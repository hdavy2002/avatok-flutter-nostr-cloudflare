import '../../core/brand.dart';

/// All the words on the Help screen, in one place (HF-WIRE-11).
///
/// Aligned with the rulebook (Specs/RULEBOOK-HELLO-FRAANDS.md): calls are masked and joined by us,
/// the wallet is charged per minute, "Notify me" for offline influencers, a booking is free to cancel
/// until 1 hour before it starts (HF-REEL-28), unused top-up money goes back to the original payment
/// (HF-REEL-31, HF-PAY-15). Nothing here names the payment gateway.
abstract final class HelpStrings {
  static const String title = 'Help';

  /// (question, answer) pairs, in the order shown.
  static const List<(String, String)> faq = <(String, String)>[
    (
      'How does a call work?',
      'Tap Call now on an online influencer. We ring them first; when they pick up we ring your phone and join the two calls. '
          'Both calls come from our number, so neither of you ever sees the other\'s real number.',
    ),
    (
      'How much does it cost?',
      'Each influencer sets a per-minute rate, shown on their reel and profile. It comes out of your wallet minute by minute while you talk, '
          'and the call stops when your wallet runs low. Top up from the Wallet screen.',
    ),
    (
      'My favourite influencer is not here.',
      'Search for them and tap Invite. Every tap is a vote; we ask the most-wanted names to join.',
    ),
    (
      'What if they are offline?',
      'Tap Notify me on their profile and we send you a WhatsApp message when they come online. Or book a time: we hold the money from your wallet '
          'and ring you both at that minute. You can cancel a booking for free until 1 hour before it starts, and if the influencer cancels you always get your money back.',
    ),
    (
      'Can I get my money back?',
      'Yes. Unused top-up money is refunded to the same payment you used, within 180 days of paying. Test credits can be spent but are not refundable. '
          'Money held for a booking comes back when the booking is cancelled in time.',
    ),
  ];

  static const String stillStuck = 'Still stuck? Write to';
  static String get supportEmail => Brand.supportEmail;
  static String get supportMailto => 'mailto:${Brand.supportEmail}';

  static const String changeEmailNote = 'To change your email, write to';
  static const String changeWhatsappNote = 'To change your WhatsApp number, write to';
}
