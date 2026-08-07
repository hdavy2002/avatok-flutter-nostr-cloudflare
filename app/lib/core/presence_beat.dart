import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleState, WidgetsBinding;

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'config.dart';
import 'remote_config.dart';
import '../push/push_service.dart' show DeviceId;

/// [CALL-PRESENCE-1 2026-08-07] "I'm here."
///
/// WHAT THIS FIXES. Until now AvaTOK had no heartbeat at all. The only signal
/// that a callee was reachable was the call ring itself: `/api/call` broadcast
/// into the callee's InboxDO and read back whether a socket accepted it — a fact
/// discovered ~3.6 s into placing a call, and then discarded. On 2026-08-07 that
/// answer came back `live:false` at +3.6 s (the server KNEW the callee was
/// offline) and the caller was still made to wait until +28 s for Ava.
///
/// The obvious objection is "the app already pings the socket every 25 s". It
/// does, and it proves nothing to anybody: [WS-AUTORESP-1] has the Durable
/// Object runtime answer that ping from its hibernation auto-response, so the DO
/// is never woken and no state is refreshed. That design is correct (~3,456
/// avoided wakes/day/user) and is not being undone — this beat is a separate,
/// cheap HTTP write that goes to a store `/api/call` can read in one lookup.
///
/// EVERY CALL SITE IS FIRE-AND-FORGET. A heartbeat must never delay a socket
/// ping, an app resume, or the handling of an incoming push. Nothing here is
/// awaited by its callers and nothing here can throw into them.
class PresenceBeat {
  PresenceBeat._();

  static int _lastBeatMs = 0;
  static bool _inFlight = false;

  /// Epoch ms of the last successful beat (0 = never). Exposed for telemetry.
  static int get lastBeatMs => _lastBeatMs;

  /// Send a beat, unless one is already in flight or one was sent very recently.
  ///
  /// [source] is why we are beating: 'ws_connect' | 'ping' | 'resume' | 'push'.
  /// [force] skips the cadence check — used by the event-driven sources (connect,
  /// resume, push), because those are exactly the moments where an up-to-date
  /// presence record changes a routing decision. The periodic 'ping' source does
  /// NOT force, so it self-throttles to `presenceHeartbeatSec`.
  static void beat(String source, {bool force = false}) {
    unawaited(_send(source, force: force));
  }

  static Future<void> _send(String source, {bool force = false}) async {
    if (!RemoteConfig.callPresenceRouting) return;
    if (_inFlight) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final sinceLast = _lastBeatMs == 0 ? -1 : now - _lastBeatMs;
    if (!force && _lastBeatMs != 0) {
      // Cadence is server-driven so it can be retuned from KV without a build.
      final minGapMs = RemoteConfig.presenceHeartbeatSec * 1000;
      if (sinceLast < minGapMs - 2000) return; // 2s slack for timer jitter
    }
    _inFlight = true;
    try {
      final deviceId = await DeviceId.get();
      final res = await ApiAuth.postJson(
        kPresenceBeatUrl,
        {
          'source': source,
          'app_state': _appState(),
          'device_id': deviceId,
          'ms_since_last': sinceLast,
        },
        timeout: const Duration(seconds: 6),
      );
      if (res.statusCode == 200) {
        _lastBeatMs = now;
      } else {
        // Not an error worth a user-visible anything — presence fails OPEN on the
        // server (unknown presence rings exactly as it always did). Recorded so a
        // silently-dead heartbeat is visible in PostHog rather than showing up
        // later as "why did nobody get routed to Ava".
        Analytics.capture('presence_beat_failed', {
          'source': source,
          'status': res.statusCode,
          'ms_since_last': sinceLast,
        });
      }
    } catch (e) {
      // warn, not log: non-info AvaLog lines are forwarded to PostHog Logs
      // (CLAUDE.md observability rules), and a heartbeat that has stopped
      // reaching the server is exactly the thing we must not discover later.
      AvaLog.I.warn('presence', 'beat($source) failed: $e');
    } finally {
      _inFlight = false;
    }
  }

  /// Foreground/background at beat time. The server stores it so a stale record
  /// can be read as "backgrounded and dozing" rather than "gone".
  static String _appState() {
    try {
      final s = WidgetsBinding.instance.lifecycleState;
      if (s == AppLifecycleState.resumed) return 'foreground';
      if (s == null) return 'unknown';
      return 'background';
    } catch (_) {
      return 'unknown';
    }
  }

  /// Test/logout seam — a new account must not inherit the previous one's
  /// throttle window.
  static void reset() {
    _lastBeatMs = 0;
    _inFlight = false;
  }
}
