import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';

/// What the person can do about a failed withdrawal.
enum PayoutAction {
  /// Nothing: read the message.
  none,

  /// Finish the identity or bank step in onboarding.
  finishSetup,

  /// Try again.
  retry,
}

class PayoutFailure {
  const PayoutFailure(this.message, [this.action = PayoutAction.none]);
  final String message;
  final PayoutAction action;
}

/// The result of checking what was typed in the amount box.
class PayoutCheck {
  const PayoutCheck.ok(int this.amount) : error = null;
  const PayoutCheck.error(String this.error) : amount = null;

  final int? amount;
  final String? error;

  bool get isOk => amount != null;
}

/// Pure rules for the withdrawal form. The server decides in the end; these only save a round trip and
/// say it in simple English. Amounts are whole rupees (the worker pays whole rupees, minimum Rs 500).
abstract final class PayoutRules {
  static String belowMinimum(int minRupees) => 'The smallest withdrawal is ${Money.rupees(minRupees)}.';

  static PayoutCheck check(String input, {required int minRupees, required int withdrawable}) {
    final text = input.trim();
    if (text.isEmpty) return const PayoutCheck.error('Enter how much you want to withdraw.');
    if (!RegExp(r'^\d{1,9}$').hasMatch(text)) return const PayoutCheck.error('Enter a whole rupee amount, like 500.');
    final amount = int.parse(text);
    if (amount <= 0) return const PayoutCheck.error('Enter a whole rupee amount, like 500.');
    if (amount < minRupees) return PayoutCheck.error(belowMinimum(minRupees));
    if (amount > withdrawable) return PayoutCheck.error('You can withdraw up to ${Money.rupees(withdrawable)} right now.');
    return PayoutCheck.ok(amount);
  }

  /// Maps the worker's answer to one message and one action. The worker's own message wins when it sent
  /// one (it already knows the numbers); the fallback covers every documented code.
  static PayoutFailure failure(ApiError e, {int minRupees = 500}) {
    final fallback = switch (e.code) {
      'not_enabled' => 'Withdrawals open soon.',
      'not_live' => 'Withdrawals open once your profile is live.',
      'kyc_required' => 'Please finish your identity check before you withdraw.',
      'bank_required' => 'Please add your bank account before you withdraw.',
      'invalid_amount' => 'Enter a whole rupee amount, like 500.',
      'below_minimum' => belowMinimum(minRupees),
      'weekly_limit' => "You've reached this week's withdrawal limit. Please try again next week.",
      'insufficient_withdrawable' => 'That amount is not available yet. Earnings are held for 7 days.',
      'wallet_error' => "We couldn't set that money aside. Please try again.",
      'not_cancellable' => 'This request can no longer be cancelled.',
      _ => e.userMessage,
    };
    final message = e.isOffline ? e.userMessage : ((e.message != null && e.message!.isNotEmpty) ? e.message! : fallback);
    final action = switch (e.code) {
      'kyc_required' || 'bank_required' => PayoutAction.finishSetup,
      'wallet_error' || 'rate_limited' => PayoutAction.retry,
      _ => (e.isOffline || e.status >= 500 || e.isRateLimited) ? PayoutAction.retry : PayoutAction.none,
    };
    return PayoutFailure(message, action);
  }

  /// A failure that may be a lost answer (offline, slow, server error). Then the same Idempotency-Key is
  /// reused on the retry. Any definite answer from the server gets a fresh key for the next try.
  static bool keepsKey(ApiError e) => e.isOffline || e.status >= 500;
}
