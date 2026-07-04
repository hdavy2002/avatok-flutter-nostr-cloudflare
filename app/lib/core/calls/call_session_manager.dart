import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../analytics.dart';
import '../voice/native_voice_audio.dart';
import 'call_session.dart';

/// App-level singleton that owns the current [CallSession] so a 1:1 call
/// survives in-app navigation and backgrounding. A [WidgetsBindingObserver]:
/// on `paused` with an active session it ensures the foreground service is
/// running and keeps the WS alive (no teardown, no video-capture stop); on
/// `resumed` it re-syncs and fires background-survival telemetry.
///
/// The one true owner is the [CallSession]; the manager only routes and
/// observes. See Specs/CALL-SESSION-API.md.
class CallSessionManager with WidgetsBindingObserver {
  CallSessionManager._();
  static final CallSessionManager instance = CallSessionManager._();

  final ValueNotifier<CallSession?> _active = ValueNotifier<CallSession?>(null);
  ValueListenable<CallSession?> get active => _active;
  CallSession? get current => _active.value;

  bool _observing = false;
  // Tracks whether the active call was backgrounded while connected, so we can
  // fire call_bg_survived exactly once on the next resume if it's still alive.
  bool _backgroundedWhileConnected = false;

  /// Register as a lifecycle observer. Call once from main().
  void register() {
    if (_observing) return;
    _observing = true;
    WidgetsBinding.instance.addObserver(this);
  }

  /// Get-or-create the session for [config]. Called from CallScreen.initState.
  /// Re-entry after minimize→reopen returns the SAME session without restarting.
  /// This is the only path that creates a [CallSession].
  CallSession attach(CallSessionConfig config) {
    final existing = _active.value;
    if (existing != null && !existing.isEnded && existing.room == config.room) {
      return existing;
    }
    final session = CallSession(config);
    _active.value = session;
    // ignore: unawaited_futures
    session.start();
    // When the session tears down, drop it from `active`.
    void watch() {
      if (session.phase.value == CallPhase.ended) {
        session.phase.removeListener(watch);
        if (_active.value == session) _active.value = null;
      }
    }
    session.phase.addListener(watch);
    return session;
  }

  /// End the current session (if any) via the single teardown path.
  Future<void> hangupActive(String reason) async {
    final s = _active.value;
    if (s == null) return;
    await s.hangup(reason);
    if (_active.value == s) _active.value = null;
  }

  /// End every live session (there is at most one 1:1 today). Called on account
  /// switch / logout via clearCallState().
  Future<void> destroyAll() async {
    final s = _active.value;
    if (s != null && !s.isEnded) {
      try { await s.hangup('account-switch'); } catch (_) {}
    }
    _active.value = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final s = _active.value;
    if (s == null || s.isEnded) return;
    if (state == AppLifecycleState.paused) {
      // Keep the call alive in the background: ensure the FGS is running (it was
      // started at call setup, but re-assert it defensively) and keep the WS +
      // video capture untouched so the reviewer sees media still flowing.
      if (NativeVoiceAudio.isSupported) {
        try {
          NativeVoiceAudio().startCallForegroundService(
            callId: s.room,
            peerName: s.config.title,
          );
        } catch (_) {}
      }
      if (s.isConnected) _backgroundedWhileConnected = true;
      Analytics.capture('call_backgrounded', {
        'call_id': s.room,
        'connected': s.isConnected,
        'video': s.video,
      });
    } else if (state == AppLifecycleState.resumed) {
      // Re-sync the UI (renderers already hold their streams).
      Analytics.capture('call_restored', {
        'call_id': s.room,
        'connected': s.isConnected,
        'video': s.video,
      });
      if (_backgroundedWhileConnected && s.isConnected) {
        Analytics.capture('call_bg_survived', {
          'call_id': s.room,
          'video': s.video,
          'elapsed_s': s.secs,
        });
      }
      _backgroundedWhileConnected = false;
    }
  }
}
