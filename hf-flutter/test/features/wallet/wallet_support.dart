import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/wallet/ui/wallet_screen.dart';
import 'package:hf_app/features/wallet/wallet_providers.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_billing.dart';

/// A token-mode `GET /api/hf/wallet` answer, shaped like worker/src/routes/hf_calls.ts walletGetTokens.
Map<String, Object?> tokenWallet({
  String balance = '45.20',
  int balanceMicro = 45200000,
  String testTokens = '5.00',
  Map<String, Object?>? debt,
  List<Object?>? history,
  List<Object?>? purchases,
}) =>
    {
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
                {'valuePaisePerToken': 82, 'valueRupees': '0.82', 'tokens': balance, 'micro': balanceMicro},
              ],
        'debt': debt ?? {'tokens': '0.00', 'micro': 0, 'valuePaise': 0, 'open': false},
        'activeValuePaisePerToken': 100,
      },
      'history': history ??
          [
            {'at': 1760000000000, 'kind': 'purchase', 'tokens': '+100.00', 'label': 'Money added'},
            {'at': 1760100000000, 'kind': 'call_spent', 'tokens': '-3.20', 'label': 'Call with Asha (4 min)', 'callId': 'c1'},
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
        {'at': 1760000000000, 'kind': 'call_spent', 'rupees': -40, 'label': 'Call with Asha (4 min)', 'callId': 'c1'},
      ],
    };

Map<String, Object?> productsAnswer({bool enabled = true}) => {
      'ok': true,
      'enabled': enabled,
      'products': enabled
          ? [
              {'productId': 'hf_tokens_100', 'tokens': 102, 'pricingVersion': 'gp-r1', 'redemptionPaisePerToken': 100, 'purchasePaisePerToken': 118, 'creditPaise': 10200},
              {'productId': 'hf_tokens_1000', 'tokens': 1020, 'pricingVersion': 'gp-r1', 'redemptionPaisePerToken': 100, 'purchasePaisePerToken': 118, 'creditPaise': 102000},
            ]
          : <Object?>[],
    };

Map<String, Object?> prepareAnswer(String productId) => {
      'ok': true,
      'obfuscatedAccountId': 'acct_hash_1',
      'productId': productId,
      'tokens': productId == 'hf_tokens_1000' ? 1020 : 102,
      'confirmAbovePaise': 100000,
    };

Map<String, Object?> verifyAnswer({String status = 'consumed', bool duplicate = false, num tokens = 102}) => {
      'ok': true,
      'status': status,
      'duplicate': duplicate,
      'orderId': 'GPA.1',
      'productId': 'hf_tokens_100',
      'tokens': tokens,
      'paidPaise': 12000,
      'consumed': status == 'consumed',
      'balance': {'totalTokens': 145.2, 'availableTokens': 145.2, 'debtValuePaise': 0, 'byValue': <Object?>[]},
    };

/// A FakeApiClient with every wallet route answered. Override a route with `api.onJson(...)` afterwards.
FakeApiClient walletApi({Map<String, Object?>? wallet, bool productsEnabled = true, Map<String, Object?>? refunds}) {
  return FakeApiClient()
    ..onJson('GET', '/api/hf/wallet', wallet ?? tokenWallet())
    ..onJson('GET', '/api/hf/tokens/products', productsAnswer(enabled: productsEnabled))
    ..onJson('GET', '/api/hf/wallet/refunds', refunds ?? {'enabled': false, 'requests': <Object?>[]})
    ..onJson('GET', '/api/hf/wallet/receipts', {'ok': true, 'receipts': <Object?>[]})
    ..on('POST', '/api/hf/tokens/play/prepare', (c) => prepareAnswer('${(c.body as Map)['productId']}'))
    ..onJson('POST', '/api/hf/tokens/play/verify', verifyAnswer());
}

/// Pumps the Wallet screen alone, signed in, with a fake API and a fake Play. Failed providers do not retry.
Future<ProviderContainer> pumpWallet(
  WidgetTester tester, {
  required FakeApiClient api,
  required FakeBillingAdapter billing,
  SessionState? session,
}) async {
  // A tall phone so the whole list is built and nothing needs scrolling.
  tester.view.physicalSize = const Size(1080, 7000);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final container = ProviderContainer(
    retry: (_, __) => null,
    overrides: [
      sessionProvider.overrideWith(() => StubSession(session ?? signedInState())),
      apiClientProvider.overrideWithValue(api),
      billingAdapterProvider.overrideWithValue(billing),
      purchaseRetryDelaysProvider.overrideWithValue(const <Duration>[]),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp(theme: buildHfTheme(), home: const WalletScreen()),
  ));
  await tester.pumpAndSettle();
  return container;
}

Finder buyButton(String productId) => find.byKey(ValueKey<String>('buy-$productId'));
