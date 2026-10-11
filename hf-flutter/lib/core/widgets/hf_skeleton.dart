import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Loading placeholder blocks that pulse their opacity between 0.5 and 1 over 900 ms (still when the phone
/// asks for no animations, or when [animate] is false: pass false in widget tests that use `pumpAndSettle`).
///
/// * `HfSkeleton.box(width:, height:, radius:)`: one rounded block.
/// * `HfSkeleton.line(width:)`: a text-line block (14 px high).
/// * `HfSkeleton.hostCard()`: the whole Discover host card (photo 380 px / radius 28, four tiles, three chips,
///   the price bar) so the feed does not jump when real cards arrive.
class HfSkeleton extends StatelessWidget {
  const HfSkeleton.box({super.key, this.width, required this.height, this.radius = 12, this.animate = true})
      : _hostCard = false;

  const HfSkeleton.line({super.key, this.width, this.animate = true})
      : height = 14,
        radius = 7,
        _hostCard = false;

  const HfSkeleton.hostCard({super.key, this.animate = true})
      : width = null,
        height = 0,
        radius = HfRadius.card,
        _hostCard = true;

  final double? width;
  final double height;
  final double radius;
  final bool animate;
  final bool _hostCard;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading',
      excludeSemantics: true,
      child: _Pulse(
        animate: animate,
        child: _hostCard ? const _HostCardSkeleton() : _Block(width: width, height: height, radius: radius),
      ),
    );
  }
}

Color _blockColor(BuildContext context) => HfBrightness.isDark(context) ? HfColors.darkTile : HfColors.segmentTrack;

class _Block extends StatelessWidget {
  const _Block({this.width, required this.height, required this.radius});

  final double? width;
  final double height;
  final double radius;

  @override
  Widget build(BuildContext context) => Container(
        width: width,
        height: height,
        decoration: BoxDecoration(color: _blockColor(context), borderRadius: BorderRadius.circular(radius)),
      );
}

class _Pulse extends StatefulWidget {
  const _Pulse({required this.child, required this.animate});

  final Widget child;
  final bool animate;

  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(_Pulse old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final run = widget.animate && !MediaQuery.disableAnimationsOf(context);
    if (run) {
      if (!_c.isAnimating) _c.repeat(reverse: true);
    } else {
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
    return FadeTransition(
      opacity: Tween<double>(begin: 0.5, end: 1).animate(CurvedAnimation(parent: _c, curve: Curves.easeInOut)),
      child: widget.child,
    );
  }
}

class _HostCardSkeleton extends StatelessWidget {
  const _HostCardSkeleton();

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    Widget tile() => const Expanded(child: _Block(height: 56, radius: HfRadius.tileSmall));
    return Container(
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.card),
        boxShadow: HfShadows.card,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(6, 6, 6, 0),
            child: _Block(height: 380, radius: HfRadius.cardInner),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(children: [tile(), const SizedBox(width: HfSpacing.sm), tile()]),
                const SizedBox(height: HfSpacing.sm),
                Row(children: [tile(), const SizedBox(width: HfSpacing.sm), tile()]),
                const SizedBox(height: HfSpacing.xl),
                const Row(children: [
                  _Block(width: 110, height: 34, radius: HfRadius.chip),
                  SizedBox(width: HfSpacing.sm),
                  _Block(width: 90, height: 34, radius: HfRadius.chip),
                  SizedBox(width: HfSpacing.sm),
                  _Block(width: 48, height: 34, radius: HfRadius.chip),
                ]),
                const SizedBox(height: HfSpacing.xl),
                const _Block(height: 60, radius: HfRadius.tile),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
