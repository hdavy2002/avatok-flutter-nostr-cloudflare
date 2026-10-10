/// How urgent an app update is, from the build numbers in `/api/config` (`hfAppLatestBuild`,
/// `hfAppMinBuild`; 0 means never prompt). The banner and the blocking screen arrive in HF-NATIVE-12.
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
