import 'dart:convert';
import 'dart:math' as math;

/// Liveness V3 — ACTIVE ANTI-AVATAR CHALLENGES (client contract).
///
/// The V3 session response now carries an optional `active_checks` block that
/// drives *server-verifiable physical* challenges the app performs WHILE
/// recording — a screen-flash sequence (the display washes the face with
/// coloured light the camera must see), a haptic buzz (whose accelerometer
/// signature the server correlates), and randomized wait-gaps between prompts.
/// The client captures the ACTUAL response (measured flash luma timeline,
/// device motion timeline, real fire timestamps, camera-path integrity signals)
/// and returns it in the verify body as `capture_meta`.
///
/// Everything here is parsed LENIENTLY: an absent/garbled `active_checks` block
/// means "no active checks — run the flow exactly as before". A failed sensor or
/// plugin leaves the corresponding `capture_meta` field null; the flow proceeds
/// and telemetry notes the miss (owner rule: graceful degradation everywhere).

/// A single screen-flash step: at [tOffsetMs] after recording starts, wash the
/// full screen with [color] for [durationMs].
class FlashStep {
  const FlashStep({required this.color, required this.tOffsetMs, required this.durationMs});

  /// 'white' | 'red' | 'blue' (server contract). Unknown → treated as white.
  final String color;
  final int tOffsetMs;
  final int durationMs;

  factory FlashStep.fromJson(Map<String, dynamic> j) => FlashStep(
        color: (j['color'] ?? 'white').toString().toLowerCase(),
        tOffsetMs: (j['t_offset_ms'] as num?)?.toInt() ?? 0,
        durationMs: (j['duration_ms'] as num?)?.toInt() ?? 220,
      );
}

/// A single haptic buzz: fire at [tOffsetMs] for [durationMs].
class VibrateStep {
  const VibrateStep({required this.tOffsetMs, required this.durationMs});
  final int tOffsetMs;
  final int durationMs;

  factory VibrateStep.fromJson(Map<String, dynamic> j) => VibrateStep(
        tOffsetMs: (j['t_offset_ms'] as num?)?.toInt() ?? 0,
        durationMs: (j['duration_ms'] as num?)?.toInt() ?? 300,
      );
}

/// The parsed `active_checks` block. [present] is false when the server sent
/// nothing (flow unchanged). [challengeGapsMs] are waits inserted BETWEEN the
/// existing head-movement challenge prompts; when the server omits them the flow
/// uses a local random 700–1900 ms gap so the timing still isn't predictable.
class ActiveChecks {
  const ActiveChecks({
    required this.present,
    required this.flashSequence,
    required this.vibrate,
    required this.challengeGapsMs,
  });

  const ActiveChecks.none()
      : present = false,
        flashSequence = const [],
        vibrate = null,
        challengeGapsMs = const [];

  final bool present;
  final List<FlashStep> flashSequence;
  final VibrateStep? vibrate;
  final List<int> challengeGapsMs;

  factory ActiveChecks.fromJson(Map<String, dynamic>? j) {
    if (j == null || j.isEmpty) return const ActiveChecks.none();
    try {
      final flashes = <FlashStep>[];
      for (final f in (j['flash_sequence'] as List? ?? const [])) {
        if (f is Map<String, dynamic>) flashes.add(FlashStep.fromJson(f));
      }
      VibrateStep? vib;
      final v = j['vibrate'];
      if (v is Map<String, dynamic>) vib = VibrateStep.fromJson(v);
      final gaps = <int>[];
      for (final g in (j['challenge_gaps_ms'] as List? ?? const [])) {
        if (g is num) gaps.add(g.toInt());
      }
      return ActiveChecks(
        present: flashes.isNotEmpty || vib != null || gaps.isNotEmpty,
        flashSequence: flashes,
        vibrate: vib,
        challengeGapsMs: gaps,
      );
    } catch (_) {
      return const ActiveChecks.none();
    }
  }

  /// The gap to wait before challenge at [index]. Uses the server value when
  /// present, else a local random 700–1900 ms (never predictable).
  int gapForIndex(int index, math.Random rng) {
    if (index >= 0 && index < challengeGapsMs.length) {
      final g = challengeGapsMs[index];
      if (g >= 0 && g <= 6000) return g;
    }
    return 700 + rng.nextInt(1201); // 700..1900
  }
}

/// One measured motion sample. gx/gy/gz are gyroscope rates (null when the device
/// has no gyro). t is ms since recording start.
class SensorSample {
  const SensorSample({
    required this.t,
    required this.ax,
    required this.ay,
    required this.az,
    this.gx,
    this.gy,
    this.gz,
  });
  final int t;
  final double ax, ay, az;
  final double? gx, gy, gz;

  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{
      't': t,
      'ax': _r(ax),
      'ay': _r(ay),
      'az': _r(az),
    };
    if (gx != null) m['gx'] = _r(gx!);
    if (gy != null) m['gy'] = _r(gy!);
    if (gz != null) m['gz'] = _r(gz!);
    return m;
  }

  static double _r(double v) => double.parse(v.toStringAsFixed(3));
}

/// One measured luminance sample (mean frame Y, 0..255). t is ms since record start.
class LumaSample {
  const LumaSample({required this.t, required this.luma});
  final int t;
  final double luma;
  Map<String, dynamic> toJson() => {'t': t, 'luma': double.parse(luma.toStringAsFixed(1))};
}

/// A flash we actually rendered (server correlates t_actual against the schedule
/// AND against the luma timeline — a printed photo/emulator won't show the wash).
class FlashEvent {
  const FlashEvent({required this.color, required this.tActualMs});
  final String color;
  final int tActualMs;
  Map<String, dynamic> toJson() => {'color': color, 't_actual_ms': tActualMs};
}

/// Camera-path integrity signals (best-effort; any unknowable field is null).
class IntegrityReport {
  const IntegrityReport({
    this.rooted,
    this.emulator,
    this.virtualCamera,
    this.instrumentation,
    this.playIntegrity,
  });

  final bool? rooted;
  final bool? emulator;
  final bool? virtualCamera; // TODO: no reliable client signal yet
  final bool? instrumentation; // TODO: no reliable client signal yet
  final String? playIntegrity; // existing [LIVE-ATTEST-1] stub — stays null

  Map<String, dynamic> toJson() => {
        'rooted': rooted,
        'emulator': emulator,
        'virtual_camera': virtualCamera,
        'instrumentation': instrumentation,
        'play_integrity': playIntegrity,
      };
}

/// Camera hardware description the server pins the clip against.
class CameraInfo {
  const CameraInfo({this.model, this.resolution, this.fps});
  final String? model;
  final String? resolution; // e.g. "720x1280"
  final int? fps;
  Map<String, dynamic> toJson() =>
      {'model': model, 'resolution': resolution, 'fps': fps};
}

/// The full `capture_meta` block returned in the verify POST body. The JSON is
/// kept ≤32 KB by DOWNSAMPLING the timelines (≤50 sensor, ≤60 luma) and, as a
/// final backstop, halving them until [toJsonCapped] fits.
class CaptureMeta {
  CaptureMeta({
    required this.sensorTimeline,
    required this.lumaTimeline,
    required this.flashEvents,
    required this.vibrateEventMs,
    required this.integrity,
    required this.camera,
  });

  final List<SensorSample> sensorTimeline;
  final List<LumaSample> lumaTimeline;
  final List<FlashEvent> flashEvents;
  final int? vibrateEventMs;
  final IntegrityReport integrity;
  final CameraInfo camera;

  static const int _maxBytes = 32 * 1024;

  Map<String, dynamic> _build(List<SensorSample> s, List<LumaSample> l) => {
        'sensor_timeline': s.map((e) => e.toJson()).toList(),
        'luma_timeline': l.map((e) => e.toJson()).toList(),
        'flash_events': flashEvents.map((e) => e.toJson()).toList(),
        'vibrate_event': vibrateEventMs == null ? null : {'t_actual_ms': vibrateEventMs},
        'integrity': integrity.toJson(),
        'camera': camera.toJson(),
      };

  /// Build the JSON map, guaranteeing the encoded body stays ≤32 KB by
  /// progressively decimating the two timelines (keep every other sample) until
  /// it fits. Never drops flash/vibrate/integrity/camera — those are tiny and
  /// load-bearing.
  Map<String, dynamic> toJsonCapped() {
    var s = sensorTimeline;
    var l = lumaTimeline;
    var map = _build(s, l);
    for (var guard = 0; guard < 8; guard++) {
      if (utf8.encode(jsonEncode(map)).length <= _maxBytes) break;
      s = _decimate(s);
      l = _decimate(l);
      map = _build(s, l);
    }
    return map;
  }

  static List<T> _decimate<T>(List<T> src) {
    if (src.length <= 2) return src;
    final out = <T>[];
    for (var i = 0; i < src.length; i += 2) {
      out.add(src[i]);
    }
    return out;
  }
}

/// Downsample any timeline to at most [max] evenly-spaced samples (keeps the
/// first and last). Used for the ≤50 sensor / ≤60 luma caps in the contract.
List<T> downsample<T>(List<T> src, int max) {
  if (src.length <= max || max <= 1) return src;
  final out = <T>[];
  final step = src.length / max;
  for (var i = 0; i < max; i++) {
    out.add(src[(i * step).floor().clamp(0, src.length - 1)]);
  }
  if (out.last != src.last) out[out.length - 1] = src.last;
  return out;
}
