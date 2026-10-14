import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';

/// Side padding of the profile sheet (mockup: 18).
const double kProfileSidePad = HfSpacing.xxl;

/// Vertical gap between profile blocks (mockup: 16).
const double kProfileGap = 16;

/// Dark-aware surfaces and text used across the profile sections.
Color profileSurface(BuildContext context) =>
    HfBrightness.isDark(context) ? HfColors.darkCard : HfColors.surface;
Color profileLine(BuildContext context) =>
    HfBrightness.isDark(context) ? HfColors.darkLine : HfColors.line;
Color profilePage(BuildContext context) =>
    HfBrightness.isDark(context) ? HfColors.darkBg : HfColors.page;
Color profileMuted(BuildContext context) =>
    HfBrightness.isDark(context) ? HfColors.mutedSoft : HfColors.muted;
Color profileSoftInk(BuildContext context) =>
    HfBrightness.isDark(context) ? HfColors.darkText : HfColors.inkSoft;

/// True when the phone's text size is large enough that side-by-side rows must stack.
bool profileBigText(BuildContext context, [double threshold = 1.3]) =>
    MediaQuery.textScalerOf(context).scale(16) > 16 * threshold;

/// White (dark: card) rounded box with a hairline border, the look of the stat strip, rating summary and rows.
BoxDecoration profileBox(
  BuildContext context, {
  double radius = HfRadius.tile,
}) => BoxDecoration(
  color: profileSurface(context),
  borderRadius: BorderRadius.circular(radius),
  border: Border.all(color: profileLine(context)),
  boxShadow: HfShadows.cardFor(context),
);

/// Section heading, Nunito 20/800.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(text, style: HfText.of(context, HfText.section)),
  );
}
