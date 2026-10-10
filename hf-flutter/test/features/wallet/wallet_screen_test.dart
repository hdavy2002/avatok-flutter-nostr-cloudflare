import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/features/wallet/billing/billing_adapter.dart';
import 'package:hf_app/features/wallet/data/pack_offer.dart';
import 'package:hf_app/features/wallet/data/wallet_models.dart';

import '../../support/app_harness.dart';
import '../../support/fake_billing.dart';
import 'wallet_support.dart';

class _RecordingLinks extends LinkOpener {
  _RecordingLinks();
  final List<Uri> opened = <Uri>[];

  @override
  Future<bool> customTab(Uri uri) async {
    opened.add(uri);
    return true;
  }
}

void main() {
  late FakeBillingAdapter billing;

  setUp(() => billing = FakeBillingAdapter());

  group('token wallet', () {
    testWidgets('shows the balance with 2 decimals, the value breakdown, test tokens and history', (tester) async {
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.text('Your balance'), findsOneWidget);
      expect(find.text('₹45.20'), findsOneWidget);
      expect(find.textContaining('worth'), findsNothing);
      expect(find.text('Test credit (spend only): ₹5.00'), findsOneWidget);
      expect(find.text('Call with Asha (4 min)'), findsOneWidget);
      expect(find.text('-₹3.20'), findsOneWidget);
      expect(find.text('+₹100.00'), findsOneWidget);
    });

    testWidgets('no test tokens line when there are none; an empty wallet says how to start', (tester) async {
      await pumpWallet(
        tester,
        api: walletApi(wallet: tokenWallet(balance: '0.00', balanceMicro: 0, testTokens: '0.00')),
        billing: billing,
      );
      expect(find.byKey(const ValueKey<String>('test-tokens')), findsNothing);
      expect(find.text('No money in your wallet yet. Add money below to start calling.'), findsOneWidget);
    });

    testWidgets('old lots of other values are not listed per value: the wallet is one rupee number', (tester) async {
      final w = tokenWallet(balance: '60.00', balanceMicro: 60000000);
      (w['tokens'] as Map)['byValue'] = [
        {'valuePaisePerToken': 82, 'tokens': '45.20', 'micro': 45200000},
        {'valuePaisePerToken': 90, 'tokens': '14.80', 'micro': 14800000},
      ];
      await pumpWallet(tester, api: walletApi(wallet: w), billing: billing);
      expect(find.textContaining('worth'), findsNothing);
      expect(find.text('₹60.00'), findsOneWidget);
    });

    testWidgets('tokens held for a call are explained', (tester) async {
      final w = tokenWallet();
      (w['tokens'] as Map)['availableMicro'] = 30000000;
      (w['tokens'] as Map)['available'] = '30.00';
      await pumpWallet(tester, api: walletApi(wallet: w), billing: billing);
      expect(find.text('₹30.00 is free to spend. The rest is held for a call in progress.'), findsOneWidget);
    });

    testWidgets('debt banner: what is owed and that the next purchase clears it', (tester) async {
      final w = tokenWallet(debt: {'tokens': '12.50', 'micro': 12500000, 'valuePaise': 1025, 'open': true});
      await pumpWallet(tester, api: walletApi(wallet: w), billing: billing);
      expect(find.byKey(const ValueKey<String>('debt-banner')), findsOneWidget);
      expect(find.text('You owe ₹12.50 after a refund.'), findsOneWidget);
      expect(find.text('Your next purchase clears it first. Calls stay paused until then.'), findsOneWidget);
    });

    testWidgets('no debt banner when nothing is owed', (tester) async {
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.byKey(const ValueKey<String>('debt-banner')), findsNothing);
    });

    testWidgets('purchase records fall back to the purchase lines of the history (no order id yet)', (tester) async {
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.byKey(const ValueKey<String>('purchases')), findsOneWidget);
      expect(find.text('Paid via Google Play'), findsOneWidget);
    });

    testWidgets('purchases[] from the server shows the order id', (tester) async {
      final w = tokenWallet(purchases: [
        {'orderId': 'GPA.3300-1', 'productId': 'hf_tokens_100', 'tokens': 100, 'paidPaise': 10000, 'at': 1760000000000, 'state': 'consumed'},
      ]);
      await pumpWallet(tester, api: walletApi(wallet: w), billing: billing);
      expect(find.text('Paid via Google Play'), findsOneWidget);
      expect(find.textContaining('Order GPA.3300-1'), findsOneWidget);
      expect(
        find.descendant(of: find.byKey(const ValueKey<String>('purchases')), matching: find.text('₹100')),
        findsOneWidget,
      );
    });

    testWidgets('the wallet is read live every time it opens: no cache', (tester) async {
      final api = walletApi();
      await pumpWallet(tester, api: api, billing: billing);
      expect(api.callsTo('GET', '/api/hf/wallet'), hasLength(1));
    });
  });

  group('old rupee wallet (tokens off)', () {
    testWidgets('renders rupees, test credits, history, and says buying tokens is coming soon', (tester) async {
      final api = walletApi(wallet: legacyWallet(), productsEnabled: false)
        ..onJson('GET', '/api/hf/wallet/receipts', {
          'ok': true,
          'receipts': [
            {'id': 'hfr_1', 'number': 'R-0001', 'kind': 'topup', 'source': 'razorpay', 'amountRupees': 100, 'issuedAt': 1760000000000},
          ],
        });
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('₹250'), findsOneWidget);
      expect(find.text('Test credits (spend only): ₹40'), findsOneWidget);
      expect(find.text('-₹40'), findsOneWidget);
      expect(find.text('Adding money is coming soon'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('purchases')), findsNothing, reason: 'purchase records are a token-mode section');
      expect(find.text('Receipt R-0001'), findsOneWidget);
      expect(find.text('These count the money you spend.'), findsOneWidget);
      expect(billing.boughtProductIds, isEmpty);
    });

    testWidgets('"Buying tokens is coming soon" also when the products route says enabled:false in token mode', (tester) async {
      await pumpWallet(tester, api: walletApi(productsEnabled: false), billing: billing);
      expect(find.text('Adding money is coming soon'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('buy-hf_tokens_100')), findsNothing);
    });
  });

  group('states', () {
    testWidgets('a guest is asked to sign in and nothing is fetched', (tester) async {
      final api = walletApi();
      await pumpWallet(tester, api: api, billing: billing, session: signedOutState());
      expect(find.text('Please sign in to see your wallet.'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
      expect(api.callsTo('GET', '/api/hf/wallet'), isEmpty);
    });

    testWidgets('the wallet route off (404 not_enabled) shows Coming soon, not an error', (tester) async {
      final api = walletApi()..onError('GET', '/api/hf/wallet', const ApiError(status: 404, code: 'not_enabled'));
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Coming soon'), findsOneWidget);
    });

    testWidgets('an error shows the message and Try again reloads', (tester) async {
      var fail = true;
      final api = walletApi()
        ..on('GET', '/api/hf/wallet', (_) {
          if (fail) throw const ApiError(status: 502, code: 'wallet_error', message: 'We could not read your wallet.');
          return tokenWallet();
        });
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('We could not read your wallet.'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('₹45.20'), findsOneWidget);
    });

    testWidgets('no internet shows the offline message', (tester) async {
      final api = walletApi()..onError('GET', '/api/hf/wallet', ApiError.network());
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });

    testWidgets('Google Play missing on the device: packs are not buyable and it says why', (tester) async {
      billing.available = false;
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.text('Google Play is not available on this device, so you cannot add money here.'), findsOneWidget);
      final b = tester.widget<ElevatedButton>(
          find.descendant(of: find.byKey(const ValueKey<String>('buy-hf_tokens_100')), matching: find.byType(ElevatedButton)));
      expect(b.onPressed, isNull);
    });

    testWidgets('Play prices that cannot load say so, with Try again', (tester) async {
      billing.queryError = StateError('play down');
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.text('We could not load the prices from Google Play.'), findsOneWidget);
      expect(find.text('Not available'), findsNWidgets(2));
    });

    testWidgets('the products route failing shows a message and Try again', (tester) async {
      final api = walletApi()..onError('GET', '/api/hf/tokens/products', ApiError.network());
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });
  });

  group('refunds', () {
    Map<String, Object?> refundsTokens({List<Object?>? lots, List<Object?>? requests}) => {
          'enabled': true,
          'mode': 'tokens',
          'windowDays': 180,
          'refundable': 82,
          'eligible': 82,
          'lots': lots ??
              [
                {'lotId': 'lot_1', 'tokens': '100.00', 'paid': 100, 'refund': 82, 'wholeOrder': true, 'boughtAt': 1760000000000},
              ],
          'requests': requests ?? <Object?>[],
        };

    testWidgets('refunds off: the Google Play way, a link to order history, and the support email', (tester) async {
      final links = _RecordingLinks();
      LinkOpener.instance = links;
      addTearDown(() => LinkOpener.instance = const LinkOpener());
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.text('Refunds'), findsOneWidget);
      expect(find.textContaining('refunded by Google'), findsOneWidget);
      expect(find.textContaining(Brand.supportEmail), findsOneWidget);
      expect(find.text('Ask for a refund'), findsNothing);
      await tester.tap(find.byKey(const ValueKey<String>('play-order-history')));
      await tester.pumpAndSettle();
      expect(links.opened, hasLength(1));
      expect(links.opened.single.host, 'play.google.com');
      expect(links.opened.single.path, '/store/account/orderhistory');
    });

    testWidgets('unused purchased tokens: the lot, what comes back, and the window', (tester) async {
      await pumpWallet(tester, api: walletApi(refunds: refundsTokens()), billing: billing);
      expect(find.text('You can ask for a refund of unused wallet money within 180 days of buying them.'), findsOneWidget);
      expect(find.text('₹100.00 unused'), findsOneWidget);
      expect(find.text('You paid ₹100. Refund: ₹82'), findsOneWidget);
    });

    testWidgets('asking for a refund: confirm, then POST with the lot and an Idempotency-Key', (tester) async {
      final api = walletApi(refunds: refundsTokens())
        ..onJson('POST', '/api/hf/wallet/refunds', {'ok': true, 'id': 'req_9', 'ids': ['req_9'], 'status': 'requested', 'amount': 82});
      await pumpWallet(tester, api: api, billing: billing);
      await tester.tap(find.byKey(const ValueKey<String>('refund-lot_1')));
      await tester.pumpAndSettle();
      expect(find.text('Ask for a refund?'), findsOneWidget);
      expect(api.callsTo('POST', '/api/hf/wallet/refunds'), isEmpty, reason: 'nothing is sent before the answer');
      await tester.tap(find.text('Yes, ask'));
      await tester.pumpAndSettle();
      final calls = api.callsTo('POST', '/api/hf/wallet/refunds');
      expect(calls, hasLength(1));
      expect(calls.single.body, {'lotId': 'lot_1'});
      expect(calls.single.idempotencyKey, startsWith('hfw-'));
      expect(find.text('Refund requested. We will check it and tell you here.'), findsOneWidget);
    });

    testWidgets('saying "Not now" sends nothing', (tester) async {
      final api = walletApi(refunds: refundsTokens());
      await pumpWallet(tester, api: api, billing: billing);
      await tester.tap(find.byKey(const ValueKey<String>('refund-lot_1')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Not now'));
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '/api/hf/wallet/refunds'), isEmpty);
    });

    testWidgets('a refused request shows the server message', (tester) async {
      final api = walletApi(refunds: refundsTokens())
        ..onError('POST', '/api/hf/wallet/refunds', const ApiError(status: 409, code: 'active_call', message: 'Finish your call first.'));
      await pumpWallet(tester, api: api, billing: billing);
      await tester.tap(find.byKey(const ValueKey<String>('refund-lot_1')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, ask'));
      await tester.pumpAndSettle();
      expect(find.text('Finish your call first.'), findsOneWidget);
    });

    testWidgets('nothing refundable says so', (tester) async {
      await pumpWallet(tester, api: walletApi(refunds: refundsTokens(lots: <Object?>[])), billing: billing);
      expect(find.text('You have no unused wallet money that can be refunded right now.'), findsOneWidget);
    });

    testWidgets('requests are listed with their status, and a waiting one can be cancelled', (tester) async {
      final api = walletApi(
        refunds: refundsTokens(requests: [
          {'id': 'req_1', 'amount': 50, 'status': 'requested', 'reason': null, 'createdAt': 1760000000000},
          {'id': 'req_0', 'amount': 20, 'status': 'rejected', 'reason': 'Tokens were already used.', 'createdAt': 1750000000000},
        ]),
      )..onJson('POST', '/api/hf/wallet/refunds/req_1/cancel', {'ok': true, 'status': 'cancelled'});
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('₹50 · Waiting for review'), findsOneWidget);
      expect(find.text('₹20 · Not approved'), findsOneWidget);
      expect(find.text('Tokens were already used.'), findsOneWidget);
      expect(find.text('Cancel request'), findsOneWidget, reason: 'only the waiting one');
      await tester.tap(find.text('Cancel request'));
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '/api/hf/wallet/refunds/req_1/cancel'), hasLength(1));
    });

    testWidgets('old rupee money: one request for the unused amount', (tester) async {
      final api = walletApi(wallet: legacyWallet(), productsEnabled: false, refunds: {
        'enabled': true,
        'windowDays': 180,
        'refundable': 120,
        'eligible': 120,
        'requests': <Object?>[],
      })
        ..onJson('POST', '/api/hf/wallet/refunds', {'ok': true, 'id': 'req_5', 'status': 'requested', 'amount': 120});
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Unused money that can go back: ₹120'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey<String>('refund-money')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, ask'));
      await tester.pumpAndSettle();
      final call = api.callsTo('POST', '/api/hf/wallet/refunds').single;
      expect(call.body, <String, Object?>{});
      expect(call.idempotencyKey, isNotNull);
    });
  });

  group('parsing and rules', () {
    test('the server\'s token strings are shown as sent when micro amounts are missing', () {
      final d = WalletData.fromJson({
        'mode': 'tokens',
        'tokens': {
          'balance': '12.30',
          'available': '12.30',
          'testTokens': '0.00',
          'byValue': [
            {'valuePaisePerToken': 82, 'tokens': '12.30'},
          ],
          'debt': {'tokens': '0.00', 'micro': 0, 'valuePaise': 0, 'open': false},
        },
        'history': [],
      });
      expect(d.tokenMode, isTrue);
      expect(d.balanceText, '12.30');
      expect(d.byValue.single.micro, 12300000);
      expect(d.hasDebt, isFalse);
    });

    test('a body without "mode" is the old rupee shape', () {
      final d = WalletData.fromJson({'paidBalance': 10, 'testBalance': 0, 'spendable': 10, 'history': []});
      expect(d.tokenMode, isFalse);
      expect(d.paidBalance, 10);
    });

    test('debt is open for any positive owed value', () {
      expect(TokenDebt.fromJson({'tokens': '0.10', 'micro': 100000, 'valuePaise': 0}).open, isTrue);
      expect(TokenDebt.fromJson({'tokens': '0.00', 'micro': 0, 'valuePaise': 0}).open, isFalse);
      expect(TokenDebt.fromJson(null).open, isFalse);
    });

    test('verify statuses', () {
      expect(VerifyResult.fromJson({'status': 'consumed'}).isCredited, isTrue);
      expect(VerifyResult.fromJson({'status': 'credited'}).isCredited, isTrue);
      expect(VerifyResult.fromJson({'status': 'pending'}).status, VerifyStatus.pending);
      expect(VerifyResult.fromJson({'status': 'canceled'}).status, VerifyStatus.canceled);
      expect(VerifyResult.fromJson({'status': 'refunded'}).status, VerifyStatus.refunded);
      expect(VerifyResult.fromJson({'status': 'duplicate'}).status, VerifyStatus.unknown);
    });

    test('tokensPlain drops .00 only', () {
      expect(tokensPlain(100), '₹100');
      expect(tokensPlain(1), '₹1');
      expect(tokensPlain(45.2), '₹45.20');
      expect(tokensPlain(1000), '₹1,000');
    });

    test('the Are-you-sure price: Play\'s rupees first, the catalogue price as a fallback, unknown otherwise', () {
      const pack = TokenPack(productId: 'p', tokens: 1000, purchasePaisePerToken: 100);
      expect(
        packPricePaise(const PackOffer(
          pack: pack,
          store: StoreProduct(productId: 'p', priceText: '₹1,000.00', currencyCode: 'INR', priceMicros: 1000000000),
        )),
        100000,
      );
      expect(
        packPricePaise(const PackOffer(
          pack: pack,
          store: StoreProduct(productId: 'p', priceText: 'US\$12.00', currencyCode: 'USD', priceMicros: 12000000),
        )),
        100000,
        reason: 'not rupees: the catalogue price decides',
      );
      expect(packPricePaise(const PackOffer(pack: pack)), 100000);
      expect(packPricePaise(const PackOffer(pack: TokenPack(productId: 'p', tokens: 100))), isNull);
    });
  });
}
