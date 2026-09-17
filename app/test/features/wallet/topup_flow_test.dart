import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/core/money_api.dart';
import 'package:avatok_call/core/money_currency.dart';
import 'package:avatok_call/core/topup_quote.dart';

void main() {
  tearDown(() => MoneyApi.debugTopupQuoteOverride = null);

  test('quote failure is observable and cannot silently select a currency', () async {
    MoneyApi.debugTopupQuoteOverride = () async {
      throw const TopupQuoteException('unavailable');
    };
    expect(MoneyApi.topupQuote(), throwsA(isA<TopupQuoteException>()));
  });

  test('typed quote override supplies immutable checkout identity', () async {
    final expires = DateTime.now().add(const Duration(minutes: 2));
    MoneyApi.debugTopupQuoteOverride = () async => TopupQuote(
      id: 'quote-42',
      currency: MoneyCurrencyForTest.usd,
      expiresAt: expires,
      minAmountMinor: 100,
      maxAmountMinor: 10000,
      presets: const [],
    );
    final quote = await MoneyApi.topupQuote();
    expect(quote.id, 'quote-42');
    expect(quote.isExpired(), isFalse);
  });
}

// Keeps the test readable without introducing a second pricing abstraction.
class MoneyCurrencyForTest {
  static final usd = MoneyCurrency.fromCode('USD');
}
