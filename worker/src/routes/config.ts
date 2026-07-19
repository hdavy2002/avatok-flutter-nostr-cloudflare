// Remote kill switches / server config (creator-marketplace Phase 1, audit A2).
// One JSON blob in KV (key `platform_config` — KV's sanctioned feature-flag
// use). Public read, 60 s edge cache; admin-only write. Flipping a flag
// reaches every client within ~15 min (RemoteConfig poll) with no APK release.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";

const KEY = "platform_config";

export interface PlatformConfig {
  walletRealMoney: boolean;
  donationsEnabled: boolean;
  liveEnabled: boolean;
  consultEnabled: boolean;
  conferenceEnabled: boolean;
  // FREE LAUNCH group AUDIO on Cloudflare Realtime SFU (Specs/FREE-LAUNCH-DIRECTION.md
  // + Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md). Default OFF: the new audio-only
  // CF-SFU group path stays dormant until its worker+client build lands and is
  // CI/device-verified. While OFF, group calls keep using the existing LiveKit
  // path (kept dormant per the launch doc, NOT deleted). Flip ON in KV to cut the
  // GROUP path over to CF Realtime SFU (audio-only, 32 cap, active-speaker pull).
  groupAudioSfuEnabled: boolean;
  brainEnabled: boolean;
  // One Brain B4 (SPEC-2026-07-17 §6, B-D6) — global brake on handing a
  // `device_private` recall snippet to a CLOUD avaReason call. `brainRecall`
  // merges the device + server lanes; a device-private hit can be included in a
  // cloud model call ONLY over our-keys, no-retention transport. TRUE by default
  // (matches the client fallback, so declaring it changes nothing today). The
  // per-account "local-only answers" toggle lives under the `messages` consent
  // domain; THIS flag is the platform-wide switch — set false in KV to force
  // device-private hits to be stripped before any cloud reasoning app-wide.
  // Declared here (interface + DEFAULTS in the same change) per the fake-flag rule
  // so the brake is actually flippable.
  cloudReasoningOverPrivate: boolean;
  verseEnabled: boolean;
  // [AVA-SYNC-SKIP] Kill switch for the reconnect/resume catch-up skip. Default TRUE
  // (matches the client's own fallback default, so declaring it changes nothing today).
  // When a socket flaps (Android doze ~15x/user/day) the client re-runs a full InboxDO
  // catch-up even when its message cursor is already at the server head — 97.6% of those
  // returned 0 messages. With this ON, a reconnect/resume whose persisted cursor is
  // already at head is answered with a cheap `sync_skip` frame instead of a full replay.
  // Flip false in KV to make every client fall back to the always-full-sync behaviour.
  syncSkipEnabled: boolean;
  // Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md)
  identityLadderEnabled: boolean;    // master switch for requireLevel gating
  guestTierEnabled: boolean;         // L0 handle-only visitors
  workersAiLivenessEnabled: boolean; // L2 via Workers AI clip check (Rekognition fallback)
  // [M-D1 2026-07-17 / M-D11 2026-07-18] simOnlyPhoneEnabled REMOVED — phone OTP was
  // deleted app-wide 2026-07-10 (/api/id/phone/confirm is in LEGACY_GONE → 410 and the
  // handler is unrouted). Liveness only, no phone anywhere; the flag gated nothing reachable.
  // Live voice translation (Gemini 3.5 Live Translate, $3/h in AvaCoins).
  translationEnabled: boolean;       // master switch for /api/translate/*
  translationGroupEnabled: boolean;  // group conferences (multi-speaker caveat)
  // AvaVoice — creator-built AI voice agents (Specs/AVAVOICE-PROPOSAL.md).
  avavoiceEnabled: boolean;          // master switch for /api/avavoice/*
  avavisionEnabled: boolean;         // master switch for /api/avavision/* (vision coaching agents)
  // Ava Receptionist — premium "Ava answers after N rings" (Specs/PROPOSAL-AI-RECEPTIONIST.md
  // + PROPOSAL-RECEPTIONIST-V2.md). First real AvaVoice deployment. Gemini Live via CF AI
  // Gateway, 2-min cap.
  receptionistEnabled: boolean;      // master switch for /api/receptionist/* (default OFF until tested)
  instantCallMountEnabled: boolean;  // [INSTANT-CALL-MOUNT-1] open 1:1 CallScreen instantly, POST /api/call in background (default ON; kill switch)
  receptionistRings: number;         // v2 Mode A: rings before auto-handoff (default 5)
  // Receptionist ENGINE switch (Specs/RECEPTIONIST-CF-PIPELINE.md). false (default)
  // = Gemini Live (do/reception_room.ts — untouched). true = the SEPARATE
  // Cloudflare-native engine (do/reception_room_cf.ts: Workers AI Deepgram/Whisper
  // STT → Llama LLM → Aura-2 TTS, fixed female "Ava"). Same Flutter client either
  // way — /start just points the call's WS at the chosen DO. One KV flip switches
  // every NEW call, instantly reversible, so the two can be A/B'd for cost.
  receptionistUseCf: boolean;
  // ZERO-COST VOICEMAIL MODE (owner 2026-07-19): routes receptionist calls to the CF
  // DO in a deterministic voicemail flow — play the owner's CACHED Bulbul-v3 greeting
  // ("Hi, seems like <owner> is not available — kindly leave a message after the
  // beep"), beep, record 30s (warning beep at 25s), store + notify. The greeting is
  // rendered ONCE per (owner name + language + voice) and cached in R2 — a name or
  // language change auto-regenerates on the next call (content-hash key). NO
  // STT/LLM/live-TTS runs during the call, so marginal AI cost is zero. Takes
  // precedence over receptionistUseCf/Gemini while ON.
  receptionistVmMode: boolean;
  // [AVA-VM-NOCOUNTDOWN-1] client 3-2-1 Ava warm-up countdown before voicemail.
  // Default true (legacy); flipped false in prod KV — the cached VM greeting is
  // instant so the warm-up screen is dead time. Client mirror: RemoteConfig.
  avaCountdownEnabled: boolean;
  // [RECEPT-BILLING-LIVE-1] charge ava_receptionist_minute for REAL even while
  // betaFreePremium is on (forceMeter) — lets the owner live-test token deduction
  // without ending the free beta platform-wide. Default false (beta stays free).
  receptBillingLive: boolean;
  // P1 call-reliability (Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02.md, Phase 1).
  // When ON, the caller's Ava-takeover countdown does NOT start until the server
  // confirms the incoming-call FCM push outcome over the CallRoom socket
  // ({type:'ring-ack', ok}). ok:true → give the callee the full ring window;
  // ok:false (push failed, callee can't ring) → hand to Ava immediately; no
  // ring-ack within 5s → fall back to today's timer. Default OFF (ships dark;
  // flip after a device test). Client mirror: RemoteConfig.receptTakeoverGuard.
  receptTakeoverGuard: boolean;
  // AvaAffiliate (Specs/proposals/PROPOSAL-AVA-AFFILIATE.md). OFF stops
  // registration, attribution + the settlement step (redirects keep working).
  avaAffiliateEnabled: boolean;      // master switch (default OFF until launch)
  affiliateAssetKitEnabled: boolean; // v2 Gemini promo-image kit (flag only; no code in v1)
  // Ava in-chat AI kill-switches (Phase 0 — Foundations). These gate the
  // SERVER-SIDE Ava surfaces/tiers; the client mirrors the defaults in
  // app/lib/core/feature_flags.dart. NOTE: runtime "is Ava on for THIS user" is
  // BYO/our-keys connection state, separate from `aiEnabled` (which is the
  // platform-wide master switch / panic button).
  aiEnabled: boolean;                // master switch for ALL Ava features (panic off)
  focusMode: boolean;                // hide non-AvaTOK apps in the drawer (reversible)
  webSearchEnabled: boolean;         // premium-only; our-keys free tier never gets it
  fileAnalysisEnabled: boolean;      // premium-only
  openChatUncapped: boolean;         // premium removes the daily cap
  dailyAvaTurnLimit: number;         // our-keys free-tier cap (turns/account/day)
  guardianEnabled: boolean;          // Guardian safety surfaces (basic free, deep premium)
  companionEnabled: boolean;         // blank "New chat with Ava" + personas
  generativeEnabled: boolean;        // in-thread image gen (each gen is a PaidFeature)
  imageDailyCap: number;             // per-USER/day image-gen fair-use backstop (ALL tiers, incl. unlimited)
  // AI Ringback Tones + Busy Tone (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md).
  // Master switch for /api/ringtone/* (generation/library) AND the caller-side
  // ringback playback. OFF → generation 503s and callers fall back to today's
  // silent ring + system busy. Client mirror: kRingbackEnabledDefault.
  ringbackEnabled: boolean;
  // BETA PHASE (2026-06-21, owner): open EVERYTHING at premium tier, free for all.
  // When true: isPremiumAI is true for every user (all AI tools unlocked, daily cap
  // bypassed), chargeFeature deducts nothing (no AvaCoin metering), and the wallet
  // balance reports premium:1 so the whole client renders premium (green pill →
  // "BETA PHASE", no PAID badges, no upsell). Flip to false in KV to restore the
  // normal free/premium + coin-metering model — no redeploy needed.
  betaFreePremium: boolean;
  // Phase 1 subscriptions (Free/Plus/Pro/Max — Specs/PROPOSAL-USAGE-PACKAGES-AND-GATING.md).
  // While FALSE: the Subscribe screen renders for preview but checkout endpoints
  // 503 and NO tier gating is enforced (today's beta = everyone unlimited). Flip
  // TRUE to enable real checkout + per-tier daily allowance enforcement. One KV
  // flip, no redeploy.
  billingEnabled: boolean;
  // AvaWallet Google Play top-up (fixed-price `avatok_topup_*` products → Tokens).
  // Independent of billingEnabled (that gates subscriptions): a user can top up
  // their wallet even while subscription paywalls are off. When FALSE the verify
  // endpoint 503s. Real security gate is the Play service account (fail-closed);
  // this is the killable master switch. Owner flips via scripts/flags.sh.
  playTopupEnabled: boolean;
  // AvaTOK Number (Specs/AVATOK-NUMBER-FEATURE-SPEC.md) — purchasable in-network
  // virtual number that represents a user and hides their real phone. Master
  // switch for /api/number/* and the directory's number search key.
  numberFeatureEnabled: boolean;
  teamIvrEnabled: boolean;           // master switch for /api/team/* (auto-attendant + team billing)
  ivrAiFrontDesk: boolean;           // future: AI natural-language front desk (off; tap-menu is default)
  // Group invites with TRUE pending membership + Accept/Decline (owner request
  // 2026-06-29). OFF (default) = current behavior: added members join the group
  // immediately. ON = added users get a PENDING invite (group_invites table) and
  // only become members of conversation_members when they Accept — so the message
  // router is unaffected (pending users simply aren't members yet). Flip ON in KV
  // after the migration + a test; no redeploy.
  groupInvitesEnabled: boolean;
  // P4: gate ALL listing creation/publish on video-liveness verification
  // (kyc_status='verified'). Browsing stays free. Default OFF (ships dark; flip ON
  // at launch). Fail-closed on the server route — a direct API call from an
  // unverified user is rejected 403 liveness_required.
  listingLivenessGate: boolean;
  // Liveness V2 (Specs/LIVENESS-V2-PLAN.md): the ML-Kit-gated, detection-driven
  // selfie-video verification flow that replaces the timer-script V1. Ships DARK
  // (default OFF); while off the client uses the V1 LivenessCheckScreen unchanged.
  // Flip ON in KV once V2 pass-rate is proven. Client mirror: RemoteConfig.livenessV2Enabled.
  livenessV2Enabled: boolean;
  // Liveness V2 P3 (Specs/LIVENESS-V2-PLAN.md §3/§6). Optional accuracy booster:
  // when ON *and* AWS creds (AWS_ACCESS_KEY_ID/SECRET/REGION) exist, the server-side
  // same-person check (B5) runs the STANDARD Rekognition IMAGE API CompareFaces
  // (neutral vs a challenge frame, similarity ≥ 90). NEVER the paid managed Face
  // Liveness API. Default OFF: with it off (or no creds) B5 is skipped-as-pass so a
  // user is never failed on a check we can't run. Purely additive — verification
  // stays 100% Workers-AI (LLaVA + Whisper) unless this is flipped.
  livenessUseRekognition: boolean;
  // [LIVE-DEVAUTH-1] device-authoritative liveness (scaling plan). Default OFF.
  // When ON, a verify carrying a device_report with ALL checks true skips the
  // expensive B2/B3/B4/B7 LLaVA calls (marked pass with an `_device` id suffix)
  // and runs only B1 realness (1 call) + B6 phrase + B9 clip sanity. A random
  // livenessAuditSampleRate fraction of device-authoritative verifies ALSO runs
  // the full LLaVA pipeline for disagreement telemetry (liveness_audit_sample).
  livenessDeviceAuthoritative: boolean;
  // [LIVE-DEVAUTH-1] fraction (0..1) of device-authoritative verifies that also
  // run the full server-side LLaVA pipeline, purely for audit/disagreement
  // telemetry (never changes the verdict served to the client).
  livenessAuditSampleRate: number;
  // Liveness V3 (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md) — voice-guided,
  // randomized head-and-neck capture, Rekognition DetectFaces via the provider-
  // normalization + deterministic-rules pipeline (worker/src/routes/liveness_v3.ts).
  // EXTENDS V2 (never replaces it): V2 stays the default flow. Ships DARK (default
  // OFF). When ON, the client can open the /api/liveness/v3/* Policy-Engine
  // entrypoint; while OFF those routes 503 `flag_off`. Flip ON in KV (never code —
  // 2026-07-04 lesson). Client mirror: RemoteConfig.livenessV3Enabled.
  livenessV3Enabled: boolean;
  // [AVA-IDGATE-1] Just-in-time identity gating (Specs/SPEC-2026-07-10-identity-gating.md).
  // Master kill switch. When ON, every PUBLIC action (post/listing/comment/live/
  // dm-to-stranger/group-post/upload) requires a Didit liveness pass no older than
  // `livenessValidityDays`. Consumers are never gated; signup is never gated.
  // Ships DARK. Flip ON in KV only AFTER the backfill migration has run — otherwise
  // every existing user is gated on their next public action (spec §11.1).
  identityGatingEnabled: boolean;
  // Liveness validity window in days (owner decision: 90). Widening this is the
  // no-code contingency if Didit's per-call price above the 500/mo free cap bites
  // (spec §9) — it divides check volume directly.
  livenessValidityDays: number;
  // [AVA-IDGATE-1] Version string for the biometric-consent disclosure the user
  // agreed to (BIPA §15(b)). Bump when the disclosure text or retention period
  // changes; the value is stored per-user so we can prove WHICH text they saw.
  biometricConsentVersion: string;
  // [LIVE-DIDIT-1] didit.me-hosted liveness. Default ON — this IS the liveness path.
  // [LIVE-DIDIT-5] When ON, only didit-provider liveness counts for L2.
  // ── DRIFT FIX 2026-07-18: both keys existed in DEFAULTS but NOT here. That is the
  // INVERSE of the fake-flag bug: `putConfig` gates writes on `k in DEFAULTS` (a
  // runtime check), so they were settable and did reach clients — but they were
  // absent from the type, so `readConfig(env).diditLivenessEnabled` did not
  // typecheck, and `const DEFAULTS: PlatformConfig` was an excess-property error.
  // Nothing caught it because NOTHING TYPECHECKS THE WORKER: `npm run typecheck`
  // (tsc --noEmit) exists in worker/package.json but no workflow runs it, and
  // wrangler deploys via esbuild, which strips types without checking them.
  diditLivenessEnabled: boolean;
  requireDiditLiveness: boolean;
  // P6: always-on per-message safety scanning (Nemotron :free via OpenRouter) with
  // red-bubble marking on the recipient. Ships **ON** (this one ships enabled).
  // Async, fail-open — a scan never blocks or delays delivery. Adult opt-out lives
  // in Guardian settings; child accounts cannot opt out.
  safetyScanEnabled: boolean;
  // P11: mandatory + AI-vetted profile completion. When ON, `/api/me` reports
  // profile_complete and the profile save route enforces completeness + real-name
  // plausibility (+ photo moderation) server-side. Default OFF (ships dark; ON at
  // launch). Client mirror: RemoteConfig.profileCompletionGate.
  profileCompletionGate: boolean;
  // P8 backup/restore durability (Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02, Phase 8).
  chatArchiveV2: boolean;   // batched R2 cold archive on InboxDO append (dark until verified)
  restoreV2: boolean;       // new-phone restore lazily pages older history from R2 (dark)
  driveAutoBackup: boolean; // daily auto-backup to the user's OWN Google Drive — ships ON, ALL users
  // P5: per-user daily cap on DISTINCT marketplace agent conversations (UTC day).
  // Tunable via KV without redeploy. The per-listing talk-once dedupe is separate
  // and does NOT consume quota (re-opening the same listing's result is free).
  agentDailyCap: number;
  // STREAM F (AI Messenger Batch): "Ava replies while you're away" auto-responder.
  // Master kill switch for the whole feature — the settings page, hot-path enqueue,
  // and the auto_reply consumer all gate on this. Default ON (per spec AUTOREP-5).
  autoResponderEnabled: boolean;
  // AI Messenger Batch 2026-07-03 — per-stream kill switches (spec §8 / §12).
  marketplaceAgentSettingsEnabled: boolean; // STREAM A: Marketplace Agent settings surface
  mktI18nNegotiationEnabled: boolean;        // STREAM A: English-canonical negotiation + translation
  strangerGateEnabled: boolean;              // STREAM B: message-request stranger safety gate
  linkPreviewsEnabled: boolean;              // STREAM C: server-side unfurl + inline YouTube
  richInputEnabled: boolean;                 // STREAM E: emoji/GIF/sticker input panel
  groupTranslationEnabled: boolean;          // STREAM G: per-member group translation (cost watch)
  smartRepliesEnabled: boolean;              // STREAM G: DM smart-reply chips
  scamAutoScanEnabled: boolean;              // STREAM G: auto scam-scan on stranger-thread first render
  // [AVA-IDGATE-1] livenessOnboardingGate REMOVED — superseded by identityGatingEnabled
  // (gate at first public action, not at signup). See lib/identity_gate.ts.
  unlimitedForwardEnabled: boolean;          // STREAM I: unlimited forwarding + forward-to-groups
  // [AVAGRP-SEENBY-1] Group "Info → seen by" (WhatsApp-style per-message read/
  // delivered receipts for group chats). Master kill switch: OFF drops every
  // POST /api/msg/receipts write server-side (msgReceiptBatch short-circuits to
  // {ok:true, disabled:true} before touching any InboxDO) and the sender simply
  // sees no seen-by data — never a crash. Dark-launch default false; see the
  // DEFAULTS entry for why this pair MUST ship together in one change.
  groupReceiptsEnabled: boolean;
  // PERF-DNS-2: client DNS-over-HTTPS fallback (resolve our hosts via 1.1.1.1 when
  // the device resolver fails — carrier-proof). Default ON in the client even
  // without this key; this is a KV kill switch to force pure OS resolution.
  dohFallbackEnabled: boolean;
  // [ARCH-ROUTING-V2] Master kill switch for the v4 server-authoritative routing
  // path (Identity/Conversation/Routing/Delivery/Transport — frozen architecture,
  // Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md). Default OFF: the new /api/v2/*
  // endpoints answer 404 and NOTHING in the v4 path runs. Purely additive while
  // OFF — the legacy /api/conversations + /api/msg/send path is untouched. Flip ON
  // in KV per-cohort to strangle the legacy path over. Reversible with one KV edit.
  routingV2Enabled: boolean;
  // Guardian Sentinel (Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md, phase S1).
  // Master kill switch for the derived safety-projection engine (deterministic
  // extractors → append-only EvidenceAdded → snapshot+tail fold → SentinelDO hot
  // caches). Default OFF: the whole worker/src/sentinel/* pipeline is DARK — the
  // best-effort ingest hooks (e.g. after guardianScan.recordFlag) no-op, nothing is
  // written, no DO is touched. Flipping ON requires a KV patch of platform_config
  // (code defaults NEVER win over KV — 2026-07-04 lesson). S1 is telemetry-only; no
  // LLM, no mem0, no enforcement — thresholds ship dark and are tuned before any act.
  sentinelEnabled: boolean;
  // Sentinel S2 (behaviour memory via mem0) — gates the async summariser
  // (sentinel/summariser.ts). Default OFF. Also requires MEM0_API_KEY; both absent →
  // clean no-op. mem0 is a DERIVED cache, never an owner of truth (plan §1.1 rule 5).
  sentinelMem0Enabled: boolean;
  // Guardian G3 — INLINE two-lane scan (Specs/GUARDIAN-SENTINEL-FINAL-PLAN §G3).
  // When ON, messaging.ts awaits a cheap FAST-lane scan (regex + ONE Nemotron
  // moderate() call, hard-timeout budget guardianInlineBudgetMs) BEFORE fan-out in
  // guardian-ON chats and attaches the verdict to the fanned-out payload so the
  // recipient's bubble paints red on arrival. The detached DEEP lane (Opus) still
  // runs after fan-out (slow lane). Default OFF: with it off messaging.ts behaves
  // EXACTLY as today (deep lane only, no pre-fanout await). Fail-open everywhere —
  // a timeout/error never delays or blocks delivery. Flip ON via KV (never code).
  guardianInlineEnabled: boolean;
  // Fast-lane hard budget (ms) for the single Nemotron moderate() call in G3.
  // Promise.race trips at this bound → fan out immediately (fail-open) and emit
  // guardian_inline_latency_budget_breach. Numeric KV key (400–600 ms per plan).
  guardianInlineBudgetMs: number;
  // U1-lite — MANUAL "Require verification" gate (Specs/GUARDIAN-SENTINEL §U1, dark).
  // When ON, a 1:1 owner control can ask the peer to complete a live face check
  // (Trust Engine liveness) before continuing. Fully DARK by default: the server
  // require_verify/gate_status modes 403 `feature_off`, the client control is
  // hidden, and NOTHING is wired to enforcement. Flip ON via KV (never code).
  guardianGateEnabled: boolean;
  minAppBuild: number;
  // Newest build published to the store. When it is greater than the build the
  // user has installed, the app shows a (dismissible) "new version available"
  // popup whose Update button opens the Google Play listing. Owner bumps this in
  // KV each time a new release is published. 0 = never prompt. Distinct from
  // minAppBuild, which is the HARD floor that shows a blocking update screen.
  latestAppBuild: number;
  // [AVA-UPDATE-AUTO] Kill switch for the automatic in-app update flow
  // (app/lib/core/update_service.dart): the on-launch Play check, the background
  // flexible download, the auto-install, and the fallback popup. Default TRUE.
  //
  // THIS EXISTS BECAUSE IT DIDN'T. remote_config.dart's own docstring claimed you
  // could "flip inAppUpdateEnabled: false in KV" to silence the update checks —
  // but the key was never declared here, and the PUT handler below rejects any key
  // not in DEFAULTS (`unknown key`, 400). So the documented brake was unusable:
  // the client defaulted it true and nothing could turn it off. That is a bad
  // shape for a feature that installs itself without asking — if a build ever
  // ships an update loop, this switch is the only thing between a bad release and
  // every device retrying it. Declaring it makes the brake real.
  inAppUpdateEnabled: boolean;
  // Call-state control-plane authority (Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md
  // §5 — protocol-v1/v2 shadow rollout). All default OFF/legacy: CallStateAuthorityDO
  // is wired (wrangler binding + v13 migration) but fully dormant until these flip.
  authorityShadowEnabled: boolean;  // shadow-write only, never read for decisions
  authorityReadEnabled: boolean;    // routes may READ authority state (still legacy writes)
  authorityWriteEnabled: boolean;   // routes WRITE through the authority DO
  authorityEnforced: boolean;       // authority verdicts are enforced (legacy path fully replaced)
  callProtocolVersion: number;      // client/server call-signaling protocol version (1 = legacy)
  // Personalized BUSY CARD (Specs/CALL-MESSAGING-RECEPTIONIST-REMEDIATION-PLAN.md
  // §3). Master kill switch for the whole busy-card server feature: the /acquire
  // busy-response enrichment (receptionist_enabled + generation), the bounded
  // waiter list ("Notify me"), and the "now free" FCM fan-out on return-to-idle.
  // Default OFF — while off, the acquire busy response is byte-for-byte today's
  // shape, no waiter rows are accepted, and no now-free push ever fires, so a bug
  // in this path can NEVER touch live calls. Flip ON in KV once the client card
  // ships + is device-verified. Client mirror: RemoteConfig.busyCardEnabled.
  busyCardEnabled: boolean;
  // Ava Copilot Phases A+B (Specs/AVA-COPILOT-FINAL-PLAN-2026-07-08.md §5–§9).
  // All default OFF — the routes 503 {flag} while dark; flip ON in KV (never code).
  avaCopilotEnabled: boolean;          // master: private lane posts + per-chat toggle + all /api/ava/doc/* routes
  avaDocActionsEnabled: boolean;       // context-menu doc actions (Summarize ✨ / Translate ✨)
  avaAutoTranslateFileEnabled: boolean; // "Auto-translate file ✨" (chunked whole-doc translation — cost watch)
  // Ava Copilot Phases C+D (ODL — Opportunity Detection Layer, shadow-mode).
  odlEnabled: boolean;        // Phase C: ODL wake scan from guardianScan (shadow-mode telemetry only)
  avaMomentsEnabled: boolean; // Phase C: master gate for user-visible Moments (nothing posts while false)
  // CALL OUTCOME MENU (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md). One server-
  // driven menu for every non-answered call (declined / no-answer / unreachable /
  // phone-off / Ava-mode / busy): Talk to Ava, voice note, text note, See Listings.
  callMenuEnabled: boolean;          // master switch — client shows the menu; server serves /api/call-menu
  callMenuListingsEnabled: boolean;  // "See Listings" button + Ava listings context — OFF until marketplace goes public
  callMenuRateLimitEnabled: boolean; // master switch for the per-caller daily caps below
  avaSessionsPerCallerPerDay: number;   // Talk-to-Ava cap per caller per owner per UTC day (owner 2026-07-09: 2)
  strangerVoiceNotesPerDay: number;     // stranger voice notes per caller per owner per day
  strangerTextNotesPerDay: number;      // stranger text notes per caller per owner per day
  // Dialpad business calls + Ava AI Voice Agent (Specs/PLAN-2026-07-11-dialpad-
  // business-calls-ava-voice-agent.md §7/§15.6). One kill switch per phase — ALL
  // default OFF, staging first, prod flags flipped one at a time on the owner's
  // say-so. While every one of these is false, the whole feature is byte-for-byte
  // dark: no new UI, no new routes, no new event emission.
  businessCallUx: boolean;    // Phase A: channel split UI (named incoming-call screen, no-answer card, tappable numbers)
  voicemailBot: boolean;      // Phase B: server-side voice-prompt + 25s recording bot in the call room
  paidCalls: boolean;         // Phase B2: caller-pays escrowed calls (§3B)
  voiceAgent: boolean;        // Phase C: Ava AI Voice Agent (Grok realtime session)
  serviceNumbers: boolean;    // Phase C: Mode-B-only additional AvaTOK numbers
  // Home · AvaDial · AvaTalk · Services 4-root shell (Specs/PLAN-2026-07-12-home-
  // ava-tok-services-shell.md, Phase 1). Master kill switch for "shellV2". Default
  // OFF — while false the client renders the CURRENT shell (messenger-first, apps
  // pushed on top) byte-for-byte, and none of the new 4-root code runs. Flip
  // `shellV2: true` in KV `platform_config` (staging first) to switch the app to
  // the four-sibling shell (Home/AvaDial/AvaTalk/Services). Client mirror:
  // RemoteConfig.shellV2.
  shellV2: boolean;
  // AvaDial community spam shield (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  // .md §4.4, Phase 2a). Master kill switch for the whole spam-reputation backend:
  // /api/spam/report, /api/spam/lookup/:e164, /api/spam/bloom and the nightly
  // scoring job. Default OFF — while false EVERY spam route 403s, the D1 tables go
  // unused and the scoring job no-ops, so the feature is fully DARK. Flip
  // `spamShield: true` in KV `platform_config` (staging first) once the reputation
  // pool + on-device bloom cache are device-verified. Client mirror:
  // RemoteConfig.spamShield.
  spamShield: boolean;
  // AvaDial native dialer layer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  // .md §4.1-4.3, Phase 2b). Master kill switch for the AvaDial PSTN surfaces in
  // the app: default-dialer onboarding banner, device contacts/logs tabs, block
  // list, red/green/blue PSTN call screens. Default OFF — while false AvaDial
  // shows the Phase-1 placeholders only. Flip `avaDialer: true` in KV
  // `platform_config` (staging first) after the §9 device test matrix passes.
  // Client mirror: RemoteConfig.avaDialer.
  avaDialer: boolean;
  // [AVADIAL-NATIVE-INCALL-1] Native in-call screen (owner decision 2026-07-15).
  // While FALSE, answering a PSTN call hands off to MainActivity and the Flutter
  // in_call_screen.dart exactly as before. While TRUE, the native InCallActivity
  // takes over and Flutter never enters the call path at all — no engine boot, no
  // Keystore, no Firebase/PostHog init, no 3s shell gate.
  //
  // This is the ONE flag that matters most on this feature: the answer path is the
  // same one that broke prod testers on 2026-07-14. Default OFF; flip it only after
  // device testing, and revert instantly if anything looks wrong.
  //
  // Native cannot read RemoteConfig (it runs with no engine), so Dart mirrors the
  // resolved value to <filesDir>/avadial/native_ui.json on every config refresh —
  // see AvaDialChannel.setNativeInCallEnabled / AvaDialPlugin.nativeInCallEnabled.
  // A missing/corrupt mirror reads as OFF (fail-closed).
  nativeInCallUi: boolean;
  // [AVA-MISSEDCALL-1] Truecaller-style missed-call overlay (owner request 2026-07-14).
  // Master kill switch for the after-call popup that draws OVER other apps naming who
  // called + quick actions, AND for the phone-presence lookup that lights the AvaTOK
  // icon. IMPORTANT: turning this ON deliberately REVERSES the 2026-06-27 privacy lock
  // — /api/contacts/match resolves AvaTOK membership from the caller's real phone
  // number (private or not), per the owner's explicit 2026-07-14 instruction. While
  // false the match endpoint returns nothing (old privacy behaviour) and the native
  // receiver/overlay stay inert. Client mirror: RemoteConfig.missedCallOverlay.
  missedCallOverlay: boolean;
  // AvaDial default-SMS-app layer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  // .md, AVA-SMS; owner decision 2026-07-12). Master kill switch for the AvaDial
  // SMS surfaces in the app: the "Make AvaTOK your messages app" onboarding banner,
  // the Messages tab conversation list + composer, and the AI Inbox/Spam filter over
  // carrier SMS. Requires ROLE_SMS at runtime (independent of ROLE_DIALER). Default
  // OFF — while false the Messages tab keeps its Phase-1 placeholder, NO SMS role is
  // ever requested, and the native SMS receivers/send service stay inert (they only
  // ever fire once the user grants the default-SMS role, which we never request unless
  // this flag is on). Flip `avaSms: true` in KV `platform_config` (staging first)
  // after the SMS role qualification + device test matrix passes and the Play Store
  // default-SMS-handler declaration is approved. Client mirror: RemoteConfig.avaSms.
  avaSms: boolean;
  // [DEFAULT-APPS-REPROMPT-1] (owner request 2026-07-15) One-time re-prompt that
  // sends EXISTING users who never took the onboarding "make AvaTOK your phone"
  // step to Settings → "Default phone & messages" on their next app open. Shows
  // AT MOST ONCE per account, ever (a persistent account-scoped key on device
  // records it), and never at all for users who already hold the roles.
  //
  // This is a kill switch on an INTERRUPTION, which is exactly the kind of thing
  // that needs one: on 2026-07-14 the owner had the old setup sheet stopped from
  // auto-popping because it nagged. If this one misbehaves, flip it false and it
  // is gone without a build. Default ON — it's the point of the feature.
  // Client mirror: RemoteConfig.defaultAppsReprompt.
  defaultAppsReprompt: boolean;
  // AvaDial contact-book backup/restore (owner request 2026-07-13; scaled 2026-07-14).
  // `contactsBookEnabled` is the master kill switch for /api/contacts/book* — when
  // false every route 503s (panic off). Default ON (the feature is live + free).
  // `contactsBookPaged` gates the paginated GET + background R2 chunking job; when
  // false the endpoint still serves the full book in one response (older behaviour)
  // and no chunks are built. Client mirror: RemoteConfig honours pagination purely
  // from the response shape, so these flags are server-authoritative.
  contactsBookEnabled: boolean;
  contactsBookPaged: boolean;
  // [AVADIAL-BACKUP-DAILY] Kill switch for the CLIENT's ~24h WorkManager
  // background backup (app/lib/features/avadial/contacts_daily_backup.dart). The
  // job re-reads this flag on every wake and does nothing when it's false, so a
  // misbehaving daily lane (e.g. an upload storm from a bad build) can be stopped
  // for the entire install base from KV WITHOUT shipping an APK — which matters
  // precisely because these clients are un-updatable in the moment. Distinct from
  // contactsBookEnabled, which 503s the ROUTES (and would take manual backup and
  // restore down with them). Default ON: the whole point is that a user who never
  // opens AvaTOK is still covered.
  contactsDailyBackup: boolean;
  // §11/§15 money + timing constants — flag-overridable via KV so a value tweak
  // never needs a redeploy. These are VALUES, not design; see plan §11.
  minServiceRate: number;          // MIN_SERVICE_RATE — floor for a caller-paid rate/min (owner proposed 20)
  agentRateAPerMin: number;        // Mode A callee-pays agent rate, tokens/min (6)
  platformFeePerMin: number;       // Mode B platform fee taken from the caller, tokens/min (10)
  serviceLineFeePerMin: number;    // service-number "extra line" fee, tokens/min, billed to the callee (3)
  agentMaxCallSec: number;         // AGENT_MAX_CALL — hard cap on an agent call, seconds (300 = 5 min)
  ringTimeoutSec: number;          // RING_TIMEOUT — no-answer window, seconds (30 ≈ 5 rings)
  agentAutoanswerSec: number;      // AGENT_AUTOANSWER — auto-handoff to agent, seconds (12 ≈ 2 rings)
  voicemailRecordSec: number;      // VOICEMAIL_RECORD — max voicemail length, seconds (25)
  escrowPromptTimeoutSec: number;  // ESCROW_PROMPT_TIMEOUT — price/length prompt abandon window, seconds (30)
  offlineDetectSec: number;        // OFFLINE_DETECT — no push-ack within this → skip ring, seconds (6)
  agentConcurrencyA: number;       // AGENT_CONCURRENCY_A — Mode A concurrent calls per primary number (1)
  agentConcurrencyB: number;       // AGENT_CONCURRENCY_B — Mode B concurrent escrowed sessions per service number (5)
  networkReconnectWindowSec: number; // NETWORK_RECONNECT_WINDOW — drop-past-this settles+refunds, seconds (20)

  // PSTN voicemail platform — Canonical Architecture v1.0 (Specs/PLAN-2026-07-16-
  // ava-receptionist-guardian-FINAL.md, "Rollout inversion": V1 SHIPS VOICEMAIL FOR
  // EVERYONE; the AI pipeline is merged but DARK — no engine code exists yet).
  // `pstnVoicemail` is the master switch for worker/src/routes/pstn.ts's whole
  // Vobiz webhook surface (answer/hangup/record-cb/expect). While FALSE the
  // routes still run in PURE PROBE MODE (capture-only + orphan voicemail — this
  // doubles as the Phase-0 Vobiz wiring probe and is safe dark because the routes
  // are unreachable unless Vobiz itself calls them). Flip ON in KV (staging
  // first) once the carrier-forwarding matrix (plan Phase 0) passes.
  pstnVoicemail: boolean;
  // Max voicemail recording length in seconds for the PSTN (Vobiz) leg — separate
  // numeric flag from the existing in-app `voicemailRecordSec` (voicemail_room.ts)
  // even though the default matches, because the two record windows are enforced
  // by different systems (Vobiz's <Record maxLength=…> XML attribute vs our own
  // DO timer) and may need to diverge for carrier/cost reasons. Numeric — remember
  // the numericKeys entry below.
  pstnVoicemailRecordSec: number;
  // [AVA-VM-PAID-1] (owner decision 2026-07-17) Each forwarded condition costs us
  // ~55 paisa per call, so only "phone off / unreachable" (cfnrc) is FREE. The
  // "missed calls" (cfnry) and "declined / busy" (cfb) conditions are a PAID
  // upgrade: the client renders those two rows greyed with a green PAID pill and
  // no "Turn on" button, and one-time-cancels them at the carrier for anyone who
  // already had them on (they shipped free-and-default-ON before this date).
  //
  // TRUE unlocks both conditions for EVERYONE — this is the switch to flip when
  // the paid tier ships (or to un-break a mistake), NOT a per-user entitlement.
  // Per-user billing is a separate lane; until it exists, leave this FALSE.
  pstnPaidConditionsUnlocked: boolean;
  // [AVA-PSTN-AGENT-1] (Specs/PLAN-2026-07-19-vobiz-media-stream-agent.md)
  // Live Gemini agent on CELL (Vobiz DID) calls via bidirectional media
  // streams. When TRUE, routes/pstn.ts's answer webhook routes calls for
  // owners with receptionist mode="agent" (and ≥3 tokens runway) to a
  // <Stream> WebSocket → do/vobiz_agent_room.ts instead of the voicemail XML.
  // FALSE (dark) = the voicemail lane is byte-identical to before. This is
  // ALSO the kill switch: flip off and the very next call gets voicemail.
  pstnAgentEnabled: boolean;
  // [AVA-CONVO-BUDGET-1] (owner 2026-07-19) Receptionist conversation budget in ms,
  // decoupled from callMenuEnabled. The old coupling reverted Gemini to the 40/60/90s
  // VOICEMAIL caps when the menu was turned off — the 40s wrap cue landed mid-goodbye
  // and produced a double sign-off. Defaults are conversation-grade (wrap 120s, close
  // 160s, hard 180s); tune live from KV. All three MUST be in numericKeys.
  receptWrapCueMs: number;
  receptCloseMs: number;
  receptHardCapMs: number;
  // [RECEPT-BILLING-3] Phase 1 billing v2 (Specs/PLAN-2026-07-19-tokens-cockpit-pstn-master.md):
  // USD→INR conversion for the INTERNAL per-call cost ledger
  // (call_cost_ledger.actual_api_cost_inr, written by ReceptionRoom.finalize), and
  // the real-cost-per-minute margin alert threshold in PAISE (₹2.20/min default —
  // above it finalize emits ava_recept_margin_alert). Both numeric — they MUST
  // also be in the numericKeys set below.
  usdInrRate: number;
  receptMarginAlertPaise: number;
  // Creator marketplace master switch for /api/marketplace/*. worker/src/routes/
  // marketplace.ts has claimed since day one that "everything here is dark until the
  // marketplaceEnabled kill switch is on" — but the key was never declared, so
  // putConfig rejected it (`unknown key`, 400) and the routes in fact had NO master
  // switch at all. Declaring it makes the documented brake real (same shape of bug as
  // inAppUpdateEnabled, found 2026-07-15). Default OFF per FREE LAUNCH (marketplace
  // hidden); flip ON in KV (staging first) when the marketplace goes public.
  marketplaceEnabled: boolean;
  // Master kill switch for /api/olx/*. Until now olx.ts was LIVE in production gated
  // by nothing — no flag anywhere. Default OFF so the routes ship dark and can be
  // turned on deliberately in KV (staging first). Read side lives in routes/olx.ts.
  olxEnabled: boolean;
  // [MKT2] AI-chat listing creation — the compose state machine that replaces the
  // 6-step SellListingFlow form (PLAN-2026-07-17 §3). Gates /api/marketplace/compose/*.
  // Default OFF: this is an LLM that talks to sellers and writes public listing text,
  // so it ships dark and is flipped on staging first. Independent of marketplaceEnabled
  // on purpose — compose can be dark while the marketplace itself is live, and the form
  // remains the escape hatch (M-D7) until the compose_started→listing_published funnel
  // proves out (§7.4).
  aiComposeEnabled: boolean;
  // [MKT6] Compose brain enrichment (PLAN §6.1). When ON, the compose greeting is
  // pre-filled from the seller's OWN listing history + a minimal-domain brainRecall
  // (domains:['listings'], k<=5). Default OFF, and it is only ONE of FOUR gates: (1) this
  // flag, (2) the user's `listings` brain consent, (3) One Brain B4 shipped (brainRecall
  // exists), (4) domains:['listings'] filtering. Failing any → the AI just asks. Separate
  // from aiComposeEnabled ON PURPOSE: turning compose on must NOT silently turn on
  // account-history recall. Read side is worker/src/lib/listing_enrichment.ts.
  listingBrainEnrichmentEnabled: boolean;
  // [MKT5] Per-listing billing (PLAN §5, M-D2: 5 free listings, then 100 tokens = $1
  // per listing per 30 days). Default OFF: while off, every publish is granted 'free'
  // and the entitlement row is still written so the quota count is accurate the moment
  // this flips on. NOTE betaFreePremium independently zeroes chargeFeature, so even with
  // this ON beta users are not debited — the machinery lands dark twice over. Read side
  // is worker/src/lib/listing_billing.ts.
  listingFeeEnabled: boolean;
}

// FREE LAUNCH (2026-06-28, owner-locked Specs/FREE-LAUNCH-DIRECTION.md): ship an
// all-free, focused comms product. Core ON: messaging, 1:1 calls, group AUDIO,
// free number/dialpad, AI receptionist, basic Ava chat, Guardian. Everything
// else (paid/marketplace/agent-builders/premium-AI) is OFF and hidden in the
// client. All paywalls off (betaFreePremium ON / billingEnabled OFF). Fully
// reversible — flip these back in KV `platform_config`, no redeploy.
const DEFAULTS: PlatformConfig = {
  walletRealMoney: false, // money-in stays OFF pending legal (§10.1)
  donationsEnabled: true,
  liveEnabled: false,              // FREE LAUNCH: marketplace/AvaLive hidden
  consultEnabled: false,           // FREE LAUNCH: paid consulting hidden
  conferenceEnabled: true,         // group AUDIO calls (master kill switch)
  groupAudioSfuEnabled: false,     // CF Realtime SFU group path — dormant until built+CI-verified
  brainEnabled: false,             // FREE LAUNCH: secondary — revisit later
  cloudReasoningOverPrivate: true, // One Brain B4/B-D6: allow device-private recall snippets in cloud reasoning (our-keys, no-retention transport). Flip false in KV to force local-only handling of private hits.
  verseEnabled: false,             // FREE LAUNCH: creator dashboard hidden
  syncSkipEnabled: true,           // [AVA-SYNC-SKIP] skip empty reconnect/resume catch-ups when the client cursor is already at head; flip false to force full syncs

  identityLadderEnabled: true,
  guestTierEnabled: true,
  workersAiLivenessEnabled: true,  // ON 2026-07-03: Cloudflare-native liveness (no AWS/Rekognition creds); powers the signup human-check
  // [M-D1 2026-07-17 / M-D11 2026-07-18] simOnlyPhoneEnabled removed from DEFAULTS —
  // phone OTP is gone app-wide; the flag gated an unrouted, 410'd endpoint.
  translationEnabled: false,       // FREE LAUNCH: Gemini-Live cost — hidden
  translationGroupEnabled: false,  // FREE LAUNCH: hidden
  avavoiceEnabled: false,          // FREE LAUNCH: agent builder hidden
  avavisionEnabled: false,         // FREE LAUNCH: agent builder hidden
  receptionistEnabled: true,       // FREE LAUNCH: AI receptionist ON (Gemini Live)
  instantCallMountEnabled: true,   // [INSTANT-CALL-MOUNT-1] instant 1:1 call screen; POST /api/call runs in background. Kill switch (flip false to restore awaited path)
  receptionistRings: 4,            // [ONE-FLOW-1] owner 2026-07-09: 4 rings (20s) GLOBAL — one flow for everyone; KV can override
  receptionistUseCf: false,        // engine switch: false = Gemini Live (default), true = Cloudflare Workers AI engine
  receptionistVmMode: false,       // zero-cost voicemail: cached Bulbul greeting + beep + 30s record (overrides engines while ON)
  avaCountdownEnabled: true,       // client 3-2-1 Ava countdown; prod KV flips false (VM greeting is instant)
  receptBillingLive: false,        // [RECEPT-BILLING-LIVE-1] real receptionist token deduction during beta (test switch)
  receptWrapCueMs: 120_000,        // [AVA-CONVO-BUDGET-1] wrap-up cue at 2:00 (was 40s when menu off → double sign-off)
  receptCloseMs: 160_000,          // graceful close by ~2:40
  receptHardCapMs: 180_000,        // stall backstop 3:00
  usdInrRate: 96.4,                // [RECEPT-BILLING-3] USD→INR for the internal call_cost_ledger (tune from KV as FX moves)
  receptMarginAlertPaise: 220,     // [RECEPT-BILLING-3] alert when real API cost > ₹2.20/min (price is ₹3/min)
  receptTakeoverGuard: false,      // P1: gate Ava takeover on FCM ring-ack — ships dark, flip after device test

  avaAffiliateEnabled: false,      // launch gate — flip ON after A5 fraud checks
  affiliateAssetKitEnabled: false, // v2 asset kit (Gemini) — defined, not built
  // Ava in-chat AI defaults (proposal §7.1 anti-abuse tiering).
  aiEnabled: true,                 // basic free Ava chat ON
  focusMode: true,
  webSearchEnabled: false,         // FREE LAUNCH: premium AI cost — hidden
  fileAnalysisEnabled: false,      // premium unlocks
  openChatUncapped: false,         // premium removes the cap
  dailyAvaTurnLimit: 25,
  guardianEnabled: true,           // safety shield — free, trust driver
  companionEnabled: true,          // basic free Ava chat
  generativeEnabled: false,        // FREE LAUNCH: premium image gen — hidden
  imageDailyCap: 100,              // fair-use backstop per user/day — applies even to "unlimited" packages
  ringbackEnabled: true,           // AI ringback + busy tone (free, our AI key)
  betaFreePremium: true,           // FREE LAUNCH: no paywalls — everyone premium, no metering
  billingEnabled: false,           // FREE LAUNCH: subscriptions/checkout off
  playTopupEnabled: true,          // AvaWallet Google Play top-up (gated also by Play service account)
  numberFeatureEnabled: true,      // AvaTOK Number — virtual number + handle retirement
  teamIvrEnabled: false,           // Team Receptionist (IVR) — OFF until dogfood passes (enable via KV)
  ivrAiFrontDesk: false,           // tap-menu is the default routing; AI front desk is a future upsell
  groupInvitesEnabled: false,      // pending-membership group invites — OFF until migration + test
  listingLivenessGate: true,       // ON 2026-07-03: mandatory liveness (once) to create/publish a listing
  livenessV2Enabled: false,        // Liveness V2 ML-Kit-gated flow — dark, flip ON once pass-rate proven
  livenessUseRekognition: false,   // Liveness V2 P3: optional AWS CompareFaces same-person (image API, NOT Face Liveness) — OFF; needs AWS creds
  livenessDeviceAuthoritative: false, // [LIVE-DEVAUTH-1] device-authoritative fast path — OFF (dark until device-signal trust is proven)
  livenessAuditSampleRate: 0.08,      // [LIVE-DEVAUTH-1] 8% of device-authoritative verifies also run full LLaVA for disagreement telemetry
  livenessV3Enabled: false,           // Liveness V3 voice-guided/Rekognition pipeline — DARK; extends V2, flip ON in KV once proven
  // [AVA-IDGATE-1] [CSAM-GATE-1 2026-07-11] Was DARK pending the identity_proofs
  // backfill migration (see Specs/IDGATE-WHAT-WE-DID-2026-07-10.md). The backfill
  // has since RUN (confirmed: 0 users left without a verification record; 1 real
  // Didit pass, 17 grandfathered, renewal dates spread days 36-88 — no gate cliff).
  // With this flag OFF, gatePublicAction() always short-circuits `on=false` and
  // returns null (allow) for EVERY action — including dm_stranger — so an
  // unverified first-time user's first message to a stranger was NEVER actually
  // gated server-side despite the gate code being correctly ordered before persist/
  // deliver in messaging.ts sendMsg/convCreate. That is the confirmed root cause of
  // the CSAM-risk hole (a first message to a stranger was delivered, unverified).
  // Flipping the DEFAULT here only changes behaviour where no KV override exists —
  // if `identityGatingEnabled` was ever explicitly set false in KV (scripts/
  // flags.sh), that override still wins and must be cleared/re-set by the owner
  // per the staging-then-prod protocol in CLAUDE.md. Test per the "what to test"
  // checklist in IDGATE-WHAT-WE-DID-2026-07-10.md before promoting to prod.
  identityGatingEnabled: true,
  livenessValidityDays: 90,           // owner decision 2026-07-10
  // [AVA-IDGATE-1] BUMPED v1→v2 when retention changed 584d → 256d. The version is
  // stored per-user, and hasCurrentConsent() only accepts the CURRENT one — so a
  // changed disclosure invalidates prior consent and the user is asked again. That is
  // the entire point of versioning it: nobody consented to a period they never saw.
  // Bump this string whenever the consent TEXT or the RETENTION PERIOD changes, and
  // update app/.../biometric_consent_screen.dart:_kRetentionDays + the published
  // schedule at /biometric-retention in the same commit. All three must agree.
  biometricConsentVersion: "2026-07-10-v2",
  // [LIVE-DIDIT-1] didit.me-hosted liveness (owner decision 2026-07-09). Default
  // ON — this IS the liveness path now; v2/v3 above are retired. The client
  // routes the human check to DiditLivenessScreen when this is true.
  diditLivenessEnabled: true,
  // [LIVE-DIDIT-5] When ON, only didit-provider liveness counts for L2 — users
  // verified by the retired v2/v3 pipelines are re-gated on next app open.
  // OWNER-CONTROLLED: flip in KV when ready to re-verify the existing base.
  requireDiditLiveness: false,
  safetyScanEnabled: true,         // P6: always-on Nemotron per-message safety scan + red bubbles — ships ON
  profileCompletionGate: false,    // P11: mandatory + AI-vetted profile — dark, flip ON at launch
  chatArchiveV2: false,            // P8 Stage 1: batched R2 cold archive — dark until verified
  restoreV2: false,               // P8 Stage 2: R2 lazy-older restore paging — dark
  driveAutoBackup: true,          // P8 Stage 3: daily Drive backup for EVERY user (no premium gate)
  agentDailyCap: 10,               // P5: 10 marketplace agent conversations/user/UTC-day
  autoResponderEnabled: true,      // STREAM F: auto-responder "Ava replies while away" — ships ON
  // AI Messenger Batch 2026-07-03 defaults (spec §8 / §12).
  marketplaceAgentSettingsEnabled: true, // STREAM A — ships ON
  mktI18nNegotiationEnabled: true,       // STREAM A — ships ON
  strangerGateEnabled: true,             // STREAM B — ships ON
  linkPreviewsEnabled: true,             // STREAM C — ships ON
  richInputEnabled: true,                // STREAM E — ships ON
  groupTranslationEnabled: false,        // STREAM G — OFF (cost watch)
  smartRepliesEnabled: true,             // STREAM G — ships ON
  scamAutoScanEnabled: true,             // STREAM G — ships ON
  // [AVA-IDGATE-1] livenessOnboardingGate removed from DEFAULTS. Liveness is no longer
  // an onboarding gate — it fires at the first public action via identityGatingEnabled.
  unlimitedForwardEnabled: true,         // STREAM I — ships ON
  groupReceiptsEnabled: false,           // [AVAGRP-SEENBY-1] dark launch — flip in KV once verified (scripts/flags.sh set groupReceiptsEnabled=true)
  dohFallbackEnabled: true,              // PERF-DNS-2 — DoH-to-1.1.1.1 fallback ON
  routingV2Enabled: false,               // [ARCH-ROUTING-V2] v4 routing path — DORMANT until wired + validated; legacy path unaffected
  sentinelEnabled: false,                // Guardian Sentinel S1 — DARK; flip ON in KV platform_config (never code) after telemetry review
  sentinelMem0Enabled: false,            // Sentinel S2 behaviour memory (mem0) — DARK; needs KV flag ON + MEM0_API_KEY secret
  guardianInlineEnabled: false,          // Guardian G3 inline two-lane scan — DARK; with it off messaging.ts is unchanged (deep lane only)
  guardianInlineBudgetMs: 600,           // G3 fast-lane hard budget (ms) for the single Nemotron moderate() call
  guardianGateEnabled: false,            // U1-lite manual "Require verification" gate — DARK; server modes 403 + client control hidden
  minAppBuild: 0,
  latestAppBuild: 0,                     // newest published build; >installed → soft "update available" popup (opens Play Store). Owner bumps in KV per release. 0 = never prompt.
  inAppUpdateEnabled: true,              // [AVA-UPDATE-AUTO] emergency brake for the auto-updater. TRUE (matches the client's own fallback default, so declaring it changes nothing today) — set false in KV to stop every device update-checking.
  // Call-state control-plane authority (Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md §5)
  // — Phase A plumbing only. All OFF/legacy: CallStateAuthorityDO is bound but dark.
  authorityShadowEnabled: true,   // CALL-AUTH-LIVE-1: authority observes + records vs legacy
  authorityReadEnabled: true,     // routes may READ authority state
  authorityWriteEnabled: true,    // routes WRITE call state through the authority DO (fail-open)
  authorityEnforced: false,       // verdicts NOT yet enforced — one KV flip when shadow data is clean
  callProtocolVersion: 2,
  busyCardEnabled: true,           // Busy-card feature (personalized card + waiter list + now-free FCM) — LIVE 2026-07-07 (glue wired end-to-end). Flip false in KV to force legacy "User is busy".
  // Ava Copilot Phases A+B — ALL DARK until device-verified; flip ON in KV.
  avaCopilotEnabled: false,           // master switch (private lane + per-chat toggle + doc routes)
  avaDocActionsEnabled: false,        // Summarize ✨ / Translate ✨ context-menu actions
  avaAutoTranslateFileEnabled: false, // Auto-translate file ✨ (chunked — cost watch)
  // Ava Copilot Phases C+D — ODL ships DARK; flip via scripts/flags.sh set odlEnabled=true
  odlEnabled: false,          // ODL wake scan (shadow telemetry only; zero AI, zero user-visible output)
  avaMomentsEnabled: false,   // no user-visible Moments until a capability is production AND this is on
  // Call Outcome Menu (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md) — ships DARK;
  // flip callMenuEnabled=true in KV (scripts/flags.sh) on staging first.
  callMenuEnabled: false,            // master switch for the unified call outcome menu
  callMenuListingsEnabled: false,    // See Listings button — stays OFF until marketplace goes public
  callMenuRateLimitEnabled: true,    // per-caller daily caps live whenever the menu is on
  avaSessionsPerCallerPerDay: 2,     // owner 2026-07-09: 2 Ava sessions/caller/owner/day, then greyed out
  strangerVoiceNotesPerDay: 5,       // stranger voice-note cap (known contacts unlimited)
  strangerTextNotesPerDay: 10,       // stranger text-note cap (known contacts unlimited)
  // Dialpad business calls + Ava AI Voice Agent — ALL DARK until each phase is
  // device-verified on staging; flip one at a time in KV (never code).
  businessCallUx: false,
  voicemailBot: false,
  paidCalls: false,
  voiceAgent: false,
  serviceNumbers: false,
  // 4-root shell (Home/AvaDial/AvaTalk/Services) — DARK. While false the client
  // renders today's messenger-first shell unchanged; flip ON in KV (staging first)
  // to switch to ShellV2. Client mirror: RemoteConfig.shellV2.
  shellV2: false,
  // AvaDial spam shield — DARK. While false every /api/spam/* route 403s and the
  // nightly scoring job no-ops. Flip ON in KV (staging first) after device tests.
  spamShield: false,
  // AvaDial native dialer surfaces — DARK. While false the AvaDial root keeps
  // its Phase-1 placeholders. Flip ON in KV (staging first) after the telecom
  // spike's device test matrix passes. Client mirror: RemoteConfig.avaDialer.
  avaDialer: false,
  // [AVADIAL-NATIVE-INCALL-1] Native in-call screen — DARK. While false, the answer
  // path is byte-for-byte the current Flutter one. Flip ON only after the device
  // matrix passes (mute/keypad/speaker/hold/bluetooth/end + lock-screen answer).
  nativeInCallUi: false,
  // [AVA-MISSEDCALL-1] Missed-call overlay + phone-presence lookup — DARK by default.
  // While false, /api/contacts/match returns nothing (privacy lock intact) and the
  // native missed-call receiver/overlay never fire. Flip ON in KV (staging first)
  // once the overlay is device-verified. Client mirror: RemoteConfig.missedCallOverlay.
  missedCallOverlay: false,
  // AvaDial default-SMS-app surfaces — DARK. While false the Messages tab keeps its
  // Phase-1 placeholder, NO SMS role is requested and the native SMS receivers stay
  // inert. Flip ON in KV (staging first) after the SMS role + device matrix passes
  // and Play's default-SMS-handler declaration is approved. Client mirror:
  // RemoteConfig.avaSms.
  avaSms: false,
  // [DEFAULT-APPS-REPROMPT-1] One-time "make AvaTOK your phone" re-prompt for
  // existing users — ON. Self-limiting: at most once per account, and only for
  // users missing the roles. Flip false in KV to kill it without a build.
  defaultAppsReprompt: true,
  // Contact-book backup/restore — LIVE + free. Paged download + R2 chunking ON so
  // large books restore a page at a time. Panic-off via contactsBookEnabled=false.
  contactsBookEnabled: true,
  contactsBookPaged: true,
  // [AVADIAL-BACKUP-DAILY] Daily background backup ON by default (owner decision
  // 2026-07-15: backup is a default app behaviour, not an opt-in). Set false in KV
  // to stop every client's daily job without a build.
  contactsDailyBackup: true,
  // §11/§15 constants — flag-overridable values, not design. Defaults per plan.
  minServiceRate: 20,
  agentRateAPerMin: 6,
  platformFeePerMin: 10,
  serviceLineFeePerMin: 3,
  agentMaxCallSec: 300,
  ringTimeoutSec: 30,
  agentAutoanswerSec: 12,
  voicemailRecordSec: 25,
  escrowPromptTimeoutSec: 30,
  offlineDetectSec: 6,
  agentConcurrencyA: 1,
  agentConcurrencyB: 5,
  networkReconnectWindowSec: 20,
  // PSTN voicemail platform — DARK. While false, worker/src/routes/pstn.ts runs
  // pure-probe mode only (capture + orphan voicemail, no owner inbox delivery).
  // Flip ON in KV (staging first) once Phase 0 carrier verification passes.
  pstnVoicemail: false,
  pstnVoicemailRecordSec: 25,
  // [AVA-VM-PAID-1] FALSE = missed/declined are a locked paid upgrade (the
  // launch state). Flip TRUE only when the paid tier actually ships.
  pstnPaidConditionsUnlocked: false,
  // [AVA-PSTN-AGENT-1] Live Gemini agent on Vobiz DID calls — SHIPS DARK.
  // Flip on only after: Gemini credits topped up on avatok-avaglobal, audio-
  // streams confirmed enabled on the Vobiz account, and a test owner has
  // mode="agent". Boolean → NOT in numericKeys.
  pstnAgentEnabled: false,
  // Creator marketplace (/api/marketplace/*) — DARK, per FREE LAUNCH. The kill switch
  // marketplace.ts always claimed to have; it did not exist until now.
  marketplaceEnabled: false,
  // OLX surface (/api/olx/*) — DARK. Was previously ungated in production; flip ON in
  // KV (staging first) when it should be reachable.
  olxEnabled: false,
  // AI-chat listing creation (/api/marketplace/compose/*) — DARK. An LLM that talks to
  // sellers and drafts public listing text; staging first, and the form stays as the
  // escape hatch until the funnel says otherwise (M-D7).
  aiComposeEnabled: false,
  // Per-listing billing — DARK. While off, publishes are free and entitlements are
  // still recorded so the 5-free quota is accurate when this flips on (staging first).
  listingFeeEnabled: false,
  // Compose brain enrichment — DARK. Needs One Brain B4 + the user's listings consent;
  // separate from aiComposeEnabled so compose can be live without account-history recall.
  listingBrainEnrichmentEnabled: false,
};

/** Merged config for server-side gates (same blob getConfig serves). */
export async function readConfig(env: Env): Promise<PlatformConfig> {
  let stored: Partial<PlatformConfig> = {};
  try { stored = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>; } catch { /* defaults */ }
  return { ...DEFAULTS, ...stored };
}

export async function getConfig(env: Env): Promise<Response> {
  let stored: Partial<PlatformConfig> = {};
  try {
    stored = (await env.TOKENS.get(KEY, "json")) ?? {};
  } catch { /* defaults */ }
  // PartyKit realtime layer master switch (replaces Ably). Ships DARK: the client
  // only opens party sockets when this is true. Flip via `wrangler secret put
  // PARTY_ENABLED` = "1" once the PartyDO migration (v11) is deployed.
  const partyEnabled = env.PARTY_ENABLED === "1";
  return json({ ...DEFAULTS, ...stored, partyEnabled }, 200, {
    "cache-control": "public, max-age=60",
  });
}

export async function putConfig(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const admins = (env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(u.uid)) return json({ error: "admin only" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // Whitelist merge — unknown keys are rejected so a typo can't ship a dead flag.
  //
  // [ENV-ISOLATION-1] KV stores OVERRIDES ONLY — never `{...DEFAULTS, ...current}`.
  // The old code materialized all ~40 flags into the blob on every write, which
  // meant (a) flipping one switch rewrote the entire config, and (b) once the
  // blob existed, changing a default in this file silently stopped taking effect
  // because the stale value was pinned in KV forever. Readers (readConfig /
  // getConfig) already layer DEFAULTS underneath, so an absent key is correct and
  // self-healing. To drop a stale pinned key: `scripts/flags.sh unset <key>`
  // (or `scripts/flags.sh prune` to sweep every key that just restates a default).
  const current = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>;
  const next: Record<string, unknown> = { ...current };
  const numericKeys = new Set([
    "minAppBuild", "latestAppBuild", "dailyAvaTurnLimit", "receptionistRings", "agentDailyCap", "livenessAuditSampleRate",
    "receptWrapCueMs", "receptCloseMs", "receptHardCapMs",
    "usdInrRate", "receptMarginAlertPaise", // [RECEPT-BILLING-3] cost-ledger FX + margin alert threshold
    "guardianInlineBudgetMs", "callProtocolVersion", "avaSessionsPerCallerPerDay", "strangerVoiceNotesPerDay",
    "strangerTextNotesPerDay",
    // Dialpad business calls + Ava AI Voice Agent — §11/§15 numeric constants.
    "minServiceRate", "agentRateAPerMin", "platformFeePerMin", "serviceLineFeePerMin", "agentMaxCallSec",
    "ringTimeoutSec", "agentAutoanswerSec", "voicemailRecordSec", "escrowPromptTimeoutSec", "offlineDetectSec",
    "agentConcurrencyA", "agentConcurrencyB", "networkReconnectWindowSec",
    // PSTN voicemail platform (Canonical Architecture v1.0).
    "pstnVoicemailRecordSec",
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULTS)) return json({ error: `unknown key: ${k}` }, 400);
    if (numericKeys.has(k) ? typeof v !== "number" : typeof v !== "boolean") {
      return json({ error: `bad type for ${k}` }, 400);
    }
    next[k] = v;
  }
  await env.TOKENS.put(KEY, JSON.stringify(next));
  // Echo the EFFECTIVE config (defaults + overrides) so the admin UI still sees
  // every flag, even though only `next` was persisted.
  return json({ ok: true, config: { ...DEFAULTS, ...next }, overrides: next });
}
