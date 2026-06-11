import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/analytics.dart';
import '../../core/theme.dart';
import 'ladder_api.dart';

/// L2 liveness check (Workers AI provider). The random challenge is only
/// revealed when recording starts, so a pre-prepared clip can't pass:
///   1. start session → server returns 2 random actions + a 3-word phrase
///   2. front camera records a short clip; at each action prompt we also
///      capture a still frame (frame0/frame1) + one neutral frame (frame2)
///   3. frames + clip upload → server verifies with Workers AI vision+Whisper
/// PASS → green tick in AvaIdentity (one thumbnail kept, clip deleted).
/// FAIL → all evidence deleted server-side; retry within the 3/24h budget.
class LivenessCheckScreen extends StatefulWidget {
  const LivenessCheckScreen({super.key});
  @override
  State<LivenessCheckScreen> createState() => _LivenessCheckScreenState();
}

enum _Phase { intro, preparing, challenge, uploading, verifying, passed, failed }

class _LivenessCheckScreenState extends State<LivenessCheckScreen> {
  CameraController? _cam;
  _Phase _phase = _Phase.intro;
  String? _error;

  String _sessionId = '';
  List<String> _actions = const [];
  String _phrase = '';
  int _actionIx = -1; // -1 = say the phrase first, then actions 0..1
  String _prompt = '';

  final List<Uint8List?> _frames = [null, null, null];
  Uint8List? _clip;
  String? _failMessage;
  int? _attemptsLeft;

  static const _actionLabels = {
    'turn_left': 'Turn your head LEFT',
    'turn_right': 'Turn your head RIGHT',
    'smile': 'SMILE big',
    'sad_face': 'Make a SAD face',
    'mouth_open': 'Open your MOUTH wide',
    'eyebrows_raised': 'RAISE your eyebrows',
  };

  @override
  void dispose() {
    _cam?.dispose();
    super.dispose();
  }

  Future<void> _begin() async {
    setState(() { _phase = _Phase.preparing; _error = null; });
    Analytics.capture('liveness_started', const {});

    if (!await Permission.camera.request().isGranted ||
        !await Permission.microphone.request().isGranted) {
      setState(() { _phase = _Phase.intro; _error = 'Camera & microphone permission needed.'; });
      return;
    }

    final s = await LadderApi.livenessStart();
    if (s == null || s.sessionId.isEmpty) {
      setState(() { _phase = _Phase.intro; _error = 'Could not start — video verification may be unavailable right now.'; });
      return;
    }
    _sessionId = s.sessionId;
    _actions = s.actions;
    _phrase = s.phrase;

    try {
      final cams = await availableCameras();
      final front = cams.firstWhere(
          (c) => c.lensDirection == CameraLensDirection.front,
          orElse: () => cams.first);
      _cam = CameraController(front, ResolutionPreset.medium, enableAudio: true);
      await _cam!.initialize();
    } catch (_) {
      setState(() { _phase = _Phase.intro; _error = 'Could not open the front camera.'; });
      return;
    }
    if (!mounted) return;
    await _runChallenge();
  }

  Future<void> _runChallenge() async {
    final cam = _cam!;
    setState(() { _phase = _Phase.challenge; _actionIx = -1; _prompt = 'Say out loud:\n“$_phrase”'; });
    try {
      await cam.startVideoRecording();
    } catch (_) {
      setState(() { _phase = _Phase.intro; _error = 'Recording failed to start — try again.'; });
      return;
    }

    // ~3 s for the phrase, then ~2.5 s per action with a frame at each.
    await Future.delayed(const Duration(milliseconds: 3000));
    for (var i = 0; i < _actions.length && i < 2; i++) {
      if (!mounted) return;
      setState(() { _actionIx = i; _prompt = _actionLabels[_actions[i]] ?? _actions[i]; });
      await Future.delayed(const Duration(milliseconds: 2000));
      _frames[i] = await _still(cam);
      await Future.delayed(const Duration(milliseconds: 500));
    }
    if (!mounted) return;
    setState(() { _actionIx = 2; _prompt = 'Look straight at the camera'; });
    await Future.delayed(const Duration(milliseconds: 1200));
    _frames[2] = await _still(cam);

    XFile? rec;
    try { rec = await cam.stopVideoRecording(); } catch (_) {/* frames may still suffice */}
    if (rec != null) {
      try { _clip = await File(rec.path).readAsBytes(); } catch (_) {/* soft */}
      try { await File(rec.path).delete(); } catch (_) {/* tmp */}
    }
    await _uploadAndVerify();
  }

  /// Capture a still during recording; falls back to null (server treats a
  /// missing optional frame as a hard fail only for the two action frames).
  Future<Uint8List?> _still(CameraController cam) async {
    try {
      final x = await cam.takePicture();
      final b = await x.readAsBytes();
      try { await File(x.path).delete(); } catch (_) {}
      return b;
    } catch (_) {
      return null;
    }
  }

  Future<void> _uploadAndVerify() async {
    if (!mounted) return;
    setState(() => _phase = _Phase.uploading);
    if (_frames[0] == null || _frames[1] == null) {
      setState(() { _phase = _Phase.failed; _failMessage = 'We could not capture the challenge photos — please try again.'; });
      return;
    }
    for (var i = 0; i < 3; i++) {
      final f = _frames[i];
      if (f != null && !await LadderApi.livenessUpload(_sessionId, 'frame$i', f)) {
        setState(() { _phase = _Phase.failed; _failMessage = 'Upload failed — check your connection and try again.'; });
        return;
      }
    }
    final clip = _clip;
    if (clip != null && clip.lengthInBytes < 16000000) {
      await LadderApi.livenessUpload(_sessionId, 'clip', clip); // best-effort (phrase check)
    }

    if (!mounted) return;
    setState(() => _phase = _Phase.verifying);
    final r = await LadderApi.livenessVerify(_sessionId);
    if (!mounted) return;
    if (r.verified) {
      Analytics.capture('liveness_passed', const {});
      setState(() => _phase = _Phase.passed);
    } else {
      Analytics.capture('liveness_failed', {'message': r.message ?? ''});
      setState(() {
        _phase = _Phase.failed;
        _failMessage = r.message;
        _attemptsLeft = r.attemptsRemaining;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Video verification')),
      body: switch (_phase) {
        _Phase.intro => _intro(cs),
        _Phase.preparing => const Center(child: CircularProgressIndicator()),
        _Phase.challenge => _challengeView(),
        _Phase.uploading => _busy('Uploading…'),
        _Phase.verifying => _busy('Checking your clip…\nThis takes a few seconds.'),
        _Phase.passed => _done(cs),
        _Phase.failed => _failed(cs),
      },
    );
  }

  Widget _intro(ColorScheme cs) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Spacer(),
          const Icon(Icons.video_camera_front_outlined, size: 64, color: AvaColors.brand),
          const SizedBox(height: 16),
          Text('Prove you\'re a real person',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 10),
          Text(
            'A quick selfie video (5–10 s). We\'ll ask you to say a short phrase '
            'and make two random gestures. The clip is checked automatically and '
            'then DELETED — only a single photo stays on your AvaIdentity card.',
            textAlign: TextAlign.center,
            style: TextStyle(color: cs.onSurfaceVariant, height: 1.45),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: cs.error)),
          ],
          const Spacer(),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: _begin,
            child: const Text('Start'),
          ),
          const SizedBox(height: 8),
        ]),
      );

  Widget _challengeView() {
    final cam = _cam;
    return Stack(fit: StackFit.expand, children: [
      if (cam != null && cam.value.isInitialized) CameraPreview(cam) else const ColoredBox(color: Colors.black),
      Positioned(
        left: 0, right: 0, bottom: 48,
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 24),
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: .65),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Text(_prompt,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800, height: 1.3)),
        ),
      ),
      const Positioned(
        top: 16, right: 16,
        child: Row(children: [
          Icon(Icons.fiber_manual_record, color: Colors.redAccent, size: 16),
          SizedBox(width: 6),
          Text('REC', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        ]),
      ),
    ]);
  }

  Widget _busy(String msg) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const CircularProgressIndicator(color: AvaColors.brand),
          const SizedBox(height: 16),
          Text(msg, textAlign: TextAlign.center),
        ]),
      );

  Widget _done(ColorScheme cs) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Spacer(),
          const Icon(Icons.verified, size: 72, color: Color(0xFF10B981)),
          const SizedBox(height: 16),
          Text('You\'re verified ✓',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Text('Creator features and verified apps are now unlocked.',
              textAlign: TextAlign.center, style: TextStyle(color: cs.onSurfaceVariant)),
          const Spacer(),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Done'),
          ),
        ]),
      );

  Widget _failed(ColorScheme cs) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Spacer(),
          Icon(Icons.error_outline, size: 64, color: cs.error),
          const SizedBox(height: 16),
          Text('Not verified yet',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Text(
            '${_failMessage ?? 'Verification failed.'}'
            '${_attemptsLeft != null ? '\nAttempts left today: $_attemptsLeft' : ''}'
            '\n\nYour clip and photos were deleted.',
            textAlign: TextAlign.center,
            style: TextStyle(color: cs.onSurfaceVariant, height: 1.4),
          ),
          const Spacer(),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: (_attemptsLeft ?? 1) > 0 ? _begin : null,
            child: const Text('Try again'),
          ),
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Later')),
        ]),
      );
}
