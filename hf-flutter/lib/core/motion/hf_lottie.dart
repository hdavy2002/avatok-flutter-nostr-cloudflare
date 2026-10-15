import 'package:flutter/widgets.dart';
import 'package:lottie/lottie.dart';

import 'reduced_motion.dart';

/// Lottie animation files bundled in `assets/lottie/` (made by
/// `tool/gen_lottie.py`).
abstract final class HfLottieAssets {
  static const String sparkleBurst = 'assets/lottie/sparkle_burst.json';
  static const String heartPop = 'assets/lottie/heart_pop.json';
  static const String checkDraw = 'assets/lottie/check_draw.json';

  static const List<String> all = [sparkleBurst, heartPop, checkDraw];
}

/// Plays a bundled Lottie file once (or forever with [repeat]).
///
/// With reduced motion it shows the LAST frame and does not animate.
/// [onFinished] runs when a one-shot play ends. Decorative unless
/// [semanticLabel] is given.
class HfLottie extends StatefulWidget {
  const HfLottie(
    this.asset, {
    super.key,
    this.width,
    this.height,
    this.fit = BoxFit.contain,
    this.repeat = false,
    this.semanticLabel,
    this.onFinished,
  });

  final String asset;
  final double? width;
  final double? height;
  final BoxFit fit;
  final bool repeat;
  final String? semanticLabel;
  final VoidCallback? onFinished;

  @override
  State<HfLottie> createState() => _HfLottieState();
}

class _HfLottieState extends State<HfLottie>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  bool _loaded = false;
  bool _reduced = false;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this)
      ..addStatusListener((status) {
        if (status == AnimationStatus.completed &&
            mounted &&
            !widget.repeat &&
            !_reduced) {
          widget.onFinished?.call();
        }
      });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = hfReduceMotion(context);
    if (_loaded) _apply();
  }

  void _onLoaded(LottieComposition composition) {
    if (!mounted) return;
    _c.duration = composition.duration;
    _loaded = true;
    _apply();
  }

  void _apply() {
    if (_reduced) {
      _c.stop();
      _c.value = 1;
      return;
    }
    if (widget.repeat) {
      if (!_c.isAnimating) _c.repeat();
    } else if (!_c.isAnimating && _c.value < 1) {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animation = ExcludeSemantics(
      child: Lottie.asset(
        widget.asset,
        controller: _c,
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        onLoaded: _onLoaded,
      ),
    );
    final label = widget.semanticLabel;
    if (label == null) return animation;
    return Semantics(label: label, image: true, child: animation);
  }
}
