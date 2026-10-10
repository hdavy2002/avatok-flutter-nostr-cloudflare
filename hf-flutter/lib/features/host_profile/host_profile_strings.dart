/// Copy that only the host profile screen uses. Copy shared by several screens lives in core/strings.dart.
/// The brand name is never typed here: use `Brand.name`.
abstract final class HostProfileStrings {
  static const String appBarTitle = 'Profile';
  static const String aiAvatarAlt = 'an AI avatar chosen by the host';
  static const String loading = 'Loading profile…';
  static const String exploreHosts = 'Explore hosts';
  static const String savedProfile = 'Showing saved profile';

  // Header
  static const String newHost = 'New host';
  static const String idChecked = 'Identity checked by our team';
  static const String womenOnlyBadge = 'Women-only space';
  static const String lgbtqBadge = 'LGBTQ+ friendly';

  // Voice intro
  static const String introTitle = 'Hear the introduction';
  static const String playIntro = 'Play introduction';
  static const String pauseIntro = 'Pause introduction';
  static const String introFailed = "We couldn't play the introduction. Please try again.";

  // Sections
  static const String about = 'About';
  static const String talkAbout = 'Let’s talk about';
  static const String languages = 'Languages';
  static const String style = 'Conversation style';
  static const String gallery = 'Gallery';
  static const String galleryImage = 'AI image';
  static const String reviews = 'What callers say';
  static const String noReviews = 'No reviews yet.';
  static const String regular = 'Regular';
  static const String beforeYouCall = 'Before you call';
  static const String disclosure =
      'The pictures on a profile are made by AI from an avatar the host chose. The voice introduction is the host’s own recording. '
      'The person you talk to on a call is a real, identity-checked host.';
  static const List<(String, String)> beforeNotes = [
    ('Just a conversation', 'Talk and share at your own pace. No professional advice or promised results.'),
    ('Keep it respectful', '18+ only. You can end a call at any time. If you feel unsafe, end the call and report it.'),
    ('Your number stays private', 'Your phone rings and the host’s phone rings. Neither of you sees the other’s number.'),
  ];
  static const String report = 'Report this profile';

  // Actions
  static const String call = 'Call';
  static const String callsSoon = 'Calls open soon';
  static const String notifyOffline = 'Notify me when online';
  static const String notifyBusy = 'Notify me when free';
  static const String notifyStop = 'Stop notifying me';
  static const String notifyOn = "We'll WhatsApp you when they're online.";
  static const String notifyOff = "Okay, we won't message you.";
  static const String verifyToCall = 'Verify to call';
  static const String womenLaneNote = 'This is a women-only space. Verify once to call hosts here.';

  static String hostOnCall(String name) => '$name is on a call right now.';
  static String hostOffline(String name) => '$name is offline right now.';
}
