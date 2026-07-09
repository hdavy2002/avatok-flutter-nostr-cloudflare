import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../core/analytics.dart';
import '../ladder_api.dart';
import '../liveness_v2/flash_fill.dart';
import '../liveness_v2/live_theme.dart';
import '../liveness_v2/pending_session.dart';
import '../liveness_v2/stage_chrome.dart';
import 'active_checks.dart';
import 'challenge_session.dart';
import 'coaching_engine.dart';
import 'frame_capture.dart';
import 'language_picker_step.dart';
import 'overlay_painter.dart';
import 'sensor_capture.dart';
import 'voice_packs.dart';
import 'watchdog.dart';

/// Liveness V3 — VOICE-GUIDED orchestrator (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md). Reuses the V2 dark-stage UI (LiveTheme, header/pips/footer, oval
/// overlay) and ADDS behaviour: a language picker, Ava voice
/// coaching from on-device ML Kit, server-randomized challenges rendered on the
/// existing oval, a per-stage no-dead-screen watchdog, and background upload to
/// the presigned R2 target. Ships behind `RemoteConfig.livenessV3Enabled`; V2 is
/// untouched and used when the flag is off.
///
/// [ISSUE-LIVE-PHONE-1] (owner decision 2026-07-09): the PHONE + OTP stages were
/// REMOVED from this flow. V3 is liveness-only — no phone number is collected and
/// no SMS is sent. `PhoneVerifyController` / `PhoneNumberStage` / `OtpConfirmStage`
/// still live in `liveness_v2/phone_stage.dart` and are still used by V2 and by
/// `profile/phone_verify_card.dart`; nothing there changed.
///
/// Flow: language → intro → faceNeck (framing + challenges,
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
  CameraController? _cam;
  CoachingEngine? _coach;

  _Phase _phase = _Phase.language;
  String? _error;

  String _lang = 'en';

  LivenessV3Session? _session;

  // Coaching / recording state.
  CoachState _coachState = const CoachState.searching();
  /// [ISSUE-LIVE-CAM-1] How many coach states arrived this stage. 0 at dead_screen
  /// means the camera stream never delivered a frame (or ML Kit never ran) — a
  /// different bug entirely from "frames arrived but no face was found".
  int _coachStates = 0;
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

  // ── Active anti-avatar checks (screen flash / vibrate / motion / integrity) ──
  final math.Random _rng = math.Random();
  final SensorCapture _sensors = SensorCapture();
  final List<LumaSample> _lumaBuf = [];
  final List<FlashEvent> _flashEvents = [];
  final List<Timer> _activeTimers = []; // scheduled flash/vibrate fire timers
  int? _vibrateEventMs;
  int _recordStartMs = 0;
  Color? _flashColor; // non-null → full-screen colour wash is showing
  IntegrityReport _integrity = const IntegrityReport();
  CameraInfo _cameraInfo = const CameraInfo();

  // ── Interim client-frame path (plan §0-C) ──
  // Grabs still JPEGs at the session capture_offsets from the coach's camera
  // stream and uploads them in the verify body so the server has a frame set
  // WITHOUT the (not-yet-bound) MEDIA_EXTRACT decoder. See frame_capture.dart.
  FrameCapture? _frameCapture;
  int _sensorOrientation = 0;
  CameraLensDirection _lensDirection = CameraLensDirection.front;

  // Fail state.
  List<String> _failMessages = const [];
  int? _attemptsLeft;
  String _deadStage = '';

  int _stageStartMs = DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    _lang = LivenessVoice.deviceLang();
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
      // Not yet known at flow entry — the session (with its active_checks block)
      // is fetched later in _begin, which re-emits this with the resolved value.
      'active_checks': 'pending',
      // [ISSUE-LIVE-PHONE-1] liveness-only from 2026-07-09; no phone/OTP stages.
      'phone_stage': false,
      'v': 3,
    });
  }

  @override
  void dispose() {
    _recordCap?.cancel();
    _challengeTimer?.cancel();
    _readTimer?.cancel();
    _autoStartTimer?.cancel();
    for (final t in _activeTimers) {
      t.cancel();
    }
    _activeTimers.clear();
    unawaited(_sensors.drain());
    _activeWatch?.dispose();
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
    _coachStates = 0; // [ISSUE-LIVE-CAM-1] per-stage, so a retry starts clean
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
      // [ISSUE-LIVE-CAM-1] Without these, a dead_screen is unactionable — it says
      // the stage stalled but not which half stalled. coach_states == 0 → no frames
      // reached the coach at all (camera stream / ML Kit init); > 0 → frames flowed
      // but the face was never framed well enough to start recording.
      'coach_states': _coachStates,
      'cam_initialized': _cam?.value.isInitialized ?? false,
      'cam_streaming': _cam?.value.isStreamingImages ?? false,
      'recording': _recording,
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
    // [ISSUE-LIVE-PHONE-1] Straight to the liveness intro — no phone/OTP gate, so
    // no VerificationApi.isPhoneVerified() round-trip and no SMS is ever sent.
    _setStage(_Phase.intro);
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
    // Record whether this session carried server-scheduled active checks (screen
    // flashes / haptic buzz / randomized gaps) — plan telemetry.
    Analytics.capture('liveness_flow_start', {
      'requester': widget.requester,
      'policy_id': widget.policyId,
      'language': _lang,
      'active_checks': s.activeChecks.present,
      'flash_steps': s.activeChecks.flashSequence.length,
      'has_vibrate': s.activeChecks.vibrate != null,
      'v': 3,
    });

    // Camera-path integrity probe (best-effort; runs off the critical path).
    unawaited(_probeIntegrity());

    try {
      final cams = await availableCameras();
      final front = cams.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cams.first,
      );
      // 720p cap (plan §6). medium ≈ 480–720p, keeps the clip small.
      //
      // [ISSUE-LIVE-CAM-1] (2026-07-09) imageFormatGroup was UNSET, so Android gave
      // us YUV420_888 (three strided planes). CoachingEngine._toInputImage then
      // concatenated those planes and told ML Kit it was NV21 — which it is not
      // (NV21 is one buffer with interleaved chroma). Every processImage() threw
      // into a bare `catch (_) { return; }`, so the coach emitted ZERO states, the
      // stage watchdog was never poked, and 10s later the user was told "the camera
      // didn't get going… a lighting or camera permission hiccup." Neither the
      // camera nor the lighting was ever at fault. Ask for NV21 directly (Android)
      // / BGRA8888 (iOS) — both are single-plane and exactly what ML Kit accepts.
      _cam = CameraController(
        front,
        ResolutionPreset.medium,
        enableAudio: true,
        imageFormatGroup:
            Platform.isAndroid ? ImageFormatGroup.nv21 : ImageFormatGroup.bgra8888,
      );
      await _cam!.initialize();
      _captureCameraInfo(front);
    } catch (e) {
      // [ISSUE-LIVE-CAM-1] (2026-07-09) This used to be `catch (_)` — the real
      // exception was dropped on the floor and the user got a generic string. Note
      // enableAudio:true means a DENIED MIC permission throws here too, which reads
      // to the user as "camera problem". Capture the actual error.
      Analytics.error(
        domain: 'liveness',
        code: 'camera_init_failed',
        message: e.toString(),
        screen: 'liveness_v3',
        action: 'camera_init',
        extra: {'requester': widget.requester, 'v': 3},
      );
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

  Future<void> _probeIntegrity() async {
    try {
      final r = await IntegrityProbe.probe();
      if (!mounted) return;
      _integrity = r;
      // Analytics requires non-null values → coalesce unknown bools to 'unknown'.
      Analytics.capture('liveness_integrity_probe', {
        'rooted': r.rooted ?? 'unknown',
        'emulator': r.emulator ?? 'unknown',
        'physical_device': r.emulator == null ? 'unknown' : !r.emulator!,
        'v': 3,
      });
    } catch (_) {/* leave the empty report — flow proceeds */}
  }

  void _captureCameraInfo(CameraDescription desc) {
    _sensorOrientation = desc.sensorOrientation;
    _lensDirection = desc.lensDirection;
    try {
      final ps = _cam?.value.previewSize;
      _cameraInfo = CameraInfo(
        model: desc.name,
        resolution: ps == null ? null : '${ps.width.round()}x${ps.height.round()}',
        fps: null, // camera plugin doesn't surface a fixed fps; server derives it
      );
    } catch (_) {/* null fields — flow proceeds */}
  }

  // ── Face + neck stage: coaching → record → challenges ───────────────────────

  void _startCoaching() {
    final cam = _cam;
    if (cam == null) return;
    // Interim client-frame collector (plan §0-C). Built here so it can receive the
    // coach's stream frames; armed only once recording actually starts.
    _frameCapture = FrameCapture(
      captureOffsets: _session?.captureOffsets ?? const [],
      sensorOrientation: _sensorOrientation,
      lensDirection: _lensDirection,
    );
    final coach = CoachingEngine(
      controller: cam,
      onState: _onCoachState,
      onLuma: _onLuma,
      onImage: (image) {
        if (_recording) _frameCapture?.offer(image);
      },
      // [ISSUE-LIVE-CAM-1] Frames are arriving but none can be analysed → this is a
      // client bug (format mismatch / ML Kit reject), not the user's lighting. Say so
      // immediately rather than letting the watchdog blame them 10 seconds later.
      onFatal: (reason, error) {
        Analytics.error(
          domain: 'liveness',
          code: 'coach_frames_unusable',
          message: '$reason${error != null ? " :: $error" : ""}',
          screen: 'liveness_v3',
          action: 'analyse',
          extra: {'requester': widget.requester, 'v': 3},
        );
      },
    );
    _coach = coach;
    // [ISSUE-LIVE-CAM-1] (2026-07-09) `unawaited(coach.start())` swallowed any
    // exception from startImageStream / ML Kit init. When start() failed, no coach
    // state was ever emitted, so _onCoachState never ran, so the watchdog never got
    // poked — and the user sat on a live-looking preview until the 10s watchdog
    // fired `dead_screen` and told them it was "a lighting or camera permission
    // hiccup". PostHog 2026-07-09 build 12374: two faceNeck failures, ms=10001 both
    // times, zero coach hints in between. Surface the real failure instead.
    unawaited(coach.start().catchError((Object e) {
      Analytics.error(
        domain: 'liveness',
        code: 'coach_start_failed',
        message: e.toString(),
        screen: 'liveness_v3',
        action: 'coach_start',
        extra: {'requester': widget.requester, 'v': 3},
      );
      if (mounted) {
        setState(() {
          _phase = _Phase.intro;
          _error = 'Could not start the face check.';
        });
      }
    }));
    // [LIVE-SCRIPT-1] (owner decision 2026-07-09) NO framing gate. The old flow
    // waited for readyToRecord (face inside the oval, held steady 2s) before
    // recording — on real phones users got stuck forever on "look up a little /
    // fit the oval" and nothing ever happened. Recording now starts on the FIRST
    // detected face, or unconditionally after this grace timer. The coach keeps
    // running for telemetry (luma/frames/nudges) but never blocks anyone.
    _autoStartTimer?.cancel();
    _autoStartTimer = Timer(const Duration(milliseconds: 2500), () {
      if (mounted && _phase == _Phase.faceNeck && !_recording) {
        Analytics.capture('liveness_record_autostart', {'reason': 'grace_timer', 'v': 3});
        _startRecording();
      }
    });
  }

  void _onCoachState(CoachState s) {
    if (!mounted || _phase != _Phase.faceNeck) return;
    _coachState = s;
    _coachStates++; // [ISSUE-LIVE-CAM-1] proves whether frames ever arrived
    _activeWatch?.poke(); // any frame with a state = progress (kills the watchdog)

    if (!_recording) {
      // [LIVE-SCRIPT-1] Framing is a ≤2.5s formality now: the first frame with a
      // face (any face, anywhere on screen) starts the recording, and the grace
      // timer starts it regardless. No oval, no hold-still, no "look up a little"
      // treadmill — the server judges quality from the clip afterwards.
      _emitCoachHint(s.instruction);
      if (s.faceFound) {
        _startRecording();
      }
      setState(() {});
      return;
    }
    // Recording phase: coach states are advisory only. During the read-aloud step
    // nothing is evaluated; during head prompts a detected pose advances early,
    // but the timer advances regardless (never stuck, never failed client-side).
    if (!_reading) _evaluateChallenge(s);
    setState(() {});
  }

  /// Collect the mean frame luminance for the active-checks `luma_timeline`
  /// (flash detection). Timestamps are offsets from recording start; samples
  /// before recording are ignored. Buffered raw, downsampled to ≤60 on drain.
  void _onLuma(double meanLuma) {
    if (!_recording || _recordStartMs == 0) return;
    if (_lumaBuf.length >= 400) return; // headroom over the ≤60 final cap
    final t = DateTime.now().millisecondsSinceEpoch - _recordStartMs;
    _lumaBuf.add(LumaSample(t: t < 0 ? 0 : t, luma: meanLuma));
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

  // ── [LIVE-SCRIPT-1] Read-aloud step ──────────────────────────────────────────
  // The clip records AUDIO (enableAudio: true) — asking the user to read a short
  // random phrase captures their voice + a moving, talking face, which is far
  // stronger liveness evidence than a silent oval-hold. Random digits make a
  // pre-recorded replay unable to match the session.
  bool _reading = false;
  Timer? _readTimer;
  Timer? _autoStartTimer;
  late final String _readPhrase = _makeReadPhrase();

  String _makeReadPhrase() {
    final d = List.generate(4, (_) => _rng.nextInt(10)).join(' ');
    return 'My AvaTOK code is $d';
  }

  Future<void> _startRecording() async {
    final cam = _cam;
    if (cam == null || _recording) return;
    _recording = true;
    _autoStartTimer?.cancel();
    try {
      await cam.startVideoRecording();
    } catch (_) {
      _recording = false;
      _stageFail('face_neck', 'record_start_failed');
      return;
    }
    // t0 for every active-checks timeline / event offset (record start).
    _recordStartMs = DateTime.now().millisecondsSinceEpoch;
    _sensors.start(_recordStartMs);
    _scheduleActiveChecks();
    // Safety cap on the clip length (plan §3 — ≤~20s, 720p).
    final capS = _session?.maxClipSeconds ?? 20;
    // Arm the interim client-frame capture over the expected clip window so the
    // server capture_offsets map onto real record-start-relative times (plan §0-C).
    _frameCapture?.arm(
      recordStartMs: _recordStartMs,
      expectedClipMs: capS * 1000,
    );
    _recordCap = Timer(Duration(seconds: capS), () {
      Analytics.capture('liveness_record_capped', {'seconds': capS, 'v': 3});
      _finishCapture();
    });
    // [LIVE-SCRIPT-1] Step 1: read the phrase out loud (~5s), THEN the timed
    // head prompts. Everything advances on a clock — the user can never be stuck.
    _reading = true;
    Analytics.capture('liveness_read_phrase_shown', {
      'phrase': _readPhrase,
      'language': _lang,
      'v': 3,
    });
    if (mounted) setState(() {});
    _readTimer?.cancel();
    _readTimer = Timer(const Duration(seconds: 4), () {
      if (!mounted || !_recording) return;
      _reading = false;
      Analytics.capture('liveness_read_phrase_done', {'v': 3});
      setState(() {});
      _challengeIndex = 0;
      _announceChallenge();
    });
  }

  /// Schedule the server's flash sequence + haptic buzz relative to record start.
  /// Each fire records its ACTUAL timestamp (for server correlation against the
  /// luma / motion timelines) and never stops recording. Best-effort: a missing
  /// plugin or a failed flash just skips that step and telemetry notes it.
  void _scheduleActiveChecks() {
    final active = _session?.activeChecks;
    if (active == null || !active.present) return;
    for (final f in active.flashSequence) {
      final t = Timer(Duration(milliseconds: f.tOffsetMs.clamp(0, 60000)), () {
        if (!mounted || !_recording) return;
        _fireFlash(f);
      });
      _activeTimers.add(t);
    }
    final vib = active.vibrate;
    if (vib != null) {
      final t = Timer(Duration(milliseconds: vib.tOffsetMs.clamp(0, 60000)), () {
        if (!mounted || !_recording) return;
        _fireVibrate(vib);
      });
      _activeTimers.add(t);
    }
  }

  static const Map<String, Color> _flashColors = {
    'white': Color(0xFFFFFFFF),
    'red': Color(0xFFFF2D2D),
    'blue': Color(0xFF2D6BFF),
  };

  void _fireFlash(FlashStep f) {
    final color = _flashColors[f.color] ?? _flashColors['white']!;
    final actual = DateTime.now().millisecondsSinceEpoch - _recordStartMs;
    _flashEvents.add(FlashEvent(color: f.color, tActualMs: actual < 0 ? 0 : actual));
    Analytics.capture('liveness_active_check', {
      'check': 'flash',
      'color': f.color,
      'scheduled_ms': f.tOffsetMs,
      'actual_ms': actual < 0 ? 0 : actual,
      'v': 3,
    });
    Analytics.capture('liveness_flash_shown', {
      'color': f.color,
      'duration_ms': f.durationMs,
      'v': 3,
    });
    // Show the full-screen colour wash, then fade it out after duration_ms.
    setState(() => _flashColor = color);
    final dur = f.durationMs.clamp(60, 1500);
    final t = Timer(Duration(milliseconds: dur), () {
      if (!mounted) return;
      setState(() => _flashColor = null);
    });
    _activeTimers.add(t);
  }

  Future<void> _fireVibrate(VibrateStep v) async {
    final actual = (DateTime.now().millisecondsSinceEpoch - _recordStartMs).clamp(0, 60000);
    _vibrateEventMs = actual;
    Analytics.capture('liveness_active_check', {
      'check': 'vibrate',
      'scheduled_ms': v.tOffsetMs,
      'actual_ms': actual,
      'v': 3,
    });
    // HapticFeedback is a built-in Flutter service (no plugin). heavyImpact gives
    // the sharpest accelerometer signature for the server to correlate. Repeat a
    // couple of times for a longer buzz when duration_ms is generous.
    try {
      await HapticFeedback.heavyImpact();
      if (v.durationMs >= 250) {
        await Future<void>.delayed(const Duration(milliseconds: 120));
        await HapticFeedback.heavyImpact();
      }
    } catch (_) {/* no haptics on this device — motion timeline still captured */}
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
    // [LIVE-SCRIPT-1] Timed script: each prompt holds for 3.5s and then ADVANCES
    // regardless of what ML Kit saw. The old flow only re-announced and waited —
    // if the on-device detector never registered the pose ("look up a little…"
    // forever) the user was stuck for the whole 20s cap. A detected pose still
    // advances early (nicer cadence); the server verifies the actual motion from
    // the sampled frames + sensor/luma timelines, so a missed client detection
    // costs nothing.
    _challengeTimer?.cancel();
    _challengeTimer = Timer(const Duration(milliseconds: 3000), () {
      if (mounted && _recording) _advanceChallenge(cleared: false);
    });
  }

  void _evaluateChallenge(CoachState s) {
    if (_gapActive) return; // holding between prompts (randomized gap)
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
    if (cleared) _advanceChallenge(cleared: true);
  }

  /// [LIVE-SCRIPT-1] Move to the next prompt — reached EITHER by ML Kit seeing
  /// the pose (cleared: true, advances early with a "good" chirp) OR by the
  /// 3.5s prompt timer (cleared: false). The client never fails a prompt; the
  /// `cleared` flag is recorded so the server/analytics know which prompts the
  /// on-device detector actually confirmed.
  void _advanceChallenge({required bool cleared}) {
    final ch = _session?.challenges;
    if (ch == null || _challengeIndex >= ch.length) return;
    if (_challengesDone.contains(_challengeIndex)) return;
    final c = ch[_challengeIndex];
    _challengesDone.add(_challengeIndex);
    if (cleared) unawaited(LivenessVoice.I.play(LivenessInstruction.good));
    Analytics.capture('liveness_stage_complete', {
      'stage': 'challenge_${c.kind.name}',
      'index': _challengeIndex,
      'client_cleared': cleared,
      'v': 3,
    });
    _challengeIndex++;
    if (_challengeIndex >= ch.length) {
      _finishCapture();
    } else {
      // Randomized wait between prompts so the challenge cadence isn't
      // predictable (server value if present, else local 700–1900 ms). During
      // the gap we hold evaluation so a lingering pose can't clear the NEXT
      // challenge before it's announced.
      final gapMs = (_session?.activeChecks ?? const ActiveChecks.none())
          .gapForIndex(_challengeIndex - 1, _rng);
      _gapActive = true;
      Analytics.capture('liveness_active_check', {
        'check': 'gap',
        'scheduled_ms': gapMs,
        'actual_ms': gapMs,
        'v': 3,
      });
      _challengeTimer?.cancel();
      _challengeTimer = Timer(Duration(milliseconds: gapMs), () {
        _gapActive = false;
        if (mounted && _recording) _announceChallenge();
      });
    }
  }

  bool _gapActive = false;

  Future<void> _finishCapture() async {
    _recordCap?.cancel();
    _challengeTimer?.cancel();
    _readTimer?.cancel();
    _autoStartTimer?.cancel();
    _activeWatch?.cancel();
    for (final t in _activeTimers) {
      t.cancel();
    }
    _activeTimers.clear();
    _flashColor = null;
    final recordMs =
        _recordStartMs == 0 ? 0 : DateTime.now().millisecondsSinceEpoch - _recordStartMs;
    await _coach?.dispose();
    _coach = null;
    await _stopRecording();
    // Assemble the active-checks evidence while the buffers are fresh.
    await _buildCaptureMeta(recordMs);
    if (!mounted) return;
    unawaited(LivenessVoice.I.play(LivenessInstruction.done));
    await _flash.deactivate();
    _stageComplete('face_neck');
    _emitCaptureMetrics();
    // User proceeds IMMEDIATELY — the check runs in the background (plan §6).
    setState(() => _phase = _Phase.done);
    unawaited(_uploadAndVerify());
  }

  CaptureMeta? _captureMeta;

  /// Drain the motion buffer and build the ≤32 KB `capture_meta` block, emitting
  /// the sensor/luma telemetry. Best-effort: any missing signal → null/empty field.
  Future<void> _buildCaptureMeta(int recordMs) async {
    List<SensorSample> sensors = const [];
    try {
      sensors = await _sensors.drain();
    } catch (_) {/* empty timeline — flow proceeds */}
    final luma = downsample(List<LumaSample>.of(_lumaBuf), 60);
    _captureMeta = CaptureMeta(
      sensorTimeline: sensors,
      lumaTimeline: luma,
      flashEvents: List<FlashEvent>.of(_flashEvents),
      vibrateEventMs: _vibrateEventMs,
      integrity: _integrity,
      camera: _cameraInfo,
    );
    Analytics.capture('liveness_sensor_capture', {
      'samples': sensors.length,
      'raw_samples': _sensors.rawSampleCount,
      'gyro': _sensors.gyroAvailable,
      'duration_ms': recordMs,
      'v': 3,
    });
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
      'luma_samples': _captureMeta?.lumaTimeline.length ?? _lumaBuf.length,
      'flash_events': _flashEvents.length,
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
    //    exact R2 object. Also attach the INTERIM client frames (plan §0-C): still
    //    JPEGs the server uses as its frame set until MEDIA_EXTRACT exists.
    final captured = _frameCapture?.frames ?? const <CapturedFrame>[];
    if (captured.isNotEmpty) {
      final totalBytes = captured.fold<int>(0, (a, f) => a + f.jpeg.lengthInBytes);
      Analytics.capture('liveness_frames_uploaded', {
        'count': captured.length,
        'bytes': totalBytes,
        'source': 'client',
        'v': 3,
      });
    }
    await LivenessPendingSession.set(session.sessionId);
    final r = await LivenessV3Api.verify(
      session.sessionId,
      objectKey: session.upload.objectKey,
      captureMeta: _captureMeta,
      frames: captured,
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
    _readTimer?.cancel();
    _autoStartTimer?.cancel();
    _activeWatch?.cancel();
    for (final t in _activeTimers) {
      t.cancel();
    }
    _activeTimers.clear();
    try {
      await _sensors.drain();
    } catch (_) {}
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
    _gapActive = false;
    _challengeIndex = 0;
    _challengesDone.clear();
    _hintsSeen.clear();
    // Reset active-check buffers so a retry captures a clean session.
    _lumaBuf.clear();
    _flashEvents.clear();
    _vibrateEventMs = null;
    _flashColor = null;
    _recordStartMs = 0;
    _captureMeta = null;
    _frameCapture?.reset();
    _frameCapture = null;
    _session = null;
    _retries++;
    if (!mounted) return;
    setState(() {
      _phase = _Phase.intro;
      _error = null;
      _failMessages = const [];
      _attemptsLeft = null;
    });
    // [ISSUE-LIVE-PHONE-1] A restart always re-enters at the liveness intro.
    Analytics.capture('liveness_restart', {'v': 3, 'to': 'intro'});
  }

  void _skip() {
    // Skip a dead stage — record it and let the user out (they can retry later).
    Analytics.capture('liveness_stage_skip', {'stage': _deadStage, 'v': 3});
    Navigator.of(context).pop(false);
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  /// [ISSUE-LIVE-PHONE-1] Three steps now (language → liveness → done); the phone
  /// and OTP pips are gone. Keep in step with [_pipTotal].
  static const int _pipTotal = 3;

  int get _activePip => switch (_phase) {
        _Phase.language => 1,
        _Phase.intro || _Phase.preparing || _Phase.faceNeck => 2,
        _Phase.done => 3,
        _ => 2,
      };

  @override
  Widget build(BuildContext context) {
    final canPop = _phase == _Phase.language ||
        _phase == _Phase.intro ||
        _phase == _Phase.passed ||
        _phase == _Phase.failed ||
        _phase == _Phase.unavailable ||
        _phase == _Phase.dead;
    final showPips = _phase == _Phase.language ||
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
                    child: StepPips(total: _pipTotal, active: _activePip),
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
          "Quick and easy: I'll record a short clip. Read one line out loud, "
          'then follow a couple of prompts — turn your head, look up. '
          'About 15 seconds, and the clip is deleted after the check.',
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
                // Active-check SCREEN FLASH: a full-preview colour wash at high
                // brightness (white/red/blue) that the camera must SEE — recording
                // never stops, and the wash fades subtly in/out (~120ms). A printed
                // photo / emulator / injected virtual camera won't show the reflected
                // light in the luma_timeline.
                Positioned.fill(
                  child: IgnorePointer(
                    child: AnimatedOpacity(
                      opacity: _flashColor != null ? 1.0 : 0.0,
                      duration: const Duration(milliseconds: 120),
                      child: ColoredBox(color: _flashColor ?? Colors.transparent),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        // [LIVE-SCRIPT-1] Script UI: read-aloud phrase first (big card), then the
        // timed head prompts. No more "fit your face in the oval" demand — the
        // pre-record window lasts ≤2.5s and needs nothing from the user.
        if (_reading) ...[
          LiveTheme.stageHeadline('Read this ', markWord: 'out loud'),
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            decoration: BoxDecoration(
              color: LiveTheme.card,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: LiveTheme.ink, width: 2),
            ),
            child: Text(
              '“$_readPhrase”',
              textAlign: TextAlign.center,
              style: const TextStyle(
                  fontSize: 24, fontWeight: FontWeight.w800, color: LiveTheme.ink),
            ),
          ),
        ] else ...[
          LiveTheme.stageHeadline(
            _recording ? 'Follow along — ' : 'Look at the ',
            markWord: _recording ? 'nice work' : 'camera',
          ),
          const SizedBox(height: 6),
          Text(
            _recording && ch != null
                ? LivenessStrings.text(_lang, ch.instruction)
                : 'Starting in a moment — no need to line anything up.',
            style: LiveTheme.subStyle,
          ),
          if (_recording && challenges.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('${_challengesDone.length} / ${challenges.length}',
                style: LiveTheme.subStyle),
          ],
        ],
      ],
    );
  }

  String _hintLabel() {
    if (_reading) return 'Speak clearly';
    if (_recording) return 'Keep going';
    return 'Get comfy';
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
