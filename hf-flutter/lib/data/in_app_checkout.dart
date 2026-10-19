import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// How an in-app payment attempt ended, as far as the phone can tell. The server alone decides whether money arrived:
/// [completed] leads to the Payment screen, which asks `GET /api/hf/wallet/topup/:id`. [HF-WIRE-21]
enum PayResult {
  /// The payment SDK says the payer finished (it still has to be confirmed by the server).
  completed,

  /// The payer backed out, the bank said no, or the SDK reported an error.
  failed,

  /// The payment SDK could not start on this phone.
  unavailable,

  /// The SDK refused because this way of paying is not switched on for the merchant account. The screen says
  /// "This payment method is not available right now" and the owner asks the provider to enable it.
  notEnabled,
}

class PayOutcome {
  const PayOutcome(this.result, [this.message]);

  final PayResult result;

  /// Plain-English reason, when the SDK gave one. Never shown with the provider's name.
  final String? message;
}

/// One UPI app installed on the phone (PhonePe, GPay, Paytm...), as reported by the payment SDK.
class UpiApp {
  const UpiApp({required this.id, required this.name, this.icon});

  /// The Android package name; this is what the SDK needs to open that app.
  final String id;
  final String name;

  /// PNG bytes of the app icon, when the SDK gave one.
  final Uint8List? icon;
}

/// The card number field (drawn by the payment SDK so the number never reaches our own code) plus the call that pays with it.
/// Card data goes only through [pay]; it is never logged, stored or sent to our server. [HF-WIRE-21]
abstract class CardEntry {
  /// The number field. [decoration] and [style] come from the app's theme.
  Widget field({required InputDecoration decoration, required TextStyle style});

  /// True once the number looks complete and passes the checksum.
  ValueListenable<bool> get numberOk;

  /// [yy] is the two-digit year ("27").
  Future<PayOutcome> pay({required String holder, required String mm, required String yy, required String cvv});

  void dispose();
}

/// The checkout inside the app. Every method works on an order the server already created ([sandbox] mirrors its `environment`).
/// UPI apps open from the app and return straight to it; nothing opens in a browser. Tests pass a fake.
abstract interface class InAppCheckout {
  /// UPI apps installed on this phone. Empty when none (or when they cannot be listed).
  Future<List<UpiApp>> upiApps();

  /// Pays with the chosen installed UPI app ([appId] is [UpiApp.id]).
  Future<PayOutcome> payWithUpiApp({required String orderId, required String paymentSessionId, required bool sandbox, required String appId});

  /// Sends a payment request to the payer's UPI ID; the payer approves it in their UPI app.
  Future<PayOutcome> payWithUpiId({required String orderId, required String paymentSessionId, required bool sandbox, required String vpa});

  /// A card form for this order, or null when cards cannot be taken on this phone.
  CardEntry? cardEntry({required String orderId, required String paymentSessionId, required bool sandbox});

  /// Old hosted-page checkout, used only when the server flag `hfCheckoutMode` is "web".
  Future<PayOutcome> payHosted({required String orderId, required String paymentSessionId, required bool sandbox});
}

/// Never starts anything: used by tests and as the "SDK missing" stand-in.
class UnavailableCheckout implements InAppCheckout {
  const UnavailableCheckout();

  @override
  Future<List<UpiApp>> upiApps() async => const [];

  @override
  Future<PayOutcome> payWithUpiApp({required String orderId, required String paymentSessionId, required bool sandbox, required String appId}) async =>
      const PayOutcome(PayResult.unavailable);

  @override
  Future<PayOutcome> payWithUpiId({required String orderId, required String paymentSessionId, required bool sandbox, required String vpa}) async =>
      const PayOutcome(PayResult.unavailable);

  @override
  CardEntry? cardEntry({required String orderId, required String paymentSessionId, required bool sandbox}) => null;

  @override
  Future<PayOutcome> payHosted({required String orderId, required String paymentSessionId, required bool sandbox}) async =>
      const PayOutcome(PayResult.unavailable);
}

// ---------------------------------------------------------------------------------------------- input checks (pure)

final RegExp _upiIdRe = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._\-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$');

/// A UPI ID looks like `name@bank`.
bool isValidUpiId(String raw) => _upiIdRe.hasMatch(raw.trim());

/// "MM/YY" (or "MMYY") -> month and two-digit year when it is a real month that has not passed; else null.
({String mm, String yy})? parseCardExpiry(String raw, {DateTime? now}) {
  final d = raw.replaceAll(RegExp(r'\D'), '');
  if (d.length != 4) return null;
  final m = int.parse(d.substring(0, 2));
  final y = int.parse(d.substring(2, 4));
  if (m < 1 || m > 12) return null;
  final n = now ?? DateTime.now();
  final fullYear = 2000 + y;
  if (fullYear < n.year || (fullYear == n.year && m < n.month)) return null;
  if (fullYear > n.year + 25) return null;
  return (mm: d.substring(0, 2), yy: d.substring(2, 4));
}

/// Card security code: 3 or 4 digits.
bool isValidCvv(String raw) => RegExp(r'^\d{3,4}$').hasMatch(raw);

/// 2 to 40 characters, no digits, handles or links; the same rule as the server's name check.
bool isValidPersonName(String raw) {
  final s = raw.trim().replaceAll(RegExp(r'\s+'), ' ');
  final len = s.runes.length;
  if (len < 2 || len > 40) return false;
  if (RegExp(r'[0-9<>@/\\]').hasMatch(s)) return false;
  return true;
}

final RegExp _emailRe = RegExp(r'^[^\s@<>()\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$');

bool isValidEmail(String raw) {
  final s = raw.trim();
  return s.length <= 254 && _emailRe.hasMatch(s) && !s.contains('..');
}
