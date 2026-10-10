/// All copy of the Host dashboard in one place (English only for now). Simple words, no jargon.
/// Hosts see rupees only, never tokens.
abstract final class HostCopy {
  static const String title = 'Host';
  static const String signIn = 'Sign in';
  static const String signInBody = 'Please sign in to see your host dashboard.';

  // No host profile
  static const String becomeTitle = 'Become a host';
  static const String becomeBody = 'Talk to people and earn. Set up your profile in about 10 minutes.';
  static const String becomeAction = 'Start setup';

  // Status banners
  static const String draftTitle = 'Finish setting up your profile';
  static const String draftBody = 'Add your details so callers can find you.';
  static const String draftAction = 'Continue setup';
  static const String generatingTitle = "We're building your profile";
  static const String generatingBody = 'This takes a few minutes. Check back soon.';
  static const String generatingAction = 'See progress';
  static const String pendingHostTitle = 'Check your profile and send it';
  static const String pendingHostBody = 'Your profile is ready. Look it over, then send it for review.';
  static const String pendingHostAction = 'Review and send';
  static const String reviewTitle = 'Sent for review';
  static const String reviewBody = "We'll tell you on WhatsApp and here when it's approved.";
  static const String rejectedTitle = 'Your profile needs changes';
  static const String rejectedBody = 'Please update your profile and send it again.';
  static const String pausedTitle = 'Your profile is paused';
  static const String pausedBody = 'Calls are switched off for now. Please update your profile and send it again.';
  static const String fixAction = 'Fix and send again';

  // Online toggle
  static const String presenceTitle = 'Taking calls';
  static const String goOnline = 'Go online';
  static const String goOffline = 'Go offline';
  static const String offlineNote = 'Go online to take calls. Your phone rings when someone calls you.';
  static const String onlineNote =
      'You stay online for up to 8 hours after you last had the app open. Open the app to stay online longer.';
  static const String notLive = "Your profile isn't live yet.";

  // Today
  static const String todayTitle = 'Today';
  static const String todayCalls = 'Calls';
  static const String todayMinutes = 'Minutes';
  static const String todayEarned = 'Earned';

  // Calls
  static const String callsTitle = 'Recent calls';
  static const String callsEmpty = 'No calls yet. When someone calls you, it shows up here.';
  static const String paidCall = 'Paid call';
  static const String testCall = 'Test call';
  static const String testCallNote = 'Test calls are not withdrawable.';
  static const String underMinute = 'Under a minute, not paid';
  static const String showMore = 'Show more calls';
  static const String showLess = 'Show fewer calls';

  // Earnings
  static const String earningsTitle = 'Your earnings';
  static const String earningsTotal = 'Total earned';
  static const String earningsAvailable = 'Available to withdraw';
  static const String earningsPending = 'On hold';
  static const String earningsPaidOut = 'Paid out so far';
  static const String earningsTest = 'Test earnings';
  static const String earningsTestNote = 'Test earnings are not withdrawable.';
  static String holdNote(int days) => 'New earnings are held for $days days before you can withdraw them.';

  // Withdrawals
  static const String payoutsTitle = 'Withdrawals';
  static const String payoutsSoon = 'Withdrawals open soon.';
  static const String withdraw = 'Withdraw';
  static const String requestTitle = 'Withdraw money';
  static const String requestAction = 'Request withdrawal';
  static const String amountLabel = 'Amount in rupees';
  static const String requested = 'Withdrawal requested. We will tell you when it is paid.';
  static const String finishSetup = 'Finish setup';
  static const String historyTitle = 'Your withdrawals';
  static const String historyEmpty = 'No withdrawals yet.';
  static const String cancelAction = 'Cancel request';
  static const String cancelTitle = 'Cancel this withdrawal?';
  static const String cancelBody = 'The money goes back to your available balance.';
  static const String cancelYes = 'Yes, cancel it';
  static const String cancelNo = 'Keep it';
  static const String cancelled = 'Withdrawal cancelled.';
  static const String blockNotLive = 'You can withdraw once your profile is live.';
  static const String blockKyc = 'Finish your identity check to withdraw.';
  static const String blockBank = 'Add your bank account to withdraw.';
  static String blockTooLow(String min) => 'You can withdraw once $min is available.';
  static String rules(String min, int perWeek) => 'Smallest withdrawal $min. Up to $perWeek requests a week.';
  static String bank(String last4, String? ifsc) =>
      'Paid to the bank account ending $last4${ifsc == null ? '' : ' ($ifsc)'}.';
  static String upTo(String amount) => 'You can withdraw up to $amount right now.';
  static const String manualNote = 'We pay by bank transfer after checking your request. This can take a day or two.';
}
