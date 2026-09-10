import 'package:flutter/material.dart';

import '../avatok_dark.dart';

/// A highlight band travelling across a label — "generating…", "syncing…"
/// captions where the text itself doesn't change but the moment is ongoing.
///
/// This is the ONE widget in the library allowed to loop by default, and it
/// is allowed precisely because it is not "by default" in the sense that
/// matters: it is driven entirely by [active]. The August audit's finding
/// was 16 looping animations nobody ever turned off; this one turns off the
/// instant the caller sets [active] to false, and its controller is
/// stopped (not just hidden) at that point — callers MUST flip [active] to
/// false when the underlying work finishes, or this keeps ticking forever.
class AdShimmerText extends StatefulWidget {
  const AdShimmerText({
    super.key,
    required this.text,
    required this.active,
    this.style,
    this.baseColor = AD.textSecondary,
    this.highlightColor = AD.textPrimary,
  });

  final String text;
  /// Whether the shimmer should be running. Set to false to stop and settle
  /// on [baseColor] — do this as soon as the loading state ends.
  final bool active;
  final TextStyle? style;
  final Color baseColor;
  final Color highlightColor;

  @override
  State<AdShimmerText> createState() => _AdShimmerTextState();
}

class _AdShimmerTextState extends State<AdShimmerText>
    with SingleTickerProviderStateMixin {
  static const Duration _cycle = Duration(milliseconds: 2000);

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
  void didUpdateWidget(covariant AdShimmerText oldWidget) {
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
    final plainText = Text(
      widget.text,
      style: (widget.style ?? const TextStyle()).copyWith(color: widget.baseColor),
    );

    if (!widget.active || reduce) return plainText;

    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return ShaderMask(
          blendMode: BlendMode.srcIn,
          shaderCallback: (bounds) {
            // Sweeps the band from fully off-left to fully off-right, at
            // constant speed (linear) across the whole cycle.
            final center = -0.6 + 2.2 * _controller.value;
            return LinearGradient(
              begin: Alignment(center - 0.4, 0),
              end: Alignment(center + 0.4, 0),
              colors: [widget.baseColor, widget.highlightColor, widget.baseColor],
              stops: const [0.0, 0.5, 1.0],
            ).createShader(bounds);
          },
          child: child,
        );
      },
      child: plainText,
    );
  }
}
