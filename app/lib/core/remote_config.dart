import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

import '../identity/identity.dart';
import '../sync/party/party_hub.dart';
import 'analytics.dart';
import 'ava_log.dart';
import 'config.dart';
import 'disk_cache.dart';
import 'feature_flags.dart';
import 'money_api.dart';
import 'net/ava_dns.dart';

/// Remote kill switches (creator-marketplace Phase 1, audit A2). Mirrors the
/// Worker's GET /api/config (KV `platform_config`). Fetched at app start and
/// every 15 min; money/live UI must check the matching getter before
/// rendering. Defaults are PERMISSIVE except real money, so a fetch failure
/// never bricks the app.
class RemoteConfig {
  RemoteConfig._();

  static Map<String, dynamic> _cfg = const {};
  static Timer? _timer;

  /// Bumps whenever a fetch lands — listen to re-check flags (e.g. the
  /// minAppBuild gate in RootFlow).
  static final ValueNotifier<int> revision = ValueNotifier(0);

  /// Whether the SIGNED-IN account is a platform admin (uid ∈ server ADMIN_UIDS).
  /// Resolved by [refreshAdmin] via the existing signed /admin/recon probe. Used
  /// to surface admin-only, not-yet-launched surfaces (e.g. the Marketplace) to
  /// the operator without exposing them to ordinary testers. Per-account: it is
  /// re-resolved on every config refresh AND on every account switch (see
  /// [onAccountSwitched]), so an account switch on a shared phone re-checks
  /// against the newly active token instead of inheriting the departing
  /// account's value.
  static bool _isAdmin = false;
  static bool get isAdmin => _isAdmin;

  /// Per-account cache key for [_isAdmin]. DiskCache is scoped by AccountScope.id,
  /// so each account on a shared phone keeps its OWN cached admin flag — a switch
  /// never inherits the previous account's value, and there is no cross-account
  /// leak. The signed /admin/recon probe ([refreshAdmin]) stays the source of
  /// truth and refreshes this cache; the cache only supplies an instant, leak-free
  /// paint before the probe lands (no Marketplace flicker on a non-admin child).
  static const String _kAdminCache = 'is_admin';

  /// [ADMIN-GATE] Per-account timestamp (ms) of the last COMPLETED /admin/recon
  /// probe. PostHog (7d prod): every ordinary user's client fired the admin probe
  /// on launch + every 15 min, so the directory saw 95×401 (79 users) + 128×403
  /// (39 users) and 378 admin_probe events across 82 users — all rejections, all
  /// pure waste, since admin status is a fixed server-side claim that does not
  /// change minute to minute. Admin status is only knowable server-side (no local
  /// claim), so for a NON-admin account we cache the rejection and re-probe at
  /// most once a week; a known admin (cached is_admin=1) keeps probing normally so
  /// a revoked admin loses admin surfaces promptly. Scoped by AccountScope.id.
  static const String _kAdminProbeAtKey = 'admin_probe_last_ms';
  static const int _adminProbeThrottleMs = 7 * 24 * 60 * 60 * 1000; // 7d

  /// Load the ACTIVE account's cached admin flag into memory (instant paint).
  /// Never throws; defaults to non-admin when nothing is cached for this account.
  static Future<void> _loadAdminCache() async {
    bool v = false;
    try { v = (await DiskCache.read(_kAdminCache)) == '1'; } catch (_) {/* best-effort */}
    if (v != _isAdmin) { _isAdmin = v; revision.value++; }
  }

  /// Re-resolve admin state for the NEWLY active account after an account switch.
  /// Step 1 paints the target account's own cached value instantly (leak-free on a
  /// shared phone — a non-admin child no longer briefly sees admin-only surfaces
  /// like the Marketplace). Step 2 re-probes the server to confirm + refresh the
  /// cache. Skips the network probe on logout (no active account). Never throws.
  static Future<void> onAccountSwitched() async {
    await _loadAdminCache();
    if (AccountScope.id != null && AccountScope.id!.isNotEmpty) {
      unawaited(refreshAdmin());
    }
  }

  static bool _b(String k, bool dflt) => _cfg[k] is bool ? _cfg[k] as bool : dflt;

  /// Tolerant numeric parsing: handles bool→num cast (when server sends true/false
  /// for numeric fields). Converts bool 1→1, 0→0; otherwise tries num parse.
  /// This prevents "bool is not num?" crashes when config fields are mistyped.
  static num? _asNum(dynamic v) => v is num ? v : (v is bool ? (v ? 1 : 0) : null);

  // FREE LAUNCH (2026-06-28, Specs/FREE-LAUNCH-DIRECTION.md): the hidden-feature
  // defaults below flip to FALSE so a config-fetch failure renders the focused
  // free product (not the full marketplace). The live KV `platform_config`
  // mirrors these; flip them back when paid/marketplace returns.
  static bool get walletRealMoney => _b('walletRealMoney', false);
  static bool get donationsEnabled => _b('donationsEnabled', true);
  static bool get liveEnabled => _b('liveEnabled', false);
  static bool get consultEnabled => _b('consultEnabled', false);
  static bool get conferenceEnabled => _b('conferenceEnabled', true);
  // [AVA-VM-NOCOUNTDOWN-1] 3-2-1 Ava warm-up countdown before voicemail. Default ON
  // (legacy behavior); prod KV flips it OFF because the cached VM greeting is instant.
  static bool get avaCountdownEnabled => _b('avaCountdownEnabled', true);
  /// [AVA-SYNC-SKIP] Kill switch for the reconnect/resume empty-catch-up skip. Default
  /// TRUE. When true, the InboxDO answers a reconnect/resume whose cursor is already at
  /// head with a cheap `sync_skip` frame instead of a full replay. Flip false in KV to
  /// make every device fall back to the always-full-sync behaviour. Declared in
  /// worker/src/routes/config.ts (PlatformConfig + DEFAULTS) so it is a real, flippable flag.
  static bool get syncSkipEnabled => _b('syncSkipEnabled', true);
  /// CF Realtime SFU group-audio path — dormant until its build lands + is
  /// CI/device-verified. While false, group calls use the existing LiveKit path.
  static bool get groupAudioSfuEnabled => _b('groupAudioSfuEnabled', false);
  static bool get brainEnabled => _b('brainEnabled', false);
  /// [ONEBRAIN-B4] Global kill-switch for cloud reasoning over device_private
  /// brain content (SPEC §6, B-D6). Default TRUE (owner decision 2026-07-18:
  /// cloud reasoning is allowed; the per-account "Local-only answers" toggle is
  /// the opt-out). When flipped FALSE in KV it behaves like every account has the
  /// toggle ON — `brainRecall(forCloud: true)` strips device_private hits for
  /// everyone, so no on-device excerpt ever reaches a cloud model. Declared in
  /// worker/src/routes/config.ts (PlatformConfig + DEFAULTS, per the fake-flag
  /// rule) so it is a real, flippable flag — the server agent adds it there.
  static bool get cloudReasoningOverPrivate => _b('cloudReasoningOverPrivate', true);
  static bool get verseEnabled => _b('verseEnabled', false);
  static bool get translationEnabled => _b('translationEnabled', false);
  static bool get translationGroupEnabled => _b('translationGroupEnabled', false);
  static bool get avavoiceEnabled => _b('avavoiceEnabled', false);
  static bool get avavisionEnabled => _b('avavisionEnabled', false);
  // STREAM G (AI in chats). Mirrors config.ts flags of the same name.
  /// [GROUP-AI-2] per-member group translation (translate on fetch). Default OFF
  /// (cost watch) — the "Translate this group for me" toggle is hidden while off.
  static bool get groupTranslationEnabled => _b('groupTranslationEnabled', false);
  /// [GROUP-AI-4] DM smart-reply suggestion chips. Default ON.
  static bool get smartRepliesEnabled => _b('smartRepliesEnabled', true);
  /// [GROUP-AI-6] auto scam-scan a stranger thread on first render. Default ON.
  static bool get scamAutoScanEnabled => _b('scamAutoScanEnabled', true);
  /// STREAM I (AI Messenger Batch): unlimited forwarding + forward-to-groups.
  /// Master kill switch for the whole forwarding feature — the multi-select
  /// forward sheet and the /api/msg/forward route both gate on this. Default ON
  /// (per spec FWD-4); flip OFF in KV to fall back to hiding Forward if abuse
  /// ever spikes. Mirrors config.ts `unlimitedForwardEnabled`.
  static bool get unlimitedForwardEnabled => _b('unlimitedForwardEnabled', true);
  /// FREE LAUNCH: no paywalls. When true, the whole client renders premium and
  /// no upgrade/metering UI shows. Mirrors KV `betaFreePremium`.
  static bool get betaFreePremium => _b('betaFreePremium', true);
  /// FREE LAUNCH: subscriptions/checkout off. When false, hide Subscribe/upgrade
  /// + wallet top-up entry points. Mirrors KV `billingEnabled`.
  static bool get billingEnabled => _b('billingEnabled', false);
  /// AI receptionist (Gemini Live) — ON for the free launch. Mirrors KV.
  static bool get receptionistEnabled => _b('receptionistEnabled', true);

  /// [AVACALL-VMFREE-1] FREE AvaTOK↔AvaTOK auto-voicemail (owner decision, Phase
  /// WS2). Mirrors config.ts `avatokVoicemailFree`, which DECLARES this key in
  /// BOTH PlatformConfig and DEFAULTS (default true) — without that declaration
  /// putConfig would 400 `unknown key` and this kill switch could never actually
  /// be pulled (the inAppUpdateEnabled trap, CLAUDE.md 2026-07-15).
  ///
  /// When an AvaTOK→AvaTOK AUDIO call is rejected / unanswered / phone-off and
  /// the callee has NO active AI receptionist, the caller auto-fires a
  /// pre-recorded generic voicemail (greeting → beep → ~25s record) instead of a
  /// silent 'timeout-ringing' teardown. FREE for everyone — deliberately NOT
  /// gated by the paid `voicemailBot`/`businessCallUx`.
  ///
  /// Defaults TRUE: this is a free fallback that only fires AFTER the ring window
  /// has already elapsed with no answer, so a config-fetch failure falling back
  /// to "offer a voicemail" is the safe, user-friendly side. Flip false in KV to
  /// restore the silent no-answer teardown without a build.
  static bool get avatokVoicemailFree => _b('avatokVoicemailFree', true);
  /// [AVA-CAMP-FL-NAV] Outbound AI-calling campaigns — master switch for the
  /// whole feature (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md). Key already
  /// declared in worker DEFAULTS (worker/src/routes/config.ts
  /// `campaignsEnabled`, default false) and enforced server-side by every
  /// `/api/campaigns*` route's `gate()` — this getter is a real, flippable
  /// kill switch, not a client-only flag. Gates the "Campaigns"/"Analytics"
  /// settings entries; off by default until the dialer + billing path is
  /// verified in staging.
  static bool get campaignsEnabled => _b('campaignsEnabled', false);
  /// [INSTANT-CALL-MOUNT-1] When ON, tapping the audio/video call icon in a 1:1
  /// chat thread opens the CallScreen IMMEDIATELY and runs POST /api/call in the
  /// BACKGROUND (instead of awaiting the ~server round-trip before showing any
  /// UI, which made the call screen take seconds to appear). The optimistically-
  /// mounted session runs the honest guard flow (connecting + searching tone, no
  /// fake ringback) and the reachability/glare outcome is fed back once the POST
  /// resolves. Kill switch: flip to false in KV to restore the awaited path
  /// everywhere with no rebuild. Mirrors config.ts.
  static bool get instantCallMountEnabled => _b('instantCallMountEnabled', true);
  /// [BUSY-CARD-1] Personalized busy card (Cancel / Notify me / Leave a message
  /// for Ava) shown when a call resolves to 'busy'. Client kill switch mirroring
  /// the server's busy-card flag. The card ALSO requires the server to send a
  /// `busy_reason` on the busy status — so even with this ON, an old server that
  /// sends no reason falls back to the plain "User is busy" line. Default ON;
  /// flip to false in KV to force legacy behaviour everywhere. Mirrors config.ts.
  static bool get busyCardEnabled => _b('busyCardEnabled', true);
  /// CALL OUTCOME MENU (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md): one unified
  /// caller-facing menu for every non-answered call (declined / no-answer /
  /// unreachable / busy). Talk to Ava, voice note, text note, See Listings.
  /// Ships DARK (default false); flip callMenuEnabled=true in KV to activate.
  /// Mirrors config.ts.
  static bool get callMenuEnabled => _b('callMenuEnabled', false);
  /// "See Listings" button on the call outcome menu — OFF until the marketplace
  /// goes public (owner 2026-07-09). Mirrors config.ts.
  static bool get callMenuListingsEnabled => _b('callMenuListingsEnabled', false);
  /// MKT-LANG (AI Messenger Batch, STREAM A): the "Marketplace Agent" settings
  /// surface (default language/voice/tone + negotiation guardrails). Default ON;
  /// the settings tile hides when false. Mirrors config.ts.
  static bool get marketplaceAgentSettingsEnabled => _b('marketplaceAgentSettingsEnabled', true);
  /// MKT-LANG-3: English-canonical negotiation + per-recipient translation +
  /// quiet-hours/floor/ask-before-commit guardrails. Default ON. Mirrors config.ts.
  static bool get mktI18nNegotiationEnabled => _b('mktI18nNegotiationEnabled', true);
  /// P1 call-reliability: gate the caller's Ava-takeover countdown on the server's
  /// ring-ack (incoming-call FCM push outcome). Ships dark (default OFF); flip in
  /// KV after a device test. Mirrors config.ts `receptTakeoverGuard`.
  static bool get receptTakeoverGuard => _b('receptTakeoverGuard', false);
  /// P4: require video-liveness verification before creating/publishing a listing.
  /// Ships dark (default OFF); flip ON at launch. Mirrors config.ts.
  static bool get listingLivenessGate => _b('listingLivenessGate', false);
  /// Liveness V2 (Specs/LIVENESS-V2-PLAN.md): the ML-Kit-gated, detection-driven
  /// selfie-video flow that replaces the timer-script V1. Ships DARK (default
  /// OFF); while off the V1 [LivenessCheckScreen] is used unchanged. Flip
  /// `livenessV2Enabled: true` in KV `platform_config` once V2 pass-rate is
  /// proven. Mirrors config.ts.
  static bool get livenessV2Enabled => _b('livenessV2Enabled', false);
  /// Liveness V3 (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md): the voice-guided
  /// flow — language picker, on-device ML Kit coaching with pre-recorded Ava voice
  /// packs, server-randomized challenges, per-stage no-dead-screen watchdog, and
  /// background upload to presigned R2. Ships DARK (default OFF); while off the V2
  /// [LivenessV2Screen] (or V1) is used unchanged. Flip `livenessV3Enabled: true`
  /// in KV `platform_config` once V3 pass-rate is proven. Mirrors config.ts. Takes
  /// precedence over V2 when both are on.
  static bool get livenessV3Enabled => _b('livenessV3Enabled', false);
  /// [LIVE-DIDIT-1] didit.me-hosted liveness (owner decision 2026-07-09) — THE
  /// live path; takes precedence over v3/v2/v1. Default TRUE (this is the
  /// pipeline now); the flag exists only as a kill switch. Mirrors config.ts.
  static bool get diditLivenessEnabled => _b('diditLivenessEnabled', true);
  // [AVA-IDGATE-1] livenessOnboardingGate getter REMOVED. The onboarding/app-open
  // liveness gate (HumanCheckPage + _landOrGate) is gone; liveness fires at the first
  // public action, enforced server-side. Nothing on the client reads this any more.
  /// P11: mandatory + AI-vetted profile completion. Ships dark (default OFF); flip
  /// ON at launch. When on, an incomplete profile is routed to the Profile screen
  /// before the app, and the save shows a hold state while the server vets. Mirrors config.ts.
  static bool get profileCompletionGate => _b('profileCompletionGate', false);
  /// P8 Stage 3: daily auto-backup to the user's OWN Google Drive — ON for ALL
  /// users (no premium gate). Flip OFF in KV to disable the daily job.
  static bool get driveAutoBackup => _b('driveAutoBackup', true);
  /// P8 Stage 2: lazily page older history from R2 beyond the hot window. Dark.
  static bool get restoreV2 => _b('restoreV2', false);
  /// ChatAVA "talk to Ava by voice" — the hands-free Gemini Live call
  /// (LiveVoiceController). Owner kill switch (2026-06-27): default OFF so the
  /// feature stays dark after a config-fetch failure and can't burn the shared
  /// Gemini Live quota. NOTE: distinct from [avavoiceEnabled] (the AvaVoice
  /// studio/agents app). Flip `aiVoiceCallEnabled: true` in KV `platform_config`
  /// to re-enable. Premium still applies on top of this when the switch is on.
  static bool get aiVoiceCallEnabled => _b('aiVoiceCallEnabled', false);
  /// AvaAffiliate (PROPOSAL-AVA-AFFILIATE) — default OFF until launch, so a
  /// config-fetch failure never advertises a program the Worker isn't serving.
  static bool get avaAffiliateEnabled => _b('avaAffiliateEnabled', false);
  /// v2 marketing-asset kit (Gemini Nano Banana 2 promo images) — default OFF.
  static bool get affiliateAssetKitEnabled => _b('affiliateAssetKitEnabled', false);
  /// AI Ringback Tones + Busy Tone — master switch (server panic off). Default
  /// mirrors kRingbackEnabledDefault so a fetch failure keeps the feature on.
  static bool get ringbackEnabled => _b('ringbackEnabled', kRingbackEnabledDefault);
  /// In-chat AI image generation (ChatAVA "make an image"). Server kill switch
  /// mirrors the compile default [kGenerativeEnabledDefault]. When false the
  /// client short-circuits every image request to a canned "coming soon" reply
  /// WITHOUT a network call (see ava_generative/image_tool.dart). Live (pro)
  /// build sets `imageGenEnabled:false` in prod KV; staging keeps it true so the
  /// side-by-side test APK still exercises generation.
  static bool get imageGenEnabled => _b('imageGenEnabled', kGenerativeEnabledDefault);
  /// Guardian (scam/grooming/deepfake safety) surfaces + settings section.
  /// Mirrors the compile default [kGuardianEnabledDefault]. When false the
  /// Guardian settings section is not registered and the per-chat shield icon is
  /// hidden. Live (pro) build sets `guardianEnabled:false` in prod KV.
  static bool get guardianEnabled => _b('guardianEnabled', kGuardianEnabledDefault);
  /// U1-lite (Guardian Sentinel §U1): MANUAL "Require verification" gate. When ON,
  /// the guardian settings sheet shows a "Require verification" row for 1:1 chats
  /// that asks the peer to complete a live face check (Trust Engine liveness).
  /// Fully DARK by default (server modes 403 `feature_off`; the client row is
  /// hidden). Mirrors config.ts `guardianGateEnabled`. Flip ON in KV platform_config.
  static bool get guardianGateEnabled => _b('guardianGateEnabled', false);
  /// AvaMarketplace (buy/sell/social + agent negotiation, Specs/AVAMARKETPLACE-
  /// FINAL-PROPOSAL.md). Default OFF so the feature stays dark after a config
  /// fetch failure and during phased rollout — flip `marketplaceEnabled: true`
  /// in KV `platform_config` to surface the Marketplace menu + agent calls.
  static bool get marketplaceEnabled => _b('marketplaceEnabled', false);

  /// [MKT2] AI-chat listing creation (PLAN-2026-07-17 §3). When ON, "Create
  /// listing" opens the AI compose chat instead of the 6-step form. Default OFF
  /// (mirrors config.ts `aiComposeEnabled`); the form stays as the fallback (M-D7)
  /// until the compose funnel proves out. Separate from `marketplaceEnabled` on
  /// purpose — compose can be dark while the marketplace itself is live.
  static bool get aiComposeEnabled => _b('aiComposeEnabled', false);

  /// Effective Marketplace visibility for the CURRENT account. The global
  /// `marketplaceEnabled` KV flag stays false during the phased/pro launch, so
  /// ordinary testers never see the Marketplace. Admins (see [isAdmin]) get it
  /// regardless, so the operator can dogfood + fix it in production while it
  /// stays hidden for everyone else. Toggle it per-tester by adding/removing
  /// their uid from the server ADMIN_UIDS var; flip `marketplaceEnabled: true`
  /// in KV `platform_config` for the eventual full launch to all users.
  static bool get marketplaceVisible => marketplaceEnabled || _isAdmin;
  /// DNS-over-HTTPS fallback (PERF-DNS-2): resolve our hostnames via 1.1.1.1 when
  /// the device resolver fails. Default ON (works before the first config fetch);
  /// this is a kill switch — set `dohFallbackEnabled: false` in KV to force pure
  /// OS resolution if the fallback ever misbehaves. Applied to [AvaDns] in refresh().
  static bool get dohFallbackEnabled => _b('dohFallbackEnabled', true);
  /// Link previews + inline YouTube (AI Messenger Batch — STREAM C). Mirrors the
  /// KV `linkPreviewsEnabled` flag. Default ON. When false the chat renders raw
  /// link text only and never calls /api/unfurl. Mirrors [kLinkPreviewsEnabledDefault].
  static bool get linkPreviewsEnabled => _b('linkPreviewsEnabled', kLinkPreviewsEnabledDefault);
  /// WhatsApp-parity rich input bar + emoji/GIF/sticker panel (AI Messenger
  /// Batch — STREAM E). Mirrors the KV `richInputEnabled` flag. Default ON. When
  /// false the chat falls back to the legacy composer row (no emoji/GIF/sticker
  /// panel, no GIF/sticker send). Add `richInputEnabled: true` to the config.ts
  /// PlatformConfig interface + defaults so it can be flipped from KV.
  static bool get richInputEnabled => _b('richInputEnabled', true);
  /// STREAM B (stranger safety gate). When false the whole feature is hidden: a
  /// new non-contact thread renders the normal composer (no gate), no Message
  /// requests grouping, no media blur. Default ON (safety ships enabled). Mirrors
  /// config.ts `strangerGateEnabled`.
  static bool get strangerGateEnabled => _b('strangerGateEnabled', true);
  // DIALPAD BUSINESS CALLS + AVA VOICE AGENT (Specs/PLAN-2026-07-11-dialpad-
  // business-calls-ava-voice-agent.md §8/§15.6). One kill switch per phase;
  // all default OFF so a config-fetch failure keeps today's behaviour exactly
  // as-is. Staging first; prod flipped one at a time on the owner's say-so.
  /// Phase A — the friend/business channel split: email-only new-chat search,
  /// tappable AvaTOK numbers → dialpad, the no-answer card, and the named
  /// incoming-business-call screen. Mirrors config.ts `businessCallUx`.
  static bool get businessCallUx => _b('businessCallUx', false);
  /// [AVACALL-INUI-1] Use the branded IncomingBusinessCallScreen (avatar +
  /// Accept/Decline/Block/Send-to-Ava) for ALL AvaTOK incoming calls — friend
  /// AND business — instead of only dialpad business calls, and raise it over
  /// the lock screen via a full-screen intent when the app isn't foregrounded.
  /// Default TRUE (owner decision 2026-07-20 — the cheap native CallKit green
  /// screen was the "friend call looks unbranded" tell). Flip false in KV to
  /// fall back to native CallKit everywhere. Mirrors config.ts `brandedIncomingUi`.
  static bool get brandedIncomingUi => _b('brandedIncomingUi', true);
  /// Phase B — the server-side voicemail bot (5-rings → prompt → 25s record).
  /// Mirrors config.ts `voicemailBot`.
  static bool get voicemailBot => _b('voicemailBot', false);
  /// Phase B2 — caller-pays paid calls (escrow + per-minute settle). Mirrors
  /// config.ts `paidCalls`.
  static bool get paidCalls => _b('paidCalls', false);
  /// Phase C — the Ava AI Voice Agent (Grok realtime session). Gates the
  /// "Send to Ava AI Agent" option on the incoming-business-call screen.
  /// Mirrors config.ts `voiceAgent`.
  static bool get voiceAgent => _b('voiceAgent', false);
  /// Phase C — additional caller-pays AvaTOK service numbers (Mode B only).
  /// Mirrors config.ts `serviceNumbers`.
  static bool get serviceNumbers => _b('serviceNumbers', false);
  /// Home · AvaDial · AvaTalk · Services 4-root shell (Specs/PLAN-2026-07-12-home-
  /// ava-tok-services-shell.md, Phase 1). Ships DARK (default false): while off the
  /// app renders today's messenger-first [AvaShell] byte-for-byte. Flip
  /// `shellV2: true` in KV `platform_config` (staging first) to switch to
  /// [ShellV2]. Mirrors config.ts `shellV2`.
  static bool get shellV2 => _b('shellV2', false);

  /// AvaDial PSTN dialer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell.md §4,
  /// Phase 2b + Specs/SPIKE-2026-07-12-avadial-telecom.md). Ships DARK (default
  /// false): while off the AvaDial tabs render the Phase-1 placeholder empty states
  /// and NO telecom role is ever requested. Flip `avaDialer: true` in KV
  /// `platform_config` (staging first) to surface the device Contacts/Logs tabs, the
  /// block list, the "Make Ava your phone app" onboarding, the red/green/blue PSTN
  /// call screens and the CallScreeningService. Mirrors config.ts `avaDialer` (served
  /// by the worker). Default false so a config-fetch failure keeps AvaDial inert.
  static bool get avaDialer => _b('avaDialer', false);

  /// [AVADIAL-NATIVE-INCALL-1] Native in-call screen (owner decision 2026-07-15).
  /// Mirrors config.ts `nativeInCallUi`. While FALSE, answering a PSTN call hands
  /// off to MainActivity and [InCallScreen] exactly as today. While TRUE the native
  /// InCallActivity takes over and Flutter never enters the call path — no engine
  /// boot, no Keystore, no Firebase/PostHog init, no 3s shell gate.
  ///
  /// Native cannot read this class (it runs with no engine), so ShellV2 mirrors the
  /// resolved value to <filesDir>/avadial/native_ui.json via
  /// [AvaDialChannel.setNativeInCallEnabled]. A missing mirror reads as OFF.
  ///
  /// Default OFF: this is the answer path that broke prod testers on 2026-07-14.
  static bool get nativeInCallUi => _b('nativeInCallUi', false);

  /// [AVA-MISSEDCALL-1] Truecaller-style missed-call overlay (owner request
  /// 2026-07-14). Master kill switch, mirrors config.ts `missedCallOverlay`. While
  /// false the native PHONE_STATE receiver/overlay stay inert and /api/contacts/match
  /// returns nothing (the 2026-06-27 phone-presence privacy lock stays intact). Turning
  /// it ON deliberately reverses that lock so AvaTOK membership is resolved from the
  /// caller's real number. Default OFF.
  static bool get missedCallOverlay => _b('missedCallOverlay', false);

  /// AvaDial default-SMS-app layer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  /// .md, AVA-SMS; owner decision 2026-07-12). Ships DARK (default false): while off
  /// the AvaDial Messages tab renders its Phase-1 placeholder, NO SMS role is ever
  /// requested and the native SMS receivers/send service stay inert. Flip
  /// `avaSms: true` in KV `platform_config` (staging first) to surface the "Make
  /// AvaTOK your messages app" onboarding, the SMS conversation list + composer and
  /// the AI Inbox/Spam filter over carrier SMS. Requires ROLE_SMS at runtime
  /// (independent of the dialer role). Mirrors config.ts `avaSms` (served by the
  /// worker). Default false so a config-fetch failure keeps AvaDial's SMS surfaces
  /// inert.
  static bool get avaSms => _b('avaSms', false);

  /// [DEFAULT-APPS-REPROMPT-1] One-time re-prompt sending existing users who never
  /// onboarded to Settings → "Default phone & messages" (owner request
  /// 2026-07-15). Mirrors config.ts `defaultAppsReprompt`, which DECLARES this key
  /// in both PlatformConfig and DEFAULTS — without that declaration putConfig
  /// would 400 `unknown key` and this kill switch could never actually be pulled
  /// (the inAppUpdateEnabled trap, CLAUDE.md 2026-07-15).
  ///
  /// Defaults TRUE here to match the server default: unlike avaDialer/avaSms this
  /// gates a prompt, not a capability, so a config-fetch failure falling back to
  /// "show it" is safe — the once-per-account key still bounds it.
  static bool get defaultAppsReprompt => _b('defaultAppsReprompt', true);

  /// [AVADIAL-BACKUP-DAILY] Client mirror of config.ts `contactsDailyBackup` —
  /// the kill switch for the ~24h WorkManager contact-book backup
  /// (features/avadial/contacts_daily_backup.dart), re-read on every wake.
  ///
  /// Defaults TRUE, unlike every other flag here. That is deliberate and it cuts
  /// against the usual "fail dark" instinct: the daily job runs in a headless
  /// isolate where a config fetch can fail for boring reasons (no network yet,
  /// DNS still cold), and defaulting false would mean a flaky fetch silently
  /// stops backing up the contacts of the exact users this feature exists for.
  /// The failure modes are not symmetric — a redundant upload of an unchanged
  /// book costs a round-trip the change-detector usually skips anyway; a skipped
  /// backup costs someone their contacts. To truly stop the lane, set the KV flag
  /// false: clients that CAN reach config (the only ones that can upload at all)
  /// will honour it.
  static bool get contactsDailyBackup => _b('contactsDailyBackup', true);

  /// AvaDial community spam shield (client mirror of config.ts `spamShield`).
  /// Gates community lookups/reports from the SMS + call surfaces; while false
  /// those degrade to local-only labels (the worker also 403s every /api/spam/*
  /// route, so this mirror is a UX nicety — the server stays the security gate).
  static bool get spamShield => _b('spamShield', false);

  /// [AVA-RCPT-5/6/7] PSTN voicemail forwarding (Specs/PLAN-2026-07-16-ava
  /// -receptionist-guardian-FINAL.md, v1 = voicemail-only, everything else
  /// dark). Mirrors config.ts `pstnVoicemail`. While false: no reject/missed
  /// "expect" ping fires, the hidden-caller-ID auto-route in
  /// AvaCallScreeningService stays fail-open exactly as today, and the
  /// forwarding setup screen is hidden. Default false — this is a live-traffic
  /// PSTN feature and must be opted into per environment.
  static bool get pstnVoicemail => _b('pstnVoicemail', false);

  /// Max voicemail recording length in seconds (owner UX spec: greeting → beep
  /// → 25s recording → "Thank you" → hangup). Mirrors config.ts
  /// `pstnVoicemailRecordSec`. Informational on the device lane today (the
  /// Vobiz XML template that actually enforces it lives in the worker) — kept
  /// here so the forwarding setup screen can show the right expectation copy
  /// without a second flag round-trip.
  static int get pstnVoicemailRecordSec =>
      (_asNum(_cfg['pstnVoicemailRecordSec'])?.toInt()) ?? 25;

  /// [AVA-VM-PAID-1] Mirrors config.ts `pstnPaidConditionsUnlocked`. FALSE (the
  /// default and the launch state) = the "missed calls" and "declined / busy"
  /// forwarding conditions are a PAID upgrade: greyed, no "Turn on", green PAID
  /// pill — and one-time-cancelled at the carrier for users who already had them
  /// on. Only "phone off / unreachable" is free, because every forwarded call
  /// costs ~55 paisa (owner decision 2026-07-17).
  ///
  /// TRUE unlocks both for EVERYONE. This is a global switch, not a per-user
  /// entitlement — wire real billing before flipping it.
  static bool get pstnPaidConditionsUnlocked =>
      _b('pstnPaidConditionsUnlocked', false);

  static int get minAppBuild => (_asNum(_cfg['minAppBuild'])?.toInt()) ?? 0;

  /// The versionCode this install ACTUALLY carries, resolved once at [start]
  /// from PackageInfo. Falls back to the compile-time [kAppBuild] until then.
  ///
  /// [AVA-UPDATE-AUTO] This exists because comparing against `kAppBuild` was a
  /// live footgun. CI stamps the real versionCode with
  /// `--build-number=$((10000 + run_number))`, so every shipped build is ~10000+
  /// while the constant sits frozen at 28. That made [updateRequired] not merely
  /// wrong but DANGEROUS: the moment the owner set `minAppBuild` to a real CI
  /// build number to force an upgrade, `minAppBuild > 28` would be true on every
  /// device INCLUDING ones already running the newest build — bricking the whole
  /// user base behind an un-passable "please update" wall, with the only exit
  /// being a KV edit. Resolving the real number removes that trap.
  static int _installedBuild = kAppBuild;
  static int get installedBuild => _installedBuild;

  static Future<void> _resolveInstalledBuild() async {
    try {
      final n = int.tryParse((await PackageInfo.fromPlatform()).buildNumber);
      if (n != null && n > 0) {
        _installedBuild = n;
        revision.value++; // re-evaluate the gate with the true number
      }
    } catch (_) {/* keep the kAppBuild fallback */}
  }

  /// Installed build too old? → callers show the blocking "please update" screen.
  static bool get updateRequired => minAppBuild > _installedBuild;

  /// Newest build published to the store (KV `latestAppBuild`). When it is
  /// greater than the build the user actually has installed, [UpdateService]
  /// shows the dismissible "new version available" popup that opens the Google
  /// Play listing. 0 (default) = never prompt. Owner bumps this in KV per
  /// release. Distinct from [minAppBuild] (the hard, blocking floor).
  static int get latestAppBuild => (_asNum(_cfg['latestAppBuild'])?.toInt()) ?? 0;

  /// Kill switch for the automatic in-app update flow (the on-launch Play check,
  /// the background flexible download + auto-install, the "Update" sidebar row and
  /// the fallback popup — see core/update_service.dart). Default ON; set
  /// `inAppUpdateEnabled: false` in KV to stop every device update-checking.
  ///
  /// [AVA-UPDATE-AUTO] That KV flip only actually works as of 2026-07-15. This
  /// docstring previously promised it while the key was NOT declared in the
  /// Worker's `config.ts` DEFAULTS — and the PUT handler rejects any undeclared
  /// key with `unknown key` / 400. So the brake was documented but unusable: the
  /// client defaulted true and nothing could turn it off. The key is now declared
  /// server-side (default true), so the switch is real. If this ever regresses,
  /// the symptom is a 400 from `scripts/flags.sh set inAppUpdateEnabled=false`.
  static bool get inAppUpdateEnabled => _b('inAppUpdateEnabled', true);

  /// [AVAGRP-SEENBY-1 / AVAGRP-BUBBLE-2] Per-message group read/delivered
  /// receipts (the "Info" sheet seen-by data, chat_thread.dart's
  /// `_showMessageInfo`). Mirrors config.ts `groupReceiptsEnabled`, already
  /// declared in both `PlatformConfig` and `DEFAULTS` (config.ts:206/373) —
  /// this getter was the missing client half; without it the flag could be
  /// read on the server but never checked here, so the dark-launched receipt
  /// pipeline had no way to actually turn on. Default false (dark launch);
  /// flip `groupReceiptsEnabled: true` in KV once the per-message ingest +
  /// hydrate path (`sync_hub.dart` `_ingestMsgReceipt`, `group_dm.dart`
  /// `sendMsgReceipt`) is device-verified.
  static bool get groupReceiptsEnabled => _b('groupReceiptsEnabled', false);

  /// Fetch now + poll every 15 min. Never throws.
  static Future<void> start() async {
    // Paint the active account's cached admin flag first so admin-only surfaces
    // (Marketplace) render correctly on cold boot before the network probe lands.
    await _loadAdminCache();
    // [AVA-UPDATE-AUTO] Resolve the real versionCode BEFORE the first refresh, so
    // the minAppBuild gate never evaluates against the stale kAppBuild constant.
    await _resolveInstalledBuild();
    await refresh();
    // Resolve admin status alongside config so admin-only surfaces (Marketplace)
    // appear on this launch. Fire-and-forget: never blocks app start.
    unawaited(refreshAdmin());
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 15), (_) {
      refresh();
      refreshAdmin();
    });
  }

  /// Probe whether the active account is an admin (signed /admin/recon → 200).
  /// Bumps [revision] on change so drawers/menus re-evaluate [marketplaceVisible].
  /// Never throws. Call again after an account switch to re-resolve.
  static Future<void> refreshAdmin() async {
    final scope = AccountScope.id; // capture: an account switch may race this probe
    // [ADMIN-GATE] For an account NOT already known to be an admin, throttle the
    // /admin/recon probe to at most once/week. A known admin (_isAdmin, painted
    // from the scoped cache) is exempt and re-probes every cycle. A last-probe of
    // 0 (never probed on this account) always probes, so a real admin is still
    // discovered on first launch. Only a COMPLETED probe writes the timestamp, so
    // a transient network failure is retried next cycle rather than throttled.
    if (!_isAdmin) {
      int last = 0;
      try {
        last = int.tryParse(await DiskCache.read(_kAdminProbeAtKey) ?? '') ?? 0;
      } catch (_) {/* best-effort — treat as never-probed */}
      final now = DateTime.now().millisecondsSinceEpoch;
      if (last != 0 && now - last < _adminProbeThrottleMs) {
        Analytics.capture('admin_probe_skipped',
            {'account': scope ?? '', 'reason': 'throttled', 'age_ms': now - last});
        return;
      }
    }
    try {
      final was = _isAdmin;
      final v = await MoneyApi.isAdmin();
      // If the active account changed while the probe was in flight, a newer
      // switch owns the admin state now — discard this (stale) result so we never
      // write one account's admin flag into another's scoped cache.
      if (AccountScope.id != scope) return;
      _isAdmin = v;
      if (_isAdmin != was) revision.value++;
      // Persist per-account so the next switch to this account paints instantly.
      try { await DiskCache.write(_kAdminCache, v ? '1' : '0'); } catch (_) {/* best-effort */}
      // [ADMIN-GATE] Record the probe time so a non-admin result throttles the
      // next probe(s) to once/week (see _kAdminProbeAtKey).
      try {
        await DiskCache.write(_kAdminProbeAtKey, '${DateTime.now().millisecondsSinceEpoch}');
      } catch (_) {/* best-effort */}
      Analytics.capture('admin_probe', {'is_admin': v, 'account': scope ?? ''});
    } catch (e) {
      AvaLog.I.log('config', 'admin probe failed: $e');
    }
  }

  static Future<void> refresh() async {
    try {
      final res = await http
          .get(Uri.parse(kConfigUrl))
          .timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final m = jsonDecode(res.body);
        if (m is Map<String, dynamic>) {
          _cfg = m;
          // PERF-DNS-2 kill switch: let KV disable the DoH fallback if needed.
          AvaDns.dohEnabled = dohFallbackEnabled;
          // PartyKit realtime layer master switch (replaces Ably). Ships dark
          // until the PartyDO is deployed + this flag flipped on server-side.
          PartyHub.I.setEnabled(m['partyEnabled'] == true);
          revision.value++;
        }
      }
    } catch (e) {
      AvaLog.I.log('config', 'remote config fetch failed: $e');
    }
  }
}
