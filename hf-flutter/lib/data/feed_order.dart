import 'dart:io' show Platform;
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// [HF-REELS-FRESH-OPEN-1] Owner: "every time the Reels screen opens, there is a new video".
/// The server's first page is always in the same order, so the app shuffles that first page on
/// every open and never starts on the reel it started on last time. Later pages keep server order.
abstract final class FeedOrder {
  static const _key = 'hf_feed_last_first_v1';

  /// Widget tests keep the server order so their expectations stay stable.
  static bool enabled = !Platform.environment.containsKey('FLUTTER_TEST');
  static Random _rng = Random();

  static void setRandomForTest(Random r) => _rng = r;

  /// Shuffles [items] in place (by [idOf]) so the first one differs from the last open, then remembers it.
  static Future<void> freshStart<T>(List<T> items, String Function(T) idOf) async {
    if (!enabled || items.length < 2) return;
    String? last;
    SharedPreferences? prefs;
    try {
      prefs = await SharedPreferences.getInstance();
      last = prefs.getString(_key);
    } catch (_) {
      // storage unavailable: still shuffle
    }
    items.shuffle(_rng);
    if (last != null && idOf(items.first) == last) {
      final j = 1 + _rng.nextInt(items.length - 1);
      final t = items[0];
      items[0] = items[j];
      items[j] = t;
    }
    try {
      await prefs?.setString(_key, idOf(items.first));
    } catch (_) {
      // best effort
    }
  }
}
