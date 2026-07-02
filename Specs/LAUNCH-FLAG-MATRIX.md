# AvaTOK Launch Flag Matrix

**Source of truth for launch flag values.** Generated Phase 0 (`[P0-CLEAN-4]`), 2026-07-02.
Covers 100% of `PlatformConfig` keys in `worker/src/routes/config.ts` (interface lines 11–100,
`DEFAULTS` lines 108–150) plus the `partyEnabled` secret injected by `getConfig` (line 167).

- **Current default** = value in `DEFAULTS` (or secret state) as of this commit.
- **Launch value** = target value at go-live per `Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02.md`.
- **Flip owner** = which phase flips it (or "—" if it already equals launch).
- Flags are stored in KV `platform_config` and merged over `DEFAULTS`; flip via KV, no redeploy.
- `partyEnabled` is NOT in `DEFAULTS` — it is derived from the `PARTY_ENABLED` Worker secret.

## Core `PlatformConfig` keys

| Flag | Type | Current default | Launch value | Flip owner / notes |
|---|---|---|---|---|
| `walletRealMoney` | bool | `false` | `false` | — money-in OFF pending legal (§10.1) |
| `donationsEnabled` | bool | `true` | `true` | — not in launch plan; leave |
| `liveEnabled` | bool | `false` | `false` | — marketplace/AvaLive hidden (free launch) |
| `consultEnabled` | bool | `false` | `false` | — paid consulting hidden |
| `conferenceEnabled` | bool | `true` | `true` → `false` | **P3** — LiveKit group path; set `false` once CF-SFU flip completes |
| `groupAudioSfuEnabled` | bool | `false` | `true` | **P3** — CF Realtime SFU group audio; ON after device test |
| `brainEnabled` | bool | `false` | `true` | **P7** — AvaBrain; flip ON as last commit of P7 |
| `verseEnabled` | bool | `false` | `false` | — creator dashboard hidden |
| `identityLadderEnabled` | bool | `true` | `true` | — progressive identity gating |
| `guestTierEnabled` | bool | `true` | `true` | — L0 handle-only visitors |
| `workersAiLivenessEnabled` | bool | `false` | `false` | — Rekognition stays default liveness (P4) |
| `simOnlyPhoneEnabled` | bool | `true` | `true` | — block VoIP/temp numbers |
| `translationEnabled` | bool | `false` | `false` | — Gemini-Live cost; hidden |
| `translationGroupEnabled` | bool | `false` | `false` | — hidden |
| `avavoiceEnabled` | bool | `false` | `false` | — agent builder hidden |
| `avavisionEnabled` | bool | `false` | `false` | — agent builder hidden |
| `receptionistEnabled` | bool | `true` | `true` | — AI receptionist ON (P2/P12 refine) |
| `receptionistRings` | number | `4` | `4` | — tunable; P1 raises min ring window in client |
| `receptionistUseCf` | bool | `false` | `false` | — engine = Gemini Live (default) |
| `receptTakeoverGuard` | bool | `false` | `true` (after device test) | **P1** — gate Ava takeover on FCM ring-ack; ships dark |
| `avaAffiliateEnabled` | bool | `false` | `false` | — flip after affiliate fraud checks (post-launch) |
| `affiliateAssetKitEnabled` | bool | `false` | `false` | — v2 asset kit, not built |
| `aiEnabled` | bool | `true` | `true` | — master Ava switch / panic button |
| `focusMode` | bool | `true` | `true` | — hide non-AvaTOK apps in drawer |
| `webSearchEnabled` | bool | `false` | `false` | — premium AI cost; hidden |
| `fileAnalysisEnabled` | bool | `false` | `false` | — premium unlocks |
| `openChatUncapped` | bool | `false` | `false` | — premium removes cap |
| `dailyAvaTurnLimit` | number | `25` | `25` | — free-tier Ava turns/account/day |
| `guardianEnabled` | bool | `true` | `true` | — safety shield (free) |
| `companionEnabled` | bool | `true` | `true` | — basic free Ava chat |
| `generativeEnabled` | bool | `false` | `false` | — premium image gen hidden |
| `imageDailyCap` | number | `100` | `100` | — per-user/day image fair-use backstop |
| `ringbackEnabled` | bool | `true` | `true` | — AI ringback + busy tone (free) |
| `betaFreePremium` | bool | `true` | `true` | — no paywalls; everyone premium |
| `billingEnabled` | bool | `false` | `false` | — subscriptions/checkout off |
| `numberFeatureEnabled` | bool | `true` | `true` | — AvaTOK Number |
| `teamIvrEnabled` | bool | `false` | `false` | — Team Receptionist IVR off until dogfood |
| `ivrAiFrontDesk` | bool | `false` | `false` | — tap-menu default; AI front desk future |
| `groupInvitesEnabled` | bool | `false` | `false` | — pending-membership invites off until migration+test |
| `listingLivenessGate` | bool | `false` | `true` | **P4** — block listing create/publish unless liveness-verified; ships dark |
| `safetyScanEnabled` | bool | `true` | `true` | **P6** — always-on Nemotron per-message safety scan + red bubbles; ships ON |
| `profileCompletionGate` | bool | `false` | `true` | **P11** — mandatory + AI-vetted profile; ships dark |
| `agentDailyCap` | number | `10` | `10` | **P5** — marketplace agent conversations/user/UTC-day (0 disables) |
| `minAppBuild` | number | `0` | `0` | — min build gate; bump when forcing upgrade |

## Secret-derived key

| Flag | Source | Current state | Launch value | Flip owner / notes |
|---|---|---|---|---|
| `partyEnabled` | Worker secret `PARTY_ENABLED === "1"` | OFF (unset) | ON | **P13** — PartyKit ephemeral realtime; `wrangler secret put PARTY_ENABLED=1` staging→prod after 24h clean `party_*` telemetry |

## Flags to be added by later phases

These do not exist in `config.ts` yet; the owning phase appends its row here when it adds the flag.

| Flag | Type | Default at add | Launch value | Owner phase |
|---|---|---|---|---|
| `chatArchiveV2` | bool | `false` | `true` | P8 Stage 1 — R2 cold archive |
| `restoreV2` | bool | `false` | `true` | P8 Stage 2 — new-phone restore |
| `driveAutoBackup` | bool | `false` | `true` | P8 Stage 3 — daily Drive backup |

## Notes

- **Nostr shim purge is DEFERRED** (Phase 0 step 1): `app/pubspec.yaml` = `0.1.17+27`, below the
  `≥ 0.1.18+27` one-release compat-window threshold, so shims and `pointycastle`/`bip340` deps
  are retained and only reported this phase. Re-run the purge once a build ≥ `0.1.18+27` ships.
- **Ably** is functionally removed; only a single dead `'AblyException'` suppression string
  remained in `app/lib/main.dart` (removed in `[P0-CLEAN-3]`). Remaining `Ably` grep hits are
  history comments and the `ABLY-R2` archive rollout phase names (a real feature, not Ably).

## Phase 4 status (video liveness gate), 2026-07-02

**Done this pass (dark behind `listingLivenessGate`, default OFF):**
- **Server gate (the real, bypass-proof gate):** `worker/src/routes/listings.ts` `livenessGate()`
  helper checks `kyc_status='verified'` and returns 403 `liveness_required` from BOTH
  `createListing` and `publishListing` (covers create AND edit-to-republish, every kind).
  **Fail-closed** — a kyc lookup error is treated as unverified. Emits `listing_blocked_unverified`.
  This closes the gap where marketplace kinds were intentionally ungated (`listings.ts:316`).
- **Client UX:** marketplace composer entry (`marketplace_hub.dart`) checks
  `RemoteConfig.listingLivenessGate` + `IdentityApi` verification; unverified → friendly
  explainer → routes to the existing `IdentityScreen` (Rekognition FaceLiveness). Emits
  `liveness_gate_shown`. Uses the existing verification pipeline.

**Deferred within Phase 4 (documented follow-up — do with the on-device liveness run):**
- The ADDED turn-left/turn-right/read-a-phrase challenge pre-roll (`worker/src/routes/liveness.ts`
  machinery + Workers-AI head-pose vision + STT phrase check, provider `rekognition+challenges`).
  Rekognition already covers presence/closeness/anti-spoof (the plan says do NOT re-implement it),
  so the gate ships on Rekognition alone; the extra gestures are an enhancement needing a new
  server pipeline + a client challenge screen, unverifiable without a build/device.
- The `CreateListingFlow` (creator-services composer) already gates server-side via `requireKyc`;
  its client explainer can reuse `_openListingComposer` when that path is wired.

## Phase 12 status (receptionist status notes + language + voice), 2026-07-02

**Done this pass (server, schema-free owner decisions):**
- **One voice, forever** (owner decision 5e): `AVA_VOICE` constant (= `Aoede`, the female default)
  exported; the settings save now **ignores any client `voice_name`** (`const voice = AVA_VOICE`,
  no error for old clients); the Gemini call init + `/config` response are **pinned to
  `AVA_VOICE`**, overriding any stored custom voice. `receptionist.ts` only.
- **Feminine register, always** (owner decision 5d): an unconditional "You are a woman… use
  feminine verb/adjective forms (Hindi बोलूंगी, Spanish encantada, French désolée, Arabic/Hebrew
  feminine first-person)…" line added to the Gemini system prompt.

**Deferred within P12 (need a DB migration and/or client UI — documented follow-up):**
- **Status notes + expiry**: `status_note` + `status_expires_at` columns on the settings row,
  included in the prompt only when unexpired, lazily cleared, cache busted on save. Needs an
  `ALTER TABLE` migration + the client expanding-notes box and expiry picker.
- **Default answering language**: `answer_lang` column + country→language default table +
  prompt wiring ("Answer in <answer_lang>; switch to the caller's language if different").
- **Client UI**: expanding multiline notes box, expiry chips/custom picker, language picker, and
  **removing the voice/gender picker from the receptionist settings screen** (server already
  ignores it). `recept_status_*` / `recept_lang_set` telemetry ships with these.
- CF engine (`reception_room_cf.ts`, off by default) uses a fixed female Aura-2 voice already;
  the feminine-register line wasn't added to its separate prompt this pass.

## Phase 11 status (profile completeness + AI vetting), 2026-07-02

**Done this pass (server, behind `profileCompletionGate`, default OFF; guardWrite Nemotron on
name/bio already ran):**
- `/api/me` now returns `profile_complete` (photo + first + last + birth year + gender + About;
  phone optional).
- Profile save (`api.ts:profileUpsert`) enforces, when the gate is ON: **completeness** (400
  `profile_incomplete` + `missing[]`), then **real-name plausibility** via `gemini-2.5-flash-lite`
  (`vetRealName`, few-shot per the plan — "Midnight Rod" implausible, "Satish"/"Al Wu" pass; min
  length 2), 400 `implausible_name` with a kind message. **FAIL CLOSED**: model outage → 400
  `vet_unavailable` "try again in a minute". `brainFact('profile_updated')` feeds the receptionist/
  AvaBrain. Telemetry `profile_vet_started/passed/rejected/error`. Client flag mirror added.

**Deferred within P11 (documented follow-up):**
- **Photo moderation** (Rekognition `DetectModerationLabels` on the avatar, reject Explicit
  Nudity/Sexual): needs a helper + the image-byte fetch from R2/URL — not wired this pass.
- **Client UX**: completeness gate (red fields + `Scrollable.ensureVisible` to the first missing
  field), the "Ava is checking your profile…" hold state, and existing-user routing to Profile
  on login when `profile_complete=false`. Server gate is bypass-proof already; this is the polish.

## Phase 7 status (AvaBrain), 2026-07-02

**Audit findings:**
- **Retrieval already exists and is uid-safe.** ChatAva (`do/ava_agent.ts:brainSearch`) calls
  `brainSearchLines` (`lib/ava_memory.ts`), which queries Vectorize with a **HARD `filter:{uid}`**
  ("never optional", `ava_memory.ts:72-74`). Cross-uid retrieval is impossible by construction —
  this is the phase's one non-negotiable security invariant, and it holds today.
- Two RAG lanes exist: server Vectorize (uid-filtered) and BYO Gemini File-Search stores keyed
  per-uid (`ava_rag.ts` `ava_rag:<uid>` → `avatok-<uid>`).
- **Ingestion**: message ingestion is gated by `brainEnabled` at the producer (`messaging.ts:310`),
  so it ships dark today. Library/file, call-summary, and receptionist ingestion paths were NOT
  fully traced this pass — list as follow-ups before flipping.

**Done this pass:** `ava_memory_context` telemetry extended in `brainSearch`
(`{hits, sources_used, retrieval_ms, query_len}`) with the tenant-isolation invariant documented
inline.

**Deferred (human decisions / larger work):**
- **`brainEnabled: true` flip** (DEFAULTS + KV): **NOT flipped** — this is privacy-sensitive (it
  turns on ingestion of users' messages/files into AvaBrain). Owner decision + a clean ingestion
  verification first.
- **Guardrail toggles**: master AvaBrain switch + per-app toggles (messaging/library/marketplace/
  receptionist), default ON, `scopedKey('avabrain_<app>')`, synced to a server prefs row the
  ingestion pipeline consults. Sizeable client-UI + server-prefs feature — not built this pass.
- `avabrain_toggle_changed` event ships with the toggles.

## Phase 3 status (CF-SFU group audio), 2026-07-02

**Stage A done (dark — `groupAudioSfuEnabled` stays `false`, no flip, no LiveKit deletion):**
- `worker/src/do/group_call_room.ts`: active-speaker **hysteresis** (enter after 2 hits, leave
  after 4 misses) + **coalescing** (a set change that reverts within 1.5s never broadcasts) —
  kills SDP-renegotiation thrash. The `{t:'speakers'}` frame now carries `size` + `churn_ms`.
- `app/lib/features/conference/sfu_group_call_screen.dart`: **adaptive level reporting** (250ms
  while speaking, 500ms idle); telemetry `sfu_join`, `sfu_leave`, `sfu_speaker_set_changed
  {size,churn_ms}`, `sfu_pull_error`, and a per-call `sfu_call_summary {peak_participants,
  avg_speakers,duration_s,speaker_changes}`.

**Deferred / human-gated (NOT done this session):**
- **Secrets check** (`CALLS_APP_ID`/`CALLS_APP_SECRET`, app id `shiny-thunder-2e45`): must be
  verified/set via wrangler CLI (write-only secrets) — a shell/owner step.
- **Pull-side Opus tuning** (`avaMicConstraints` on pulled transceivers): deferred — munging the
  SFU pull-answer SDP is risky on the live media path without a build; publish-side `tuneOpusSdp`
  already applies.
- **Stage B** (multi-device SFU test with `groupAudioSfuEnabled:true` in STAGING) and **Stage C**
  (prod flip + `conferenceEnabled:false` + LiveKit deletion + cancel subscription) — both HUMAN-
  IN-LOOP, do not run without the owner.

## Phase 6 status (per-message safety scanning), 2026-07-02

Much of P6 pre-existed: `guardianScan` is wired into the send path (`messaging.ts:333`), records
`ava_guardian_flags`, sends private warnings carrying the flagged message id, and the client
already paints flagged messages red (`chat_thread.dart:_flaggedTs`).

**Done this pass (owner chose always-on Nemotron):**
- `safetyScanEnabled` flag (**ON**). `guardianScan` now runs an ALWAYS-ON message-level
  Nemotron scan (`moderate()`, `nvidia/nemotron-3.5-content-safety:free`) once per message,
  **fail-open**, gated by the flag. Policy encoded in `mapNemotronCategories`: adult sexual
  content is NEVER flagged; flag hate/csae/grooming/trafficking/threat/scam. `GuardianCategory`
  extended with those labels; `warningText` has a default branch for them.
- A Nemotron flag applies to every recipient → existing `recordFlag` + `warnPrivately` path →
  the flagged message goes red on the recipient (via the existing `_flaggedTs` mechanism).
- Telemetry: `safety_scan {flagged, category, raw_categories, ms, engine, model}` and
  `safety_scan_error` (fail-open). Ava/private chats already skipped; media unchanged (text v1).

**Deferred within P6 (documented follow-up):**
- Per-user **adult opt-out** in Guardian settings (child accounts cannot opt out) — needs a
  stored per-user pref + child-account check + settings toggle.
- The dedicated `{type:'safety_flag'}` annotation frame + a red-bubble tap-sheet with
  Block/Report/"This is fine" (`safety_flag_shown`/`safety_flag_dismissed`). Today's red bubble
  rides the existing private-warning path, which is functional but less granular.

## Telemetry doctrine (STANDING RULE — added Phase 13-D)

Every pipeline in this app emits, at minimum:

- `<name>_started` / `<name>_ok` / `<name>_error`, each with `{ms}` and the user's `email`
  where available (rides every event via `Analytics._base` on the client / `account_id` + email
  on the Worker).
- Every `_error` event carries enough context to debug **without a reproduction**: the relevant
  ids (call_id, conv, msg_id, listing_id, session id), the pipeline `stage`, and any upstream
  `status`/error string.
- Latency-sensitive paths additionally emit a `*_ms` metric (e.g. `msg_delivery_latency`,
  `ttfm_ms`, `sync_catchup.ms`, `call_setup_ms`, `hub_connected.connect_ms`).
- **Add events, never delete existing ones.** Disambiguate a reused event name with a `stage`
  property (e.g. `call_push_sent` `stage:enqueue` vs `stage:fcm_send`) rather than renaming.

Pipelines to audit against this rule as they land: P4 liveness (`liveness_*`), P6 safety
(`safety_scan*`), P8 backup/restore (`restore_result`, archive writes), P11 profile vetting
(`profile_vet_*`), P12 receptionist status (`recept_status_*`). They are **not built yet**, so
there is nothing to backfill today — each phase wires its own events to this shape.

## Phase 13 status (live sync + LTE latency), 2026-07-02

**Done this pass (dark/additive; no flag flips):**
- **A — measurement:** `msg_delivery_latency{ms,via:live}` (InboxDO now stamps `server_ts` on the
  live `msg` frame), `sync_catchup{messages,ms,cursor_gap,trigger}`, `ttfm_ms` (per foreground),
  `hub_connected{connect_ms,cellular}` (+ auto `net`).
- **B — delays:** resume probe reconnects immediately when the socket is >10s idle (else keeps the
  4s ping); zombie window 60s→30s; foreground FCM `message` now kicks a `push`-labelled cursor
  sync (`syncFromPush`); PartyKit delivery-hint wired both ends (`thread:<conv>` `{t:'new'}`),
  **dark behind `PARTY_ENABLED`**.
- **C — call latency:** `call_setup_ms` added to `call_connected`.

**Deferred within Phase 13 (need protocol / live-call refactors — do as a focused follow-up,
verified on device):**
- **B7 login fast-path** (newest page first, backfill older): needs an InboxDO sync-ordering
  change (`?newest=1` mode) — not risked on the durable layer without a build.
- **B8 flip:** `PARTY_ENABLED=1` staging → 24h clean `party_*` → prod (human-gated soak).
- **C9 ICE pre-warm** (create the RTCPeerConnection at call-screen open, not at dial):
  `iceCandidatePoolSize:2` already set; moving PC creation earlier is a live-call-path refactor.
- **C10 audio-first on constrained cellular** (start low-res/audio-only, upgrade after stabilise):
  reuses the existing `call_video_upgraded` path; deferred with C9.
