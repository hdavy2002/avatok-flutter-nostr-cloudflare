import '../../core/brand.dart';

/// All the words on the Help screen, in one place (HF-WIRE-11, rewritten by HF-WIRE-15 on 2026-10-19).
///
/// Aligned with the rulebook (Specs/RULEBOOK-HELLO-FRAANDS.md HF-CALL-1..6, HF-REEL-28..36, section 7):
/// calls are private and masked, you need at least ₹20 in the wallet to start, a call is made once we have
/// rung both people and joined them, a joined call that breaks in the first minute costs ₹1, a booking holds
/// 10 minutes and is free to cancel until 1 hour before, all refunds go to the wallet (never to a card or UPI),
/// anyone can withdraw wallet money with Payout after a one-time ID and UPI check. Nothing here names the
/// payment gateway.
abstract final class HelpStrings {
  static const String title = 'Help';

  /// (question, answer) pairs, in the order shown.
  static const List<(String, String)> faq = <(String, String)>[
    (
      'How does a call work?',
      'Tap Call now on an online influencer. We ring them first; when they pick up we ring your phone and join the two calls. '
          'Both calls come from our number, so neither of you ever sees the other\'s real number. '
          'A call is made once we have rung both of you and joined the call.',
    ),
    (
      'How much does it cost?',
      'Each influencer sets a per-minute rate, shown on their reel and profile. You pay per minute spoken, from your wallet. '
          'You need at least ₹20 in your wallet to start a call. You can top up any amount from ₹10; the price includes 18% GST, '
          'so your wallet gets the amount divided by 1.18. Top up from the Wallet screen.',
    ),
    (
      'My favourite influencer is not here.',
      'Search for them and tap Invite. Every tap is a vote; we ask the most-wanted names to join.',
    ),
    (
      'What if they are offline?',
      'Tap Notify me on their profile and we send you a WhatsApp message when they come online. Or book a time: we hold 10 minutes of their rate '
          'from your wallet and ring you both at that minute. You can cancel for free until 1 hour before it starts. If the influencer cancels, '
          'or does not pick up at the booked time, the full hold comes back to your wallet.',
    ),
    (
      'Can I get my money back?',
      'We do not refund calls that were made. If the influencer declines, cancels or does not answer, you pay nothing. '
          'If a joined call breaks within the first minute, we charge ₹1 and return the rest. '
          'All refunds go back to your wallet, never to your card or UPI.',
    ),
    (
      'How do I take my money out?',
      'Tap Payout in your wallet. We send the money to your UPI after a one-time ID (KYC) and UPI check. There is no minimum amount and we take no fee. '
          'Test credits can be spent on calls but cannot be withdrawn. An influencer\'s earnings are held for 7 days first.',
    ),
    (
      'Where do the videos come from?',
      'From the influencer\'s own YouTube or Instagram. They play in the official players. We do not copy or store videos.',
    ),
  ];

  static const String stillStuck = 'Still stuck? Write to';
  static String get supportEmail => Brand.supportEmail;
  static String get supportMailto => 'mailto:${Brand.supportEmail}';

  static const String changeEmailNote = 'To change your email, write to';
  static const String changeWhatsappNote = 'To change your WhatsApp number, write to';
}
