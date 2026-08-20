/// Rajasthani illustration set — asset paths for the 16 SVGs shipped verbatim
/// from the designer (`design/rajasthani/illustrations/`, see MANIFEST.md
/// there). ONE place for these paths so screens never scatter raw asset
/// strings; do not hand-write `assets/illustrations/...` elsewhere.
///
/// Two groups:
///  - Empty-state illustrations: pass into `EmptyState.illustration`
///    (`core/ui/states.dart`) at the call site whose title matches.
///  - Mid-size motifs: decorative hero/medallion art, NOT empty states — do
///    not force these into `EmptyState`. See the constant doc comments below
///    for where each is believed to belong.
class Illustrations {
  Illustrations._();

  static const _base = 'assets/illustrations/';

  // ---------------------------------------------------------- empty states
  /// Chat list — "No chats yet" (chat_list.dart).
  static const chatListEmpty = '${_base}03-chat-list-illo-1.svg';
  /// Calls list — "No calls yet" (calls_screen.dart).
  static const callsListEmpty = '${_base}05-calls-list-illo-1.svg';
  /// AvaDial dialpad search — "Not on AvaTOK" (dialpad_search_tab.dart).
  static const dialerNotOnAvatok = '${_base}11-dialer-illo-1.svg';
  /// AvaDial blocklist — "Nothing blocked" (shell/v2/avadial_root.dart, via
  /// `ShellEmptyState.illustration`). Wired.
  static const dialerNothingBlocked = '${_base}11-dialer-illo-2.svg';
  /// Ava companion — "Adults only" gate sheet
  /// (features/ava_companion/companion_home.dart). Wired.
  static const companionAdultsOnly = '${_base}12-ava-companion-illo-1.svg';
  /// Status — "No updates yet" (features/status/status_screen.dart). Wired.
  static const statusEmpty = '${_base}15-status-illo-1.svg';

  // -------------------------------------------------- hero / header art
  // Not empty states — nearby text is a screen headline/glyph, not a "no
  // items" title. Not wired into any screen; see the ship report for where
  // each is believed to belong.
  /// Onboarding — headline art next to "Ava TOK" (onboarding_flow.dart,
  /// on the do-not-touch list).
  static const onboardingHero = '${_base}01-onboarding-illo-1.svg';
  /// Sign-in / OTP — the envelope + 123456 card + chai cup art, shown on the
  /// `_Mode.verify` step only (features/auth/sign_in_screen.dart). Wired.
  static const signInHero = '${_base}02-sign-in-illo-1.svg';
  /// In-call screen — large art behind the caller identity/avatar.
  static const inCallHero1 = '${_base}06-in-call-illo-1.svg';
  /// In-call screen — secondary decorative ring/badge art.
  static const inCallHero2 = '${_base}06-in-call-illo-2.svg';
  /// Profile — avatar-adjacent flower motif (profile_screen.dart, on the
  /// do-not-touch list).
  static const profileHero = '${_base}08-profile-illo-1.svg';

  // ------------------------------------------------------- mid-size motifs
  // Decorative hero/medallion art (manifest's own "mid-size motifs"
  // section) — never empty states. wallet_screen.dart and
  // settings_screen.dart are both on the do-not-touch list.
  /// Wallet — small ring/coin medallion, ~100x100 (wallet_screen.dart).
  static const walletMotif100 = '${_base}07-wallet-motif-100x100.svg';
  /// Wallet — flower medallion, ~120x120 (wallet_screen.dart).
  static const walletMotif120 = '${_base}07-wallet-motif-120x120.svg';
  /// Wallet — decorative bar-chart strip, 320x62 (wallet_screen.dart).
  static const walletMotifStrip = '${_base}07-wallet-motif-320x62.svg';
  /// Settings — "Ava answers for you" flower motif, 120x120
  /// (settings_screen.dart).
  static const settingsMotif = '${_base}09-settings-motif-120x120.svg';
  /// Groups — flower medallion, 108x108 (likely groups_tab.dart or the
  /// group thread header — not confidently placed; see ship report).
  static const groupsMotif = '${_base}13-groups-motif-108x108.svg';
}
