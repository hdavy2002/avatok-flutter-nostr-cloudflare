/// User preference is a ceiling; it is never a promise of delivered resolution.
enum VideoQualityMode {
  auto('Auto'),
  best('Best quality'),
  dataSaver('Data saver');

  const VideoQualityMode(this.label);
  final String label;

  static VideoQualityMode fromStored(String? value) =>
      values.firstWhere((mode) => mode.name == value, orElse: () => auto);
}

/// Ordered from least to most expensive. Audio is never disabled by this policy.
enum VideoQualityRung {
  audioOnly(0, 0, 0, 'Audio only'),
  p480(854, 480, 600000, '480p'),
  p720(1280, 720, 1500000, '720p'),
  p1080(1920, 1080, 3000000, '1080p'),
  p1440(2560, 1440, 5000000, '1440p'),
  // GetStream's documented server-side maximum is 6 Mbps for a video layer.
  p2160(3840, 2160, 6000000, '2160p');

  const VideoQualityRung(this.width, this.height, this.bitrate, this.label);
  final int width;
  final int height;
  final int bitrate;
  final String label;

  VideoQualityRung get lower => values[index > 0 ? index - 1 : 0];
  VideoQualityRung get higher => values[index < values.length - 1 ? index + 1 : index];

  static VideoQualityRung forDimensions(int width, int height) {
    if (width <= 0 || height <= 0) return audioOnly;
    final shortSide = width < height ? width : height;
    return values.lastWhere((rung) => rung.height <= shortSide);
  }
}

class VideoQualitySample {
  const VideoQualitySample({
    required this.at,
    this.availableBitrate,
    this.roundTripMs,
    this.poorConnection = false,
    this.healthyConnection = false,
    this.videoPaused = false,
  });

  final DateTime at;
  /// ICE bandwidth estimate, not the bitrate of the currently selected layer.
  final double? availableBitrate;
  final double? roundTripMs;
  final bool poorConnection;
  final bool healthyConnection;
  final bool videoPaused;
}

/// Deterministic policy shared by live and conversational Stream calls.
/// Unknown capabilities default to 720p. A caller must provide an evidenced
/// ceiling to request more. Failure lowers that ceiling for this session only.
class VideoQualityPolicy {
  VideoQualityPolicy({
    VideoQualityMode mode = VideoQualityMode.auto,
    VideoQualityRung capabilityCeiling = VideoQualityRung.p720,
  }) : _mode = mode, _capabilityCeiling = capabilityCeiling {
    _requested = _initial;
  }

  static const downgradeHold = Duration(seconds: 3);
  static const upgradeHold = Duration(seconds: 20);
  static const changeCooldown = Duration(seconds: 8);
  static const sampleExpiry = Duration(seconds: 10);

  VideoQualityMode _mode;
  VideoQualityRung _capabilityCeiling;
  late VideoQualityRung _requested;
  DateTime? _lastSample;
  DateTime? _lastChange;
  DateTime? _candidateSince;
  VideoQualityRung? _candidate;

  VideoQualityMode get mode => _mode;
  VideoQualityRung get requested => _requested;
  VideoQualityRung get ceiling => _mode == VideoQualityMode.dataSaver
      ? _min(_capabilityCeiling, VideoQualityRung.p480)
      : _capabilityCeiling;
  VideoQualityRung get _initial => _mode == VideoQualityMode.best
      ? ceiling
      : _min(ceiling, VideoQualityRung.p720);

  static VideoQualityRung _min(VideoQualityRung a, VideoQualityRung b) =>
      a.index < b.index ? a : b;

  void setMode(VideoQualityMode mode) {
    if (_mode == mode) return;
    _mode = mode;
    _requested = _initial;
    _resetEvidence();
  }

  void setCapabilityCeiling(VideoQualityRung ceiling) {
    if (_capabilityCeiling == ceiling) return;
    final wasUnavailable = _capabilityCeiling == VideoQualityRung.audioOnly;
    final raised = ceiling.index > _capabilityCeiling.index;
    _capabilityCeiling = ceiling;
    _requested = wasUnavailable || (raised && mode == VideoQualityMode.best)
        ? _initial : _min(_requested, this.ceiling);
    _resetEvidence();
  }

  void reject(VideoQualityRung rung) {
    _capabilityCeiling = _min(_capabilityCeiling, rung.lower);
    _requested = _min(_requested, ceiling);
    _resetEvidence();
  }

  void _resetEvidence() {
    _candidate = null;
    _candidateSince = null;
    _lastSample = null;
    _lastChange = null;
  }

  VideoQualityRung observe(VideoQualitySample sample) {
    final previous = _lastSample;
    if (previous != null && !sample.at.isAfter(previous)) return requested;
    if (previous != null && sample.at.difference(previous) > sampleExpiry) {
      _candidate = null;
      _candidateSince = null;
    }
    _lastSample = sample.at;
    final bandwidth = sample.availableBitrate;
    final hasBandwidth = bandwidth != null && bandwidth.isFinite && bandwidth >= 0;
    final bad = sample.poorConnection || sample.videoPaused ||
        (sample.roundTripMs ?? 0) > 600 ||
        (hasBandwidth && bandwidth! < requested.bitrate * 1.15);
    final next = _min(requested.higher, ceiling);
    final good = !bad &&
        (sample.roundTripMs == null || sample.roundTripMs! < 250) &&
        (hasBandwidth
            ? bandwidth! >= next.bitrate * 1.4
            : sample.healthyConnection && next.index <= VideoQualityRung.p720.index);
    final candidate = bad ? requested.lower : good ? next : requested;
    if (candidate == requested) {
      _candidate = null;
      _candidateSince = null;
      return requested;
    }
    if (_candidate != candidate) {
      _candidate = candidate;
      _candidateSince = sample.at;
      return requested;
    }
    final hold = candidate.index < requested.index ? downgradeHold : upgradeHold;
    if (sample.at.difference(_candidateSince!) < hold ||
        (_lastChange != null && sample.at.difference(_lastChange!) < changeCooldown)) {
      return requested;
    }
    _requested = candidate;
    _lastChange = sample.at;
    _candidate = null;
    _candidateSince = null;
    return requested;
  }
}
