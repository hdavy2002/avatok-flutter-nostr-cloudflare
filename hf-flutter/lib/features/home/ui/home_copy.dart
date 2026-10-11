/// Copy of the Home screen (English only; one file so translation can come later).
/// The brand name is never typed here: the screen reads `Brand.name` and `Brand.slogan`.
abstract final class HomeCopy {
  /// "Good morning, Davy" by the time of day; without a name just "Good morning".
  /// 5-11 morning, 12-16 afternoon, every other hour evening.
  static String greeting(String? firstName, {DateTime? now}) {
    final h = (now ?? DateTime.now()).hour;
    final part = (h >= 5 && h < 12)
        ? 'Good morning'
        : (h >= 12 && h < 17)
        ? 'Good afternoon'
        : 'Good evening';
    final name = firstName?.trim() ?? '';
    return name.isEmpty ? part : '$part, $name';
  }

  static const String hero = 'Who would you like to talk to?';
  static const String walletSignIn = 'Sign in';
  static const String walletFallback = 'Wallet';
  static const String walletLabel = 'Wallet';

  static const String onlineNow = 'Online now';
  static const String seeAll = 'See all';
  static const String nobodyOnline =
      'Nobody is online right now. Browse everyone below.';
  static const String noHostsYet = 'No hosts are live yet. Check back soon.';
  static const String browseAll = 'Browse everyone';

  static const String moodTitle = 'What is on your mind?';
  static const String moodHint = 'Pick a mood and see who is ready to talk.';

  static const String spacesTitle = 'Your own space';
  static const String womenTitle = 'Women-only space';
  static const String womenBody =
      'Talk to women hosts in a space made for you.';
  static const String lgbtqTitle = 'LGBTQ+ space';
  static const String lgbtqBody =
      'A respectful space, shared on your own terms.';

  /// The safety line (same promise as the website).
  static const String safetyTitle = 'AI-powered, ends bad calls automatically';
  static const String safetyBody =
      'Spam, abuse and fraud can end a call by themselves. Your number stays private, always.';

  /// The disclaimer strip (same words as the website).
  static const String disclaimer =
      'Yahan sirf baat hoti hai. No medical, legal or money advice. No miracles, no guaranteed results. '
      'Not a replacement for a doctor or counsellor. 18+ only.';

  static const String hostTitle = 'Become a host';
  static const String hostBody =
      'Talk to people in your language and earn for every minute.';
  static const String hostButton = 'Become a host';
  static const String hostTitleExisting = 'Your host profile';
  static const String hostBodyExisting =
      'See your calls and earnings, and go online.';
  static const String hostButtonExisting = 'Open host tab';
}
