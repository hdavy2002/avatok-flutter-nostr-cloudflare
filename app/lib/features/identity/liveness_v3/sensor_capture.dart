import 'dart:async';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:sensors_plus/sensors_plus.dart';

import 'active_checks.dart';

/// Liveness V3 — MOTION CAPTURE + CAMERA-PATH INTEGRITY (client active checks).
///
/// While the face stage records, [SensorCapture] streams the accelerometer (and
/// gyroscope when present) and buffers raw samples timestamped from record start.
/// [drain] downsamples the buffer to ≤50 samples for the verify body. A holding
/// hand produces a characteristic micro-tremor + the haptic buzz produces a sharp
/// spike the server correlates against `vibrate_event` — a rigid tripod / emulator
/// / injected virtual camera does not.
///
/// Everything is best-effort: if the streams never fire (no sensor, permission
/// denied on some OEMs, plugin failure) [drain] just returns an empty list and the
/// caller sends `sensor_timeline: []`; the flow is never blocked.
class SensorCapture {
  StreamSubscription<AccelerometerEvent>? _accSub;
  StreamSubscription<GyroscopeEvent>? _gyroSub;

  final List<SensorSample> _buf = [];
  int _t0 = 0;
  bool _running = false;

  // Latest gyro reading, merged into the next accel sample (accel drives the
  // sample cadence so the two streams don't double the buffer).
  double? _gx, _gy, _gz;
  bool _gyroSeen = false;

  bool get gyroAvailable => _gyroSeen;

  /// Start buffering. [t0Ms] is the recording-start epoch so every sample's `t`
  /// is an offset from record start (matching flash/vibrate offsets).
  void start(int t0Ms) {
    if (_running) return;
    _running = true;
    _t0 = t0Ms;
    _buf.clear(); // fresh capture per recording (retry-safe)
    _gyroSeen = false;
    _gx = _gy = _gz = null;
    try {
      _gyroSub = gyroscopeEvents.listen(
        (e) {
          _gyroSeen = true;
          _gx = e.x;
          _gy = e.y;
          _gz = e.z;
        },
        onError: (_) {},
        cancelOnError: false,
      );
    } catch (_) {/* no gyro — accel-only is fine */}
    try {
      _accSub = accelerometerEvents.listen(
        (e) {
          if (!_running) return;
          // Cap the raw buffer so a long stage can't grow it unbounded before
          // downsampling (≈ generous headroom over the ≤50 final samples).
          if (_buf.length >= 600) return;
          final t = DateTime.now().millisecondsSinceEpoch - _t0;
          _buf.add(SensorSample(
            t: t < 0 ? 0 : t,
            ax: e.x, ay: e.y, az: e.z,
            gx: _gyroSeen ? _gx : null,
            gy: _gyroSeen ? _gy : null,
            gz: _gyroSeen ? _gz : null,
          ));
        },
        onError: (_) {},
        cancelOnError: false,
      );
    } catch (_) {/* no accel — timeline will be empty, flow continues */}
  }

  /// Stop the streams and return the downsampled (≤50) timeline.
  Future<List<SensorSample>> drain() async {
    _running = false;
    try {
      await _accSub?.cancel();
    } catch (_) {}
    try {
      await _gyroSub?.cancel();
    } catch (_) {}
    _accSub = null;
    _gyroSub = null;
    return downsample(List<SensorSample>.of(_buf), 50);
  }

  int get rawSampleCount => _buf.length;
}

/// Best-effort camera-path integrity probe (root / emulator / attest).
///
/// - rooted: reuse a lightweight heuristic since the app has no root-check plugin
///   — Android: build tags contain "test-keys" OR a common `su` binary exists on
///   disk; iOS: null (jailbreak detection not attempted here).
/// - emulator: device_info_plus `isPhysicalDevice == false`.
/// - virtual_camera / instrumentation: null (no reliable client signal yet — TODO).
/// - play_integrity: null (the existing [LIVE-ATTEST-1] attestation stub owns this).
///
/// Never throws: any probe failure leaves that field null.
class IntegrityProbe {
  static final DeviceInfoPlugin _info = DeviceInfoPlugin();

  static const List<String> _suPaths = [
    '/system/bin/su',
    '/system/xbin/su',
    '/sbin/su',
    '/system/app/Superuser.apk',
    '/data/local/xbin/su',
    '/data/local/bin/su',
    '/system/sd/xbin/su',
  ];

  static Future<IntegrityReport> probe() async {
    bool? rooted;
    bool? emulator;
    try {
      if (Platform.isAndroid) {
        final a = await _info.androidInfo;
        emulator = !a.isPhysicalDevice;
        final tags = (a.tags).toLowerCase();
        var suFound = false;
        for (final p in _suPaths) {
          try {
            if (File(p).existsSync()) {
              suFound = true;
              break;
            }
          } catch (_) {/* SELinux denial on a clean device — ignore */}
        }
        rooted = tags.contains('test-keys') || suFound;
      } else if (Platform.isIOS) {
        final i = await _info.iosInfo;
        emulator = !i.isPhysicalDevice;
        rooted = null; // jailbreak detection not attempted client-side (TODO)
      }
    } catch (_) {
      // device_info unavailable — leave whatever we managed to set.
    }
    return IntegrityReport(
      rooted: rooted,
      emulator: emulator,
      virtualCamera: null, // TODO
      instrumentation: null, // TODO
      playIntegrity: null, // [LIVE-ATTEST-1] stub
    );
  }
}
