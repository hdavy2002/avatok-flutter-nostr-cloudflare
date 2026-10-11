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
    await selectAndPay(tester, 'hf_tokens_100');
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the pack section says the price shown includes 18% GST (HF-PAY-19)',
    (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Price includes 18% GST.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('gst-subtitle')),
        findsOneWidget,
      );
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey<String>('gst-hf_tokens_100')))
            .data,
        'Total ₹120.00 · GST included ₹18.31 · Added to wallet ₹101.69',
      );
      expect(find.text('Paid via Google Play'), findsWidgets);
    },
  );

  group('adding money', () {
    testWidgets(
      'purchased -> verify -> the rupee breakdown and refreshed balance',
      (tester) async {
        var balanceReads = 0;
        api.on('GET', '/api/hf/wallet', (_) {
          balanceReads++;
          return balanceReads == 1
              ? rupeeWallet(balancePaise: 0, testPaise: 0)
              : rupeeWallet(balancePaise: 10169, testPaise: 0);
        });
        billing.answerWith(StorePurchaseStatus.purchased, token: 'tok-abc');
        await pumpWallet(tester, api: api, billing: billing);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey<String>('balance-total')),
            matching: find.text('₹0.00'),
            matchRoot: true,
          ),
          findsOneWidget,
        );

        await buy100(tester);

        // prepare first, then the Play sheet with the server's account id, then verify with the token.
        final prepare = api.callsTo('POST', '/api/hf/tokens/play/prepare');
        expect(prepare, hasLength(1));
        expect((prepare.single.body as Map)['productId'], 'hf_tokens_100');
        expect(billing.boughtProductIds, ['hf_tokens_100']);
        expect(billing.accountIdsSent, ['acct_hash_1']);
        final verify = api.callsTo('POST', '/api/hf/tokens/play/verify');
        expect(verify, hasLength(1));
        expect(verify.single.body, {
          'productId': 'hf_tokens_100',
          'purchaseToken': 'tok-abc',
        });

        expect(
          find.text(
            '₹101.69 added to your wallet.\nTotal ₹120.00 · GST included ₹18.31 · Added to wallet ₹101.69',
          ),
          findsOneWidget,
        );
        expect(
          balanceReads,
          2,
          reason: 'the wallet is read again after the credit',
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey<String>('balance-total')),
            matching: find.text('₹101.69'),
            matchRoot: true,
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'the price on the button is Play\'s own string, not a number from our server',
      (tester) async {
        billing.products = {
          'hf_tokens_100': const StoreProduct(
            productId: 'hf_tokens_100',
            priceText: 'Rs 99.99 (from Play)',
            currencyCode: 'INR',
            priceMicros: 99990000,
          ),
          'hf_tokens_1000': const StoreProduct(
            productId: 'hf_tokens_1000',
            priceText: 'Rs 999.99 (from Play)',
            currencyCode: 'INR',
            priceMicros: 999990000,
          ),
        };
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('Pay Rs 99.99 (from Play)'), findsOneWidget);
        expect(find.text('Pay Rs 999.99 (from Play)'), findsOneWidget);
        expect(
          find.text(
            'Total ₹99.99 · GST included ₹15.25 · Added to wallet ₹84.74',
          ),
          findsOneWidget,
        );
        expect(
          find.text(
            'Total ₹999.99 · GST included ₹152.54 · Added to wallet ₹847.45',
          ),
          findsOneWidget,
        );
        expect(
          find.text('Pay Rs 99.99 (from Play) with Google Play'),
          findsOneWidget,
        );
        expect(find.textContaining('token'), findsNothing);
      },
    );

    testWidgets(
      'a pack Play does not know is shown as not available and cannot be bought',
      (tester) async {
        billing.products = {
          billing.products.entries.first.key:
              billing.products.entries.first.value,
        }; // only the 100 pack
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('Not available'), findsOneWidget);
        await tester.tap(buyButton('hf_tokens_1000'));
        await tester.pump();
        final b = tester.widget<ElevatedButton>(
          find.descendant(of: payButton, matching: find.byType(ElevatedButton)),
        );
        expect(b.onPressed, isNull);
        expect(billing.boughtProductIds, isEmpty);
      },
    );

    testWidgets('selecting another pack changes the Pay label', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Pay ₹100.00 with Google Play'), findsOneWidget);
      await tester.tap(buyButton('hf_tokens_1000'));
      await tester.pumpAndSettle();
      expect(find.text('Pay ₹1,000.00 with Google Play'), findsOneWidget);
      expect(find.text('Pay ₹100.00 with Google Play'), findsNothing);
    });

    testWidgets('the Popular pack is selected first and wears the badge', (
      tester,
    ) async {
      api.onJson('GET', '/api/hf/tokens/products', {
        'ok': true,
        'enabled': true,
        'products': [
          {'productId': 'hf_tokens_100', 'tokens': 102, 'creditPaise': 10200},
          {'productId': 'hf_tokens_240', 'tokens': 204, 'creditPaise': 20400},
        ],
      });
      billing.products = {
        ...billing.products,
        'hf_tokens_240': const StoreProduct(
          productId: 'hf_tokens_240',
          priceText: '₹240.00',
          currencyCode: 'INR',
          priceMicros: 240000000,
        ),
      };
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        find.byKey(const ValueKey<String>('popular-hf_tokens_240')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey<String>('popular-hf_tokens_100')),
        findsNothing,
      );
      expect(find.text('Pay ₹240.00 with Google Play'), findsOneWidget);
    });

    testWidgets('Pay is disabled while a purchase is pending (no double tap)', (
      tester,
    ) async {
      await pumpWallet(tester, api: api, billing: billing);
      await selectAndPay(tester, 'hf_tokens_100');
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      // The Play sheet is open and has not answered: Pay stays off and the tiles are locked.
      final b = tester.widget<ElevatedButton>(
        find.descendant(of: payButton, matching: find.byType(ElevatedButton)),
      );
      expect(b.onPressed, isNull);
      expect(billing.boughtProductIds, ['hf_tokens_100']);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
    });

    testWidgets('the buy button is at least 48 dp tall', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        tester.getSize(buyButton('hf_tokens_100')).height,
        greaterThanOrEqualTo(48),
      );
    });

    testWidgets(
      'duplicate: the same purchase again says it was already added',
      (tester) async {
        api.onJson(
          'POST',
          '/api/hf/tokens/play/verify',
          verifyAnswer(duplicate: true),
        );
        billing.answerWith(StorePurchaseStatus.purchased);
        await pumpWallet(tester, api: api, billing: billing);
        await buy100(tester);
        expect(
          find.text('This money was already added to your wallet.'),
          findsOneWidget,
        );
        expect(find.textContaining('₹101.69 added to your wallet.'), findsNothing);
      },
    );

    testWidgets(
      'a "credited" answer (server not yet consumed) is also success',
      (tester) async {
        api.onJson(
          'POST',
          '/api/hf/tokens/play/verify',
          verifyAnswer(status: 'credited'),
        );
        billing.answerWith(StorePurchaseStatus.purchased);
        await pumpWallet(tester, api: api, billing: billing);
        await buy100(tester);
        expect(find.textContaining('₹101.69 added to your wallet.'), findsOneWidget);
      },
    );

    testWidgets(
      'pending: tells the buyer money comes when Google confirms, and adds nothing',
      (tester) async {
        api.onJson('POST', '/api/hf/tokens/play/verify', {
          'ok': true,
          'status': 'pending',
          'orderId': 'GPA.2',
          'balance': {},
        });
        billing.answerWith(StorePurchaseStatus.pending, token: 'tok-pending');
        await pumpWallet(tester, api: api, billing: billing);
        await buy100(tester);
        expect(
          find.text(
            "Payment pending. We'll add the money to your wallet when Google confirms it.",
          ),
          findsOneWidget,
        );
        expect(find.textContaining('₹101.69 added to your wallet.'), findsNothing);
        expect(
          api.callsTo('POST', '/api/hf/tokens/play/verify').single.body,
          containsPair('purchaseToken', 'tok-pending'),
        );
      },
    );

    testWidgets('cancelled in the Play sheet: a quiet note, no verify', (
      tester,
    ) async {
      billing.answerWith(StorePurchaseStatus.canceled);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(
        find.text('Purchase cancelled. You were not charged.'),
        findsOneWidget,
      );
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), isEmpty);
    });

    testWidgets('a Play error shows a simple message', (tester) async {
      billing.answerWith(StorePurchaseStatus.error);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(
        find.text(
          'Google Play could not complete this purchase. Please try again.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('the Play sheet failing to open shows a message', (
      tester,
    ) async {
      billing.opens = false;
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(
        find.text('Google Play could not open. Please try again.'),
        findsOneWidget,
      );
    });

    testWidgets('prepare off (503 disabled): "not available right now"', (
      tester,
    ) async {
      api.onError(
        'POST',
        '/api/hf/tokens/play/prepare',
        const ApiError(
          status: 503,
          code: 'disabled',
          message: 'Token purchases are not available right now.',
        ),
      );
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(
        find.text(
          'Adding money is not available right now. Please try again soon.',
        ),
        findsOneWidget,
      );
      expect(billing.boughtProductIds, isEmpty);
    });

    testWidgets('no internet while preparing shows the offline message', (
      tester,
    ) async {
      api.onError('POST', '/api/hf/tokens/play/prepare', ApiError.network());
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });

    testWidgets(
      'verify cannot be reached: "still confirming", and the purchase is NOT consumed or completed',
      (tester) async {
        api.onError(
          'POST',
          '/api/hf/tokens/play/verify',
          const ApiError(
            status: 503,
            code: 'unavailable',
            extra: {'retry': true},
          ),
        );
        billing.answerWith(StorePurchaseStatus.purchased);
        await pumpWallet(tester, api: api, billing: billing);
        await buy100(tester);
        expect(
          find.textContaining("We're still confirming your payment"),
          findsOneWidget,
        );
        expect(find.textContaining('₹101.69 added to your wallet.'), findsNothing);
      },
    );

    testWidgets(
      'verify refuses the purchase (account mismatch): a clear message',
      (tester) async {
        api.onError(
          'POST',
          '/api/hf/tokens/play/verify',
          const ApiError(status: 403, code: 'account_mismatch', message: 'x'),
        );
        billing.answerWith(StorePurchaseStatus.purchased);
        await pumpWallet(tester, api: api, billing: billing);
        await buy100(tester);
        expect(
          find.text(
            'This purchase was made with a different account, so we cannot add it here.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('canceled and refunded answers add nothing', (tester) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', {
        'ok': true,
        'status': 'refunded',
        'orderId': 'GPA.3',
        'balance': {},
      });
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(
        find.text('Google refunded this payment, so no money was added.'),
        findsOneWidget,
      );
    });

    testWidgets('the notice can be dismissed', (tester) async {
      billing.answerWith(StorePurchaseStatus.canceled);
      await pumpWallet(tester, api: api, billing: billing);
      await buy100(tester);
      expect(
        find.byKey(const ValueKey<String>('purchase-notice')),
        findsOneWidget,
      );
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey<String>('purchase-notice')),
        findsNothing,
      );
    });
  });

  group('Are you sure?', () {
    Future<void> buy1000(WidgetTester tester) async {
      await selectAndPay(tester, 'hf_tokens_1000');
      // Not pumpAndSettle: "Getting ready" shows a spinner while the question is open, and it never settles.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    testWidgets(
      'a pack at or above the server threshold asks first; Yes buys',
      (tester) async {
        billing.answerWith(StorePurchaseStatus.purchased);
        api.onJson(
          'POST',
          '/api/hf/tokens/play/verify',
          verifyAnswer(
            paidPaise: 120000,
            gstPaise: 18305,
            walletPaise: 101695,
          ),
        );
        await pumpWallet(tester, api: api, billing: billing);
        await buy1000(tester);
        expect(find.text('Are you sure?'), findsOneWidget);
        expect(
          find.textContaining('₹1,000.00'),
          findsWidgets,
        ); // Play's price string is in the question
        expect(
          billing.boughtProductIds,
          isEmpty,
          reason: 'nothing opens before the answer',
        );
        await tester.tap(find.text('Yes, buy'));
        await tester.pumpAndSettle();
        expect(billing.boughtProductIds, ['hf_tokens_1000']);
        expect(find.textContaining('₹1,016.95 added to your wallet.'), findsOneWidget);
      },
    );

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
    testWidgets('an unfinished purchase is verified when the Wallet opens', (
      tester,
    ) async {
      billing.unfinished.add(
        const StorePurchase(
          productId: 'hf_tokens_100',
          purchaseToken: 'tok-old',
          status: StorePurchaseStatus.purchased,
          orderId: 'GPA.9',
        ),
      );
      await pumpWallet(tester, api: api, billing: billing);
      final verify = api.callsTo('POST', '/api/hf/tokens/play/verify');
      expect(verify, hasLength(1));
      expect(verify.single.body, {
        'productId': 'hf_tokens_100',
        'purchaseToken': 'tok-old',
      });
      expect(billing.recoverCalls, greaterThanOrEqualTo(1));
      expect(
        find.textContaining('₹101.69 added to your wallet.'),
        findsOneWidget,
        reason: 'late money is news',
      );
    });

    testWidgets('an already-credited unfinished purchase is silent', (
      tester,
    ) async {
      api.onJson(
        'POST',
        '/api/hf/tokens/play/verify',
        verifyAnswer(duplicate: true),
      );
      billing.unfinished.add(
        const StorePurchase(
          productId: 'hf_tokens_100',
          purchaseToken: 'tok-old',
          status: StorePurchaseStatus.purchased,
        ),
      );
      await pumpWallet(tester, api: api, billing: billing);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
      expect(
        find.byKey(const ValueKey<String>('purchase-notice')),
        findsNothing,
      );
    });

    testWidgets('a pending purchase found on start says so once', (
      tester,
    ) async {
      api.onJson('POST', '/api/hf/tokens/play/verify', {
        'ok': true,
        'status': 'pending',
        'orderId': 'GPA.2',
        'balance': {},
      });
      billing.unfinished.add(
        const StorePurchase(
          productId: 'hf_tokens_100',
          purchaseToken: 'tok-pend',
          status: StorePurchaseStatus.pending,
        ),
      );
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        find.text(
          "Payment pending. We'll add the money to your wallet when Google confirms it.",
        ),
        findsOneWidget,
      );
    });

    testWidgets('the same token reported twice is verified once', (
      tester,
    ) async {
      await pumpWallet(tester, api: api, billing: billing);
      const p = StorePurchase(
        productId: 'hf_tokens_100',
        purchaseToken: 'tok-twice',
        status: StorePurchaseStatus.purchased,
      );
      billing.emit(p);
      billing.emit(p);
      await tester.pumpAndSettle();
      billing.emit(p); // and again after it finished
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
    });

    testWidgets('a purchase the server will never accept is not retried', (
      tester,
    ) async {
      api.onError(
        'POST',
        '/api/hf/tokens/play/verify',
        const ApiError(
          status: 400,
          code: 'unknown_product',
          message: 'That token pack is not available.',
        ),
      );
      await pumpWallet(tester, api: api, billing: billing);
      const p = StorePurchase(
        productId: 'hf_tokens_100',
        purchaseToken: 'tok-bad',
        status: StorePurchaseStatus.purchased,
      );
      billing.emit(p);
      await tester.pumpAndSettle();
      billing.emit(p);
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
    });

    test(
      'the recovery provider verifies unfinished purchases once a person is signed in',
      () async {
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
        billing.unfinished.add(
          const StorePurchase(
            productId: 'hf_tokens_100',
            purchaseToken: 'tok-start',
            status: StorePurchaseStatus.purchased,
          ),
        );
        container.listen(purchaseRecoveryProvider, (_, __) {});
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(billing.recoverCalls, 1);
        expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(1));
        expect(
          container.read(purchaseControllerProvider).notice?.message,
          '₹101.69 added to your wallet.\nTotal ₹120.00 · GST included ₹18.31 · Added to wallet ₹101.69',
        );
      },
    );

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
