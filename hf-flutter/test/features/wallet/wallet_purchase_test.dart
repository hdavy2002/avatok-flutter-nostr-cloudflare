import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/features/wallet/billing/billing_adapter.dart';
import 'package:hf_app/features/wallet/wallet_providers.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_billing.dart';
import 'wallet_support.dart';

void main() {
  late FakeBillingAdapter billing;
  late FakeApiClient api;

  setUp(() {
    billing = FakeBillingAdapter();
    api = walletApi();
  });

  Future<void> buy100(WidgetTester tester) async {
    await tester.tap(buyButton('hf_tokens_100'));
    await tester.pumpAndSettle();
  }

  group('buying tokens', () {
    testWidgets('purchased -> verify -> "100 tokens added" and the balance is refreshed', (tester) async {
      var balanceReads = 0;
      api.on('GET', '/api/hf/wallet', (_) {
        balanceReads++;
        return balanceReads == 1
            ? tokenWallet(balance: '0.00', balanceMicro: 0)
            : tokenWallet(balance: '100.00', balanceMicro: 100000000);
      });
      billing.answerWith(StorePurchaseStatus.purchased, token: 'tok-abc');
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('0.00 tokens'), findsOneWidget);

      await buy100(tester);

      // prepare first, then the Play sheet with the server's account id, then verify with the token.
      final prepare = api.callsTo('POST', '/api/hf/tokens/play/prepare');
      expect(prepare, hasLength(1));
      expect((prepare.single.body as Map)['productId'], 'hf_tokens_100');
      expect(billing.boughtProductIds, ['hf_tokens_100']);
      expect(billing.accountIdsSent, ['acct_hash_1']);
      final verify = api.callsTo('POST', '/api/hf/tokens/play/verify');
      expect(verify, hasLength(1));
      expect(verify.single.body, {'productId': 'hf_tokens_100', 'purchaseToken': 'tok-abc'});

      expect(find.text('100 tokens added'), findsOneWidget);
      expect(balanceReads, 2, reason: 'the wallet is read again after the credit');
      expect(find.text('100.00 tokens'), findsOneWidget);
    });

    testWidgets('the price on the button is Play\'s own string, not a number from our server', (tester) async {
      billing.products = {
        'hf_tokens_100': const StoreProduct(
            productId: 'hf_tokens_100', priceText: 'Rs 99.99 (from Play)', currencyCode: 'INR', priceMicros: 99990000),
        'hf_tokens_1000': const StoreProduct(
            productId: 'hf_tokens_1000', priceText: 'Rs 999.99 (from Play)', currencyCode: 'INR', priceMicros: 999990000),
      };
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Buy for Rs 99.99 (from Play)'), findsOneWidget);
      expect(find.text('Buy for Rs 999.99 (from Play)'), findsOneWidget);
      expect(find.text('Each token worth ₹0.82 of call time'), findsNWidgets(2));
    });

    testWidgets('a pack Play does not know is shown as not available and cannot be bought', (tester) async {
      billing.products = {billing.products.entries.first.key: billing.products.entries.first.value}; // only the 100 pack
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Not available'), findsOneWidget);
      final b = tester.widget<ElevatedButton>(find.descendant(of: buyButton('hf_tokens_1000'), matching: find.byType(ElevatedButton)));
      expect(b.onPressed, isNull);
    });

    testWidgets('the buy button is at least 48 dp tall', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      expect(tester.getSize(buyButton('hf_tokens_100')).height, greaterThanOrEqualTo(48));
    });

    testWidgets('duplicate: the same purchase again says it was already added', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', verifyAnswer(duplicate: true));
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('These tokens were already added to your wallet.'), findsOneWidget);
      expect(find.text('100 tokens added'), findsNothing);
    });

    testWidgets('a "credited" answer (server not yet consumed) is also success', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', verifyAnswer(status: 'credited'));
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('100 tokens added'), findsOneWidget);
    });

    testWidgets('pending: tells the buyer tokens come when Google confirms, and adds nothing', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', {'ok': true, 'status': 'pending', 'orderId': 'GPA.2', 'balance': {}});
      billing.answerWith(StorePurchaseStatus.pending, token: 'tok-pending');
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text("Payment pending. We'll add your tokens when Google confirms it."), findsOneWidget);
      expect(find.text('100 tokens added'), findsNothing);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify').single.body, containsPair('purchaseToken', 'tok-pending'));
    });

    testWidgets('cancelled in the Play sheet: a quiet note, no verify', (tester) async {
      billing.answerWith(StorePurchaseStatus.canceled);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('Purchase cancelled. You were not charged.'), findsOneWidget);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), isEmpty);
    });

    testWidgets('a Play error shows a simple message', (tester) async {
      billing.answerWith(StorePurchaseStatus.error);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('Google Play could not complete this purchase. Please try again.'), findsOneWidget);
    });

    testWidgets('the Play sheet failing to open shows a message', (tester) async {
      billing.opens = false;
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('Google Play could not open. Please try again.'), findsOneWidget);
    });

    testWidgets('limit: the server message is shown and Play is never opened', (tester) async {
      api.onError(
        'POST',
        '/api/hf/tokens/play/prepare',
        const ApiError(
          status: 403,
          code: 'limit',
          message: "You've reached today's limit of Rs 2,000. It resets at midnight.",
          extra: {'binding': 'day'},
        ),
      );
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text("You've reached today's limit of Rs 2,000. It resets at midnight."), findsOneWidget);
      expect(billing.boughtProductIds, isEmpty);
    });

    testWidgets('prepare off (503 disabled): "not available right now"', (tester) async {
      api.onError('POST', '/api/hf/tokens/play/prepare', const ApiError(status: 503, code: 'disabled', message: 'Token purchases are not available right now.'));
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('Buying tokens is not available right now. Please try again soon.'), findsOneWidget);
      expect(billing.boughtProductIds, isEmpty);
    });

    testWidgets('no internet while preparing shows the offline message', (tester) async {
      api.onError('POST', '/api/hf/tokens/play/prepare', ApiError.network());
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });

    testWidgets('verify cannot be reached: "still confirming", and the purchase is NOT consumed or completed', (tester) async {
      api.onError('POST', '/api/hf/tokens/play/verify', const ApiError(status: 503, code: 'unavailable', extra: {'retry': true}));
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.textContaining("We're still confirming your payment"), findsOneWidget);
      expect(find.text('100 tokens added'), findsNothing);
    });

    testWidgets('verify refuses the purchase (account mismatch): a clear message', (tester) async {
      api.onError('POST', '/api/hf/tokens/play/verify', const ApiError(status: 403, code: 'account_mismatch', message: 'x'));
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('This purchase was made with a different account, so we cannot add it here.'), findsOneWidget);
    });

    testWidgets('canceled and refunded answers add nothing', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', {'ok': true, 'status': 'refunded', 'orderId': 'GPA.3', 'balance': {}});
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('Google refunded this payment, so no tokens were added.'), findsOneWidget);
    });

    testWidgets('the notice can be dismissed', (tester) async {
      billing.answerWith(StorePurchaseStatus.canceled);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.byKey(const ValueKey<String>('purchase-notice')), findsOneWidget);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey<String>('purchase-notice')), findsNothing);
    });
  });

  group('Are you sure?', () {
    Future<void> buy1000(WidgetTester tester) async {
      await tester.tap(buyButton('hf_tokens_1000'));
      // Not pumpAndSettle: "Getting ready" shows a spinner while the question is open, and it never settles.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    testWidgets('a pack at or above the server threshold asks first; Yes buys', (tester) async {
      billing.answerWith(StorePurchaseStatus.purchased);
      api.onJson('POST', '/api/hf/tokens/play/verify', verifyAnswer(tokens: 1000));
      await pumpWallet(tester, api: api, billing: billing);
      await buy1000(tester);
      expect(find.text('Are you sure?'), findsOneWidget);
      expect(find.textContaining('₹1,000.00'), findsWidgets); // Play's price string is in the question
      expect(billing.boughtProductIds, isEmpty, reason: 'nothing opens before the answer');
      await tester.tap(find.text('Yes, buy'));
      await tester.pumpAndSettle();
      expect(billing.boughtProductIds, ['hf_tokens_1000']);
      expect(find.text('1,000 tokens added'), findsOneWidget);
    });

    testWidgets('No stops it: Play never opens', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      await buy1000(tester);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(billing.boughtProductIds, isEmpty);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), isEmpty);
    });

    testWidgets('a smaller pack buys straight away', (tester) async {
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('Are you sure?'), findsNothing);
      expect(billing.boughtProductIds, ['hf_tokens_100']);
    });
  });

  group('recovery', () {
    testWidgets('an unfinished purchase is verified when the Wallet opens', (tester) async {
      billing.unfinished.add(const StorePurchase(
        productId: 'hf_tokens_100',
        purchaseToken: 'tok-old',
        status: StorePurchaseStatus.purchased,
        orderId: 'GPA.9',
      ));
      await pumpWallet(tester, api: api, billing: billing);
      final verify = api.callsTo('POST', '/api/hf/tokens/play/verify');
      expect(verify, hasLength(1));
      expect(verify.single.body, {'productId': 'hf_tokens_100', 'purchaseToken': 'tok-old'});
      expect(billing.recoverCalls, greaterThanOrEqualTo(1));
      expect(find.text('100 tokens added'), findsOneWidget, reason: 'late tokens are news');
    });

    testWidgets('an already-credited unfinished purchase is silent', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', verifyAnswer(duplicate: true));
      billing.unfinished.add(const StorePurchase(
        productId: 'hf_tokens_100',
        purchaseToken: 'tok-old',
        status: StorePurchaseStatus.purchased,
      ));
      await pumpWallet(tester, api: api, billing: billing);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
      expect(find.byKey(const ValueKey<String>('purchase-notice')), findsNothing);
    });

    testWidgets('a pending purchase found on start says so once', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', {'ok': true, 'status': 'pending', 'orderId': 'GPA.2', 'balance': {}});
      billing.unfinished.add(const StorePurchase(
        productId: 'hf_tokens_100',
        purchaseToken: 'tok-pend',
        status: StorePurchaseStatus.pending,
      ));
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text("Payment pending. We'll add your tokens when Google confirms it."), findsOneWidget);
    });

    testWidgets('the same token reported twice is verified once', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      const p = StorePurchase(productId: 'hf_tokens_100', purchaseToken: 'tok-twice', status: StorePurchaseStatus.purchased);
      billing.emit(p);
      billing.emit(p);
      await tester.pumpAndSettle();
      billing.emit(p); // and again after it finished
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
    });

    testWidgets('a purchase the server will never accept is not retried', (tester) async {
      api.onError('POST', '/api/hf/tokens/play/verify', const ApiError(status: 400, code: 'unknown_product', message: 'That token pack is not available.'));
      await pumpWallet(tester, api: api, billing: billing);
      const p = StorePurchase(productId: 'hf_tokens_100', purchaseToken: 'tok-bad', status: StorePurchaseStatus.purchased);
      billing.emit(p);
      await tester.pumpAndSettle();
      billing.emit(p);
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
    });

    test('the recovery provider verifies unfinished purchases once a person is signed in', () async {
      final container = ProviderContainer(
        retry: (_, __) => null,
        overrides: [
          sessionProvider.overrideWith(() => StubSession(signedInState())),
          apiClientProvider.overrideWithValue(api),
          billingAdapterProvider.overrideWithValue(billing),
          purchaseRetryDelaysProvider.overrideWithValue(const <Duration>[]),
        ],
      );
      addTearDown(container.dispose);
      billing.unfinished.add(const StorePurchase(
        productId: 'hf_tokens_100',
        purchaseToken: 'tok-start',
        status: StorePurchaseStatus.purchased,
      ));
      container.listen(purchaseRecoveryProvider, (_, __) {});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(billing.recoverCalls, 1);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
      expect(container.read(purchaseControllerProvider).notice?.message, '100 tokens added');
    });

    test('the recovery provider does nothing for a guest', () async {
      final container = ProviderContainer(
        retry: (_, __) => null,
        overrides: [
          sessionProvider.overrideWith(() => StubSession(signedOutState())),
          apiClientProvider.overrideWithValue(api),
          billingAdapterProvider.overrideWithValue(billing),
        ],
      );
      addTearDown(container.dispose);
      container.listen(purchaseRecoveryProvider, (_, __) {});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(billing.recoverCalls, 0);
      expect(api.calls, isEmpty);
    });
  });
}
