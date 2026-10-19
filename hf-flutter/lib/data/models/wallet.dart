/// Money shapes for the wallet and top-up screens (HF-WIRE-6). Every amount is whole paise (an int).

int _i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;

/// What the history row was for. Unknown server words fall back to [topup].
enum LedgerKind { call, topup, hold, release, payout, refund }

LedgerKind _kind(Object? v) {
  for (final k in LedgerKind.values) {
    if (k.name == v) return k;
  }
  return LedgerKind.topup;
}

class LedgerEntry {
  const LedgerEntry({required this.id, required this.kind, required this.amountPaise, required this.at, required this.label});

  factory LedgerEntry.fromJson(Map<String, dynamic> j) => LedgerEntry(
        id: '${j['id'] ?? ''}',
        kind: _kind(j['kind']),
        amountPaise: _i(j['amountPaise']),
        at: DateTime.fromMillisecondsSinceEpoch(_i(j['at'])),
        label: '${j['label'] ?? ''}',
      );

  final String id;
  final LedgerKind kind;

  /// Signed: negative is money out.
  final int amountPaise;
  final DateTime at;
  final String label;
}

/// `GET /api/hf/app/wallet`.
class WalletSnapshot {
  const WalletSnapshot({
    required this.balancePaise,
    required this.testCreditPaise,
    required this.heldPaise,
    required this.ledger,
    required this.nextCursor,
  });

  factory WalletSnapshot.fromJson(Map<String, dynamic> j) {
    final rows = j['ledger'];
    return WalletSnapshot(
      balancePaise: _i(j['balancePaise']),
      testCreditPaise: _i(j['testCreditPaise']),
      heldPaise: _i(j['heldPaise']),
      ledger: rows is List ? [for (final r in rows) if (r is Map<String, dynamic>) LedgerEntry.fromJson(r)] : const [],
      nextCursor: j['nextCursor'] is String ? j['nextCursor'] as String : null,
    );
  }

  /// Money you can spend and withdraw (test credits are not in here).
  final int balancePaise;

  /// Spendable on calls, never withdrawable.
  final int testCreditPaise;

  /// Set aside for a call or booking in progress.
  final int heldPaise;
  final List<LedgerEntry> ledger;
  final String? nextCursor;

  WalletSnapshot appended(WalletSnapshot more) => WalletSnapshot(
        balancePaise: more.balancePaise,
        testCreditPaise: more.testCreditPaise,
        heldPaise: more.heldPaise,
        ledger: [...ledger, ...more.ledger],
        nextCursor: more.nextCursor,
      );
}

/// `POST /api/hf/wallet/topup`: the order the server made for this top-up.
class TopupOrder {
  const TopupOrder({
    required this.orderId,
    required this.amountPaise,
    required this.creditPaise,
    required this.gstPaise,
    required this.checkoutUrl,
    required this.paymentSessionId,
    required this.environment,
  });

  factory TopupOrder.fromJson(Map<String, dynamic> j) => TopupOrder(
        orderId: '${j['orderId'] ?? j['topupId'] ?? ''}',
        amountPaise: _i(j['amountPaise']),
        creditPaise: _i(j['creditPaise']),
        gstPaise: _i(j['gstPaise']),
        checkoutUrl: j['checkoutUrl'] is String ? j['checkoutUrl'] as String : null,
        paymentSessionId: j['paymentSessionId'] is String ? j['paymentSessionId'] as String : null,
        environment: '${j['environment'] ?? 'production'}',
      );

  final String orderId;
  final int amountPaise;

  /// What reaches the wallet (paid divided by 1.18, rounded down to the paisa).
  final int creditPaise;
  final int gstPaise;

  /// The hosted payment page to open, when the server gave one.
  final String? checkoutUrl;
  final String? paymentSessionId;
  final String environment;
}

enum TopupState { pending, paid, failed }

/// `GET /api/hf/wallet/topup/:id`.
class TopupStatus {
  const TopupStatus({required this.state, required this.creditPaise});

  factory TopupStatus.fromJson(Map<String, dynamic> j) {
    final s = j['state'];
    return TopupStatus(
      state: s == 'paid'
          ? TopupState.paid
          : s == 'failed'
              ? TopupState.failed
              : TopupState.pending,
      creditPaise: j['creditPaise'] is num ? (j['creditPaise'] as num).round() : null,
    );
  }

  final TopupState state;
  final int? creditPaise;
}
