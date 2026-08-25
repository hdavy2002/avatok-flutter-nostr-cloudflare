import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'api_auth.dart';
import 'config.dart';

/// Provider-neutral Phase 2C checkout contracts.
///
/// The public listing URL is never sent as an admission credential. The Worker
/// binds the returned order and entitlement to the signed account, and the
/// same idempotency key must be reused when a request is retried.
enum CommercialCheckoutKind { liveEvent, consultation }

class CommercialCheckoutResult {
  const CommercialCheckoutResult({
    required this.status,
    required this.ok,
    this.error,
    this.kind,
    this.listingId,
    this.bookingId,
    this.orderId,
    this.entitlementId,
    this.policySnapshotId,
    this.grossAmount,
    this.balance,
    this.needed,
    this.currency,
    this.startsAt,
    this.endsAt,
    this.idempotentReplay = false,
  });

  final int status;
  final bool ok;
  final String? error;
  final String? kind;
  final String? listingId;
  final String? bookingId;
  final String? orderId;
  final String? entitlementId;
  final String? policySnapshotId;
  final int? grossAmount;
  final int? balance, needed;
  final String? currency;
  final int? startsAt;
  final int? endsAt;
  final bool idempotentReplay;

  bool get accountBound => ok;

  factory CommercialCheckoutResult.fromResponse(int status, String body) {
    Map<String, dynamic> json;
    try {
      final decoded = jsonDecode(body);
      json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    } catch (_) {
      json = <String, dynamic>{};
    }
    return CommercialCheckoutResult(
      status: status,
      ok: status == 200 && json['ok'] == true,
      error: json['error']?.toString(),
      kind: json['kind']?.toString(),
      listingId: json['listing_id']?.toString(),
      bookingId: json['booking_id']?.toString(),
      orderId: json['order_id']?.toString(),
      entitlementId: json['entitlement_id']?.toString(),
      policySnapshotId: json['policy_snapshot_id']?.toString(),
      grossAmount: (json['gross_amount'] as num?)?.toInt(),
      balance: (json['balance'] as num?)?.toInt(),
      needed: (json['needed'] as num?)?.toInt(),
      currency: json['currency']?.toString(),
      startsAt: (json['starts_at'] as num?)?.toInt(),
      endsAt: (json['ends_at'] as num?)?.toInt(),
      idempotentReplay: json['idempotent_replay'] == true,
    );
  }
}

class CommercialCheckoutApi {
  static const String _base = 'https://$kSignalingHost/api/commercial';

  /// Test-only seam for exercising replay behavior without a live Worker.
  /// Production callers leave this null; the caller-owned idempotency key is
  /// still the only key sent on every attempt.
  static Future<http.Response> Function(
    String url,
    Map<String, dynamic> body,
    Map<String, String> headers,
  )? debugPostOverride;

  /// Generate once per logical checkout and persist/reuse it across retries.
  static String newIdempotencyKey() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return bytes.map((v) => v.toRadixString(16).padLeft(2, '0')).join();
  }

  static Future<CommercialCheckoutResult> liveTicket({
    required String listingId,
    required bool acceptPolicy,
    required String idempotencyKey,
  }) async {
    return _checkout(
      path: 'live/${Uri.encodeComponent(listingId)}/checkout',
      body: {'accept_policy': acceptPolicy},
      idempotencyKey: idempotencyKey,
    );
  }

  static Future<CommercialCheckoutResult> consultation({
    required String listingId,
    required int startAt,
    required int endAt,
    required bool acceptPolicy,
    required String idempotencyKey,
  }) async {
    return _checkout(
      path: 'consult/${Uri.encodeComponent(listingId)}/checkout',
      body: {
        'accept_policy': acceptPolicy,
        'slot': {'start_at': startAt, 'end_at': endAt},
      },
      idempotencyKey: idempotencyKey,
    );
  }

  static Future<CommercialCheckoutResult> _checkout({
    required String path,
    required Map<String, dynamic> body,
    required String idempotencyKey,
  }) async {
    try {
      final headers = {'Idempotency-Key': idempotencyKey};
      final response = debugPostOverride != null
          ? await debugPostOverride!('$_base/$path', body, headers)
          : await ApiAuth.postJsonH(
              '$_base/$path',
              body,
              headers,
              timeout: const Duration(seconds: 20),
            );
      return CommercialCheckoutResult.fromResponse(response.statusCode, response.body);
    } catch (_) {
      // The key must be retained by the caller and reused after a network
      // failure; this result intentionally does not mint a replacement key.
      return const CommercialCheckoutResult(status: 0, ok: false, error: 'network');
    }
  }
}
