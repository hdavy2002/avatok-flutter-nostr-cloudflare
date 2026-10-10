import '../../../core/format/money.dart';

// Typed views of the wallet routes (worker/src/routes/hf_calls.ts, hf_refunds.ts, hf_wallet_limits.ts,
// hf_tokens_play.ts). The server sends token amounts as 2-decimal strings plus integer micro-tokens, and
// rupee amounts as integers or numbers it already computed. The phone only DISPLAYS them: no balance,
// price or value is computed here.

int _int(Object? v, [int fallback = 0]) {
  if (v is num) return v.toInt();
  return int.tryParse('$v') ?? fallback;
}

num? _num(Object? v) {
  if (v is num) return v;
  return num.tryParse('$v');
}

String? _str(Object? v) {
  if (v == null) return null;
  final s = '$v';
  return s.isEmpty ? null : s;
}

List<Map<String, dynamic>> _maps(Object? v) {
  if (v is! List) return const <Map<String, dynamic>>[];
  return [
    for (final e in v)
      if (e is Map) Map<String, dynamic>.from(e),
  ];
}

DateTime? _date(Object? v) {
  final ms = _num(v);
  return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms.toInt());
}

/// "100 tokens", "45.20 tokens": whole amounts drop the decimals. Display only.
String tokensPlain(num tokens) {
  final text = Money.tokens(tokens);
  final plain = text.endsWith('.00') ? text.substring(0, text.length - 3) : text;
  return plain == '1' ? '1 token' : '$plain tokens';
}

/// One line of the balance breakdown: `45.20 tokens worth ₹0.82 each`.
class ByValue {
  const ByValue({required this.valuePaisePerToken, required this.micro});

  final int valuePaisePerToken;
  final int micro;

  factory ByValue.fromJson(Map<String, dynamic> j) {
    final micro = j['micro'] != null ? _int(j['micro']) : (((_num(j['tokens']) ?? 0) * 1000000).round());
    return ByValue(valuePaisePerToken: _int(j['valuePaisePerToken']), micro: micro);
  }
}

class TokenDebt {
  const TokenDebt({required this.tokensText, required this.valuePaise, required this.open});

  final String tokensText;
  final int valuePaise;
  final bool open;

  static const TokenDebt none = TokenDebt(tokensText: '0.00', valuePaise: 0, open: false);

  factory TokenDebt.fromJson(Object? v) {
    if (v is! Map) return none;
    final j = Map<String, dynamic>.from(v);
    final micro = _int(j['micro']);
    final paise = _int(j['valuePaise']);
    final text = j['micro'] != null ? Money.microTokens(micro) : (_str(j['tokens']) ?? '0.00');
    return TokenDebt(tokensText: text, valuePaise: paise, open: j['open'] == true || paise > 0 || micro > 0);
  }
}

class WalletLimits {
  const WalletLimits({
    required this.daily,
    required this.monthly,
    required this.spentToday,
    required this.spentThisMonth,
    this.paidTokensBasis = false,
  });

  final num daily;
  final num monthly;
  final num spentToday;
  final num spentThisMonth;

  /// True when the server counts rupees paid for tokens (`basis: paid_for_tokens`).
  final bool paidTokensBasis;

  static WalletLimits? fromJson(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    if (j['daily'] == null && j['monthly'] == null) return null;
    return WalletLimits(
      daily: _num(j['daily']) ?? 0,
      monthly: _num(j['monthly']) ?? 0,
      spentToday: _num(j['spentToday']) ?? 0,
      spentThisMonth: _num(j['spentThisMonth']) ?? 0,
      paidTokensBasis: j['basis'] == 'paid_for_tokens',
    );
  }
}

/// One history line. Token mode carries [tokens] (`+100.00`, `-3.20`); old money carries [rupees].
class HistoryItem {
  const HistoryItem({required this.at, required this.kind, required this.label, this.tokens, this.rupees, this.callId});

  final DateTime? at;
  final String kind;
  final String label;
  final String? tokens;
  final num? rupees;
  final String? callId;

  /// Shown on the right: `+100.00 tokens`, `-3.20 tokens`, `-₹40`.
  String get amountText {
    final t = tokens;
    if (t != null) return '$t tokens';
    final r = rupees;
    if (r == null) return '';
    return '${r > 0 ? '+' : ''}${Money.rupees(r)}';
  }

  factory HistoryItem.fromJson(Map<String, dynamic> j) => HistoryItem(
        at: _date(j['at']),
        kind: _str(j['kind']) ?? '',
        label: _str(j['label']) ?? '',
        tokens: _str(j['tokens']),
        rupees: _num(j['rupees']),
        callId: _str(j['callId']),
      );
}

/// A Google Play purchase record. The server's `purchases[]` (when present) carries the order id; until
/// then the records are built from history lines of kind `purchase` (no order id).
class PurchaseRecord {
  const PurchaseRecord({this.orderId, required this.label, this.tokens, this.paidPaise, this.at, this.state});

  final String? orderId;
  final String label;
  final String? tokens;
  final int? paidPaise;
  final DateTime? at;
  final String? state;

  factory PurchaseRecord.fromJson(Map<String, dynamic> j) {
    final t = _num(j['tokens']);
    return PurchaseRecord(
      orderId: _str(j['orderId']),
      label: 'Paid via Google Play',
      tokens: t == null ? _str(j['tokens']) : tokensPlain(t),
      paidPaise: j['paidPaise'] == null ? null : _int(j['paidPaise']),
      at: _date(j['at']),
      state: _str(j['state']),
    );
  }
}

/// `GET /api/hf/wallet`. Two shapes, both render: token mode (`mode: "tokens"`) and the old rupee shape.
class WalletData {
  const WalletData({
    required this.tokenMode,
    required this.history,
    required this.purchases,
    this.limits,
    this.balanceText = '0.00',
    this.availableText = '0.00',
    this.availableMicro = 0,
    this.balanceMicro = 0,
    this.testTokensText = '0.00',
    this.byValue = const <ByValue>[],
    this.debt = TokenDebt.none,
    this.paidBalance = 0,
    this.testBalance = 0,
    this.spendable = 0,
  });

  final bool tokenMode;

  // token mode
  final String balanceText;
  final String availableText;
  final int balanceMicro;
  final int availableMicro;
  final String testTokensText;
  final List<ByValue> byValue;
  final TokenDebt debt;

  // old rupee shape
  final num paidBalance;
  final num testBalance;
  final num spendable;

  final WalletLimits? limits;
  final List<HistoryItem> history;
  final List<PurchaseRecord> purchases;

  bool get hasDebt => debt.open;

  /// More tokens in the balance than free to spend (some are held for a call in progress).
  bool get hasReserved => availableMicro < balanceMicro;

  /// True when there are test tokens (spend-only). Compared, never added up.
  bool get hasTestTokens {
    final n = num.tryParse(testTokensText.replaceAll(',', ''));
    return n != null && n > 0;
  }

  factory WalletData.fromJson(Map<String, dynamic> j) {
    final history = [for (final m in _maps(j['history'])) HistoryItem.fromJson(m)];
    final limits = WalletLimits.fromJson(j['limits']);
    var purchases = [for (final m in _maps(j['purchases'])) PurchaseRecord.fromJson(m)];
    if (purchases.isEmpty) {
      // Until the server sends purchases[] (order ids), the token history says which lines were purchases.
      purchases = [
        for (final h in history)
          if (h.kind == 'purchase')
            PurchaseRecord(label: 'Paid via Google Play', tokens: h.tokens?.replaceFirst('+', ''), at: h.at),
      ];
    }
    if (j['mode'] == 'tokens' && j['tokens'] is Map) {
      final t = Map<String, dynamic>.from(j['tokens'] as Map);
      final balanceMicro = _int(t['balanceMicro']);
      final availableMicro = t['availableMicro'] == null ? balanceMicro : _int(t['availableMicro']);
      return WalletData(
        tokenMode: true,
        balanceMicro: balanceMicro,
        availableMicro: availableMicro,
        balanceText: t['balanceMicro'] != null ? Money.microTokens(balanceMicro) : (_str(t['balance']) ?? '0.00'),
        availableText: t['availableMicro'] != null ? Money.microTokens(availableMicro) : (_str(t['available']) ?? '0.00'),
        testTokensText: _str(t['testTokens']) ?? '0.00',
        byValue: [for (final m in _maps(t['byValue'])) ByValue.fromJson(m)],
        debt: TokenDebt.fromJson(t['debt']),
        limits: limits,
        history: history,
        purchases: purchases,
      );
    }
    return WalletData(
      tokenMode: false,
      paidBalance: _num(j['paidBalance']) ?? 0,
      testBalance: _num(j['testBalance']) ?? 0,
      spendable: _num(j['spendable']) ?? 0,
      limits: limits,
      history: history,
      purchases: const <PurchaseRecord>[],
    );
  }
}

/// A token pack from `GET /api/hf/tokens/products`. There is NO price here on purpose: the price beside a
/// Play button is Play's own `ProductDetails.price`.
class TokenPack {
  const TokenPack({required this.productId, required this.tokens, this.redemptionPaisePerToken, this.purchasePaisePerToken});

  final String productId;
  final num tokens;

  /// What each token is worth in call time (paise). Shown as "worth ₹0.82 each".
  final int? redemptionPaisePerToken;

  /// The catalogue price per token (paise). Only a fallback to decide "Are you sure?" when Play's price
  /// is not in rupees. Never shown.
  final int? purchasePaisePerToken;

  factory TokenPack.fromJson(Map<String, dynamic> j) => TokenPack(
        productId: _str(j['productId']) ?? '',
        tokens: _num(j['tokens']) ?? 0,
        redemptionPaisePerToken: j['redemptionPaisePerToken'] == null ? null : _int(j['redemptionPaisePerToken']),
        purchasePaisePerToken: j['purchasePaisePerToken'] == null ? null : _int(j['purchasePaisePerToken']),
      );
}

class TokenCatalog {
  const TokenCatalog({required this.enabled, required this.packs});

  final bool enabled;
  final List<TokenPack> packs;

  factory TokenCatalog.fromJson(Map<String, dynamic> j) => TokenCatalog(
        enabled: j['enabled'] == true,
        packs: [
          for (final m in _maps(j['products']))
            if (_str(m['productId']) != null) TokenPack.fromJson(m),
        ],
      );
}

/// `POST /api/hf/tokens/play/prepare` answer.
class PreparedPurchase {
  const PreparedPurchase({required this.obfuscatedAccountId, required this.confirmAbovePaise, required this.productId});

  final String obfuscatedAccountId;
  final int confirmAbovePaise;
  final String productId;

  factory PreparedPurchase.fromJson(Map<String, dynamic> j, String productId) => PreparedPurchase(
        obfuscatedAccountId: _str(j['obfuscatedAccountId']) ?? '',
        confirmAbovePaise: _int(j['confirmAbovePaise']),
        productId: productId,
      );
}

enum VerifyStatus { consumed, credited, pending, canceled, refunded, unknown }

/// `POST /api/hf/tokens/play/verify` answer.
class VerifyResult {
  const VerifyResult({required this.status, required this.duplicate, this.tokens, this.orderId});

  final VerifyStatus status;
  final bool duplicate;
  final num? tokens;
  final String? orderId;

  /// Tokens were credited (now or earlier): `consumed` and `credited` are both success.
  bool get isCredited => status == VerifyStatus.consumed || status == VerifyStatus.credited;

  factory VerifyResult.fromJson(Map<String, dynamic> j) {
    final VerifyStatus s;
    switch ('${j['status']}') {
      case 'consumed':
        s = VerifyStatus.consumed;
      case 'credited':
        s = VerifyStatus.credited;
      case 'pending':
        s = VerifyStatus.pending;
      case 'canceled':
      case 'cancelled':
        s = VerifyStatus.canceled;
      case 'refunded':
        s = VerifyStatus.refunded;
      default:
        s = VerifyStatus.unknown;
    }
    return VerifyResult(status: s, duplicate: j['duplicate'] == true, tokens: _num(j['tokens']), orderId: _str(j['orderId']));
  }
}

/// A purchase lot that can be refunded (token mode): the unspent share of one Play purchase.
class RefundLot {
  const RefundLot({
    required this.lotId,
    required this.tokens,
    required this.paidRupees,
    required this.refundRupees,
    required this.wholeOrder,
    this.boughtAt,
  });

  final String lotId;
  final String tokens;
  final num paidRupees;
  final num refundRupees;
  final bool wholeOrder;
  final DateTime? boughtAt;

  factory RefundLot.fromJson(Map<String, dynamic> j) => RefundLot(
        lotId: _str(j['lotId']) ?? '',
        tokens: _str(j['tokens']) ?? '0.00',
        paidRupees: _num(j['paid']) ?? 0,
        refundRupees: _num(j['refund']) ?? 0,
        wholeOrder: j['wholeOrder'] == true,
        boughtAt: _date(j['boughtAt']),
      );
}

class RefundRequest {
  const RefundRequest({required this.id, required this.amountRupees, required this.status, this.reason, this.createdAt});

  final String id;
  final num amountRupees;
  final String status;
  final String? reason;
  final DateTime? createdAt;

  bool get canCancel => status == 'requested';

  /// Plain English for the status a person sees.
  String get statusText {
    switch (status) {
      case 'requested':
        return 'Waiting for review';
      case 'processing':
        return 'Being processed';
      case 'refunded':
        return 'Refunded';
      case 'rejected':
        return 'Not approved';
      case 'cancelled':
        return 'Cancelled';
      default:
        return status;
    }
  }

  factory RefundRequest.fromJson(Map<String, dynamic> j) => RefundRequest(
        id: _str(j['id']) ?? '',
        amountRupees: _num(j['amount']) ?? 0,
        status: _str(j['status']) ?? '',
        reason: _str(j['reason']),
        createdAt: _date(j['createdAt']),
      );
}

/// `GET /api/hf/wallet/refunds`.
class RefundsInfo {
  const RefundsInfo({
    required this.enabled,
    required this.tokenMode,
    required this.windowDays,
    required this.lots,
    required this.requests,
    this.refundableRupees = 0,
  });

  final bool enabled;
  final bool tokenMode;
  final int windowDays;
  final List<RefundLot> lots;
  final List<RefundRequest> requests;

  /// Old rupee money only: how much unused top-up money can go back.
  final num refundableRupees;

  static const RefundsInfo off =
      RefundsInfo(enabled: false, tokenMode: false, windowDays: 180, lots: <RefundLot>[], requests: <RefundRequest>[]);

  factory RefundsInfo.fromJson(Map<String, dynamic> j) => RefundsInfo(
        enabled: j['enabled'] == true,
        tokenMode: j['mode'] == 'tokens',
        refundableRupees: _num(j['refundable']) ?? 0,
        windowDays: j['windowDays'] == null ? 180 : _int(j['windowDays'], 180),
        lots: [for (final m in _maps(j['lots'])) RefundLot.fromJson(m)],
        requests: [for (final m in _maps(j['requests'])) RefundRequest.fromJson(m)],
      );
}

/// One receipt of old rupee money (`GET /api/hf/wallet/receipts`).
class WalletReceipt {
  const WalletReceipt({required this.id, required this.number, required this.amountRupees, this.issuedAt});

  final String id;
  final String number;
  final num amountRupees;
  final DateTime? issuedAt;

  factory WalletReceipt.fromJson(Map<String, dynamic> j) => WalletReceipt(
        id: _str(j['id']) ?? '',
        number: _str(j['number']) ?? '',
        amountRupees: _num(j['amountRupees']) ?? 0,
        issuedAt: _date(j['issuedAt']),
      );
}

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// `10 Oct 2026`. Local time. Display only.
String shortDate(DateTime? d) {
  if (d == null) return '';
  return '${d.day} ${_months[d.month - 1]} ${d.year}';
}
