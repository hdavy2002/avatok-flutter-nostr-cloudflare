import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../core/analytics.dart';
import '../../../core/verification_api.dart';
import '../ladder_api.dart';
import '../liveness_v2/flash_fill.dart';
import '../liveness_v2/live_theme.dart';
import '../liveness_v2/pending_session.dart';
import '../liveness_v2/phone_stage.dart';
import '../liveness_v2/stage_chrome.dart';
import 'challenge_session.dart';
import 'coaching_engine.dart';
import 'language_picker_step.dart';
import 'overlay_painter.dart';
import 'voice_packs.dart';
import 'watchdog.dart';

/// Liveness V3 — VOICE-GUIDED orchestrator (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md). Reuses the V2 dark-stage UI (LiveTheme, header/pips/footer, phone/
/// OTP stages, oval overlay) and ADDS behaviour: a language picker, Ava voice
/// coaching from on-device ML Kit, server-randomized challenges rendered on the
/// existing oval, a per-stage no-dead-screen watchdog, and background upload to
/// the presigned R2 target. Ships behind `RemoteConfig.livenessV3Enabled`; V2 is
/// untouched and used when the flag is off.
///
/// Flow: language → phone → otp → intro → faceNeck (framing + challenges,
/// continuous recording) → done (background upload; user proceeds immediately).
/// Verdict arrives via the existing V2 result/push path (green tick via
/// /api/identity/level refresh).
class LivenessV3Screen extends StatefulWidget {
  const LivenessV3Screen({
    super.key,
    this.listingContext = false,
    this.requester = 'onboarding',
    this.policyId = 'default',
  });

  final bool listingContext;

  /// Caller context recorded on the session + every event (plan §0-A).
  final String requester;

  /// Trust-Engine policy selecting required stages/limits (plan §4-A.1).
  final String policyId;

  @override
  State<LivenessV3Screen> createState() => _LivenessV3ScreenState();
}

enum _Phase {
  language,
  phone,
  otp,
  intro,
  preparing,
  faceNeck, // framing + randomized challenges, continuous recording
  done,     // captured; background upload; user proceeds
  passed,
  failed,
  unavailable,
  dead,     // watchdog fired — plain error + Retry/Skip
}

class _LivenessV3ScreenState extends State<LivenessV3Screen> {
  final FlashFillController _flash = FlashFillController();
  final PhoneVerifyController _phone = PhoneVerifyController();
  CameraController? _cam;
  CoachingEngine? _coach;

  _Phase _phase = _Phase.language;
  String? _error;

  String _lang = 'en';
  bool _phoneVerified = false;
  bool _phoneStart = false;

  LivenessV3Session? _session;

  // Coaching / recording state.
  CoachState _coachState = const CoachState.searching();
  bool _recording = false;
  int _challengeIndex = 0;
  final Set<int> _challengesDone = {};

  // Capture accounting.
  Uint8List? _clip;
  int _uploadBytes = 0;
  int _retries = 0;

  Timer? _recordCap;
  Timer? _challengeTimer;
  StageWatchdog? _activeWatch;

  // Fail state.
  List<String> _failMessages = const [];
  int? _attemptsLeft;
  String _deadStage = '';

  int _stageStartMs = DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    _lang = LivenessVoice.deviceLang();
    _phone.addListener(_onPhoneChanged);
    _phone.loadStoredPhone();
    _boot();
  }

  Future<void> _boot() async {
    // Resume a pending verify first (same resilience as V2, but on the V3 result
    // route + verdict shape).
    final sid = await LivenessPendingSession.get();
    if (sid != null && sid.isNotEmpty && mounted) {
      setState(() => _phase = _Phase.done);
      final res = await LivenessV3Api.result(sid);
      if (!mounted) return;
      if (!res.pending && !res.noResult) {
        await _applyOutcome(res);
        return;
      }
      if (res.noResult) await LivenessPendingSession.clear();
    }
    // Otherwise start at the language picker (plan §1 — flow OPENS with language).
    if (!mounted) return;
    setState(() => _phase = _Phase.language);
    Analytics.capture('liveness_flow_start', {
      'requester': widget.requester,
      'policy_id': widget.policyId,
      'language': _lang,
      'v': 3,
    });
  }

  void _onPhoneChanged() {
    if (!mounted) return;
    if (_phase == _Phase.phone && _phone.codeSent && !_phone.verified) {
      _setStage(_Phase.otp);
      return;
    }
    if (_phase == _Phase.otp && _phone.verified) {
      _phoneVerified = true;
      _setStage(_Phase.intro);
      return;
    }
    setState(() {});
  }

  @override
  void dispose() {
    _recordCap?.cancel();
    _challengeTimer?.cancel();
    _activeWatch?.dispose();
    _phone.removeListener(_onPhoneChanged);
    _phone.dispose();
    unawaited(_coach?.dispose());
    unawaited(LivenessVoice.I.stop());
    _flash.dispose();
    _cam?.dispose();
    super.dispose();
  }

  // ── Stage telemetry helpers ────────────────────────────────────────────────

  void _setStage(_Phase p) {
    _activeWatch?.cancel();
    if (mounted) setState(() => _phase = p);
    _stageStartMs = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('liveness_stage_start', {'stage': p.name, 'v': 3});
    _armWatchdog(p);
  }

  void _stageComplete(String stage) {
    Analytics.capture('liveness_stage_complete', {
      'stage': stage,
      'ms': DateTime.now().millisecondsSinceEpoch - _stageStartMs,
      'v': 3,
    });
  }

  void _stageFail(String stage, String reason) {
    Analytics.capture('liveness_stage_fail', {
      'stage': stage,
      'fail_reason': reason,
      'ms': DateTime.now().millisecondsSinceEpoch - _stageStartMs,
      'v': 3,
    });
  }

  /// Arm a 10s no-progress watchdog for the interactive stages (plan §5).
  void _armWatchdog(_Phase p) {
    _activeWatch?.dispose();
    // Only stages that can silently stall need a watchdog.
    const watched = {_Phase.preparing, _Phase.faceNeck};
    if (!watched.contains(p)) {
      _activeWatch = null;
      return;
    }
    _activeWatch = StageWatchdog(
      stage: p.name,
      onDead: () => _onDeadScreen(p.name),
    )..start();
  }

  void _onDeadScreen(String stage) {
    if (!mounted) return;
    _stageFail(stage, 'dead_screen');
    // Plan §4: the named watchdog event (the 10s-inactivity bug that started all
    // this) — kept distinct from the generic stage_fail so the dashboard can track
    // dead-screen rate → target 0.
    Analytics.capture('liveness_dead_screen', {
      'stage': stage,
      'ms': DateTime.now().millisecondsSinceEpoch - _stageStartMs,
      'v': 3,
    });
    setState(() {
      _deadStage = stage;
      _phase = _Phase.dead;
    });
    unawaited(_flash.deactivate());
  }

  // ── Language ───────────────────────────────────────────────────────────────

  Future<void> _onLanguageConfirmed(String lang) async {
    _lang = lang;
    Analytics.capture('liveness_stage_complete', {
      'stage': 'language',
      'language': lang,
      'ms': DateTime.now().millisecondsSinceEpoch - _stageStartMs,
      'v': 3,
    });
    // Switch voice + strings; kick off (best-effort) pack fetch for non-English.
    unawaited(LivenessVoice.I.ensureLanguage(lang));
    // Decide phone vs face entry (phone/OTP stays exactly as V2 wired it).
    bool verified = false;
    try {
      verified = await VerificationApi.isPhoneVerified();
    } catch (_) {}
    _phoneVerified = verified;
    _phoneStart = !verified;
    _setStage(verified ? _Phase.intro : _Phase.phone);
  }

  // ── Intro → session + camera ────────────────────────────────────────────────

  Future<void> _begin() async {
    if (!Platform.isAndroid && !Platform.isIOS) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Video verification is available on the AvaTok mobile app.';
      });
      return;
    }
    _setStage(_Phase.preparing);
    _error = null;

    if (!await Permission.camera.request().isGranted ||
        !await Permission.microphone.request().isGranted) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Camera & microphone permission needed.';
      });
      return;
    }

    final s = await LivenessV3Api.startSession(
      requester: widget.requester,
      policyId: widget.policyId,
      lang: _lang,
    );
    if (s == null || !s.isValid) {
      _stageFail('preparing', 'session_start_failed');
      setState(() => _phase = _Phase.unavailable);
      return;
    }
    _session = s;

    try {
      final cams = await availableCameras();
      final front = cams.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cams.first,
      );
      // 720p cap (plan §6). medium ≈ 480–720p, keeps the clip small.
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

    await _flash.activate();
    if (!mounted) return;

    // Ava intro line, then into framing.
    unawaited(LivenessVoice.I.play(LivenessInstruction.intro));
    _startCoaching();
    _setStage(_Phase.faceNeck);
  }

  // ── Face + neck stage: coaching → record → challenges ───────────────────────

  void _startCoaching() {
    final cam = _cam;
    if (cam == null) return;
    final coach = CoachingEngine(controller: cam, onState: _onCoachState);
    _coach = coach;
    unawaited(coach.start());
  }

  void _onCoachState(CoachState s) {
    if (!mounted || _phase != _Phase.faceNeck) return;
    _coachState = s;
    _activeWatch?.poke(); // any frame with a state = progress (kills the watchdog)

    if (!_recording) {
      // Framing phase: voice-coach the user toward a good, steady frame. The voice
      // manager debounces same-instruction repeats within 3s (plan §3).
      unawaited(LivenessVoice.I.play(
        s.instruction,
        localizedText: LivenessStrings.text(_lang, s.instruction),
      ));
      _emitCoachHint(s.instruction);
      if (s.readyToRecord) {
        _startRecording();
      }
      setState(() {});
      return;
    }
    // Recording phase: run the current challenge against the live coach state.
    _evaluateChallenge(s);
    setState(() {});
  }

  final Set<LivenessInstruction> _hintsSeen = {};
  void _emitCoachHint(LivenessInstruction i) {
    if (_hintsSeen.add(i)) {
      Analytics.capture('liveness_coach_hint', {
        'instruction': i.name,
        'language': _lang,
        'v': 3,
      });
    }
  }

  Future<void> _startRecording() async {
    final cam = _cam;
    if (cam == null || _recording) return;
    _recording = true;
    unawaited(LivenessVoice.I.play(LivenessInstruction.holdStill));
    try {
      await cam.startVideoRecording();
    } catch (_) {
      _recording = false;
      _stageFail('face_neck', 'record_start_failed');
      return;
    }
    // Safety cap on the clip length (plan §3 — ≤~20s, 720p).
    final capS = _session?.maxClipSeconds ?? 20;
    _recordCap = Timer(Duration(seconds: capS), () {
      Analytics.capture('liveness_record_capped', {'seconds': capS, 'v': 3});
      _finishCapture();
    });
    // Begin the first challenge.
    _challengeIndex = 0;
    _announceChallenge();
  }

  void _announceChallenge() {
    final ch = _session?.challenges;
    if (ch == null || _challengeIndex >= ch.length) return;
    final c = ch[_challengeIndex];
    unawaited(LivenessVoice.I.play(c.instruction));
    Analytics.capture('liveness_stage_start', {
      'stage': 'challenge_${c.kind.name}',
      'index': _challengeIndex,
      'v': 3,
    });
    // Per-challenge watchdog: if the user can't complete it in 10s, the whole
    // stage watchdog (still poking on frames) covers the true dead-screen case;
    // here we just re-announce once at 6s so nobody is left guessing.
    _challengeTimer?.cancel();
    _challengeTimer = Timer(const Duration(seconds: 6), () {
      if (mounted && _recording) unawaited(LivenessVoice.I.play(c.instruction));
    });
  }

  void _evaluateChallenge(CoachState s) {
    final ch = _session?.challenges;
    if (ch == null || _challengeIndex >= ch.length) return;
    final c = ch[_challengeIndex];
    if (_challengesDone.contains(_challengeIndex)) return;

    bool cleared = false;
    switch (c.kind) {
      case ChallengeKind.blink:
        cleared = (s.eyeOpenProb ?? 1) < 0.35; // eyes closed this frame
        break;
      case ChallengeKind.turnLeft:
        cleared = s.eulerY <= -22; // device-frame: negative = user's left
        break;
      case ChallengeKind.turnRight:
        cleared = s.eulerY >= 22;
        break;
      case ChallengeKind.lookUp:
        cleared = s.eulerX >= 18;
        break;
      case ChallengeKind.lookDown:
        cleared = s.eulerX <= -18;
        break;
      case ChallengeKind.smile:
        // No reliable client smile signal here (classification smile prob isn't
        // surfaced in CoachState) — advance on stable face presence; the server
        // confirms the smile from the sampled frames. Anti-replay load is carried
        // by the other randomized challenges.
        cleared = s.faceFound && s.readyToRecord;
        break;
      case ChallengeKind.closer:
        cleared = s.sizeFrac >= 0.6; // face grew as phone approached (plan §0-B.2)
        break;
      case ChallengeKind.holdStill:
        // HOLD_STILL: pass on a stable, well-framed face for this frame. The
        // server confirms stillness from the sampled frames; the client just needs
        // the user to stay put, so a steady in-frame face clears it.
        cleared = s.faceFound && s.readyToRecord;
        break;
    }
    if (cleared) {
      _challengesDone.add(_challengeIndex);
      unawaited(LivenessVoice.I.play(LivenessInstruction.good));
      Analytics.capture('liveness_stage_complete', {
        'stage': 'challenge_${c.kind.name}',
        'index': _challengeIndex,
        'v': 3,
      });
      _challengeIndex++;
      if (_challengeIndex >= ch.length) {
        _finishCapture();
      } else {
        _announceChallenge();
      }
    }
  }

  Future<void> _finishCapture() async {
    _recordCap?.cancel();
    _challengeTimer?.cancel();
    _activeWatch?.cancel();
    await _coach?.dispose();
    _coach = null;
    await _stopRecording();
    if (!mounted) return;
    unawaited(LivenessVoice.I.play(LivenessInstruction.done));
    await _flash.deactivate();
    _stageComplete('face_neck');
    _emitCaptureMetrics();
    // User proceeds IMMEDIATELY — the check runs in the background (plan §6).
    setState(() => _phase = _Phase.done);
    unawaited(_uploadAndVerify());
  }

  Future<void> _stopRecording() async {
    final cam = _cam;
    if (cam == null) return;
    try {
      if (cam.value.isStreamingImages) await cam.stopImageStream();
    } catch (_) {}
    try {
      if (cam.value.isRecordingVideo) {
        final rec = await cam.stopVideoRecording();
        try {
          _clip = await File(rec.path).readAsBytes();
        } catch (_) {}
        try {
          await File(rec.path).delete();
        } catch (_) {}
      }
    } catch (_) {}
    _recording = false;
  }

  void _emitCaptureMetrics() {
    Analytics.capture('liveness_capture_metrics', {
      'blur': 0, // client has no sharpness metric; server computes it
      'brightness': _coachState.brightness.round(),
      'face_ratio': double.parse(_coachState.faceRatio.toStringAsFixed(3)),
      'retries': _retries,
      'v': 3,
    });
  }

  // ── Upload → verify (background) ─────────────────────────────────────────────

  Future<void> _uploadAndVerify() async {
    final session = _session;
    final clip = _clip;
    if (session == null) return;

    // 1) Background upload to the R2 target from the session (presigned PUT, or
    //    worker-proxy PUT when R2 creds are unset) — plan §3, ≤15 MB.
    if (clip != null && clip.lengthInBytes <= session.maxClipBytes) {
      final t0 = DateTime.now().millisecondsSinceEpoch;
      bool ok = false;
      if (session.upload.isValid) {
        ok = await LivenessV3Api.uploadClip(session.upload, clip);
      }
      _uploadBytes = clip.lengthInBytes;
      Analytics.capture('liveness_upload', {
        'bytes': _uploadBytes,
        'ms': DateTime.now().millisecondsSinceEpoch - t0,
        'ok': ok,
        'mode': session.upload.mode,
        'v': 3,
      });
    }

    // 2) Kick the async V3 verify + persist the session for resume-on-reopen.
    //    Echo the object_key from the upload contract so the pipeline finds the
    //    exact R2 object.
    await LivenessPendingSession.set(session.sessionId);
    final r = await LivenessV3Api.verify(
      session.sessionId,
      objectKey: session.upload.objectKey,
    );
    if (!mounted) return;
    if (r.pending) {
      // Honest recoverable state — user already told they'll get a tick shortly.
      return; // stay on the "done" screen; result arrives via push/reopen
    }
    await _applyOutcome(r);
  }

  Future<void> _applyOutcome(LivenessV3Outcome res) async {
    await LivenessPendingSession.clear();
    if (!mounted) return;
    if (res.verified) {
      // Refresh the green-tick ladder (existing wiring).
      await LadderApi.level();
      Analytics.capture('liveness_passed', {'requester': widget.requester, 'v': 3});
      setState(() => _phase = _Phase.passed);
    } else {
      Analytics.capture('liveness_failed', {
        'requester': widget.requester,
        'checks': res.failedMessages.length,
        'v': 3,
      });
      setState(() {
        _phase = _Phase.failed;
        _failMessages = res.failedMessages.isEmpty
            ? const ['Verification failed — please try again.']
            : res.failedMessages;
        _attemptsLeft = res.attemptsRemaining;
      });
    }
  }

  // ── Restart / retry / skip ───────────────────────────────────────────────────

  Future<void> _restart() async {
    _recordCap?.cancel();
    _challengeTimer?.cancel();
    _activeWatch?.cancel();
    await _coach?.dispose();
    _coach = null;
    await _stopRecording();
    await _flash.deactivate();
    try {
      await _cam?.dispose();
    } catch (_) {}
    _cam = null;
    _clip = null;
    _recording = false;
    _challengeIndex = 0;
    _challengesDone.clear();
    _hintsSeen.clear();
    _session = null;
    _retries++;
    final toPhone = _phoneStart && !_phoneVerified;
    if (toPhone) _phone.resetAll();
    if (!mounted) return;
    setState(() {
      _phase = toPhone ? _Phase.phone : _Phase.intro;
      _error = null;
      _failMessages = const [];
      _attemptsLeft = null;
    });
    Analytics.capture('liveness_restart', {'v': 3, 'to': toPhone ? 'phone' : 'intro'});
  }

  void _skip() {
    // Skip a dead stage — record it and let the user out (they can retry later).
    Analytics.capture('liveness_stage_skip', {'stage': _deadStage, 'v': 3});
    Navigator.of(context).pop(false);
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  int get _activePip => switch (_phase) {
        _Phase.language => 1,
        _Phase.phone => 2,
        _Phase.otp => 3,
        _Phase.intro || _Phase.preparing || _Phase.faceNeck => 4,
        _Phase.done => 5,
        _ => 4,
      };

  @override
  Widget build(BuildContext context) {
    final canPop = _phase == _Phase.language ||
        _phase == _Phase.phone ||
        _phase == _Phase.otp ||
        _phase == _Phase.intro ||
        _phase == _Phase.passed ||
        _phase == _Phase.failed ||
        _phase == _Phase.unavailable ||
        _phase == _Phase.dead;
    final showPips = _phase == _Phase.language ||
        _phase == _Phase.phone ||
        _phase == _Phase.otp ||
        _phase == _Phase.intro ||
        _phase == _Phase.preparing ||
        _phase == _Phase.faceNeck ||
        _phase == _Phase.done;
    return PopScope(
      canPop: canPop,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop && !canPop) {
          Analytics.capture('liveness_abandoned', {'step': _phase.name, 'v': 3});
        }
      },
      child: Scaffold(
        backgroundColor: LiveTheme.stage,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 22, 24, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                LivenessHeader(onRestart: _phase == _Phase.language ? null : _restart),
                const SizedBox(height: 16),
                if (showPips && _phase != _Phase.passed) ...[
                  Align(
                    alignment: Alignment.centerLeft,
                    child: StepPips(total: 5, active: _activePip),
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
      case _Phase.language:
        return LanguagePickerStep(initialLang: _lang, onConfirm: _onLanguageConfirmed);
      case _Phase.phone:
        return PhoneNumberStage(controller: _phone);
      case _Phase.otp:
        return OtpConfirmStage(controller: _phone);
      case _Phase.intro:
        return _intro();
      case _Phase.preparing:
        return const Center(child: CircularProgressIndicator(color: LiveTheme.lime));
      case _Phase.faceNeck:
        return _faceNeckView();
      case _Phase.done:
        return _doneView();
      case _Phase.passed:
        return _accepted();
      case _Phase.failed:
        return _failed();
      case _Phase.unavailable:
        return _unavailable();
      case _Phase.dead:
        return _deadView();
    }
  }

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
          "I'll talk you through it. Prop your phone up so I can see your face, "
          'then just follow along — come closer, blink, turn your head. It takes '
          'about 15 seconds, and the clip is deleted after the check.',
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

  Widget _faceNeckView() {
    final cam = _cam;
    final overlay = _session?.overlay ?? const LivenessOverlay();
    final s = _coachState;
    final framed = s.readyToRecord || _recording;
    final challenges = _session?.challenges ?? const [];
    final ch = _challengeIndex < challenges.length ? challenges[_challengeIndex] : null;
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
                // Server-randomized overlay drawn on the EXISTING oval widget.
                CustomPaint(painter: OverlayPainter(overlay: overlay, locked: framed)),
                Positioned(
                  top: 14,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: LiveTheme.pill(
                      label: _recording ? 'Rec' : 'Camera on',
                      filled: _recording ? LiveTheme.coral : LiveTheme.card,
                      textOnFill: _recording ? Colors.white : LiveTheme.ink,
                      leadingDotBlink: true,
                    ),
                  ),
                ),
                Positioned(
                  bottom: 16,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: LiveTheme.pill(
                      label: _hintLabel(),
                      filled: framed ? LiveTheme.lime : LiveTheme.card,
                      textOnFill: LiveTheme.ink,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        LiveTheme.stageHeadline(
          _recording ? 'Follow along — ' : 'Fit your face in the ',
          markWord: _recording ? 'nice work' : 'oval',
        ),
        const SizedBox(height: 6),
        Text(
          _recording && ch != null
              ? LivenessStrings.text(_lang, ch.instruction)
              : LivenessStrings.text(_lang, s.instruction),
          style: LiveTheme.subStyle,
        ),
        if (_recording && challenges.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('${_challengesDone.length} / ${challenges.length}',
              style: LiveTheme.subStyle),
        ],
      ],
    );
  }

  String _hintLabel() {
    if (_recording) return 'Keep going';
    final s = _coachState;
    if (s.readyToRecord) return 'Perfect';
    final t = LivenessStrings.text(_lang, s.instruction);
    return t.length > 24 ? 'Align your face' : t;
  }

  Widget _doneView() {
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
              color: LiveTheme.mint,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: const Icon(Icons.check_rounded, size: 48, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline("That's ", markWord: 'it!'),
        const SizedBox(height: 12),
        Text(
          "I'm checking now — you'll get a green tick in a minute. "
          'You can carry on in the app.',
          style: LiveTheme.subStyle,
        ),
        const Spacer(),
        LiveTheme.limeButton(
          label: 'Done',
          icon: Icons.arrow_forward_rounded,
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    );
  }

  Widget _accepted() {
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
              color: LiveTheme.lime,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: const Icon(Icons.verified_rounded, size: 48, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline("You're ", markWord: 'verified'),
        const SizedBox(height: 12),
        Text('Thanks — that keeps AvaTOK free of AI bots.', style: LiveTheme.subStyle),
        const Spacer(),
        LiveTheme.limeButton(
          label: widget.listingContext ? 'Create a listing' : 'Done',
          icon: Icons.arrow_forward_rounded,
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    );
  }

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
          LiveTheme.stageHeadline('Not verified ',
              markWord: 'yet', markFill: LiveTheme.coralMark, markText: LiveTheme.paper),
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
            Center(child: Text('Attempts left today: $_attemptsLeft', style: LiveTheme.subStyle)),
          ],
          const SizedBox(height: 20),
          LiveTheme.limeButton(
              label: 'Try again', icon: Icons.refresh, onPressed: canRetry ? _restart : null),
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
        Text('Verification is temporarily unavailable — please try again later.',
            style: LiveTheme.subStyle),
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

  /// [plan §5] The no-dead-screen error: plain language + Retry/Skip.
  Widget _deadView() {
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
            child: const Icon(Icons.hourglass_empty_rounded, size: 40, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 20),
        LiveTheme.stageHeadline('That took ', markWord: 'too long'),
        const SizedBox(height: 10),
        Text(
          "The camera didn't get going. This is usually a lighting or camera "
          "permission hiccup — let's try again, or skip for now.",
          style: LiveTheme.subStyle,
        ),
        const Spacer(),
        LiveTheme.limeButton(label: 'Try again', icon: Icons.refresh, onPressed: _restart),
        const SizedBox(height: 12),
        Center(
          child: GestureDetector(
            onTap: _skip,
            child: Text('Skip for now', style: LiveTheme.subStyle),
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
