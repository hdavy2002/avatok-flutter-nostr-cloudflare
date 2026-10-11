import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import 'profile_common.dart';
import 'profile_hero.dart';

/// The loading shape of the profile: photo, name row, tagline, stat strip, voice card, tabs and a few text
/// lines, so the page does not jump when the real content arrives.
class ProfileSkeleton extends StatelessWidget {
  const ProfileSkeleton({super.key, this.animate = true});

  final bool animate;

  @override
  Widget build(BuildContext context) {
    Widget box(double h, {double? w, double r = HfRadius.tile}) =>
        HfSkeleton.box(width: w, height: h, radius: r, animate: animate);
    Widget line([double? w]) => HfSkeleton.line(width: w, animate: animate);
    const gap = SizedBox(height: kProfileGap);
    return ExcludeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          box(kHeroHeight - kHeroOverlap, r: 0),
          Container(
            decoration: BoxDecoration(
              color: profilePage(context),
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(HfRadius.sheet),
              ),
            ),
            padding: const EdgeInsets.fromLTRB(
              kProfileSidePad,
              22,
              kProfileSidePad,
              HfSpacing.section,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    box(32, w: 150, r: HfRadius.chip),
                    const Spacer(),
                    box(34, w: 100, r: HfRadius.segment),
                  ],
                ),
                const SizedBox(height: HfSpacing.sm),
                line(220),
                gap,
                box(76),
                gap,
                box(112, r: 26),
                gap,
                box(48, r: HfRadius.segment),
                gap,
                line(),
                const SizedBox(height: HfSpacing.sm),
                line(),
                const SizedBox(height: HfSpacing.sm),
                line(180),
                gap,
                Row(
                  children: [
                    Expanded(child: box(64, r: HfRadius.tileSmall)),
                    const SizedBox(width: HfSpacing.sm),
                    Expanded(child: box(64, r: HfRadius.tileSmall)),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
