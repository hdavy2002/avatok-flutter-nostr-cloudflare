import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../flow/onboarding_context.dart';
import '../flow/onboarding_steps.dart';
import '../part_b/part_b_steps.dart';
import 'steps/aadhaar_step.dart';
import 'steps/payout_step.dart';
import 'steps/phone_step.dart';
import 'steps/selfie_step.dart';
import 'steps/welcome_step.dart';

/// Part A: the steps built in HF-NATIVE-9.
final Map<String, OnboardingStepBuilder> partAStepBuilders = <String, OnboardingStepBuilder>{
  OnboardingKeys.welcome: (context, ctx) => WelcomeStep(ctx: ctx),
  OnboardingKeys.phone: (context, ctx) => PhoneStep(ctx: ctx),
  OnboardingKeys.aadhaar: (context, ctx) => AadhaarStep(ctx: ctx),
  OnboardingKeys.selfie: (context, ctx) => SelfieStep(ctx: ctx),
  OnboardingKeys.payout: (context, ctx) => PayoutStep(ctx: ctx),
};

/// Step key to builder: part A plus part B (`part_b/part_b_steps.dart`). Tests override this provider.
final onboardingStepBuildersProvider = Provider<Map<String, OnboardingStepBuilder>>(
  (ref) => <String, OnboardingStepBuilder>{...partAStepBuilders, ...partBStepBuilders},
);
