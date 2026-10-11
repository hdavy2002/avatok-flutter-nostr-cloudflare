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
  static const String introFailed =
      "We couldn't play the introduction. Please try again.";

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

  /// Order and titles follow the Profile mockup: private number, respect, not therapy.
  static const List<(String, String)> beforeNotes = [
    (
      'Your number stays private',
      'Your phone rings and the host’s phone rings. Neither of you sees the other’s number.',
    ),
    (
      'Keep it respectful, 18+ only',
      '18+ only. You can end a call at any time. If you feel unsafe, end the call and report it.',
    ),
    (
      'Just a conversation, not therapy',
      'Talk and share at your own pace. No professional advice or promised results.',
    ),
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
  static const String womenLaneNote =
      'This is a women-only space. Verify once to call hosts here.';

  static String hostOnCall(String name) => '$name is on a call right now.';
  static String hostOffline(String name) => '$name is offline right now.';

  // Profile redesign (HF-UI-5)
  static const String aiAvatarChosen = 'AI avatar chosen by the host';
  static const String backLabel = 'Back';
  static const String saveLabel = 'Save profile';
  static const String unsaveLabel = 'Remove from saved';
  static const String shareLabel = 'Share profile';
  static const String linkCopied = 'Profile link copied.';
  static const String newLabel = 'New';
  static const String hostWord = 'host';
  static const String talkedTo = 'talked to';
  static const String regulars = 'regulars';
  static const String styleTile = 'Style';
  static const String spaceTile = 'Space';
  static const String welcomeTile = 'Welcome';
  static const String topicsNote =
      'Pick a topic, bring a story, or just say hello.';
  static const String reviewsNote =
      'Reviews are checked before they appear. Only first names are shown.';
  static const String crisisLead = 'In crisis? Call Tele-MANAS';
  static const String crisisOr = 'or';
  static const String perMin = ' /min';
  static const String tabTopics = 'Topics';
  static const String tabReviews = 'Reviews';

  static String introHeading(String name) => 'Hear $name first';
  static String callName(String name) => 'Call $name';
  static String tenMinutes(String amount) => '10 min ≈ $amount';
  static String reviewCount(int n) => '$n ${n == 1 ? 'review' : 'reviews'}';
  static String morePictures(int n) => '+$n more';
  static String openPicture(int n) => 'Open picture $n';
  static String seeAllPictures(int n) => 'See all $n pictures';
}
