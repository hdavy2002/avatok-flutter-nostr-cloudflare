import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import 'beaver_tip.dart';

/// A full-width form with the beaver guide on top and a white workspace. 16 dp page padding.
///
/// The beaver (HF-MOTION-D) replaces the old illustrated chapter: it points at the step with a short tip
/// ([tip], or the first sentence of [lead]) and gives a quick thumbs up when [celebrate] turns true.
/// [beaverPose] changes its resting pose (nod on the voice step, happy when the profile is ready, ...).
/// [warm] paints the page in the warm sun colours (the "done" moment) and [heroTitle] makes the title big.
///
/// [footer] (usually an error line and the Continue button) is pinned under the scrolling content in a
/// [StepFooter], so the main action is always in reach and rides above the keyboard. On a short screen or with
/// large text the footer goes inside the scrolling page instead.
class OnboardingStepPage extends StatelessWidget {
  const OnboardingStepPage({
    super.key,
    this.title,
    this.lead,
    this.scene = HfClusterKind.host,
    this.tip,
    this.beaverPose = BeaverPose.point,
    this.celebrate = false,
    this.warm = false,
    this.heroTitle = false,
    required this.children,
    this.footer = const <Widget>[],
  });

  final String? title;
  final String? lead;

  /// The illustration a step used before the beaver guide. Kept so callers need not change; not drawn.
  final HfClusterKind scene;

  /// The beaver's tip. Defaults to the first sentence of [lead].
  final String? tip;
  final BeaverPose beaverPose;
  final bool celebrate;
  final bool warm;
  final bool heroTitle;
  final List<Widget> children;

  /// Widgets pinned at the bottom of the step.
  final List<Widget> footer;

  TextStyle _titleStyle(BuildContext context) {
    if (!heroTitle) return HfText.of(context, HfText.title);
    if (warm) return HfText.hero.copyWith(color: HfColors.onPrimary);
    return HfText.of(context, HfText.hero);
  }

  Widget _page(BuildContext context, List<Widget> kids) {
    final page = SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        16,
        HfSpacing.pageWide,
        32,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          OnboardingBeaverTip(
            tip: tip ?? tipFromLead(lead),
            pose: beaverPose,
            celebrate: celebrate,
            size: heroTitle ? 120 : 88,
          ),
          const SizedBox(height: 16),
          if (title != null)
            Semantics(
              header: true,
              child: Text(
                title!,
                key: const ValueKey<String>('onboarding-step-title'),
                style: _titleStyle(context),
                textAlign: heroTitle ? TextAlign.center : null,
              ),
            ),
          if (lead != null) ...[
            const SizedBox(height: 8),
            Text(
              lead!,
              style: warm
                  ? HfText.note.copyWith(color: HfColors.onPrimary)
                  : HfText.of(context, HfText.note),
              textAlign: heroTitle ? TextAlign.center : null,
            ),
          ],
          const SizedBox(height: 16),
          _StepCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: kids,
            ),
          ),
        ],
      ),
    );
    if (!warm) return page;
    return DecoratedBox(
      key: const ValueKey<String>('onboarding-warm'),
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [HfColors.sunshine, HfColors.butter],
        ),
      ),
      child: page,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (footer.isEmpty) return _page(context, children);
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact =
            constraints.maxHeight < 520 ||
            MediaQuery.textScalerOf(context).scale(14) > 20;
        if (compact) {
          return _page(context, [
            ...children,
            const SizedBox(height: 20),
            ...footer,
          ]);
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: _page(context, children)),
            StepFooter(warm: warm, children: footer),
          ],
        );
      },
    );
  }
}

/// The sticky bar under a step: white, a hairline on top, 16 dp sides. The Scaffold lifts it above the keyboard.
class StepFooter extends StatelessWidget {
  const StepFooter({super.key, required this.children, this.warm = false});

  final List<Widget> children;

  /// Butter yellow, to sit under a warm page without a seam.
  final bool warm;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    if (warm) {
      return Container(
        padding: const EdgeInsets.fromLTRB(
          HfSpacing.pageWide,
          HfSpacing.lg,
          HfSpacing.pageWide,
          HfSpacing.lg,
        ),
        color: HfColors.butter,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.lg,
        HfSpacing.pageWide,
        HfSpacing.lg,
      ),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkBg : HfColors.page,
        border: Border(
          top: BorderSide(color: dark ? HfColors.darkLine : HfColors.line),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}

/// A step's neutral workspace: radius 22, with a visible border and card shadow.
class _StepCard extends StatelessWidget {
  const _StepCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Container(
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.surface,
        borderRadius: BorderRadius.circular(HfRadius.tile),
        border: Border.all(color: dark ? HfColors.darkLine : HfColors.line),
        boxShadow: HfShadows.cardFor(context),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: Padding(padding: const EdgeInsets.all(16), child: child),
      ),
    );
  }
}
