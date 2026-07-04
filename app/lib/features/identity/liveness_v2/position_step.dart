import 'dart:async';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import 'face_gate.dart';
import 'flash_fill.dart';

/// Liveness V2 — POSITION step (Specs/LIVENESS-V2-PLAN.md §4 step 2). Shows the
/// front-camera preview inside an oval cutout with the flash-fill ring-light,
/// live coaching text under it, a row of gate chips, and — when EVERY gate
/// passes continuously for 1.0s — a green ring + [onReady] auto-advance, then a
/// 3-2-1 countdown ([onCountdownDone]).
///
/// The caller owns the [CameraController] (already initialized) and the
/// [FlashFillController] (already activated). This widget attaches a [FaceGate]
/// to the controller and detaches it on dispose.
class PositionStep extends StatefulWidget {
  const PositionStep({
    super.key,
    required this.controller,
    required this.flashFill,
    required this.onCountdownDone,
  });

  final CameraController controller;
  final FlashFillController flashFill;

  /// Fired once, after the gates hold for 1s AND the 3-2-1 countdown finishes.
  /// The orchestrator (Agent C) starts recording here.
  final VoidCallback onCountdownDone;

  @override
  State<PositionStep> createState() => _PositionStepState();
}

class _PositionStepState extends State<PositionStep> {
  FaceGate? _gate;
  FaceGateStatus _status = FaceGateStatus.searching();

  Timer? _holdTimer; // fires onReady after a continuous 1s all-pass
  bool _ready = false; // all gates held → countdown running
  int _count = 3; // 3-2-1
  Timer? _countTimer;

  final int _stepStartMs = DateTime.now().millisecondsSinceEpoch;
  final Set<String> _seenHints = {}; // throttle coach-hint telemetry per session

  @override
  void initState() {
    super.initState();
    _attachGate();
  }

  Future<void> _attachGate() async {
    final gate = FaceGate(
      controller: widget.controller,
      onStatus: _onStatus,
    );
    _gate = gate;
    try {
      await gate.start();
    } catch (_) {/* preview still shows; gates just won't update */}
  }

  void _onStatus(FaceGateStatus s) {
    if (!mounted || _ready) return;
    setState(() => _status = s);

    // Throttle: one liveness_coach_hint per hint-id per session.
    final id = s.hintId;
    if (id != null && _seenHints.add(id)) {
      Analytics.capture('liveness_coach_hint', {'hint_id': id, 'step': 'position'});
    }

    if (s.allPass) {
      _holdTimer ??= Timer(const Duration(milliseconds: 1000), _onHeld);
    } else {
      _holdTimer?.cancel();
      _holdTimer = null;
    }
  }

  void _onHeld() {
    if (!mounted || _ready) return;
    Analytics.capture('liveness_step', {
      'step': 'position',
      'outcome': 'passed',
      'ms': DateTime.now().millisecondsSinceEpoch - _stepStartMs,
    });
    setState(() {
      _ready = true;
      _count = 3;
    });
    _countTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      if (_count <= 1) {
        t.cancel();
        // Detach the gate before capture so its image stream doesn't fight the
        // orchestrator's video recording.
        _gate?.dispose();
        _gate = null;
        widget.onCountdownDone();
      } else {
        setState(() => _count--);
      }
    });
  }

  @override
  void dispose() {
    _holdTimer?.cancel();
    _countTimer?.cancel();
    _gate?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cam = widget.controller;
    final ready = _status.allPass;
    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: FlashFillSurround(
              active: widget.flashFill.isActive,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(Zine.rSm),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (cam.value.isInitialized)
                      CameraPreview(cam)
                    else
                      const ColoredBox(color: Zine.ink),
                    // Oval cutout + ring (green when all gates pass).
                    CustomPaint(
                      painter: _OvalPainter(
                        ringColor: ready ? Zine.mint : Zine.paper,
                        ringWidth: ready ? 6 : 3,
                      ),
                    ),
                    if (_ready)
                      Center(
                        child: Text(
                          '$_count',
                          style: ZineText.hero(size: 96, color: Zine.paper),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
        // Live coaching line.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 4),
          child: Text(
            _ready
                ? 'Hold still…'
                : (_status.hint ?? 'Perfect — hold it there'),
            textAlign: TextAlign.center,
            style: ZineText.cardTitle(
              size: 18,
              color: ready ? Zine.mintInk : Zine.ink,
            ),
          ),
        ),
        // Gate chips.
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
          child: Wrap(
            alignment: WrapAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              _chip('Face', _status.faceFound),
              _chip('Only you', _status.singleFace),
              _chip('In frame', _status.insideOval && _status.sizeOk),
              _chip('Level', _status.levelOk),
              _chip('Well lit', _status.brightOk && _status.notBacklit),
              _chip('Eyes open', _status.eyesOpen),
            ],
          ),
        ),
      ],
    );
  }

  Widget _chip(String label, bool ok) => ZineChip(label: label, active: ok);
}

/// Darkens everything outside a centered oval and draws the ring on its edge.
class _OvalPainter extends CustomPainter {
  _OvalPainter({required this.ringColor, required this.ringWidth});

  final Color ringColor;
  final double ringWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final oval = Rect.fromCenter(
      center: Offset(size.width / 2, size.height * 0.46),
      width: size.width * 0.66,
      height: size.height * 0.6,
    );

    // Scrim outside the oval (even-odd cutout).
    final scrim = Path()
      ..addRect(Offset.zero & size)
      ..addOval(oval)
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(
      scrim,
      Paint()..color = Zine.ink.withValues(alpha: 0.45),
    );

    // Ring on the oval edge.
    canvas.drawOval(
      oval,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = ringWidth
        ..color = ringColor,
    );
  }

  @override
  bool shouldRepaint(_OvalPainter old) =>
      old.ringColor != ringColor || old.ringWidth != ringWidth;
}
