import 'dart:async';

import 'package:flutter/widgets.dart';

import 'analytics.dart';

/// Detects event-loop stalls that frame timings cannot see (for example a
/// plugin blocking the main thread before Flutter can schedule a frame).
/// A delayed timer fires immediately after recovery and reports the measured
/// gap, current screen and most recent named interaction to PostHog.
class UiFreezeMonitor with WidgetsBindingObserver {
  UiFreezeMonitor._();

  static final UiFreezeMonitor I = UiFreezeMonitor._();
  static const _tick = Duration(milliseconds: 250);
  static const _freezeThresholdMs = 700;

  Timer? _timer;
  DateTime _expected = DateTime.now();
  bool _foreground = true;
  int _sequence = 0;

  void start() {
    if (_timer != null) return;
    WidgetsBinding.instance.addObserver(this);
    _expected = DateTime.now().add(_tick);
    _timer = Timer.periodic(_tick, (_) => _onTick());
  }

  void _onTick() {
    final now = DateTime.now();
    final stallMs = now.difference(_expected).inMilliseconds;
    _expected = now.add(_tick);
    if (!_foreground || stallMs < _freezeThresholdMs) return;

    final actionAt = Analytics.lastInteractionAtMs;
    Analytics.capture('ui_freeze_recovered', {
      'freeze_id': '${now.millisecondsSinceEpoch}-${++_sequence}',
      'stall_ms': stallMs,
      'screen': Analytics.currentScreen ?? 'unknown',
      if (Analytics.lastInteractionName != null)
        'last_interaction': Analytics.lastInteractionName!,
      if (actionAt != null) 'ms_since_interaction': now.millisecondsSinceEpoch - actionAt,
      'detector': 'event_loop_watchdog',
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _expected = DateTime.now().add(_tick);
  }
}
