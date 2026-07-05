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

  // [CALL-DUP-SESSION-1] Registry of LIVE (non-ended) sessions keyed by room
  // (== callId). WHY: `_active` is a single slot and is populated only after the
  // route's initState → attach() → start() chain runs. A second accept/restore/
  // FGS-notification-tap path that fires in that same-frame window used to see
  // `_active.value == null`, construct a SECOND CallSession, and open a THIRD WS
  // to the CallRoom DO — the room's 2-peer cap busy-rejected it, and the busy
  // teardown fanned out cancel/ended pushes that killed the genuine live call
  // (PostHog calls avatok-cdcc815d / avatok-23692246). This map is written
  // SYNCHRONOUSLY inside attach() BEFORE start(), so any concurrent attach for
  // the same room in the same microtask returns the already-registered session
  // instead of building a new one. Covers ALL construction paths, not just push.
  final Map<String, CallSession> _byRoom = <String, CallSession>{};

  /// [CALL-DUP-SESSION-1] Is there a live (non-ended) session for [room]?
  /// Used by accept/restore paths to re-attach instead of starting a new flow.
  bool hasLiveSession(String room) {
    final s = _byRoom[room];
    return s != null && !s.isEnded;
  }

  /// [CALL-DUP-SESSION-1] The live session for [room], or null. Lets a duplicate
  /// teardown check whether ANOTHER live session owns the room before it fans
  /// out any bye/cancel/ended signalling.
  CallSession? liveSessionFor(String room) {
    final s = _byRoom[room];
    return (s != null && !s.isEnded) ? s : null;
  }

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
    // [CALL-DUP-SESSION-1] Idempotent acquisition keyed by room (== callId).
    // Check the keyed registry FIRST (not just `_active`): a live session for
    // this exact room — regardless of whether it is the one currently in
    // `_active` — MUST be returned as-is. This is the primary guard against a
    // duplicate accept/restore path opening a second CallRoom WS as a 3rd peer.
    final live = _byRoom[config.room];
    if (live != null && !live.isEnded) {
      Analytics.capture('call_dup_session_blocked', {
        'call_id': config.room,
        'via': 'manager_attach',
      });
      // Re-assert it as the active session (a restore path may attach while a
      // different/ended session momentarily sits in `_active`).
      if (_active.value != live) _active.value = live;
      return live;
    }
    final existing = _active.value;
    if (existing != null && !existing.isEnded && existing.room == config.room) {
      _byRoom[config.room] = existing;
      return existing;
    }
    final session = CallSession(config);
    // [CALL-DUP-SESSION-1] Teach this session how to tell whether ANOTHER live
    // session already owns its room on this device. Belt-and-braces with the
    // attach() dedup above: if a duplicate leg ever does slip through (e.g. a
    // legacy direct construction path), it stays inert — its busy/receptionist/
    // cancel/ended fan-out is suppressed so it can never kill the real call.
    session.anotherLiveSessionOwnsRoom = () {
      final other = _byRoom[config.room];
      return other != null && other != session && !other.isEnded;
    };
    // Register SYNCHRONOUSLY before start()/anything async so a concurrent
    // attach for the same room in this microtask sees it and dedups.
    _byRoom[config.room] = session;
    _active.value = session;
    // When the session tears down, drop it from `active` AND the registry.
    void watch() {
      if (session.phase.value == CallPhase.ended) {
        session.phase.removeListener(watch);
        if (_active.value == session) _active.value = null;
        if (_byRoom[config.room] == session) _byRoom.remove(config.room);
      }
    }
    session.phase.addListener(watch);
    // ignore: unawaited_futures
    session.start();
    return session;
  }

  /// End the current session (if any) via the single teardown path.
  Future<void> hangupActive(String reason) async {
    final s = _active.value;
    if (s == null) return;
    await s.hangup(reason);
    if (_active.value == s) _active.value = null;
    // [CALL-DUP-SESSION-1] Drop it from the keyed registry too.
    _byRoom.removeWhere((_, v) => v == s || v.isEnded);
  }

  /// End every live session (there is at most one 1:1 today). Called on account
  /// switch / logout via clearCallState().
  Future<void> destroyAll() async {
    final s = _active.value;
    if (s != null && !s.isEnded) {
      try { await s.hangup('account-switch'); } catch (_) {}
    }
    // [CALL-DUP-SESSION-1] Tear down any stragglers in the registry, then clear.
    for (final other in List<CallSession>.of(_byRoom.values)) {
      if (other == s || other.isEnded) continue;
      try { await other.hangup('account-switch'); } catch (_) {}
    }
    _byRoom.clear();
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
          // Use the shared singleton (not a fresh instance) so the method-channel
          // handler carrying the notification callbacks is not stolen (CALL-BG-INT1).
          NativeVoiceAudio.instance.startCallForegroundService(
            callId: s.room,
            peerName: s.config.title,
            isVideo: s.video,
            at: 'accept',
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
