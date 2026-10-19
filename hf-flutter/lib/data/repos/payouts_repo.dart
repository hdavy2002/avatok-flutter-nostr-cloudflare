import 'dart:math';

import '../api_client.dart';
import '../api_exception.dart';

int _i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;

/// The influencer's UPI as the server holds it. [nameMatched] is null when no name check was possible.
class PayoutUpi {
  const PayoutUpi({required this.vpa, this.nameMatched});

  factory PayoutUpi.fromJson(Map<String, dynamic> j) =>
      PayoutUpi(vpa: '${j['vpa'] ?? ''}', nameMatched: j['nameMatched'] is bool ? j['nameMatched'] as bool : null);

  final String vpa;
  final bool? nameMatched;
}

/// `checking` is a request we are looking at by hand; `paid` carries the bank reference.
enum PayoutStatus { checking, paid, rejected }

class PayoutItem {
  const PayoutItem({required this.id, required this.at, required this.amountPaise, required this.status, this.utr});

  factory PayoutItem.fromJson(Map<String, dynamic> j) => PayoutItem(
        id: '${j['id'] ?? ''}',
        at: DateTime.fromMillisecondsSinceEpoch(_i(j['at'])),
        amountPaise: _i(j['amountPaise']),
        status: switch (j['status']) {
          'paid' => PayoutStatus.paid,
          'rejected' => PayoutStatus.rejected,
          _ => PayoutStatus.checking,
        },
        utr: j['utr'] is String ? j['utr'] as String : null,
      );

  final String id;
  final DateTime at;
  final int amountPaise;
  final PayoutStatus status;
  final String? utr;
}

enum KycStatus { none, pending, verified }

/// `GET /api/hf/payouts/summary`. Every amount is whole paise.
class PayoutSummary {
  const PayoutSummary({
    required this.readyPaise,
    required this.onHoldPaise,
    required this.minPaise,
    this.upi,
    this.kycStatus = KycStatus.none,
    this.history = const [],
  });

  factory PayoutSummary.fromJson(Map<String, dynamic> j) {
    final upi = j['upi'];
    final hist = j['history'];
    return PayoutSummary(
      readyPaise: _i(j['readyPaise']),
      onHoldPaise: _i(j['onHoldPaise']),
      minPaise: j['minPaise'] == null ? 50000 : _i(j['minPaise']),
      upi: upi is Map ? PayoutUpi.fromJson(Map<String, dynamic>.from(upi)) : null,
      kycStatus: switch (j['kycStatus']) {
        'verified' => KycStatus.verified,
        'pending' => KycStatus.pending,
        _ => KycStatus.none,
      },
      history: hist is List
          ? [for (final h in hist) if (h is Map) PayoutItem.fromJson(Map<String, dynamic>.from(h))]
          : const [],
    );
  }

  final int readyPaise;
  final int onHoldPaise;
  final int minPaise;
  final PayoutUpi? upi;
  final KycStatus kycStatus;
  final List<PayoutItem> history;

  /// Whole rupees the person can ask for right now.
  int get readyRupees => readyPaise ~/ 100;
}

/// Where the server says to go to finish the ID check (`409 kyc_required`).
class KycNextStep {
  const KycNextStep({required this.title, required this.url});

  final String title;
  final String? url;
}

/// Payouts for influencers (HF-WIRE-10, rulebook HF-REEL-30/31).
///
/// - `GET  /api/hf/payouts/summary` -> `{readyPaise, onHoldPaise, minPaise, upi, kycStatus, history[]}`
/// - `PUT  /api/hf/payouts/upi {vpa}` -> `{ok, upi}`
/// - `POST /api/hf/payouts {amountPaise}` + `Idempotency-Key` -> `{ok, id, status, amountPaise}`; or
///   `409 kyc_required {nextStep}`, `409 upi_required`, `403 influencers_only` (fans never withdraw).
class PayoutsRepo {
  const PayoutsRepo(this._api);

  final ApiClient _api;

  static const int minRupees = 500;

  /// Same shape the server accepts: name@bank.
  static final RegExp upiPattern = RegExp(r'^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,32}$');
  static bool validUpi(String v) => upiPattern.hasMatch(v.trim().toLowerCase());

  Future<PayoutSummary> summary() async => PayoutSummary.fromJson(await _api.getJson('/api/hf/payouts/summary'));

  Future<PayoutUpi> setUpi(String vpa) async {
    final j = await _api.putJson('/api/hf/payouts/upi', body: {'vpa': vpa.trim().toLowerCase()});
    final u = j['upi'];
    if (u is! Map) throw ApiException.parse(200);
    return PayoutUpi.fromJson(Map<String, dynamic>.from(u));
  }

  /// One key per intended request: pass the same [key] when retrying after a lost answer.
  Future<void> request(int amountPaise, {required String key}) async {
    await _api.request('POST', '/api/hf/payouts', body: {'amountPaise': amountPaise}, headers: {'Idempotency-Key': key});
  }

  /// The ID-check step in a `kyc_required` error, or null for any other error.
  static KycNextStep? kycStep(Object error) {
    if (error is! ApiException || error.code != 'kyc_required') return null;
    final n = error.extra['nextStep'];
    final map = n is Map ? n : const <String, Object?>{};
    return KycNextStep(
      title: error.message ?? 'We check your ID once, before your first payout.',
      url: map['url'] is String ? map['url'] as String : null,
    );
  }

  static String newKey() {
    final r = Random.secure();
    final tail = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'payout-${DateTime.now().millisecondsSinceEpoch}-$tail';
  }
}
