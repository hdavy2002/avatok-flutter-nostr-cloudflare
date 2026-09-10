import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../messenger_theme.dart';

/// Which wavefront the loader's dots pulse in.
enum AdDotLoaderVariant {
  /// All 16 dots in the grid pulse outward from the centre.
  grid,
  /// A '>' shaped wavefront sweeps left to right — a chevron, not a ripple.
  chevron,
  /// Only the 12 perimeter dots light in sequence around the edge, like a
  /// ring spinner built from dots instead of an arc.
  orbit,
}

/// A 4x4 grid of dots with a per-dot phase offset, so the loader reads as a
/// single travelling wave rather than sixteen dots blinking independently.
///
/// One [AnimationController] drives every dot — each dot's brightness is a
/// sine wave offset by its own phase, computed in [_DotLoaderPainter] rather
/// than sixteen separate animations. Like [AdShimmerText], this is a
/// repeating animation and is therefore gated on [active]: callers MUST set
/// [active] to false once the underlying work finishes, which stops and
/// idles the controller rather than leaving it running off-screen.
class AdDotLoader extends StatefulWidget {
  const AdDotLoader({
    super.key,
    required this.active,
    this.variant = AdDotLoaderVariant.grid,
    this.size = 32,
    this.color = Msg.accent,
  });

  /// Whether the loader should be animating. Set false as soon as loading
  /// ends.
  final bool active;
  final AdDotLoaderVariant variant;
  final double size;
  final Color color;

  @override
  State<AdDotLoader> createState() => _AdDotLoaderState();
}

class _AdDotLoaderState extends State<AdDotLoader> with SingleTickerProviderStateMixin {
  static const Duration _cycle = Duration(milliseconds: 1200);

  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: _cycle);
    _syncPlaying();
  }

  void _syncPlaying() {
    final reduce = MediaQuery.of(context).disableAnimations;
    if (widget.active && !reduce) {
      _controller.repeat();
    } else {
      _controller.stop();
    }
  }

  @override
  void didUpdateWidget(covariant AdDotLoader oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) {
      _syncPlaying();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) => CustomPaint(
        size: Size.square(widget.size),
        painter: _DotLoaderPainter(
          t: reduce ? 0 : _controller.value,
          variant: widget.variant,
          color: widget.color,
        ),
      ),
    );
  }
}

class _DotLoaderPainter extends CustomPainter {
  const _DotLoaderPainter({required this.t, required this.variant, required this.color});

  final double t;
  final AdDotLoaderVariant variant;
  final Color color;

  static const int _gridSize = 4;
  static const int _perimeterCount = 12;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / _gridSize;
    final dotRadius = cell * 0.22;
    final paint = Paint()..color = color;

    for (var row = 0; row < _gridSize; row++) {
      for (var col = 0; col < _gridSize; col++) {
        final isPerimeter = row == 0 || row == _gridSize - 1 || col == 0 || col == _gridSize - 1;
        if (variant == AdDotLoaderVariant.orbit && !isPerimeter) continue;

        final phase = _phaseFor(row, col);
        final wave = (math.sin(2 * math.pi * (t - phase)) + 1) / 2; // 0..1
        final opacity = 0.25 + 0.75 * wave;
        final scale = 0.55 + 0.45 * wave;

        final center = Offset((col + 0.5) * cell, (row + 0.5) * cell);
        paint.color = color.withOpacity(opacity.clamp(0.0, 1.0));
        canvas.drawCircle(center, dotRadius * scale, paint);
      }
    }
  }

  double _phaseFor(int row, int col) {
    switch (variant) {
      case AdDotLoaderVariant.grid:
        final dr = row - 1.5;
        final dc = col - 1.5;
        final dist = math.sqrt(dr * dr + dc * dc);
        return dist / (math.sqrt(2) * 1.5 + 1);
      case AdDotLoaderVariant.chevron:
        final v = col.toDouble() + (row - 1.5).abs();
        return v / 6.0;
      case AdDotLoaderVariant.orbit:
        return _perimeterIndex(row, col) / _perimeterCount;
    }
  }

  int _perimeterIndex(int row, int col) {
    // Walk the 12-cell perimeter clockwise starting top-left.
    if (row == 0) return col; // top row: 0..3
    if (col == _gridSize - 1) return 3 + row; // right column: 4..6
    if (row == _gridSize - 1) return 6 + (_gridSize - 1 - col); // bottom row: 7..9
    return 9 + (_gridSize - 1 - row); // left column: 10..11
  }

  @override
  bool shouldRepaint(covariant _DotLoaderPainter oldDelegate) {
    return oldDelegate.t != t || oldDelegate.variant != variant || oldDelegate.color != color;
  }
}
