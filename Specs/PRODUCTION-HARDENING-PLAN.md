# Production Hardening Plan — Global Release Readiness

Owner directive (2026-07-05): the app ships to a global audience (~1M users/day target).
Nothing stays "half done". This plan closes every known gap from the 2026-07-05
investigation/fix batch and adds the scale-readiness work a launch of this size demands.

Principle: **Sat's flaky phone is not an edge case — at 1M users/day it is the median
user.** Bad networks, dying FCM tokens, killed apps and mid-call drops are the normal
operating environment. Every layer must assume them.

---

## Phase 1 — Correctness gaps left open (DO NOW, before next release build)

### 1.1 Server message idempotency — InboxDO client_id dedupe  [SRV-MSG-IDEMP-1]
**Gap:** `worker/src/do/inbox.ts` `append()` is a plain INSERT. The client outbox
([MSG-OUTBOX-1]) retries on lost ACKs, so a retry whose first attempt actually landed
would duplicate the message server-side. At 1M users/day on mobile networks, lost ACKs
are a certainty (thousands/day), not an "extreme edge".
**Fix:**
- DO-local SQLite: `CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_client ON messages(conv, client_id) WHERE client_id IS NOT NULL;` (partial index — legacy NULL client_id rows unaffected). Run in the schema-ensure path so every DO self-migrates on first touch.
- `append()`: `INSERT ... ON CONFLICT(conv, client_id) DO NOTHING RETURNING id`; when no row returned, SELECT the existing id and return it with `dedup: true` (ACK stays consistent, client removes from outbox).
- Do NOT bump unread/conv_meta on a dedup hit.
- Telemetry: `msg_dedup_hit` (worker→PostHog) with conv hash + attempt metadata.
**Blast radius:** one DO class; per-user DOs migrate lazily; zero client change; deploy avatok-api.
**Verify:** unit-style replay — POST same client_id twice → one row, same id, second response flagged dedup.

### 1.2 Media-upload resume after app kill  [MSG-OUTBOX-2]
**Gap:** [MSG-OUTBOX-1] auto-resumes text only. Media bytes live in RAM; app kill mid-upload = the user must notice and re-send.
**Fix:**
- On send: copy the picked file into a per-account spool dir `…/outbox_media/<AccountScope.id>/<clientId>` (per-account scoping rule) BEFORE upload starts; outbox entry references the spool path + upload params (crypto key for private media as already used by MediaService).
- Outbox drain: if entry has a spool file and no media_ref yet → (re)upload first (single-flight), then send the message; delete spool file only after server ACK of the message.
- Spool hygiene: cap (e.g. 200 MB / 50 items) with oldest-given-up eviction; clear on account switch via the existing outbox reset hook.
- Resume granularity: whole-file re-upload is acceptable at current media caps (40 MB); chunked/resumable upload (R2 multipart) is a later optimization — noted, not blocking.
- Telemetry: `msg_outbox_media_respooled`, `msg_outbox_media_sent`.

### 1.3 Push/FCM token resilience — no single point of ring failure  [PUSH-RESIL-1]
**Gap:** ring delivery is FCM-or-nothing. Telemetry shows recurring `push_token_pruned`
(404s), `push_register_failed` 400/401, `push_no_device all_tokens_pruned`. When tokens
rot, calls ring nobody and the caller fake-rings (now at least fail-fast after
[CALL-DIAL-FAIL-1]).
**Fix (layered):**
- **L1 Client self-heal:** re-register the FCM token (a) on every cold start (exists), (b) on app resume if last successful register > 24h, (c) immediately when the server reports the token invalid (see L2), (d) after `onTokenRefresh`. Exponential retry on 4xx/5xx with the reason logged (`push_register_failed` already exists — add `retry_scheduled`).
- **L2 Server→client invalidation signal:** when fan-out prunes a token (FCM 404/410), push a control message into that user's InboxDO (`kind:'sys', t:'push_token_invalid'`). The client's live InboxDO WebSocket receives it and immediately re-registers. Cost: one DO append; no new infra.
- **L3 WS ring fallback:** the InboxDO hibernatable WebSocket is a live channel whenever the app is foregrounded/recently active. Deliver call invites down BOTH paths: FCM push AND an InboxDO control message (`t:'call_invite'`, same payload, same dedup by callId via existing `_seenIncoming`). If FCM is dead but the socket is up, the phone still rings. (Android background kill still needs FCM — this covers the huge "app open, token rotten" class seen with Sat.)
- **L4 Un-dark the unreachable signal:** the worker already relays `ring-ack ok:false` on zero-device fan-out but it's gated behind `receptTakeoverGuard=false`. Device-test then flip the KV flag so callers get instant "can't be reached" instead of a 35s fake ring. (Flag flip = KV patch; remember the KV-overrides-code-defaults lesson from 2026-07-04.)
- Telemetry: `push_reregister_forced` {trigger}, `call_invite_ws_delivered`, plus a dashboard (below).

---

## Phase 2 — Scale readiness for 1M users/day (before public launch)

### 2.1 Load & concurrency reality check
- Per-user InboxDO + per-call CallRoom DO shard naturally — the architecture is right for scale. The risks are the SHARED chokepoints: D1 tables (conversation_members, users), KV config reads, the push fan-out consumer queue, TURN capacity.
- Actions: k6/artillery load scripts against staging (place-call storm: 500 concurrent dials; message storm: 10k msgs/min; sync storm: 50k reconnects after a simulated outage — the "thundering herd" case when a region's network blips). Document p95s; fix what falls over. TURN: measure relay minutes/call and price/capacity plan (Cloudflare Calls TURN).
- D1: audit every query on the hot path for indexes; move anything per-message off D1 (already the design — verify no regressions crept in).

### 2.2 Release gates (no build ships without these green)
1. **Static gate:** CI `flutter analyze` + `dart format --set-exit-if-changed` job (manual-dispatch workflow like everything else, run before every release build; agents can't run analyze locally, so CI must). Worker: `tsc --noEmit` + vitest for InboxDO/CallRoom invariants (2-peer cap, dedupe, cursor sync).
2. **Device-test checklist:** the two-phone script (call each ways, accept, hang up, minimize, background, kill mid-call, airplane-mode mid-call, message under airplane mode → reconnect) — extend Specs/DEVICE-TEST-CHECKLIST with the new telemetry assertions (call_dup_session_blocked==0 on clean runs, msg_outbox_sent recovers 100% of airplane-mode sends).
3. **Telemetry gate:** PostHog release dashboard (below) reviewed after every staged rollout step.

### 2.3 Staged rollout + kill switches
- Play Console staged rollout: internal → 5% → 20% → 100%, each step gated on the telemetry dashboard (crash-free rate, call_connect success %, msg delivery %).
- Every new subsystem behind a KV kill switch (pattern exists: conferenceEnabled). Add: `outboxEnabled`, `wsRingFallbackEnabled`, `mediaWatchdogEnabled` — flip off remotely without a build if something misbehaves at scale.
- Crash reporting: verify Crashlytics (or Sentry) is wired and symbolicated; crash-free-users is a rollout gate metric.

### 2.4 Observability & alerting (PostHog)
- **Release-health dashboard:** call placement success rate, connect rate, median setup time, `call_media_stalled` rate, `call_dup_session_blocked`, `reconnect_failed` rate, `msg_outbox_gave_up` rate, `push_no_device` rate, `push_register_failed` rate — split by app version.
- **Alerts** (PostHog alerts / scheduled queries): page when call-connect success < 90% over 1h, `msg_outbox_gave_up` > 0.5% of sends, `push_no_device` > 2% of invites.
- Sampling plan: at 1M DAU, keep call/message OUTCOME events at 100%, downsample chatty progress events (call_progress every 30s → sample 10%) to control PostHog cost.

### 2.5 Cost & quota audit
- FCM (free but quota-limited per-device), Cloudflare DO duration + requests, R2 egress, TURN minutes, Gemini receptionist minutes (per-call cost telemetry exists), PostHog events/month. Produce a per-1000-DAU unit-cost sheet so growth doesn't surprise billing.

---

## Phase 3 — Durability & recovery (fast follow, within 2 weeks of launch)

- **Server-side call state authority:** CallRoom DO becomes the single truth for "call alive"; clients reconcile on reconnect (kills any remaining stale-busy class bugs permanently).
- **Chunked resumable media upload** (R2 multipart) replacing whole-file retry from 1.2.
- **InboxDO storage lifecycle:** growth policy per user (message TTL/archive to R2 — design exists in ABLY-R2 notes; revisit Cloudflare-native), so 1M users don't grow unbounded DO SQLite.
- **Multi-region latency:** measure DO placement effects for IN/EU/US users; enable location hints where they help call setup time.
- **Chaos drills:** scripted loss injection (drop WS mid-call, 50% packet loss, kill FCM) in a staging harness so regressions in resilience are caught before users find them.

---

## Execution order & sizing

| Item | Size | Deploy | Blocks release? |
|---|---|---|---|
| 1.1 InboxDO dedupe | S (½ day) | worker deploy | YES |
| 1.2 Media spool/resume | M (1 day) | app build | YES |
| 1.3 Push resilience L1-L3 | M-L (1-2 days) | app + worker | YES |
| 1.3 L4 flag flip | XS | KV patch after device test | YES |
| 2.2 CI analyze/tsc gate | S | workflow (manual dispatch) | YES |
| 2.1 Load tests | M | staging only | YES (results reviewed) |
| 2.3 Kill switches + staged rollout | S | app + KV | YES |
| 2.4 Dashboard + alerts | S | PostHog | YES |
| 2.5 Cost sheet | S | doc | no |
| Phase 3 items | L | post-launch | no |

Definition of done for each item: code + telemetry + device-test assertion + Graphiti episode. No item is "done" on code alone.
