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

/// `requested` is waiting for approval (can still be cancelled); `checking` is approved and being paid; `paid` carries the bank
/// reference; `cancelled` is a request the person took back (the money returned to the wallet).
enum PayoutStatus { requested, checking, paid, rejected, cancelled }

class PayoutItem {
  const PayoutItem({required this.id, required this.at, required this.amountPaise, required this.status, this.utr});

  factory PayoutItem.fromJson(Map<String, dynamic> j) => PayoutItem(
        id: '${j['id'] ?? ''}',
        at: DateTime.fromMillisecondsSinceEpoch(_i(j['at'])),
        amountPaise: _i(j['amountPaise']),
        status: switch (j['status']) {
          'paid' => PayoutStatus.paid,
          'rejected' => PayoutStatus.rejected,
          'requested' => PayoutStatus.requested,
          'cancelled' => PayoutStatus.cancelled,
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
    this.maxPerWeek = defaultMaxPerWeek,
  });

  /// The server's own default (`hfPayoutMaxPerWeek`), used until it tells us the real number.
  static const int defaultMaxPerWeek = 2;

  factory PayoutSummary.fromJson(Map<String, dynamic> j) {
    final upi = j['upi'];
    final hist = j['history'];
    return PayoutSummary(
      readyPaise: _i(j['readyPaise']),
      onHoldPaise: _i(j['onHoldPaise']),
      minPaise: j['minPaise'] == null ? 0 : _i(j['minPaise']), // HF-REEL-38: no minimum unless the server sets one
      upi: upi is Map ? PayoutUpi.fromJson(Map<String, dynamic>.from(upi)) : null,
      kycStatus: switch (j['kycStatus']) {
        'verified' => KycStatus.verified,
        'pending' => KycStatus.pending,
        _ => KycStatus.none,
      },
      maxPerWeek: j['maxPerWeek'] is num && (j['maxPerWeek'] as num) >= 1 ? (j['maxPerWeek'] as num).round() : defaultMaxPerWeek,
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

  /// How many withdrawal requests a person may make in a week.
  final int maxPerWeek;

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
/// - `GET  /api/hf/payouts/summary` -> `{readyPaise, onHoldPaise, minPaise, upi, kycStatus, history[]}` (open to fans too, HF-REEL-36)
/// - `PUT  /api/hf/payouts/upi {vpa}` -> `{ok, upi}`
/// - `POST /api/hf/payouts {amountPaise}` + `Idempotency-Key` -> `{ok, id, status, amountPaise}`; or
///   `409 kyc_required {nextStep}`, `409 upi_required`. Anyone can withdraw wallet money (no more `403 influencers_only`).
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

  /// `POST /api/hosts/me/payouts/:id/cancel` - only while the request is still `requested`. The money returns to the wallet.
  /// `409 not_cancellable` means it was just approved.
  Future<void> cancel(String id) async {
    await _api.request('POST', '/api/hosts/me/payouts/${Uri.encodeComponent(id)}/cancel');
  }

  /// Plain words for the refusals a withdrawal can get, by the server's exact error code. Other errors keep the server's own sentence.
  static String friendlyError(Object error, {int maxPerWeek = PayoutSummary.defaultMaxPerWeek}) {
    if (error is! ApiException) return ApiException.genericText;
    return switch (error.code) {
      'weekly_limit' => 'You can withdraw $maxPerWeek times a week, and you have used them. Please try again in a few days.',
      'insufficient_withdrawable' => 'That is more than you can withdraw right now. Try a smaller amount.',
      'not_cancellable' => 'This request was just approved, so it cannot be cancelled now.',
      'upi_required' => 'Add your UPI first.',
      _ => error.userMessage,
    };
  }

  /// The ID-check step in a `kyc_required` error, or null for any other error.
  static KycNextStep? kycStep(Object error) {
    if (error is! ApiException || error.code != 'kyc_required') return null;
    final n = error.extra['nextStep'];
    final map = n is Map ? n : const <String, Object?>{};
    return KycNextStep(
      title: error.message ?? 'We check your ID once, before your first withdrawal.',
      url: map['url'] is String ? map['url'] as String : null,
    );
  }

  static String newKey() {
    final r = Random.secure();
    final tail = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'payout-${DateTime.now().millisecondsSinceEpoch}-$tail';
  }
}
