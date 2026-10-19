import 'package:shared_preferences/shared_preferences.dart';

/// Remembers that the two intro screens were seen, so they show only on the first open.
/// Device-level (not per account): the intro is about the app, not a person.
abstract final class IntroStore {
  static const _key = 'hf_intro_seen_v1';

  /// False when never seen, or when storage is unavailable (a repeat of the intro is harmless).
  static Future<bool> read() async {
    try {
      final p = await SharedPreferences.getInstance();
      return p.getBool(_key) ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> markSeen() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_key, true);
    } catch (_) {
      // best effort
    }
  }
}
