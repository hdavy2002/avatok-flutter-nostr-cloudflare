import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfcard/cfcardlistener.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfcard/cfcardwidget.dart';
import 'package:flutter_cashfree_pg_sdk/api/cferrorresponse/cferrorresponse.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpayment/cfcard.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpayment/cfcardpayment.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpayment/cfupi.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpayment/cfupipayment.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpayment/cfwebcheckoutpayment.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfpaymentgateway/cfpaymentgatewayservice.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfsession/cfsession.dart';
import 'package:flutter_cashfree_pg_sdk/api/cfupi/cfupiutils.dart';
import 'package:flutter_cashfree_pg_sdk/utils/cfenums.dart';

import 'in_app_checkout.dart';

/// [HF-WIRE-21] The official payment SDK (`flutter_cashfree_pg_sdk` 2.5.0+53, "element" / seamless mode) behind [InAppCheckout].
///
/// Everything happens on our own screens:
///  - UPI apps: `CFUPIUtils().getUPIApps()` lists what is installed; `CFUPIBuilder().setChannel(CFUPIChannel.INTENT).setUPIID(<package>)`
///    pays with the chosen one, and that app returns straight to us.
///  - UPI ID: the same builder with `CFUPIChannel.COLLECT` and the payer's `name@bank`.
///  - Card: `CFCardWidget` (the SDK draws the number field, so the number never reaches our code) + `CFCardBuilder` +
///    `CFCardPaymentBuilder`. Expiry, CVV and holder name are handed to the SDK in the same call and nowhere else.
///  - Hosted page (`CFWebCheckoutPaymentBuilder`): only behind the server flag `hfCheckoutMode = web`.
///
/// The SDK reports `onVerify(orderId)` when the payer finishes and `onError(error, orderId)` otherwise. Neither credits anything:
/// the server's signed webhook is the only thing that adds money, and the Payment screen polls the server for it.
///
/// Anything that throws while starting is reported as [PayResult.unavailable]. An error that says the way of paying is not switched on
/// for the merchant account is reported as [PayResult.notEnabled]. The SDK leaves some channel errors unhandled, so every attempt runs
/// in a guarded zone.
class CashfreeInAppCheckout implements InAppCheckout {
  const CashfreeInAppCheckout({this.timeout = const Duration(minutes: 20)});

  /// Safety net: if the SDK never calls back (killed activity), hand over to the Payment screen, which asks the server.
  final Duration timeout;

  static CFSession _session(String orderId, String sessionId, bool sandbox) => CFSessionBuilder()
      .setEnvironment(sandbox ? CFEnvironment.SANDBOX : CFEnvironment.PRODUCTION)
      .setOrderId(orderId)
      .setPaymentSessionId(sessionId)
      .build();

  /// Pure: does this SDK error mean "this way of paying is not enabled for the account"? Public for tests.
  @visibleForTesting
  static bool looksNotEnabled(String? message, String? code) {
    final m = (message ?? '').toLowerCase();
    final c = (code ?? '').toLowerCase();
    const words = [
      'not enabled', 'not activated', 'not active', 'not allowed', 'disabled', 'unauthorized', 'unauthorised', 'not authorized',
      'not authorised', 'permission', 'feature not', 'not available for', 'not configured', 'not whitelisted',
    ];
    if (words.any(m.contains)) return true;
    return c.contains('feature_not_enabled') || c.contains('authentication_error') || c.contains('not_enabled');
  }

  Future<PayOutcome> _run(void Function(void Function(PayOutcome) finish) start) {
    final done = Completer<PayOutcome>();
    void finish(PayOutcome o) {
      if (!done.isCompleted) done.complete(o);
    }

    runZonedGuarded(() {
      try {
        start(finish);
      } catch (_) {
        finish(const PayOutcome(PayResult.unavailable));
      }
    }, (Object e, StackTrace st) => finish(const PayOutcome(PayResult.unavailable)));

    return done.future.timeout(timeout, onTimeout: () => const PayOutcome(PayResult.completed));
  }

  static void _listen(CFPaymentGatewayService service, void Function(PayOutcome) finish) {
    service.setCallback(
      (String id) => finish(const PayOutcome(PayResult.completed)),
      (CFErrorResponse e, String id) {
        final notEnabled = looksNotEnabled(e.getMessage(), e.getCode());
        finish(PayOutcome(notEnabled ? PayResult.notEnabled : PayResult.failed, e.getMessage()));
      },
    );
  }

  @override
  Future<List<UpiApp>> upiApps() async {
    try {
      final raw = await CFUPIUtils().getUPIApps();
      if (raw == null) return const [];
      final out = <UpiApp>[];
      for (final a in raw) {
        if (a is! Map) continue;
        final id = '${a['id'] ?? ''}'.trim();
        if (id.isEmpty) continue;
        final name = '${a['displayName'] ?? a['name'] ?? id}'.trim();
        out.add(UpiApp(id: id, name: name.isEmpty ? id : name, icon: _icon(a['icon'])));
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  static Uint8List? _icon(Object? v) {
    if (v is! String || v.isEmpty) return null;
    try {
      return base64Decode(v);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<PayOutcome> payWithUpiApp({required String orderId, required String paymentSessionId, required bool sandbox, required String appId}) =>
      _run((finish) {
        final upi = CFUPIBuilder().setChannel(CFUPIChannel.INTENT).setUPIID(appId).build();
        final payment = CFUPIPaymentBuilder().setSession(_session(orderId, paymentSessionId, sandbox)).setUPI(upi).build();
        final service = CFPaymentGatewayService();
        _listen(service, finish);
        service.doPayment(payment);
      });

  @override
  Future<PayOutcome> payWithUpiId({required String orderId, required String paymentSessionId, required bool sandbox, required String vpa}) =>
      _run((finish) {
        final upi = CFUPIBuilder().setChannel(CFUPIChannel.COLLECT).setUPIID(vpa.trim()).build();
        final payment = CFUPIPaymentBuilder().setSession(_session(orderId, paymentSessionId, sandbox)).setUPI(upi).build();
        final service = CFPaymentGatewayService();
        _listen(service, finish);
        service.doPayment(payment);
      });

  @override
  CardEntry? cardEntry({required String orderId, required String paymentSessionId, required bool sandbox}) =>
      _CashfreeCardEntry(this, _session(orderId, paymentSessionId, sandbox));

  @override
  Future<PayOutcome> payHosted({required String orderId, required String paymentSessionId, required bool sandbox}) => _run((finish) {
        final payment = CFWebCheckoutPaymentBuilder().setSession(_session(orderId, paymentSessionId, sandbox)).build();
        final service = CFPaymentGatewayService();
        _listen(service, finish);
        service.doPayment(payment);
      });
}

class _CashfreeCardEntry implements CardEntry {
  _CashfreeCardEntry(this._owner, this._session);

  final CashfreeInAppCheckout _owner;
  final CFSession _session;
  final GlobalKey<CFCardWidgetState> _key = GlobalKey<CFCardWidgetState>();
  final ValueNotifier<bool> _ok = ValueNotifier<bool>(false);
  CFCardWidget? _widget;
  bool _disposed = false;

  @override
  ValueListenable<bool> get numberOk => _ok;

  @override
  Widget field({required InputDecoration decoration, required TextStyle style}) {
    _widget ??= CFCardWidget(
      key: _key,
      inputDecoration: decoration,
      textStyle: style,
      cfSession: _session,
      cardListener: (CFCardListener l) {
        if (_disposed) return;
        final n = l.getNumberOfCharacters() ?? 0;
        final meta = l.getMetaData();
        final luhn = meta is Map && meta['luhn_check_info'] == 'SUCCESS';
        _ok.value = n >= 13 && n <= 19 && luhn;
      },
    );
    // The SDK field carries its own 20 dp side margin; widen it by 40 so it lines up with our other fields.
    return SizedBox(
      height: 76,
      child: LayoutBuilder(
        builder: (context, c) => OverflowBox(
          minWidth: c.maxWidth + 40,
          maxWidth: c.maxWidth + 40,
          minHeight: 0,
          maxHeight: 76,
          alignment: Alignment.center,
          child: _widget,
        ),
      ),
    );
  }

  @override
  Future<PayOutcome> pay({required String holder, required String mm, required String yy, required String cvv}) {
    final w = _widget;
    if (w == null) return Future.value(const PayOutcome(PayResult.unavailable));
    return _owner._run((finish) {
      final card = CFCardBuilder()
          .setCardWidget(w)
          .setCardHolderName(holder)
          .setCardExpiryMonth(mm)
          .setCardExpiryYear(yy)
          .setCardCVV(cvv)
          .build();
      final payment = CFCardPaymentBuilder().setSession(_session).setCard(card).build();
      final service = CFPaymentGatewayService();
      CashfreeInAppCheckout._listen(service, finish);
      service.doPayment(payment);
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _ok.dispose();
  }
}
