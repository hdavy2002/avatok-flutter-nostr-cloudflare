import 'package:flutter/material.dart';

import '../../../../core/links.dart';
import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../flow/onboarding_context.dart';
import '../widgets/step_page.dart';
import 'onboarding_copy.dart';

/// Step `welcome`: what you need, and what we keep (spec 2.13). No API call.
class WelcomeStep extends StatelessWidget {
  const WelcomeStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  Widget build(BuildContext context) {
    return OnboardingStepPage(
      scene: HfSceneKind.welcome,
      title: OnboardingCopy.welcomeTitle,
      lead: OnboardingCopy.welcomeLead,
      footer: [
        HfButton(
          key: const ValueKey<String>('welcome-start'),
          label: OnboardingCopy.start,
          onPressed: () => ctx.next(),
        ),
        HfButton(
          label: OnboardingCopy.readRules,
          kind: HfButtonKind.text,
          onPressed: () => LinkOpener.instance.site('/hosts/rules'),
        ),
      ],
      children: [
        Text(
          OnboardingCopy.welcomeHinglish,
          style: HfText.of(context, HfText.bodyStrong),
        ),
        const SizedBox(height: 16),
        Text(
          OnboardingCopy.needTitle,
          style: HfText.of(context, HfText.subsection),
        ),
        const SizedBox(height: 10),
        const _NeedRow(
          Icons.phone_android_rounded,
          OnboardingCopy.needPhone,
          HfTint.lavender,
        ),
        const _NeedRow(
          Icons.badge_rounded,
          OnboardingCopy.needAadhaar,
          HfTint.peach,
        ),
        const _NeedRow(
          Icons.account_balance_rounded,
          OnboardingCopy.needBank,
          HfTint.sky,
        ),
        const _NeedRow(
          Icons.schedule_rounded,
          OnboardingCopy.needTime,
          HfTint.butter,
        ),
        const _NeedRow(
          Icons.mic_rounded,
          OnboardingCopy.needQuiet,
          HfTint.blush,
        ),
        const SizedBox(height: 16),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(HfSpacing.xxl),
          decoration: BoxDecoration(
            color: HfTint.lavender.bg(context),
            borderRadius: BorderRadius.circular(HfRadius.tile),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.shield_rounded,
                    color: HfTint.lavender.ink(context),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      OnboardingCopy.keepTitle,
                      style: HfText.subsection.copyWith(
                        color: HfTint.lavender.valueInk(context),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                OnboardingCopy.keepBody,
                style: HfText.body.copyWith(
                  color: HfTint.lavender.ink(context),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        const _Fact(Icons.verified_user_rounded, OnboardingCopy.factsAge),
        const _Fact(Icons.currency_rupee_rounded, OnboardingCopy.factsPrice),
        const _Fact(Icons.call_rounded, OnboardingCopy.factsPhone),
      ],
    );
  }
}

/// A white row with a tinted icon square, as in the Welcome mockup.
class _NeedRow extends StatelessWidget {
  const _NeedRow(this.icon, this.text, this.tint);

  final IconData icon;
  final String text;
  final HfTint tint;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Container(
      margin: const EdgeInsets.only(bottom: HfSpacing.md),
      padding: const EdgeInsets.all(HfSpacing.lg),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.tileSmall),
        border: Border.all(color: dark ? HfColors.darkLine : HfColors.line),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: tint.bg(context),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, size: 20, color: tint.ink(context)),
          ),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: HfText.of(context, HfText.body))),
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.icon, this.text);

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Icon(icon, color: HfColors.rose),
        const SizedBox(width: 12),
        Expanded(
          child: Text(text, style: HfText.of(context, HfText.bodyStrong)),
        ),
      ],
    ),
  );
}
