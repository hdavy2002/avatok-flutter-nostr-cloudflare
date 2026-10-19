import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hf_app/data/in_app_checkout.dart';

/// [HF-WIRE-21] A stand-in for the payment SDK. It records what it was asked to do (never any card number: the real SDK keeps that
/// to itself too) and answers with whatever the test set.
class FakeCheckout implements InAppCheckout {
  FakeCheckout({
    this.apps = const [],
    this.upiAppOutcome = const PayOutcome(PayResult.completed),
    this.hostedOutcome = const PayOutcome(PayResult.completed),
    this.cardOutcome = const PayOutcome(PayResult.completed),
    this.cardsAvailable = true,
  });

  List<UpiApp> apps;
  PayOutcome upiAppOutcome;
  PayOutcome hostedOutcome;
  PayOutcome cardOutcome;
  bool cardsAvailable;

  /// When set, `payWithUpiId` waits on it (the payer has not approved yet). Otherwise it answers [upiIdOutcome] at once.
  Completer<PayOutcome>? upiIdWait;
  PayOutcome upiIdOutcome = const PayOutcome(PayResult.completed);

  final List<String> calls = [];
  FakeCardEntry? lastCard;

  @override
  Future<List<UpiApp>> upiApps() async => apps;

  @override
  Future<PayOutcome> payWithUpiApp({required String orderId, required String paymentSessionId, required bool sandbox, required String appId}) async {
    calls.add('upi_app|$orderId|$paymentSessionId|$sandbox|$appId');
    return upiAppOutcome;
  }

  @override
  Future<PayOutcome> payWithUpiId({required String orderId, required String paymentSessionId, required bool sandbox, required String vpa}) {
    calls.add('upi_id|$orderId|$paymentSessionId|$sandbox|$vpa');
    final w = upiIdWait;
    return w != null ? w.future : Future.value(upiIdOutcome);
  }

  @override
  CardEntry? cardEntry({required String orderId, required String paymentSessionId, required bool sandbox}) {
    calls.add('card_form|$orderId|$paymentSessionId|$sandbox');
    if (!cardsAvailable) return null;
    return lastCard = FakeCardEntry(this);
  }

  @override
  Future<PayOutcome> payHosted({required String orderId, required String paymentSessionId, required bool sandbox}) async {
    calls.add('hosted|$orderId|$paymentSessionId|$sandbox');
    return hostedOutcome;
  }
}

class FakeCardEntry implements CardEntry {
  FakeCardEntry(this._owner);

  final FakeCheckout _owner;
  final ValueNotifier<bool> _ok = ValueNotifier<bool>(false);
  bool disposed = false;

  @override
  ValueListenable<bool> get numberOk => _ok;

  @override
  Widget field({required InputDecoration decoration, required TextStyle style}) => TextField(
        key: const Key('fake-card-number'),
        keyboardType: TextInputType.number,
        onChanged: (v) => _ok.value = v.replaceAll(' ', '').length >= 15,
        decoration: decoration,
        style: style,
      );

  @override
  Future<PayOutcome> pay({required String holder, required String mm, required String yy, required String cvv}) async {
    _owner.calls.add('card_pay|$holder|$mm|$yy|cvv${cvv.length}');
    return _owner.cardOutcome;
  }

  @override
  void dispose() => disposed = true;
}
