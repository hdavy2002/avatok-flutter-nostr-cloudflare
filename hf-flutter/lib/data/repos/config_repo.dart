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
  const AppConfig({this.minBuild = 0, this.latestBuild = 0});

  final int minBuild;
  final int latestBuild;

  factory AppConfig.fromJson(Map<String, dynamic> j) =>
      AppConfig(minBuild: _int(j['hfAppMinBuild']), latestBuild: _int(j['hfAppLatestBuild']));

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
  Future<AppConfig> fetch() async => AppConfig.fromJson(await _api.getJson('/api/config', auth: false));
}
