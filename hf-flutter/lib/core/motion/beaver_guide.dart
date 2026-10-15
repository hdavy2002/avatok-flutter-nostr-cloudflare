import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../brand.dart';
import '../theme/hf_tokens.dart';
import 'pop_in.dart';
import 'reduced_motion.dart';
import 'speech_bubble.dart';

/// The twelve looping beaver clips in `assets/beaver/` (320x320, transparent
/// animated WebP, plus a still PNG of the first frame for reduced motion).
enum BeaverPose {
  idle,
  wave,
  happy,
  nod,
  phoneTalk,
  phoneLaugh,
  thumbs,
  point,
  namaste,
  celebrate,
  sleepy,
  oops;

  /// File stem, for example `phone_talk`.
  String get fileStem => switch (this) {
    BeaverPose.phoneTalk => 'phone_talk',
    BeaverPose.phoneLaugh => 'phone_laugh',
    _ => name,
  };

  /// Looping animated WebP.
  String get animatedAsset => 'assets/beaver/beaver_$fileStem.webp';

  /// First frame as a still PNG (used with reduced motion).
  String get stillAsset => 'assets/beaver/beaver_${fileStem}_still.png';
}

/// Where [BeaverGuide] puts its speech bubble.
enum BeaverBubbleSide { above, beside }

/// The onboarding guide: the beaver mascot, optionally with a [message] in a
/// [SpeechBubble] that types word by word.
///
/// * [pose]: which clip plays; changing it cross-fades (250 ms).
/// * [size]: the beaver's square size (160 by default).
/// * [bubbleSide]: bubble above (tail down) or beside (tail left).
/// * [entrance]: spring pop on first appearance (0.6 -> 1 with a slight
///   overshoot, 450 ms).
///
/// With reduced motion the still PNG is shown, there is no pop and the full
/// message shows at once. Keep only ONE animated beaver on screen at a time
/// (cheap phones decode every frame). Use [precacheBeaver] before showing a
/// pose to avoid a blank first frame.
class BeaverGuide extends StatefulWidget {
  const BeaverGuide({
    super.key,
    this.pose = BeaverPose.idle,
    this.size = 160,
    this.message,
    this.bubbleSide = BeaverBubbleSide.above,
    this.entrance = true,
    this.semanticLabel,
  });

  final BeaverPose pose;
  final double size;
  final String? message;
  final BeaverBubbleSide bubbleSide;
  final bool entrance;

  /// Defaults to "<brand name> beaver".
  final String? semanticLabel;

  /// Default screen-reader label of the beaver image.
  static const String defaultSemanticLabel = '${Brand.name} beaver';

  @override
  State<BeaverGuide> createState() => _BeaverGuideState();
}

class _BeaverGuideState extends State<BeaverGuide>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pop;
  late final Animation<double> _scale;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _pop = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 450),
    );
    _scale = Tween<double>(
      begin: 0.6,
      end: 1,
    ).animate(CurvedAnimation(parent: _pop, curve: Curves.easeOutBack));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (!widget.entrance || hfReduceMotion(context)) {
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
    final reduced = hfReduceMotion(context);
    final pose = widget.pose;
    final size = widget.size;
    final asset = reduced ? pose.stillAsset : pose.animatedAsset;
    final image = Image.asset(
      asset,
      key: ValueKey<String>(asset),
      width: size,
      height: size,
      fit: BoxFit.contain,
      gaplessPlayback: true,
      filterQuality: FilterQuality.medium,
      excludeFromSemantics: true,
      errorBuilder: (context, error, stack) => SizedBox.square(dimension: size),
    );
    Widget beaver = Semantics(
      label: widget.semanticLabel ?? BeaverGuide.defaultSemanticLabel,
      image: true,
      child: SizedBox.square(
        dimension: size,
        child: AnimatedSwitcher(
          duration: HfMotion.of(context, const Duration(milliseconds: 250)),
          child: image,
        ),
      ),
    );
    if (!reduced) {
      beaver = ScaleTransition(
        scale: _scale,
        alignment: Alignment.bottomCenter,
        child: beaver,
      );
    }

    final message = widget.message;
    if (message == null || message.isEmpty) return beaver;

    if (widget.bubbleSide == BeaverBubbleSide.beside) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          beaver,
          const SizedBox(width: 4),
          Flexible(
            child: PopIn(
              delay: const Duration(milliseconds: 180),
              alignment: Alignment.centerLeft,
              child: SpeechBubble(text: message, tail: SpeechBubbleTail.left),
            ),
          ),
        ],
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: math.max(240.0, size * 1.8)),
          child: PopIn(
            delay: const Duration(milliseconds: 180),
            alignment: Alignment.bottomCenter,
            child: SpeechBubble(text: message),
          ),
        ),
        const SizedBox(height: 6),
        beaver,
      ],
    );
  }
}

/// Starts decoding [pose] (the animated clip, or the still with reduced
/// motion) so it shows without a blank frame.
Future<void> precacheBeaver(BuildContext context, BeaverPose pose) {
  final asset = hfReduceMotion(context) ? pose.stillAsset : pose.animatedAsset;
  return precacheImage(AssetImage(asset), context);
}
