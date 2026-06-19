/// Central compile-time feature flags (creator-marketplace Phase 1).
/// Later flags live here so there is exactly one place to look.
library;

/// Onboarding account-type step (Single / Parent / Enterprise). Disabled for
/// the creator-marketplace launch (owner decision 2026-06-10): every signup is
/// `AccountKind.personal`. Flip to true to restore the step — the widget and
/// its stores are kept intact in onboarding_flow.dart.
const bool kAccountTypeStepEnabled = false;

/// Onboarding "Add AI?" step — offers the BYO Gemini key flow (with a skip).
/// When false the step is removed from onboarding (users can still set it up
/// from Settings → Ava AI). The step + its stores stay intact in code.
// Disabled: BYOK (bring-your-own Gemini key) was removed in the two-mode model
// (2026-06-18 — premium is top-up only, AI runs on our Cloudflare stack).
const bool kAddAiStepEnabled = false;

/// Build environment, baked at compile time: --dart-define=AVATOK_ENV=staging.
const String kAvatokEnv = String.fromEnvironment('AVATOK_ENV', defaultValue: 'prod');

/// Numeric build number — keep in sync with pubspec `version` (after the +)
/// and Analytics.appVersion. Compared against RemoteConfig.minAppBuild.
const int kAppBuild = 17;

// ---------------------------------------------------------------------------
// Ava in-chat AI flags (Phase 0 — Foundations). Compile-time defaults; the
// server enforces the real anti-abuse tiering (BYO key vs our-keys vs premium)
// — these gate UI surfaces and supply the non-premium daily-cap default.
//
// NOTE: there is intentionally NO `aiEnabled` flag. Whether Ava is on at runtime
// is DERIVED from AvaAiStore (app/lib/core/ava_ai_store.dart) — a BYO/our-keys
// connection — not from a compile-time flag. Read AvaAiStore.isConnected().
// ---------------------------------------------------------------------------

/// Menu "focus mode" default: hide non-AvaTOK apps so the drawer shows AvaTOK +
/// account essentials only. Fully reversible. P1 consumes AppRegistry.focusMode.
const bool kFocusModeDefault = true;

/// Web search available to Ava. Default OFF — premium (wallet) unlocks it; the
/// our-keys free tier never gets web search (proposal §7.1 anti-abuse tiering).
const bool kWebSearchEnabledDefault = false;

/// File analysis available to Ava. Default OFF — premium-only, same as above.
const bool kFileAnalysisEnabledDefault = false;

/// Uncapped open-ended chat. Default OFF — only premium removes the daily cap.
const bool kOpenChatUncappedDefault = false;

/// Daily Ava-turn cap for the our-keys free tier (per account/day). BYO-key and
/// premium users are not capped by this (server-enforced). Proposal §7.1: ~20–30.
const int kDailyAvaTurnLimit = 25;

/// Guardian (scam/grooming/deepfake safety) surfaces. Default ON: the basic
/// scam/spam flag is free; always-on deep monitoring is premium-gated at use.
const bool kGuardianEnabledDefault = true;

/// Companion (blank "New chat with Ava", personas). Default ON; voice is premium.
const bool kCompanionEnabledDefault = true;

/// Generative image gen (Nano Banana 2) in-thread. Default ON as a surface;
/// every generation is a premium PaidFeature at the point of use.
const bool kGenerativeEnabledDefault = true;
