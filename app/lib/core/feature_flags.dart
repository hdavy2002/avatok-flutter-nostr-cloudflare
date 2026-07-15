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

/// Extra social login providers (beyond Google, which is always on). Each stays
/// OFF until its provider app + Clerk dashboard config + the Worker token-
/// exchange endpoint are live. Flip per provider once ready — the buttons render
/// either way (see sign_in_screen.dart); while a flag is false the button is
/// shown as "coming soon" instead of attempting a half-configured sign-in.
///   Facebook: Clerk has the provider enabled; still needs the Meta app
///     (App ID/secret, key hashes, OAuth redirect) + `/api/auth/facebook`.
///   LinkedIn: needs LinkedIn OIDC app + Clerk provider + `/api/auth/linkedin`.
const bool kSocialFacebookEnabled = false;
const bool kSocialLinkedInEnabled = false;

/// Build environment, baked at compile time: --dart-define=AVATOK_ENV=staging.
const String kAvatokEnv = String.fromEnvironment('AVATOK_ENV', defaultValue: 'prod');

/// Numeric build number — keep in sync with pubspec `version` (after the +).
///
/// [AVA-UPDATE-AUTO] DO NOT compare this against RemoteConfig.minAppBuild (it
/// used to be, and that was a trap). CI overrides the real versionCode with
/// `--build-number=$((10000 + run_number))`, so no shipped build has ever
/// carried this number — it is a compile-time fallback only. Use
/// `RemoteConfig.installedBuild`, which reads the true value from PackageInfo.
const int kAppBuild = 28;

/// Human-readable app version — keep in sync with pubspec `version` (before the
/// +). Shown on the About screen.
const String kAppVersion = '0.1.18';

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

/// "Discuss this chat with Ava" — open ChatAVA pointed at a Messenger thread to
/// get Ava's opinion + draft replies. Context is assembled on-device and passed
/// transiently to the moderated proxy (never indexed server-side). Default ON;
/// the entry point also checks the AvaBrain DM/group consent toggle at use.
const bool kDiscussWithAvaEnabled = true;

/// Generative image gen (Nano Banana 2) in-thread. Default ON as a surface;
/// every generation is a premium PaidFeature at the point of use.
const bool kGenerativeEnabledDefault = true;

// ---------------------------------------------------------------------------
// AI Ringback Tones + Busy Tone (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md).
// Caller-side ringback: the CALLER hears the callee's MiniMax-generated tune
// during the existing (today silent) ringing phase; a busy tone plays when the
// callee is already on a call. Local playback on the caller's device — NOT
// carrier early media. Free (our Workers AI key). Default ON; the server mirror
// is PlatformConfig.ringbackEnabled (routes/config.ts) — the panic switch.
// ---------------------------------------------------------------------------

/// Master client default for the ringback/busy-tone feature. Mirrors the server
/// `ringbackEnabled` flag; the server value (RemoteConfig) wins at runtime.
const bool kRingbackEnabledDefault = true;

/// Stored clip length for a generated ringtone. The caller ring phase times out
/// at 35s (call_screen.dart), so a 30s clip looped once covers the whole window.
const int kRingtoneSeconds = 30;

/// Max ringtones saved per account. Generating one more evicts the OLDEST
/// (FIFO) — server-enforced, deleting both the R2 object and the D1 row.
const int kMaxRingtonesPerAccount = 5;

/// Bundled fallback tones (used when no custom tone is set or the network is
/// down). Registered in pubspec under assets/audio/.
const String kDefaultRingbackAsset = 'assets/audio/ringback_default.wav';
const String kBusyToneAsset = 'assets/audio/busy_tone.wav';
// [CALL-SEARCH-TONE-1] PSTN-style call-progress beeps: played by the CALLER
// while the network is still locating the callee's device (takeover-guard
// 'connecting' phase, before the device-ringing receipt). Soft 425 Hz double
// beep every 2s — honest "working on it", distinct from real ringback.
const String kSearchingToneAsset = 'assets/audio/searching_tone.wav';

// ---------------------------------------------------------------------------
// Link previews + inline YouTube (AI Messenger Batch — STREAM C, PREVIEW-4).
// The SENDER unfurls a link at compose time (/api/unfurl) and embeds the result
// in the message envelope (preview:{...}); recipients render the card from the
// envelope with zero fetch. When OFF, chat renders raw link text only and the
// compose-time unfurl call is skipped. Server mirror: PlatformConfig
// .linkPreviewsEnabled (routes/config.ts) — the RemoteConfig value wins at runtime.
// ---------------------------------------------------------------------------
const bool kLinkPreviewsEnabledDefault = true;
