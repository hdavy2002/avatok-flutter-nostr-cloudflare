import 'dart:async';

import '../../../core/analytics.dart';

/// Liveness V3 — NO-DEAD-SCREENS WATCHDOG (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md §5, the P0 fix for the inert-camera bug that started this project).
///
/// Every stage arms a watchdog. If the stage makes NO progress for [timeout]
/// (default 10s), it fires [onDead] — the flow then shows a plain-language error
/// with Retry/Skip — and emits the `liveness_dead_screen` telemetry event. The
/// stage calls [poke] whenever anything advances (a coaching state change, a
/// challenge cleared, bytes uploaded), which resets the timer.
class StageWatchdog {
  StageWatchdog({
    required this.stage,
    required this.onDead,
    this.timeout = const Duration(seconds: 10),
  });

  /// Stage id for telemetry (e.g. 'language', 'intro', 'face_neck', 'upload').
  final String stage;

  /// Called once when no progress has happened for [timeout]. The flow renders the
  /// error + Retry/Skip UI. Fires AT MOST once until [rearm]/[poke] restarts it.
  final void Function() onDead;

  final Duration timeout;

  Timer? _timer;
  bool _fired = false;

  /// Start (or restart) the watchdog for this stage.
  void start() {
    _fired = false;
    _timer?.cancel();
    _timer = Timer(timeout, _fire);
  }

  /// Progress happened — reset the countdown. No-op after the watchdog has already
  /// fired (the flow is showing the error UI; the user must Retry/Skip).
  void poke() {
    if (_fired) return;
    _timer?.cancel();
    _timer = Timer(timeout, _fire);
  }

  /// Re-arm after the user tapped Retry.
  void rearm() => start();

  void _fire() {
    if (_fired) return;
    _fired = true;
    Analytics.capture('liveness_dead_screen', {'stage': stage, 'v': 3});
    onDead();
  }

  bool get hasFired => _fired;

  void cancel() {
    _timer?.cancel();
    _timer = null;
  }

  void dispose() => cancel();
}
