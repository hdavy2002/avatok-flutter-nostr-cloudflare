import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../sync/party/party_hub.dart';
import 'ava_log.dart';
import 'config.dart';
import 'feature_flags.dart';

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
  /// CF Realtime SFU group-audio path — dormant until its build lands + is
  /// CI/device-verified. While false, group calls use the existing LiveKit path.
  static bool get groupAudioSfuEnabled => _b('groupAudioSfuEnabled', false);
  static bool get brainEnabled => _b('brainEnabled', false);
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
  /// STREAM H (AI Messenger Batch): onboarding "human check" hard gate. When ON,
  /// every account must pass liveness the moment it's created (D12) and existing
  /// unverified users are redirected on app open (D13, non-dismissible). Server
  /// enforcement (bypass-proof) mirrors this via authz.requireLiveness. Ships dark
  /// (default OFF); flip ON in KV platform_config.livenessOnboardingGate.
  static bool get livenessOnboardingGate => _b('livenessOnboardingGate', false);
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
  /// AvaMarketplace (buy/sell/social + agent negotiation, Specs/AVAMARKETPLACE-
  /// FINAL-PROPOSAL.md). Default OFF so the feature stays dark after a config
  /// fetch failure and during phased rollout — flip `marketplaceEnabled: true`
  /// in KV `platform_config` to surface the Marketplace menu + agent calls.
  static bool get marketplaceEnabled => _b('marketplaceEnabled', false);
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
  static int get minAppBuild => (_asNum(_cfg['minAppBuild'])?.toInt()) ?? 0;

  /// Installed build too old? → callers show the blocking "please update" screen.
  static bool get updateRequired => minAppBuild > kAppBuild;

  /// Kill switch for the Google Play in-app update flow (the "Update" sidebar row
  /// + the on-launch "new version available" popup). Default ON; flip to false in
  /// KV to silence all Play update checks (e.g. if they ever get noisy).
  static bool get inAppUpdateEnabled => _b('inAppUpdateEnabled', true);

  /// Fetch now + poll every 15 min. Never throws.
  static Future<void> start() async {
    await refresh();
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 15), (_) => refresh());
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
