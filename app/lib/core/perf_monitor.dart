import 'dart:ui' show FrameTiming;

import 'package:flutter/scheduler.dart';

import 'analytics.dart';

/// [UI-PERF-1] App-wide UI performance monitor.
///
/// Registers ONE `SchedulerBinding` timings callback and rolls raw per-frame
/// timings up into periodic `ui_frame_stats` events. It NEVER emits one event
/// per frame (that would be thousands/sec) — the per-frame callback only bumps
/// integer counters, and the (relatively) expensive `Analytics.capture` runs at
/// most once per [_flushEvery] or when the screen changes.
///
/// This is the first client-side jank/freeze signal in the app: it turns a
/// vague "the app feels laggy" into "chat_thread has 22% jank frames on build
/// 10446, worst 900ms" — sliceable in PostHog by `screen`, `build`, `release`,
/// and device (all added automatically by [Analytics].`_base`).
class PerfMonitor {
  PerfMonitor._();

  /// 60fps budget. A frame whose total span (build + raster) exceeds this
  /// missed the ~16.67ms window and is counted as jank.
  static const int _jankUs = 16667;
  /// ANR-class stall: a single frame this long is a visible freeze.
  static const int _freezeUs = 700000; // 700ms
  /// Max age of an aggregation window before it is flushed.
  static const Duration _flushEvery = Duration(seconds: 10);
  /// Emit an all-smooth (zero-jank) window only once it has at least this many
  /// frames, so a perfectly smooth session sends a sparse baseline instead of
  /// spamming identical zero rows.
  static const int _minSmoothFrames = 120;

  static bool _started = false;
  static int _frames = 0;
  static int _jank = 0;
  static int _freeze = 0;
  static int _worstUs = 0;
  static int _sumUs = 0;
  static DateTime _lastFlush = DateTime.now();
  static String? _windowScreen;

  /// Idempotent. Call once after `Analytics.init()` (post-first-frame).
  static void start() {
    if (_started) return;
    _started = true;
    _windowScreen = Analytics.currentScreen;
    try {
      SchedulerBinding.instance.addTimingsCallback(_onTimings);
    } catch (_) {/* never let telemetry setup break the app */}
  }

  static void _onTimings(List<FrameTiming> timings) {
    for (final t in timings) {
      final us = t.totalSpan.inMicroseconds;
      _frames++;
      _sumUs += us;
      if (us > _worstUs) _worstUs = us;
      if (us > _freezeUs) {
        _freeze++;
        _jank++; // a freeze is also a missed frame
      } else if (us > _jankUs) {
        _jank++;
      }
    }
    // Flush on a screen change (so a window's stats attribute to the screen the
    // frames were actually drawn on) or when the window is old enough. Only
    // counter comparisons here — no per-frame IO.
    final screenNow = Analytics.currentScreen;
    final rolled = screenNow != _windowScreen;
    final aged = DateTime.now().difference(_lastFlush) >= _flushEvery;
    if (_frames > 0 && (rolled || aged)) _flush(screenNow);
  }

  static void _flush(String? screenNow) {
    final frames = _frames;
    final jank = _jank;
    final freeze = _freeze;
    final worstUs = _worstUs;
    final sumUs = _sumUs;
    final windowScreen = _windowScreen;
    // Reset the window BEFORE the async capture so no frame is double-counted.
    _frames = 0;
    _jank = 0;
    _freeze = 0;
    _worstUs = 0;
    _sumUs = 0;
    _lastFlush = DateTime.now();
    _windowScreen = screenNow;
    if (frames <= 0) return;
    if (jank == 0 && frames < _minSmoothFrames) return; // skip tiny smooth windows
    Analytics.capture('ui_frame_stats', {
      // Explicit `screen` overrides _base's currentScreen so the window is
      // attributed to the screen its frames were drawn on, not the one we
      // just rolled onto.
      'screen': windowScreen ?? screenNow ?? 'unknown',
      'frames': frames,
      'jank_frames': jank,
      'freeze_frames': freeze,
      'jank_ratio': double.parse((jank / frames).toStringAsFixed(3)),
      'avg_frame_ms': double.parse((sumUs / frames / 1000).toStringAsFixed(1)),
      'worst_frame_ms': double.parse((worstUs / 1000).toStringAsFixed(1)),
    });
  }
}
