/// All user-facing copy shared by more than one screen lives here, so translation can come later
/// (English only for now). Screen-specific copy lives next to its screen in the same style.
/// The brand name is never typed: use `Brand.name` from brand.dart.
abstract final class Strings {
  // States
  static const String loadingDefault = 'Loading…';
  static const String loadingPeople = 'Finding people…';
  static const String tryAgain = 'Try again';
  static const String noInternet = 'No internet. Check your connection.';
  static const String timedOut = 'That took too long. Please try again.';
  static const String somethingWrong = 'Something went wrong. Please try again.';
  static const String comingSoonTitle = 'Coming soon';
  static const String comingSoonBody = 'This is not open yet. Please check back soon.';
  static const String showingSavedList = 'Showing saved list';
  static const String notAvailable = "This profile isn't available.";

  // Sign in
  static const String signInNeeded = 'Please sign in to continue.';
  static const String signInAgain = 'Please sign in again.';

  // Safety
  static const String crisisTitle = 'Need to talk to someone right now?';
  static const String crisisTeleManas = 'Tele-MANAS 14416';
  static const String crisisEmergency = 'Emergency 112';
  static const String crisisTeleManasNumber = '14416';
  static const String crisisEmergencyNumber = '112';

  // Labels the owner wants visible at 14 sp or more (HF-AVA-1)
  static const String aiAvatarLabel = 'AI avatar chosen by the host';
  static const String aiImagesLabel = 'AI images';
  static const String recordedByHost = 'Recorded by the host';

  // Tabs
  static const String tabHome = 'Browse';
  static const String tabExplore = 'Browse';
  static const String tabWallet = 'Wallet';
  static const String tabHost = 'Host';
  static const String tabMe = 'Me';

  // Permissions
  static const String openSettings = 'Open settings';
  static const String notNow = 'Not now';
  static const String continueLabel = 'Continue';

  // Back button
  static const String exitTitle = 'Exit?';
  static const String exitYes = 'Exit';
  static const String exitNo = 'Stay';

  static const String notFoundTitle = 'Page not found';
  static const String notFoundBody = 'We could not find that page.';
  static const String goHome = 'Go to Home';
}
