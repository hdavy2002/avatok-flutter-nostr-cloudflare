import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../analytics/analytics.dart';
import '../config/flags.dart';

/// How urgent an app update is, from the build numbers in `/api/config` (`hfAppLatestBuild`,
/// `hfAppMinBuild`; 0 means never prompt). The banner and the blocking screen are in `update_gate.dart`
/// (HF-NATIVE-12).
enum UpdateStatus {
  /// Up to date, or the numbers are unknown.
  none,

  /// A newer build exists: show the soft banner "A new version is ready".
  soft,

  /// The installed build is below the minimum: block with the update button.
  forced,
}

UpdateStatus updateStatusFor({required int installed, required int latest, required int min}) {
  if (installed <= 0) return UpdateStatus.none; // our own build is unknown: never nag on a guess
  if (min > 0 && installed < min) return UpdateStatus.forced;
  if (latest > 0 && installed < latest) return UpdateStatus.soft;
  return UpdateStatus.none;
}

/// The installed build number (Android versionCode), from package_info_plus through `Analytics.init`.
/// -1 until known. Tests override it.
final installedBuildProvider = Provider<int>((ref) => Analytics.appBuild);

/// What the update gate shows right now. While the installed build is unknown this never reads `/api/config`
/// (so it also starts no request in widget tests); while the config is loading or failed it is [UpdateStatus.none].
final updateStatusProvider = Provider<UpdateStatus>((ref) {
  final installed = ref.watch(installedBuildProvider);
  if (installed <= 0) return UpdateStatus.none;
  final flags = ref.watch(flagsProvider).when<HfFlags?>(
        data: (f) => f,
        loading: () => null,
        error: (_, __) => null,
      );
  if (flags == null) return UpdateStatus.none;
  return updateStatusFor(installed: installed, latest: flags.hfAppLatestBuild, min: flags.hfAppMinBuild);
});
