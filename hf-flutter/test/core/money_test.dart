import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/format/money.dart';
import 'package:hf_app/core/update/update_check.dart';

void main() {
  group('paise to rupees', () {
    test('whole and fractional', () {
      expect(Money.paise(0), '₹0');
      expect(Money.paise(1200), '₹12');
      expect(Money.paise(1250), '₹12.50');
      expect(Money.paise(5), '₹0.05');
    });
    test('Indian grouping', () {
      expect(Money.paise(99900), '₹999');
      expect(Money.paise(100000), '₹1,000');
      expect(Money.paise(12345600), '₹1,23,456');
      expect(Money.paise(123456700), '₹12,34,567');
    });
    test('negative', () => expect(Money.paise(-500), '-₹5'));
    test('server rupee numbers', () {
      expect(Money.rupees(12.5), '₹12.50');
      expect(Money.rupees(40), '₹40');
    });
  });

  group('tokens', () {
    test('micro-tokens show two decimals, rounded half up', () {
      expect(Money.microTokens(45200000), '45.20');
      expect(Money.microTokens(999999), '1.00');
      expect(Money.microTokens(5000), '0.01');
      expect(Money.microTokens(4999), '0.00');
      expect(Money.microTokens(0), '0.00');
    });
    test('a value that rounds to zero has no minus', () => expect(Money.microTokens(-4000), '0.00'));
    test('negative', () => expect(Money.microTokens(-1500000), '-1.50'));
    test('grouping', () => expect(Money.microTokens(1234567000000), '12,34,567.00'));
    test('unit word follows the shown number', () {
      expect(Money.tokensWithUnit(1), '1.00 token');
      expect(Money.tokensWithUnit(3), '3.00 tokens');
      expect(Money.tokensWithUnit(0.5), '0.50 tokens');
    });
  });

  group('time', () {
    test('call clock', () {
      expect(Money.clock(0), '00:00');
      expect(Money.clock(65), '01:05');
      expect(Money.clock(3725), '1:02:05');
      expect(Money.clock(-3), '00:00');
    });
    test('duration words', () {
      expect(Money.duration(40), '40 s');
      expect(Money.duration(600), '10 min');
      expect(Money.duration(65), '1 min 5 s');
    });
  });

  group('update status', () {
    test('unknown installed build never nags', () {
      expect(updateStatusFor(installed: 0, latest: 9, min: 9), UpdateStatus.none);
    });
    test('zero means never prompt', () {
      expect(updateStatusFor(installed: 5, latest: 0, min: 0), UpdateStatus.none);
    });
    test('soft and forced', () {
      expect(updateStatusFor(installed: 5, latest: 7, min: 0), UpdateStatus.soft);
      expect(updateStatusFor(installed: 5, latest: 7, min: 6), UpdateStatus.forced);
      expect(updateStatusFor(installed: 7, latest: 7, min: 6), UpdateStatus.none);
    });
  });
}
