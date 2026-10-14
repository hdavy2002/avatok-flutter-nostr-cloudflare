import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/format/money.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/wallet/billing/billing_adapter.dart';
import 'package:hf_app/features/wallet/ui/wallet_screen.dart';
import 'package:hf_app/features/wallet/wallet_providers.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_billing.dart';

Map<String, Object?> rupeeWallet({
  int balancePaise = 4520,
  int availablePaise = -1,
  int testPaise = 500,
  int debtPaise = 0,
  List<Object?>? history,
}) {
  final available = availablePaise < 0 ? balancePaise : availablePaise;
  return {
    'mode': 'rupees',
    'wallet': {
      'currency': 'INR',
      'balancePaise': balancePaise,
      'availablePaise': available,
      'reservedPaise': balancePaise - available,
      'paidPaise': balancePaise - testPaise,
      'testPaise': testPaise,
      'debtPaise': debtPaise,
      'debtOpen': debtPaise > 0,
    },
    'history': history ??
        [
          {
            'at': 1760000000000,
            'kind': 'purchase',
            'amountPaise': 10169,
            'label': 'Money added',
            'purchase': {
              'paidPaise': 12000,
              'gstPaise': 1831,
              'walletPaise': 10169,
              'orderId': 'GPA.1',
            },
          },
          {
            'at': 1760100000000,
            'kind': 'call_spent',
            'amountPaise': -320,
            'label': 'Call with Asha (4 min)',
            'callId': 'c1',
          },
        ],
  };
}

/// A token-mode `GET /api/hf/wallet` answer, shaped like worker/src/routes/hf_calls.ts walletGetTokens.
Map<String, Object?> tokenWallet({
  String balance = '45.20',
  int balanceMicro = 45200000,
  String testTokens = '5.00',
  Map<String, Object?>? debt,
  List<Object?>? history,
  List<Object?>? purchases,
}) => {
  'mode': 'tokens',
  'tokens': {
    'balance': balance,
    'balanceMicro': balanceMicro,
    'testTokens': testTokens,
    'available': balance,
    'availableMicro': balanceMicro,
    'byValue': balanceMicro == 0
        ? <Object?>[]
        : [
            {
              'valuePaisePerToken': 82,
              'valueRupees': '0.82',
              'tokens': balance,
              'micro': balanceMicro,
            },
          ],
    'debt':
        debt ?? {'tokens': '0.00', 'micro': 0, 'valuePaise': 0, 'open': false},
    'activeValuePaisePerToken': 100,
  },
  'history':
      history ??
      [
        {
          'at': 1760000000000,
          'kind': 'purchase',
          'tokens': '+100.00',
          'label': 'Money added',
        },
        {
          'at': 1760100000000,
          'kind': 'call_spent',
          'tokens': '-3.20',
          'label': 'Call with Asha (4 min)',
          'callId': 'c1',
        },
      ],
  if (purchases != null) 'purchases': purchases,
};

Map<String, Object?> legacyWallet() => {
  'balanceRupees': 250,
  'testCredits': true,
  'paidBalance': 250,
  'testBalance': 40,
  'spendable': 290,
  'history': [
    {
      'at': 1760000000000,
      'kind': 'call_spent',
      'rupees': -40,
      'label': 'Call with Asha (4 min)',
      'callId': 'c1',
    },
  ],
};

Map<String, Object?> productsAnswer({bool enabled = true}) => {
  'ok': true,
  'enabled': enabled,
  'gstBps': 1800,
  'products': enabled
      ? [
          {
            'productId': 'hf_rupees_120',
            'pricePaise': 12000,
            'gstPaise': 1831,
            'walletPaise': 10169,
            'creditPaise': 10169,
          },
          {
            'productId': 'hf_rupees_500',
            'pricePaise': 50000,
            'gstPaise': 7627,
            'walletPaise': 42373,
            'creditPaise': 42373,
          },
        ]
      : <Object?>[],
};

/// Approved live catalogue subset; legacy recovery tests keep the generic fake.
FakeBillingAdapter walletBilling() => FakeBillingAdapter(
  products: const {
    'hf_rupees_120': StoreProduct(
      productId: 'hf_rupees_120',
      priceText: '₹120.00',
      currencyCode: 'INR',
      priceMicros: 120000000,
    ),
    'hf_rupees_500': StoreProduct(
      productId: 'hf_rupees_500',
      priceText: '₹500.00',
      currencyCode: 'INR',
      priceMicros: 500000000,
    ),
  },
);

Map<String, Object?> prepareAnswer(String productId) => {
  'ok': true,
  'obfuscatedAccountId': 'acct_hash_1',
  'productId': productId,
  'confirmAbovePaise': 100000,
};

Map<String, Object?> verifyAnswer({
  String productId = 'hf_tokens_100',
  String status = 'consumed',
  bool duplicate = false,
  int paidPaise = 12000,
  int gstPaise = 1831,
  int walletPaise = 10169,
}) => {
  'ok': true,
  'status': status,
  'duplicate': duplicate,
  'orderId': 'GPA.1',
  'productId': productId,
  'paidPaise': paidPaise,
  'gstPaise': gstPaise,
  'walletPaise': walletPaise,
  'paid': formatPaise(paidPaise),
  'gst': formatPaise(gstPaise),
  'wallet': formatPaise(walletPaise),
  'consumed': status == 'consumed',
  'balance': {
    'balancePaise': 4520 + walletPaise,
    'availablePaise': 4520 + walletPaise,
    'debtValuePaise': 0,
    'byValue': <Object?>[],
  },
};

/// A FakeApiClient with every wallet route answered. Override a route with `api.onJson(...)` afterwards.
FakeApiClient walletApi({
  Map<String, Object?>? wallet,
  bool productsEnabled = true,
  Map<String, Object?>? refunds,
}) {
  return FakeApiClient()
    ..onJson('GET', '/api/hf/wallet', wallet ?? rupeeWallet())
    ..onJson(
      'GET',
      '/api/hf/tokens/products',
      productsAnswer(enabled: productsEnabled),
    )
    ..onJson(
      'GET',
      '/api/hf/wallet/refunds',
      refunds ?? {'enabled': false, 'requests': <Object?>[]},
    )
    ..onJson('GET', '/api/hf/wallet/receipts', {
      'ok': true,
      'receipts': <Object?>[],
    })
    ..on(
      'POST',
      '/api/hf/tokens/play/prepare',
      (c) => prepareAnswer('${(c.body as Map)['productId']}'),
    )
    ..on(
      'POST',
      '/api/hf/tokens/play/verify',
      (c) => verifyAnswer(productId: '${(c.body as Map)['productId']}'),
    );
}

/// Pumps the Wallet screen alone, signed in, with a fake API and a fake Play. Failed providers do not retry.
Future<ProviderContainer> pumpWallet(
  WidgetTester tester, {
  required FakeApiClient api,
  required FakeBillingAdapter billing,
  SessionState? session,
  Map<String, String> query = const {},
  bool dark = false,
}) async {
  // A tall phone so the whole list is built and nothing needs scrolling.
  tester.view.physicalSize = const Size(1080, 7000);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final container = ProviderContainer(
    retry: (_, __) => null,
    overrides: [
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
      sessionProvider.overrideWith(
        () => StubSession(session ?? signedInState()),
      ),
      apiClientProvider.overrideWithValue(api),
      billingAdapterProvider.overrideWithValue(billing),
      purchaseRetryDelaysProvider.overrideWithValue(const <Duration>[]),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: dark ? buildHfDarkTheme() : buildHfTheme(),
        home: WalletScreen(query: query),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

/// The pack tile of [productId] (tapping it selects the pack).
Finder buyButton(String productId) =>
    find.byKey(ValueKey<String>('buy-$productId'));

/// The one Pay button under the tiles.
Finder get payButton => find.byKey(const ValueKey<String>('pay-button'));

/// Selects the pack, then taps Pay. Does not settle: callers choose how to pump.
Future<void> selectAndPay(WidgetTester tester, String productId) async {
  await tester.tap(buyButton(productId));
  await tester.pump();
  await tester.tap(payButton);
}
