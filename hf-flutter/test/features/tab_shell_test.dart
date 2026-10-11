import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/features/host_profile/ui/host_profile_screen.dart';
import 'package:hf_app/features/review/ui/review_screen.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/tab_shell.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';

import '../support/app_harness.dart';
import '../support/fake_api_client.dart';

Finder tabLabel(String label) =>
    find.descendant(of: find.byType(HfTabBar), matching: find.text(label));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));
  testWidgets('a guest sees Browse, Wallet and Me, and no Host tab', (tester) async {
    await pumpApp(tester);
    expect(find.byType(HfTabBar), findsOneWidget);
    for (final l in ['Browse', 'Wallet', 'Me']) {
      expect(tabLabel(l), findsOneWidget, reason: l);
    }
    expect(tabLabel('Host'), findsNothing);
  });

  testWidgets('a person with a host profile also sees the Host tab', (tester) async {
    await pumpApp(tester, session: signedInState(host: true));
    expect(tabLabel('Host'), findsOneWidget);
  });

  testWidgets('a signed-in non-host has no Host tab', (tester) async {
    await pumpApp(tester, session: signedInState());
    expect(tabLabel('Host'), findsNothing);
  });

  testWidgets('tapping a tab opens its screen', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.byKey(const ValueKey<String>('tab-home')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('open-filters')), findsOneWidget);
    expect(find.text('Browse'), findsWidgets);
  });

  testWidgets('Wallet needs sign-in: a guest lands on sign-in with next', (tester) async {
    final c = await pumpApp(tester);
    await tester.tap(find.byKey(const ValueKey<String>('tab-wallet')));
    await tester.pumpAndSettle();
    expect(find.text(SignInCopy.numberHint), findsOneWidget);
    final uri = c.read(appRouterProvider).routeInformationProvider.value.uri;
    expect(uri.path, '/sign-in');
    expect(uri.queryParameters['next'], '/wallet');
  });

  testWidgets('Wallet opens for a signed-in person', (tester) async {
    final api = FakeApiClient()
      ..onJson('GET', '/api/hf/wallet', {'paidBalance': 0, 'testBalance': 0, 'spendable': 0, 'history': []})
      ..onJson('GET', '/api/hf/tokens/products', {'ok': true, 'enabled': false, 'products': []})
      ..onJson('GET', '/api/hf/wallet/refunds', {'enabled': false, 'requests': []})
      ..onJson('GET', '/api/hf/wallet/receipts', {'ok': true, 'receipts': []});
    final container = await pumpApp(tester, session: signedInState(), api: api);
    await tester.tap(find.byKey(const ValueKey<String>('tab-wallet')));
    await tester.pumpAndSettle();
    expect(container.read(appRouterProvider).routeInformationProvider.value.uri.path, '/wallet');
    await tester.scrollUntilVisible(find.text('Your balance'), 200, scrollable: find.byType(Scrollable).last);
    expect(find.text('Your balance'), findsOneWidget);
    expect(api.callsTo('GET', '/api/hf/wallet'), hasLength(1));
  });

  testWidgets('Explore and host profiles open without an account', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/h/asha');
    await tester.pumpAndSettle();
    expect(find.byType(HostProfileScreen), findsOneWidget); // no sign-in redirect
  });

  testWidgets('a call link for a guest goes to sign-in, then keeps the target', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/call/abc');
    await tester.pumpAndSettle();
    expect(find.text(SignInCopy.numberHint), findsOneWidget);
    expect(c.read(appRouterProvider).routeInformationProvider.value.uri.queryParameters['next'], '/call/abc');
  });

  testWidgets('a review token link needs no account', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/review/tok123');
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget); // no sign-in redirect
  });

  testWidgets('the tab bar survives the largest system font without overflow', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await pumpApp(tester, session: signedInState(host: true));
    expect(tester.takeException(), isNull);
    expect(find.byType(HfTabBar), findsOneWidget);
  });

  testWidgets('every tab label is at least 14 sp', (tester) async {
    await pumpApp(tester, session: signedInState(host: true));
    for (final l in ['Browse', 'Wallet', 'Host', 'Me']) {
      final text = tester.widget<Text>(tabLabel(l));
      final style = DefaultTextStyle.of(tester.element(tabLabel(l))).style.merge(text.style);
      expect(style.fontSize, greaterThanOrEqualTo(14), reason: l);
    }
  });
}
