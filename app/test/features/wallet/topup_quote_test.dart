import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/core/money_currency.dart';
import 'package:avatok_call/core/topup_quote.dart';

void main() {
  test('parses server minor units and preserves server Token amounts', () {
    final quote = TopupQuote.fromJson({
      'quote_id': 'q-1',
      'currency': 'EUR',
      'currency_exponent': 2,
      'expires_at': DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch,
      'min_amount_minor': 100,
      'max_amount_minor': 50000,
      'presets': [{'amount_minor': 1000, 'tokens': 123}],
    });
    expect(quote.id, 'q-1');
    expect(quote.presets.single.tokens, 123);
    expect(quote.currency.formatMinor(12345), '€123.45');
  });

  test('rejects incomplete quotes instead of enabling fallback pricing', () {
    expect(() => TopupQuote.fromJson({}), throwsA(isA<TopupQuoteException>()));
  });

  test('expiry is explicit and minor-unit formatting is generic', () {
    final currency = MoneyCurrency.fromCode('JPY');
    expect(currency.formatMinor(1234), '¥1,234');
    final quote = TopupQuote.fromJson({
      'quote_id': 'expired', 'currency': 'USD', 'expires_at': 1,
      'min_amount_minor': 100, 'max_amount_minor': 1000, 'presets': [],
    });
    expect(quote.isExpired(DateTime.fromMillisecondsSinceEpoch(1000)), isTrue);
  });
}
