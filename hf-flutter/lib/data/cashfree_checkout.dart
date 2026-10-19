import 'dart:async';

import 'package:flutter_cashfree_pg_sdk/api/cferrorresponse/cferrorresponse.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpayment/cfwebcheckoutpayment.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpaymentgateway/cfpaymentgatewayservice.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfsession/cfsession.dart';
import 'package:flutter_cashfree_pg_sdk/utils/cfenums.dart';

import 'in_app_checkout.dart';

/// [HF-WIRE-20] The official payment SDK (`flutter_cashfree_pg_sdk`, web-checkout mode) behind [InAppCheckout].
///
/// The checkout runs inside the app: card, netbanking and UPI, and UPI apps (PhonePe, GPay...) open and come back to the app.
/// The SDK reports `onVerify(orderId)` when the payer finishes and `onError(error, orderId)` otherwise. Neither credits anything:
/// the server's signed webhook is the only thing that adds money, and the Payment screen polls the server for it.
///
/// Anything that throws while starting (missing plugin, bad session) is reported as [PayResult.unavailable], so the caller can
/// fall back to the hosted page in a browser tab. The SDK itself leaves some channel errors unhandled, so the whole attempt runs
/// in a guarded zone.
class CashfreeInAppCheckout implements InAppCheckout {
  const CashfreeInAppCheckout({this.timeout = const Duration(minutes: 20)});

  /// Safety net: if the SDK never calls back (killed activity), hand over to the Payment screen, which asks the server.
  final Duration timeout;

  @override
  Future<PayOutcome> pay({required String orderId, required String paymentSessionId, required bool sandbox}) {
    final done = Completer<PayOutcome>();
    void finish(PayOutcome o) {
      if (!done.isCompleted) done.complete(o);
    }

    runZonedGuarded(() {
      try {
        final session = CFSessionBuilder()
            .setEnvironment(sandbox ? CFEnvironment.SANDBOX : CFEnvironment.PRODUCTION)
            .setOrderId(orderId)
            .setPaymentSessionId(paymentSessionId)
            .build();
        final payment = CFWebCheckoutPaymentBuilder().setSession(session).build();
        final service = CFPaymentGatewayService();
        service.setCallback(
          (String id) => finish(const PayOutcome(PayResult.completed)),
          (CFErrorResponse e, String id) => finish(PayOutcome(PayResult.failed, e.getMessage())),
        );
        service.doPayment(payment);
      } catch (_) {
        finish(const PayOutcome(PayResult.unavailable));
      }
    }, (Object e, StackTrace st) => finish(const PayOutcome(PayResult.unavailable)));

    return done.future.timeout(timeout, onTimeout: () => const PayOutcome(PayResult.completed));
  }
}
