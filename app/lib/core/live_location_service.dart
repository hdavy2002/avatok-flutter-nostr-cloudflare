import 'dart:async';

import 'package:geolocator/geolocator.dart';

import 'ava_log.dart';

/// Sender-side engine for a single WhatsApp-style live-location share.
///
/// Streams the device GPS (high accuracy, 10 m distance filter) and calls
/// [onTick] every time the user moves, plus a 15 s heartbeat so a *stationary*
/// sender still keeps the receiver's "live" status fresh. Auto-stops at
/// [untilEpoch] (the share window the user picked) or when [stop] is called.
///
/// It owns NO transport: the chat thread wires [onTick] to the ephemeral
/// presence WebSocket (so high-frequency fixes are NOT persisted per-tick into
/// the InboxDO message log) and to PostHog telemetry. [onEnd] fires exactly once.
class LiveLocationBroadcaster {
  final String id;
  final int untilEpoch; // epoch seconds when the share ends
  final void Function(double lat, double lng, double? heading, double? speed)
      onTick;
  final void Function(String reason) onEnd;

  StreamSubscription<Position>? _sub;
  Timer? _stopTimer;
  Timer? _heartbeat;
  Position? _last;
  bool _stopped = false;

  LiveLocationBroadcaster({
    required this.id,
    required this.untilEpoch,
    required this.onTick,
    required this.onEnd,
  });

  String get _shortId => id.length >= 8 ? id.substring(0, 8) : id;

  void start() {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final secs = (untilEpoch - now).clamp(1, 12 * 3600);
    _stopTimer = Timer(Duration(seconds: secs), () => stop('expired'));

    try {
      _sub = Geolocator.getPositionStream(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: 10, // metres moved before a new fix is emitted
        ),
      ).listen(
        (p) {
          _last = p;
          onTick(p.latitude, p.longitude, _validHeading(p.heading), p.speed);
        },
        onError: (e) {
          AvaLog.I.log('location', 'live stream error id=$_shortId: $e');
        },
        cancelOnError: false,
      );
    } catch (e) {
      AvaLog.I.log('location', 'live stream start FAILED id=$_shortId: $e');
    }

    // Heartbeat: re-emit the last known fix so the receiver's countdown/marker
    // stays "live" even when the sender hasn't moved far enough to trip the
    // distance filter.
    _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) {
      final p = _last;
      if (p != null && !_stopped) {
        onTick(p.latitude, p.longitude, _validHeading(p.heading), p.speed);
      }
    });

    AvaLog.I.log('location', 'live broadcaster started id=$_shortId for ${secs}s');
  }

  /// Geolocator reports -1 when heading is unknown; normalise to null.
  double? _validHeading(double h) => (h.isNaN || h < 0) ? null : h;

  void stop([String reason = 'manual']) {
    if (_stopped) return;
    _stopped = true;
    _sub?.cancel();
    _stopTimer?.cancel();
    _heartbeat?.cancel();
    AvaLog.I.log('location', 'live broadcaster stopped id=$_shortId reason=$reason');
    onEnd(reason);
  }

  bool get isRunning => !_stopped;
}
