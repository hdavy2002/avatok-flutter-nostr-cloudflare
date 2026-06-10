/// Central compile-time feature flags (creator-marketplace Phase 1).
/// Later flags live here so there is exactly one place to look.
library;

/// Onboarding account-type step (Single / Parent / Enterprise). Disabled for
/// the creator-marketplace launch (owner decision 2026-06-10): every signup is
/// `AccountKind.personal`. Flip to true to restore the step — the widget and
/// its stores are kept intact in onboarding_flow.dart.
const bool kAccountTypeStepEnabled = false;

/// Build environment, baked at compile time: --dart-define=AVATOK_ENV=staging.
const String kAvatokEnv = String.fromEnvironment('AVATOK_ENV', defaultValue: 'prod');

/// Numeric build number — keep in sync with pubspec `version` (after the +)
/// and Analytics.appVersion. Compared against RemoteConfig.minAppBuild.
const int kAppBuild = 17;
