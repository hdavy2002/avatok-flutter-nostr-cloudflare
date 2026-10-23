import '../../core/brand.dart';

/// All the words on the Help screen, in one place (HF-WIRE-11, rewritten by HF-WIRE-15 on 2026-10-19).
///
/// Aligned with the rulebook (Specs/RULEBOOK-HELLO-FRAANDS.md HF-CALL-1..6, HF-REEL-28..36, section 7):
/// calls are private and masked, you need at least ₹20 in the wallet to start, a call is made once we have
/// rung both people and joined them, a joined call that breaks in the first minute costs ₹1, a booking holds
/// the first 15 minutes (HF-BOOK-10) and is free to cancel until 1 hour before, all refunds go to the wallet (never to a card or UPI),
/// anyone can withdraw wallet money with Withdraw to their own UPI ID after a one-time ID check (HF-UPI-ONLY-1), the call queue and
/// three-way call mode (HF-CALL-7..10) and 5-minute chunk billing (HF-PAY-22/23). Refreshed by HF-FAQ-REFRESH-1. Nothing here names the
/// payment gateway.
abstract final class HelpStrings {
  static const String title = 'Help';

  /// (question, answer) pairs, in the order shown.
  static const List<(String, String)> faq = <(String, String)>[
    (
      'How does a call work?',
      'Tap Call now on an online influencer. We ring them first; when they pick up we ring your phone and join the two calls. '
          'Both calls come from our number, so neither of you ever sees the other’s real number. '
          'A call is made once we have rung both of you and joined the call.',
    ),
    (
      'How much does it cost?',
      'Each influencer sets a per-minute rate, shown on their reel and profile. You pay by the minute you speak, from your wallet. '
          'Money is set aside 5 minutes at a time and what you do not use comes back. A call can last up to 5 hours. '
          'To start a call or join a queue you need at least ₹20, or 5 minutes at their rate if that is more.',
    ),
    (
      'How do I add money?',
      'Top up from the Wallet screen with any whole-rupee amount from ₹10 to ₹5,000. 18% GST is deducted from what you pay '
          '(you pay − GST = what your wallet gets). Your receipt is in Wallet.',
    ),
    (
      'My favourite influencer is not here.',
      'Search for them and tap Invite. Every tap is a vote; we ask the most-wanted names to join.',
    ),
    (
      'What do Online, Bookings only and Offline mean?',
      'Online: you can call now, join the queue or book. Bookings only (Available by appointment): no instant calls, but you can book a time. '
          'Offline: no instant calls and no new bookings; bookings already confirmed still ring. On a call: they are talking to someone right now.',
    ),
    (
      'They are on a call. Can I wait?',
      'Tap Join the queue (or Book a time). We WhatsApp you your place (#N) and again when you are next. About a minute after their call ends, '
          'we connect you automatically. Nothing is charged while you wait and you can leave any time. If you miss our call you are removed. '
          'At most 10 people can wait, for up to 2 hours, and the influencer can pause the queue.',
    ),
    (
      'What if they are offline?',
      'Tap Notify me on their profile and we send you a WhatsApp message when they come online.',
    ),
    (
      'How do I book a call?',
      'Pick a date, a time and a length (15 min, 30 min, 1 h, 2 h, 3 h, 4 h or 5 h). We hold the cost of the first 15 minutes from your wallet, '
          'and the rest is charged 5 minutes at a time while you talk. You can cancel for free until 1 hour before it starts. If the influencer cancels, '
          'or does not pick up at the booked time, the full hold comes back to your wallet.',
    ),
    (
      'What does Waiting for approval mean?',
      'Some influencers approve each booking. Your money stays held while you wait. If they decline, or do not accept in time, '
          'you get the full amount back in your wallet. You can withdraw a pending request any time.',
    ),
    (
      'My wallet is running low during a call.',
      'Only you hear a voice message that the call will end soon. Top up while you are talking and the call keeps going. '
          'If a joined call breaks within the first minute, we charge ₹1 and return the rest.',
    ),
    (
      'Can I get my money back?',
      'We do not refund calls that were made. If the influencer declines, cancels or does not answer, you pay nothing. '
          'If a joined call breaks within the first minute, we charge ₹1 and return the rest. '
          'All refunds go back to your wallet, never to your card or UPI.',
    ),
    (
      'How do I withdraw my money?',
      'Tap Withdraw in your wallet. We send the money only to your own UPI ID (no bank account) after a one-time ID check. '
          'Any amount in whole rupees, no fee, up to 2 withdrawals a week. Each request shows its status and, once paid, the bank reference (UTR). '
          'Test credits can be spent on calls but cannot be withdrawn. An influencer’s earnings are held for 7 days first.',
    ),
    (
      'How do I close my account?',
      'In Settings, choose to close your account. Your money is settled first: your wallet balance (after GST) is paid to your UPI ID in whole rupees, '
          'and the part below ₹1 is not paid. Your account is deleted after 30 days. Influencer earnings still in the 7-day hold wait for their release date. '
          'Pause notifications only pauses the Notify me WhatsApps, and you can resume them.',
    ),
    (
      'How do I report or block someone?',
      'Use Report a person: your report is saved with a reference you can quote, and our team reviews it. Blocking someone removes them from My Fraands.',
    ),
    (
      'Where do the videos come from?',
      'From the influencer’s own YouTube or Instagram. They play in the official players. We do not copy or store videos.',
    ),
  ];

  static const String stillStuck = 'Still stuck? Write to';
  static String get supportEmail => Brand.supportEmail;
  static String get supportMailto => 'mailto:${Brand.supportEmail}';

  static const String changeEmailNote = 'To change your email, write to';
  static const String changeWhatsappNote =
      'To change your WhatsApp number, write to';
}
