import '../flow/onboarding_context.dart';
import '../flow/onboarding_steps.dart';
import 'ui/about_step.dart';
import 'ui/avatar_step.dart';
import 'ui/done_step.dart';
import 'ui/generating_step.dart';
import 'ui/hours_step.dart';
import 'ui/languages_step.dart';
import 'ui/preview_step.dart';
import 'ui/price_step.dart';
import 'ui/review_step.dart';
import 'ui/topics_step.dart';
import 'ui/voice_step.dart';

/// The part B steps (HF-NATIVE-10), keyed by `OnboardingKeys.*`. Merged with part A by `ui/step_registry.dart`.
final Map<String, OnboardingStepBuilder> partBStepBuilders = <String, OnboardingStepBuilder>{
  OnboardingKeys.avatar: (context, ctx) => AvatarStep(ctx: ctx),
  OnboardingKeys.about: (context, ctx) => AboutStep(ctx: ctx),
  OnboardingKeys.languages: (context, ctx) => LanguagesStep(ctx: ctx),
  OnboardingKeys.topics: (context, ctx) => TopicsStep(ctx: ctx),
  OnboardingKeys.price: (context, ctx) => PriceStep(ctx: ctx),
  OnboardingKeys.hours: (context, ctx) => HoursStep(ctx: ctx),
  OnboardingKeys.voice: (context, ctx) => VoiceStep(ctx: ctx),
  OnboardingKeys.review: (context, ctx) => ReviewStep(ctx: ctx),
  OnboardingKeys.generating: (context, ctx) => GeneratingStep(ctx: ctx),
  OnboardingKeys.preview: (context, ctx) => PreviewStep(ctx: ctx),
  OnboardingKeys.done: (context, ctx) => DoneStep(ctx: ctx),
};
