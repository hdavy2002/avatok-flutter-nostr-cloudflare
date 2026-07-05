import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/ui/zine.dart';
import 'live_theme.dart';

/// [LIVE-UI-3] Chrome + per-stage decorative widgets for the redesigned dark
/// Liveness V2 flow. Kept out of the orchestrator so the orchestrator stays
/// about flow logic. All animations honour reduced-motion.

/// Top header: "LIVENESS CHECK" kicker + circular restart button.
class LivenessHeader extends StatelessWidget {
  const LivenessHeader({super.key, this.onRestart});
  final VoidCallback? onRestart;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        const Text(
          'LIVENESS CHECK',
          style: TextStyle(
            fontFamily: 'Nunito',
            fontWeight: FontWeight.w700,
            fontSize: 11,
            letterSpacing: 1.1,
            color: Color(0x9EF9F7ED), // paper @62%
          ),
        ),
        if (onRestart != null)
          GestureDetector(
            onTap: onRestart,
            child: Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: LiveTheme.card,
                shape: BoxShape.circle,
                border: Border.all(color: LiveTheme.ink, width: 2),
                boxShadow: Zine.shadowXs,
              ),
              child: const Icon(Icons.restart_alt_rounded, size: 18, color: LiveTheme.ink),
            ),
          )
        else
          const SizedBox(width: 34, height: 34),
      ],
    );
  }
}

/// Step pips (1..total) inside a pill.
class StepPips extends StatelessWidget {
  const StepPips({super.key, required this.total, required this.active});
  final int total;
  final int active;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      decoration: BoxDecoration(
        color: LiveTheme.card,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: LiveTheme.ink, width: 2),
        boxShadow: Zine.shadowXs,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= total; i++) ...[
            if (i > 1) const SizedBox(width: 6),
            _pip(i == active, i < active),
          ],
        ],
      ),
    );
  }

  Widget _pip(bool isActive, bool isDone) => AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        width: isActive ? 18 : 8,
        height: 8,
        decoration: BoxDecoration(
          color: (isActive || isDone) ? LiveTheme.lime : LiveTheme.ink.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(100),
          border: (isActive || isDone)
              ? Border.all(color: LiveTheme.ink, width: 1.4)
              : null,
        ),
      );
}

/// Footer lock line, present on every stage.
class LivenessFooter extends StatelessWidget {
  const LivenessFooter({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: const [
        Icon(Icons.lock_outline, size: 13, color: Color(0x80F9F7ED)),
        SizedBox(width: 7),
        Flexible(
          child: Text(
            'End-to-end encrypted — clips are deleted when you close your account.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: 'Nunito',
              fontWeight: FontWeight.w700,
              fontSize: 11,
              color: Color(0x80F9F7ED),
            ),
          ),
        ),
      ],
    );
  }
}

/// Blinking coral inset border for the recording stage.
class RecInsetBorder extends StatefulWidget {
  const RecInsetBorder({super.key, required this.reducedMotion});
  final bool reducedMotion;
  @override
  State<RecInsetBorder> createState() => _RecInsetBorderState();
}

class _RecInsetBorderState extends State<RecInsetBorder>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));
    if (!widget.reducedMotion) _c.repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: FadeTransition(
          opacity: widget.reducedMotion
              ? const AlwaysStoppedAnimation(1.0)
              : Tween<double>(begin: 1, end: 0.3).animate(_c),
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: LiveTheme.coral, width: 3),
            ),
          ),
        ),
      ),
    );
  }
}

/// A lime progress bar that fills over [durationMs].
class LiveProgressBar extends StatefulWidget {
  const LiveProgressBar({super.key, required this.fill, required this.durationMs});
  final Color fill;
  final int durationMs;
  @override
  State<LiveProgressBar> createState() => _LiveProgressBarState();
}

class _LiveProgressBarState extends State<LiveProgressBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: Duration(milliseconds: widget.durationMs))
      ..forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 18,
      decoration: BoxDecoration(
        color: const Color(0x24F9F7ED),
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: const Color(0x66F9F7ED), width: 2),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(100),
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) => Align(
            alignment: Alignment.centerLeft,
            child: FractionallySizedBox(
              widthFactor: _c.value.clamp(0.0, 1.0),
              child: Container(color: widget.fill),
            ),
          ),
        ),
      ),
    );
  }
}

/// The turn-head guide: staggered-blink caret arrows (3 sizes) each side, lime on
/// the active side + a dashed face circle in the middle.
class TurnHeadGuide extends StatelessWidget {
  const TurnHeadGuide({super.key, required this.leftActive, required this.rightActive});
  final bool leftActive;
  final bool rightActive;

  @override
  Widget build(BuildContext context) {
    final reduced = LiveTheme.reducedMotion(context);
    return Center(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _carets(Icons.chevron_left, leftActive, reduced, reverse: true),
          const SizedBox(width: 18),
          Container(
            width: 150,
            height: 150,
            decoration: BoxDecoration(
              color: const Color(0x0FF9F7ED),
              shape: BoxShape.circle,
              border: Border.all(color: LiveTheme.dimPaper, width: 3),
            ),
            child: const Icon(Icons.person, size: 92, color: Color(0xD1F9F7ED)),
          ),
          const SizedBox(width: 18),
          _carets(Icons.chevron_right, rightActive, reduced),
        ],
      ),
    );
  }

  Widget _carets(IconData icon, bool active, bool reduced, {bool reverse = false}) {
    final color = active ? LiveTheme.lime : const Color(0x38F9F7ED);
    final sizes = [22.0, 30.0, 38.0];
    final row = <Widget>[
      for (var i = 0; i < 3; i++)
        _BlinkCaret(
          icon: icon,
          size: sizes[i],
          color: color,
          delayMs: i * 150,
          animate: active && !reduced,
        ),
    ];
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: reverse ? row.reversed.toList() : row,
    );
  }
}

class _BlinkCaret extends StatefulWidget {
  const _BlinkCaret({
    required this.icon,
    required this.size,
    required this.color,
    required this.delayMs,
    required this.animate,
  });
  final IconData icon;
  final double size;
  final Color color;
  final int delayMs;
  final bool animate;
  @override
  State<_BlinkCaret> createState() => _BlinkCaretState();
}

class _BlinkCaretState extends State<_BlinkCaret>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));
    if (widget.animate) {
      Future.delayed(Duration(milliseconds: widget.delayMs), () {
        if (mounted) _c.repeat(reverse: true);
      });
    }
  }

  @override
  void didUpdateWidget(covariant _BlinkCaret old) {
    super.didUpdateWidget(old);
    if (widget.animate && !_c.isAnimating) {
      _c.repeat(reverse: true);
    } else if (!widget.animate && _c.isAnimating) {
      _c.stop();
      _c.value = 1;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final icon = Icon(widget.icon, size: widget.size, color: widget.color);
    if (!widget.animate) return icon;
    return FadeTransition(
      opacity: Tween<double>(begin: 1, end: 0.15).animate(_c),
      child: icon,
    );
  }
}

// ── Analyzing stage ─────────────────────────────────────────────────────────

enum RowState { pending, active, done }

class AnalyzeRowData {
  const AnalyzeRowData(this.label, this.state);
  final String label;
  final RowState state;
}

class AnalyzingStage extends StatelessWidget {
  const AnalyzingStage({super.key, required this.rows, required this.reducedMotion});
  final List<AnalyzeRowData> rows;
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _SpinningBadge(reducedMotion: reducedMotion),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline('Ava is ', markWord: 'checking'),
        const SizedBox(height: 6),
        Text('Face, motion and voice — all on your device.',
            textAlign: TextAlign.center, style: LiveTheme.subStyle),
        const SizedBox(height: 22),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Column(
            children: [
              for (final r in rows)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: _row(r),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _row(AnalyzeRowData r) {
    Widget marker;
    switch (r.state) {
      case RowState.done:
        marker = Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            color: LiveTheme.mint,
            shape: BoxShape.circle,
            border: Border.all(color: LiveTheme.ink, width: 2),
          ),
          child: const Icon(Icons.check, size: 12, color: LiveTheme.ink),
        );
        break;
      case RowState.active:
        marker = SizedBox(
          width: 22,
          height: 22,
          child: reducedMotion
              ? const Icon(Icons.autorenew, size: 20, color: LiveTheme.lilac)
              : const CircularProgressIndicator(strokeWidth: 2.5, color: LiveTheme.lilac),
        );
        break;
      case RowState.pending:
        marker = Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: LiveTheme.dimPaper, width: 2),
          ),
        );
        break;
    }
    return Opacity(
      opacity: r.state == RowState.pending ? 0.45 : 1,
      child: Row(
        children: [
          marker,
          const SizedBox(width: 10),
          Expanded(child: Text(r.label, style: LiveTheme.checkRowStyle)),
        ],
      ),
    );
  }
}

class _SpinningBadge extends StatefulWidget {
  const _SpinningBadge({required this.reducedMotion});
  final bool reducedMotion;
  @override
  State<_SpinningBadge> createState() => _SpinningBadgeState();
}

class _SpinningBadgeState extends State<_SpinningBadge>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 5));
    if (!widget.reducedMotion) _c.repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 170,
      height: 170,
      child: Stack(
        alignment: Alignment.center,
        children: [
          AnimatedBuilder(
            animation: _c,
            builder: (context, _) => Transform.rotate(
              angle: _c.value * 2 * math.pi,
              child: CustomPaint(size: const Size(170, 170), painter: _DashedRing(1)),
            ),
          ),
          AnimatedBuilder(
            animation: _c,
            builder: (context, _) => Transform.rotate(
              angle: -_c.value * 2 * math.pi,
              child: CustomPaint(size: const Size(138, 138), painter: _DashedRing(0.45)),
            ),
          ),
          Container(
            width: 96,
            height: 96,
            decoration: BoxDecoration(
              color: LiveTheme.lilac,
              shape: BoxShape.circle,
              border: Border.all(color: LiveTheme.ink, width: 2.5),
              boxShadow: Zine.shadowSm,
            ),
            child: const Icon(Icons.auto_awesome, size: 44, color: LiveTheme.ink),
          ),
        ],
      ),
    );
  }
}

class _DashedRing extends CustomPainter {
  _DashedRing(this.opacity);
  final double opacity;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = opacity < 1 ? 2 : 3
      ..color = LiveTheme.lilac.withValues(alpha: opacity);
    final rect = Offset.zero & size;
    final path = Path()..addOval(rect.deflate(2));
    const dash = 8.0, gap = 8.0;
    for (final m in path.computeMetrics()) {
      var d = 0.0;
      while (d < m.length) {
        canvas.drawPath(m.extractPath(d, d + dash), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRing old) => false;
}

// ── Accepted stage ──────────────────────────────────────────────────────────

class AcceptedStage extends StatefulWidget {
  const AcceptedStage({
    super.key,
    required this.reducedMotion,
    required this.listingContext,
    required this.onCta,
  });
  final bool reducedMotion;
  final bool listingContext;
  final VoidCallback onCta;
  @override
  State<AcceptedStage> createState() => _AcceptedStageState();
}

class _AcceptedStageState extends State<AcceptedStage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pop;
  @override
  void initState() {
    super.initState();
    _pop = AnimationController(vsync: this, duration: const Duration(milliseconds: 450));
    if (widget.reducedMotion) {
      _pop.value = 1;
    } else {
      _pop.forward();
    }
  }

  @override
  void dispose() {
    _pop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (!widget.reducedMotion) const _Confetti(),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ScaleTransition(
                    scale: CurvedAnimation(parent: _pop, curve: Curves.elasticOut),
                    child: Container(
                      width: 128,
                      height: 128,
                      decoration: BoxDecoration(
                        color: LiveTheme.lime,
                        shape: BoxShape.circle,
                        border: Border.all(color: LiveTheme.ink, width: 3),
                        boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
                      ),
                      child: const Icon(Icons.check, size: 60, color: LiveTheme.ink),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    decoration: BoxDecoration(
                      color: LiveTheme.mint,
                      borderRadius: BorderRadius.circular(100),
                      border: Border.all(color: LiveTheme.ink, width: 2),
                      boxShadow: Zine.shadowXs,
                    ),
                    child: const Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.verified, size: 14, color: LiveTheme.ink),
                      SizedBox(width: 6),
                      Text('Verified',
                          style: TextStyle(
                            fontFamily: 'Nunito',
                            fontWeight: FontWeight.w800,
                            fontSize: 12,
                            color: LiveTheme.ink,
                          )),
                    ]),
                  ),
                  const SizedBox(height: 16),
                  LiveTheme.stageHeadline('Accepted — you are ', markWord: 'in'),
                  const SizedBox(height: 6),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: Text(
                      widget.listingContext
                          ? "Liveness passed. You're free to make a listing now."
                          : "Liveness passed. Verified features are now unlocked.",
                      textAlign: TextAlign.center,
                      style: LiveTheme.subStyle,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        // Delete-mode storage card.
        Container(
          padding: const EdgeInsets.all(16),
          decoration: LiveTheme.taperedCardDecoration,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: LiveTheme.mint,
                  borderRadius: BorderRadius.circular(11),
                  border: Border.all(color: LiveTheme.ink, width: 2),
                ),
                child: const Icon(Icons.shield_outlined, size: 18, color: LiveTheme.ink),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Delete-mode storage',
                        style: TextStyle(
                          fontFamily: 'Nunito',
                          fontWeight: FontWeight.w800,
                          fontSize: 14,
                          color: LiveTheme.ink,
                        )),
                    SizedBox(height: 2),
                    Text(
                      'Your video is erased automatically the moment you close your account with us.',
                      style: TextStyle(
                        fontFamily: 'Nunito',
                        fontWeight: FontWeight.w700,
                        fontSize: 12.5,
                        height: 1.45,
                        color: LiveTheme.inkSoft,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        LiveTheme.limeButton(
          label: widget.listingContext ? 'Create a listing' : 'Done',
          icon: widget.listingContext ? Icons.storefront : Icons.check,
          onPressed: widget.onCta,
        ),
      ],
    );
  }
}

/// Simple floating confetti squares/dots for the accepted stage.
class _Confetti extends StatefulWidget {
  const _Confetti();
  @override
  State<_Confetti> createState() => _ConfettiState();
}

class _ConfettiState extends State<_Confetti> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  final _pieces = <({double x, double y, Color color, bool square, double delay})>[
    (x: 0.14, y: 0.12, color: LiveTheme.coral, square: true, delay: 0.0),
    (x: 0.80, y: 0.06, color: LiveTheme.lilac, square: false, delay: 0.2),
    (x: 0.08, y: 0.36, color: LiveTheme.mint, square: false, delay: 0.35),
    (x: 0.90, y: 0.30, color: LiveTheme.blue, square: true, delay: 0.12),
    (x: 0.24, y: 0.66, color: LiveTheme.lilac, square: true, delay: 0.5),
    (x: 0.78, y: 0.60, color: LiveTheme.coral, square: false, delay: 0.28),
  ];

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      return AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Stack(
            children: [
              for (final p in _pieces)
                Positioned(
                  left: box.maxWidth * p.x,
                  top: box.maxHeight * p.y - 9 * math.sin((_c.value + p.delay) * math.pi),
                  child: Container(
                    width: p.square ? 12 : 10,
                    height: p.square ? 12 : 10,
                    decoration: BoxDecoration(
                      color: p.color,
                      shape: p.square ? BoxShape.rectangle : BoxShape.circle,
                      borderRadius: p.square ? BorderRadius.circular(3) : null,
                      border: Border.all(color: LiveTheme.ink, width: 2),
                    ),
                  ),
                ),
            ],
          );
        },
      );
    });
  }
}
