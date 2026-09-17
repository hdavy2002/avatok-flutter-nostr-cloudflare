import 'package:shared_preferences/shared_preferences.dart';

import '../account_storage.dart';
import 'video_quality_policy.dart';

/// Capture the account key synchronously, before any storage await. A pending
/// save from a departing account must never land in the next account's scope.
class VideoQualityPreferences {
  VideoQualityPreferences() : storageKey = scopedKey('video_quality_mode_v1');

  final String storageKey;
  Future<void> _writes = Future<void>.value();

  Future<VideoQualityMode> load() async {
    final prefs = await SharedPreferences.getInstance();
    return VideoQualityMode.fromStored(prefs.getString(storageKey));
  }

  Future<void> save(VideoQualityMode mode) {
    final write = _writes.then((_) async {
      final prefs = await SharedPreferences.getInstance();
      if (!await prefs.setString(storageKey, mode.name)) {
        throw StateError('Could not save video quality preference');
      }
    });
    _writes = write.catchError((Object _) {});
    return write;
  }
}
