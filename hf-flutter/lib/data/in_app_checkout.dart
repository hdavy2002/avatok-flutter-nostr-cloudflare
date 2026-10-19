/// How an in-app payment attempt ended, as far as the phone can tell. The server alone decides whether money arrived:
/// both [completed] and [failed] lead to the Payment screen, which asks `GET /api/hf/wallet/topup/:id`. [HF-WIRE-20]
enum PayResult {
  /// The payment SDK says the payer finished (it still has to be confirmed by the server).
  completed,

  /// The payer backed out or the SDK reported an error.
  failed,

  /// The payment SDK could not start on this phone: the caller falls back to the hosted page in a browser tab.
  unavailable,
}

class PayOutcome {
  const PayOutcome(this.result, [this.message]);

  final PayResult result;

  /// Plain-English reason, when the SDK gave one. Never shown with the provider's name.
  final String? message;
}

/// The in-app checkout (payment sheet inside the app, UPI apps open and return to the app). Tests pass a fake.
abstract interface class InAppCheckout {
  /// Opens the checkout for an order the server already created. [sandbox] mirrors the server's `environment`.
  Future<PayOutcome> pay({required String orderId, required String paymentSessionId, required bool sandbox});
}

/// Never starts anything: used by tests and as the "SDK missing" stand-in. The caller then takes the browser-tab fallback.
class UnavailableCheckout implements InAppCheckout {
  const UnavailableCheckout();

  @override
  Future<PayOutcome> pay({required String orderId, required String paymentSessionId, required bool sandbox}) async =>
      const PayOutcome(PayResult.unavailable);
}
