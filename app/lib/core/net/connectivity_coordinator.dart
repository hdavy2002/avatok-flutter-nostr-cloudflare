import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

import '../analytics.dart';
import '../ava_log.dart';

/// The five deterministic connectivity states (spec row #14 / B8).
///
/// OFFLINE     — no transport (all connectivity_plus results are `none`).
/// CONNECTING  — transport is up but the hub socket is not (first connect).
/// CONNECTED   — the hub socket is up and receiving frames.
/// DEGRADED    — transport up but the socket keeps flapping (N drops within
///               M minutes); stays degraded until a stable window passes.
/// RECOVERING  — we were CONNECTED, the socket dropped, transport is still up
///               and we're re-establishing (distinct from the cold CONNECTING).
enum NetState { offline, connecting, connected, degraded, recovering }

/// [NET-COORD-1] ConnectivityCoordinator — docs nickname **"NetBrain"**.
///
/// Spec: `Specs/DETERMINISTIC-CORE-ARCH.md` row #14 (Network Brain), Phase B item
/// B8. The v1.3 rename made `ConnectivityCoordinator` the CODE identifier;
/// "Network Brain / NetBrain" stays as the docs nickname.
///
/// ONE device-level singleton that fuses three signals into ONE deterministic
/// connectivity state so that SyncHub, Outbox, CallSession, uploads and presence
/// stop running competing private reconnect storms and instead REACT to a single
/// source of truth (Sat's telemetry showed those storms are hurting today).
///
/// Signals in:
///  1. `connectivity_plus` transport up/down (wifi/cell/ethernet vs none).
///  2. The hub socket state — SyncHub calls [reportSocketUp]/[reportSocketDown].
///  3. App lifecycle resume — [onAppResumed] nudges a re-evaluation.
///
/// Deterministic rules (no wall-clock merge decisions; only elapsed-time windows
/// for flap detection, which is allowed for backoff/GC per the arch rules):
///  - transport down                        → OFFLINE
///  - transport up, socket down, never connected this session → CONNECTING
///  - transport up, socket down, was connected               → RECOVERING
///  - socket up                                              → CONNECTED
///  - >= [_flapThreshold] socket drops within [_flapWindow]  → DEGRADED
///    (holds until [_stableWindow] of continuous CONNECTED elapses)
///
/// PER-ACCOUNT SCOPING: intentionally NONE. The network is a DEVICE property, not
/// an account property (per the rulebook, only per-USER state needs `scopedKey`);
/// a parent and child sharing one phone share one radio, so this singleton stays
/// device-level and is never torn down on account switch.
class ConnectivityCoordinator {
  static final ConnectivityCoordinator I = ConnectivityCoordinator._();
  ConnectivityCoordinator._();

  // Flap detection: this many socket drops inside this window while transport is
  // up flips us to DEGRADED, which then holds until a stable connected window.
  static const int _flapThreshold = 3;
  static const Duration _flapWindow = Duration(minutes: 2);
  static const Duration _stableWindow = Duration(minutes: 1);

  final ValueNotifier<NetState> state = ValueNotifier<NetState>(NetState.offline);
  final _changes = StreamController<NetState>.broadcast();

  /// State transitions (broadcast). Subscribers react to ONE state instead of
  /// each running its own reconnect loop.
  Stream<NetState> get changes => _changes.stream;

  /// Convenience: true when we believe the device can reach the server.
  bool get online =>
      state.value == NetState.connected ||
      state.value == NetState.recovering ||
      state.value == NetState.degraded;

  bool _started = false;
  StreamSubscription? _transportSub;

  bool _transportUp = false;   // last known connectivity_plus verdict
  bool _socketUp = false;      // last hub-socket signal
  bool _everConnected = false; // any CONNECTED this session → RECOVERING vs CONNECTING

  final List<int> _drops = []; // epoch-ms of recent socket drops (flap window)
  bool _degradedLatch = false; // holds DEGRADED until a stable window passes
  Timer? _stableTimer;

  int _stateSince = DateTime.now().millisecondsSinceEpoch; // for time_in_prev_state_ms

  /// Idempotent. Starts the transport listener and seeds the initial state.
  void start() {
    if (_started) return;
    _started = true;
    try {
      Connectivity().checkConnectivity().then(_applyTransport).catchError((_) {});
      _transportSub =
          Connectivity().onConnectivityChanged.listen(_applyTransport, onError: (_) {});
    } catch (_) {/* transport dimension stays down; socket signals still drive us */}
    _recompute('start');
  }

  void _applyTransport(List<ConnectivityResult> rs) {
    final up = rs.isNotEmpty && rs.any((r) => r != ConnectivityResult.none);
    if (up == _transportUp) return;
    _transportUp = up;
    _recompute(up ? 'transport_up' : 'transport_down');
  }

  /// SyncHub reports its socket came up (a live InboxDO connection). SyncHub keeps
  /// its own reconnect loop for now — it just FEEDS this signal in.
  void reportSocketUp() {
    if (_socketUp) return;
    _socketUp = true;
    _everConnected = true;
    _recompute('socket_up');
  }

  /// SyncHub reports its socket went down. Records a drop for flap detection.
  void reportSocketDown() {
    if (!_socketUp) return;
    _socketUp = false;
    final now = DateTime.now().millisecondsSinceEpoch;
    _drops.add(now);
    _drops.removeWhere((t) => now - t > _flapWindow.inMilliseconds);
    if (_transportUp && _drops.length >= _flapThreshold) {
      _degradedLatch = true; // held until a stable connected window elapses
    }
    _recompute('socket_down');
  }

  /// App returned to the foreground — re-evaluate (the socket may have died
  /// half-open while backgrounded; SyncHub will report the real socket state).
  void onAppResumed() {
    if (!_started) return;
    _recompute('resume');
  }

  NetState _derive() {
    if (!_transportUp) return NetState.offline;
    if (_socketUp) return _degradedLatch ? NetState.degraded : NetState.connected;
    // transport up, socket down:
    if (_degradedLatch) return NetState.degraded;
    return _everConnected ? NetState.recovering : NetState.connecting;
  }

  void _recompute(String cause) {
    final next = _derive();

    // A stable CONNECTED window clears the degraded latch. Arm a one-shot timer
    // while genuinely connected; any drop cancels it (re-added below on the next
    // socket_down). This is the ONLY timer here and it's a stability window, not a
    // wall-clock merge decision.
    if (next == NetState.connected) {
      _stableTimer ??= Timer(_stableWindow, () {
        _stableTimer = null;
        if (_socketUp && _transportUp && _degradedLatch) {
          _degradedLatch = false;
          _recompute('stable_window'); // may drop DEGRADED → CONNECTED
        }
      });
    } else {
      _stableTimer?.cancel();
      _stableTimer = null;
    }

    if (next == state.value) return;
    final prev = state.value;
    final now = DateTime.now().millisecondsSinceEpoch;
    final inPrev = now - _stateSince;
    _stateSince = now;
    state.value = next;
    if (!_changes.isClosed) _changes.add(next);
    AvaLog.I.log('netbrain', '${prev.name} → ${next.name} ($cause)');
    // Fire-and-forget telemetry on every transition. Per-account email/platform
    // already ride every event via Analytics._base; 'transport' distinguishes
    // cellular from wifi/other (Analytics owns the raw net dimension privately, so
    // we surface the one bit it exposes rather than duplicating its listener).
    Analytics.capture('netbrain_${next.name}', {
      'from': prev.name,
      'time_in_prev_state_ms': inPrev,
      'transport': _transportUp ? (Analytics.isCellular ? 'cell' : 'wifi_or_other') : 'offline',
      'cause': cause,
    });
  }
}
