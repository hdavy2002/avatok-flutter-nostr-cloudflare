import 'package:flutter_test/flutter_test.dart';

import '../lib/core/listings_api.dart';

void main() {
  group('ListingFeeQuote', () {
    test('reads the planned free-slot response', () {
      final quote = ListingFeeQuote.fromJson({
        'listing_id': 'draft-123',
        'amount': 0,
        'source': 'free',
        'fee_enabled': true,
        'free_used': 2,
        'free_remaining': 3,
        'funding_policy': 'paid_only',
        'period': 1,
        'period_days': 30,
        'expires_at': 1770000000000,
      });

      expect(quote.isFree, isTrue);
      expect(quote.insufficient, isFalse);
      expect(quote.freeRemaining, 3);
      expect(quote.period, 1);
      expect(quote.periodDays, 30);
    });

    test('reads the actual paid-only backend shape without treating period as days', () {
      final quote = ListingFeeQuote.fromJson({
        'listing_id': 'draft-123',
        'fee_enabled': true,
        'source': 'paid',
        'amount': 100,
        'free_used': 5,
        'free_remaining': 0,
        'funding_policy': 'paid_only',
        'period': 2,
        'paid_balance': 40,
        'expires_at': 1770000000000,
        'reason': 'insufficient_tokens',
      });

      expect(quote.amount, 100);
      expect(quote.source, 'paid');
      expect(quote.balance, 40);
      expect(quote.period, 2);
      expect(quote.periodDays, 30);
      expect(quote.insufficient, isTrue);
      expect(quote.isFree, isFalse);
    });
  });
}
