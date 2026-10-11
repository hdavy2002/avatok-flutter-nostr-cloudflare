import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/hf_theme.dart';

/// The mockups' round back button: 48 px circle (`surfaceSoft`, `darkTile` in dark mode), arrow in ink.
class HfBackCircle extends StatelessWidget {
  const HfBackCircle({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Semantics(
      button: true,
      label: 'Back',
      excludeSemantics: true,
      onTap: onPressed,
      child: Tooltip(
        message: 'Back',
        child: Material(
          color: dark ? HfColors.darkTile : HfColors.surfaceSoft,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: () {
              HapticFeedback.selectionClick();
              onPressed();
            },
            child: SizedBox(
              width: 48,
              height: 48,
              child: Icon(
                Icons.arrow_back_rounded,
                size: 24,
                color: dark ? HfColors.darkText : HfColors.ink,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Page top used by onboarding, lanes and sign-in: back circle, then a Nunito 24 title. 20 px sides.
class HfPageHeader extends StatelessWidget {
  const HfPageHeader({
    super.key,
    required this.onBack,
    this.title,
    this.backKey,
  });

  final VoidCallback onBack;
  final String? title;
  final Key? backKey;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.sm,
        HfSpacing.pageWide,
        HfSpacing.sm,
      ),
      child: Row(
        children: [
          KeyedSubtree(
            key: backKey,
            child: HfBackCircle(onPressed: onBack),
          ),
          if (title != null) ...[
            const SizedBox(width: HfSpacing.lg),
            Expanded(
              child: Semantics(
                header: true,
                child: Text(
                  title!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: HfText.of(context, HfText.title),
                ),
              ),
            ),
          ] else
            const Spacer(),
        ],
      ),
    );
  }
}

/// A 24 px rounded checkbox: ink when checked (`lavenderLight` in dark mode), animated over 150 ms.
/// Purely visual: the row around it owns the tap and the semantics.
class HfCheckMark extends StatelessWidget {
  const HfCheckMark({super.key, required this.checked});

  final bool checked;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final fill = dark ? HfColors.lavenderLight : HfColors.ink;
    return AnimatedContainer(
      duration: HfMotion.of(context, HfMotion.fast),
      curve: HfMotion.curve,
      width: 24,
      height: 24,
      decoration: BoxDecoration(
        color: checked ? fill : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: checked ? fill : (dark ? HfColors.mutedSoft : HfColors.muted),
          width: 2,
        ),
      ),
      child: checked
          ? Icon(
              Icons.check_rounded,
              size: 18,
              color: dark ? HfColors.ink : HfColors.white,
            )
          : null,
    );
  }
}
