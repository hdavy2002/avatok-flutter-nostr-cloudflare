import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../core/links.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../widgets/step_page.dart';
import 'onboarding_copy.dart';

/// Step `phone`: normally already done, because the app signs in with a WhatsApp code. A verified number passes
/// by itself: the card shows "+91 •••• 1234 verified" and one Continue button. An unverified number (rare, an old
/// account) is sent to the website's number check in a Custom Tab, and "check again" re-reads the server.
class PhoneStep extends StatelessWidget {
  const PhoneStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  Widget build(BuildContext context) {
    final s = ctx.state;
    if (s.phoneVerified) {
      final last4 = s.phoneLast4;
      return OnboardingStepPage(
        title: OnboardingCopy.phoneVerifiedTitle,
        children: [
          HfCard(
            key: const ValueKey<String>('phone-verified'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DoneRow(last4 == null ? '+91 verified' : '+91 •••• $last4 verified'),
                const SizedBox(height: 8),
                const Text(OnboardingCopy.phoneVerifiedBody, style: HfText.bodyText),
              ],
            ),
          ),
          const SizedBox(height: 24),
          HfButton(
            key: const ValueKey<String>('phone-continue'),
            label: OnboardingCopy.continueLabel,
            onPressed: () => ctx.next(),
          ),
        ],
      );
    }
    return OnboardingStepPage(
      title: OnboardingCopy.phoneNotVerifiedTitle,
      lead: OnboardingCopy.phoneNotVerifiedBody,
      children: [
        HfButton(
          key: const ValueKey<String>('phone-verify'),
          label: OnboardingCopy.phoneVerifyButton,
          onPressed: () => unawaited(LinkOpener.instance.site('/sign-up?finish=1')),
        ),
        const SizedBox(height: 8),
        HfButton(
          key: const ValueKey<String>('phone-check-again'),
          label: OnboardingCopy.phoneCheckAgain,
          kind: HfButtonKind.secondary,
          onPressed: () => unawaited(ctx.refresh()),
        ),
      ],
    );
  }
}
