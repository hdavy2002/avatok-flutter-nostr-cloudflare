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

const String _play120Breakdown =
    'Total ₹120.00 · GST included ₹18.31 · Added to wallet ₹101.69';
const String _play120Success =
    '₹101.69 added to your wallet.\n$_play120Breakdown';

void main() {
  late FakeBillingAdapter billing;
  late FakeApiClient api;

  setUp(() {
    billing = walletBilling();
    api = walletApi();
  });

  Future<void> buy120(WidgetTester tester) async {
    await selectAndPay(tester, 'hf_rupees_120');
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
            .widget<Text>(find.byKey(const ValueKey<String>('gst-hf_rupees_120')))
            .data,
        '+ ₹101.69 to wallet',
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

        expect(
          tester
              .widget<Text>(
                find.byKey(const ValueKey<String>('gst-hf_rupees_120')),
              )
              .data,
          '+ ₹101.69 to wallet',
        );

        await buy120(tester);

        // prepare first, then the Play sheet with the server's account id, then verify with the token.
        final prepare = api.callsTo('POST', '/api/hf/tokens/play/prepare');
        expect(prepare, hasLength(1));
        expect((prepare.single.body as Map)['productId'], 'hf_rupees_120');
        expect(billing.boughtProductIds, ['hf_rupees_120']);
        expect(billing.accountIdsSent, ['acct_hash_1']);
        final verify = api.callsTo('POST', '/api/hf/tokens/play/verify');
        expect(verify, hasLength(1));
        expect(verify.single.body, {
          'productId': 'hf_rupees_120',
          'purchaseToken': 'tok-abc',
        });

        expect(
          find.text(_play120Success),
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
          'hf_rupees_120': const StoreProduct(
            productId: 'hf_rupees_120',
            priceText: 'Rs 99.99 (from Play)',
            currencyCode: 'INR',
            priceMicros: 99990000,
          ),
          'hf_rupees_500': const StoreProduct(
            productId: 'hf_rupees_500',
            priceText: 'Rs 999.99 (from Play)',
            currencyCode: 'INR',
            priceMicros: 999990000,
          ),
        };
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('Rs 99.99 (from Play)'), findsOneWidget);
        expect(find.text('Rs 999.99 (from Play)'), findsOneWidget);
        expect(
          find.text('+ ₹84.74 to wallet'),
          findsOneWidget,
        );
        expect(
          find.text('+ ₹847.45 to wallet'),
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
        }; // only the ₹120 pack
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('Not available'), findsOneWidget);
        await tester.tap(buyButton('hf_rupees_500'));
        await tester.pump();
        final b = tester.widget<ElevatedButton>(
          find.descendant(of: payButton, matching: find.byType(ElevatedButton)),
        );
        expect(b.onPressed, isNotNull);
        expect(find.text('Pay ₹120.00 with Google Play'), findsOneWidget);
        expect(api.callsTo('POST', '/api/hf/tokens/play/prepare'), isEmpty);
        expect(billing.boughtProductIds, isEmpty);
      },
    );

    testWidgets('partial Play catalogue keeps missing packs disabled and recovers on retry', (
      tester,
    ) async {
      api.onJson('GET', '/api/hf/tokens/products', {
        'ok': true,
        'enabled': true,
        'products': [
          for (final amount in [120, 240, 360, 500])
            {'productId': 'hf_rupees_$amount', 'pricePaise': amount * 100},
        ],
      });
      billing.products = {
        for (final amount in [360, 500])
          'hf_rupees_$amount': StoreProduct(
            productId: 'hf_rupees_$amount',
            priceText: '₹$amount.00',
            currencyCode: 'INR',
            priceMicros: amount * 1000000,
          ),
      };
      final container = await pumpWallet(tester, api: api, billing: billing);
      final offers = container.read(packOffersProvider).requireValue;
      expect(offers.missingProductIds, ['hf_rupees_120', 'hf_rupees_240']);
      expect(find.text('Not available'), findsNWidgets(2));
      expect(find.text('Pay ₹360.00 with Google Play'), findsOneWidget);
      for (final id in offers.missingProductIds) {
        final tile = find.descendant(of: buyButton(id), matching: find.byType(InkWell));
        expect(tester.widget<InkWell>(tile).onTap, isNull);
        await tester.tap(buyButton(id));
        await tester.pump();
      }
      expect(find.text('Pay ₹360.00 with Google Play'), findsOneWidget);
      // Defence in depth: direct controller calls still cannot prepare a missing product.
      await container.read(purchaseControllerProvider.notifier).buy(
        offers.offers.first,
        confirm: (_, __) async => true,
      );
      expect(api.callsTo('POST', '/api/hf/tokens/play/prepare'), isEmpty);
      expect(billing.boughtProductIds, isEmpty);
      container.read(purchaseControllerProvider.notifier).dismissNotice();
      await tester.tap(buyButton('hf_rupees_500'));
      await tester.pumpAndSettle();
      expect(find.text('Pay ₹500.00 with Google Play'), findsOneWidget);
      billing.products = {'hf_rupees_360': billing.products['hf_rupees_360']!};
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Pay ₹360.00 with Google Play'), findsOneWidget,
          reason: 'a previously selected pack lost from Play cannot remain selected');

      billing.products = {
        for (final amount in [120, 240, 360, 500])
          'hf_rupees_$amount': StoreProduct(
            productId: 'hf_rupees_$amount',
            priceText: '₹$amount.00',
            currencyCode: 'INR',
            priceMicros: amount * 1000000,
          ),
      };
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(container.read(packOffersProvider).requireValue.missingProductIds, isEmpty);
      expect(find.text('Not available'), findsNothing);
      expect(find.text('Pay ₹500.00 with Google Play'), findsOneWidget,
          reason: 'the user choice can return when Play makes it available again');
      billing.answerWith(StorePurchaseStatus.canceled);
      await selectAndPay(tester, 'hf_rupees_120');
      await tester.pumpAndSettle();
      expect(billing.boughtProductIds, ['hf_rupees_120']);
      expect((api.callsTo('POST', '/api/hf/tokens/play/prepare').single.body as Map)['productId'], 'hf_rupees_120');
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), isEmpty);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('selecting another pack changes the Pay label', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Pay ₹120.00 with Google Play'), findsOneWidget);
      await tester.tap(buyButton('hf_rupees_500'));
      await tester.pumpAndSettle();
      expect(find.text('Pay ₹500.00 with Google Play'), findsOneWidget);
      expect(find.text('Pay ₹120.00 with Google Play'), findsNothing);
    });

    testWidgets('legacy packs cannot become new purchases', (tester) async {
      api.onJson('GET', '/api/hf/tokens/products', {
        'ok': true,
        'enabled': true,
        'products': [
          {'productId': 'hf_tokens_100', 'pricePaise': 12000},
        ],
      });
      billing = FakeBillingAdapter();
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        find.text('The approved fixed packs are not available right now.'),
        findsOneWidget,
      );
      expect(buyButton('hf_tokens_100'), findsNothing);
      expect(payButton, findsNothing);
      expect(billing.boughtProductIds, isEmpty);
    });

    testWidgets('the Popular pack is selected first and wears the badge', (
      tester,
    ) async {
      api.onJson('GET', '/api/hf/tokens/products', {
        'ok': true,
        'enabled': true,
        'products': [
          {
            'productId': 'hf_rupees_120',
            'tokens': 102,
            'pricePaise': 12000,
            'creditPaise': 10200,
          },
          {
            'productId': 'hf_rupees_240',
            'tokens': 204,
            'pricePaise': 24000,
            'creditPaise': 20400,
          },
          {
            'productId': 'hf_rupees_360',
            'tokens': 305,
            'pricePaise': 36000,
            'creditPaise': 30500,
          },
          {
            'productId': 'hf_rupees_500',
            'tokens': 424,
            'pricePaise': 50000,
            'creditPaise': 42400,
          },
        ],
      });
      billing.products = {
        'hf_rupees_120': const StoreProduct(
          productId: 'hf_rupees_120',
          priceText: '₹120.00',
          currencyCode: 'INR',
          priceMicros: 120000000,
        ),
        'hf_rupees_240': const StoreProduct(
          productId: 'hf_rupees_240',
          priceText: '₹240.00',
          currencyCode: 'INR',
          priceMicros: 240000000,
        ),
        'hf_rupees_360': const StoreProduct(
          productId: 'hf_rupees_360',
          priceText: '₹360.00',
          currencyCode: 'INR',
          priceMicros: 360000000,
        ),
        'hf_rupees_500': const StoreProduct(
          productId: 'hf_rupees_500',
          priceText: '₹500.00',
          currencyCode: 'INR',
          priceMicros: 500000000,
        ),
      };
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        find.byKey(const ValueKey<String>('popular-hf_rupees_240')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey<String>('popular-hf_rupees_120')),
        findsNothing,
      );
      expect(find.text('Pay ₹240.00 with Google Play'), findsOneWidget);
      for (final id in const [
        'hf_rupees_120',
        'hf_rupees_240',
        'hf_rupees_360',
        'hf_rupees_500',
      ]) {
        expect(find.byKey(ValueKey<String>('buy-$id')), findsOneWidget);
      }
    });

    testWidgets('Pay is disabled while a purchase is pending (no double tap)', (
      tester,
    ) async {
      await pumpWallet(tester, api: api, billing: billing);
      await selectAndPay(tester, 'hf_rupees_120');
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      // The Play sheet is open and has not answered: Pay stays off and the tiles are locked.
      final b = tester.widget<ElevatedButton>(
        find.descendant(of: payButton, matching: find.byType(ElevatedButton)),
      );
      expect(b.onPressed, isNull);
      expect(billing.boughtProductIds, ['hf_rupees_120']);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
    });

    testWidgets('the buy button is at least 48 dp tall', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        tester.getSize(buyButton('hf_rupees_120')).height,
        greaterThanOrEqualTo(48),
      );
    });

    testWidgets(
      'duplicate: the same purchase again says it was already added',
      (tester) async {
        api.onJson(
          'POST',
          '/api/hf/tokens/play/verify',
          verifyAnswer(productId: 'hf_rupees_120', duplicate: true),
        );
        billing.answerWith(StorePurchaseStatus.purchased);
        await pumpWallet(tester, api: api, billing: billing);
        await buy120(tester);
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
          verifyAnswer(productId: 'hf_rupees_120', status: 'credited'),
        );
        billing.answerWith(StorePurchaseStatus.purchased);
        await pumpWallet(tester, api: api, billing: billing);
        await buy120(tester);
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
        await buy120(tester);
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
      await buy120(tester);
      expect(
        find.text('Purchase cancelled. You were not charged.'),
        findsOneWidget,
      );
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), isEmpty);
    });

    testWidgets('a Play error shows a simple message', (tester) async {
      billing.answerWith(StorePurchaseStatus.error);
      await pumpWallet(tester, api: api, billing: billing);
      await buy120(tester);
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
      await buy120(tester);
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
      await buy120(tester);
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
      await buy120(tester);
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
        await buy120(tester);
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
        await buy120(tester);
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
      await buy120(tester);
      expect(
        find.text('Google refunded this payment, so no money was added.'),
        findsOneWidget,
      );
    });

    testWidgets('the notice can be dismissed', (tester) async {
      billing.answerWith(StorePurchaseStatus.canceled);
      await pumpWallet(tester, api: api, billing: billing);
      await buy120(tester);
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
    setUp(() {
      api.on('POST', '/api/hf/tokens/play/prepare', (call) => {
        ...prepareAnswer('${(call.body as Map)['productId']}'),
        // The server owns the threshold, even when the fixed catalogue changes.
        'confirmAbovePaise': 50000,
      });
    });

    Future<void> buy500(WidgetTester tester) async {
      await selectAndPay(tester, 'hf_rupees_500');
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
            productId: 'hf_rupees_500',
            paidPaise: 50000,
            gstPaise: 7627,
            walletPaise: 42373,
          ),
        );
        await pumpWallet(tester, api: api, billing: billing);
        await buy500(tester);
        expect(find.text('Are you sure?'), findsOneWidget);
        expect(
          find.textContaining('₹500.00'),
          findsWidgets,
        ); // Play's price string is in the question
        expect(
          billing.boughtProductIds,
          isEmpty,
          reason: 'nothing opens before the answer',
        );
        await tester.tap(find.text('Yes, buy'));
        await tester.pumpAndSettle();
        expect(billing.boughtProductIds, ['hf_rupees_500']);
        expect(find.textContaining('₹423.73 added to your wallet.'), findsOneWidget);
      },
    );

    testWidgets('No stops it: Play never opens', (tester) async {
      await pumpWallet(tester, api: api, billing: billing);
      await buy500(tester);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(billing.boughtProductIds, isEmpty);
      expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), isEmpty);
    });

    testWidgets('a smaller pack buys straight away', (tester) async {
      billing.answerWith(StorePurchaseStatus.purchased);
      await pumpWallet(tester, api: api, billing: billing);
      await buy120(tester);
      expect(find.text('Are you sure?'), findsNothing);
      expect(billing.boughtProductIds, ['hf_rupees_120']);
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
          _play120Success,
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
