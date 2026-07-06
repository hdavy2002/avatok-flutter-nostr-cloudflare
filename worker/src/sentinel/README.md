# Guardian Sentinel — S1 core (`worker/src/sentinel/`)

> **Constitutional sentence:** Guardian Sentinel is a *derived safety projection*.
> Its entire state — evidence buckets, snapshots, SentinelDO caches — must be
> reproducible **solely** from the immutable event stream and versioned
> deterministic rules. **No Sentinel component is a system of record.** The single
> owner of truth is the append-only `sentinel_evidence` log.

Spec: `Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md` (§S1) and
`Specs/GUARDIAN-TELEMETRY-SPEC-2026-07-06.md` (sentinel events).

## What's built (S1)

- **`evidence.ts`** — the `EvidenceAdded` op model + self-creating D1 tables in
  `DB_META`: `sentinel_evidence` (APPEND-ONLY, the owner of truth),
  `sentinel_snapshots` (per-(uid,bucket) fold checkpoint), and
  `sentinel_conversation_aggregate` (background moderation projection). Buckets v1:
  `identity_confidence, behaviour_confidence, community_reputation,
  conversation_risk, marketplace_trust, media_risk`.
- **`fold.ts`** — the pure, deterministic, **versioned** scorer.
  `score = clamp(50 + Σ effective_delta(now))` over snapshot + tail;
  `effective_delta = delta * 0.5^(age_days/half_life_days)` (decay is mathematical,
  computed at read — never a cron). Snapshot consolidation when the tail exceeds 200
  rows. `verifyReplay()` refolds full history and compares (drives
  `sentinel_replay_mismatch`). Constants: `SENTINEL_RULESET_VERSION`,
  `SENTINEL_EVIDENCE_VERSION`.
- **`extractors.ts`** — deterministic extractors ONLY (no LLM). Rules SEN-001…007:
  guardian_flag, guardian_sender_blocked, report_received, listing_moderation_fail,
  upload_moderation_fail, liveness_pass, message_velocity. Plus a D1-counter
  `recordFirstMessage()` sliding window for mass-messaging detection.
- **`ingest.ts`** — the single fan-in `sentinelIngest(env, event)`:
  gate → extract → append → telemetry (`sentinel_event_ingested`,
  `sentinel_evidence_added`, `sentinel_bucket_crossed`). Self-gates on
  `sentinelEnabled`; fail-open, detached.
- **`do.ts`** — `SentinelDO` (per user, `idFromName(uid)`): HOT CACHE ONLY —
  velocity/dedup ring + bucket score cache. Rehydrates from D1 on wake. Ops
  `POST /ingest`, `GET /score[?bucket=]`, `GET /replay[?bucket=]` (emits
  `sentinel_replay_mismatch`, `sentinel_do_rehydrated`).

Bands: `low < 40 · neutral 40–70 · high > 70`.

## What's built (S2 — behaviour memory, mem0)

DARK behind **`sentinelMem0Enabled`** (default `false`) **and** the **`MEM0_API_KEY`**
secret — both absent ⇒ clean no-op. mem0 is a **DERIVED CACHE, never an owner of
truth**: every memory carries `derived_from: [event_ids]`, `summary_version`,
`created_from_ruleset`, `buckets`; if mem0 vanished, all memories regenerate from the
append-only `sentinel_evidence` log. All writes are **async, never on a message hot
path, and there is NO LLM in this phase**.

- **`mem0.ts`** — minimal mem0 cloud REST client (`https://api.mem0.ai/v1`):
  `writeMemory` (POST `/memories` `{messages:[{role:'user',content}], user_id, metadata}`),
  `listMemories` (GET), `deleteMemories` (DELETE `?user_id=`). `user_id` = account uid.
  8 s timeout, **fail-open** everywhere. Telemetry `mem0_write` / `mem0_write_failed`
  `{ms, status}` (+ `mem0_delete[_failed]`).
- **`summariser.ts`** — `buildBehaviouralSummary(env, uid)` reads recent
  `sentinel_evidence` rows (30-day window) + the `behaviour_confidence` bucket band and
  composes a **deterministic, templated, category-level** pattern string
  (`"Between {d1} and {d2}: {n} guardian flags ({categories}), {m} reports received;
  behaviour band {band}."`). **PATTERNS not content** — no raw message text, media,
  emails, or protected attributes. `maybeSummarise(env, uid)` gates on the flag+key,
  drains the purge queue opportunistically, **debounces to ≤1 summary per uid per 6h**
  (`sentinel_mem0_debounce` table), writes via mem0, stamps the debounce. Emits
  `mem0_summarised`. (Comment notes a future LLM paraphrase may layer over the
  deterministic base, but must never alter numbers/provenance.)
- **`purge.ts`** — deletion purge queue (`sentinel_mem0_purge_queue` self-creating D1
  table: `uid, attempts, next_attempt_at, enqueued_at`). `enqueueMem0Purge` is called
  best-effort from `routes/account.ts` deletion and **NEVER blocks canonical deletion**.
  `processPurgeQueue(env)` (exported for a future cron/consumer; also called
  opportunistically from `maybeSummarise`) drains due rows with exponential backoff
  (5 min → 24 h cap, 8 attempts), confirming via mem0 DELETE. Telemetry
  `mem0_purge_retry {processed, backlog}` (+ `mem0_purge_exhausted`).
- **Hook:** `ingest.ts` fires `void maybeSummarise(env, event.uid)` after evidence is
  appended, guarded by `sentinelMem0Enabled` — the only hot-path touch, fully detached.

### S2 secret setup

```bash
wrangler secret put MEM0_API_KEY   # owner-supplied mem0 managed-cloud key
```

Also record it in `secrets/secret-values.env` (the recoverable source of truth —
Worker secrets are write-only). Then patch KV `platform_config`
`"sentinelMem0Enabled": true` (code defaults never win over KV — 2026-07-04 lesson).
Until BOTH are set, S2 is a no-op.

## What's dark / not built

- **Everything is DARK** behind the `sentinelEnabled` flag (default `false`); S2 adds a
  second gate `sentinelMem0Enabled` + the `MEM0_API_KEY` secret.
- No enforcement — S1/S2 are **telemetry-only**. S2 mem0 memories are **written, not
  yet read on any hot path** (deferred to v2 per plan §V2). No LLM anywhere.
  Deltas + half-lives ship conservative and are tuned from telemetry before any act.
- Full event-bus (`Q_BRAIN` / consumers) consumption is **not** wired yet. The only
  live fan-in is ONE best-effort hook after `recordFlag` in
  `routes/ava_guardian.ts` (`guardian_flag` → `senderUid`). The `SENTINEL` DO
  binding + v12 migration exist but nothing routes to the DO in S1.

## How to flip ON

1. Deploy the worker (adds the `SENTINEL` DO, v12 migration, and the dark code).
2. **Patch KV** `platform_config`: set `"sentinelEnabled": true`
   (`PUT /api/admin/config` as an admin, or edit the KV blob directly).
   **Code defaults never win over KV** (2026-07-04 lesson) — the flag *must* be set
   in KV, not just in `config.ts`.
3. Watch PostHog: `sentinel_event_ingested`, `sentinel_evidence_added`,
   `sentinel_bucket_crossed`, and — critically — `sentinel_replay_mismatch` (any
   occurrence means derived state diverged from the log; page immediately).
