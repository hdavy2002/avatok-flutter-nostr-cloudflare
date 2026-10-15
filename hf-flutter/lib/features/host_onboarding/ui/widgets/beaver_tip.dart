import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../core/widgets/widgets.dart';

/// The beaver guide at the top of every onboarding step (HF-MOTION-D), with a short tip in a speech bubble.
///
/// The tip is existing helper copy (by default the first sentence of the step's lead, see [tipFromLead]); nothing
/// new is promised here. The beaver points by default. When [celebrate] turns true (a step was just finished) it
/// gives a thumbs up for a moment and then goes back to [pose]. One beaver per screen: a step never adds another.
class OnboardingBeaverTip extends StatefulWidget {
  const OnboardingBeaverTip({
    super.key,
    this.tip,
    this.pose = BeaverPose.point,
    this.celebrate = false,
    this.size = 88,
  });

  final String? tip;
  final BeaverPose pose;

  /// True when the step's work is done. The thumbs up shows for [thumbsFor].
  final bool celebrate;
  final double size;

  /// How long the thumbs up stays before the beaver goes back to [pose].
  static const Duration thumbsFor = Duration(milliseconds: 1800);

  @override
  State<OnboardingBeaverTip> createState() => _OnboardingBeaverTipState();
}

class _OnboardingBeaverTipState extends State<OnboardingBeaverTip> {
  Timer? _timer;
  bool _thumbs = false;

  @override
  void initState() {
    super.initState();
    if (widget.celebrate) _cheer();
  }

  @override
  void didUpdateWidget(OnboardingBeaverTip old) {
    super.didUpdateWidget(old);
    if (widget.celebrate && !old.celebrate) _cheer();
  }

  void _cheer() {
    _timer?.cancel();
    _thumbs = true;
    _timer = Timer(OnboardingBeaverTip.thumbsFor, () {
      if (mounted) setState(() => _thumbs = false);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tip = widget.tip;
    final beaver = BeaverGuide(
      key: const ValueKey<String>('onboarding-beaver'),
      pose: _thumbs ? BeaverPose.thumbs : widget.pose,
      size: widget.size,
      message: tip,
      bubbleSide: BeaverBubbleSide.beside,
    );
    return Align(
      alignment: tip == null ? Alignment.center : Alignment.centerLeft,
      child: beaver,
    );
  }
}

/// The first sentence of a step's lead, used as the beaver's tip. `null` when there is no lead.
String? tipFromLead(String? lead) {
  if (lead == null) return null;
  final text = lead.trim();
  if (text.isEmpty) return null;
  final end = text.indexOf('. ');
  return end < 0 ? text : text.substring(0, end + 1);
}
