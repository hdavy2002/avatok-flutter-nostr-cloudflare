# AvaTok — Scale / Cost / Speed Audit (2026-06-04)

Cross-check of everything built this session, with one lens: **what bites at 10M
users** — either a correctness wall, a runaway bill, or a latency tax on the user
experience. Ordered by severity. File references are exact.

> **STATUS — ALL 12 ITEMS FIXED (Session 3, 2026-06-04).** Code-complete and
> bundle-verified (`tsc` + `wrangler --dry-run` pass for all 3 Workers). Deploys
> still held behind `secrets/deploy.sh`.
>
> - **P0-1 relay single DO** ✅ Sharded to per-user inbox DOs (`idFromName(pubkey)`); global broadcast removed → local deliver + DM/mention fan-out to recipient DOs; app sends `?pubkey=`.
> - **P0-2 D1 100-param limit** ✅ `chunk()` batches of ≤90 in `matchContacts` and relay `queryFilter` (dynamic size + cartesian + dedupe).
> - **P1-3 search scan** ✅ FTS5 `profiles_fts` (`meta_fts.sql`) + prefix `MATCH`.
> - **P1-4 pHash O(n) scan** ✅ LSH bands (`moderation_lsh.sql`) → indexed candidate lookup.
> - **P1-5 vision AI cost** ✅ Analytics-Engine cost metric + verified-tier lenient threshold + `MODERATION_MODEL_TYPE` swap path to a cheap classifier.
> - **P1-6 Blossom cache** ✅ Verified live (cache-everything 30d + tiered + smart-tiered on).
> - **P1-7 R2 re-fetch** ✅ `moderation_results.phash` (`moderation_phash_col.sql`) — skip R2 GET + Photon on known sha256.
> - **P2-8 PostHog** ✅ One `/batch` call per queue batch.
> - **P2-9 read-your-writes** ✅ Documented in `db/shard.ts`.
> - **P2-10 cron index** ✅ Partial index (`media_pending_index.sql`).
> - **P2-11 Analytics Engine** ✅ Wired: API latency, relay events/kind, moderation cost, queue ok/fail, cron counts.
> - **P2-12 relay shard trigger** ✅ Documented threshold in `db/shard.ts`.

Verified facts used below: D1 enforces **100 bound parameters per query**
([docs](https://developers.cloudflare.com/d1/platform/limits/)); D1 billing is on
**rows_read/rows_written**, 25B rows read/mo included **per account**
([pricing](https://developers.cloudflare.com/d1/platform/pricing/)); Workers AI is
**10k neurons/day free, then $0.011/1k**
([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).

---

## P0 — will break or hard-bottleneck at scale

### P0-1. The relay is a SINGLE global Durable Object
`relay/src/index.ts` routes every WebSocket to `idFromName("relay-global")`. A
Durable Object is **one single-threaded instance pinned to one location**. Consequences at scale:
- **Global latency tax:** a user in Delhi and one in New York both connect to the
  *same* colo (wherever that one DO lives). Real-time messaging — the core UX — is
  fast for one region and slow for everyone else. This directly contradicts the
  "global speed" goal.
- **Throughput ceiling:** all events, all `REQ` queries, all auth, and the
  `broadcast()` loop run in one isolate. `broadcast()` iterates
  `state.getWebSockets()` for **every** published event — O(connections) per event.
  At even 100k concurrent sockets this melts; at 10M it's impossible.
- Hibernation (just added) helps idle cost but does **nothing** for this — an active
  relay still funnels everyone through one object.

**Fix (architectural, the single most important item):** shard the relay. The
clean pattern for a messaging-first Nostr product is a **per-user "inbox" DO**
keyed by the user's own pubkey (`idFromName(myPubkey)`): each client connects to
its own DO (millions of tiny DOs, each hibernating when idle). DMs (kind 1059 with
`#p=recipient`) are delivered by fanning the publish out to each recipient's inbox
DO. Public posts persist to D1 and are served by `REQ`→D1 queries (+ optional
follower fan-out). This shards naturally and removes the global broadcast loop.
Interim cheaper step if a redesign isn't possible yet: shard by
`hash(pubkey) % N` into N relay DOs to at least spread load across regions.

### P0-2. D1 100-bound-parameter limit is exceeded in two places
D1 rejects any query with >100 bound params. Two paths build `IN (...)` from
unbounded client input:
- **Contacts match** — `worker/src/routes/api.ts › matchContacts()` builds one
  `IN (?1..?N)` from up to **5000** phone hashes (`contactsSync` slices to 5000).
  Any user with **>100 contacts** → query throws → contact discovery fails for
  essentially everyone. **Fix:** chunk hashes into batches of ≤90 and union the
  results (and dedupe first).
- **Relay filters** — `relay/src/relay_do.ts › queryFilter()` binds client filter
  arrays (`ids`, `authors`, `kinds`, `#p`/`#e` tag values) directly. A normal
  following-feed `REQ` with **>100 authors** (a 500-follow timeline) → query throws
  → feed breaks. **Fix:** chunk/loop these arrays in batches of ≤90 (or cap + paginate).

---

## P1 — cost and latency that compound with usage

### P1-3. `search` does a full-table scan per query
`worker/src/routes/api.ts › search()` uses `handle LIKE '%q%' OR
LOWER(display_name) LIKE '%q%'`. A **leading wildcard** and `LOWER(col)` both defeat
the existing indexes, so every search **reads the entire profiles table**. At 10M
profiles that's ~10M `rows_read` *per search* — a direct, large D1 bill and a slow
query. **Fix:** use SQLite **FTS5** (a `profiles_fts` virtual table) for name/handle
search, or prefix-only `handle LIKE 'q%'` (index-usable), or route search through the
already-provisioned **Vectorize** index for semantic people-search. The 60s Cache API
layer helps repeat queries but not the long tail of unique searches.

### P1-4. Perceptual-blocklist check scans up to 5000 rows per public upload
`consumers/src/moderation.ts › matchesBlockedPerceptual()` does
`SELECT hash_value FROM blocked_media_hashes WHERE hash_type='perceptual' LIMIT 5000`
and Hamming-compares in JS on **every public upload**. That's up to 5000 `rows_read`
+ O(n) CPU per image, and it silently stops matching past 5000 blocked hashes.
**Fix:** store pHash in **bands/buckets (LSH)** — split the 64-bit hash into k 16-bit
bands, index each, and only compare candidates that share a band. Turns an O(n) scan
into an indexed lookup and stays correct as the blocklist grows.

### P1-5. Vision moderation is the likely #1 AI cost
`MODERATION_MODEL = @cf/meta/llama-3.2-11b-vision-instruct` runs on every *distinct*
public image. An 11B vision model is neuron-heavy; the 10k-neuron/day free tier is a
few hundred requests. At 10M users posting public images, this is millions of
inferences/day → real money. **What's already right:** only the public path is
scanned, and identical bytes are deduped via `moderation_results` (never re-scanned).
**Consider:** a lighter classifier when one lands in the catalog (the falcons-ai NSFW
model is ~2 orders of magnitude cheaper if/when enabled — keep it as the swap target);
relaxing scan frequency for tier-verified users; and tracking neuron spend in a
dashboard so it can't surprise you.

### P1-6. Confirm the Blossom R2 edge-cache rule actually exists
Media correctly bypasses the Worker (`blossom.avatok.ai`, custom domain confirmed
active). But the *cost/speed* win only lands if there's a **Cache Rule / Cache-Everything
with a long edge TTL** on that hostname. Without it, every media view is an R2 **Class B
read** + origin round-trip instead of an edge hit. **Action:** verify in the dashboard
(Caching → Cache Rules) that `blossom.avatok.ai` is Cache-Everything with a long TTL
(content is content-addressed by sha256, so it's immutable → `max-age=31536000, immutable`).

### P1-7. Moderation re-fetches the blob + re-decodes for pHash even on cache hits
`handleModeration()` always `BLOBS.get(hash)` and Photon-decodes to compute pHash —
even when the AI result is already cached for that sha256. **Fix:** store the pHash
alongside `moderation_results` and skip the R2 GET + decode when the sha256 is known.
Saves an R2 Class B op + WASM CPU on every re-upload of identical bytes.

---

## P2 — efficiency / polish

- **P2-8. PostHog one HTTP call per event.** `consumers/src/index.ts › capture()`
  POSTs once per message though the queue already batches ≤50. Use PostHog's
  `/batch` endpoint to send the whole batch in one request.
- **P2-9. Cross-request read-your-writes.** Each request opens a fresh
  `withSession("first-unconstrained")`, so a read *in a later request* right after a
  write (e.g., resolving a handle you just set) may briefly hit a lagged replica. Fine
  for most flows; for the few that need it, return/replay the D1 bookmark. Worth a note,
  not urgent.
- **P2-10. Cron cleanup scans `user_media` by `moderation_status`** every 6h with no
  dedicated index. Cheap now; add a partial index on `(moderation_status, created_at)`
  if the table gets large.
- **P2-11. `ANALYTICS` (Analytics Engine) binding is unused.** Either wire the
  operational metrics it was meant for (API latency, relay throughput, queue depth) or
  drop the binding. No cost, just dead wiring.
- **P2-12. Relay single `DB_RELAY` write volume.** Every event = 1 row + N tag rows to
  one database. The time-shard plan exists (`worker/src/db/shard.ts › relayDbFor`) but
  has no trigger. Set a concrete threshold (e.g., shard by month near ~5 GB) before you
  need it.

---

## What's already solid (no change needed)

- **Indexes are well covered** — `push_tokens(npub)`, `profiles(handle)`,
  `profiles(email_hash)`, `contact_phone_index(phone_hash,…)`, `user_media(npub,created_at)`,
  `user_media(key)`, `nostr_events(kind|pubkey,created_at)`, `nostr_tags(tag,value,created_at)`,
  `account_status(npub)`. The hot lookups hit indexes.
- **sha256 dedupe of AI scans** — identical bytes are never re-scanned.
- **D1 Sessions API** now routes reads to nearest replica (just added).
- **DO hibernation** on the relay (just added) — idle connections don't bill.
- **Media bypasses the Worker** (public R2 via Blossom) — no proxy cost.
- **Async via Queues**, **dual auth (NIP-98 + Clerk JWT)**, **DM E2E + ciphertext media**.

---

## Suggested order to fix
1. **P0-2** (param chunking) — small, surgical, and it's a *live correctness bug* that
   triggers at ~100 contacts / ~100 follows. Do first.
2. **P1-6** (verify Blossom cache rule) — one dashboard check, big cost/speed lever.
3. **P1-3** (search) and **P1-4** (pHash LSH) — bounded code changes.
4. **P0-1** (relay sharding) — the big one; plan it deliberately before a real user surge.
5. The P2 items as cleanup.
