import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';

/// A full-width form with its own illustrated chapter and a white workspace. 16 dp page padding.
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
    required this.children,
    this.footer = const <Widget>[],
  });

  final String? title;
  final String? lead;
  final HfClusterKind scene;
  final List<Widget> children;

  /// Widgets pinned at the bottom of the step.
  final List<Widget> footer;

  Widget _page(BuildContext context, List<Widget> kids) =>
      SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(
          HfSpacing.pageWide,
          16,
          HfSpacing.pageWide,
          32,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            HfCluster(kind: scene, height: 140),
            const SizedBox(height: 16),
            if (title != null)
              Semantics(
                header: true,
                child: Text(title!, style: HfText.of(context, HfText.title)),
              ),
            if (lead != null) ...[
              const SizedBox(height: 8),
              Text(lead!, style: HfText.of(context, HfText.note)),
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
            StepFooter(children: footer),
          ],
        );
      },
    );
  }
}

/// The sticky bar under a step: white, a hairline on top, 16 dp sides. The Scaffold lifts it above the keyboard.
class StepFooter extends StatelessWidget {
  const StepFooter({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
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
