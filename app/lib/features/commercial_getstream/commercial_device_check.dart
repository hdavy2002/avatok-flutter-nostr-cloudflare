// Local commercial media check. This file deliberately has no gateway or room
// dependency: capture is private until the caller explicitly joins.
import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:record/record.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

/// Shared readiness rule for prejoin surfaces. A missing probe is pending,
/// rather than ready; yellow is usable while red is blocked.
///
/// [AV-AUDIO-ONLY-1] `cameraAvailable: false` means this device has no usable
/// camera at all (none fitted, broken, or held by another app). That is NOT a
/// reason to keep someone out of a slot he has paid for: he is still heard and
/// still sees the other party, so the camera clause is satisfied exactly like
/// a deliberate camera-off choice. A camera is never required to join
/// (RULEBOOK-PAID-SESSIONS.md §3); only the microphone permission the user
/// actually asked to use is.
bool commercialDeviceCheckReady({
  required bool enabled,
  required bool checking,
  required bool cameraOn,
  required bool microphoneOn,
  required bool cameraGranted,
  required bool microphoneGranted,
  required String? networkVerdict,
  bool cameraAvailable = true,
}) => enabled && !checking &&
    (!cameraOn || !cameraAvailable || cameraGranted) &&
    (!microphoneOn || microphoneGranted) &&
    (networkVerdict == 'green' || networkVerdict == 'yellow');

/// A small, injectable boundary around the local media check. The default
/// implementation uses GetStream's local camera track and the record package's
/// PCM stream for an immediate RMS meter. Tests can inject both factories.
class CommercialDeviceCheckController {
  CommercialDeviceCheckController({
    this.trackFactory = const CommercialRtcTrackFactory(),
    this.recorderFactory = const DefaultCommercialRecordFactory(),
  });

  final CommercialDeviceTrackFactory trackFactory;
  final CommercialRecordFactory recorderFactory;

  RtcLocalCameraTrack? cameraTrack;

  /// [AV-AUDIO-ONLY-1] True once opening the camera has actually FAILED on
  /// this device — distinct from the user switching the camera off, because
  /// there is nothing here for him to switch back on. Opening the camera no
  /// longer throws out of [setCameraEnabled]: a broken camera used to abort
  /// `_syncTracks` before the microphone was ever started, which killed the
  /// mic meter and left the prejoin screen permanently not-ready.
  bool cameraUnavailable = false;

  CommercialPcmRecorder? _recorder;
  StreamSubscription<Uint8List>? _audioSubscription;
  double? _level;
  bool _microphoneEnabled = false;
  Future<void> _operations = Future<void>.value();
  bool _closed = false;
  bool _disposed = false;
  int _generation = 0;

  Future<void> _enqueue(Future<void> Function() operation) {
    final next = _operations.then((_) => operation(), onError: (_) => operation());
    _operations = next.catchError((_) {});
    return next;
  }

  Future<void> setCameraEnabled(bool enabled) {
    final generation = _generation;
    return _enqueue(() async {
      if (generation != _generation || (_closed && enabled)) return;
      if (enabled == (cameraTrack != null)) return;
      if (enabled) {
        final RtcLocalCameraTrack track;
        try {
          track = await trackFactory.camera();
        } catch (_) {
          // [AV-AUDIO-ONLY-1] Audio-only fallback: record it and carry on.
          cameraUnavailable = true;
          return;
        }
        if (_closed || generation != _generation) { try { await track.stop(); } catch (_) {} return; }
        cameraUnavailable = false;
        cameraTrack = track;
      } else {
        final track = cameraTrack;
        cameraTrack = null;
        await track?.stop();
      }
    });
  }

  Future<void> setMicrophoneEnabled(bool enabled) {
    final generation = _generation;
    return _enqueue(() async {
      if (generation != _generation || (_closed && enabled)) return;
      if (enabled == _microphoneEnabled) return;
      if (enabled) {
        // Record owns the only microphone capture during preview. The stream
        // is consumed for RMS only and never persisted or transmitted.
        final recorder = recorderFactory.create();
        late final Stream<Uint8List> stream;
        try {
          stream = await recorder.startPcm();
        } catch (_) {
          try { await recorder.stop(); } catch (_) {}
          try { await recorder.dispose(); } catch (_) {}
          rethrow;
        }
        if (_closed || generation != _generation) { try { await recorder.stop(); } catch (_) {} try { await recorder.dispose(); } catch (_) {} return; }
        _recorder = recorder;
        await _audioSubscription?.cancel();
        _audioSubscription = stream.listen((bytes) {
          _level = commercialPcm16Rms(bytes);
        }, onError: (_, __) { _level = null; }, onDone: () { _level = null; });
        _microphoneEnabled = true;
      } else {
        await _stopRecorder();
        _microphoneEnabled = false;
      }
    });
  }

  double? get microphoneLevel => _level;

  Future<void> _stopRecorder() async {
    final subscription = _audioSubscription;
    _audioSubscription = null;
    await subscription?.cancel();
    final recorder = _recorder;
    _recorder = null;
    try { await recorder?.stop(); } catch (_) {}
    try { await recorder?.dispose(); } catch (_) {}
    _level = null;
  }

  /// [AV-AUDIO-ONLY-1] Clears the audio-only latch so an explicit retry (or a
  /// fresh device check) probes a camera that may since have been plugged in
  /// or released by whatever app was holding it.
  void clearCameraUnavailable() { cameraUnavailable = false; }

  /// Idempotent and safe to call before a failed join, route pop, or pause.
  Future<void> dispose() {
    _disposed = true;
    return release();
  }

  /// Releases preview capture before the SDK starts its own microphone or
  /// camera tracks. The controller remains reusable if the join fails.
  Future<void> release() {
    _closed = true;
    ++_generation;
    return _enqueue(() async {
      final camera = cameraTrack;
      cameraTrack = null;
      try { await camera?.stop(); } catch (_) {}
      await _stopRecorder();
      _microphoneEnabled = false;
    });
  }

  void resume() { if (!_disposed) _closed = false; }
}

abstract interface class CommercialDeviceTrackFactory {
  Future<RtcLocalCameraTrack> camera();
}

class CommercialRtcTrackFactory implements CommercialDeviceTrackFactory {
  const CommercialRtcTrackFactory();
  @override
  Future<RtcLocalCameraTrack> camera() => RtcLocalTrack.camera();
}

abstract interface class CommercialPcmRecorder {
  Future<Stream<Uint8List>> startPcm();
  Future<void> stop();
  Future<void> dispose();
}

abstract interface class CommercialRecordFactory {
  CommercialPcmRecorder create();
}

class CommercialPcmRecorderAdapter implements CommercialPcmRecorder {
  CommercialPcmRecorderAdapter() : _recorder = AudioRecorder();
  final AudioRecorder _recorder;
  @override
  Future<Stream<Uint8List>> startPcm() => _recorder.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits, sampleRate: 44100, numChannels: 1));
  @override Future<void> stop() async { await _recorder.stop(); }
  @override Future<void> dispose() async { await _recorder.dispose(); }
}

class DefaultCommercialRecordFactory implements CommercialRecordFactory {
  const DefaultCommercialRecordFactory();
  @override CommercialPcmRecorder create() => CommercialPcmRecorderAdapter();
}

double commercialPcm16Rms(Uint8List bytes) {
  if (bytes.length < 2) return 0;
  var sum = 0.0;
  var count = 0;
  for (var i = 0; i + 1 < bytes.length; i += 2) {
    final sample = (bytes[i] | (bytes[i + 1] << 8));
    final signed = sample > 32767 ? sample - 65536 : sample;
    sum += signed * signed;
    count++;
  }
  return count == 0 ? 0 : (math.sqrt(sum / count) / 32768).clamp(0, 1).toDouble();
}

/// Reusable visual panel for consultation prejoin and commercial backstage.
/// [onCameraChanged] and [onMicrophoneChanged] let a live room keep ownership
/// of its already-joined tracks while reusing the controls and meter layout.
class CommercialDeviceCheckPanel extends StatefulWidget {
  const CommercialDeviceCheckPanel({
    super.key,
    required this.controller,
    required this.cameraEnabled,
    required this.microphoneEnabled,
    required this.onCameraChanged,
    required this.onMicrophoneChanged,
    this.showCameraPreview = true,
    this.speakerControl,
    this.captureEnabled = true,
    this.cameraGranted = true,
    this.microphoneGranted = true,
    this.onReadyChanged,
    this.onCameraUnavailable,
  });

  final CommercialDeviceCheckController controller;
  final bool cameraEnabled, microphoneEnabled;
  final ValueChanged<bool> onCameraChanged;
  final ValueChanged<bool> onMicrophoneChanged;
  final bool showCameraPreview;
  final bool captureEnabled, cameraGranted, microphoneGranted;
  final ValueChanged<bool>? onReadyChanged;
  /// [AV-AUDIO-ONLY-1] Fired once when the camera could not be opened, so the
  /// host screen can drop its camera intent to `false` before authorizing the
  /// join (publishing a camera that cannot start can fail the whole join).
  final VoidCallback? onCameraUnavailable;
  /// Supplied by the shared commercial speaker test owner. Keeping it outside
  /// this capture controller prevents two audio players owning the same route.
  final Widget? speakerControl;

  @override
  State<CommercialDeviceCheckPanel> createState() => _CommercialDeviceCheckPanelState();
}

class _CommercialDeviceCheckPanelState extends State<CommercialDeviceCheckPanel> with WidgetsBindingObserver {
  Timer? _meterTimer;
  double? _level;
  String? _error;
  bool _paused = false;
  bool _cameraMissing = false;
  int _syncGeneration = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _syncTracks();
    _meterTimer = Timer.periodic(const Duration(milliseconds: 180), (_) => _readLevel());
  }

  @override
  void didUpdateWidget(covariant CommercialDeviceCheckPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cameraEnabled != widget.cameraEnabled || oldWidget.microphoneEnabled != widget.microphoneEnabled || oldWidget.captureEnabled != widget.captureEnabled || oldWidget.cameraGranted != widget.cameraGranted || oldWidget.microphoneGranted != widget.microphoneGranted) unawaited(_syncTracks());
  }

  void _reportReady(bool ready, int generation) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && generation == _syncGeneration) widget.onReadyChanged?.call(ready);
    });
  }

  Future<void> _syncTracks() async {
    final generation = ++_syncGeneration;
    _reportReady(false, generation);
    if (_paused || !widget.captureEnabled) {
      await widget.controller.release();
      if (mounted) setState(() => _level = null);
      return;
    }
    widget.controller.resume();
    try {
      await widget.controller.setCameraEnabled(widget.cameraEnabled && widget.cameraGranted);
      if (!mounted || generation != _syncGeneration) return;
      // [AV-AUDIO-ONLY-1] The camera no longer throws; it reports. Read the
      // verdict here, then keep going so the microphone still starts. Read the
      // controller's own latch and not `widget.cameraEnabled`: the host screen
      // drops its camera intent the moment this fires, so an intent-based test
      // would erase the explanation on the very next rebuild.
      final cameraMissing = widget.controller.cameraUnavailable;
      await widget.controller.setMicrophoneEnabled(widget.microphoneEnabled && widget.microphoneGranted);
      if (!mounted || generation != _syncGeneration) return;
      setState(() { _error = null; _cameraMissing = cameraMissing; });
      if (cameraMissing) widget.onCameraUnavailable?.call();
      final ready = (!widget.cameraEnabled || widget.cameraGranted) &&
          (!widget.microphoneEnabled || widget.microphoneGranted);
      Analytics.capture('commercial_device_check', {'result': ready ? 'ready' : 'permission_required', 'camera_enabled': widget.cameraEnabled, 'microphone_enabled': widget.microphoneEnabled, 'camera_available': !cameraMissing});
      _reportReady(ready, generation);
    } catch (_) {
      if (mounted && generation == _syncGeneration) {
        setState(() => _error = 'This camera or microphone could not be opened. Check permissions and try again.');
        Analytics.capture('commercial_device_check', {'result': 'failed'});
        _reportReady(false, generation);
      }
    }
  }

  Future<void> _readLevel() async {
    if (mounted) setState(() => _level = widget.controller.microphoneLevel);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _paused = state != AppLifecycleState.resumed;
    unawaited(_syncTracks());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _meterTimer?.cancel();
    ++_syncGeneration;
    unawaited(widget.controller.release());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, constraints) {
        final wide = constraints.maxWidth >= 600;
        final preview = _preview(context);
        final controls = _controls(context);
        return wide ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: preview), const SizedBox(width: Msg.s3), Flexible(child: controls)]) : Column(children: [preview, controls]);
      });

  Widget _preview(BuildContext context) {
    final track = widget.controller.cameraTrack;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 520),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(Msg.rLg),
        child: ColoredBox(
          color: Colors.black,
          child: AspectRatio(
            aspectRatio: 16 / 10,
            child: widget.showCameraPreview && track != null
                ? VideoTrackRenderer(videoTrack: track, mirror: track.mediaConstraints.facingMode == FacingMode.user)
                : Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Icon(_cameraMissing ? PhosphorIcons.microphone(PhosphorIconsStyle.bold) : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold), color: Colors.white, size: 48),
                    if (_cameraMissing) ...[
                      const SizedBox(height: Msg.s2),
                      Text('Audio only', style: ADText.preview(c: Colors.white)),
                    ],
                  ])),
          ),
        ),
      ),
    );
  }

  Widget _controls(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Camera on when I join'), subtitle: _cameraMissing ? const Text('No camera found on this device') : null, value: widget.cameraEnabled && !_cameraMissing, onChanged: widget.captureEnabled && !_cameraMissing ? widget.onCameraChanged : null),
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Microphone on when I join'), value: widget.microphoneEnabled, onChanged: widget.captureEnabled ? widget.onMicrophoneChanged : null),
        ListTile(contentPadding: EdgeInsets.zero, leading: Icon(widget.microphoneEnabled ? PhosphorIcons.microphone(PhosphorIconsStyle.bold) : PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)), title: const Text('Microphone check'), subtitle: Text(_level == null ? (widget.microphoneEnabled ? 'Waiting for microphone input…' : 'Microphone off') : 'Input level'), trailing: SizedBox(width: 110, child: LinearProgressIndicator(value: widget.microphoneEnabled ? (_level ?? 0) : 0)),),
        // [AV-AUDIO-ONLY-1] Says what happened AND that the session still
        // works — a bare "no camera" reads as a failure and makes people
        // abandon a slot they have already paid for.
        if (_cameraMissing)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Msg.s2),
            child: Text(
              "No camera found — you'll join with audio only; you'll still see the other person.",
              style: ADText.preview(),
            ),
          ),
        if (widget.speakerControl != null) widget.speakerControl!,
        if (_error != null) ...[Text(_error!, style: ADText.preview(c: AD.danger)), TextButton(onPressed: widget.captureEnabled ? () { widget.controller.clearCameraUnavailable(); unawaited(_syncTracks()); } : null, child: const Text('Retry device check'))],
      ]);
}
