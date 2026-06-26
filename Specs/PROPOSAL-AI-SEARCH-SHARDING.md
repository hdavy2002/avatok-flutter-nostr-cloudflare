# Plan: AI Search sharding — fix the per-user-instance scaling wall
**Decision (not options): pool all users into 1,024 shared AI Search instances; isolate each user by a folder prefix and a query filter, through one central helper.**
Date: 2026-06-26 · Status: **DECIDED — ready to build** · Owner: davy (hdavy2005)

---

## 1. The problem

We create **one AI Search instance per user** (`ava-<uid>`) in three places:
`worker/src/routes/ava_rag.ts`, `worker/src/lib/ava_memory.ts`,
`worker/src/routes/ava_gemini.ts`.

Cloudflare's hard cap (Workers Paid) is **5,000 AI Search instances per account**, with
**1,000,000 files per instance**. One-instance-per-user therefore dies at 5,000 users. We
target **1,000,000 users**. This blocks memory/RAG at scale.

## 2. The plan

**Pool users into a fixed set of 1,024 shared instances** (`ava-shard-0 … ava-shard-1023`)
in the existing `AI_SEARCH` namespace.

- **Assign:** each user maps to one shard by a stable hash — `shard = hash(uid) % 1024`.
- **Store:** every document is written under the user's folder — `"<uid>/<name>"`.
- **Search:** every query is filtered to that folder — `filters: { folder: "<uid>/" }`.
- **Find a user's data:** compute their shard, query it with their folder filter.

Capacity = 1,024 × 1,000,000 = ~1 billion documents (~1,000 users per shard at 1M users,
well under the 1M-file cap), using at most 1,024 of the 5,000 instances. Shards are created
lazily on first use.

**Why the folder prefix does double duty:** `folder` is a *built-in* AI Search attribute
(the path prefix of a file's name), so filtering on it needs **no** custom-metadata schema
(changing that schema would force a full re-index). It also fixes a latent bug: today the
backfill writes names like `messages-<conv>.txt`, which in a shared instance would let two
users **overwrite each other**. The `<uid>/` prefix makes every key unique per user.

## 3. One central helper — the safety boundary

All three call sites collapse into one new file, `worker/src/lib/ava_search.ts`, so the
per-user filter is applied on every read and can never be forgotten (forgetting it = a
cross-user leak). This file is the tenancy boundary; review it as security-critical.

```ts
const SHARD_COUNT = 1024;                      // FIXED FOREVER — see §5

const safeUid = (uid: string) =>
  uid.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 60);

const shardId = (uid: string) => `ava-shard-${fnv1a(uid) % SHARD_COUNT}`; // stable hash, not JS hashCode

async function shard(env: Env, uid: string) {
  const ns = env.AI_SEARCH, id = shardId(uid);
  try { const got = await ns.get(id); if (got) return got; } catch {}
  try { return await ns.create({ id }); } catch { return ns.get(id); }   // lazy, idempotent
}

// the ONLY write path
export async function ingestForUser(env: Env, uid: string, name: string, content: unknown) {
  const inst = await shard(env, uid);
  return inst.items.uploadAndPoll(`${safeUid(uid)}/${name}`.slice(0, 120), content);
}

// the ONLY read path — filter injected here, callers cannot omit it
export async function searchForUser(env: Env, uid: string, query: string) {
  const inst = await shard(env, uid);
  return inst.search({
    messages: [{ role: "user", content: query }],
    ai_search_options: { retrieval: { filters: { folder: `${safeUid(uid)}/` } } },
  });
}

// the ONLY delete path — used on account deletion (see §5)
export async function deleteForUser(env: Env, uid: string) {
  const inst = await shard(env, uid);
  // item ids were recorded in D1 at ingest (no shard-wide scan needed)
  const rows = await env.META.prepare(
    "SELECT item_id FROM ava_search_items WHERE uid = ?1",
  ).bind(uid).all<{ item_id: string }>();
  for (const r of rows.results ?? []) {
    try { await inst.items.delete(r.item_id); } catch { /* keep going */ }
  }
  await env.META.prepare("DELETE FROM ava_search_items WHERE uid = ?1").bind(uid).run();
}
```

`ingestForUser` additionally records each returned item id in a small D1 table
`ava_search_items(uid, shard, item_id, name)` so `deleteForUser` is a direct lookup, never
a scan of a shared shard holding ~1,000 users.

Refactor the three call sites to call `ingestForUser` / `searchForUser` and delete their
local instance-id + raw `inst.search` / `inst.items.uploadAndPoll` logic. No public route
changes (`index.ts` stays frozen); premium gating, charging, and telemetry are unchanged.

## 4. Migration

RAG data is rebuildable (messages from each user's InboxDO, file descriptors from the
`user_media` D1) via the existing `/api/ava/rag/backfill`, so:

1. Ship `ava_search.ts` and point the three call sites at it.
2. Re-run the backfill for existing premium users so they land in their shard (idempotent;
   small cohort today → one-shot job).
3. Delete the old `ava-<uid>` instances to reclaim the instance count.

No downtime: a user who searches before their re-backfill just gets fewer hits until it
finishes (search already returns empty on a miss).

## 5. Account deletion (sharding makes this harder — design it now)

In the old per-user model, deleting a user was trivial: drop their whole `ava-<uid>`
instance. **In the pooled model you cannot delete the instance** — it holds ~1,000 other
users. You must delete that user's individual documents from the shared shard.

CF's Items API supports **delete-by-item-id** but has **no delete-by-folder** bulk op. So
we record every item id in D1 at ingest (`ava_search_items`) and, on account deletion, look
up the user's ids and delete each via `deleteForUser` (§3). No shard-wide scan.

Account deletion must wipe the user from **every** store, not just one:

| Store | What | How |
|---|---|---|
| **AI Search shard** | indexed messages + file descriptors | `deleteForUser` — per-item delete via D1-tracked ids |
| **R2** (`avatok-blobs`, `avatok-verification`) | raw file bytes, media, KYC docs | delete by `<uid>/` key prefix (this is *our* R2, separate from AI Search's internal storage) |
| **Vectorize** | the other memory lane (`user_brain`) | delete the user's vectors by `uid` |
| **InboxDO** | their message log | dispose the per-user DO |
| **D1** (`avatok-meta`, `avatok-media-meta`, wallet, …) | their rows + `ava_search_items` | delete where `uid = …` |
| **KV** (identity/contact caches) | cached lookups | purge keys |
| **On-device** | local SQLite/caches | wiped on app uninstall / local logout |

Wire all of this into the existing account-deletion handler as one ordered routine so a
deletion can be retried safely (each step idempotent).

### 5.1 Why NOT per-user R2 buckets (decided)

A tempting idea: give each user their own R2 bucket and just delete the bucket to wipe
everything. **Rejected.** The reasoning, on record:

- **R2 could take it** — R2 allows up to **1,000,000 buckets/account** (vs AI Search's 5,000
  instances) with unlimited objects per bucket, so unlike AI Search we would *not* hit a
  wall. That's the only point in its favor.
- **But deleting a bucket does not clear AI Search.** AI Search is a separate index. We use
  AI Search **built-in storage**, so its index has no relationship to our `avatok-blobs`
  bucket — emptying a user's bucket leaves the index fully intact. "Delete bucket = clear
  all" is simply false in this mode.
- **And per-user buckets can't pair with the index anyway.** The only mode where deleting
  R2 cascades to the index is **R2-as-source**, but there **one bucket = one AI Search
  instance** — so per-user buckets would again require ~1M instances (5,000 cap). Dead end.
- **R2-as-source also loses instant indexing.** External R2 sources index on a *schedule*;
  built-in storage indexes **immediately**. Instant indexing is required by our core
  "share a file in a group and `@ava` it right away" feature, so built-in storage wins.

**Decision: keep built-in storage + per-user *prefixes* (`<uid>/`), not per-user buckets.**
Instant search matters more than one-shot bucket deletion, and deletion is already a small,
well-defined routine (`deleteForUser` + the §5 table). Per-user buckets buy us nothing.

## 6. The one rule: 1,024 is permanent

`shard = hash(uid) % 1024`. Changing the number later remaps users to different shards and
their data appears to vanish until a full re-index. **Never change it.** It is sized with
large headroom precisely so we never need to.

## 7. The tradeoff (accepted)

Per-user instances today give *hard* isolation (physically separate). Pooling gives *soft*
isolation — users share instances and are kept apart by the folder filter. This is the
standard multi-tenant model and is safe here because there is exactly one read path
(`searchForUser`) plus a test asserting the filter is always present.

## 8. Build steps

1. `lib/ava_search.ts` — helper (`ingestForUser` / `searchForUser` / `deleteForUser`) +
   FNV-1a hash; `SHARD_COUNT = 1024`. Add D1 table `ava_search_items(uid, shard, item_id, name)`.
2. Refactor `ava_rag.ts`, `ava_memory.ts`, `ava_gemini.ts` to use it.
3. Wire `deleteForUser` + the R2/Vectorize/InboxDO/D1/KV wipe (§5 table) into the
   account-deletion handler as one idempotent routine.
4. Unit test: ingest for user A and user B that hash to the **same** shard; assert neither
   can ever see the other's documents; assert deletion of A leaves B intact.
5. Re-backfill existing premium users; delete old `ava-<uid>` instances.
6. Telemetry: per-shard file count (alert at 80% of 1M) + a counter confirming the folder
   filter is set on every search.

**Relationship to OKF (decided):** OKF is **not** part of this fix and **not** built for
AvaTOK now. It is the portable knowledge format we adopt for **future apps**, and
"OKF-in-R2 as source of truth" is deferred because it implies R2-as-source (scheduled
indexing), whereas AvaTOK needs built-in storage's **instant** indexing for "share a file
and `@ava` it right away." Full rationale in **`PROPOSAL-OKF-KNOWLEDGE-LAYER.md` §0**.

---

*Sources: code verified 2026-06-26 — `worker/src/routes/ava_rag.ts`, `worker/src/lib/ava_memory.ts`, `worker/src/routes/ava_gemini.ts`, `worker/src/types.ts`. CF docs — AI Search limits & pricing, Filtering (Workers binding), Metadata attributes, Built-in storage (developers.cloudflare.com, 2026-06).*
