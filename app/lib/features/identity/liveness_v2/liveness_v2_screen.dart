import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../ladder_api.dart';
import 'expression_step.dart';
import 'flash_fill.dart';
import 'head_circle_step.dart';
import 'pending_session.dart';
import 'phrase_step.dart';
import 'position_step.dart';
import 'tips_sheet.dart';

/// Liveness V2 — the detection-gated orchestrator (Specs/LIVENESS-V2-PLAN.md §4).
/// Replaces V1's timer script: every challenge step advances ONLY when ML Kit
/// confirms the action (or the user takes an explicit action), never on a clock.
///
/// Flow: intro → preflight (perms + FlashFill on) → PositionStep → 3-2-1 →
/// startVideoRecording → HeadCircle → Expression → Phrase → stopRecording →
/// REVIEW (neutral still: Use this? Retake/Submit) → upload → verifying (poll
/// LadderApi.livenessResult) → result.
///
/// Ships behind `RemoteConfig.livenessV2Enabled` (the push sites choose V1 vs
/// V2); V1 [LivenessCheckScreen] is untouched. Brightness is ALWAYS restored via
/// the FlashFillController's try/finally, including on dispose and every early
/// return.
class LivenessV2Screen extends StatefulWidget {
  const LivenessV2Screen({super.key});

  @override
  State<LivenessV2Screen> createState() => _LivenessV2ScreenState();
}

enum _Phase {
  intro,
  preparing,
  position,
  headCircle,
  expression,
  phrase,
  review,
  uploading,
  verifying,
  passed,
  failed,
}

class _LivenessV2ScreenState extends State<LivenessV2Screen> {
  final FlashFillController _flash = FlashFillController();
  CameraController? _cam;

  _Phase _phase = _Phase.intro;
  String? _error;

  // Challenge from the server.
  String _sessionId = '';
  String _phrase = '';
  String _expression = 'smile';

  // Captured evidence.
  Uint8List? _profileLeft, _profileRight, _profileUp, _profileDown;
  String _expressionId = 'smile';
  Uint8List? _expressionFrame;
  Uint8List? _neutralFrame;
  Uint8List? _clip;

  // Continuous-guard overlay message (face lost / second face). Null = clear.
  String? _guard;

  // Every failing check's user_message, each shown as its own line on the fail
  // screen (Agent E P4). Empty when the fail is a local error (upload etc.).
  List<String> _failMessages = const [];
  int? _attemptsLeft;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @override
  void initState() {
    super.initState();
    // Verify-pending resilience: if we backgrounded mid-verify last time, resume
    // that session's result instead of restarting the whole video (plan §4 s7).
    _resumePendingIfAny();
  }

  Future<void> _resumePendingIfAny() async {
    final sid = await LivenessPendingSession.get();
    if (sid == null || sid.isEmpty || !mounted) return;
    setState(() {
      _sessionId = sid;
      _phase = _Phase.verifying;
    });
    final res = await LadderApi.livenessResultOutcome(sid);
    if (!mounted) return;
    if (res.pending) {
      // Still checking server-side — poll a little, then let the user reopen.
      final done = await _pollResume(sid);
      if (!mounted) return;
      if (!done) {
        // Give up gracefully back to intro; the pending sid stays for next open.
        setState(() {
          _phase = _Phase.intro;
          _error = 'We\'re still checking your last video — reopen this screen '
              'in a minute to see the result.';
        });
      }
      return;
    }
    if (res.noResult) {
      // The session is gone (expired / cleared). Drop it and show a clean intro.
      await LivenessPendingSession.clear();
      if (!mounted) return;
      setState(() => _phase = _Phase.intro);
      return;
    }
    await _applyOutcome(res);
  }

  /// Poll a resumed session up to 60s (30 × 2s). Returns true if it resolved to
  /// a terminal outcome (which [_applyOutcome] then renders).
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
    // Restore brightness no matter how we leave (try/finally inside deactivate).
    _flash.dispose();
    _cam?.dispose();
    super.dispose();
  }

  void _abandon(String step) {
    Analytics.capture('liveness_abandoned', {'step': step});
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

  /// Render a terminal verify outcome (pass or fail) + clear the pending session
  /// so it isn't resumed again. Fires the pass/fail funnel event.
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
      setState(() => _phase = _Phase.passed);
    } else {
      Analytics.capture('liveness_failed', {
        'v': 2,
        'checks': res.failedMessages.length,
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

    if (!await Permission.camera.request().isGranted ||
        !await Permission.microphone.request().isGranted) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Camera & microphone permission needed.';
      });
      return;
    }

    final s = await LadderApi.livenessStart();
    if (s == null || s.sessionId.isEmpty) {
      setState(() {
        _phase = _Phase.intro;
        _error = 'Could not start — video verification may be unavailable right now.';
      });
      return;
    }
    _sessionId = s.sessionId;
    _phrase = s.phrase;
    _expression = _pickExpression(s.actions);

    try {
      final cams = await availableCameras();
      final front = cams.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cams.first,
      );
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

    // Flash-fill on for the whole capture (A8/A9 mitigation).
    await _flash.activate();
    if (!mounted) return;
    setState(() => _phase = _Phase.position);
  }

  /// Choose the ONE expression to ask (plan §4 4b). Prefer a non-turn expression
  /// from the server challenge; fall back to `smile`.
  String _pickExpression(List<String> actions) {
    const supported = {'smile', 'mouth_open', 'eyebrows_raised', 'blink_twice'};
    for (final a in actions) {
      if (supported.contains(a)) return a;
    }
    return 'smile';
  }

  // ── Step transitions ───────────────────────────────────────────────────────

  Future<void> _onPositionDone() async {
    final cam = _cam;
    if (cam == null) {
      await _fail('Camera closed — please try again.');
      return;
    }
    try {
      await cam.startVideoRecording();
    } catch (_) {
      await _fail('Recording failed to start — try again.');
      return;
    }
    if (!mounted) return;
    setState(() => _phase = _Phase.headCircle);
  }

  void _onHeadCircleDone(
    Uint8List? left,
    Uint8List? right,
    Uint8List? up,
    Uint8List? down,
  ) {
    _profileLeft = left;
    _profileRight = right;
    _profileUp = up;
    _profileDown = down;
    if (!mounted) return;
    setState(() {
      _guard = null;
      _phase = _Phase.expression;
    });
  }

  void _onExpressionDone(String id, Uint8List? frame) {
    _expressionId = id;
    _expressionFrame = frame;
    if (!mounted) return;
    setState(() {
      _guard = null;
      _phase = _Phase.phrase;
    });
  }

  Future<void> _onPhraseDone() async {
    // Grab a neutral still, then stop recording.
    final cam = _cam;
    if (cam != null) {
      _neutralFrame = await _still(cam);
    }
    await _stopRecordingSafely();
    if (!mounted) return;
    setState(() {
      _guard = null;
      _phase = _Phase.review;
    });
  }

  Future<void> _stopRecordingSafely() async {
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

  // ── Guards (continuous during challenge) ───────────────────────────────────

  void _guardFaceLost() {
    if (!mounted) return;
    setState(() => _guard = 'Come back into the oval');
  }

  void _guardFaceBack() {
    if (!mounted) return;
    setState(() => _guard = null);
  }

  void _guardSecondFace() {
    if (!mounted) return;
    setState(() => _guard = 'Make sure only you are in the frame');
  }

  // ── Review → upload → verify ───────────────────────────────────────────────

  void _retakeFromReview() {
    // Reset captured evidence and re-run the whole capture (not the network
    // session — the challenge/session id is still valid within its TTL).
    _profileLeft = _profileRight = _profileUp = _profileDown = null;
    _expressionFrame = null;
    _neutralFrame = null;
    _clip = null;
    setState(() {
      _guard = null;
      _phase = _Phase.position;
    });
    // Re-activate flash-fill (dispose may have deactivated on fail paths; here
    // it is still active, activate() is idempotent).
    _flash.activate();
  }

  Future<void> _submit() async {
    if (!mounted) return;
    setState(() => _phase = _Phase.uploading);
    await _flash.deactivate(); // capture done — restore brightness now

    // Build the ordered part list. Until Agent D lands the multi-part server,
    // send the 3 most important as frame0/frame1/frame2 (expression, one
    // profile, neutral) and the rest as extra0.. + profile_* named parts so a
    // V2-aware server can pick them up. Order per prompt: expression, neutral,
    // profiles.
    final profiles = <String, Uint8List?>{
      'profile_left': _profileLeft,
      'profile_right': _profileRight,
      'profile_up': _profileUp,
      'profile_down': _profileDown,
    };
    final firstProfile =
        profiles.values.firstWhere((v) => v != null, orElse: () => null);

    // frame0 = expression, frame1 = first available profile, frame2 = neutral.
    final key = <String, Uint8List?>{
      'frame0': _expressionFrame,
      'frame1': firstProfile,
      'frame2': _neutralFrame,
    };
    for (final e in key.entries) {
      final b = e.value;
      if (b == null) continue;
      if (!await LadderApi.livenessUpload(_sessionId, e.key, b)) {
        await _fail('Upload failed — check your connection and try again.');
        return;
      }
    }

    // Named profile parts (server-side Agent D reads these); best-effort.
    for (final e in profiles.entries) {
      final b = e.value;
      if (b != null) {
        await LadderApi.livenessUpload(_sessionId, e.key, b);
      }
    }

    final clip = _clip;
    if (clip != null && clip.lengthInBytes < 16000000) {
      await LadderApi.livenessUpload(_sessionId, 'clip', clip);
    }

    if (!mounted) return;
    setState(() => _phase = _Phase.verifying);
    // Persist BEFORE verifying so a background/kill mid-check can resume this
    // exact session on reopen instead of restarting the whole video.
    await LivenessPendingSession.set(_sessionId);
    final r = await LadderApi.livenessVerifyRich(_sessionId);
    if (!mounted) return;
    if (r.pending) {
      // Verify hasn't resolved within the poll window. Keep the pending sid and
      // let the user reopen to see the result (resilience path in initState).
      setState(() {
        _phase = _Phase.intro;
        _error = 'We\'re still checking your video — reopen this screen in a '
            'minute to see the result.';
      });
      return;
    }
    await _applyOutcome(r);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _phase == _Phase.intro ||
          _phase == _Phase.passed ||
          _phase == _Phase.failed,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) return;
        if (_phase != _Phase.intro &&
            _phase != _Phase.passed &&
            _phase != _Phase.failed) {
          _abandon(_phase.name);
        }
      },
      child: Scaffold(
        backgroundColor: Zine.paper,
        appBar: const ZineAppBar(
          title: 'Video check',
          markWord: 'Video',
          tag: 'prove you\'re real',
        ),
        body: switch (_phase) {
          _Phase.intro => _intro(),
          _Phase.preparing =>
            const Center(child: CircularProgressIndicator(color: Zine.blueInk)),
          _Phase.position => _positionView(),
          _Phase.headCircle => _challengeShell(
              HeadCircleStep(
                controller: _cam!,
                onComplete: _onHeadCircleDone,
                onFaceLost: _guardFaceLost,
                onFaceBack: _guardFaceBack,
                onSecondFace: _guardSecondFace,
              ),
            ),
          _Phase.expression => _challengeShell(
              ExpressionStep(
                controller: _cam!,
                expression: _expression,
                onComplete: _onExpressionDone,
                onFaceLost: _guardFaceLost,
                onFaceBack: _guardFaceBack,
                onSecondFace: _guardSecondFace,
              ),
            ),
          _Phase.phrase => _challengeShell(
              PhraseStep(phrase: _phrase, onComplete: _onPhraseDone),
            ),
          _Phase.review => _review(),
          _Phase.uploading => _busy('Uploading…'),
          _Phase.verifying =>
            _busy('Checking your clip…\nThis can take up to a minute.'),
          _Phase.passed => _done(),
          _Phase.failed => _failed(),
        },
      ),
    );
  }

  Widget _positionView() {
    final cam = _cam;
    if (cam == null) return const SizedBox.shrink();
    return PositionStep(
      controller: cam,
      flashFill: _flash,
      onCountdownDone: _onPositionDone,
    );
  }

  /// Wraps a challenge step over the live camera preview + REC sticker + guard
  /// banner. The step widgets paint their own overlays on top.
  Widget _challengeShell(Widget step) {
    final cam = _cam;
    return Stack(
      fit: StackFit.expand,
      children: [
        if (cam != null && cam.value.isInitialized)
          CameraPreview(cam)
        else
          const ColoredBox(color: Zine.ink),
        step,
        const Positioned(
          top: 16,
          right: 16,
          child: ZineSticker('● rec', kind: ZineStickerKind.no),
        ),
        if (_guard != null)
          Positioned(
            top: 16,
            left: 16,
            right: 70,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: Zine.coral,
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Border.all(color: Zine.ink, width: Zine.bw),
              ),
              child: Text(
                _guard!,
                style: ZineText.tag(size: 13, color: Colors.white),
              ),
            ),
          ),
      ],
    );
  }

  Widget _intro() => ZineScrollBody(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Spacer(),
          Center(
            child: Container(
              width: 104,
              height: 104,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                color: Zine.lilac,
                border: Border.fromBorderSide(
                    BorderSide(color: Zine.ink, width: Zine.bwLg)),
                boxShadow: Zine.shadow,
              ),
              child: PhosphorIcon(
                  PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                  size: 46,
                  color: Zine.ink),
            ),
          ),
          const SizedBox(height: 22),
          Text('Prove you\'re a real person',
              textAlign: TextAlign.center, style: ZineText.hero(size: 28)),
          const SizedBox(height: 12),
          Text(
            'A quick, guided selfie video. We\'ll help you line up your face, '
            'then ask you to move your head in a circle, make one expression, '
            'and say a short phrase. Nothing is rushed — each step waits for you. '
            'The clip is checked automatically and stored securely, used only for '
            'safety review.',
            textAlign: TextAlign.center,
            style: ZineText.sub(size: 14),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Center(
                  child: SizedBox(width: 280, child: ZineErrorMsg(_error!))),
            ),
          const Spacer(),
          ZineButton(
              label: 'Start', fullWidth: true, fontSize: 19, onPressed: _begin),
          const SizedBox(height: 8),
        ]),
      );

  Widget _review() {
    final frame = _neutralFrame;
    return ZineScrollBody(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SizedBox(height: 8),
        Text('Use this photo?',
            textAlign: TextAlign.center, style: ZineText.hero(size: 26)),
        const SizedBox(height: 6),
        Text('This is the neutral shot we\'ll check. Looks good?',
            textAlign: TextAlign.center, style: ZineText.sub(size: 14)),
        const SizedBox(height: 18),
        Center(
          child: Container(
            decoration: BoxDecoration(
              border: Border.all(color: Zine.ink, width: Zine.bwLg),
              boxShadow: Zine.shadow,
              borderRadius: BorderRadius.circular(Zine.rSm),
            ),
            clipBehavior: Clip.antiAlias,
            child: frame != null
                ? Image.memory(frame, width: 220, height: 280, fit: BoxFit.cover)
                : Container(
                    width: 220,
                    height: 280,
                    color: Zine.ink,
                    child: const Center(
                      child: Icon(Icons.person, color: Zine.paper, size: 64),
                    ),
                  ),
          ),
        ),
        const SizedBox(height: 24),
        ZineButton(
            label: 'Submit', fullWidth: true, fontSize: 19, onPressed: _submit),
        const SizedBox(height: 12),
        Center(child: ZineLink('RETAKE', onTap: _retakeFromReview)),
        const SizedBox(height: 8),
      ]),
    );
  }

  Widget _busy(String msg) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const CircularProgressIndicator(color: Zine.blueInk),
          const SizedBox(height: 18),
          Text(msg, textAlign: TextAlign.center, style: ZineText.sub(size: 14)),
        ]),
      );

  Widget _done() => ZineSuccessOverlay(
        icon: PhosphorIcons.sealCheck(PhosphorIconsStyle.fill),
        headline: 'You\'re verified',
        sub: 'Creator features and verified apps are now unlocked.',
        ctaLabel: 'Done',
        onCta: () => Navigator.of(context).pop(true),
      );

  Widget _failed() {
    final msgs = _failMessages.isEmpty
        ? const ['Verification failed — please try again.']
        : _failMessages;
    final canRetry = (_attemptsLeft ?? 1) > 0;
    return ZineScrollBody(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SizedBox(height: 8),
        Center(
          child: Container(
            width: 92,
            height: 92,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: Zine.coral,
              border: Border.fromBorderSide(
                  BorderSide(color: Zine.ink, width: Zine.bwLg)),
              boxShadow: Zine.shadow,
            ),
            child: PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold),
                size: 42, color: Colors.white),
          ),
        ),
        const SizedBox(height: 20),
        Text('Not verified yet',
            textAlign: TextAlign.center, style: ZineText.hero(size: 28)),
        const SizedBox(height: 6),
        Text(
          msgs.length > 1
              ? 'A few things to fix and try again:'
              : 'Here\'s what to fix and try again:',
          textAlign: TextAlign.center,
          style: ZineText.sub(size: 14),
        ),
        const SizedBox(height: 14),
        // Every failed check as its own warning-icon line (zine ZineErrorMsg style).
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          decoration: BoxDecoration(
            color: Zine.card,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Border.all(color: Zine.ink, width: Zine.bw),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [for (final m in msgs) ZineErrorMsg(m)],
          ),
        ),
        if (_attemptsLeft != null) ...[
          const SizedBox(height: 12),
          Center(
            child: Text('Attempts left today: $_attemptsLeft',
                textAlign: TextAlign.center, style: ZineText.sub(size: 13)),
          ),
        ],
        const SizedBox(height: 16),
        Center(
          child: ZineLink('Tips for a good video',
              onTap: () => LivenessTipsSheet.show(context)),
        ),
        const SizedBox(height: 24),
        ZineButton(
          label: 'Try again',
          fullWidth: true,
          fontSize: 19,
          onPressed: canRetry
              ? () {
                  setState(() {
                    _phase = _Phase.intro;
                    _error = null;
                    _failMessages = const [];
                  });
                }
              : null,
        ),
        const SizedBox(height: 14),
        Center(
            child: ZineLink('LATER',
                onTap: () => Navigator.of(context).pop(false))),
        const SizedBox(height: 8),
      ]),
    );
  }
}
