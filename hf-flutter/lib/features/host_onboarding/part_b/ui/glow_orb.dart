import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';

/// The "making your profile" moment (HF-MOTION-D): a glowing orb of soft colour blobs (primary, sunshine, blush,
/// lavender) that swirl round each other and merge. [progress] (0..1, the share of finished stages) makes the
/// glow brighter.
///
/// When [resolved] turns true the blobs open out and fade and [child] (the host's avatar) grows in their place,
/// with a sparkle burst on top. Display only: it never changes how the job is started, followed or retried.
/// Reduced motion: no swirl; a still orb, or the avatar straight away once [resolved].
class GlowOrb extends StatefulWidget {
  const GlowOrb({
    super.key,
    this.size = 176,
    this.progress = 0,
    this.resolved = false,
    this.child,
  });

  final double size;
  final double progress;
  final bool resolved;
  final Widget? child;

  static const List<Color> colors = <Color>[
    HfColors.primary,
    HfColors.sunshine,
    HfColors.blush,
    HfColors.lavender,
  ];

  @override
  State<GlowOrb> createState() => _GlowOrbState();
}

class _GlowOrbState extends State<GlowOrb> with TickerProviderStateMixin {
  late final AnimationController _swirl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 6000),
  );
  late final AnimationController _reveal = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _sync();
  }

  @override
  void didUpdateWidget(GlowOrb old) {
    super.didUpdateWidget(old);
    if (old.resolved != widget.resolved) _sync();
  }

  void _sync() {
    final reduced = hfReduceMotion(context);
    if (widget.resolved) {
      _swirl.stop();
      if (reduced) {
        _reveal.value = 1;
      } else if (_reveal.value < 1 && !_reveal.isAnimating) {
        _reveal.forward();
      }
      return;
    }
    _reveal.value = 0;
    if (reduced) {
      _swirl.stop();
    } else if (!_swirl.isAnimating) {
      _swirl.repeat();
    }
  }

  @override
  void dispose() {
    _swirl.dispose();
    _reveal.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final size = widget.size;
    final reduced = hfReduceMotion(context);
    return SizedBox.square(
      key: const ValueKey<String>('gen-orb'),
      dimension: size,
      child: AnimatedBuilder(
        animation: Listenable.merge([_swirl, _reveal]),
        builder: (context, _) {
          final r = Curves.easeOutBack.transform(_reveal.value);
          final fade = (1 - _reveal.value).clamp(0.0, 1.0).toDouble();
          return Stack(
            alignment: Alignment.center,
            clipBehavior: Clip.none,
            children: [
              if (fade > 0)
                Opacity(
                  opacity: fade,
                  child: RepaintBoundary(
                    child: CustomPaint(
                      size: Size.square(size),
                      painter: OrbPainter(
                        t: _swirl.value,
                        progress: widget.progress,
                        open: _reveal.value,
                      ),
                    ),
                  ),
                ),
              if (widget.resolved && widget.child != null)
                Transform.scale(
                  scale: 0.55 + 0.45 * r,
                  child: Opacity(
                    opacity: _reveal.value.clamp(0.0, 1.0).toDouble(),
                    child: Container(
                      key: const ValueKey<String>('gen-orb-avatar'),
                      width: size * 0.78,
                      height: size * 0.78,
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: HfGradients.sun,
                        boxShadow: [
                          BoxShadow(
                            color: HfColors.sunshine.withValues(alpha: 0.6),
                            blurRadius: 24,
                            spreadRadius: 2,
                          ),
                        ],
                      ),
                      child: ClipOval(child: widget.child),
                    ),
                  ),
                ),
              if (widget.resolved && !reduced)
                IgnorePointer(
                  child: HfLottie(
                    HfLottieAssets.sparkleBurst,
                    width: size * 1.3,
                    height: size * 1.3,
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// Four blurred colour blobs orbiting the centre at different speeds and distances, over a warm glow, with a
/// bright core. [open] (0..1) pushes the blobs outwards as the orb resolves.
class OrbPainter extends CustomPainter {
  OrbPainter({required this.t, required this.progress, this.open = 0});

  final double t;
  final double progress;
  final double open;

  static const List<double> _speeds = <double>[1, -2, 3, -1];
  static const List<double> _phases = <double>[0, 1.7, 3.1, 4.6];

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final base = size.shortestSide / 2;
    final p = progress.clamp(0.0, 1.0).toDouble();

    // Warm halo.
    canvas.drawCircle(
      c,
      base * 0.95,
      Paint()
        ..shader = RadialGradient(
          colors: [
            HfColors.sunshine.withValues(alpha: 0.35 + 0.25 * p),
            HfColors.sunshine.withValues(alpha: 0),
          ],
        ).createShader(Rect.fromCircle(center: c, radius: base * 0.95)),
    );

    for (var i = 0; i < GlowOrb.colors.length; i++) {
      final angle = 2 * math.pi * t * _speeds[i] + _phases[i];
      final wobble = math.sin(2 * math.pi * t * 2 + i);
      final dist = base * (0.2 + 0.06 * wobble + 0.45 * open);
      final centre = c + Offset(math.cos(angle), math.sin(angle)) * dist;
      final radius = base * (0.42 + 0.05 * wobble);
      final colour = GlowOrb.colors[i];
      canvas.drawCircle(
        centre,
        radius,
        Paint()
          ..maskFilter = MaskFilter.blur(BlurStyle.normal, base * 0.12)
          ..shader = RadialGradient(
            colors: [
              colour.withValues(alpha: 0.95),
              colour.withValues(alpha: 0),
            ],
          ).createShader(Rect.fromCircle(center: centre, radius: radius)),
      );
    }

    // Bright core where the blobs merge.
    canvas.drawCircle(
      c,
      base * (0.22 + 0.08 * p),
      Paint()
        ..maskFilter = MaskFilter.blur(BlurStyle.normal, base * 0.1)
        ..color = HfColors.white.withValues(alpha: 0.7),
    );
  }

  @override
  bool shouldRepaint(OrbPainter old) =>
      old.t != t || old.progress != progress || old.open != open;
}
