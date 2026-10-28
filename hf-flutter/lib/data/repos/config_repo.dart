import '../api_client.dart';

/// How urgent an app update is.
enum UpdateStatus {
  /// Up to date, or the numbers are unknown.
  none,

  /// A newer build exists: ask, but let the person carry on.
  soft,

  /// The installed build is below the minimum: block until updated.
  forced,
}

/// The slice of the public `GET /api/config` the app needs at start.
/// `hfAppMinBuild` / `hfAppLatestBuild` are declared in worker/src/routes/config.ts; 0 means never prompt.
class AppConfig {
  const AppConfig({
    this.minBuild = 0,
    this.latestBuild = 0,
    this.bookingApprovalEnabled = false,
    this.callModesEnabled = false,
    this.callQueueEnabled = false,
    this.callChunkBillingEnabled = false,
    this.bookingLengthsEnabled = false,
    this.introOnboardingEnabled = false,
    this.facebookLoginEnabled = false,
  });

  /// [HF-INTRO-A1] `hfIntroOnboardingEnabled` (the in-app intro-video onboarding) and `hfFacebookLoginEnabled` ("Log in with Facebook").
  /// Each is true only when the server says exactly `true`.
  final bool introOnboardingEnabled;
  final bool facebookLoginEnabled;

  /// [HF-CALL-MODES-E2] `hfCallModesEnabled`, `hfCallQueueEnabled`, `hfCallChunkBillingEnabled`, `hfBookingLengthsEnabled`.
  /// Each is true only when the server says exactly `true`.
  final bool callModesEnabled;
  final bool callQueueEnabled;
  final bool callChunkBillingEnabled;
  final bool bookingLengthsEnabled;

  final int minBuild;
  final int latestBuild;

  /// [HF-BOOK-APPROVE] `hfBookingApprovalEnabled`: bookings can wait for the influencer to accept them. Off unless the server says true.
  final bool bookingApprovalEnabled;

  factory AppConfig.fromJson(Map<String, dynamic> j) => AppConfig(
        minBuild: _int(j['hfAppMinBuild']),
        latestBuild: _int(j['hfAppLatestBuild']),
        bookingApprovalEnabled: j['hfBookingApprovalEnabled'] == true,
        callModesEnabled: j['hfCallModesEnabled'] == true,
        callQueueEnabled: j['hfCallQueueEnabled'] == true,
        callChunkBillingEnabled: j['hfCallChunkBillingEnabled'] == true,
        bookingLengthsEnabled: j['hfBookingLengthsEnabled'] == true,
        introOnboardingEnabled: j['hfIntroOnboardingEnabled'] == true,
        facebookLoginEnabled: j['hfFacebookLoginEnabled'] == true,
      );

  static int _int(Object? v) {
    if (v is num) return v.toInt();
    return int.tryParse((v ?? '').toString()) ?? 0;
  }

  /// [installed] is the Android versionCode; 0 or less means unknown, so never nag on a guess.
  UpdateStatus updateStatusFor(int installed) {
    if (installed <= 0) return UpdateStatus.none;
    if (minBuild > 0 && installed < minBuild) return UpdateStatus.forced;
    if (latestBuild > 0 && installed < latestBuild) return UpdateStatus.soft;
    return UpdateStatus.none;
  }
}

class ConfigRepo {
  const ConfigRepo(this._api);

  final ApiClient _api;

  /// Public route: no sign-in needed.
  Future<AppConfig> fetch() async => AppConfig.fromJson(await _api.getJson('/api/config', auth: false, store: true));

  /// [HF-APP-CACHE-1] The config this phone saw last (up to 30 days old), or null.
  Future<AppConfig?> cached() async {
    final j = await _api.peekJson('/api/config', auth: false, maxAge: const Duration(days: 30));
    return j == null ? null : AppConfig.fromJson(j);
  }
}
