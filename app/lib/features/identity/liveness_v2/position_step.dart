import 'dart:async';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/avatok_dark.dart';
import 'face_gate.dart';
import 'flash_fill.dart';
import 'live_theme.dart';

/// Liveness V2 — POSITION step (Specs/LIVENESS-V2-PLAN.md §4 step 2), restyled
/// to the new dark stage [LIVE-UI-3].
///
/// Shows the live front-camera preview inside the rounded camera card with a
/// dashed oval that turns solid lime when EVERY ML Kit gate passes (face present
/// / single / in-frame / level / lit / eyes open). A "Camera on" pill (blinking
/// coral dot) sits at the top; while searching a lime scanning line sweeps and an
/// "Align your face" pill shows; on lock a lime "Face locked" pill pops. After
/// the gates hold ~1s the step auto-advances (no visible 3-2-1 — the design
/// locks and moves straight on).
///
/// CRITICAL BUG FIX [LIVE-UI-3]: the OLD position view rendered requirement chips
/// in a bottom Wrap with no SafeArea, so on Android they slid UNDER the system
/// nav bar and became untappable ("menu buttons hidden underneath and do
/// nothing"). The redesign removes that chip row entirely (the single lock pill
/// replaces it) and the orchestrator wraps the whole stage in SafeArea, so
/// nothing is ever clipped by the nav bar.
///
/// The caller owns the [CameraController] (initialized) and [FlashFillController]
/// (activated). This widget attaches a [FaceGate] and detaches it on lock/dispose.
class PositionStep extends StatefulWidget {
  const PositionStep({
    super.key,
    required this.controller,
    required this.flashFill,
    required this.onCountdownDone,
    this.onLockedGate,
  });

  final CameraController controller;
  final FlashFillController flashFill;

  /// Fired once the gates hold for ~1s (the orchestrator then captures the
  /// neutral still + starts recording). Named for source-compat with the old flow.
  final VoidCallback onCountdownDone;

  /// [LIVE-DEVAUTH-1] Reports the ML Kit gate snapshot at the moment of lock so
  /// the orchestrator can build the optional `device_report` (single_face,
  /// eyes_open, occlusion-clear + representative scores). Best-effort — null when
  /// no all-pass snapshot was captured.
  final void Function(FaceGateStatus locked)? onLockedGate;

  @override
  State<PositionStep> createState() => _PositionStepState();
}

class _PositionStepState extends State<PositionStep> {
  FaceGate? _gate;
  FaceGateStatus _status = FaceGateStatus.searching();

  Timer? _holdTimer; // fires _onHeld after a continuous ~1s all-pass
  bool _locked = false;

  final int _stepStartMs = DateTime.now().millisecondsSinceEpoch;
  final Set<String> _seenHints = {};

  @override
  void initState() {
    super.initState();
    _attachGate();
  }

  Future<void> _attachGate() async {
    final gate = FaceGate(controller: widget.controller, onStatus: _onStatus);
    _gate = gate;
    try {
      await gate.start();
    } catch (_) {/* preview still shows; gates just won't update */}
  }

  void _onStatus(FaceGateStatus s) {
    if (!mounted || _locked) return;
    setState(() => _status = s);

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
    if (!mounted || _locked) return;
    Analytics.capture('liveness_step', {
      'step': 'position',
      'outcome': 'passed',
      'ms': DateTime.now().millisecondsSinceEpoch - _stepStartMs,
    });
    setState(() => _locked = true);
    // [LIVE-DEVAUTH-1] Surface the all-pass gate snapshot at lock (single_face,
    // eyes-open, occlusion-clear + scores) for the optional device_report.
    widget.onLockedGate?.call(_status);
    // Brief lock-pop, then hand back so the orchestrator can grab the neutral
    // still and start recording. Detach the gate first so its image stream does
    // not fight the video recording.
    Timer(const Duration(milliseconds: 700), () {
      if (!mounted) return;
      _gate?.dispose();
      _gate = null;
      widget.onCountdownDone();
    });
  }

  @override
  void dispose() {
    _holdTimer?.cancel();
    _gate?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cam = widget.controller;
    final reduced = LiveTheme.reducedMotion(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: LiveTheme.cameraStage(
            child: Stack(
              fit: StackFit.expand,
              children: [
                if (cam.value.isInitialized)
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

                // "Camera on" pill, top-centre.
                Positioned(
                  top: 14,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: LiveTheme.pill(
                      label: 'Camera on',
                      filled: LiveTheme.card,
                      textOnFill: AD.textPrimary,
                      leadingDotBlink: true,
                    ),
                  ),
                ),

                // Dashed oval → solid lime on lock, + scanning line while searching.
                CustomPaint(
                  painter: _OvalPainter(
                    locked: _locked || _status.allPass,
                    reducedMotion: reduced,
                  ),
                ),

                // Bottom status pill.
                Positioned(
                  bottom: 16,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: (_locked || _status.allPass)
                        ? LiveTheme.pill(
                            label: 'Face locked',
                            filled: LiveTheme.lime,
                            icon: Icons.check,
                          )
                        : LiveTheme.pill(
                            label: _shortHint(),
                            filled: LiveTheme.card,
                            textOnFill: AD.textPrimary,
                          ),
                  ),
                ),

                // Scanning line (searching only).
                if (!_locked && !_status.allPass && !reduced)
                  const Positioned.fill(child: _ScanLine()),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        LiveTheme.stageHeadline('Fit your face in the ', markWord: 'oval'),
        const SizedBox(height: 6),
        Text(
          "Hold your phone at eye level — I'll lock on automatically.",
          style: LiveTheme.subStyle,
        ),
      ],
    );
  }

  /// A very short coach label for the bottom pill (design shows "Align your
  /// face"; we surface the specific gate hint when we have one so users still
  /// get the actionable feedback the old chips gave, just in one line).
  String _shortHint() {
    final h = _status.hint;
    if (h == null || h.isEmpty) return 'Align your face';
    return h.length > 24 ? 'Align your face' : h;
  }
}

/// Dashed oval (searching) → solid lime oval (locked), with a subtle pulse.
class _OvalPainter extends CustomPainter {
  _OvalPainter({required this.locked, required this.reducedMotion});
  final bool locked;
  final bool reducedMotion;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromCenter(
      center: Offset(size.width / 2, size.height * 0.5),
      width: size.width * 0.5,
      height: size.height * 0.42,
    );
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..color = locked ? LiveTheme.lime : LiveTheme.dimPaper;

    if (locked) {
      canvas.drawOval(rect, paint);
    } else {
      // Dashed oval.
      _dashedOval(canvas, rect, paint);
    }
  }

  void _dashedOval(Canvas canvas, Rect rect, Paint paint) {
    final path = Path()..addOval(rect);
    const dash = 10.0, gap = 8.0;
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        final seg = metric.extractPath(d, d + dash);
        canvas.drawPath(seg, paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_OvalPainter old) => old.locked != locked;
}

/// A lime scanning line that sweeps top→bottom while the face is being found.
class _ScanLine extends StatefulWidget {
  const _ScanLine();
  @override
  State<_ScanLine> createState() => _ScanLineState();
}

class _ScanLineState extends State<_ScanLine>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(seconds: 2))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        return LayoutBuilder(builder: (context, box) {
          final y = box.maxHeight * (0.06 + 0.74 * _c.value);
          return Stack(children: [
            Positioned(
              left: box.maxWidth * 0.09,
              right: box.maxWidth * 0.09,
              top: y,
              child: Container(
                height: 22,
                decoration: const BoxDecoration(
                  color: Color(0x29E8833A), // primaryBadge @16%
                  border: Border(top: BorderSide(color: LiveTheme.lime, width: 2.5)),
                ),
              ),
            ),
          ]);
        });
      },
    );
  }
}
