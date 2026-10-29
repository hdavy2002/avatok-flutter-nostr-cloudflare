import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:video_player/video_player.dart';

import '../../../data/api_exception.dart';
import '../../../data/models/intro_onboarding.dart';
import '../../../data/repos/intro_onboarding_repo.dart';
import '../../../data/telemetry.dart';
import '../../desi.dart';
import '../../theme.dart';
import 'intro_onb_kit.dart';

/// What the recorder answers when the video was recorded AND sent: the server's draft video, and how many times she pressed Redo.
class IntroRecorderResult {
  const IntroRecorderResult({required this.video, required this.retakes, this.poster});

  final OnbVideo video;
  final int retakes;

  /// [HF-DESI-GAPS] The JPEG still taken when recording stopped (the same bytes sent as the poster), or null. The "Sent for
  /// approval" screen shows it in the gold frame.
  final Uint8List? poster;
}

/// [HF-INTRO-A1] Step 5 (designs "Recording", "Hold your phone upright"): live camera + microphone only (there is no gallery or file picker
/// anywhere), front camera first with a flip button, portrait only, 10 to 20 seconds, then a preview with Redo / Use this video, then the
/// upload. Open it with `Navigator.push<IntroRecorderResult>`; it pops the result, or null when she leaves.
class IntroRecorderScreen extends StatefulWidget {
  const IntroRecorderScreen({
    super.key,
    required this.repo,
    required this.lang,
    required this.topic,
    required this.hints,
    this.minSeconds = 10,
    this.maxSeconds = 20,
    this.initialRetakes = 0,
  });

  final IntroOnboardingRepo repo;

  /// Sent with the video (`x-lang`, `x-topic`).
  final String lang;
  final String topic;

  /// "You could say" lines for the strip at the top (tap the strip for the next one).
  final List<String> hints;
  final int minSeconds;
  final int maxSeconds;
  final int initialRetakes;

  @override
  State<IntroRecorderScreen> createState() => _IntroRecorderScreenState();
}

enum _Phase { permission, starting, ready, recording, review, uploading }

class _IntroRecorderScreenState extends State<IntroRecorderScreen> with WidgetsBindingObserver {
  _Phase _phase = _Phase.permission;
  CameraController? _cam;
  CameraDescription? _desc;
  List<CameraDescription> _cams = const <CameraDescription>[];

  bool _askedOnce = false;
  bool _permanentlyDenied = false;
  bool _sideways = false;
  bool _paused = false;
  bool _stopping = false;

  Timer? _timer;
  final Stopwatch _sw = Stopwatch();
  int _elapsedMs = 0;
  int _retakes = 0;
  int _hintIx = 0;

  String? _error;
  bool _retryable = false;
  bool _canUse = true;

  /// [HF-MOD-1] The take is the wrong length or too big: the big button becomes "Record again" and nothing is uploaded.
  bool _mustRedo = false;

  /// [HF-MOD-1] Same limit as the server (the Clef safety check takes at most 16 MB). A 20 s take is about 5 MB.
  static const int _maxBytes = 16 * 1024 * 1024;

  String? _path;
  Uint8List? _poster;
  Uint8List? _bytes;
  VideoPlayerController? _player;
  int _durationMs = 0;
  int _w = 0;
  int _h = 0;
  Size? _previewSize;

  int get _minMs => widget.minSeconds * 1000;
  int get _maxMs => widget.maxSeconds * 1000;

  /// The Done button opens 0.3 s after the minimum, so the saved file is never a hair under it.
  int get _doneMs => _minMs + 300;

  /// The take stops a moment before the maximum, so the saved file is never a hair over it.
  int get _autoStopMs => _maxMs - 150;

  /// [HF-MOD-1] Whole seconds still needed before Done unlocks (0 once the minimum is reached).
  int get _secondsToGo => _elapsedMs >= _doneMs ? 0 : ((_doneMs - _elapsedMs) / 1000).ceil();

  /// [HF-MOD-1] Same sentence as the server's: "Your video is 9 seconds. Please record between 10 and 20 seconds."
  String _lengthProblem(int ms) {
    final sec = ms < _minMs ? ms ~/ 1000 : (ms / 1000).ceil();
    return 'Your video is $sec second${sec == 1 ? '' : 's'}. Please record between ${widget.minSeconds} and ${widget.maxSeconds} seconds.';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _retakes = widget.initialRetakes;
    unawaited(_checkPermissions());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    final cam = _cam;
    if (cam != null) {
      cam.removeListener(_onCamValue);
      unawaited(cam.dispose());
    }
    unawaited(_player?.dispose());
    final p = _path;
    if (p != null) unawaited(_rm(p));
    super.dispose();
  }

  Future<void> _rm(String path) async {
    try {
      await File(path).delete();
    } catch (_) {
      // a leftover cache file is harmless
    }
  }

  // ------------------------------------------------------------------------------------------------------------ lifecycle

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!mounted) return;
    if (state == AppLifecycleState.resumed) {
      if (_phase == _Phase.permission && _askedOnce) {
        unawaited(_checkPermissions()); // back from Settings
      } else if (_phase == _Phase.ready && _cam == null) {
        unawaited(_initCamera());
      }
      return;
    }
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      if (_phase == _Phase.recording) {
        unawaited(() async {
          await _discardTake(message: 'Recording stopped because you left the app. Please record again.');
          await _closeCamera();
        }());
      } else if (_phase == _Phase.ready) {
        unawaited(_closeCamera());
      }
    }
  }

  // ----------------------------------------------------------------------------------------------------------- permission

  Future<void> _checkPermissions() async {
    final cam = await Permission.camera.status;
    final mic = await Permission.microphone.status;
    if (!mounted) return;
    if (cam.isGranted && mic.isGranted) {
      await _initCamera();
      return;
    }
    setState(() {
      _phase = _Phase.permission;
      _permanentlyDenied = cam.isPermanentlyDenied || mic.isPermanentlyDenied;
    });
  }

  Future<void> _request() async {
    _askedOnce = true;
    final res = await <Permission>[Permission.camera, Permission.microphone].request();
    if (!mounted) return;
    final cam = res[Permission.camera];
    final mic = res[Permission.microphone];
    if ((cam?.isGranted ?? false) && (mic?.isGranted ?? false)) {
      await _initCamera();
      return;
    }
    setState(() {
      _phase = _Phase.permission;
      _permanentlyDenied = (cam?.isPermanentlyDenied ?? false) || (mic?.isPermanentlyDenied ?? false);
      _error = 'Without the camera and microphone we cannot record your video.';
    });
  }

  // -------------------------------------------------------------------------------------------------------------- camera

  Future<void> _initCamera() async {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.starting;
      _error = null;
    });
    try {
      if (_cams.isEmpty) _cams = await availableCameras();
      if (_cams.isEmpty) {
        if (mounted) {
          setState(() {
            _phase = _Phase.permission;
            _error = 'We could not find a camera on this phone.';
          });
        }
        return;
      }
      final desc = _desc ?? _cams.firstWhere((c) => c.lensDirection == CameraLensDirection.front, orElse: () => _cams.first);
      await _openCamera(desc);
    } on CameraException {
      if (mounted) {
        setState(() {
          _phase = _Phase.permission;
          _error = 'We need your camera and microphone to record. Please allow them in Settings.';
          _permanentlyDenied = true;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _phase = _Phase.permission;
          _error = 'We could not start the camera. Please try again.';
        });
      }
    }
  }

  Future<void> _openCamera(CameraDescription desc) async {
    await _closeCamera();
    final c = CameraController(desc, ResolutionPreset.high, enableAudio: true, fps: 30, videoBitrate: 2000000, audioBitrate: 64000); // [HF-INTRO-P] ~5 MB per 20 s
    await c.initialize();
    if (!mounted) {
      await c.dispose();
      return;
    }
    try {
      await c.lockCaptureOrientation(DeviceOrientation.portraitUp); // portrait only, whatever the phone does
    } catch (_) {
      // some phones refuse; the upload check still rejects a sideways file
    }
    c.addListener(_onCamValue);
    setState(() {
      _cam = c;
      _desc = desc;
      _phase = _Phase.ready;
      _sideways = _isSideways(c.value.deviceOrientation);
    });
  }

  Future<void> _closeCamera() async {
    final c = _cam;
    if (c == null) return;
    _cam = null;
    c.removeListener(_onCamValue);
    if (mounted) setState(() {});
    try {
      await c.dispose();
    } catch (_) {
      // already gone
    }
  }

  static bool _isSideways(DeviceOrientation o) => o == DeviceOrientation.landscapeLeft || o == DeviceOrientation.landscapeRight;

  void _onCamValue() {
    final c = _cam;
    if (c == null || !mounted) return;
    final sideways = _isSideways(c.value.deviceOrientation);
    if (sideways == _sideways) return;
    setState(() => _sideways = sideways);
    if (_phase == _Phase.recording) unawaited(sideways ? _pauseTake() : _resumeTake());
  }

  Future<void> _flip() async {
    if (_phase != _Phase.ready) return;
    final cur = _desc;
    if (cur == null) return;
    CameraDescription? other;
    for (final c in _cams) {
      if (c.lensDirection != cur.lensDirection) {
        other = c;
        break;
      }
    }
    if (other == null) return;
    final target = other;
    setState(() => _phase = _Phase.starting);
    try {
      await _openCamera(target);
    } catch (_) {
      if (mounted) setState(() => _error = 'We could not switch the camera.');
      await _initCamera();
    }
  }

  // ------------------------------------------------------------------------------------------------------------ recording

  Future<void> _start() async {
    final c = _cam;
    if (c == null || _phase != _Phase.ready || _sideways) return;
    try {
      await c.startVideoRecording();
    } catch (_) {
      if (mounted) setState(() => _error = 'We could not start recording. Please try again.');
      return;
    }
    _sw
      ..reset()
      ..start();
    _stopping = false;
    if (!mounted) return;
    setState(() {
      _phase = _Phase.recording;
      _elapsedMs = 0;
      _paused = false;
      _error = null;
    });
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(milliseconds: 100), (_) => _tick());
  }

  void _tick() {
    if (!mounted || _paused || _phase != _Phase.recording) return;
    final ms = _sw.elapsedMilliseconds;
    setState(() => _elapsedMs = ms);
    if (ms >= _autoStopMs) unawaited(_finish());
  }

  Future<void> _pauseTake() async {
    final c = _cam;
    if (c == null || _paused) return;
    _paused = true;
    _sw.stop();
    try {
      await c.pauseVideoRecording();
    } catch (_) {
      // cannot pause on this phone: throw the take away, she records again upright
      await _discardTake(message: 'Please hold your phone upright. Record again when you are ready.');
    }
  }

  Future<void> _resumeTake() async {
    final c = _cam;
    if (c == null || !_paused) return;
    try {
      await c.resumeVideoRecording();
      _paused = false;
      _sw.start();
    } catch (_) {
      await _discardTake(message: 'The recording stopped. Please record again.');
    }
  }

  /// Stops the take and throws it away (Redo while recording, leaving the app, a phone that cannot pause).
  Future<void> _discardTake({String? message}) async {
    final c = _cam;
    _timer?.cancel();
    _sw.stop();
    if (c != null && _phase == _Phase.recording) {
      try {
        final f = await c.stopVideoRecording();
        unawaited(_rm(f.path));
      } catch (_) {
        // nothing was saved
      }
    }
    _retakes += 1;
    if (!mounted) return;
    setState(() {
      _phase = _cam == null ? _Phase.starting : _Phase.ready;
      _paused = false;
      _elapsedMs = 0;
      _error = message;
    });
    if (_cam == null) unawaited(_initCamera());
  }

  void _tapStop() {
    if (_elapsedMs < _doneMs) {
      final n = _secondsToGo;
      setState(() => _error = 'Keep going — $n more second${n == 1 ? '' : 's'}. Your video needs ${widget.minSeconds} to ${widget.maxSeconds} seconds.');
      return;
    }
    unawaited(_finish());
  }

  Future<void> _finish() async {
    final c = _cam;
    if (c == null || _phase != _Phase.recording || _stopping) return;
    _stopping = true;
    _timer?.cancel();
    _sw.stop();
    final recordedMs = _sw.elapsedMilliseconds;
    XFile? file;
    try {
      file = await c.stopVideoRecording();
    } catch (_) {
      file = null;
    }
    if (file == null) {
      _stopping = false;
      if (mounted) {
        setState(() {
          _phase = _Phase.ready;
          _error = 'The video did not save. Please try again.';
        });
      }
      return;
    }
    final ps = c.value.previewSize;
    _previewSize = ps;
    Uint8List? poster;
    try {
      final shot = await c.takePicture().timeout(const Duration(seconds: 3));
      final b = await shot.readAsBytes();
      unawaited(_rm(shot.path));
      if (b.isNotEmpty && b.length <= 2 * 1024 * 1024) poster = b;
    } catch (_) {
      poster = null; // no poster is fine
    }
    _poster = poster;
    _path = file.path;
    Telemetry.event('hf_intro_record', {'duration_ms': recordedMs, 'retake_n': _retakes});
    await _closeCamera();
    await _openReview(file.path, recordedMs);
  }

  // -------------------------------------------------------------------------------------------------------------- review

  Future<void> _openReview(String path, int recordedMs) async {
    await _player?.dispose();
    _player = null;
    var durationMs = recordedMs;
    var w = 0;
    var h = 0;
    VideoPlayerController? p;
    try {
      p = VideoPlayerController.file(File(path));
      await p.initialize();
      await p.setLooping(true);
      final real = p.value.duration.inMilliseconds;
      if (real > 0) durationMs = real;
      w = p.value.size.width.round();
      h = p.value.size.height.round();
      unawaited(p.play());
    } catch (_) {
      await p?.dispose();
      p = null;
    }
    if (w <= 0 || h <= 0) {
      // no preview on this phone: use the camera's own size, turned upright
      final ps = _previewSize;
      if (ps != null) {
        w = ps.width < ps.height ? ps.width.round() : ps.height.round();
        h = ps.width < ps.height ? ps.height.round() : ps.width.round();
      }
    }
    _bytes = null;
    _durationMs = durationMs;
    _w = w;
    _h = h;
    _player = p;
    var size = 0;
    try {
      size = await File(path).length();
    } catch (_) {
      size = 0; // the upload step reads it again and says so
    }
    String? problem;
    // [HF-MOD-1] Refused HERE, before anything goes to Cloudflare: under 10 s, over 20 s, or over 16 MB.
    if (durationMs < _minMs || durationMs > _maxMs + 500) {
      problem = _lengthProblem(durationMs);
      Telemetry.event('hf_intro_record', {'duration_ms': durationMs, 'retake_n': _retakes, 'refused_reason': durationMs < _minMs ? 'too_short' : 'too_long'});
    } else if (size > _maxBytes) {
      problem = 'This video file is too big (${(size / (1024 * 1024)).toStringAsFixed(1)} MB). Please record it again.';
      Telemetry.event('hf_intro_record', {'duration_ms': durationMs, 'retake_n': _retakes, 'bytes': size, 'refused_reason': 'too_large'});
    } else if (w > 0 && h > 0 && w >= h) {
      problem = 'The video came out sideways. Please hold your phone upright and record again.';
    }
    if (!mounted) return;
    setState(() {
      _phase = _Phase.review;
      _error = problem;
      _canUse = problem == null;
      _mustRedo = problem != null;
      _retryable = false;
      _stopping = false;
    });
  }

  Future<void> _redo() async {
    if (_phase == _Phase.uploading) return;
    _retakes += 1;
    await _player?.dispose();
    _player = null;
    final p = _path;
    if (p != null) unawaited(_rm(p));
    _path = null;
    _poster = null;
    _bytes = null;
    if (!mounted) return;
    setState(() {
      _error = null;
      _elapsedMs = 0;
      _hintIx = 0;
      _mustRedo = false;
    });
    await _initCamera();
  }

  Future<void> _use() async {
    final path = _path;
    if (path == null || _phase == _Phase.uploading) return;
    setState(() {
      _phase = _Phase.uploading;
      _error = null;
    });
    final sw = Stopwatch()..start();
    var size = 0;
    try {
      final bytes = _bytes ??= await File(path).readAsBytes();
      size = bytes.length;
      final video = await widget.repo.uploadVideo(
        bytes,
        durationMs: _durationMs,
        width: _w > 0 ? _w : 720,
        height: _h > 0 ? _h : 1280,
        lang: widget.lang,
        topic: widget.topic,
      );
      Telemetry.event('hf_intro_upload', {'bytes': size, 'ms': sw.elapsedMilliseconds, 'ok': true});
      final poster = _poster;
      if (poster != null) {
        try {
          await widget.repo.uploadPoster(video.id, poster);
        } catch (_) {
          // the video is in; a missing poster only means a plain frame in the review list
        }
      }
      if (!mounted) return;
      Navigator.of(context).pop(IntroRecorderResult(video: video, retakes: _retakes, poster: poster));
    } on ApiException catch (e) {
      Telemetry.event('hf_intro_upload', {'bytes': size, 'ms': sw.elapsedMilliseconds, 'ok': false, 'reason': e.code});
      if (!mounted) return;
      final retry = e.isOffline || e.status >= 500 || e.code == 'store_failed';
      setState(() {
        _phase = _Phase.review;
        _error = _uploadProblem(e);
        _retryable = retry;
        _canUse = retry;
        _mustRedo = !retry;
      });
    } catch (_) {
      Telemetry.event('hf_intro_upload', {'bytes': size, 'ms': sw.elapsedMilliseconds, 'ok': false, 'reason': 'read'});
      if (!mounted) return;
      setState(() {
        _phase = _Phase.review;
        _error = 'We could not read the video. Please record it again.';
        _retryable = false;
        _canUse = false;
        _mustRedo = true;
      });
    }
  }

  String _uploadProblem(ApiException e) {
    switch (e.code) {
      case 'too_short':
      case 'too_long':
      case 'duration_unreadable':
        // [HF-MOD-1] the server measured the file itself; its sentence says how long it really was
        return e.userMessage;
      case 'not_portrait':
        return 'Please hold your phone upright and record again.';
      case 'too_large':
        return 'The video file is too big. Please record it again.';
      case 'unsupported_type':
      case 'empty_video':
        return 'We could not use that video. Please record it again.';
      case 'store_failed':
        return 'We could not save your video just now. Please try sending it again.';
    }
    if (e.isOffline) return 'No internet. Check your connection, then tap Send again.';
    return e.userMessage;
  }

  Future<void> _close() async {
    if (_phase == _Phase.uploading) return;
    if (_phase == _Phase.recording) {
      await _discardTake();
    }
    if (mounted) Navigator.of(context).pop();
  }

  // ------------------------------------------------------------------------------------------------------------------ UI

  String _clock(int ms) {
    final s = ms ~/ 1000;
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  Widget _roundButton({required IconData icon, required String label, required VoidCallback? onTap}) => Semantics(
        button: true,
        label: label,
        onTap: onTap,
        excludeSemantics: true,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(shape: BoxShape.circle, color: IO.camScrim, border: Border.all(color: IO.camLine, width: 2)),
            child: Icon(icon, color: IO.onCamera, size: 26),
          ),
        ),
      );

  Widget _cameraFill() {
    final c = _cam;
    if (c == null || !c.value.isInitialized) return const SizedBox.shrink();
    final size = c.value.previewSize;
    if (size == null) return SizedBox.expand(child: CameraPreview(c));
    return SizedBox.expand(
      child: FittedBox(
        fit: BoxFit.cover,
        clipBehavior: Clip.hardEdge,
        child: SizedBox(width: size.height, height: size.width, child: CameraPreview(c)),
      ),
    );
  }

  Widget _darkPage({required Widget child}) => Scaffold(
        backgroundColor: IO.cameraBg,
        body: DecoratedBox(
          decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF6B2468), IO.cameraBg])),
          child: SafeArea(child: child),
        ),
      );

  /// [HF-DESI-ONB] The saffron frame and the two corner marigolds of the camera design (Record). Never over text: the
  /// flowers sit in the screen corners above the safe area, the frame is a thin edge.
  Widget _frame() => IgnorePointer(
        child: Stack(children: [
          Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(border: Border.all(color: IO.camLine, width: 5)))),
          const Positioned(left: -18, top: -18, child: Marigold(size: 60, yellow: true)),
          const Positioned(right: -18, top: -18, child: Marigold(size: 60, yellow: true)),
        ]),
      );

  Widget _permissionView() {
    return _darkPage(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Align(alignment: Alignment.centerLeft, child: OnbBackButton(onTap: () => unawaited(_close()), dark: true)),
          const Spacer(),
          const Icon(Icons.videocam_rounded, color: IO.gold, size: 72),
          const SizedBox(height: 18),
          Text('We need your camera and microphone', textAlign: TextAlign.center, style: t(26, color: IO.onCamera, w: FontWeight.w800, h: 1.15)),
          const SizedBox(height: 12),
          Text(
            'You record a short live video of yourself. Nothing is uploaded from your gallery, and nobody sees it until our team approves it.',
            textAlign: TextAlign.center,
            style: t(16, color: IO.onCameraSoft, w: FontWeight.w600, h: 1.5),
          ),
          if (_error != null) ...[const SizedBox(height: 14), Text(_error!, textAlign: TextAlign.center, style: t(15, color: IO.gold, w: FontWeight.w800, h: 1.4))],
          const Spacer(),
          if (_permanentlyDenied)
            OnbPrimaryButton(label: 'Open Settings', onTap: () {
              _askedOnce = true;
              unawaited(openAppSettings());
            })
          else
            OnbPrimaryButton(label: 'Allow camera and microphone', onTap: () => unawaited(_request())),
        ]),
      ),
    );
  }

  Widget _uprightView() {
    return DecoratedBox(
      decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF4A1747), IO.cameraBg])),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 420),
            decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(26), border: Border.all(color: IO.line, width: 1.5), boxShadow: IO.shadow),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(26),
              child: Stack(children: [
                const Positioned(left: -16, top: -16, child: Marigold(size: 62, yellow: true)),
                const Positioned(right: -16, top: -16, child: Marigold(size: 74)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(22, 30, 22, 24),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                      width: 92,
                      height: 92,
                      alignment: Alignment.center,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0xFFF6E3C0)),
                      child: const Icon(Icons.screen_rotation_rounded, color: IO.plum, size: 44),
                    ),
                    const SizedBox(height: 16),
                    Semantics(liveRegion: true, child: Text('Please hold your phone upright', textAlign: TextAlign.center, style: t(24, color: IO.ink, w: FontWeight.w800, h: 1.15))),
                    const SizedBox(height: 10),
                    Text('Reels are tall, like your phone. Turn it upright and recording will start working again.', textAlign: TextAlign.center, style: t(15, color: IO.muted, w: FontWeight.w700, h: 1.5)),
                    const SizedBox(height: 18),
                    Container(
                      width: double.infinity,
                      height: 52,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: C.sand, borderRadius: BorderRadius.circular(999), border: Border.all(color: IO.line, width: 1.5)),
                      child: Text('Record button is paused', style: t(15, color: IO.plum, w: FontWeight.w800)),
                    ),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _progressBar() {
    final frac = (_elapsedMs / _maxMs).clamp(0.0, 1.0).toDouble();
    final minFrac = (_minMs / _maxMs).clamp(0.0, 1.0).toDouble();
    final recording = _phase == _Phase.recording;
    final toGo = _secondsToGo;
    final left = ((_maxMs - _elapsedMs) / 1000).ceil().clamp(0, widget.maxSeconds);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
      child: Column(children: [
        // [HF-MOD-1] live nudge: she always knows how long is left before Done unlocks, and before it stops
        if (recording)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Semantics(
              liveRegion: true,
              child: Text(
                toGo > 0 ? 'Keep going — $toGo more second${toGo == 1 ? '' : 's'}' : 'You can stop now · $left s left',
                textAlign: TextAlign.center,
                style: t(17, color: toGo > 0 ? IO.gold : IO.onCamera, w: FontWeight.w900),
              ),
            ),
          ),
        LayoutBuilder(
          builder: (context, box) => SizedBox(
            height: 20,
            child: Stack(clipBehavior: Clip.none, alignment: Alignment.centerLeft, children: [
              Container(height: 8, decoration: BoxDecoration(color: IO.camTrack, borderRadius: BorderRadius.circular(99))),
              Container(width: box.maxWidth * frac, height: 8, decoration: BoxDecoration(gradient: const LinearGradient(colors: [IO.orange, IO.yellow]), borderRadius: BorderRadius.circular(99))),
              Positioned(left: box.maxWidth * minFrac - 1.5, top: 0, child: Container(width: 3, height: 20, color: IO.onCamera)),
            ]),
          ),
        ),
        const SizedBox(height: 6),
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text('0 s', style: t(14, color: IO.onCamera, w: FontWeight.w800)),
          Text('${widget.minSeconds} s min', style: t(14, color: IO.onCamera, w: FontWeight.w800)),
          Text('${widget.maxSeconds} s max', style: t(14, color: IO.onCamera, w: FontWeight.w800)),
        ]),
      ]),
    );
  }

  Widget _smallPill({required String label, required VoidCallback? onTap, required bool filled}) => Semantics(
        button: true,
        enabled: onTap != null,
        label: label,
        onTap: onTap,
        excludeSemantics: true,
        child: Opacity(
          opacity: onTap == null ? 0.45 : 1,
          child: InkWell(
            borderRadius: BorderRadius.circular(999),
            onTap: onTap,
            child: Container(
              width: 72,
              height: 48,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: filled ? IO.yellow : IO.camScrim,
                borderRadius: BorderRadius.circular(999),
                border: filled ? null : Border.all(color: IO.camLine, width: 2),
              ),
              child: Text(label, style: t(15, color: filled ? IO.onYellow : IO.onCamera, w: FontWeight.w800)),
            ),
          ),
        ),
      );

  Widget _recordView() {
    final recording = _phase == _Phase.recording;
    final canDone = recording && _elapsedMs >= _doneMs;
    final hint = widget.hints.isEmpty ? null : widget.hints[_hintIx % widget.hints.length];
    return Scaffold(
      backgroundColor: IO.cameraBg,
      body: Stack(fit: StackFit.expand, children: [
        _cameraFill(),
        SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                _roundButton(icon: Icons.close_rounded, label: 'Close', onTap: () => unawaited(_close())),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(color: IO.camScrim, borderRadius: BorderRadius.circular(999)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: recording ? IO.recDot : IO.camLine)),
                    const SizedBox(width: 8),
                    Text(recording ? 'REC ${_clock(_elapsedMs)}' : 'Ready', style: t(14, color: IO.onCamera, w: FontWeight.w800)),
                  ]),
                ),
                _roundButton(icon: Icons.cameraswitch_rounded, label: 'Flip camera', onTap: recording || _cams.length < 2 ? null : () => unawaited(_flip())),
              ]),
            ),
            if (hint != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Semantics(
                  button: true,
                  label: 'Idea to say. Tap for the next one. $hint',
                  excludeSemantics: true,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(16),
                    onTap: () => setState(() => _hintIx += 1),
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(color: IO.camScrim, borderRadius: BorderRadius.circular(16), border: Border.all(color: IO.gold, width: 1.2)),
                      child: Text.rich(TextSpan(children: [
                        TextSpan(text: 'Hint · ', style: t(14, color: IO.gold, w: FontWeight.w800)),
                        TextSpan(text: hint, style: t(14, color: IO.onCamera, w: FontWeight.w600, h: 1.45)),
                      ])),
                    ),
                  ),
                ),
              ),
            const Spacer(),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Text(_error!, textAlign: TextAlign.center, style: t(15, color: IO.gold, w: FontWeight.w800, h: 1.35)),
              ),
            _progressBar(),
            Padding(
              padding: const EdgeInsets.fromLTRB(0, 8, 0, 14),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.center, children: [
                _smallPill(label: 'Redo', onTap: recording ? () => unawaited(_discardTake()) : null, filled: false),
                const SizedBox(width: 30),
                Semantics(
                  button: true,
                  label: recording ? 'Stop recording' : 'Start recording',
                  onTap: recording ? _tapStop : () => unawaited(_start()),
                  excludeSemantics: true,
                  child: InkWell(
                    customBorder: const CircleBorder(),
                    onTap: recording ? _tapStop : () => unawaited(_start()),
                    child: Container(
                      width: 86,
                      height: 86,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(shape: BoxShape.circle, color: IO.white, border: Border.all(color: IO.yellow, width: 6)),
                      child: recording
                          ? Container(width: 32, height: 32, decoration: BoxDecoration(color: IO.pink, borderRadius: BorderRadius.circular(8)))
                          : Container(width: 58, height: 58, decoration: const BoxDecoration(color: IO.pink, shape: BoxShape.circle)),
                    ),
                  ),
                ),
                const SizedBox(width: 30),
                _smallPill(label: 'Done', onTap: canDone ? () => unawaited(_finish()) : null, filled: true),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
              child: Text(
                recording ? 'Live recording only · keep your phone upright' : 'Tap the big button to start · live recording only',
                textAlign: TextAlign.center,
                style: t(14, color: IO.onCameraSoft, w: FontWeight.w700),
              ),
            ),
          ]),
        ),
        _frame(),
        if (_sideways)
          Positioned.fill(
            child: Stack(children: [
              _uprightView(),
              SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 10, 16, 0), child: _roundButton(icon: Icons.close_rounded, label: 'Close', onTap: () => unawaited(_close())))),
            ]),
          ),
      ]),
    );
  }

  Widget _reviewView() {
    final p = _player;
    final uploading = _phase == _Phase.uploading;
    final seconds = (_durationMs / 1000).toStringAsFixed(0);
    return Scaffold(
      backgroundColor: IO.cameraBg,
      body: SafeArea(
        child: Stack(children: [
          Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Row(children: [
                _roundButton(icon: Icons.close_rounded, label: 'Close', onTap: uploading ? null : () => unawaited(_close())),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(color: IO.camScrim, borderRadius: BorderRadius.circular(999)),
                  child: Text('Your video · $seconds s', style: t(14, color: IO.onCamera, w: FontWeight.w800)),
                ),
              ]),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
                child: Center(
                  child: p != null && p.value.isInitialized
                      ? GestureDetector(
                          onTap: () => setState(() => p.value.isPlaying ? unawaited(p.pause()) : unawaited(p.play())),
                          child: ClipRRect(borderRadius: BorderRadius.circular(20), child: AspectRatio(aspectRatio: p.value.aspectRatio, child: VideoPlayer(p))),
                        )
                      : Text('Your video is saved. We could not show a preview on this phone.', textAlign: TextAlign.center, style: t(16, color: IO.onCameraSoft, w: FontWeight.w700, h: 1.45)),
                ),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 10),
                child: Text(_error!, textAlign: TextAlign.center, style: t(15, color: IO.gold, w: FontWeight.w800, h: 1.4)),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
              child: Row(children: [
                if (!_mustRedo) ...[
                SizedBox(
                  width: 110,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(999),
                    onTap: uploading ? null : () => unawaited(_redo()),
                    child: Container(
                      height: 58,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: IO.camScrim, borderRadius: BorderRadius.circular(999), border: Border.all(color: IO.camLine, width: 2)),
                      child: Text('Redo', style: t(17, color: IO.onCamera, w: FontWeight.w800)),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                ],
                Expanded(
                  child: OnbPrimaryButton(
                    // [HF-MOD-1] a wrong-length or too-big take can only be recorded again; nothing is uploaded
                    label: _mustRedo ? 'Record again' : (_retryable ? 'Send again' : 'Use this video'),
                    enabled: _mustRedo || _canUse,
                    busy: uploading,
                    onTap: () => unawaited(_mustRedo ? _redo() : _use()),
                  ),
                ),
              ]),
            ),
          ]),
          if (uploading)
            Positioned.fill(
              child: Container(
                color: IO.camScrim,
                alignment: Alignment.center,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const SizedBox(width: 44, height: 44, child: CircularProgressIndicator(strokeWidth: 4, color: IO.yellow)),
                  const SizedBox(height: 14),
                  Text('Sending your video…', style: t(18, color: IO.onCamera, w: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text('Please keep the app open.', style: t(14, color: IO.onCameraSoft, w: FontWeight.w700)),
                ]),
              ),
            ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final Widget body;
    switch (_phase) {
      case _Phase.permission:
        body = _permissionView();
      case _Phase.starting:
        body = _darkPage(child: const Center(child: CircularProgressIndicator(color: IO.yellow)));
      case _Phase.ready:
      case _Phase.recording:
        body = _recordView();
      case _Phase.review:
      case _Phase.uploading:
        body = _reviewView();
    }
    return PopScope(
      canPop: _phase != _Phase.uploading && _phase != _Phase.recording,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _phase == _Phase.recording) unawaited(_close());
      },
      child: body,
    );
  }
}
