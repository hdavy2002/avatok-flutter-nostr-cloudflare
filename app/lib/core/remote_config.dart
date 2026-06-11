import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

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

  static bool get walletRealMoney => _b('walletRealMoney', false);
  static bool get donationsEnabled => _b('donationsEnabled', true);
  static bool get liveEnabled => _b('liveEnabled', true);
  static bool get consultEnabled => _b('consultEnabled', true);
  static bool get conferenceEnabled => _b('conferenceEnabled', true);
  static bool get brainEnabled => _b('brainEnabled', true);
  static bool get translationEnabled => _b('translationEnabled', true);
  static bool get translationGroupEnabled => _b('translationGroupEnabled', true);
  static bool get avavoiceEnabled => _b('avavoiceEnabled', true);
  /// AvaAffiliate (PROPOSAL-AVA-AFFILIATE) — default OFF until launch, so a
  /// config-fetch failure never advertises a program the Worker isn't serving.
  static bool get avaAffiliateEnabled => _b('avaAffiliateEnabled', false);
  /// v2 marketing-asset kit (Gemini Nano Banana 2 promo images) — default OFF.
  static bool get affiliateAssetKitEnabled => _b('affiliateAssetKitEnabled', false);
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
          revision.value++;
        }
      }
    } catch (e) {
      AvaLog.I.log('config', 'remote config fetch failed: $e');
    }
  }
}
