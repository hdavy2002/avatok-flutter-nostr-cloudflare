import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/features/explore/data/hosts_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/core/storage/account_storage.dart';
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

const _packColors = <int, ({Color fill, Color value, Color ink})>{
  120: (
    fill: Color(0xFFDCEBFF),
    value: Color(0xFF1D3F6E),
    ink: Color(0xFF1D3F6E),
  ),
  240: (
    fill: Color(0xFFFFF1C7),
    value: Color(0xFF3D2D00),
    ink: Color(0xFF5C4300),
  ),
  360: (
    fill: Color(0xFFFFE3D3),
    value: Color(0xFF6B2C12),
    ink: Color(0xFF6B2C12),
  ),
  500: (
    fill: Color(0xFFE7E1FF),
    value: Color(0xFF2C2477),
    ink: Color(0xFF2C2477),
  ),
};

Map<String, Object?> _paletteCatalogue(List<int> amounts) => {
  'ok': true,
  'enabled': true,
  'gstBps': 1800,
  'products': [
    for (final amount in amounts)
      {'productId': 'hf_rupees_$amount', 'pricePaise': amount * 100},
  ],
};

FakeBillingAdapter _paletteBilling(List<int> amounts) => FakeBillingAdapter(
  products: {
    for (final amount in amounts)
      'hf_rupees_$amount': StoreProduct(
        productId: 'hf_rupees_$amount',
        priceText: '₹$amount.00',
        currencyCode: 'INR',
        priceMicros: amount * 1000000,
      ),
  },
);

double _contrast(Color foreground, Color background) {
  final a = foreground.computeLuminance();
  final b = background.computeLuminance();
  return a > b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

void _expectPackPalette(
  WidgetTester tester,
  int amount, {
  required bool dark,
  required bool selected,
  bool available = true,
}) {
  final tile = buyButton('hf_rupees_$amount');
  final colors = _packColors[amount]!;
  final decoration = tester.widget<AnimatedContainer>(tile).decoration! as BoxDecoration;
  expect(decoration.color, colors.fill);
  expect(decoration.borderRadius, BorderRadius.circular(22));
  final border = decoration.border! as Border;
  expect(border.top.width, selected ? 3 : 1);
  expect(border.top.color, selected
      ? Colors.black
      : dark ? const Color(0xFF5C5C66) : const Color(0xFFD8D1C9));
  final aspect = tester.widget<AspectRatio>(find.ancestor(
    of: tile,
    matching: find.byType(AspectRatio),
  ));
  expect(aspect.aspectRatio, 1.42);
  final semantics = tester.widget<Semantics>(find.ancestor(
    of: tile,
    matching: find.byWidgetPredicate((w) => w is Semantics && w.properties.button == true),
  ).first);
  expect(semantics.properties.selected, selected);
  expect(semantics.properties.enabled, available);
  final price = tester.widget<Text>(find.descendant(
    of: tile,
    matching: find.text(available ? '₹$amount.00' : 'Not available'),
  ));
  expect(price.style?.fontSize, 24);
  expect(price.style?.color, colors.value);
  expect(_contrast(price.style!.color!, decoration.color!), greaterThanOrEqualTo(3));
  final notes = tester.widgetList<Text>(find.descendant(
    of: tile,
    matching: find.byType(Text),
  )).where((text) => text != price);
  expect(notes, isNotEmpty);
  for (final note in notes) {
    expect(note.style?.color, colors.ink);
    expect(_contrast(note.style!.color!, decoration.color!), greaterThanOrEqualTo(4.5));
  }
  if (amount == 500) {
    expect(find.descendant(of: tile, matching: find.text('Fixed pack')), findsOneWidget);
    final lock = tester.widget<Icon>(find.descendant(
      of: tile,
      matching: find.byIcon(Icons.lock_outline_rounded),
    ));
    expect(lock.color, colors.ink);
  }
}

void main() {
  for (final dark in [false, true]) {
    testWidgets('wallet palette preserves type sizes (${dark ? 'dark' : 'light'})', (tester) async {
      const amounts = [120, 240, 360, 500];
      final billing = _paletteBilling(amounts);
      final api = walletApi()
        ..onJson('GET', '/api/hf/tokens/products', _paletteCatalogue(amounts));
      await pumpWallet(tester, api: api, billing: billing, dark: dark);
      expect(tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor,
          dark ? const Color(0xFF000000) : const Color(0xFFF6F3EE));
      final balance = tester.widget<Text>(find.byKey(const ValueKey<String>('balance-total')));
      expect(balance.style?.fontSize, 44);
      expect(balance.style?.color, Colors.white);
      final balanceCard = find.byKey(const ValueKey<String>('token-balance'));
      final base = dark ? const Color(0xFF2E2852) : Colors.black;
      final artwork = tester.widgetList<DecoratedBox>(find.descendant(
        of: balanceCard,
        matching: find.byType(DecoratedBox),
      )).map((box) => box.decoration).whereType<BoxDecoration>();
      expect(artwork.where((box) => box.shape == BoxShape.rectangle)
          .map((box) => box.color), contains(base));
      expect(artwork.where((box) => box.shape == BoxShape.circle)
          .map((box) => box.color), [const Color(0xFF3A2F99), const Color(0xFF9C2853)]);
      final supporting = tester.widgetList<Text>(find.descendant(
        of: balanceCard,
        matching: find.byType(Text),
      )).where((text) => text != balance);
      expect(supporting, isNotEmpty);
      for (final text in supporting) {
        expect(text.style?.fontSize, 14);
        expect(text.style?.color, const Color(0xFFD6D1EE));
        for (final background in [base, const Color(0xFF3A2F99), const Color(0xFF9C2853)]) {
          expect(_contrast(text.style!.color!, background), greaterThanOrEqualTo(4.5));
          expect(_contrast(balance.style!.color!, background), greaterThanOrEqualTo(3));
        }
      }
      for (final amount in amounts) {
        _expectPackPalette(tester, amount, dark: dark, selected: amount == 240);
      }
      final popular = tester.widget<Text>(find.text('Popular'));
      expect(popular.style?.color, Colors.black);
      final badge = tester.widget<Container>(find.ancestor(
        of: find.text('Popular'),
        matching: find.byType(Container),
      ).first);
      expect((badge.decoration! as BoxDecoration).color, const Color(0xFFF28C28));
      final price = tester.widget<Text>(find.descendant(
        of: buyButton('hf_rupees_120'),
        matching: find.text('₹120.00'),
      ));
      expect(price.style?.fontSize, 24);
      final button = tester.widget<ElevatedButton>(
        find.descendant(of: payButton, matching: find.byType(ElevatedButton)),
      );
      final buttonContext = tester.element(find.descendant(of: payButton, matching: find.byType(ElevatedButton)));
      expect(Theme.of(buttonContext).elevatedButtonTheme.style?.backgroundColor?.resolve({}), const Color(0xFFF28C28));
      expect(button.onPressed, isNotNull);
      final refundSurface = tester.widget<Container>(find.ancestor(
        of: find.text('Payments & refunds'),
        matching: find.byWidgetPredicate((w) => w is Container && w.decoration is BoxDecoration),
      ).first);
      expect((refundSurface.decoration! as BoxDecoration).color,
          dark ? const Color(0xFF343438) : const Color(0xFFFFFDF9));
      final refundTitle = tester.widget<Text>(find.text('Payments & refunds'));
      expect(refundTitle.style?.color, dark ? const Color(0xFFF8F6FF) : Colors.black);
      final refundHeading = find.ancestor(
        of: find.text('Payments & refunds'),
        matching: find.byType(Wrap),
      );
      final refundIcon = tester.widget<Icon>(find.descendant(
        of: refundHeading,
        matching: find.byIcon(Icons.receipt_long_rounded),
      ));
      expect(refundIcon.color, dark ? const Color(0xFFF8F6FF) : Colors.black);
      // Hold the fake Play sheet open only long enough to inspect the loading state.
      await selectAndPay(tester, 'hf_rupees_120');
      await tester.pump(const Duration(milliseconds: 100));
      final spinner = tester.widget<CircularProgressIndicator>(
        find.descendant(of: payButton, matching: find.byType(CircularProgressIndicator)),
      );
      expect(spinner.color, dark ? const Color(0xFFF8F6FF) : Colors.black);
      expect(billing.boughtProductIds, ['hf_rupees_120']);
      billing.emit(const StorePurchase(
        productId: 'hf_rupees_120',
        purchaseToken: '',
        status: StorePurchaseStatus.canceled,
      ));
      await tester.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);
      final notice = tester.widget<Text>(find.descendant(
        of: find.byKey(const ValueKey<String>('purchase-notice')),
        matching: find.byType(Text),
      ).first);
      expect(notice.style?.color, dark ? const Color(0xFFF8F6FF) : Colors.black);
    });
  }

  for (final dark in [false, true]) {
    testWidgets('pack colors survive reordered and omitted catalogue entries (${dark ? 'dark' : 'light'})', (tester) async {
      final api = walletApi()
        ..onJson('GET', '/api/hf/tokens/products', _paletteCatalogue([500, 360, 240]));
      await pumpWallet(tester, api: api, billing: _paletteBilling([360, 500]), dark: dark);
      expect(buyButton('hf_rupees_120'), findsNothing);
      _expectPackPalette(tester, 240, dark: dark, selected: false, available: false);
      _expectPackPalette(tester, 360, dark: dark, selected: true);
      _expectPackPalette(tester, 500, dark: dark, selected: false);
      expect(find.text('Pay ₹360.00 with Google Play'), findsOneWidget);
    });
  }

  late FakeBillingAdapter billing;

  setUp(() => billing = walletBilling());

  testWidgets(
    'a Wallet detour retains context but cannot unlock a call with zero funds',
    (tester) async {
      AccountScope.id = 'user_test';
      addTearDown(() => AccountScope.id = null);
      final api = walletApi(
        wallet: tokenWallet(balance: '0.00', balanceMicro: 0),
      );
      await pumpWallet(
        tester,
        api: api,
        billing: billing,
        query: const {'next': '/call/new?host=asha&lane=lgbtq'},
      );
      final button = tester.widget<HfButton>(
        find.byKey(const ValueKey('wallet-return-to-call')),
      );
      expect(button.onPressed, isNull);
      expect(api.callsTo('POST', '/api/hf/calls'), isEmpty);
    },
  );

  group('rupee wallet', () {
    testWidgets(
      'shows the balance with 2 decimals, test credit and history',
      (tester) async {
        await pumpWallet(tester, api: walletApi(), billing: billing);
        expect(find.text('Balance'), findsOneWidget);
        expect(find.text('₹45.20'), findsOneWidget);
        expect(find.textContaining('worth'), findsNothing);
        expect(find.text('Test credit (spend only): ₹5.00'), findsOneWidget);
        expect(find.text('Call with Asha'), findsOneWidget);
        expect(find.textContaining('4 min'), findsOneWidget);
        expect(find.text('−₹3.20'), findsOneWidget);
        expect(find.text('Added money'), findsOneWidget);
        expect(find.textContaining('Google Play'), findsWidgets);
        expect(find.text('+₹101.69'), findsOneWidget);
        expect(
          find.textContaining(RegExp('token', caseSensitive: false)),
          findsNothing,
        );
      },
    );

    testWidgets('both history row kinds render in the Recent list', (
      tester,
    ) async {
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.text('Recent'), findsOneWidget);
      final history = find.byKey(const ValueKey<String>('history'));
      expect(
        find.descendant(of: history, matching: find.text('Call with Asha')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: history, matching: find.text('A')),
        findsOneWidget,
        reason: 'host tile initial',
      );
      expect(
        find.descendant(of: history, matching: find.byIcon(Icons.add_rounded)),
        findsOneWidget,
        reason: 'top-up plus tile',
      );
      expect(
        find.descendant(of: history, matching: find.text('Added money')),
        findsOneWidget,
      );
    });

    testWidgets('no history says "No activity yet."', (tester) async {
      await pumpWallet(
        tester,
        api: walletApi(wallet: tokenWallet(history: <Object?>[])),
        billing: billing,
      );
      expect(find.text('No activity yet.'), findsOneWidget);
    });

    String minutesText(WidgetTester tester) => tester
        .widget<Text>(find.byKey(const ValueKey<String>('balance-minutes')))
        .data!;

    String cachedHosts(List<int> prices) => jsonEncode({
      'at': DateTime.now().toIso8601String(),
      'data': {
        'key': 'k',
        'page': {
          'items': [
            for (var i = 0; i < prices.length; i++)
              {
                'slug': 'h$i',
                'displayName': 'Host $i',
                'pricePerMin': prices[i],
              },
          ],
          'total': prices.length,
        },
      },
    });

    testWidgets('the rate saved from the last call wins', (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        scopedKey('hf.last_call_rate.v1'): 15.0,
        kExploreCacheKey: cachedHosts([4]),
      });
      await pumpWallet(tester, api: walletApi(), billing: billing);
      // 45.20 / 15 = 3.01
      expect(minutesText(tester), 'About 3 minutes at ₹15.00/min');
    });

    testWidgets('with no call yet, the cheapest cached host sets the rate', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        kExploreCacheKey: cachedHosts([12, 9, 20]),
        kOnlineCacheKey: cachedHosts([7, 30]),
      });
      await pumpWallet(tester, api: walletApi(), billing: billing);
      // 45.20 / 7 = 6.45
      expect(minutesText(tester), 'About 6 minutes at ₹7.00/min');
    });

    testWidgets('an unknown rate does not invent a minutes estimate', (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.text('₹45.20'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('balance-minutes')), findsNothing);
    });

    testWidgets('a zero balance says how to start', (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await pumpWallet(
        tester,
        api: walletApi(
          wallet: tokenWallet(
            balance: '0.00',
            balanceMicro: 0,
            testTokens: '0.00',
          ),
        ),
        billing: billing,
      );
      expect(find.text('₹0.00'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('balance-minutes')), findsNothing);
      expect(
        find.text('No money in your wallet yet. Add money below to start calling.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'no test tokens line when there are none; an empty wallet says how to start',
      (tester) async {
        await pumpWallet(
          tester,
          api: walletApi(
            wallet: tokenWallet(
              balance: '0.00',
              balanceMicro: 0,
              testTokens: '0.00',
            ),
          ),
          billing: billing,
        );
        expect(find.byKey(const ValueKey<String>('test-tokens')), findsNothing);
        expect(
          find.text(
            'No money in your wallet yet. Add money below to start calling.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'old lots of other values are not listed per value: the wallet is one rupee number',
      (tester) async {
        final w = tokenWallet(balance: '60.00', balanceMicro: 60000000);
        (w['tokens'] as Map)['byValue'] = [
          {'valuePaisePerToken': 82, 'tokens': '45.20', 'micro': 45200000},
          {'valuePaisePerToken': 90, 'tokens': '14.80', 'micro': 14800000},
        ];
        await pumpWallet(
          tester,
          api: walletApi(wallet: w),
          billing: billing,
        );
        expect(find.textContaining('worth'), findsNothing);
        expect(find.text('₹60.00'), findsOneWidget);
      },
    );

    testWidgets('tokens held for a call are explained', (tester) async {
      final w = tokenWallet();
      (w['tokens'] as Map)['availableMicro'] = 30000000;
      (w['tokens'] as Map)['available'] = '30.00';
      await pumpWallet(
        tester,
        api: walletApi(wallet: w),
        billing: billing,
      );
      expect(
        find.text(
          '₹30.00 is free to spend. The rest is held for a call in progress.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'debt banner: what is owed and that the next purchase clears it',
      (tester) async {
        final w = tokenWallet(
          debt: {
            'tokens': '12.50',
            'micro': 12500000,
            'valuePaise': 1025,
            'open': true,
          },
        );
        await pumpWallet(
          tester,
          api: walletApi(wallet: w),
          billing: billing,
        );
        expect(
          find.byKey(const ValueKey<String>('debt-banner')),
          findsOneWidget,
        );
        expect(find.text('You owe ₹10.25 after a refund.'), findsOneWidget);
        expect(
          find.text(
            'Your next purchase clears it first. Calls stay paused until then.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('no debt banner when nothing is owed', (tester) async {
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(find.byKey(const ValueKey<String>('debt-banner')), findsNothing);
    });

    testWidgets(
      'purchase records fall back to the purchase lines of the history (no order id yet)',
      (tester) async {
        await pumpWallet(tester, api: walletApi(), billing: billing);
        expect(find.byKey(const ValueKey<String>('purchases')), findsOneWidget);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey<String>('purchases')),
            matching: find.text('Paid via Google Play'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('purchases[] from the server shows the order id', (
      tester,
    ) async {
      final w = tokenWallet(
        purchases: [
          {
            'orderId': 'GPA.3300-1',
            'productId': 'hf_tokens_100',
            'tokens': 100,
            'paidPaise': 10000,
            'at': 1760000000000,
            'state': 'consumed',
          },
        ],
      );
      await pumpWallet(
        tester,
        api: walletApi(wallet: w),
        billing: billing,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey<String>('purchases')),
          matching: find.text('Paid via Google Play'),
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Order GPA.3300-1'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey<String>('purchases')),
          matching: find.text('₹100.00'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('purchase row shows gross paid and opens real charge details', (
      tester,
    ) async {
      final w = tokenWallet(
        purchases: [
          {
            'orderId': 'GPA.240-1',
            'productId': 'hf_rupees_240',
            'paidPaise': 24000,
            'gstPaise': 3661,
            'walletPaise': 20339,
            'at': 1760000000000,
            'state': 'consumed',
          },
        ],
      );
      await pumpWallet(tester, api: walletApi(wallet: w), billing: billing);
      final section = find.byKey(const ValueKey<String>('purchases'));
      expect(
        find.descendant(of: section, matching: find.text('₹240.00')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: section, matching: find.text('₹203.39')),
        findsNothing,
      );

      await tester.tap(find.descendant(of: section, matching: find.text('Paid via Google Play')));
      await tester.pumpAndSettle();
      expect(find.text('Google Play purchase'), findsOneWidget);
      expect(find.text('GST included'), findsOneWidget);
      expect(find.text('₹36.61'), findsOneWidget);
      expect(find.text('Added to wallet'), findsOneWidget);
      expect(find.text('₹203.39'), findsOneWidget);
    });

    testWidgets('the wallet is read live every time it opens: no cache', (
      tester,
    ) async {
      final api = walletApi();
      await pumpWallet(tester, api: api, billing: billing);
      expect(api.callsTo('GET', '/api/hf/wallet'), hasLength(1));
    });
  });

  group('old rupee wallet (tokens off)', () {
    testWidgets(
      'renders rupees, test credits, history, and says adding money is coming soon',
      (tester) async {
        final api = walletApi(wallet: legacyWallet(), productsEnabled: false)
          ..onJson('GET', '/api/hf/wallet/receipts', {
            'ok': true,
            'receipts': [
              {
                'id': 'hfr_1',
                'number': 'R-0001',
                'kind': 'topup',
                'source': 'razorpay',
                'amountRupees': 100,
                'issuedAt': 1760000000000,
              },
            ],
          });
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('₹250.00'), findsOneWidget);
        expect(find.text('Test credits (spend only): ₹40.00'), findsOneWidget);
        expect(find.text('−₹40.00'), findsOneWidget);
        expect(find.text('Adding money is coming soon'), findsOneWidget);
        expect(
          find.byKey(const ValueKey<String>('purchases')),
          findsNothing,
          reason: 'purchase records are a token-mode section',
        );
        expect(find.text('Receipt R-0001'), findsOneWidget);
        expect(billing.boughtProductIds, isEmpty);
      },
    );

    testWidgets(
      '"Adding money is coming soon" also when the products route says enabled:false in token mode',
      (tester) async {
        await pumpWallet(
          tester,
          api: walletApi(productsEnabled: false),
          billing: billing,
        );
        expect(find.text('Adding money is coming soon'), findsOneWidget);
        expect(
          buyButton('hf_rupees_120'),
          findsNothing,
        );
      },
    );
  });

  group('states', () {
    testWidgets('a guest is asked to sign in and nothing is fetched', (
      tester,
    ) async {
      final api = walletApi();
      await pumpWallet(
        tester,
        api: api,
        billing: billing,
        session: signedOutState(),
      );
      expect(find.text('Please sign in to see your wallet.'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
      expect(api.callsTo('GET', '/api/hf/wallet'), isEmpty);
    });

    testWidgets(
      'the wallet route off (404 not_enabled) shows Coming soon, not an error',
      (tester) async {
        final api = walletApi()
          ..onError(
            'GET',
            '/api/hf/wallet',
            const ApiError(status: 404, code: 'not_enabled'),
          );
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('Coming soon'), findsOneWidget);
      },
    );

    testWidgets('an error shows the message and Try again reloads', (
      tester,
    ) async {
      var fail = true;
      final api = walletApi()
        ..on('GET', '/api/hf/wallet', (_) {
          if (fail) {
            throw const ApiError(
              status: 502,
              code: 'wallet_error',
              message: 'We could not read your wallet.',
            );
          }
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
      final api = walletApi()
        ..onError('GET', '/api/hf/wallet', ApiError.network());
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });

    testWidgets(
      'Google Play missing on the device: packs are not buyable and it says why',
      (tester) async {
        billing.available = false;
        await pumpWallet(tester, api: walletApi(), billing: billing);
        expect(
          find.text(
            'Google Play is not available on this device, so you cannot add money here.',
          ),
          findsOneWidget,
        );
        final b = tester.widget<ElevatedButton>(
          find.descendant(of: payButton, matching: find.byType(ElevatedButton)),
        );
        expect(b.onPressed, isNull);
      },
    );

    testWidgets('Play prices that cannot load say so, with Try again', (
      tester,
    ) async {
      billing.queryError = StateError('play down');
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(
        find.text('We could not load the prices from Google Play.'),
        findsOneWidget,
      );
      expect(find.text('Not available'), findsNWidgets(2));
    });

    testWidgets('the products route failing shows a message and Try again', (
      tester,
    ) async {
      final api = walletApi()
        ..onError('GET', '/api/hf/tokens/products', ApiError.network());
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });
  });

  group('refunds', () {
    Map<String, Object?> refundsTokens({
      List<Object?>? lots,
      List<Object?>? requests,
    }) => {
      'enabled': true,
      'mode': 'tokens',
      'windowDays': 180,
      'refundable': 82,
      'eligible': 82,
      'lots':
          lots ??
          [
            {
              'lotId': 'lot_1',
              'tokens': '100.00',
              'paid': 100,
              'refund': 82,
              'wholeOrder': true,
              'boughtAt': 1760000000000,
            },
          ],
      'requests': requests ?? <Object?>[],
    };

    testWidgets(
      'refunds off: the Google Play way, a link to order history, and the support email',
      (tester) async {
        final links = _RecordingLinks();
        LinkOpener.instance = links;
        addTearDown(() => LinkOpener.instance = const LinkOpener());
        await pumpWallet(tester, api: walletApi(), billing: billing);
        expect(find.text('Refunds'), findsOneWidget);
        expect(find.textContaining('refunded by Google'), findsOneWidget);
        expect(find.textContaining(Brand.supportEmail), findsOneWidget);
        expect(find.text('Ask for a refund'), findsNothing);
        await tester.tap(
          find.byKey(const ValueKey<String>('play-order-history')),
        );
        await tester.pumpAndSettle();
        expect(links.opened, hasLength(1));
        expect(links.opened.single.host, 'play.google.com');
        expect(links.opened.single.path, '/store/account/orderhistory');
      },
    );

    testWidgets(
      'unused purchased tokens: the lot, what comes back, and the window',
      (tester) async {
        await pumpWallet(
          tester,
          api: walletApi(refunds: refundsTokens()),
          billing: billing,
        );
        expect(
          find.text(
            'You can ask for a refund of unused wallet money within 180 days of buying them.',
          ),
          findsOneWidget,
        );
        expect(find.text('₹100.00 unused'), findsOneWidget);
        expect(
          find.text('You paid ₹100.00. Refund: ₹82.00'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'asking for a refund: confirm, then POST with the lot and an Idempotency-Key',
      (tester) async {
        final api = walletApi(refunds: refundsTokens())
          ..onJson('POST', '/api/hf/wallet/refunds', {
            'ok': true,
            'id': 'req_9',
            'ids': ['req_9'],
            'status': 'requested',
            'amount': 82,
          });
        await pumpWallet(tester, api: api, billing: billing);
        await tester.tap(find.byKey(const ValueKey<String>('refund-lot_1')));
        await tester.pumpAndSettle();
        expect(find.text('Ask for a refund?'), findsOneWidget);
        expect(
          api.callsTo('POST', '/api/hf/wallet/refunds'),
          isEmpty,
          reason: 'nothing is sent before the answer',
        );
        await tester.tap(find.text('Yes, ask'));
        await tester.pumpAndSettle();
        final calls = api.callsTo('POST', '/api/hf/wallet/refunds');
        expect(calls, hasLength(1));
        expect(calls.single.body, {'lotId': 'lot_1'});
        expect(calls.single.idempotencyKey, startsWith('hfw-'));
        expect(
          find.text('Refund requested. We will check it and tell you here.'),
          findsOneWidget,
        );
      },
    );

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
        ..onError(
          'POST',
          '/api/hf/wallet/refunds',
          const ApiError(
            status: 409,
            code: 'active_call',
            message: 'Finish your call first.',
          ),
        );
      await pumpWallet(tester, api: api, billing: billing);
      await tester.tap(find.byKey(const ValueKey<String>('refund-lot_1')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, ask'));
      await tester.pumpAndSettle();
      expect(find.text('Finish your call first.'), findsOneWidget);
    });

    testWidgets('nothing refundable says so', (tester) async {
      await pumpWallet(
        tester,
        api: walletApi(refunds: refundsTokens(lots: <Object?>[])),
        billing: billing,
      );
      expect(
        find.text(
          'You have no unused wallet money that can be refunded right now.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'requests are listed with their status, and a waiting one can be cancelled',
      (tester) async {
        final api =
            walletApi(
              refunds: refundsTokens(
                requests: [
                  {
                    'id': 'req_1',
                    'amount': 50,
                    'status': 'requested',
                    'reason': null,
                    'createdAt': 1760000000000,
                  },
                  {
                    'id': 'req_0',
                    'amount': 20,
                    'status': 'rejected',
                    'reason': 'Money was already used.',
                    'createdAt': 1750000000000,
                  },
                ],
              ),
            )..onJson('POST', '/api/hf/wallet/refunds/req_1/cancel', {
              'ok': true,
              'status': 'cancelled',
            });
        await pumpWallet(tester, api: api, billing: billing);
        expect(find.text('₹50.00 · Waiting for review'), findsOneWidget);
        expect(find.text('₹20.00 · Not approved'), findsOneWidget);
        expect(find.text('Money was already used.'), findsOneWidget);
        expect(
          find.text('Cancel request'),
          findsOneWidget,
          reason: 'only the waiting one',
        );
        await tester.ensureVisible(find.text('Cancel request'));
        await tester.pump();
        expect(find.text('Cancel request').hitTestable(), findsOneWidget);
        await tester.tap(find.text('Cancel request'));
        await tester.pumpAndSettle();
        expect(
          api.callsTo('POST', '/api/hf/wallet/refunds/req_1/cancel'),
          hasLength(1),
        );
      },
    );

    testWidgets('old rupee money: one request for the unused amount', (
      tester,
    ) async {
      final api =
          walletApi(
            wallet: legacyWallet(),
            productsEnabled: false,
            refunds: {
              'enabled': true,
              'windowDays': 180,
              'refundable': 120,
              'eligible': 120,
              'requests': <Object?>[],
            },
          )..onJson('POST', '/api/hf/wallet/refunds', {
            'ok': true,
            'id': 'req_5',
            'status': 'requested',
            'amount': 120,
          });
      await pumpWallet(tester, api: api, billing: billing);
      expect(find.text('Unused money that can go back: ₹120.00'), findsOneWidget);
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
    test('rupee wallet keeps paise, reserves, debt and purchase amounts', () {
      final d = WalletData.fromJson(
        rupeeWallet(
          balancePaise: 10169,
          availablePaise: 10000,
          testPaise: 0,
          debtPaise: 5,
        ),
      );
      expect(d.rupeeMode, isTrue);
      expect(d.spendablePaise, 10000);
      expect(d.reservedPaise, 169);
      expect(d.hasDebt, isTrue);
      expect(d.history.first.amountText, '+₹101.69');
      expect(d.purchases.single.amounts!.line,
          'Total ₹120.00 · GST included ₹18.31 · Added to wallet ₹101.69');
    });

    test('GST-inclusive pack split uses integer paise', () {
      final split = splitGstInclusive(12000);
      expect(split.walletPaise, 10169);
      expect(split.gstPaise, 1831);
      expect(split.walletPaise + split.gstPaise, split.paidPaise);
    });

    test('verify response exposes the public rupee breakdown', () {
      final result = VerifyResult.fromJson(verifyAnswer());
      expect(result.breakdownLine,
          'Total ₹120.00 · GST included ₹18.31 · Added to wallet ₹101.69');
    });

    test(
      'the server\'s token strings are shown as sent when micro amounts are missing',
      () {
        final d = WalletData.fromJson({
          'mode': 'tokens',
          'tokens': {
            'balance': '12.30',
            'available': '12.30',
            'testTokens': '0.00',
            'byValue': [
              {'valuePaisePerToken': 82, 'tokens': '12.30'},
            ],
            'debt': {
              'tokens': '0.00',
              'micro': 0,
              'valuePaise': 0,
              'open': false,
            },
          },
          'history': [],
        });
        expect(d.tokenMode, isTrue);
        expect(d.balanceText, '12.30');
        expect(d.byValue.single.micro, 12300000);
        expect(d.hasDebt, isFalse);
      },
    );

    test('a body without "mode" is the old rupee shape', () {
      final d = WalletData.fromJson({
        'paidBalance': 10,
        'testBalance': 0,
        'spendable': 10,
        'history': [],
      });
      expect(d.tokenMode, isFalse);
      expect(d.paidBalance, 10);
    });

    test('debt is open for any positive owed value', () {
      expect(
        TokenDebt.fromJson({
          'tokens': '0.10',
          'micro': 100000,
          'valuePaise': 0,
        }).open,
        isTrue,
      );
      expect(
        TokenDebt.fromJson({
          'tokens': '0.00',
          'micro': 0,
          'valuePaise': 0,
        }).open,
        isFalse,
      );
      expect(TokenDebt.fromJson(null).open, isFalse);
    });

    test('verify statuses', () {
      expect(VerifyResult.fromJson({'status': 'consumed'}).isCredited, isTrue);
      expect(VerifyResult.fromJson({'status': 'credited'}).isCredited, isTrue);
      expect(
        VerifyResult.fromJson({'status': 'pending'}).status,
        VerifyStatus.pending,
      );
      expect(
        VerifyResult.fromJson({'status': 'canceled'}).status,
        VerifyStatus.canceled,
      );
      expect(
        VerifyResult.fromJson({'status': 'refunded'}).status,
        VerifyStatus.refunded,
      );
      expect(
        VerifyResult.fromJson({'status': 'duplicate'}).status,
        VerifyStatus.unknown,
      );
    });

    test('tokensPlain drops .00 only', () {
      expect(tokensPlain(100), '₹100');
      expect(tokensPlain(1), '₹1');
      expect(tokensPlain(45.2), '₹45.20');
      expect(tokensPlain(1000), '₹1,000');
    });

    test(
      'the Are-you-sure price: Play\'s rupees first, the catalogue price as a fallback, unknown otherwise',
      () {
        const pack = TokenPack(
          productId: 'p',
          tokens: 1000,
          purchasePaisePerToken: 100,
        );
        expect(
          packPricePaise(
            const PackOffer(
              pack: pack,
              store: StoreProduct(
                productId: 'p',
                priceText: '₹1,000.00',
                currencyCode: 'INR',
                priceMicros: 1000000000,
              ),
            ),
          ),
          100000,
        );
        expect(
          packPricePaise(
            const PackOffer(
              pack: pack,
              store: StoreProduct(
                productId: 'p',
                priceText: 'US\$12.00',
                currencyCode: 'USD',
                priceMicros: 12000000,
              ),
            ),
          ),
          100000,
          reason: 'not rupees: the catalogue price decides',
        );
        expect(packPricePaise(const PackOffer(pack: pack)), 100000);
        expect(
          packPricePaise(
            const PackOffer(pack: TokenPack(productId: 'p', tokens: 100)),
          ),
          isNull,
        );
      },
    );
  });
}
