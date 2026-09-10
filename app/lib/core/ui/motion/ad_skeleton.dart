import 'dart:ui';

import 'package:flutter/material.dart';

import '../messenger_theme.dart';

/// A loading placeholder that pulses once to signal "this is loading, not
/// broken", then sits still until the real content is ready and cross-fades
/// into it through a matching 2px blur.
///
/// Deliberately NOT a looping shimmer or pulse: the August audit's headline
/// finding was 16 always-on looping animations making the app feel restless.
/// A skeleton only needs to say "loading" once — after that, a repeating
/// pulse is decoration, not information. [AdShimmerText] is the one place a
/// loop is justified, precisely because it is explicitly stoppable.
///
/// [skeleton] and [child] are stacked in the same slot so swapping between
/// them never shifts layout — size it for the eventual [child], not the
/// placeholder.
class AdSkeleton extends StatefulWidget {
  const AdSkeleton({
    super.key,
    required this.isLoading,
    required this.skeleton,
    required this.child,
  });

  /// Whether the placeholder (true) or the real content (false) should show.
  final bool isLoading;
  final Widget skeleton;
  final Widget child;

  @override
  State<AdSkeleton> createState() => _AdSkeletonState();
}

class _AdSkeletonState extends State<AdSkeleton> with TickerProviderStateMixin {
  static const Duration _pulseDuration = Duration(milliseconds: 1000);

  late final AnimationController _pulse;
  late final AnimationController _crossFade;
  late final Animation<double> _pulseOpacity;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: _pulseDuration);
    _pulseOpacity = TweenSequence<double>([
      TweenSequenceItem(
        weight: 1,
        tween: Tween(begin: 1.0, end: 0.5).chain(CurveTween(curve: Msg.settle)),
      ),
      TweenSequenceItem(
        weight: 1,
        tween: Tween(begin: 0.5, end: 1.0).chain(CurveTween(curve: Msg.settle)),
      ),
    ]).animate(_pulse);
    _crossFade = AnimationController(vsync: this, duration: Msg.base);

    final reduce = MediaQuery.of(context).disableAnimations;
    if (!widget.isLoading) {
      _crossFade.value = 1;
    } else if (!reduce) {
      _pulse.forward();
    }
  }

  @override
  void didUpdateWidget(covariant AdSkeleton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isLoading == widget.isLoading) return;
    final reduce = MediaQuery.of(context).disableAnimations;
    if (!widget.isLoading) {
      if (reduce) {
        _crossFade.value = 1;
      } else {
        _crossFade.forward(from: 0);
      }
    } else {
      // Went back to loading (e.g. a refresh) — reset and pulse once again.
      _crossFade.value = 0;
      if (!reduce) _pulse.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    _crossFade.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return AnimatedBuilder(
      animation: Listenable.merge([_pulse, _crossFade]),
      builder: (context, _) {
        final t = reduce ? (widget.isLoading ? 0.0 : 1.0) : _crossFade.value.clamp(0.0, 1.0);
        final pulseVal = reduce ? 1.0 : _pulseOpacity.value.clamp(0.0, 1.0);

        return Stack(
          alignment: Alignment.center,
          children: [
            Opacity(
              opacity: ((1 - t) * pulseVal).clamp(0.0, 1.0),
              child: ImageFiltered(
                imageFilter: ImageFilter.blur(sigmaX: t * 2, sigmaY: t * 2),
                child: widget.skeleton,
              ),
            ),
            Opacity(
              opacity: t,
              child: ImageFiltered(
                imageFilter: ImageFilter.blur(sigmaX: (1 - t) * 2, sigmaY: (1 - t) * 2),
                child: widget.child,
              ),
            ),
          ],
        );
      },
    );
  }
}
