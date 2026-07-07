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
  verseEnabled: boolean;
  // Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md)
  identityLadderEnabled: boolean;    // master switch for requireLevel gating
  guestTierEnabled: boolean;         // L0 handle-only visitors
  workersAiLivenessEnabled: boolean; // L2 via Workers AI clip check (Rekognition fallback)
  simOnlyPhoneEnabled: boolean;      // block VoIP/temp numbers on phone verify
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
  receptionistRings: number;         // v2 Mode A: rings before auto-handoff (default 5)
  // Receptionist ENGINE switch (Specs/RECEPTIONIST-CF-PIPELINE.md). false (default)
  // = Gemini Live (do/reception_room.ts — untouched). true = the SEPARATE
  // Cloudflare-native engine (do/reception_room_cf.ts: Workers AI Deepgram/Whisper
  // STT → Llama LLM → Aura-2 TTS, fixed female "Ava"). Same Flutter client either
  // way — /start just points the call's WS at the chosen DO. One KV flip switches
  // every NEW call, instantly reversible, so the two can be A/B'd for cost.
  receptionistUseCf: boolean;
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
  livenessOnboardingGate: boolean;           // STREAM H: hard liveness gate at signup / existing-user redirect
  unlimitedForwardEnabled: boolean;          // STREAM I: unlimited forwarding + forward-to-groups
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
  verseEnabled: false,             // FREE LAUNCH: creator dashboard hidden
  identityLadderEnabled: true,
  guestTierEnabled: true,
  workersAiLivenessEnabled: true,  // ON 2026-07-03: Cloudflare-native liveness (no AWS/Rekognition creds); powers the signup human-check
  simOnlyPhoneEnabled: true,
  translationEnabled: false,       // FREE LAUNCH: Gemini-Live cost — hidden
  translationGroupEnabled: false,  // FREE LAUNCH: hidden
  avavoiceEnabled: false,          // FREE LAUNCH: agent builder hidden
  avavisionEnabled: false,         // FREE LAUNCH: agent builder hidden
  receptionistEnabled: true,       // FREE LAUNCH: AI receptionist ON (Gemini Live)
  receptionistRings: 6,            // v2 Mode A: auto-handoff after 6 unanswered rings (CALLFIX-10: changed from 4; KV can override)
  receptionistUseCf: false,        // engine switch: false = Gemini Live (default), true = Cloudflare Workers AI engine
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
  livenessOnboardingGate: false,         // OFF 2026-07-03: liveness moved to listing-creation gate, NOT onboarding
  unlimitedForwardEnabled: true,         // STREAM I — ships ON
  dohFallbackEnabled: true,              // PERF-DNS-2 — DoH-to-1.1.1.1 fallback ON
  routingV2Enabled: false,               // [ARCH-ROUTING-V2] v4 routing path — DORMANT until wired + validated; legacy path unaffected
  sentinelEnabled: false,                // Guardian Sentinel S1 — DARK; flip ON in KV platform_config (never code) after telemetry review
  sentinelMem0Enabled: false,            // Sentinel S2 behaviour memory (mem0) — DARK; needs KV flag ON + MEM0_API_KEY secret
  guardianInlineEnabled: false,          // Guardian G3 inline two-lane scan — DARK; with it off messaging.ts is unchanged (deep lane only)
  guardianInlineBudgetMs: 600,           // G3 fast-lane hard budget (ms) for the single Nemotron moderate() call
  guardianGateEnabled: false,            // U1-lite manual "Require verification" gate — DARK; server modes 403 + client control hidden
  minAppBuild: 0,
  // Call-state control-plane authority (Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md §5)
  // — Phase A plumbing only. All OFF/legacy: CallStateAuthorityDO is bound but dark.
  authorityShadowEnabled: true,   // CALL-AUTH-LIVE-1: authority observes + records vs legacy
  authorityReadEnabled: true,     // routes may READ authority state
  authorityWriteEnabled: true,    // routes WRITE call state through the authority DO (fail-open)
  authorityEnforced: false,       // verdicts NOT yet enforced — one KV flip when shadow data is clean
  callProtocolVersion: 2,
  busyCardEnabled: false,          // Busy-card server feature (waiter list + now-free FCM + acquire enrichment) — DARK; flip ON in KV once the client card ships + is device-verified
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
  const current = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>;
  const next: Record<string, unknown> = { ...DEFAULTS, ...current };
  const numericKeys = new Set(["minAppBuild", "dailyAvaTurnLimit", "receptionistRings", "agentDailyCap", "livenessAuditSampleRate", "guardianInlineBudgetMs", "callProtocolVersion"]);
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULTS)) return json({ error: `unknown key: ${k}` }, 400);
    if (numericKeys.has(k) ? typeof v !== "number" : typeof v !== "boolean") {
      return json({ error: `bad type for ${k}` }, 400);
    }
    next[k] = v;
  }
  await env.TOKENS.put(KEY, JSON.stringify(next));
  return json({ ok: true, config: next });
}
