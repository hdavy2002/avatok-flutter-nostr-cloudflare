import 'package:flutter/material.dart';

import '../../../../core/links.dart';
import '../../../../core/theme/hf_tokens.dart';
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
      children: [
        const Text(OnboardingCopy.welcomeHinglish, style: HfText.bodyStrong),
        const SizedBox(height: 20),
        const HfCard(
          color: HfColors.white,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(OnboardingCopy.needTitle, style: HfText.subtitle),
              SizedBox(height: 12),
              _NeedRow(Icons.phone_android_rounded, OnboardingCopy.needPhone),
              _NeedRow(Icons.badge_rounded, OnboardingCopy.needAadhaar),
              _NeedRow(Icons.account_balance_rounded, OnboardingCopy.needBank),
              _NeedRow(Icons.schedule_rounded, OnboardingCopy.needTime),
              _NeedRow(Icons.mic_rounded, OnboardingCopy.needQuiet),
            ],
          ),
        ),
        const SizedBox(height: 16),
        const HfCard(
          color: HfColors.white,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.shield_rounded, color: HfColors.orchid),
                  SizedBox(width: 8),
                  Expanded(child: Text(OnboardingCopy.keepTitle, style: HfText.subtitle)),
                ],
              ),
              SizedBox(height: 8),
              Text(OnboardingCopy.keepBody, style: HfText.bodyText),
            ],
          ),
        ),
        const SizedBox(height: 16),
        const _Fact(Icons.verified_user_rounded, OnboardingCopy.factsAge),
        const _Fact(Icons.currency_rupee_rounded, OnboardingCopy.factsPrice),
        const _Fact(Icons.call_rounded, OnboardingCopy.factsPhone),
        const SizedBox(height: 24),
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
    );
  }
}

class _NeedRow extends StatelessWidget {
  const _NeedRow(this.icon, this.text);

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Icon(icon, color: HfColors.orchid),
            const SizedBox(width: 12),
            Expanded(child: Text(text, style: HfText.bodyText)),
          ],
        ),
      );
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
            Expanded(child: Text(text, style: HfText.bodyStrong)),
          ],
        ),
      );
}
