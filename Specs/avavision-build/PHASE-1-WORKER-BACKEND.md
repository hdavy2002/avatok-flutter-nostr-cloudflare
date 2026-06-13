# PHASE 1 — Worker backend (the AvaVision API). Runs in parallel.

> Carry `MASTER-PROMPT.md`. You build the entire server side by **mirroring AvaVoice**. You create two
> new files and leave shared-file wiring to Phase Z via a glue note. **No commit.**

## Pre-flight checklist (do BEFORE writing any code — confirm each, note misses in the glue note)
- [ ] Opened `worker/src/routes/avavoice.ts` and located: the constants block, `loadAgent`,
      `composePrompt`/`mintToken`, `activeCalls` (the D1 slot count), `avavoiceSessionStart`,
      `avavoiceHeartbeat`, `avavoiceSessionStop`/`settleSession`, and the agent serializer. These are
      your line-by-line templates.
- [ ] Confirmed the **real response field convention is `snake_case`** (e.g. `session_id`,
      `token_expires_at`, `beat_every_sec`) — MASTER §4 sketches camelCase; **§A below is authoritative
      and snake_case wins.** Do not emit camelCase.
- [ ] Confirmed the ledger idempotency keys AvaVoice uses (`orderId = "avv_<uuid>"`,
      `opId = "refund:<orderId>:cancel"`, `settlementId = "avv:<sessionId>"`) so you can mirror them with
      an `avvis_` prefix (§B). Never reuse the AvaVoice `avv_` namespace.
- [ ] Read `Specs/avavision-templates.json` and noted the enum values + which templates are `ios:false`.
- [ ] Checked whether `Specs/avavision-build/PRICING.md` exists. If not, every pricing constant is a
      `// PRICING-TBD` placeholder logged in the glue note.
- [ ] Confirmed `cd worker && npx tsc --noEmit` is currently clean on a fresh tree (so any new error is
      yours), and that `config.avavisionEnabled` is the **one** expected error (Phase Z adds the flag).

## You own (create/edit ONLY these)
- `worker/src/routes/avavision.ts`  ← the whole route module (NEW)
- `worker/migrations/avavision.sql` ← the D1 schema (NEW)
- `Specs/avavision-build/glue/PHASE-1-GLUE.md` ← your glue note (NEW)
You may also **copy** `Specs/avavision-templates.json` into the repo if it is missing (it should
already be present — check first; do not overwrite it).

## You MUST NOT touch (Phase Z wires these — put the changes in your glue note)
`worker/src/index.ts`, `worker/src/routes/config.ts`, `worker/wrangler.toml`.

## Read first (your blueprint — READ ONLY)
- `worker/src/routes/avavoice.ts` — **copy its structure function-for-function.** This is the single
  most important file. Your `avavision.ts` is this file with `avavoice`→`avavision`, plus vision fields,
  plus the snapshot route.
- `worker/migrations/avavoice.sql` — copy the table shapes.
- `worker/src/routes/translate.ts` — `mintToken` (ephemeral token via
  `https://generativelanguage.googleapis.com/v1alpha/auth_tokens`); copy how it locks config into the
  token. You will additionally lock the **video** config (`mediaResolution: MEDIA_RESOLUTION_LOW`, ~1 fps).
- `worker/src/ledger.ts`, `worker/src/routes/wallet.ts`, `worker/src/money.ts`, `worker/src/db/shard.ts`
  (`metaDb`), `worker/src/authz.ts` (`requireUser`, `isFail`), `worker/src/util.ts` (`json`),
  `worker/src/routes/config.ts` (`readConfig`), `worker/src/routes/insights.ts`,
  `worker/src/routes/affiliate.ts` (`settleAffiliate`).
- `Specs/avavision-templates.json` — the template catalog you serve and validate against.
- `Specs/avavision-build/PRICING.md` if Phase 0 finished — for the min rate + snapshot cap + snapshot
  model string. If it is not ready, use placeholders flagged `// PRICING-TBD` and document them in the
  glue note so Phase Z reconciles.

## CRITICAL reality (from master §3) — do not deviate
- **NO Durable Object.** AvaVoice enforces the 10-slot cap by **counting active `avavoice_sessions`
  rows** with a 2-minute stale-heartbeat sweep. Mirror this with `avavision_sessions`. Do **not** create
  a `VisionSessionDO` or `AgentPresenceDO` (it would force a `wrangler.toml` migration = forbidden here).
- **Snapshot rate-limit = a D1 counter.** `avavision_sessions.snapshot_calls` checked against the
  agent/template `free_snapshots_per_session`. No token bucket.

## Build steps

### 1. Migration `worker/migrations/avavision.sql`
Copy `avavoice.sql` and rename tables to `avavision_*`. Add the vision columns to `avavision_agents`:
`template_id, capability, mediapipe_solution, engine_default, overlay_enabled, overlay_style,
scoring_mode, score_label, vision_mode, agentic_snapshot_enabled, free_snapshots_per_session,
media_resolution (default 'LOW'), platforms_json, save_snapshots (default 0), rubric_id`.
Keep `avavision_agent_files`, `avavision_bookings` (identical to avavoice). Extend `avavision_sessions`
with `frames_streamed, snapshot_calls, avg_score, peak_score` (all INTEGER default 0; scores nullable).
Add an optional `avavision_snapshots` table (`id, session_id, r2_key, score, created_at`) for when an
agent has `save_snapshots=1`. Keep all the AvaVoice indexes, renamed.

### 2. Route module `worker/src/routes/avavision.ts`
Mirror every exported function in `avavoice.ts`, renamed `avavision*`. Reuse the constants
(`MAX_SESSION_MIN=60`, `MAX_CONCURRENT=10`, `SESSION_LIMITS={5,10,30,60}`,
`CREATOR_PAYS_RATE_PER_HOUR=500`, `FEE_RATE=0.5`, `STALE_BEAT_MS`, etc.). Set `MIN_RATE_PER_HOUR` from
`PRICING.md` (likely ≥ AvaVoice's 100). Add:
- `avavisionTemplates(req, env)` — **NEW.** Parse `?platform=`; read `avavision-templates.json`
  (import it as a bundled JSON asset, or inline a typed copy — pick the approach AvaVoice uses for
  static catalogs like the voice list, i.e. an in-file constant is acceptable and simplest); return
  categories with templates whose `platforms[platform]` is true (no filter if platform omitted).
- `avavisionVoices()` — reuse AvaVoice's voice list (copy the `VOICES` array).
- CRUD + publish: copy avavoice's, and in **publish validation** enforce: capability ∈ enum;
  `platforms` coherent with capability (e.g. `face_landmark/segmentation/holistic` ⇒ `ios:false`);
  overlay/scoring coherence; `rate_per_hour ≥ MIN_RATE_PER_HOUR` for user-pays; `safety_notes`
  carried from the template are preserved. Reject incoherent combos with a clear 400.
- `composePrompt(...)` — copy avavoice's and insert the **VISION CONTEXT** block from master §5,
  interpolating `capability, tracked_subject, score_label, scoring_mode, agentic_snapshot_enabled`.
- `avavisionSessionStart` — copy avavoice's, but mint the token with the **video config locked**
  (`MEDIA_RESOLUTION_LOW`, ~1 fps) in addition to voice/lang; choose model
  `gemini-3.1-flash-live-preview` (vision); return the extra vision fields listed in master §4; do the
  **D1 slot gate** (count active sessions < MAX_CONCURRENT) exactly like avavoice; create the session row.
- `avavisionHeartbeat`, `avavisionSessionStop` — copy avavoice's billing/settlement verbatim
  (escrow→settle 50/50→refund unused; creator-pays one-way $5/hr; `settleAffiliate`); in `stop`
  additionally persist `frames_streamed, snapshot_calls, avg_score, peak_score` (sent in the stop body).
- `avavisionAvailability`, `avavisionStats` — copy avavoice; add avg/peak score + snapshot usage to stats.
- `avavisionSnapshot(req, env)` — **NEW, the only new media path.** Body `{ sessionId, image (base64
  JPEG) }`. Steps: `requireUser`; load session, assert `status='active'` and the caller owns it; assert
  `snapshot_calls < free_snapshots_per_session` (else 429 with a friendly "fair-use cap reached");
  call `AVAVISION_SNAPSHOT_MODEL` (`env.AVAVISION_SNAPSHOT_MODEL ?? 'gemini-3-flash'`) `generateContent`
  with the code-execution tool enabled and the frame as inline image data; parse out the annotated image
  + a numeric score + short breakdown; `UPDATE avavision_sessions SET snapshot_calls = snapshot_calls+1`;
  if the agent has `save_snapshots=1`, put the annotated image in R2 (`avatok-blobs`) and insert an
  `avavision_snapshots` row (per-account scoped key). Return `{ annotated_image, score, breakdown }`.
  Meter the token cost into the same session ledger line as the live cost (snapshots are **bundled**,
  no separate fee — owner decision Q-AV1).
- Respect a kill switch: at the top of session/snapshot handlers, read config and bail if
  `!cfg.avavisionEnabled` (the flag is added by Phase Z; reference `cfg.avavisionEnabled` and note in
  the glue note that the type/default must be added).

### 3. Type-check
`cd worker && npx tsc --noEmit` — your new file must add **no** new errors except the expected
`config.avavisionEnabled` (because Phase Z adds it). Note that one expected error in the glue note.

## Glue note (`Specs/avavision-build/glue/PHASE-1-GLUE.md`) — be exact, copy-pasteable
1. **`worker/src/index.ts`** — the `import { ... } from "./routes/avavision"` line and the full set of
   `if (p === "/api/avavision/...")` dispatch lines (mirror the avavoice block at ~line 364–391, plus
   `/templates` and `/snapshot`).
2. **`worker/src/routes/config.ts`** — add `avavisionEnabled: boolean;` to the interface and
   `avavisionEnabled: true,` to the defaults.
3. **`worker/wrangler.toml`** — add the migration tag for `avavision.sql` if migrations are listed
   there, and add `AVAVISION_SNAPSHOT_MODEL` to `[vars]` (default `gemini-3-flash`). (No new DO/binding.)
4. **D1 apply:** note that Phase Z must run `avavision.sql` against `avatok-meta` (prod + staging) via
   the REST API (per the project's migration recipe), like other meta migrations.
5. Any `// PRICING-TBD` placeholders and the values Phase 0 should fill.

## Acceptance
- [ ] `avavision.ts` + `avavision.sql` created, mirroring avavoice, with all vision fields + snapshot.
- [ ] No DO created; slot cap via D1 counting; snapshot cap via D1 counter.
- [ ] `npx tsc --noEmit` clean except the documented `avavisionEnabled` flag.
- [ ] Glue note written with exact index.ts/config.ts/wrangler.toml snippets + D1 apply instructions.
- [ ] Graphiti episode written. **No commit.**

---

## A. Authoritative request/response schemas (this is the contract Phases 2–5 build against)

**Convention (non-negotiable):** all wire fields are **`snake_case`** (matches the real AvaVoice API,
e.g. `avavoiceSessionStart` returns `session_id`/`token_expires_at`/`beat_every_sec`). Errors are
`{ "error": "<CODE_or_message>", ...context }` with the HTTP status carrying the meaning. Auth =
`Authorization: Bearer <Clerk JWT>` except public reads. Copy any field not listed here from the
matching `avavoice.ts` handler verbatim. **Phases 2–5 must mirror these names exactly** — if you change
one, update this section and flag it in your glue note so the clients follow.

**`VisionAgent` object** (returned by `marketplace`, `agents/mine`, `GET /agents/:id`):
```jsonc
{
  "id": "string", "creator_id": "string", "name": "string", "role": "string",
  "system_profile": "string", "voice_name": "string", "avatar_url": "string|null",
  "rate_per_hour": 0, "payer_mode": "user_pays|creator_pays", "session_limit_min": 5|10|30|60,
  "status": "draft|published",
  // vision additions:
  "template_id": "string", "capability": "pose|hand|face_landmark|face_detect|gesture|object|image_class|segmentation|holistic|gemini_only",
  "mediapipe_solution": "string", "engine_default": "movenet|mediapipe_pose|...",
  "overlay_enabled": true, "overlay_style": "skeleton|hand_mesh|face_mesh|bounding_box|segmentation_mask|none",
  "scoring_mode": "geometry|gemini_qualitative|hybrid|none", "score_label": "string",
  "vision_mode": "live|snapshot|both", "agentic_snapshot_enabled": true,
  "free_snapshots_per_session": 0, "media_resolution": "LOW",
  "platforms": { "android": true, "ios": false, "web": true },
  "save_snapshots": false, "created_at": 0, "updated_at": 0
}
```

**`GET /api/avavision/templates?platform=android|ios|web`** → `{ "categories": [ { "id","name","tagline","templates":[ <template objects from avavision-templates.json, filtered by platform> ] } ] }`

**`GET /api/avavision/marketplace?q=`** → `{ "agents": [ <VisionAgent + availability> ] }` where each card also carries `availability: { "state": "available|busy", "active": 0, "max": 10 }`.

**`GET /api/avavision/agents/:id/availability`** → `{ "state": "available|busy", "active": 0, "max": 10 }`.

**`POST /api/avavision/sessions/start`** — body `{ "booking_id"?: "string", "call_id"?: "string", "language"?: "en-US" }` (one of booking_id/call_id required). →
```jsonc
{
  "ok": true, "session_id": "uuid", "token": "ephemeral", "token_expires_at": 0,
  "model": "gemini-3.1-flash-live-preview", "limit_minutes": 30, "voice": "string", "language": "en-US",
  "beat_every_sec": 60,
  // vision additions (master §4):
  "capability": "pose", "overlay_style": "skeleton", "overlay_enabled": true,
  "scoring_mode": "hybrid", "score_label": "FormScore",
  "agentic_snapshot_enabled": true, "free_snapshots_per_session": 3,
  "media_resolution": "LOW", "frames_per_sec": 1
}
```
Error cases (mirror avavoice exactly): `400 {"error":"booking_id or call_id required"}`,
`404 {"error":"booking not found"}`, `409 {"error":"booking not joinable","status":"..."}`,
`409 {"error":"too early","starts_at":0}`, `409 {"error":"AGENT_BUSY"}`,
`409 {"error":"agent unavailable","reason":"..."}`, `502 {"error":"<token mint error>"}`,
`403/kill-switch {"error":"avavision disabled"}`.

**`POST /api/avavision/sessions/heartbeat`** — body `{ "session_id": "uuid" }` →
`{ "ok": true }` | `{ "ok": false, "ended": true, "status": "ended" }` (also returns the settle payload on `hard_cap`).

**`POST /api/avavision/sessions/stop`** — body `{ "session_id":"uuid", "reason"?:"user", "frames_streamed"?:0, "snapshot_calls"?:0, "avg_score"?:0, "peak_score"?:0 }` →
`{ "ok": true, "billed_minutes": 0, "gross_coins": 0, "creator_coins": 0, "refund_coins": 0, "status": "ended", "end_reason": "user|hard_cap|..." }`.

**`POST /api/avavision/snapshot`** — body `{ "session_id":"uuid", "image":"<base64 JPEG>" }` →
`{ "ok": true, "annotated_image": "<base64>", "score": 0, "breakdown": "string", "snapshot_calls": 1, "free_snapshots_per_session": 3 }`.
Errors: `404 {"error":"session not found"}`, `409 {"error":"session not active","status":"..."}`,
`429 {"error":"SNAPSHOT_CAP_REACHED","snapshot_calls":N,"free_snapshots_per_session":N}` (friendly,
no charge), `502 {"error":"<snapshot model error>"}`.

**Publish validation errors** (`POST /agents/:id/publish`): `400 {"error":"VALIDATION","field":"<name>","detail":"..."}` — e.g. capability/platform incoherence, `rate_per_hour < MIN_RATE_PER_HOUR`, missing `safety_notes`, missing 1–5 listing photos.

## B. Idempotency contract (mirror AvaVoice's ledger discipline — clients WILL retry)

Network retries and dispose-on-swipe (Phase 3/5) mean every money-moving or counter-moving call can
arrive **more than once**. Make them safe:

- **Order/escrow:** booking & call-now mint `order_id = "avvis_<uuid>"` (own namespace, never `avv_`).
  `hold(env, uid, order_id, ...)` is keyed by `order_id` — a duplicate hold with the same `order_id`
  must not double-charge (mirror how avavoice relies on this).
- **Refund/release:** use deterministic `opId`s — `release` → `settlementId = "avvis:<session_id>"`;
  `refund` → `opId = "refund:<order_id>:cancel"` / `"refund:<order_id>:unused"`. Re-running settlement
  with the same id is a no-op.
- **`sessions/stop`:** must be **idempotent** — if `status != 'active'`, return the already-settled
  result, do NOT settle again (avavoice does this: it loads the row and short-circuits). Phase 3/5 fire
  stop fire-and-forget on unmount, so double-stop is expected.
- **`snapshot`:** the `snapshot_calls` increment must not be double-counted on a retried request that
  already succeeded. Increment **after** a successful model call, in the same write that records the
  result; if a client lacks a natural idempotency key, accept the rare double-count but never let a
  failed model call increment the counter (cap is fair-use, err on the user's side).
- **`heartbeat`:** naturally idempotent (last-write-wins on `last_beat_at`).
- **create/update agent:** server generates the id; a duplicate `POST /agents` creates a second draft
  (acceptable). If you add an optional `Idempotency-Key` header, document it here; otherwise the client
  must guard the button (Phase 2/4 note this).
