import 'money_currency.dart';

class TopupQuoteException implements Exception {
  const TopupQuoteException(this.message);
  final String message;
  @override
  String toString() => message;
}

class TopupPreset {
  const TopupPreset({required this.amountMinor, required this.tokens});
  final int amountMinor;
  final int tokens;

  factory TopupPreset.fromJson(Map<String, dynamic> json) {
    final amount = (json['amount_minor'] as num?)?.toInt();
    final tokens = (json['tokens'] ?? json['token_amount'] ?? json['coins']) as num?;
    if (amount == null || tokens == null || amount <= 0 || tokens.toInt() <= 0) {
      throw const TopupQuoteException('Top-up quote contains an invalid preset.');
    }
    return TopupPreset(amountMinor: amount, tokens: tokens.toInt());
  }
}

/// Immutable server quote. Token amounts are accepted only as values returned
/// by the server; no FX or Token arithmetic belongs in the Flutter client.
class TopupQuote {
  const TopupQuote({
    required this.id,
    required this.currency,
    required this.expiresAt,
    required this.minAmountMinor,
    required this.maxAmountMinor,
    required this.presets,
    this.snapshot,
  });

  final String id;
  final MoneyCurrency currency;
  final DateTime expiresAt;
  final int minAmountMinor;
  final int maxAmountMinor;
  final List<TopupPreset> presets;
  final Map<String, dynamic>? snapshot;

  bool isExpired([DateTime? now]) => !expiresAt.isAfter(now ?? DateTime.now());
  bool expiresSoon([DateTime? now]) => expiresAt.difference(now ?? DateTime.now()) <= const Duration(seconds: 30);
  bool accepts(int amountMinor) => amountMinor >= minAmountMinor && amountMinor <= maxAmountMinor && !isExpired();

  factory TopupQuote.fromJson(Map<String, dynamic> json) {
    final id = '${json['quote_id'] ?? json['id'] ?? ''}'.trim();
    final code = '${json['currency'] ?? ''}'.trim();
    final expiresRaw = json['expires_at'] ?? json['expiresAt'];
    final expiresNumber = expiresRaw is num ? expiresRaw.toInt() : int.tryParse('$expiresRaw');
    final expires = expiresNumber == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(expiresNumber < 100000000000 ? expiresNumber * 1000 : expiresNumber);
    final min = (json['min_amount_minor'] as num?)?.toInt();
    final max = (json['max_amount_minor'] as num?)?.toInt();
    final exponent = (json['currency_exponent'] as num?)?.toInt();
    final rawPresets = json['presets'];
    if (id.isEmpty || code.isEmpty || expires == null || min == null || max == null || rawPresets is! List) {
      throw const TopupQuoteException('Top-up quote is incomplete.');
    }
    final presets = rawPresets.map((e) => TopupPreset.fromJson((e as Map).cast<String, dynamic>())).toList(growable: false);
    return TopupQuote(
      id: id,
      currency: MoneyCurrency.fromCode(code, exponent: exponent),
      expiresAt: expires,
      minAmountMinor: min,
      maxAmountMinor: max,
      presets: presets,
      snapshot: Map<String, dynamic>.from(json),
    );
  }
}
