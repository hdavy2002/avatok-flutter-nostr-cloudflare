import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/session.dart';

/// The remote flags this app reads from the public `GET /api/config`.
///
/// A flag that is off gives a calm "Coming soon" panel, never an error: the worker answers
/// `404 not_enabled` for those routes, and [ApiError.isNotEnabled] says so.
///
/// Every key here must be declared in the worker's config DEFAULTS (a flag the worker does not declare is a
/// FAKE flag that can never be flipped). `hfAppMinBuild` / `hfAppLatestBuild` arrive with HF-NATIVE-S7;
/// until then they read as 0 (never prompt).
class HfFlags {
  const HfFlags({
    required this.hostsPublicEnabled,
    required this.hfCallsEnabled,
    required this.hfTokensEnabled,
    required this.hostOnboardingEnabled,
    required this.hostKycEnabled,
    required this.hfPayoutsEnabled,
    required this.hfRefundsEnabled,
    required this.hfPushEnabled,
    required this.hfAppMinBuild,
    required this.hfAppLatestBuild,
  });

  final bool hostsPublicEnabled;
  final bool hfCallsEnabled;
  final bool hfTokensEnabled;
  final bool hostOnboardingEnabled;
  final bool hostKycEnabled;
  final bool hfPayoutsEnabled;
  final bool hfRefundsEnabled;
  final bool hfPushEnabled;
  final int hfAppMinBuild;
  final int hfAppLatestBuild;

  /// Used when `/api/config` cannot be reached and nothing is cached: every feature is assumed on, so
  /// screens still try, and the server is the authority (it answers `404 not_enabled` for a flag that is off).
  /// Build numbers are 0: never prompt for an update on a guess.
  static const HfFlags unknown = HfFlags(
    hostsPublicEnabled: true,
    hfCallsEnabled: true,
    hfTokensEnabled: true,
    hostOnboardingEnabled: true,
    hostKycEnabled: true,
    hfPayoutsEnabled: true,
    hfRefundsEnabled: true,
    hfPushEnabled: true,
    hfAppMinBuild: 0,
    hfAppLatestBuild: 0,
  );

  /// Everything off. For tests of the "Coming soon" panels.
  static const HfFlags allOff = HfFlags(
    hostsPublicEnabled: false,
    hfCallsEnabled: false,
    hfTokensEnabled: false,
    hostOnboardingEnabled: false,
    hostKycEnabled: false,
    hfPayoutsEnabled: false,
    hfRefundsEnabled: false,
    hfPushEnabled: false,
    hfAppMinBuild: 0,
    hfAppLatestBuild: 0,
  );

  factory HfFlags.fromJson(Map<String, dynamic> j) {
    bool b(String k) => j[k] == true;
    int n(String k) {
      final v = j[k];
      if (v is num) return v.toInt();
      return int.tryParse('$v') ?? 0;
    }

    return HfFlags(
      hostsPublicEnabled: b('hostsPublicEnabled'),
      hfCallsEnabled: b('hfCallsEnabled'),
      hfTokensEnabled: b('hfTokensEnabled'),
      hostOnboardingEnabled: b('hostOnboardingEnabled'),
      hostKycEnabled: b('hostKycEnabled'),
      hfPayoutsEnabled: b('hfPayoutsEnabled'),
      hfRefundsEnabled: b('hfRefundsEnabled'),
      hfPushEnabled: b('hfPushEnabled'),
      hfAppMinBuild: n('hfAppMinBuild'),
      hfAppLatestBuild: n('hfAppLatestBuild'),
    );
  }
}

const String _flagsCacheKey = 'hf.cache.config.v1';

/// `GET /api/config`, cached. Never errors: network failure falls back to the cached copy, then to
/// [HfFlags.unknown]. Read it with `ref.watch(flagsProvider)` and `valueOrNull`/`when`.
final flagsProvider = FutureProvider<HfFlags>((ref) async {
  final api = ref.watch(apiClientProvider);
  final cache = ref.watch(jsonCacheProvider);
  try {
    final json = await api.getJson('/api/config', auth: false);
    await cache.write(_flagsCacheKey, json);
    return HfFlags.fromJson(json);
  } catch (_) {
    final cached = await cache.read(_flagsCacheKey);
    final data = cached?.data;
    if (data is Map) return HfFlags.fromJson(Map<String, dynamic>.from(data));
    return HfFlags.unknown;
  }
});
