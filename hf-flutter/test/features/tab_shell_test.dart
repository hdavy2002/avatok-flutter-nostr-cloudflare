import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/tab_shell.dart';

import '../support/app_harness.dart';

Finder tabLabel(String label) =>
    find.descendant(of: find.byType(HfTabBar), matching: find.text(label));

void main() {
  testWidgets('a guest sees Home, Explore, Wallet and Me, and no Host tab', (tester) async {
    await pumpApp(tester);
    expect(find.byType(HfTabBar), findsOneWidget);
    for (final l in ['Home', 'Explore', 'Wallet', 'Me']) {
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
    await tester.tap(find.byKey(const ValueKey<String>('tab-explore')));
    await tester.pumpAndSettle();
    expect(find.text('This screen is built in HF-NATIVE-3.'), findsOneWidget);
    expect(find.text('Explore'), findsWidgets);
  });

  testWidgets('Wallet needs sign-in: a guest lands on sign-in with next', (tester) async {
    final c = await pumpApp(tester);
    await tester.tap(find.byKey(const ValueKey<String>('tab-wallet')));
    await tester.pumpAndSettle();
    expect(find.text('This screen is built in HF-NATIVE-2.'), findsOneWidget);
    expect(find.text('next: /wallet'), findsOneWidget);
    expect(c.read(appRouterProvider).routeInformationProvider.value.uri.path, '/sign-in');
  });

  testWidgets('Wallet opens for a signed-in person', (tester) async {
    await pumpApp(tester, session: signedInState());
    await tester.tap(find.byKey(const ValueKey<String>('tab-wallet')));
    await tester.pumpAndSettle();
    expect(find.text('This screen is built in HF-NATIVE-6.'), findsOneWidget);
  });

  testWidgets('Explore and host profiles open without an account', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/h/asha');
    await tester.pumpAndSettle();
    expect(find.text('slug: asha'), findsOneWidget);
  });

  testWidgets('a call link for a guest goes to sign-in, then keeps the target', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/call/abc');
    await tester.pumpAndSettle();
    expect(find.text('next: /call/abc'), findsOneWidget);
  });

  testWidgets('a review token link needs no account', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/review/tok123');
    await tester.pumpAndSettle();
    expect(find.text('token: tok123'), findsOneWidget);
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
    for (final l in ['Home', 'Explore', 'Wallet', 'Host', 'Me']) {
      final text = tester.widget<Text>(tabLabel(l));
      final style = DefaultTextStyle.of(tester.element(tabLabel(l))).style.merge(text.style);
      expect(style.fontSize, greaterThanOrEqualTo(14), reason: l);
    }
  });
}
