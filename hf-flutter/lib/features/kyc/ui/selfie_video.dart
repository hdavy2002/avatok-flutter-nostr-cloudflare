import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/kyc_api.dart';
import '../data/kyc_telemetry.dart';
import '../data/permission_service.dart';
import '../data/selfie_recorder.dart';
import 'kyc_copy.dart';
import 'kyc_parts.dart';
import 'permission_gate.dart';

/// The selfie video is exactly this long (spec 2.13).
const int kSelfieSeconds = 10;

/// The shared selfie-video widget (HF-NATIVE-8): "prove you are a real person".
///
/// 1. Gets a 4-digit code from the worker (`selfie/code`) and shows it large, with the line to say out loud.
/// 2. The person ticks the consent box and opens the camera, after the camera and microphone explainer
///    ([PermissionGate]: explainer, Android prompt, "Open settings" after a denial).
/// 3. FRONT camera, medium quality. A 3-2-1 countdown, then it records for exactly [recordSeconds] (10 s)
///    and stops by itself. The code stays on the preview the whole time.
/// 4. Review: "Use this video" or "Record again" (no playback inside the app: the 17-package list has no video player).
/// 5. Upload with a progress bar: raw video body, `x-selfie-code`, at most 12 MB, `video/mp4`.
///    `code_expired` and `code_mismatch` fetch a new code; `too_large` sends the person back to record again.
///
/// [onUploaded] runs once when the worker answered `{ok, status:"pending"}`.
class SelfieVideoWidget extends ConsumerStatefulWidget {
  const SelfieVideoWidget({
    super.key,
    required this.onUploaded,
    this.recordSeconds = kSelfieSeconds,
    this.countdownSeconds = 3,
  });

  final VoidCallback onUploaded;

  /// Length of the recording. Tests use a short one; the app always uses [kSelfieSeconds].
  final int recordSeconds;
  final int countdownSeconds;

  @override
  ConsumerState<SelfieVideoWidget> createState() => _SelfieVideoState();
}

enum _Step { ready, camera, review, uploading, done }

class _SelfieVideoState extends ConsumerState<SelfieVideoWidget> {
  String? _code;
  String? _codeError;
  bool _consent = false;
  _Step _step = _Step.ready;
  SelfieClip? _clip;
  double _progress = 0;
  String? _error;

  KycApi get _api => ref.read(kycApiProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_loadCode());
  }

  Future<void> _loadCode() async {
    setState(() {
      _code = null;
      _codeError = null;
    });
    try {
      final code = await _api.selfieCode();
      if (!mounted) return;
      setState(() => _code = code);
    } on ApiError catch (e) {
      if (!mounted) return;
      KycTelemetry.kycStep('selfie_code', 'error', reason: e.code, status: e.status);
      setState(() => _codeError = e.userMessage);
    }
  }

  void _onClip(SelfieClip clip) {
    if (clip.bytes.length > kSelfieMaxBytes) {
      KycTelemetry.kycStep('selfie_upload', 'error', reason: 'too_large_local');
      setState(() {
        _step = _Step.ready;
        _error = KycCopy.tooLargeLocal;
      });
      return;
    }
    if (clip.bytes.length < kSelfieMinBytes) {
      KycTelemetry.kycStep('selfie_upload', 'error', reason: 'too_small_local');
      setState(() {
        _step = _Step.ready;
        _error = KycCopy.tooSmallLocal;
      });
      return;
    }
    setState(() {
      _clip = clip;
      _step = _Step.review;
      _error = null;
    });
  }

  Future<void> _upload() async {
    final clip = _clip;
    final code = _code;
    if (clip == null || code == null || _step == _Step.uploading) return;
    setState(() {
      _step = _Step.uploading;
      _progress = 0;
      _error = null;
    });
    try {
      await _api.uploadSelfie(
        bytes: clip.bytes,
        mime: clip.mime,
        code: code,
        onProgress: (sent, total) {
          if (mounted && total > 0) setState(() => _progress = sent / total);
        },
      );
      if (!mounted) return;
      KycTelemetry.kycStep('selfie_upload', 'ok');
      setState(() => _step = _Step.done);
      widget.onUploaded();
    } on ApiError catch (e) {
      if (!mounted) return;
      KycTelemetry.kycStep('selfie_upload', 'error', reason: e.code, status: e.status);
      switch (e.code) {
        case 'code_expired':
        case 'code_mismatch':
          // The code is no good any more: get a new one and record again.
          setState(() {
            _step = _Step.ready;
            _clip = null;
            _error = e.code == 'code_expired' ? KycCopy.codeExpired : e.userMessage;
          });
          unawaited(_loadCode());
        case 'too_large':
        case 'too_small':
        case 'unsupported_type':
          setState(() {
            _step = _Step.ready;
            _clip = null;
            _error = e.userMessage;
          });
        default:
          // No internet, too many tries, a server fault: the video is kept, the person can send it again.
          setState(() {
            _step = _Step.review;
            _error = e.userMessage;
          });
      }
    }
  }

  void _recordAgain() => setState(() {
        _clip = null;
        _step = _Step.ready;
        _error = null;
      });

  @override
  Widget build(BuildContext context) {
    switch (_step) {
      case _Step.camera:
        return PermissionGate(
          permissions: const [HfPermission.camera, HfPermission.mic],
          icon: Icons.videocam_rounded,
          title: KycCopy.cameraTitle,
          body: '${KycCopy.cameraWhy} ${KycCopy.cameraWhyMic}',
          onSkip: () => setState(() => _step = _Step.ready),
          child: _CameraStage(
            code: _code ?? '',
            recordSeconds: widget.recordSeconds,
            countdownSeconds: widget.countdownSeconds,
            onClip: _onClip,
            onCancel: () => setState(() => _step = _Step.ready),
          ),
        );
      case _Step.review:
      case _Step.uploading:
        return _review();
      case _Step.done:
        return const HfCard(
          key: ValueKey<String>('selfie-done'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DoneRow(KycCopy.videoSent),
              SizedBox(height: 8),
              Text(KycCopy.videoSentBody, style: HfText.bodyText),
            ],
          ),
        );
      case _Step.ready:
        return _ready();
    }
  }

  Widget _ready() {
    final code = _code;
    final spaced = code == null ? '' : code.split('').join(' ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const HfScene(kind: HfSceneKind.verify, height: 100),
        const SizedBox(height: 16),
        const Text(KycCopy.selfieTitle, style: HfText.title),
        const SizedBox(height: 8),
        const Text(KycCopy.selfieLead, style: HfText.bodyText),
        const SizedBox(height: 16),
        HfCard(
          color: HfColors.sky,
          child: Column(
            children: [
              const Text(KycCopy.yourCode, style: HfText.label),
              const SizedBox(height: 4),
              Semantics(
                label: code == null ? KycCopy.gettingCode : '${KycCopy.yourCode} $spaced',
                excludeSemantics: true,
                child: Text(
                  code ?? '····',
                  key: const ValueKey<String>('selfie-code'),
                  style: HfText.hero.copyWith(fontSize: 32, letterSpacing: 4),
                ),
              ),
              const SizedBox(height: 8),
              if (_codeError != null) ...[
                InlineError(_codeError!),
                HfButton(
                  key: const ValueKey<String>('selfie-code-retry'),
                  label: 'Try again',
                  kind: HfButtonKind.text,
                  expand: false,
                  onPressed: () => unawaited(_loadCode()),
                ),
              ] else if (code == null)
                const Text(KycCopy.gettingCode, style: HfText.note)
              else
                Text(
                  'Look at the camera and say: Mera code $spaced hai',
                  style: HfText.bodyText,
                  textAlign: TextAlign.center,
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        ConsentRow(
          key: const ValueKey<String>('selfie-consent'),
          value: _consent,
          onChanged: (v) => setState(() => _consent = v),
          text: KycCopy.selfieConsent,
        ),
        if (_error != null) InlineError(_error!),
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('selfie-open-camera'),
          label: KycCopy.openCamera,
          icon: Icons.videocam_rounded,
          onPressed: _consent && code != null ? () => setState(() => _step = _Step.camera) : null,
        ),
      ],
    );
  }

  Widget _review() {
    final clip = _clip;
    final uploading = _step == _Step.uploading;
    final mb = clip == null ? '' : (clip.bytes.length / (1024 * 1024)).toStringAsFixed(1);
    return Column(
      key: const ValueKey<String>('selfie-review'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        HfCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const DoneRow(KycCopy.videoReady),
              const SizedBox(height: 8),
              if (clip != null) Text('${clip.seconds} s, $mb MB', style: HfText.note),
              if (uploading) ...[
                const SizedBox(height: 16),
                const Text(KycCopy.uploading, style: HfText.bodyText, semanticsLabel: KycCopy.uploading),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: LinearProgressIndicator(
                    key: const ValueKey<String>('selfie-progress'),
                    value: _progress,
                    minHeight: 10,
                    backgroundColor: HfColors.lilac,
                    color: HfColors.orchid,
                  ),
                ),
              ],
            ],
          ),
        ),
        if (_error != null) InlineError(_error!),
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('selfie-upload'),
          label: KycCopy.useThisVideo,
          loading: uploading,
          onPressed: _upload,
        ),
        const SizedBox(height: 8),
        HfButton(
          key: const ValueKey<String>('selfie-again'),
          label: KycCopy.recordAgain,
          kind: HfButtonKind.secondary,
          onPressed: uploading ? null : _recordAgain,
        ),
      ],
    );
  }
}

enum _Cam { opening, idle, countdown, recording, stopping, error }

/// The live camera: preview, the code on top of it, the countdown and the 10 second recording.
class _CameraStage extends ConsumerStatefulWidget {
  const _CameraStage({
    required this.code,
    required this.recordSeconds,
    required this.countdownSeconds,
    required this.onClip,
    required this.onCancel,
  });

  final String code;
  final int recordSeconds;
  final int countdownSeconds;
  final void Function(SelfieClip clip) onClip;
  final VoidCallback onCancel;

  @override
  ConsumerState<_CameraStage> createState() => _CameraStageState();
}

class _CameraStageState extends ConsumerState<_CameraStage> {
  late final SelfieRecorder _recorder;
  _Cam _cam = _Cam.opening;
  int _left = 0;
  Timer? _timer;
  String? _problem;
  bool _denied = false;

  @override
  void initState() {
    super.initState();
    _recorder = ref.read(selfieRecorderFactoryProvider)();
    unawaited(_open());
  }

  @override
  void dispose() {
    _timer?.cancel();
    unawaited(_recorder.dispose());
    super.dispose();
  }

  Future<void> _open() async {
    setState(() {
      _cam = _Cam.opening;
      _problem = null;
      _denied = false;
    });
    try {
      await _recorder.open();
      if (!mounted) return;
      setState(() => _cam = _Cam.idle);
    } on SelfieRecorderException catch (e) {
      if (!mounted) return;
      _fail(e);
    }
  }

  void _fail(SelfieRecorderException e) {
    KycTelemetry.permission('camera', e.isDenied ? 'denied' : 'error');
    _timer?.cancel();
    setState(() {
      _cam = _Cam.error;
      _denied = e.isDenied;
      _problem = e.isDenied
          ? KycCopy.cameraOff
          : (e.code == 'no_camera' ? KycCopy.noCamera : KycCopy.cameraFailed);
    });
  }

  void _begin() {
    if (_cam != _Cam.idle) return;
    if (widget.countdownSeconds <= 0) {
      unawaited(_record());
      return;
    }
    setState(() {
      _cam = _Cam.countdown;
      _left = widget.countdownSeconds;
    });
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      if (_left <= 1) {
        t.cancel();
        unawaited(_record());
      } else {
        setState(() => _left -= 1);
      }
    });
  }

  Future<void> _record() async {
    try {
      await _recorder.start();
    } on SelfieRecorderException catch (e) {
      if (mounted) _fail(e);
      return;
    }
    if (!mounted) return;
    setState(() {
      _cam = _Cam.recording;
      _left = widget.recordSeconds;
    });
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      if (_left <= 1) {
        t.cancel();
        unawaited(_stop());
      } else {
        setState(() => _left -= 1);
      }
    });
  }

  Future<void> _stop() async {
    setState(() {
      _left = 0;
      _cam = _Cam.stopping;
    });
    try {
      final clip = await _recorder.stop();
      if (!mounted) return;
      widget.onClip(clip);
    } on SelfieRecorderException catch (e) {
      if (mounted) _fail(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cam == _Cam.error) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InfoBox(
            key: const ValueKey<String>('camera-problem'),
            title: _problem ?? KycCopy.cameraFailed,
            body: _denied ? KycCopy.cameraOffHelp : null,
            color: HfColors.blush,
          ),
          const SizedBox(height: 16),
          if (_denied)
            HfButton(
              key: const ValueKey<String>('camera-open-settings'),
              label: 'Open settings',
              onPressed: () => unawaited(ref.read(permissionServiceProvider).openSettings()),
            ),
          if (_denied) const SizedBox(height: 8),
          HfButton(
            key: const ValueKey<String>('camera-retry'),
            label: 'Try again',
            kind: _denied ? HfButtonKind.secondary : HfButtonKind.primary,
            onPressed: () => unawaited(_open()),
          ),
          HfButton(label: KycCopy.cancel, kind: HfButtonKind.text, onPressed: widget.onCancel),
        ],
      );
    }
    final live = _cam == _Cam.countdown || _cam == _Cam.recording || _cam == _Cam.stopping;
    final spaced = widget.code.split('').join(' ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(HfRadius.card),
          child: SizedBox(
            height: MediaQuery.textScalerOf(context).scale(14) > 20 ? 560 : 420,
            child: Stack(
              fit: StackFit.expand,
              children: [
                const ColoredBox(color: HfColors.plum),
                if (_cam != _Cam.opening) Center(child: _recorder.buildPreview(context)),
                if (_cam == _Cam.opening) const Center(child: CircularProgressIndicator(color: HfColors.cream)),
                Positioned(
                  left: 12,
                  right: 12,
                  top: 12,
                  child: Container(
                    key: const ValueKey<String>('camera-code'),
                    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                    decoration: BoxDecoration(
                      color: HfColors.plum.withValues(alpha: 0.78),
                      borderRadius: BorderRadius.circular(HfRadius.control),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          widget.code,
                          style: HfText.hero.copyWith(color: HfColors.cream, fontSize: 30, letterSpacing: 4),
                        ),
                        Text(
                          'Say: Mera code $spaced hai',
                          style: HfText.bodyText.copyWith(color: HfColors.cream),
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),
                ),
                if (_cam == _Cam.countdown)
                  Center(
                    child: Text(
                      '$_left',
                      key: const ValueKey<String>('camera-countdown'),
                      style: HfText.hero.copyWith(color: HfColors.cream, fontSize: 96),
                    ),
                  ),
                if (_cam == _Cam.recording || _cam == _Cam.stopping)
                  Positioned(
                    left: 12,
                    right: 12,
                    bottom: 12,
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: HfColors.plum.withValues(alpha: 0.78),
                        borderRadius: BorderRadius.circular(HfRadius.control),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.fiber_manual_record_rounded, color: HfColors.accent, size: 22),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              _cam == _Cam.stopping ? 'Saving…' : 'Recording, $_left ${KycCopy.recordingLeft}',
                              key: const ValueKey<String>('camera-recording'),
                              style: HfText.bodyStrong.copyWith(color: HfColors.cream),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        if (!live)
          HfButton(
            key: const ValueKey<String>('camera-start'),
            label: KycCopy.startRecording,
            icon: Icons.fiber_manual_record_rounded,
            onPressed: _cam == _Cam.idle ? _begin : null,
          ),
        if (!live) HfButton(label: KycCopy.cancel, kind: HfButtonKind.text, onPressed: widget.onCancel),
      ],
    );
  }
}
