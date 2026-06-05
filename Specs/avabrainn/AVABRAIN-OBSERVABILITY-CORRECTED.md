# AvaBrain + Observability — Corrected Build Prompt

This replaces `AVABRAIN-OBSERVABILITY-PROMPT.md`. It keeps the good parts and
fixes the items that contradicted our architecture (E2E encryption), would have
been expensive at 10M users, or were technically wrong on Cloudflare/PostHog.

**Governing constraints (do not violate):**
- **E2E is sacred.** DMs are NIP-17 (the server only ever sees the kind-1059
  ciphertext). The server CANNOT read DM content. Any "learn from messages" for
  DMs happens **client-side**; the server brain only processes content the server
  legitimately holds (public posts, the user's own profile, app metadata).
- **Cost discipline.** No 70B model on a per-event hot path. Background extraction
  uses an 8B model; embeddings use the 384-dim model that matches our Vectorize
  index. Decay is computed lazily, never as a full-table cron write.
- **Cloudflare-only**, Rulebook v1.1. Don't rebuild existing Workers/schemas — add.

---

## What changed vs the original prompt (summary)

| Original | Problem | Correction |
|---|---|---|
| Relay → Q_BRAIN extracts facts from messages (incl. DMs) | Server can't read E2E DMs; kind 14 never published | Server brain processes **public** events only; **DM facts are extracted client-side** and synced via `/api/brain/remember` |
| `llama-3.3-70b` per event + per query | Most expensive model on a hot path | `llama-3.1-8b-instruct-fp8` for background extraction; on-demand `ask`/`briefing` default 8B (70B optional, flagged) |
| `investigate()` reads PostHog with `POSTHOG_API_KEY` | Project key is **write-only**; can't read | New gated secret `POSTHOG_PERSONAL_API_KEY`; query via HogQL |
| Brain tables in DB_META; "they're small" | Raw event log is a firehose; bloats identity DB + 10 GB ceiling | New **`avatok-brain` D1**; raw log short-TTL; curated graph small |
| Importance decay across all rows every cron | Full-table rewrite for every user | **Lazy decay at read time** from `last_seen` |
| `POSTHOG_HOST` = app.posthog.com | Wrong region/host | `${POSTHOG_HOST}/batch/` = `us.i.posthog.com` |
| `neuronCount` to Analytics Engine | Not returned by `AI.run` | Log **duration** as the cost proxy |
| Missing bindings | Relay Q_BRAIN producer + consumers Vectorize not wired | Add them (see §3) |
| Knowledge graph = plaintext 3rd-party PII | Privacy/DPDP honeypot | Minimize 3rd-party PII; brain is **opt-in**; document retention |

---

# PART 1: OBSERVABILITY (build this first — it's the foundation)

Most of this is **already in the codebase** (Analytics Engine wired across all
Workers; PostHog `/batch` via the analytics queue; per-request latency in the API
worker). This part finishes it: trace IDs, the PostHog event catalog, and dashboards.

### 1A. Three-system split (unchanged — it's correct)

| Destination | What | Cost |
|---|---|---|
| **PostHog** | User-facing events, errors, journeys, AI diagnostics (~5–15/user/day) | Free to 1M/mo |
| **Analytics Engine** | Ops metrics (latency, throughput, queue depth, scan duration) | $0.25/M |
| **Workers Logs** | Raw request/response, stack traces | Free, 7-day |

### 1B. Trace IDs
- API worker: `const traceId = req.headers.get('X-Trace-Id') || crypto.randomUUID()`. We already wrap `dispatch()` for latency — thread `traceId` into the Analytics Engine blobs and onto every queue message.
- Flutter (`app/lib/core/api_auth.dart`): generate a `v4` per request, send `X-Trace-Id`, keep the last N locally for error reports.
- Queue messages already carry context; add `traceId`.

### 1C. PostHog event catalog (~29 events — unchanged from the original; it's good)
Keep the original's Auth/Messaging/Calls/Uploads/AI/Push/Journey/Errors tables.
Two rules:
- **All events flow through `Q_ANALYTICS`** (already built) → one `/batch/` POST per queue batch. No direct PostHog calls from request paths.
- **`message_*` events carry NO content** — only metadata (recipient npub, type, latency). Never log message text (E2E).

### 1D. PostHog ingestion (fix the host)
The analytics consumer already posts to `${env.POSTHOG_HOST}/batch/`. Confirm
`POSTHOG_HOST = "https://us.i.posthog.com"` (it is) and the body shape
`{ api_key: <phc_…>, batch: [...] }`. **Do not** hardcode `app.posthog.com`.

### 1E. Analytics Engine (already wired — verify, don't duplicate)
Already emitting: API latency/route/status, relay events-per-kind, moderation
scan duration, queue ok/fail, cron counts. Add `trace_id` to the API blobs. Use
**duration**, not neuron count.

### 1F. Dashboards (via PostHog MCP, after events flow)
Keep the original's 7 dashboards (System Health, Auth, Journey Funnel, Messaging,
AI/Brain, Mobile Stability, Cross-App). Build these only once real events arrive.

---

# PART 2: AVABRAIN (corrected — privacy-safe, cost-bounded)

### 2A. The core correction: where the brain learns

Two ingestion paths, by data sensitivity:

```
PUBLIC / server-visible content (server brain):
  public posts (kind 1), the user's own profile, AvaLive/stream metadata,
  upload/moderation metadata, calendar/event metadata (when those apps exist)
    → relay/API dispatch to Q_BRAIN → brain consumer extracts (8B model)

PRIVATE / E2E content (client brain):
  DM text, DM media (the server only has ciphertext)
    → the APP extracts facts locally from plaintext (on-device, or a small
      client-side model) → sends curated facts to POST /api/brain/remember
    → stored in the user's own brain (their data, their consent)
```

The server brain **never** receives DM plaintext and **never** processes kind-1059
gift wraps. This preserves "even your server can't read your DMs."

### 2B. Storage: a dedicated `avatok-brain` D1 (not DB_META)

Provision a 5th D1 `avatok-brain` (APAC, read replication auto). Rationale: the
event log is high-volume and would otherwise push DB_META toward D1's ~10 GB
ceiling and add write contention to identity. Bind it as `DB_BRAIN` on
`avatok-api` and `avatok-consumers`.

Schema (`worker/migrations/brain.sql`, applied to `avatok-brain`): keep the
original's `brain_entities`, `brain_relationships`, `brain_facts`,
`brain_daily_summaries` — with these changes:
- **`brain_events`** → make it a **short-TTL catch-up buffer**, not a permanent
  source of truth. Add `expires_at` (default now + 30 days) and prune in cron.
  Most value is in the curated entities/facts; the raw firehose isn't worth
  storing forever.
- Add a **`scope` column** to `brain_facts`/`brain_entities`: `'public'` (server-
  derived) vs `'private'` (client-synced from DMs). Lets you treat them
  differently for retention/consent and lets the client choose what to sync.
- Keep all the original indexes (they're good). Importance is decayed lazily
  (see 2E), so no `idx` is needed for a decay scan.

### 2C. Models (cost-bounded)
- **Background extraction** (Q_BRAIN consumer): `@cf/meta/llama-3.1-8b-instruct-fp8`.
  One call per event, JSON-mode prompt: extract `entities[]`, `relationships[]`,
  `facts[]`. Dedupe by `(npub, name, type)` → upsert.
- **Embeddings**: `@cf/baai/bge-small-en-v1.5` (384-dim — matches the
  `avatok-semantic` Vectorize index). Store vectors with `{ npub }` metadata and
  **filter every query by npub**.
- **On-demand reasoning** (`ask`/`briefing`): default `@cf/meta/llama-3.1-8b-instruct-fp8`.
  Allow `@cf/meta/llama-3.3-70b-instruct-fp8-fast` behind a `BRAIN_REASONER_MODEL`
  var for premium/verified users only — never on the background path.
- Every AI call logs **duration** to Analytics Engine (`blobs:["brain", model]`).

### 2D. UserBrain DO (`worker/src/do/user_brain.ts`)
Per-user, keyed by npub, WebSocket Hibernation (same pattern as the relay inbox
DO; separate binding `USER_BRAIN`). Keep the migration **v1 (CallRoom) block AND
add a v2 block** for `UserBrain` — don't replace v1.

`ask()` flow (unchanged from original, but 8B + npub-filtered Vectorize):
query top entities by importance, relevant relationships/facts, npub-filtered
vector hits, recent daily summaries → one 8B call with "answer ONLY from context,
say if unknown, never hallucinate" → return.

`briefing()`: summarize the user's last day from curated facts/summaries.

### 2E. Lazy importance decay (no cron full-table write)
Do **not** rewrite importance every cron. Store raw `importance` + `last_seen`;
compute effective importance at read time:
`effective = importance * 0.995 ^ daysSince(last_seen)`. On a new interaction,
bump `importance` and set `last_seen`. Cron only prunes expired facts and the
short-TTL `brain_events` buffer.

### 2F. Brain API routes (`worker/src/routes/brain.ts`)
```
POST   /api/brain/ask          { question }
POST   /api/brain/briefing
POST   /api/brain/remember     { facts:[...] }   ← client-synced DM-derived facts (scope='private')
POST   /api/brain/investigate  { complaint }     ← see 2H
DELETE /api/brain/forget       { entity_id }
GET    /api/brain/entities
GET    /api/brain/timeline
```
All require **NIP-98 + Clerk JWT** (dual auth); npub comes from auth; the handler
forwards to that user's `USER_BRAIN` DO. `remember` is how the client brain syncs
private facts — the only path private data enters the server brain, with consent.

### 2G. Event hooks (public only)
- Relay `handleEvent`: after persist, if kind is **public and brain-relevant**
  (kind 1 posts; **NOT** 1059/14/13 DMs, **NOT** 0/3/10002 metadata) →
  `env.Q_BRAIN.send({ traceId, npub, type:'post_created', ... })`. Requires adding
  the `Q_BRAIN` producer binding to **relay/wrangler.toml + relay Env**.
- API worker: on public upload / stream / (future) calendar events → `Q_BRAIN`.

### 2H. `investigate()` — correct PostHog read
- Needs a **personal API key** (`phx_…`), gated as `POSTHOG_PERSONAL_API_KEY`. If
  unset, `investigate` returns "diagnostics unavailable" (graceful, like other
  gated secrets). The write-only `phc_` project key **cannot** read events.
- Query via HogQL: `POST ${POSTHOG_QUERY_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query`
  (`POSTHOG_QUERY_HOST=https://us.posthog.com`, `POSTHOG_PROJECT_ID=139917`),
  `Authorization: Bearer <phx_…>`, body a HogQL `SELECT` over `events` filtered by
  `distinct_id = npub` and last 24h. Then summarize with the 8B model.
- This is the ONE new secret. Everything else reuses existing bindings.

---

# PART 3: WIRING

### 3A. New files
```
worker/src/do/user_brain.ts      — UserBrain DO (8B reasoning)
worker/src/routes/brain.ts       — /api/brain/* handlers
worker/migrations/brain.sql      — graph + memory (applied to avatok-brain)
consumers/src/brain.ts           — Q_BRAIN consumer (8B extraction + bge embed)
```
(`consumers/src/posthog.ts` is unnecessary — the analytics consumer already batches.)

### 3B. Files to modify
```
worker/wrangler.toml      — Q_BRAIN producer, USER_BRAIN DO (+v2 migration), DB_BRAIN
worker/src/index.ts       — brain routes; trace_id into Analytics Engine blobs
worker/src/routes/api.ts  — (or brain.ts) brain route dispatch
relay/wrangler.toml       — Q_BRAIN PRODUCER + DB? (no) ; relay Env += Q_BRAIN
relay/src/relay_do.ts     — Q_BRAIN dispatch for PUBLIC kinds only
consumers/wrangler.toml   — Q_BRAIN consumer, DB_BRAIN, VECTOR_INDEX (Vectorize)
consumers/src/index.ts    — route "brain-events" queue → handleBrain
```
Note: `DB_META` is already bound on consumers — don't re-add. Vectorize is **not**
on consumers yet — add it.

### 3C. New infra
```
wrangler d1 create avatok-brain           # 5th D1; put id in worker + consumers wrangler
wrangler queues create brain-events
wrangler d1 execute avatok-brain --remote --file=worker/migrations/brain.sql
```

### 3D. Secrets
```
POSTHOG_API_KEY            — already staged (phc_, ingestion) — unchanged
POSTHOG_PERSONAL_API_KEY   — NEW, gated, for investigate() reads (phx_). Optional:
                             unset → investigate returns "diagnostics unavailable".
```

### 3E. Deploy order
1. `avatok-brain` D1 + `brain.sql` migration; create `brain-events` queue.
2. Deploy consumers (brain consumer + Vectorize + DB_BRAIN).
3. Deploy relay (Q_BRAIN dispatch, public kinds only).
4. Deploy API worker (brain routes + UserBrain DO + trace IDs).
5. Build dashboards via PostHog MCP once events flow.

---

## Rules
1. **Never send DM plaintext or ciphertext to the server brain.** Public content +
   client-synced facts only.
2. **8B for background, npub-filtered Vectorize, lazy decay.** No 70B hot path, no
   full-table decay writes.
3. **Brain consumer idempotent** — upsert by `(npub, name, type)`; never duplicate.
4. **AI inference is async (Q_BRAIN)** — never block a request on the LLM.
5. **PostHog through `Q_ANALYTICS`** (already built); ingestion `${POSTHOG_HOST}/batch/`.
6. **Analytics Engine via `ctx.waitUntil`**, log duration not neurons.
7. **Brain is opt-in** and only over data the user owns; document retention
   (curated facts persist; raw `brain_events` TTL 30d).
8. **Test investigate** with a real personal key against a deliberately failed login.
9. Update `BACKEND_REBUILD_HANDOFF.md` with a Session 4 section.
