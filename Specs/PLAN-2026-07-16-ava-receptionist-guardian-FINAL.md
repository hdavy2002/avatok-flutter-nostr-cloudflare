# CANONICAL ARCHITECTURE v1.0 — AvaDial Programmable Call Platform (voicemail · AI receptionist · Guardian)
**FROZEN 2026-07-16.** Approved for implementation after four review rounds (final: 9.8/10).

## Architecture Stability

This document defines the **stable architectural contracts** of the AvaTOK PSTN Platform. The following concepts are **frozen**: the canonical pipeline, service boundaries, call state machine, event model, Capacity Manager, PlatformPolicy, Resource Manifests, Execution Modes, CallContext, the single-writer principle, and the VoiceEngine abstraction. New features must extend these abstractions, never bypass them. **Changing any frozen contract requires an Architecture Decision Record (ADR)** — a dated `Specs/ADR-*.md` stating the contract changed, why production evidence demands it, and the migration — approved by the owner. An implementation commit is never sufficient.

**Free to evolve without ADR** (implementation concerns): engine/model choices (Gemini/OpenAI/local), STT/TTS providers, prompt design, Guardian algorithms, embedding models, cost optimizations, queue implementations, schema details, telemetry fields, retry policies.

**Execution milestones:** ① ship voicemail-only (AI dark) → ② real users + telemetry → ③ AI for internal accounts → ④ AI for paid users → ⑤ scale Capacity Manager on real traffic, not estimates. Production data feeds back into the architecture only when it exposes a genuine weakness.

> **🧭 ARCHITECTURAL GUARDRAIL — read before changing anything in this document or the code it describes.**
> Design this as a **programmable communications platform, not an AI receptionist.** Every new feature must fit the canonical pipeline:
> `PSTN → Admission Controller → Execution Planner → Capacity Manager → Execution Mode → Call Controller → Post-Call Pipeline`.
> Do not introduce feature-specific paths or branching architectures. If a new capability cannot fit this pipeline, **redesign the capability, not the platform.** AI is one execution mode among many; no model vendor is an architectural dependency (Gemini is merely the first `VoiceEngine` implementation — the platform must read identically if it were OpenAI, Claude, or a local model).
>
> **Prefer extending the platform over introducing exceptions.** New features are implemented by adding a new Execution Mode, Resource Manifest, PlatformPolicy field, or Event type — never by sprinkling special-case conditionals (`if premium`, `if ivr`, `if business`) into the canonical pipeline. If a feature seems to require bypassing the pipeline, redesign the feature.
>
> **Every module has one owner and one responsibility.** No module may import implementation details from another execution mode. Shared functionality belongs in platform libraries — never cross-imports between voicemail, AI, IVR, or future modes.
**Date:** 2026-07-16 · **Supersedes:** `PLAN-2026-07-16-vobiz-voicemail-v1.md` (voicemail-only v1 is REVERSED by owner — AI conversation is back in v1) · **Research:** `RESEARCH-2026-07-16-vobiz-ai-receptionist-unknown-calls.md` · **Plain-English version:** `EXPLAINER-ava-receptionist-plain-english.md`

## 🏛 PLATFORM ARCHITECTURE v2 — principal-engineer review adopted (2026-07-16, evening)

**Reframe: this is not "an AI receptionist" — it is a programmable call platform.** AI is one execution mode among many (voicemail, AI agent, future: IVR, human transfer, spam sink, reject). Everything below supersedes conflicting statements elsewhere in this doc.

### Canonical pipeline

```
PSTN (carrier CFB/CFNRy) → Vobiz DID → /api/pstn/answer
        → ADMISSION CONTROLLER   (pure policy — consumes PlatformPolicy, knows no vendors)
        → EXECUTION PLANNER      (mode + its Resource Manifest)
        → CAPACITY MANAGER       (leases the manifest's resources, or degrades the mode)
        → EXECUTION MODE:  VOICEMAIL | AI_AGENT | REJECT | (future: IVR, HUMAN_TRANSFER, SPAM_SINK, …)
        → CALL CONTROLLER  (per-call DO — sole owner/writer of call state)
        → POST-CALL PIPELINE (R2 → transcript → Inbox → Guardian → Billing, all async)
```

**Admission Controller (`worker/src/lib/call_admission.ts`, AVA-RCPT-26 — the most important service).** A pure, fast function: `(owner, caller, now, capacity) → ExecutionMode`. Evaluates in order: owner resolved? → tier capability → owner preference → business hours → health mode / kill switches → daily quota → country availability. **Admission decides only what the owner is ENTITLED to — it never asks whether resources are available.** Whether the entitlement can actually run is the Capacity Manager's answer, reached via the Execution Planner; a failed lease makes the *Planner* degrade the mode to VOICEMAIL. Every "no" at any layer degrades to VOICEMAIL, never to a dropped call. **The core promise: you never lose a call — worst case is voicemail, never busy.** No `if premium` anywhere — it evaluates the capability matrix:

| Capability | Free (Tier 0) | Paid (Tier 1) | Business (Tier 2) |
| --- | --- | --- | --- |
| Voicemail | ✅ guaranteed, unlimited | ✅ | ✅ |
| AI agent | ❌ | ✅ best-effort (lease) | ✅ guaranteed (reserved slots) |
| Max AI time | 0 | 3 min | 5 min |
| Guardian | passive (signals harvested from voicemail transcript) | passive | active (alerts, reports) |
| Transcript | yes (Whisper, async) | yes | yes |
| Priority | low | medium | high |

Matrix lives in config (KV-backed, per-tier rows), not code — evolving a tier = data change.

### Voicemail Engine — total separation, near-zero compute (AVA-RCPT-27)

Voicemail knows **nothing** about Gemini, prompts, Guardian, or the media plane. It is **pure Vobiz XML — no WebSocket, no DO, no audio ever touches our infrastructure during the call:**

```xml
<Response>
  <Speak>…is not available. Please leave a message after the beep.</Speak>
  <Record maxLength="25" timeout="10" playBeep="true" fileFormat="wav" callbackUrl=…/>
  <Speak>Thank you.</Speak><Hangup/>
</Response>
```

Vobiz records, then POSTs `RecordUrl` to our callback → async: fetch file → R2 (`voicemail/<owner>/…` key) → Whisper transcript → InboxDO card → push → Guardian queue. Marginal cost per voicemail ≈ one webhook + one file fetch — **this is why the free tier can absorb millions of calls.** Owner's UX spec: greeting → beep → 25 s recording.
**Ending behavior (owner-confirmed 2026-07-16):** clean cut at 25 s — greeting ("…please leave a message after the beep; you have 25 seconds") → beep → 25 s recording → "Thank you" → hangup. The originally-specced per-second warning beeps from 20 s are dropped: Vobiz can't inject audio mid-recording in XML mode, and streaming free calls through our media plane just for beeps would defeat the zero-compute scaling win.

### AI Engine — leased slots, dark until flipped (AVA-RCPT-28)

- **AI Lease Manager** (singleton DO or KV counter with strong semantics): pools of slots — `ai_slots` (sized to purchased Vobiz concurrency minus voicemail headroom and Gemini quota), Tier-2 reserved sub-pool. Admission acquires a lease **before** returning `<Stream>` XML; no lease → VOICEMAIL mode. Lease released on finalize (DO alarm reaps leaked leases). Slots are the unit of capacity planning: N ai_slots, effectively-unbounded voicemail, M transcription/embedding queue consumers — separate pools, separate scaling.
- **Call Controller owns the call; AI is a plugin.** The per-call DO (state machine, AVA-RCPT-17) owns timers, billing, recording, transcript, hangup, routing — the VoiceEngine is invoked, never in charge. Business logic never lives in the DO beyond lifecycle; everything else is plugin modules. One call = one DO stays (correct at 1M scale); the DO is thin.
- Tier max time: 3 min (Paid) / 5 min (Business) via the capability matrix, enforced by controller timers.

### Platform contracts (review #3, 2026-07-16 — adopted; AVA-RCPT-29, shared types module `worker/src/lib/platform_types.ts`)

1. **Capacity Manager** (renamed from AI Lease Manager): general resource leasing — AI slots today; STT/TTS workers, outbound slots, GPU pools, Tier-2 reserved capacity tomorrow. Admission never talks to it directly.
2. **Execution Planner** sits between Admission and Capacity: Admission outputs an execution mode; the Planner attaches the mode's **Resource Manifest**; Capacity leases exactly what the manifest declares. Admission knows nothing about AI, Gemini, or any resource type — it only asks "may this mode start for this owner now?"
3. **Resource Manifests** (data, not code): `VOICEMAIL: {vobiz_channel:1}` · `AI_AGENT: {vobiz_channel:1, ai_slot:1, stt:1, tts:1, do:1}` · future modes declare their own. No special cases in Capacity — it just checks manifests against pools.
4. **Canonical `CallState` enum** — single definition in `platform_types.ts`, consumed by the worker, the DO, PostHog events, analytics, and billing. No string literals, no duplicate enums, anywhere. (Mirror constants generated for Dart/Kotlin if clients ever display state.)
5. **Immutable `CallContext`** built once at admission and passed to every module: `{call_id, trace_id, conversation_id, owner, caller, tier, execution_mode, call_state, admission_reason, capacity_lease, policy_snapshot_id}`. Nobody reconstructs context from scratch.
6. **Trace IDs everywhere:** `trace_id` (+ `call_id`, `conversation_id`) stamped on every log line, telemetry event, queue message, Guardian row, inbox envelope, and billing record. One grep = the whole life of a call.
7. **Health modes** (in PlatformPolicy, flippable via KV — no deploy): `NORMAL` (matrix as configured) → `DEGRADED` (Paid falls back to voicemail; Business keeps reserved AI) → `EMERGENCY` (everyone → voicemail) → `MAINTENANCE` (everyone → voicemail + ops banner). Admission reads the mode as just another policy input.
8. **`PlatformPolicy` object:** one KV-backed snapshot `{health_mode, ai_enabled, capability_matrix, business_hours_defaults, quotas, kill_switches}` loaded once per request; Admission consumes the snapshot, never does scattered config lookups. Versioned (`policy_snapshot_id` lands in CallContext for auditability).
9. **Single-writer rule:** *the Call Controller (per-call DO) is the only component permitted to mutate call state.* Guardian, Billing, VoiceEngine, Telemetry, Inbox only **emit events**. This is a review-blocking rule for every subagent lane.
10. **Vendor de-anchoring:** platform-level sections and code speak only of `VoiceEngine`; `GeminiLiveEngine` / `OpenAIRealtimeEngine` / `ClaudeVoiceEngine` / `LocalVoiceEngine` are leaf implementations. No vendor name appears outside `voice_engine_impls/`.

### Platform contracts — round 2 (review #4, 2026-07-16 — adopted, final)

11. **Manifest `priority` field** (`LOW|MEDIUM|HIGH|CRITICAL`): AI_AGENT(Paid)=MEDIUM, AI_AGENT(Business)=HIGH, emergency modes=CRITICAL. Enables preemption decisions in Capacity.
12. **Capacity pool classes:** every pool splits into `reserved` (Tier-2 guaranteed) / `shared` (best-effort) / `burst` (overflow buffer). Example at scale: 200 ai_slots = 150 shared + 30 business-reserved + 20 burst. Business always gets AI.
13. **Backpressure — the third state between accept and reject** (`NORMAL → THROTTLED → SHEDDING`, per pool, surfaced in PlatformPolicy): THROTTLED = leases still granted but degraded (shorter max time e.g. 2 min, cheaper engine/model if available, skip non-essential post-call work like summary — transcript still produced); SHEDDING = no new AI leases, Planner degrades to VOICEMAIL. Thresholds config-driven (e.g. THROTTLED at 75% pool utilization, SHEDDING at 92%). Degrade gracefully before failing completely.
14. **Policy hierarchy:** `GlobalPolicy → TenantPolicy (region/market: IN, UK, EU…) → OwnerPolicy`, merged top-down into the per-call snapshot. Regional divergence (regulations, hours conventions, languages) = data, not code.
15. **Event Contract** (`platform_types.ts`): the only telemetry primitive is a typed event — `AdmissionDecision, LeaseGranted, LeaseRejected, CallAnswered, ExecutionStarted, ExecutionEnded, RecordingUploaded, TranscriptReady, InboxDelivered, GuardianQueued, GuardianScored, BillingCompleted, StateTransition(from,to,reason)` — each carrying `CallContext` identifiers. PostHog, Billing, and Guardian are *consumers* of these events; no module emits ad-hoc telemetry.
16. **Versioning extends to policy:** `PlatformPolicy`, the capability matrix, and admission rules are all versioned; every `AdmissionDecision` event records `policy_snapshot_id` — "why did this call get voicemail?" is answered by "policy snapshot 47," deterministically.
17. **CallContext is frozen:** no setters, no mutation (`Object.freeze` / readonly types). A changed fact = a new `CallSnapshot vN` linked to the original, never an edit.
18. **Thin-DO hard rule (review-blocking):** the Call Controller DO owns state, timers, transitions, and event emission — nothing else. AI inference streaming passes *through* it; Whisper, Guardian analysis, embeddings, and billing computation happen in queue consumers after the call. Any heavy compute inside the DO fails review.
19. **Disaster recovery — expected behavior (defined now, implemented later):** Cloudflare colo/region unavailable → Workers re-route automatically (platform property); an in-flight call's DO is unreachable → that call is lost (finalize via Vobiz hangup webhook when it arrives; mark `state=LOST`, deliver whatever exists to Inbox with `degraded:true`); recordings are safe in Vobiz until fetched (callback retries) → R2; post-call queues replay idempotently (dedupe on `call_id`). Recovery invariant: **no acknowledged recording is ever lost; a lost live call always leaves an auditable event trail.**

20. **Voicemail durability rule (owner-locked 2026-07-16 — FROZEN):** voicemails are **durable user assets, not chat frames**. InboxDO's retention prune is hard-exempted for `kind IN ('voicemail','receptionist','recept')` (implemented in `do/inbox.ts prune()`, AVA-RCPT-20) — enabling `INBOX_RETENTION_DAYS` for chats must never age out a voicemail. No R2 lifecycle rule may ever be added to `voicemail/` keys. Voicemail keys join the account backup scope (Drive backup / archive lane) when that lane is next touched.

### Guardian — strictly post-call (confirmed)
Guardian never touches a live call: finalize → queue → classify → embed → score, fully async (already the design; now a hard rule). Voicemail transcripts feed Guardian the same way AI transcripts do — free-tier calls still grow the spam database.

### Service boundaries (Cloudflare reality)
Advisor's nine services map to **modules + queues + DO classes in the existing worker, not microservices**: PSTN Gateway = `routes/pstn.ts`; Admission = `lib/call_admission.ts`; Call Controller = per-call DO; VoiceMail = XML templates + callback route; AI Conversation = gateway+engine libs; Inbox = InboxDO (exists); Guardian = queue consumer; Billing = `pstn_call_costs` + rollup; Telemetry = PostHog/Q_ANALYTICS. Same boundaries, deployable as one worker now, splittable later if ever needed. Hard rule enforced by the lead session at review: **no import from voicemail code into engine code or vice versa.**

### Rollout inversion (owner decision — supersedes earlier phasing)

- **V1 SHIP: voicemail for everyone.** Forwarded call → admission (trivial: everyone → VOICEMAIL) → XML voicemail → Inbox. Plus forwarding setup, Inbox UI, spam reports, Guardian passive harvest. AI code paths merged but **dark** (flag + zero ai_slots).
- **V2: flip AI for Paid** (lease manager live, 3-min cap). Everyone else unchanged.
- **V3: Business tier** (reserved slots, 5 min, active Guardian, business hours already built).

## Owner-locked scope (2026-07-16)

> **Note (evening revision):** items 1–3 below describe the full platform; per the Rollout inversion above, **v1 ships voicemail-only for all users** with the AI pipeline built dark. Free = voicemail forever; Paid = AI 3 min; Business = AI 5 min.

1. **Ava (AI receptionist) answers when a call is missed OR the callee rejects it.** Hidden-caller-ID calls go straight to Ava without ringing. Contacts always ring through. Triage style (§5c research): greet with owner's name, find out who + what, 1–2 follow-ups, "I'll let <owner> know", hang up. **Hard 3-min cap** (`receptionistMaxSeconds=180`, wrap-up cue ~2:30).
2. **The conversation (audio + transcript) lands in a new Inbox inside AvaDial** — chat-thread style: list shows "Missed call from <name/number>"; thread view shows audio player card with transcript underneath; back button to the list; **all future messages from the same number append to the same thread.**
3. **Ava Guardian:** harvest signals from transcripts (sales / scam / robocall / delivery / personal…), store signals + embeddings against the number (hash), aggregate across the whole network, maintain a per-number score; past thresholds → warn banner, then **instant block + notify the callee** on future calls anywhere in the network. Manual spam reports (with category) feed the same score.

**Execution model:** parallel **Sonnet subagents** per lane (Worker, Kotlin, Flutter, Guardian), orchestrated by the lead session, which **verifies every lane against this plan before commit**. One issue per commit via `scripts/git_safe_commit.py` with explicit paths. No builds triggered — owner ships.

**Issue prefix:** `AVA-RCPT-*`

---

## Phase 0 — Go/no-go + Vobiz wiring probe *(unchanged from prior plan, still first)*

- **AVA-RCPT-0a — Vobiz probe.** Account is live (DID +912271264209, Mumbai, ₹500/mo; auth verified; store `VOBIZ_AUTH_ID`/`VOBIZ_AUTH_TOKEN` as Worker secrets, never in git; rotate the pasted token). Deploy a dark logging route (owner approved prod dark route), create the Vobiz **Application** (`answer_url`/`hangup_url` → `/api/pstn/answer/<secret>`), attach the DID. Verify with a direct test call: webhook payload fields (esp. **`ForwardedFrom`** — documented as "original forwarding number when the carrier provides it"; this is our primary owner-mapping key), `<Stream>` WSS handshake from a Worker, frame format.
- **AVA-RCPT-0b — Carrier matrix (THE go/no-go).** Per tester SIM (Jio/Airtel/VI, dual-SIM noted): `*67*<DID>#` + `*61*<DID>#` set; verify `Call.reject()` triggers forward-on-busy; no-answer delay `**61*<DID>*11*<sec>#`; status `*#67#`; teardown `##67#`; whether `ForwardedFrom` actually arrives per carrier; what the caller hears. Results table appended here.

## Phase 1 — Worker: PSTN ingress + Ava bridge (dark behind flags)

- **AVA-RCPT-1 — Flags** (`config.ts` `PlatformConfig` + `DEFAULTS` same commit; numerics in `numericKeys`): `pstnReceptionist:false`, `receptionistMaxSeconds:180`, `avaGuardian:false`, `spamReportsToServer:false`. Client mirrors in `remote_config.dart`. Prove each flips on staging.
- **AVA-RCPT-2 — `/api/pstn/*` routes** (`worker/src/routes/pstn.ts`): `answer/<secret>` — resolve owner (1. `ForwardedFrom` → `phone_hash` lookup (api.ts:1076 core; needs a consent carve-out recorded at forwarding setup because of the `phone_discoverable` privacy lock), 2. expectation match, 3. unmatched → `<Hangup/>`), mint sid + KV init blob, return `<Stream>` XML to our WSS. `hangup/<secret>` — finalize safety net + Vobiz duration/cost telemetry. WS `GET /api/pstn/stream` → DO by sid. D1 migration `2026-07-16-pstn-receptionist.sql`: `pstn_dids`, `pstn_forwarding` (uid, sim, carrier, codes-set state, consent), `pstn_expectations` (or KV). **DID pool is a separate namespace from AvaTOK virtual numbers** (numbering.ts never-PSTN invariant).
- **AVA-RCPT-3 — `PstnReceptionRoom` DO** (new; wrangler.toml binding + `new_sqlite_classes` in **prod AND staging** sections), structured as **two decoupled layers** (advisor review 2026-07-16, adopted):
  - **Voice Gateway layer** (`worker/src/lib/voice_gateway.ts`): owns everything transport — Vobiz JSON protocol (`start`/`media`/`stop`), G.711 μ-law 8 kHz base64 ↔ PCM16 transcode, 160-byte/20 ms outbound framing, `clearAudio` barge-in, heartbeats/reconnection, session timers. Knows nothing about which AI is on the other side.
  - **VoiceEngine abstraction** (`worker/src/lib/voice_engine.ts`): `interface VoiceEngine { connect(ctx); sendAudio(pcm); onAudio(cb); onTranscript(cb); end(); }`. First implementation `GeminiLiveEngine` extracted from `reception_room.ts`; the DO and gateway code never import Gemini directly. Engine selection via config (future: OpenAI Realtime, Claude, local) — swap without touching transport or business logic.
  - Business logic (triage prompt with owner name via `contactFor`/`nameFor`, `receptionistMaxSeconds` enforcement — wrap-up cue at cap−30s, hard stop at cap, recording assembly, transcript + summary) sits in the DO on top of both, shared with the in-app path via `worker/src/lib/reception_core.ts`. Finalize = existing `postMessage()` shape → InboxDO `/append` (`kind:"receptionist"`, R2 recording, `scope:to:<owner>`) + `Q_PUSH` notify — **thread key must be stable per caller number** (see Phase 3) so future calls append to the same thread.
- **AVA-RCPT-4 — Expectation pre-registration** `POST /api/pstn/expect` (HMAC device-token auth per `missedcall.ts` pattern; callable from native with Flutter engine dead). Fired on reject and on missed-call detection; `"anonymous"` marker for hidden-ID.

## Phase 2 — Device: routing + forwarding setup (dark)

- **AVA-RCPT-5 — Reject/missed hooks.** `AvaInCallService`: on user decline → fire `/api/pstn/expect` then `Call.reject()` (CFB diverts). Missed (ring timeout) → carrier CFNRy diverts on its own; still fire expect from `AvaMissedCallReceiver` for mapping. No third button needed — Decline itself now means "Ava takes it" once forwarding is set (UI copy should say so).
- **AVA-RCPT-6 — Hidden caller-ID auto-route.** `AvaCallScreeningService` null-handle branch: flag-mirror-gated `setDisallowCall(true)+setRejectCall(true)` + expect(`anonymous`). Only auto-reject in the system. Native mirror `pstn_config.json` (`writeFileAtomic` pattern, pushed from `shell_v2.dart` like `setMissedCallEnabled`).
- **AVA-RCPT-7 — Forwarding setup screen** (AvaDial settings): explain → dial `*67*/*61*` per-carrier codes (per-SIM aware) → verify `*#67#` → record consent + state (server `pstn_forwarding` + local). One-tap disable (`##67#`/`##61#`). Plain-language notes: replaces carrier voicemail; forwarded leg may be carrier-billed. Assign pool DID here.

## Phase 3 — AvaDial Inbox (Flutter lane)

- **AVA-RCPT-8 — Inbox list screen** (new `app/lib/features/avadial/inbox/`): entry point in AvaDial shell (`avadial_root.dart`). Lists receptionist threads — one row per caller number: display name (contacts/CNAP fallback number), last-call time, unread badge. Data source: the owner's InboxDO conversations filtered to the receptionist/voicemail conv namespace.
- **AVA-RCPT-9 — Thread view:** chat-style; each screened call = one card: audio player (existing `voicemail/`-key streaming route authorizes owner-only) with **transcript rendered underneath**, plus Ava's one-line summary; **back button (top) to the inbox list**; newest at bottom. **Thread key = `recept_<owner>__tel:<E.164>`** (already the fallback convention in `reception_room.postMessage`) so every future call from that number appends to the same thread — verify normalization so `+91` variants collapse to one thread. Row actions: Add to contacts (→ future calls ring through), Report spam (category picker), Block.
- **AVA-RCPT-10 — Per-account scoping check:** all local caches for inbox/audio per `AccountScope.id` (rulebook rule 1); decrypted/downloaded audio under `…/media/<AccountScope.id>/` (rule 2).

## Phase 4 — Ava Guardian (signal harvest → network protection)

**Data rule (non-negotiable):** recordings + transcripts + summaries stay per-owner. What is pooled network-wide: **number hash + extracted category signals + confidence + embedding vector + timestamps.** Never raw text tied to a specific callee. **Detachment rule (advisor review 2026-07-16, adopted):** once a transcript is classified, the pooled record is severed from the owner account — `guardian_signals`/Vectorize rows carry NO owner uid, only a **salted one-way reporter fingerprint** (HMAC(uid, rotating salt)) whose sole purpose is distinct-reporter counting and anti-brigading; it cannot be resolved back to a user, and raw uid never leaves the finalize step. AvaBrain master/per-app consent toggles gate harvesting (rulebook rule 3); harvesting is on the OWNER's side of a call made TO them by a stranger — document the legal basis per market; add a recording-consent line to Ava's greeting where required.

- **AVA-RCPT-11 — Signal extraction.** On finalize, queue (`Q_ANALYTICS`-style consumer or new queue `Q_GUARDIAN`) a Workers AI classification of the transcript → `{category: sales|scam|robocall|delivery|personal|other, confidence, sub_signals: [loan_offer, otp_request, threat, impersonation…], language}`. Store in D1 `guardian_signals (e164_hash, category, confidence, sub_signals_json, source: transcript|user_report, reporter_scope, ts)`.
- **AVA-RCPT-12 — Embeddings + similarity.** Embed transcript (Workers AI embedding model) → **Cloudflare Vectorize** index keyed by e164_hash + call id. Purpose: "familiar signals" — same pitch script from the same number (or new numbers reusing an identical script = scam-farm detection, a v2 lever). Metadata only (hash, category); no raw transcript in vector metadata.
- **AVA-RCPT-13 — Scoring.** Extend the existing `spam/scoring.ts` deterministic pipeline (versioned formula) to consume `guardian_signals` alongside `spam_number_reports`: distinct-owner count weighting, confidence weighting, decay over time, reporter-trust. Output stays in `spam_number_scores` (score 0–100, label `none|caution|red`). Thresholds owner-tunable via flags. Cron the scoring job (wrangler.toml, both envs — it's currently manual).
- **AVA-RCPT-14 — Enforcement + notify.** Push scores to devices via the existing snapshot pipe (`writeScreeningSnapshot` merge from `/api/spam/lookup` + bloom; **fix the Dart-normalized vs Kotlin-raw hash bug** or lookups silently miss). Behavior: `caution` → red banner on ring (existing verdict surface); `red` → `AvaCallScreeningService` auto-blocks (reject + skip log) and posts a notification + an entry in the same Guardian inbox thread: "Ava Guardian blocked a likely scammer (+91xx…) — tap to listen to what they told Ava previously / unblock." False-positive escape: per-user unblock overrides network verdict locally.
- **AVA-RCPT-15 — Manual reports.** Wire `BlockList.reportSpam` → `POST /api/spam/report` (copy `sms_threads_screen.dart:195`), add category param; after-call + missed-call-overlay "Report spam & block" buttons; anti-brigading (distinct uids, rate limits, SIM-verified only).

## Phase 5 — Telemetry, rollout, verification

- **AVA-RCPT-16 — PostHog** (owner email + caller hash on every event): `pstn_forward_setup`, `ava_pstn_session {match_method, duration, cap_hit}`, `ava_card_delivered`, `ava_orphan_call`, `guardian_signal {category, confidence}`, `guardian_block`, `guardian_unblock` (false-positive rate!), `spam_report {category}`, `inbox_thread_opened`, `vm_audio_played`.
- **Rollout:** staging flags first; tester loop from 0b matrix; watch orphan rate, cap-hit rate, Gemini + Vobiz spend per call; prod = merge staging→main, commit-before-deploy, `ALLOW_PROD=1` deploys, D1 migrations deliberate, flags one at a time on owner's word. `guardian_block` (auto-blocking) flips LAST, after weeks of `caution`-only data and a manual review of the first red-labeled numbers.
- **Verification pass (lead session, after each lane):** diff review of every subagent commit against this plan §-by-§; flag declarations proven flippable; thread-key stability tested (two calls, same number → one thread); privacy audit (no transcript text outside owner scope; scoped storage); telemetry events observed in PostHog; Graphiti updated per phase.

## Cost guardrails
Per screened call: Vobiz inbound leg (~₹0.45–0.65/min, ≤3 min) + Gemini Live (~₹2/min, ≤3 min; triage typically <1 min) + amortized DID rent → **typical ≈ ₹2–4/call, worst case ≈ ₹9** (advisor estimate 2026-07-16, plausible vs ₹12/min hosted orchestration platforms — validate against real Vobiz invoices in Phase 0/pilot). **DIDs are shared, never per-user** — pool sized on *concurrent* screened calls (₹500/mo × pool size ÷ monthly calls; start = 1 existing DID, grow on concurrency telemetry from hangup webhooks). The Phase-2 "assign pool DID" step points a user's forwarding at a shared number; it does not rent one. Guardian adds pennies (one classification + one embedding per call). Kill switches at every layer: `pstnReceptionist` (whole feature), `receptionistMaxSeconds` (spend cap), `avaGuardian` (harvest), auto-block behind its own threshold flags.

## Capacity model (researched 2026-07-16 — no queue system needed)

**Facts (Vobiz docs + live API):** concurrency is **account-level**, not per-DID — one DID accepts unlimited simultaneous inbound calls up to the account ceiling; no per-DID channel limit exists in the docs. Current account: **`max_concurrent = 3`, `CPS = 1`** (base tier; the "10" figure is the SIP-trunk default, which doesn't apply to our XML/WebSocket app). Past the ceiling, an inbound call is **rejected at Vobiz's edge (SIP 503) — our webhook never fires**, so server-side queueing of overflow calls is impossible by design. Vobiz's "call queue" feature is a hold-music/agent-dispatch XML pattern for call centers — irrelevant here (each caller gets their own AI session; there is no shared agent to wait for). Concurrency and CPS are **purchasable add-ons** (Dashboard → Settings → Limits & Quotas → Request Increase; enterprise path for thousands of channels).

**Design consequences:**
1. **Buy headroom, don't queue.** Required concurrency ≈ **peak simultaneous AI conversations, not daily volume**: with 60–90 s sessions, 3 channels process ~120–180 calls/hour under even traffic, but only 3 callers *at the same instant*. Purchase more when observed peak utilization sustains 50–70%. **Concurrency and CPS are INDEPENDENT bottlenecks and must be raised together:** 23 concurrent + 1 CPS still fails when 5 people dial in the same second — CPS caps admission rate, concurrency caps live sessions. (Verify in Phase 0 whether Vobiz delays or rejects over-CPS inbound attempts.) Pilot: 3/1 is adequate for a handful of testers only.
2. **Monitor, don't guess.** Ops loop polls `GET /Account/{id}/concurrency` (`utilization_pct`) — telemetry alert at 70%, purchase trigger at sustained 50%. Also alert on Vobiz-edge rejects visible as caller complaints/missing hangup webhooks vs expect-registrations (an expectation with no matching answer webhook within 30 s = a call that got 503'd or the carrier didn't forward — track this `pstn_lost_call` metric).
3. **Graceful degradation INSIDE our capacity (the only "queue" we build):** the answer route counts live AI sessions; above a config cap (`receptionistMaxSessions`), serve the **plain voicemail XML** (`<Speak>+<Record>`) instead of the AI bridge — same Vobiz channel cost, zero Gemini cost, message still lands in the inbox. Caps AI spend under call storms without dropping anyone.
4. **Caller experience on true overflow** (Vobiz 503): caller hears busy/failure — acceptable at pilot scale, solved by headroom at production scale. The 140/160 series (v2 TRAI routing) uses separately purchased capacity, not the central pool.

## Operational hardening (advisor review #2, 2026-07-16 — adopted)

### The call state machine (AVA-RCPT-17 — build FIRST in the worker lane)
Canonical lifecycle owned by the DO; every telemetry event, timeout, retry, and failure maps to a transition. Persist current state in DO storage so restarts resume deterministically.

```
FORWARDED → ANSWERED → AI_CONNECTING → AI_ACTIVE → WRAP_UP → RECORDING_FINALIZE → INBOX_STORED → GUARDIAN_QUEUED → DONE
Failure edges: AI_CONNECTING|AI_ACTIVE →(engine/WS failure >2s)→ FALLBACK_VOICEMAIL → RECORDING_FINALIZE → …
               ANSWERED →(owner unresolved)→ HANGUP_ORPHAN → DONE
               any →(caller hangup)→ RECORDING_FINALIZE (with whatever was captured) → …
```

### Resilience policy (AVA-RCPT-18 — highest priority gap)
**Never dead air.** If Gemini/engine disconnects, the DO throws, or the engine-side WS drops: <2 s → silent reconnect (engine session resume or fresh session with transcript-so-far as context); ≥2 s → play "I'm having trouble — please leave a message after the beep" and switch to plain record mode (**FALLBACK_VOICEMAIL** state). Partial transcript + crash reason still delivered to the Inbox card (`degraded:true` in envelope) and to telemetry. If the *Vobiz-side* WS drops, the call is gone — finalize with whatever was captured. DO alarm as watchdog: any state older than its max age forces the failure edge.

### Runaway guards (AVA-RCPT-19 — extends the 3-min cap)
Config-driven (numerics in `numericKeys`): `receptionistMaxSeconds=180` (exists) + `receptionistMaxTurns=15` + `receptionistMaxSilenceSec=20` (caller silent → "I'll let <owner> know, goodbye" + hangup) + per-session token ceiling on the engine. Any guard tripping → WRAP_UP, never abrupt cut.

### Idempotency & duplicates (AVA-RCPT-20)
Carriers and Vobiz both retry. Answer webhook dedupe key: `CallUUID` (KV, short TTL) — replays return the same `<Stream>` XML, never a second session. Finalize/inbox dedupe already exists via InboxDO `client_id` — set it to `recept:<CallUUID>`. Hangup webhook is a no-op if state ≥ RECORDING_FINALIZE.

### Anonymous-caller threading (AVA-RCPT-9 amendment)
Hidden-number calls do NOT share one giant thread: thread key `recept_<owner>__anon_<CallUUID>` (one thread per anonymous call), listed as "Hidden number". Only real E.164s get the persistent per-number thread.

### Versioning (AVA-RCPT-21)
Every stored transcript carries `prompt_version, engine (gemini-live-x), model_version, temperature`. Every `guardian_signals` row and Vectorize vector carries `classifier_model_version, embedding_model_version` (vectors from different embedding models are incomparable — score job only mixes same-version vectors; model upgrade = new Vectorize namespace + backfill or parallel-run).

### Cost accounting (AVA-RCPT-22)
Per call, persist actuals (D1 `pstn_call_costs`): Vobiz `BillDuration`/cost from hangup webhook, engine tokens/audio-seconds, session duration, fallback used y/n. Roll up per owner per month → real per-user cost ("this user generated ₹63 this month"), reconciled against Vobiz invoices. Feeds pricing/margin decisions.

### Availability hours (AVA-RCPT-23)
Per-owner schedule beside forwarding setup (default: always on). Outside hours Ava opens with "The office is closed — you've reached <owner>'s assistant; leave a message…" and skips probing (shorter, cheaper). Stored per-account (scoped), applied in the prompt-build step.

### Escalation keywords (AVA-RCPT-24)
Safety wordlist (fire/heart attack/police/bomb/suicide + hi/regional equivalents) checked on each caller turn. On hit: Ava immediately stops probing, says "This sounds urgent — please hang up and call emergency services" (+ configurable: attempt owner ring-through via high-priority push), flags the Inbox card `urgent:true`, pushes an urgent notification to the owner. Never let the AI chat through an emergency.

### AI-loop protection (AVA-RCPT-25)
Ava-calls-Ava (two users' forwarding chains, or v2 outbound features): cap AI hops at 1 — the answer route checks whether the *caller* number is one of our own pool DIDs or a number currently in an active outbound Ava session; if so, plain voicemail XML, no engine. Additionally the greeting is detectable by our own agent (known marker phrase) as a belt-and-braces guard for v2 outbound.

## Non-goals (v1)
Live patch-through to owner mid-call; TRAI 140/160 prefix routing; orphan-call voicemail; iOS; cross-number scam-script hunting (Vectorize groundwork lands, the hunt is v2); selling/exposing Guardian data outside the network.
