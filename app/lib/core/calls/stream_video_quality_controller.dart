import 'dart:async';

import 'package:flutter/material.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart' as video;

import '../../identity/identity.dart' show AccountScope;
import 'video_quality_policy.dart';
import 'video_quality_preferences.dart';

/// Small adapter boundary so safety and fallback can be tested without media.
abstract interface class StreamVideoQualityPort {
  bool get connected;
  bool get cameraEnabled;
  VideoQualityRung get capabilityCeiling;
  Future<bool> requestCameraResolution(VideoQualityRung rung);
  Future<bool> requestIncomingResolution(VideoQualityRung rung);
  Future<bool> setCameraEnabled(bool enabled);
  Future<bool> flipCamera();
}

class _StreamVideoQualityPort implements StreamVideoQualityPort {
  _StreamVideoQualityPort(this.call);
  final video.Call call;

  @override
  bool get connected => call.state.value.status.isConnected;
  @override
  bool get cameraEnabled =>
      call.state.value.localParticipant?.publishedTracks[video.SfuTrackType.video]
          ?.muted == false;
  @override
  VideoQualityRung get capabilityCeiling {
    if (!connected) return VideoQualityRung.p720;
    final settings = call.state.value.settings.video;
    if (!settings.enabled) return VideoQualityRung.audioOnly;
    final target = settings.targetResolution;
    return VideoQualityRung.forDimensions(target.width, target.height);
  }

  @override
  Future<bool> requestCameraResolution(VideoQualityRung rung) async =>
      (await call.setCameraTargetResolution(video.StreamTargetResolution(
        width: rung.width, height: rung.height, bitrate: rung.bitrate,
      ))).isSuccess;

  @override
  Future<bool> requestIncomingResolution(VideoQualityRung rung) async {
    if (rung == VideoQualityRung.audioOnly) {
      return (await call.setIncomingVideoEnabled(false)).isSuccess;
    }
    // This SDK method also re-enables incoming video. Do not call
    // setIncomingVideoEnabled(true) afterward: it erases the resolution override.
    return (await call.setPreferredIncomingVideoResolution(
      video.VideoDimension(width: rung.width, height: rung.height),
    )).isSuccess;
  }

  @override
  Future<bool> setCameraEnabled(bool enabled) async =>
      (await call.setCameraEnabled(enabled: enabled)).isSuccess;

  @override
  Future<bool> flipCamera() async => (await call.flipCamera()).isSuccess;
}

/// SDK 1.4.3 APIs inspected in call.dart, call_settings.dart and rtc stats.
/// All media writes are serialized; microphone/audio routing are never changed.
class StreamVideoQualityController extends ChangeNotifier {
  StreamVideoQualityController({
    required StreamVideoQualityPort port,
    required this.videoAllowed,
    required this.canPublish,
    VideoQualityPreferences? preferences,
  }) : _port = port,
       _preferences = preferences ?? VideoQualityPreferences(),
       _accountId = AccountScope.id,
       policy = VideoQualityPolicy(capabilityCeiling: port.capabilityCeiling);

  factory StreamVideoQualityController.forCall(
    video.Call call, {
    required bool videoAllowed,
    required bool canPublish,
  }) {
    enableSubscriberPause(call);
    final controller = StreamVideoQualityController(
      port: _StreamVideoQualityPort(call),
      videoAllowed: videoAllowed,
      canPublish: canPublish,
    );
    controller._stateSubscription = call.state.valueStream.listen((state) {
      controller._readState(state);
    });
    controller._statsSubscription = call.stats.listen((bundle) {
      controller._readStats(
        call.state.value, bundle.publisherStatsBundle, bundle.subscriberStatsBundle,
      );
    });
    controller._readState(call.state.value);
    return controller;
  }

  /// Must run before join. 1.4.3 also defaults this capability on, including
  /// native-answer sessions whose join precedes the Flutter screen.
  static void enableSubscriberPause(video.Call call) =>
      call.enableClientCapabilities([video.SfuClientCapability.subscriberVideoPause]);

  final StreamVideoQualityPort _port;
  final VideoQualityPreferences _preferences;
  final String? _accountId;
  final bool videoAllowed;
  final bool canPublish;
  final VideoQualityPolicy policy;
  StreamSubscription<dynamic>? _stateSubscription;
  StreamSubscription<dynamic>? _statsSubscription;
  Future<void> _operations = Future<void>.value();
  Future<void>? _startFuture;
  bool _closed = false;
  bool _disposed = false;
  bool _ready = false;
  bool _applyQueued = false;
  bool _wasConnected = false;
  bool _wasCameraEnabled = false;
  int _modeRevision = 0;
  VideoQualityRung? _captureApplied;
  VideoQualityRung? _incomingApplied;
  VideoQualityRung? _failedCeiling;
  DateTime? _retryIncomingAfter;
  double? _lastStatsTimestamp;
  String? actualSendResolution;
  String? actualReceiveResolution;
  Map<String, bool> pausedParticipants = const {};
  bool cameraPausedForQuality = false;
  String? error;

  bool get _active => !_closed && AccountScope.id == _accountId;
  bool get cameraEnabled => _port.cameraEnabled;
  bool get incomingPaused => _incomingApplied == VideoQualityRung.audioOnly;
  bool get serverPaused => pausedParticipants.values.any((paused) => paused);
  VideoQualityRung get requested => videoAllowed
      ? policy.requested : VideoQualityRung.audioOnly;
  VideoQualityRung? get appliedCapture => _captureApplied;
  VideoQualityRung? get appliedIncoming => _incomingApplied;

  Map<String, Object> get telemetry => {
    'video_quality_mode': policy.mode.name,
    'video_quality_requested': requested.label,
    'video_quality_cap': policy.ceiling.label,
    'video_quality_applied_send': _captureApplied?.label ?? 'unknown',
    'video_quality_applied_receive': _incomingApplied?.label ?? 'unknown',
    'video_quality_actual_send': actualSendResolution ?? 'unknown',
    'video_quality_actual_receive': actualReceiveResolution ?? 'unknown',
    'video_quality_subscriber_paused': serverPaused,
    'video_quality_incoming_paused': incomingPaused,
    'video_quality_camera_paused': cameraPausedForQuality,
    'video_quality_error': error ?? '',
  };

  Future<void> start() => _startFuture ??= _load();

  Future<void> _load() async {
    final revision = _modeRevision;
    try {
      final mode = await _preferences.load();
      if (!_active) return;
      if (revision == _modeRevision) policy.setMode(mode);
    } catch (_) {
      error = 'Quality preference unavailable; using Auto';
    }
    if (!_active) return;
    _ready = true;
    await refresh();
  }

  Future<void> setMode(VideoQualityMode mode) async {
    if (!_active) return;
    _modeRevision++;
    policy.setMode(mode);
    _retryIncomingAfter = null;
    error = null;
    final saved = _preferences.save(mode).catchError((Object _) {
      if (_active) {
        error = 'Quality changed for this call; preference could not be saved';
        _notify();
      }
    });
    await refresh();
    await saved;
  }

  void _readState(video.CallState state) {
    if (!_active) return;
    pausedParticipants = Map.unmodifiable({
      for (final participant in state.otherParticipants)
        participant.sessionId: participant.pausedTracks.contains(video.SfuTrackType.video),
    });
    if (!_port.connected) {
      actualSendResolution = null;
      actualReceiveResolution = null;
    }
    if (!_port.cameraEnabled) actualSendResolution = null;
    if (state.otherParticipants.isEmpty ||
        state.otherParticipants.every((p) =>
            p.publishedTracks[video.SfuTrackType.video]?.muted != false ||
            p.pausedTracks.contains(video.SfuTrackType.video))) {
      actualReceiveResolution = null;
    }
    unawaited(refresh());
  }

  void _readStats(video.CallState state, video.PeerConnectionStatsBundle pub,
      video.PeerConnectionStatsBundle sub) {
    if (!_active || !_ready || !_port.connected) return;
    final timestamps = [...pub.stats, ...sub.stats]
        .map((stat) => stat.timestamp)
        .whereType<double>()
        .where((value) => value.isFinite);
    if (timestamps.isEmpty) return;
    final timestamp = timestamps.reduce((a, b) => a > b ? a : b);
    if (_lastStatsTimestamp != null && timestamp <= _lastStatsTimestamp!) return;
    _lastStatsTimestamp = timestamp;
    final outbound = pub.stats.whereType<video.RtcOutboundRtpVideoStream>();
    final inbound = sub.stats.whereType<video.RtcInboundRtpVideoStream>();
    actualSendResolution = _port.cameraEnabled ? _largestResolution([
      for (final s in outbound)
        if ((s.framesPerSecond ?? 0) > 0) (s.frameWidth, s.frameHeight),
    ]) : null;
    final receiving = state.otherParticipants.any((p) =>
        p.publishedTracks[video.SfuTrackType.video]?.muted == false &&
        !p.pausedTracks.contains(video.SfuTrackType.video));
    actualReceiveResolution = incomingPaused || !receiving ? null : _largestResolution([
      for (final s in inbound)
        if ((s.framesPerSecond ?? 0) > 0) (s.frameWidth, s.frameHeight),
    ]);
    final publisherPairs = pub.stats.whereType<video.RtcIceCandidatePair>()
        .where((p) => p.nominated == true && p.state == 'succeeded');
    final subscriberPairs = sub.stats.whereType<video.RtcIceCandidatePair>()
        .where((p) => p.nominated == true && p.state == 'succeeded');
    final estimates = <double>[
      if (canPublish && _port.cameraEnabled)
        for (final p in publisherPairs)
          if (p.availableOutgoingBitrate != null) p.availableOutgoingBitrate!,
      for (final p in subscriberPairs)
        if (p.availableIncomingBitrate != null) p.availableIncomingBitrate!,
    ].where((value) => value.isFinite && value >= 0).toList();
    final rtts = [
      for (final p in [...publisherPairs, ...subscriberPairs])
        if (p.currentRoundTripTime != null) p.currentRoundTripTime! * 1000,
    ].where((value) => value.isFinite && value >= 0).toList();
    final quality = state.localParticipant?.connectionQuality;
    policy.observe(VideoQualitySample(
      at: DateTime.now(),
      availableBitrate: estimates.isEmpty ? null : estimates.reduce((a, b) => a < b ? a : b),
      roundTripMs: rtts.isEmpty ? null : rtts.reduce((a, b) => a > b ? a : b),
      poorConnection: quality == video.SfuConnectionQuality.poor,
      healthyConnection: quality == video.SfuConnectionQuality.good ||
          quality == video.SfuConnectionQuality.excellent,
      // A remembered SFU pause cannot trap our own audio-only subscription:
      // after we disable video there may be no SFU resume event until recovery.
      videoPaused: serverPaused && !incomingPaused,
    ));
    unawaited(refresh());
  }

  static String? _largestResolution(List<(int?, int?)> dimensions) {
    int area = 0;
    String? result;
    for (final (width, height) in dimensions) {
      if (width != null && height != null && width > 0 && height > 0 &&
          width * height > area) {
        area = width * height;
        result = '${width}x$height';
      }
    }
    return result;
  }

  Future<void> _enqueue(Future<void> Function() operation) {
    final next = _operations.then((_) async {
      if (!_active) return;
      try {
        await operation();
      } catch (_) {
        if (_active) error = 'Could not apply video quality; audio is unchanged';
      }
      _notify();
    });
    _operations = next;
    return next;
  }

  /// Called on state changes and fresh stats, never by a fast polling timer.
  Future<void> refresh() {
    if (!_active) return Future<void>.value();
    final connected = _port.connected;
    final cameraOn = _port.cameraEnabled;
    if (connected != _wasConnected) {
      _captureApplied = null;
      _incomingApplied = null;
      _lastStatsTimestamp = null;
      _retryIncomingAfter = null;
    }
    if (cameraOn != _wasCameraEnabled) _captureApplied = null;
    _wasConnected = connected;
    _wasCameraEnabled = cameraOn;
    var ceiling = _port.capabilityCeiling;
    if (_failedCeiling != null && _failedCeiling!.index < ceiling.index) {
      ceiling = _failedCeiling!;
    }
    policy.setCapabilityCeiling(ceiling);
    _notify();
    if (!_ready || !connected || _applyQueued) return _operations;
    _applyQueued = true;
    return _enqueue(() async {
      try {
        // At most the six ladder rungs. A rejected capture request cannot
        // create an infinite retry loop or terminate a usable audio session.
        for (var attempt = 0; attempt < VideoQualityRung.values.length; attempt++) {
          if (!_active || !_port.connected) return;
          final target = requested;
          if (_incomingApplied != target &&
              (_retryIncomingAfter == null ||
                  !DateTime.now().isBefore(_retryIncomingAfter!))) {
            _retryIncomingAfter = DateTime.now().add(VideoQualityPolicy.changeCooldown);
            var applied = false;
            try { applied = await _port.requestIncomingResolution(target); } catch (_) {}
            if (!_active) return;
            if (applied) {
              _retryIncomingAfter = null;
              _incomingApplied = target;
              if (target == VideoQualityRung.audioOnly) actualReceiveResolution = null;
            } else {
              error = 'Incoming quality request failed; will retry shortly';
            }
            // Subscriber failure must not block a required publisher downgrade.
          }
          if (!_active || !_port.connected) return;
          if (canPublish && _port.cameraEnabled) {
            if (target == VideoQualityRung.audioOnly) {
              if (!await _port.setCameraEnabled(false)) {
                error = 'Could not pause camera for this connection';
                return;
              }
              if (!_active) return;
              cameraPausedForQuality = true;
              actualSendResolution = null;
              _captureApplied = target;
            } else if (_captureApplied != target) {
              bool accepted;
              try {
                accepted = await _port.requestCameraResolution(target);
              } catch (_) {
                accepted = false;
              }
              if (!_active) {
                // A native recreation can finish after bounded teardown.
                // Release this old call's late capture, never its microphone.
                await _port.setCameraEnabled(false);
                return;
              }
              if (!accepted) {
                if (!_port.cameraEnabled) return;
                policy.reject(target);
                _failedCeiling = policy.ceiling;
                error = 'Camera quality reduced to a supported setting';
                continue;
              }
              _captureApplied = target;
            }
          }
          // A mode change during an SDK await is reconciled in this queue.
          if (requested != target) continue;
          return;
        }
      } finally {
        _applyQueued = false;
      }
    });
  }

  /// Explicit user action only. Automatic recovery resumes subscriptions but
  /// never turns a camera back on (including an external/prejoin camera-off).
  Future<bool> setCameraEnabled(bool enabled) async {
    var success = false;
    await _enqueue(() async {
      if (!canPublish || !videoAllowed || !_port.connected) return;
      if (enabled && requested == VideoQualityRung.audioOnly) {
        error = 'Connection is too weak for video; try again after it recovers';
        return;
      }
      success = await _port.setCameraEnabled(enabled);
      if (!_active) {
        if (enabled) await _port.setCameraEnabled(false);
        success = false;
        return;
      }
      if (success) {
        cameraPausedForQuality = false;
        _captureApplied = null;
        if (!enabled) actualSendResolution = null;
      } else {
        error = 'Could not change camera; check permissions and try again';
      }
    });
    if (success) await refresh();
    return success;
  }

  Future<bool> flipCamera() async {
    var success = false;
    await _enqueue(() async {
      if (!canPublish || !_port.connected || !_port.cameraEnabled) return;
      success = await _port.flipCamera();
      if (!_active) {
        await _port.setCameraEnabled(false);
        success = false;
        return;
      }
      // A different camera may support a different resolution. Reapply with
      // the existing conservative ceiling; any rejection falls down again.
      _captureApplied = null;
    });
    if (success) await refresh();
    return success;
  }

  void _notify() {
    if (_active && !_disposed) notifyListeners();
  }

  /// Drain any capture recreation before call.leave releases native tracks.
  Future<void> close() async {
    _closed = true;
    try { await _stateSubscription?.cancel(); } catch (_) {}
    try { await _statsSubscription?.cancel(); } catch (_) {}
    try {
      await _operations.timeout(const Duration(seconds: 2));
    } on TimeoutException {
      // Hang-up must not wait indefinitely for an SFU request or camera.
      // The in-flight operation checks _active and releases any late capture.
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(close());
    super.dispose();
  }
}

/// Shared compact selector and truthful status for live and call surfaces.
class StreamVideoQualityControl extends StatelessWidget {
  const StreamVideoQualityControl({super.key, required this.controller});
  final StreamVideoQualityController controller;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => PopupMenuButton<VideoQualityMode>(
      tooltip: 'Video quality',
      initialValue: controller.policy.mode,
      onSelected: (mode) => unawaited(controller.setMode(mode)),
      itemBuilder: (_) => [
        for (final mode in VideoQualityMode.values)
          CheckedPopupMenuItem(value: mode, checked: controller.policy.mode == mode,
            child: Text(mode.label)),
      ],
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('${controller.policy.mode.label} · requested ${controller.requested.label}',
            textAlign: TextAlign.center),
          Text([
            if (controller.canPublish)
              'Send ${controller.actualSendResolution ?? (controller.cameraEnabled ? 'measuring' : 'camera off')}',
            'Receive ${controller.incomingPaused ? 'audio only' : controller.actualReceiveResolution ?? 'measuring'}',
            if (controller.serverPaused) 'Video paused for bandwidth',
            if (controller.cameraPausedForQuality) 'Camera paused; tap camera to resume',
            if (controller.error != null) controller.error!,
          ].join(' · '), textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 11)),
        ]),
      ),
    ),
  );
}
