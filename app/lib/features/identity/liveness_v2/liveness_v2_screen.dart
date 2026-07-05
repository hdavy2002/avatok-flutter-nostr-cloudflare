import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../core/analytics.dart';
import '../ladder_api.dart';
import 'capture_compress.dart';
import 'face_gate.dart';
import 'flash_fill.dart';
import 'head_circle_step.dart';
import 'live_theme.dart';
import 'pending_session.dart';
import 'phrase_step.dart';
import 'position_step.dart';
import 'stage_chrome.dart';

/// Liveness V2 — the detection-gated orchestrator (Specs/LIVENESS-V2-PLAN.md §4),
/// redesigned to the dark 6-stage flow [LIVE-UI-3]
/// (`design/Liveliness Check Screens/Liveness Check.dc.html`).
///
/// Flow (SIMPLIFIED — the expression step is dropped from routing):
///   intro → preparing → position (face-in-oval, captures the NEUTRAL still on
///   lock) → recording (starts video) → headCircle (LEFT then RIGHT) → phrase
///   (pick language + read aloud) → uploading → verifying (analyzing) →
///   passed / failed.
///
/// This is a RESKIN + flow simplification, NOT a logic rewrite: ML Kit gating,
/// session/pending resume, and the 202→poll verify contract are all preserved.
/// Ships behind `RemoteConfig.livenessV2Enabled`; V1 [LivenessCheckScreen] is
/// untouched. Brightness is ALWAYS restored via the FlashFillController's
/// try/finally, including on dispose and every early return.
class LivenessV2Screen extends StatefulWidget {
  const LivenessV2Screen({super.key, this.listingContext = false});

  /// True when this flow was entered from the "create a listing" gate, so the
  /// Accepted screen shows a "Create a listing" CTA. Otherwise the CTA is "Done".
  /// (The route always pops `true` on pass, matching the old behaviour.)
  final bool listingContext;

  @override
  State<LivenessV2Screen> createState() => _LivenessV2ScreenState();
}

enum _Phase {
  intro,
  preparing,
  position,
  recording,
  headCircle,
  phrase,
  uploading,
  verifying,
  passed,
  failed,
  unavailable, // 503 flag_off from /start
}

/// Which analyze row is active/done (drives the design's staged rows on real
/// progress: uploading → verify-accepted → final polls).
enum _AnalyzeStep { face, motion, voice }

class _LivenessV2ScreenState extends State<LivenessV2Screen> {
  final FlashFillController _flash = FlashFillController();
  CameraController? _cam;

  _Phase _phase = _Phase.intro;
  String? _error;

  // Challenge from the server.
  String _sessionId = '';
  String _phrase = '';
  String _lang = 'en';
  bool _langBusy = false;

  // Left/right head-turn progress (for the design's arrows + pills).
  bool _leftDone = false;
  bool _rightDone = false;

  // Analyzing progress.
  _AnalyzeStep _analyzeStep = _AnalyzeStep.face;

  // Captured evidence.
  Uint8List? _profileLeft, _profileRight;
  Uint8List? _neutralFrame;
  Uint8List? _clip;

  // Byte accounting for telemetry (compressed sizes actually uploaded).
  int _uploadBytes = 0;

  Timer? _recordCap; // caps the clip at ~6s

  List<String> _failMessages = const [];
  int? _attemptsLeft;

  // ── [LIVE-DEVAUTH-1] Device-observed liveness outcomes ──────────────────────
  // The device-authoritative checks the server can cross-check against its own
  // model verdict (flag-gated OFF server-side for now). Booleans are what the
  // existing ML Kit gates already proved; scores are representative captures.
  bool _chkSingleFace = false;
  bool _chkEyesOpen = false;
  bool _chkOcclusionClear = false;
  bool _chkTurnLeft = false;
  bool _chkTurnRight = false;
  final Map<String, double> _mlKitScores = {};

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @override
  void initState() {
    super.initState();
    _resumePendingIfAny();
  }

  Future<void> _resumePendingIfAny() async {
    final sid = await LivenessPendingSession.get();
    if (sid == null || sid.isEmpty || !mounted) return;
    setState(() {
      _sessionId = sid;
      _phase = _Phase.verifying;
      _analyzeStep = _AnalyzeStep.voice; // resumed = already past upload/motion
    });
    final res = await LadderApi.livenessResultOutcome(sid);
    if (!mounted) return;
    if (res.pending) {
      final done = await _pollResume(sid);
      if (!mounted) return;
      if (!done) {
        setState(() {
          _phase = _Phase.intro;
          _error = "We're still checking your last video — reopen this screen "
              'in a minute to see the result.';
        });
      }
      return;
    }
    if (res.noResult) {
      await LivenessPendingSession.clear();
      if (!mounted) return;
      setState(() => _phase = _Phase.intro);
      return;
    }
    await _applyOutcome(res);
  }

  Future<bool> _pollResume(String sid) async {
    for (var i = 0; i < 30; i++) {
      await Future<void>.delayed(const Duration(seconds: 2));
      if (!mounted) return true;
      final r = await LadderApi.livenessResultOutcome(sid);
      if (!r.pending && !r.noResult) {
        await _applyOutcome(r);
        return true;
      }
      if (r.noResult) {
        await LivenessPendingSession.clear();
        return false;
      }
    }
    return false;
  }

  @override
  void dispose() {
    _recordCap?.cancel();
    _flash.dispose(); // always restores brightness (try/finally inside)
    _cam?.dispose();
    super.dispose();
  }

  void _abandon(String step) {
    Analytics.capture('liveness_abandoned', {'step': step});
  }

  /// [LIVE-UI-3] telemetry: which stage the user is on.
  void _stage(String name) {
    Analytics.capture('liveness_ui_stage', {'stage': name, 'v': 2});
  }

  Future<void> _fail(String message, {int? attemptsLeft}) async {
    await _stopRecordingSafely();
    if (!mounted) return;
    setState(() {
      _phase = _Phase.failed;
      _failMessages = [message];
      _attemptsLeft = attemptsLeft;
    });
    await _flash.deactivate();
  }

  Future<void> _applyOutcome(({
    bool pending,
    bool noResult,
    bool verified,
    List<String> failedMessages,
    int? attemptsRemaining,
  }) res) async {
    await LivenessPendingSession.clear();
    if (!mounted) return;
    if (res.verified) {
      Analytics.capture('liveness_passed', const {'v': 2});
      _stage('accepted');
      setState(() => _phase = _Phase.passed);
    } else {
      Analytics.capture('liveness_failed', {
        'v': 2,
        'checks': res.failedMessages.length,
      });
      _stage('failed');
      setState(() {
        _phase = _Phase.failed;
        _failMessages = res.failedMessages.isEmpty
            ? const ['Verification failed — please try again.']
            : res.failedMessages;
        _attemptsLeft = res.attemptsRemaining;
      });
    }
  }

  // ── Preflight ────────────────────────────────────────────────────────────

  Future<void> _begin() async {
    if (!Platform.isAndroid && !Platform.isIOS) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Video verification is available on the AvaTok mobile app. '
            'Please complete this step on your phone.';
      });
      return;
    }
    setState(() {
      _phase = _Phase.preparing;
      _error = null;
    });
    Analytics.capture('liveness_started', const {'v': 2});
    _stage('preparing');

    if (!await Permission.camera.request().isGranted ||
        !await Permission.microphone.request().isGranted) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Camera & microphone permission needed.';
      });
      return;
    }

    final s = await LadderApi.livenessStart(lang: _lang);
    if (s == null || s.sessionId.isEmpty) {
      // Could be a 503 flag_off (verification temporarily unavailable) or a
      // transient start failure — show the honest, recoverable unavailable state.
      _stage('unavailable');
      setState(() => _phase = _Phase.unavailable);
      return;
    }
    _sessionId = s.sessionId;
    _phrase = s.phrase;
    _lang = s.lang;

    try {
      final cams = await availableCameras();
      final front = cams.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cams.first,
      );
      // [LIVE-COMPRESS-1] low(er) resolution for the whole capture: medium is
      // ~480–720p, well below the sensor max, cutting clip + still bytes.
      _cam = CameraController(front, ResolutionPreset.medium, enableAudio: true);
      await _cam!.initialize();
    } catch (_) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Could not open the front camera.';
      });
      return;
    }
    if (!mounted) return;

    await _flash.activate(); // flash-fill on for the whole capture (A8/A9)
    if (!mounted) return;
    setState(() => _phase = _Phase.position);
    _stage('face');
  }

  /// [LIVE-UI-3] Re-request the challenge in a new language (only when cheap: a
  /// single POST, chips locked while it's in flight). If the server ignores lang
  /// we keep whatever phrase it returned.
  Future<void> _pickLang(String code) async {
    if (code == _lang || _langBusy) return;
    Analytics.capture('liveness_lang_selected', {'lang': code});
    setState(() {
      _lang = code;
      _langBusy = true;
    });
    final s = await LadderApi.livenessStart(lang: code);
    if (!mounted) return;
    if (s != null && s.sessionId.isNotEmpty) {
      // Adopt the fresh session for the new language (the old one is unused).
      _sessionId = s.sessionId;
      _phrase = s.phrase;
      _lang = s.lang;
    }
    setState(() => _langBusy = false);
  }

  // ── Step transitions ───────────────────────────────────────────────────────

  /// Face locked → grab the NEUTRAL still (design drops the separate neutral/
  /// review step; we capture it here at lock), then start recording.
  Future<void> _onPositionDone() async {
    final cam = _cam;
    if (cam == null) {
      await _fail('Camera closed — please try again.');
      return;
    }
    // Neutral still captured while still in preview mode (before recording).
    _neutralFrame = await _still(cam);
    try {
      await cam.startVideoRecording();
    } catch (_) {
      await _fail('Recording failed to start — try again.');
      return;
    }
    if (!mounted) return;
    setState(() {
      _phase = _Phase.recording;
    });
    _stage('recording');
    // [LIVE-COMPRESS-1] Safety cap on the recording length. The clip must span
    // the turn-head + read-aloud portions (that's the motion + voice evidence),
    // so we can't cut at ~6s of wall-clock — but we DO cap it so a user who
    // lingers can't produce a 40 MB clip. 12s is comfortably enough for both
    // portions at ResolutionPreset.medium and keeps the clip well under budget;
    // if the cap fires we stop recording (whatever is captured still uploads).
    _recordCap = Timer(const Duration(seconds: 12), () {
      if (!mounted) return;
      Analytics.capture('liveness_record_capped', const {'seconds': 12, 'v': 2});
      _stopRecordingSafely();
    });
    // Short recording flash, then straight into the head-turn challenge.
    Timer(const Duration(milliseconds: 900), () {
      if (!mounted) return;
      setState(() => _phase = _Phase.headCircle);
      _stage('turn');
    });
  }

  void _onHeadProgress(bool left, bool right) {
    if (!mounted) return;
    setState(() {
      _leftDone = left;
      _rightDone = right;
    });
  }

  /// [LIVE-DEVAUTH-1] Record the device-observed outcomes at the position/face
  /// gate lock: single_face + eyes_open come straight off the all-pass ML Kit
  /// snapshot; occlusion_clear is true because the gate only locks with the
  /// mouth/nose + eyes landmarks visible (no covering). Representative scores are
  /// stashed for the ml_kit map.
  void _onLockedGate(FaceGateStatus s) {
    _chkSingleFace = s.singleFace;
    _chkEyesOpen = s.eyesOpen;
    // Gate locks only when eyesVisible && mouthNoseVisible (no sunglasses / no
    // covering), i.e. the face is unobstructed → occlusion is clear.
    _chkOcclusionClear = s.eyesVisible && s.mouthNoseVisible;
    if (s.eyeOpenProb != null) _mlKitScores['eye_open_prob'] = s.eyeOpenProb!;
    if (s.smilingProb != null) _mlKitScores['smiling_prob'] = s.smilingProb!;
  }

  /// [LIVE-DEVAUTH-1] Record that each head-turn extreme was reached, plus the
  /// head Euler-Y angle at capture (representative motion score).
  void _onTurnCaptured(String side, double eulerY) {
    if (side == 'left') {
      _chkTurnLeft = true;
      _mlKitScores['head_euler_y_left'] = eulerY;
    } else if (side == 'right') {
      _chkTurnRight = true;
      _mlKitScores['head_euler_y_right'] = eulerY;
    }
  }

  /// [LIVE-DEVAUTH-1] Assemble the optional `device_report` sent with verify.
  Map<String, dynamic> _buildDeviceReport() => {
        'checks': {
          'single_face': _chkSingleFace,
          'occlusion_clear': _chkOcclusionClear,
          'turn_left': _chkTurnLeft,
          'turn_right': _chkTurnRight,
          'eyes_open': _chkEyesOpen,
        },
        'ml_kit': Map<String, double>.from(_mlKitScores),
        // TODO [LIVE-ATTEST-1]: Play Integrity (Android) / App Attest (iOS).
        'attestation_token': null,
        'platform': Platform.isIOS ? 'ios' : 'android',
      };

  void _onHeadCircleDone(
    Uint8List? left,
    Uint8List? right,
    Uint8List? up,
    Uint8List? down,
  ) {
    _profileLeft = left;
    _profileRight = right;
    if (!mounted) return;
    setState(() => _phase = _Phase.phrase);
    _stage('read');
  }

  /// Phrase step tapped "start" → nothing extra to do (recording is already
  /// running from the position step); we just let it keep recording the audio.
  void _onPhraseStart() {/* recording already active */}

  Future<void> _onPhraseDone() async {
    await _stopRecordingSafely();
    if (!mounted) return;
    // Design has no review step — go straight to upload.
    await _submit();
  }

  Future<void> _stopRecordingSafely() async {
    _recordCap?.cancel();
    final cam = _cam;
    if (cam == null) return;
    try {
      if (cam.value.isStreamingImages) {
        await cam.stopImageStream();
      }
    } catch (_) {/* best-effort */}
    try {
      if (cam.value.isRecordingVideo) {
        final rec = await cam.stopVideoRecording();
        try {
          _clip = await File(rec.path).readAsBytes();
        } catch (_) {/* soft */}
        try {
          await File(rec.path).delete();
        } catch (_) {/* tmp */}
      }
    } catch (_) {/* frames may still suffice */}
  }

  Future<Uint8List?> _still(CameraController cam) async {
    try {
      final x = await cam.takePicture();
      final b = await x.readAsBytes();
      try {
        await File(x.path).delete();
      } catch (_) {}
      return b;
    } catch (_) {
      return null;
    }
  }

  // ── Upload → verify ─────────────────────────────────────────────────────────

  Future<void> _submit() async {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.uploading;
      _analyzeStep = _AnalyzeStep.face;
    });
    _stage('analyzing');
    await _flash.deactivate(); // capture done — restore brightness now
    _uploadBytes = 0;

    // [LIVE-COMPRESS-1] compress every still (downscale 640px + JPEG q75) before
    // upload. frame0 = neutral (design captures no expression), frame1 = a
    // profile, frame2 = the other profile.
    final firstProfile = _profileLeft ?? _profileRight;
    final key = <String, Uint8List?>{
      'frame0': _neutralFrame,
      'frame1': firstProfile,
      'frame2': _profileRight ?? _profileLeft,
    };
    for (final e in key.entries) {
      final raw = e.value;
      if (raw == null) continue;
      final b = CaptureCompress.still(raw);
      if (!await LadderApi.livenessUpload(_sessionId, e.key, b)) {
        await _fail('Upload failed — check your connection and try again.');
        return;
      }
      _uploadBytes += b.lengthInBytes;
    }

    // Named profile parts (server-side reads these); best-effort, compressed.
    final profiles = <String, Uint8List?>{
      'profile_left': _profileLeft,
      'profile_right': _profileRight,
    };
    for (final e in profiles.entries) {
      final raw = e.value;
      if (raw != null) {
        final b = CaptureCompress.still(raw);
        await LadderApi.livenessUpload(_sessionId, e.key, b);
        _uploadBytes += b.lengthInBytes;
      }
    }

    final clip = _clip;
    if (clip != null && clip.lengthInBytes < 16000000) {
      // motion row becomes active once the (largest) clip part goes up.
      if (mounted) setState(() => _analyzeStep = _AnalyzeStep.motion);
      await LadderApi.livenessUpload(_sessionId, 'clip', clip);
      _uploadBytes += clip.lengthInBytes;
    }

    // [LIVE-COMPRESS-1] size telemetry (bytes actually uploaded, all parts).
    Analytics.capture('liveness_upload_bytes', {
      'bytes': _uploadBytes,
      'clip_bytes': clip?.lengthInBytes ?? 0,
      'v': 2,
    });

    if (!mounted) return;
    setState(() {
      _phase = _Phase.verifying;
      _analyzeStep = _AnalyzeStep.voice; // final polls = verifying voice
    });
    await LivenessPendingSession.set(_sessionId);
    // [LIVE-DEVAUTH-1] Attach the device-observed outcomes (server flag-gated).
    final deviceReport = _buildDeviceReport();
    final checks = deviceReport['checks'] as Map<String, dynamic>;
    Analytics.capture('liveness_device_report', {
      ...checks, // booleans only — no raw ml_kit scores in telemetry
      'platform': deviceReport['platform'],
      'attested': deviceReport['attestation_token'] != null,
      'v': 2,
    });
    final r = await LadderApi.livenessVerifyRich(_sessionId, deviceReport: deviceReport);
    if (!mounted) return;
    if (r.pending) {
      // Verify hasn't resolved within the poll window — honest recoverable state.
      setState(() {
        _phase = _Phase.intro;
        _error = "We're still checking your video — reopen this screen in a "
            'minute to see the result.';
      });
      return;
    }
    await _applyOutcome(r);
  }

  /// Full clean restart (restart button + retry): drop evidence, reset to intro.
  Future<void> _restart() async {
    _recordCap?.cancel();
    await _stopRecordingSafely();
    await _flash.deactivate();
    try {
      await _cam?.dispose();
    } catch (_) {}
    _cam = null;
    _profileLeft = _profileRight = _neutralFrame = _clip = null;
    _leftDone = _rightDone = false;
    _sessionId = '';
    if (!mounted) return;
    setState(() {
      _phase = _Phase.intro;
      _error = null;
      _failMessages = const [];
      _attemptsLeft = null;
    });
    Analytics.capture('liveness_restart', const {'v': 2});
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  bool get _isCapturePhase =>
      _phase == _Phase.position ||
      _phase == _Phase.recording ||
      _phase == _Phase.headCircle ||
      _phase == _Phase.phrase;

  int get _activePip => switch (_phase) {
        _Phase.position || _Phase.recording => 1,
        _Phase.headCircle => 2,
        _Phase.phrase => 3,
        _Phase.uploading || _Phase.verifying => 4,
        _ => 1,
      };

  @override
  Widget build(BuildContext context) {
    // Only intro / passed / failed / unavailable are dismissible; a capture in
    // progress swallows back and logs abandonment.
    final canPop = _phase == _Phase.intro ||
        _phase == _Phase.passed ||
        _phase == _Phase.failed ||
        _phase == _Phase.unavailable;
    final showPips = _isCapturePhase || _phase == _Phase.uploading || _phase == _Phase.verifying;
    return PopScope(
      canPop: canPop,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop && !canPop) _abandon(_phase.name);
      },
      child: Scaffold(
        backgroundColor: LiveTheme.stage,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 22, 24, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                LivenessHeader(
                  onRestart: _phase == _Phase.intro ? null : _restart,
                ),
                const SizedBox(height: 16),
                if (showPips && _phase != _Phase.passed) ...[
                  Align(
                    alignment: Alignment.centerLeft,
                    child: StepPips(total: 4, active: _activePip),
                  ),
                  const SizedBox(height: 16),
                ],
                Expanded(child: _body()),
                const SizedBox(height: 12),
                const LivenessFooter(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.intro:
        return _intro();
      case _Phase.preparing:
        return const Center(
            child: CircularProgressIndicator(color: LiveTheme.lime));
      case _Phase.position:
        return PositionStep(
          controller: _cam!,
          flashFill: _flash,
          onCountdownDone: _onPositionDone,
          onLockedGate: _onLockedGate,
        );
      case _Phase.recording:
        return _recordingView();
      case _Phase.headCircle:
        return _turnHeadView();
      case _Phase.phrase:
        return PhraseStep(
          phrase: _phrase,
          langCode: _lang,
          langLabel: _langLabel(_lang),
          langBusy: _langBusy,
          onPickLang: _pickLang,
          onStart: _onPhraseStart,
          onComplete: _onPhraseDone,
        );
      case _Phase.uploading:
      case _Phase.verifying:
        return _analyzingView();
      case _Phase.passed:
        return _accepted();
      case _Phase.failed:
        return _failed();
      case _Phase.unavailable:
        return _unavailable();
    }
  }

  String _langLabel(String code) => switch (code) {
        'es' => 'Español',
        'fr' => 'Français',
        'de' => 'Deutsch',
        _ => 'English',
      };

  // ── Intro ───────────────────────────────────────────────────────────────
  Widget _intro() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        Center(
          child: Container(
            width: 104,
            height: 104,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: LiveTheme.lilac,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: const Icon(Icons.videocam_rounded, size: 46, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline('Prove you are ', markWord: 'real'),
        const SizedBox(height: 12),
        Text(
          'A quick, guided selfie video: line up your face, turn your head '
          'left then right, and read one short line aloud. Each step waits for '
          'you — nothing is rushed. The clip is checked automatically and '
          'deleted when you close your account.',
          style: LiveTheme.subStyle,
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          _noticeCard(_error!),
        ],
        const Spacer(),
        LiveTheme.limeButton(label: 'Start', icon: Icons.videocam_rounded, onPressed: _begin),
      ],
    );
  }

  // ── Stage 2: recording ────────────────────────────────────────────────────
  Widget _recordingView() {
    final cam = _cam;
    final reduced = LiveTheme.reducedMotion(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: LiveTheme.cameraStage(
            child: Stack(
              fit: StackFit.expand,
              children: [
                if (cam != null && cam.value.isInitialized)
                  FittedBox(
                    fit: BoxFit.cover,
                    child: SizedBox(
                      width: cam.value.previewSize?.height ?? 1,
                      height: cam.value.previewSize?.width ?? 1,
                      child: CameraPreview(cam),
                    ),
                  )
                else
                  const ColoredBox(color: LiveTheme.cameraCard),
                // Blinking coral inset border.
                RecInsetBorder(reducedMotion: reduced),
                Positioned(
                  top: 14,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: LiveTheme.pill(
                      label: 'Rec',
                      filled: LiveTheme.coral,
                      textOnFill: Colors.white,
                      leadingDotBlink: true,
                    ),
                  ),
                ),
                // Lime oval overlay.
                CustomPaint(painter: _LimeOval()),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        LiveTheme.stageHeadline('Hold still — ',
            markWord: 'recording', markFill: LiveTheme.coralMark, markText: LiveTheme.paper),
        const SizedBox(height: 10),
        LiveProgressBar(
          fill: LiveTheme.lime,
          durationMs: reduced ? 1 : 900,
        ),
      ],
    );
  }

  // ── Stage 3: turn head ────────────────────────────────────────────────────
  Widget _turnHeadView() {
    final leftActive = !_leftDone;
    final rightActive = _leftDone && !_rightDone;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: LiveTheme.cameraStage(
            child: Stack(
              fit: StackFit.expand,
              children: [
                // Headless ML Kit detector (draws nothing / timeout card only).
                HeadCircleStep(
                  controller: _cam!,
                  leftRight: true,
                  hideBuiltInChrome: true,
                  onProgress: _onHeadProgress,
                  onTurnCaptured: _onTurnCaptured,
                  onComplete: _onHeadCircleDone,
                  onFaceLost: () {},
                  onFaceBack: () {},
                  onSecondFace: () {},
                ),
                TurnHeadGuide(leftActive: leftActive, rightActive: rightActive),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
        Row(children: [
          _leftDone
              ? LiveTheme.pill(label: '✓ Left done', filled: LiveTheme.lime, icon: Icons.check)
              : LiveTheme.pill(label: 'Turn left', outlined: true, icon: Icons.chevron_left),
          const SizedBox(width: 10),
          _rightDone
              ? LiveTheme.pill(label: '✓ Right done', filled: LiveTheme.lime, icon: Icons.check)
              : LiveTheme.pill(label: 'Turn right', outlined: true, icon: Icons.chevron_right),
        ]),
        const SizedBox(height: 14),
        LiveTheme.stageHeadline('Slowly turn your ', markWord: 'head'),
        const SizedBox(height: 6),
        Text('Left first, then right — nice and easy.', style: LiveTheme.subStyle),
      ],
    );
  }

  // ── Stage 5: analyzing ────────────────────────────────────────────────────
  Widget _analyzingView() {
    final reduced = LiveTheme.reducedMotion(context);
    final rows = <AnalyzeRowData>[
      AnalyzeRowData('Matching your face geometry', _analyzeStep.index > 0
          ? RowState.done
          : RowState.active),
      AnalyzeRowData('Checking natural motion', switch (_analyzeStep) {
        _AnalyzeStep.face => RowState.pending,
        _AnalyzeStep.motion => RowState.active,
        _AnalyzeStep.voice => RowState.done,
      }),
      AnalyzeRowData('Verifying your voice', switch (_analyzeStep) {
        _AnalyzeStep.voice => RowState.active,
        _ => RowState.pending,
      }),
    ];
    return AnalyzingStage(rows: rows, reducedMotion: reduced);
  }

  // ── Stage 6: accepted ─────────────────────────────────────────────────────
  Widget _accepted() {
    final reduced = LiveTheme.reducedMotion(context);
    return AcceptedStage(
      reducedMotion: reduced,
      listingContext: widget.listingContext,
      onCta: () => Navigator.of(context).pop(true),
    );
  }

  // ── Failed ────────────────────────────────────────────────────────────────
  Widget _failed() {
    final msgs = _failMessages.isEmpty
        ? const ['Verification failed — please try again.']
        : _failMessages;
    final canRetry = (_attemptsLeft ?? 1) > 0;
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 8),
          Center(
            child: Container(
              width: 92,
              height: 92,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: LiveTheme.coral,
                border: Border.all(color: LiveTheme.ink, width: 3),
                boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
              ),
              child: const Icon(Icons.priority_high_rounded, size: 42, color: Colors.white),
            ),
          ),
          const SizedBox(height: 20),
          LiveTheme.stageHeadline('Not verified ', markWord: 'yet',
              markFill: LiveTheme.coralMark, markText: LiveTheme.paper),
          const SizedBox(height: 8),
          Text(
            msgs.length > 1
                ? 'A few things to fix and try again:'
                : "Here's what to fix and try again:",
            style: LiveTheme.subStyle,
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: LiveTheme.taperedCardDecoration,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final m in msgs)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.error_outline, size: 18, color: LiveTheme.coral),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(m,
                              style: const TextStyle(
                                fontFamily: 'Nunito',
                                fontWeight: FontWeight.w700,
                                fontSize: 14,
                                color: LiveTheme.ink,
                              )),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          if (_attemptsLeft != null) ...[
            const SizedBox(height: 12),
            Center(
              child: Text('Attempts left today: $_attemptsLeft',
                  style: LiveTheme.subStyle),
            ),
          ],
          const SizedBox(height: 20),
          LiveTheme.limeButton(
            label: 'Try again',
            icon: Icons.refresh,
            onPressed: canRetry ? _restart : null,
          ),
          const SizedBox(height: 12),
          Center(
            child: GestureDetector(
              onTap: () => Navigator.of(context).pop(false),
              child: Text('Later', style: LiveTheme.subStyle),
            ),
          ),
        ],
      ),
    );
  }

  // ── Unavailable (503 flag_off) ────────────────────────────────────────────
  Widget _unavailable() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        Center(
          child: Container(
            width: 92,
            height: 92,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: LiveTheme.card,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: const Icon(Icons.cloud_off_rounded, size: 40, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 20),
        LiveTheme.stageHeadline('Temporarily ', markWord: 'unavailable'),
        const SizedBox(height: 10),
        Text(
          'Verification is temporarily unavailable — please try again later.',
          style: LiveTheme.subStyle,
        ),
        const Spacer(),
        LiveTheme.limeButton(label: 'Try again', icon: Icons.refresh, onPressed: _begin),
        const SizedBox(height: 12),
        Center(
          child: GestureDetector(
            onTap: () => Navigator.of(context).pop(false),
            child: Text('Later', style: LiveTheme.subStyle),
          ),
        ),
      ],
    );
  }

  Widget _noticeCard(String text) => Container(
        padding: const EdgeInsets.all(14),
        decoration: LiveTheme.taperedCardDecoration,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.info_outline, size: 18, color: LiveTheme.ink),
            const SizedBox(width: 8),
            Expanded(
              child: Text(text,
                  style: const TextStyle(
                    fontFamily: 'Nunito',
                    fontWeight: FontWeight.w700,
                    fontSize: 13.5,
                    color: LiveTheme.ink,
                  )),
            ),
          ],
        ),
      );
}

/// Lime oval overlay for the recording stage.
class _LimeOval extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromCenter(
      center: Offset(size.width / 2, size.height * 0.5),
      width: size.width * 0.5,
      height: size.height * 0.42,
    );
    canvas.drawOval(
      rect,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..color = LiveTheme.lime,
    );
  }

  @override
  bool shouldRepaint(_LimeOval old) => false;
}
