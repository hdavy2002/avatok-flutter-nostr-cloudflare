# AvaTOK — Make Ably the Transport, Cloudflare the Archive + Brain

**Created:** 2026-06-28 · **Companion to:** `ABLY-MESSAGING-EXPERIENCES.md`,
`ABLY-MESSAGING-UI-CHANGES.md`, `AVAVERSE-ABLY-MIGRATION-PLAN.md`
**Goal:** kill the latency in chat delivery by letting Ably do all realtime fan-out,
while Cloudflare keeps doing what it's good at — moderation/safety, durable storage, and
AI-search context. Code-grounded against `worker/src/routes/messaging.ts`,
`worker/src/do/inbox.ts`, `worker/src/routes/ably.ts`, `consumers/src/brain.ts`,
`app/lib/sync/transport/*`.

---

## 0. Reality check (one important correction)

> "We store messages in R2 today."

Not quite — and this matters for the plan. **Today messages are stored in per-user
`InboxDO` SQLite**, not R2. That same Durable Object also runs the realtime WebSocket.
Here is what actually lives where:

| Thing | Where it lives today |
|---|---|
| **Durable message log** | per-user **`InboxDO` SQLite** (`messages` table, `do/inbox.ts` L34) — sharded per user, optional daily prune |
| Realtime delivery | `InboxDO` hibernatable WebSocket **and** an Ably best-effort publish (the migration) |
| Conversations / members / blocks | **D1** (`DB_META`) |
| Media (images, voice, files) | **R2** (`avatok-blobs`, served via `blossom.avatok.ai`) |
| Encrypted premium device-backup | **R2** (`avatok-backup`) via `BackupDO` manifest |
| **AI search context** | **Vectorize** (`avatok-semantic`, 384-dim) + **`DB_BRAIN`** (D1), fed by the `Q_BRAIN` consumer (`consumers/src/brain.ts`) off the send path |
| Moderation / safety | server-side: `delegateScan`, `guardianScan`, CSAM/phash/moderation consumers |

So the request really means two changes: **(1)** move realtime delivery fully to Ably, and
**(2)** introduce **R2 as the durable message archive** (a role it doesn't play yet) so the
chat store is decoupled from the DO and becomes clean AI-search fuel.

---

## 1. Why it feels slow today (the actual bottleneck)

The send path `sendMsg()` (`messaging.ts` L117) does, **before responding to the sender**:

1. auth + KYC + a chunked **D1 blocks** query,
2. `appendTo(sender)` — a cross-DO `stub.fetch` into the sender's InboxDO,
3. **a fan-out loop** — `appendTo(eachRecipient)` = **one DO round-trip per recipient**
   (parallel ≤25, queued above 25),
4. *then* an Ably publish (currently just a parallel best-effort),
5. then brain + guardian + delegate scans.

The cost is the **per-recipient Durable-Object hops** plus delivery riding each user's
**single InboxDO socket**. Ably already does global edge fan-out with one publish — we're
paying for the DO fan-out and **not** leaning on Ably for what it's best at.

---

## 2. Target architecture

**Ably = the nervous system (realtime). Cloudflare = the memory + conscience (storage,
AI, safety).** The Worker stays in the path as a thin, fast **gateway** so messages remain
server-readable for moderation and child-safety — a hard requirement from the rulebook
(guardian, CSAM, grooming detection). We just take the slow persistence + fan-out **off the
hot path**.

### KEEP on Cloudflare
1. **`/api/msg/send` as the gateway** — auth, blocks, KYC, and a **synchronous fast
   moderation gate** (cheap guardian/CSAM heuristics). Do **not** let clients publish the
   durable message straight to Ably: pre-publish safety needs the server in the path.
2. **D1 (`DB_META`)** — conversations, members, blocks, context tags. Unchanged.
3. **R2 — new role: durable message archive** (§3). Source of truth so chats are never
   lost and AI search has deep history.
4. **AI brain** — `Q_BRAIN` → Vectorize + `DB_BRAIN`. Unchanged on the ingest side; gains
   R2 as a backfill/retro-index source.
5. **Safety consumers** — CSAM/phash/moderation/guardian/delegate. Unchanged.
6. **Offline push** — FCM/APNs via `Q_PUSH`. Unchanged for now (Ably Push is a later option).

### MOVE to Ably
1. **All realtime delivery** — the Worker publishes **once** to `msg:<conv>`; Ably's edge
   fans out to every subscriber. **Delete the synchronous per-recipient InboxDO appends.**
   This is the speed win.
2. **Recent history / catch-up** — enable Ably **persistence** on `msg:*` so a thread opens
   instantly from Ably history; R2 is the deep archive beyond Ably's retention window.
3. **Typing, presence/online/last-seen, occupancy** — client↔Ably direct (already started).
4. **Per-message reactions + room-reaction bursts** — Ably-native (the new bells & whistles).
5. **Delivered/read receipts** — Ably `meta:<conv>` / presence (already partway there).

### RETIRE / shrink
- **`InboxDO` loses both of its jobs:** realtime → Ably; durable log → R2 archive. What
  *may* remain is **owner-private, multi-device state** that doesn't belong on a shared conv
  channel: read position, hide/undo flags, call log. Recommend moving those to **D1** (small,
  queryable) and **retiring InboxDO for messaging** — or keeping a thin InboxDO just for that
  state. (Decision D2 below.)

### New hot path (send)
```
client ──POST /api/msg/send──▶ Worker gateway
    1. auth + block + KYC
    2. fast safety gate (sync heuristics; full scan async)
    3. ablyPublish(msg:<conv>)         ← INSTANT delivery to all peers (one publish)
    4. enqueue  Q_ARCHIVE (→ R2)  +  Q_BRAIN (→ Vectorize)  +  Q_PUSH (offline FCM)
    5. return {id, serial}
   (no per-recipient DO hops)
```
Peers receive over **Ably** (global, multi-region, reconnection handled by the SDK).
Persistence + indexing happen **asynchronously**, off the path the user waits on.

---

## 3. R2 as the message archive (design)

**Canonical id & ordering:** adopt the **Ably message `serial`** (lexically sortable) as the
message id, so archive order == delivery order with no separate counter.

**Layout (recommended):** one object per message for contention-free writes —
`msg/<conv>/<serial>.json` — plus a tiny **D1 index** row
`message_index(conv, serial, ts, sender, kind, r2_key)` for fast range/paged reads.
A nightly **compaction** job rolls each day into `msg/<conv>/<yyyymmdd>.ndjson` for
cheap bulk AI re-indexing and faster restore. (Alternative: NDJSON-per-day only — fewer
objects but R2 has no append, so you'd buffer in a DO/queue. Start with one-object-per-message.)

**Write path:** a new `Q_ARCHIVE` consumer takes the moderated payload and `PUT`s it to R2 +
upserts the D1 index. Retries + DLQ make it durable; Ably history covers any lag for online
clients.

**Read path (thread open):** newest N from **Ably history** (instant) → older pages from
**R2 via the D1 index** (cursor by serial). The device's local **drift SQLite** cache stays
primary (local-first), so most opens hit nothing remote at all.

**Retention:** Ably persistence = short window (recent). R2 = long-term/forever (premium can
mean longer/full-fidelity). Aligns with the existing premium-storage model.

---

## 4. AI search continuity

AI search keeps working and gets **better**:
- Live messages still feed `Q_BRAIN` → Vectorize + `DB_BRAIN` exactly as now (the producer
  in `sendMsg()` is unchanged).
- The **R2 archive becomes the bulk/retro source**: backfill, re-embedding after a model
  change, and full-history semantic search read from R2 (compacted NDJSON shards) instead of
  trying to page millions of rows out of per-user DOs. This is strictly cleaner than today.
- E2E/private content rule unchanged: only server-readable content is indexed; private stays
  on-device.

---

## 5. Trade-offs, risks & decisions

1. **Moderation timing (child safety).** Keep a **synchronous fast gate** pre-publish; run
   the full guardian/CSAM scan async and, if it later flags, issue an Ably **redact/tombstone**
   (we already have `del`/`gdel` control envelopes). Media must clear the **phash/CSAM** check
   before its `media_ref` is shareable. *Non-negotiable per rulebook.*
2. **Ably is mobile-only** (`ably_flutter` = iOS/Android). Desktop/web currently rely on
   InboxDO. You **cannot fully delete InboxDO** until desktop is either (a) kept on InboxDO,
   or (b) moved to the **Ably JS SDK / React UI Kit**. → **Decision D1.**
3. **InboxDO's private state** (read position, hide/undo, call log) needs a new home if you
   retire it → D1 vs slim DO. → **Decision D2.**
4. **Cost model.** Ably bills per message + per peak channel; R2 bills writes (Class A) +
   storage. Need a back-of-envelope vs current DO usage before flipping at scale. → **D3.**
5. **Ordering/dedup.** Canonical id = Ably serial; archive + client dedupe idempotently by it.
6. **Reliability.** If Ably publish succeeds but R2 archive lags, online clients are fine
   (they got the live message + Ably history); R2 catches up via the queue. If Ably publish
   fails, fall back to the FCM wake + a server-side retry (don't lose the message).

---

## 6. Phased rollout (low-risk, flag-gated)

- **Phase 1 — Archive in parallel (dark).** Add `Q_ARCHIVE` + R2 writes + D1 index, fed
  from the existing send path. No behaviour change; just start building the durable store.
- **Phase 2 — Ably-first delivery.** In `sendMsg()`, make `ablyPublish` the primary delivery
  and **stop the synchronous recipient InboxDO appends** (keep sender-side until reads move).
  Clients read recent from Ably history. Measure latency (PostHog dashboard 778258).
- **Phase 3 — Reads from Ably + R2.** Thread open = Ably history + R2 paging via D1 index;
  retire the InboxDO `/sync` for messaging on mobile.
- **Phase 4 — New experiences.** Per-message reactions, room-reaction bursts, occupancy,
  group "seen by" — all Ably-native (see `ABLY-MESSAGING-EXPERIENCES.md`).
- **Phase 5 — Decommission.** Resolve desktop (D1), move private state (D2), then retire or
  slim `InboxDO`.

Every phase stays behind `kMessagingProvider` / `AVATOK_MSG_PROVIDER` and the `ablyConfigured`
gate, so it ships dark and flips per-cohort.

---

## 7. Decisions — LOCKED (owner, 2026-06-28)

- **D1 — Scope: MOBILE-ONLY for now.** Build the Ably-transport + R2-archive experience for
  iOS/Android only. Desktop/web are out of scope for this work (they keep the legacy InboxDO
  path untouched). We are **not** investing in an Ably-JS web client yet — revisit later.
  Implication: InboxDO stays alive for desktop, but mobile stops using it for messaging.
- **D2 — Private state → D1.** Read position, hide/undo flags, and call log move to small
  queryable **D1** tables (per-account scoped). Goal: InboxDO is no longer the message store
  or the private-state store on mobile.
- **D3 — Everyone keeps FULL history in R2.** All chats are archived to R2 for every user
  (never lost, full AI-search context). **Premium adds** instant cross-device restore +
  longer live Ably history window. Free tier still keeps its full R2 archive.

---

*Constraints unchanged: send routed through `/api/msg/send`; per-account scoping for any new
local state; mobile-only Ably; groups ≤25; flag-gated rollout. Line refs valid 2026-06-28.*
