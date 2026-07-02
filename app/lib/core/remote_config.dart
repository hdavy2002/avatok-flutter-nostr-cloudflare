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
  /// FREE LAUNCH: no paywalls. When true, the whole client renders premium and
  /// no upgrade/metering UI shows. Mirrors KV `betaFreePremium`.
  static bool get betaFreePremium => _b('betaFreePremium', true);
  /// FREE LAUNCH: subscriptions/checkout off. When false, hide Subscribe/upgrade
  /// + wallet top-up entry points. Mirrors KV `billingEnabled`.
  static bool get billingEnabled => _b('billingEnabled', false);
  /// AI receptionist (Gemini Live) — ON for the free launch. Mirrors KV.
  static bool get receptionistEnabled => _b('receptionistEnabled', true);
  /// P1 call-reliability: gate the caller's Ava-takeover countdown on the server's
  /// ring-ack (incoming-call FCM push outcome). Ships dark (default OFF); flip in
  /// KV after a device test. Mirrors config.ts `receptTakeoverGuard`.
  static bool get receptTakeoverGuard => _b('receptTakeoverGuard', false);
  /// P4: require video-liveness verification before creating/publishing a listing.
  /// Ships dark (default OFF); flip ON at launch. Mirrors config.ts.
  static bool get listingLivenessGate => _b('listingLivenessGate', false);
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
  static int get minAppBuild => (_cfg['minAppBuild'] as num?)?.toInt() ?? 0;

  /// Installed build too old? → callers show the blocking "please update" screen.
  static bool get updateRequired => minAppBuild > kAppBuild;

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
