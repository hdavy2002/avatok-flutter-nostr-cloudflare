// Phase 5 (A2) — server clock skew. Device clocks lie; every countdown
// (reminders, waiting-room, "starts in …") must use server time. GET /api/time
// once at app start (public, unauthenticated); skew = serverNow - deviceNow.
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'config.dart';

class TimeSync {
  /// serverNow - deviceNow, in ms. 0 until [init] succeeds (best-effort).
  static int clockSkewMs = 0;
  static bool _done = false;

  /// Call once at app start (fire-and-forget). Cheap; refreshes on re-call.
  static Future<void> init() async {
    try {
      final t0 = DateTime.now().millisecondsSinceEpoch;
      final r = await http.get(Uri.parse(kTimeUrl)).timeout(const Duration(seconds: 5));
      final t1 = DateTime.now().millisecondsSinceEpoch;
      if (r.statusCode == 200) {
        final server = (jsonDecode(r.body)['now'] as num).toInt();
        // Midpoint compensation for network latency.
        clockSkewMs = server - ((t0 + t1) ~/ 2);
        _done = true;
      }
    } catch (_) {/* keep 0 — device time fallback */}
  }

  static bool get synced => _done;

  /// Server-corrected "now" — use for every countdown and time comparison.
  static DateTime now() =>
      DateTime.now().add(Duration(milliseconds: clockSkewMs));
  static int nowMs() => DateTime.now().millisecondsSinceEpoch + clockSkewMs;
}
