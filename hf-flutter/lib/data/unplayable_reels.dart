import 'package:shared_preferences/shared_preferences.dart';

/// [HF-REEL-SKIP-1] Reels that cannot play inside the app (Instagram "watch this reel in the app", no video in the embed,
/// YouTube embedding turned off by the uploader). The feed never shows them (owner 2026-10-22). Device-level, not per
/// account: whether a video can be embedded is a fact about the video, not about a person. Entries expire after
/// [keep] (an uploader can switch embedding back on) and the list is capped at [cap] (oldest dropped).
abstract final class UnplayableReels {
  static const _key = 'hf_unplayable_reels_v2'; // [HF-REEL-YT-ORIGIN-1] v1 held every YouTube reel (wrong-origin error 150)
  static const Duration keep = Duration(days: 14);
  static const int cap = 400;

  /// Reasons that mean "this video can never play here" (not a slow network or a hiccup).
  static const Set<String> permanentReasons = {
    'appOnly', // Instagram: watch this reel in the app
    'novideo', // Instagram embed has no video
    '100',
    '101',
    '150',
    '152',
    '153', // YouTube: removed / private / embedding off
  };

  static final Map<String, int> _ids = {};
  static bool _loaded = false;

  static bool contains(String id) => _ids.containsKey(id);

  static Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final e in p.getStringList(_key) ?? const <String>[]) {
        final i = e.lastIndexOf('|');
        if (i <= 0) continue;
        final at = int.tryParse(e.substring(i + 1)) ?? 0;
        if (now - at < keep.inMilliseconds) _ids[e.substring(0, i)] = at;
      }
    } catch (_) {
      // best effort: an empty list only means a bad reel may show once more
    }
  }

  static Future<void> mark(String id) async {
    if (id.isEmpty) return;
    _ids[id] = DateTime.now().millisecondsSinceEpoch;
    if (_ids.length > cap) {
      final oldest = _ids.entries.toList()
        ..sort((a, b) => a.value.compareTo(b.value));
      for (final e in oldest.take(_ids.length - cap)) {
        _ids.remove(e.key);
      }
    }
    try {
      final p = await SharedPreferences.getInstance();
      await p.setStringList(_key, [
        for (final e in _ids.entries) '${e.key}|${e.value}',
      ]);
    } catch (_) {
      // best effort
    }
  }

  /// Tests only.
  static void resetForTest() {
    _ids.clear();
    _loaded = false;
  }
}
