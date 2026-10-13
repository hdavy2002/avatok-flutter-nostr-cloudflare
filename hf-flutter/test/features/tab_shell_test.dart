import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/features/host_profile/ui/host_profile_screen.dart';
import 'package:hf_app/features/review/ui/review_screen.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/tab_shell.dart';
import 'package:hf_app/core/widgets/hf_floating_nav.dart';
import 'package:hf_app/features/me/data/notification_control.dart';

import 'package:hf_app/features/auth/ui/sign_in_screen.dart';

import 'me/me_test_support.dart' show FakeNotificationControl;

import '../support/app_harness.dart';
import '../support/fake_api_client.dart';

Finder tabLabel(String label) =>
    find.descendant(of: find.byType(HfFloatingNav), matching: find.text(label));

/// A nav item by its key (idle items show only an icon; their name is the semantics label).
Finder tabItem(String key) => find.byKey(ValueKey<String>(key));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));
  testWidgets('a guest sees Browse, Wallet and Me, and no Host tab', (
    tester,
  ) async {
    await pumpApp(tester);
    expect(find.byType(HfFloatingNav), findsOneWidget);
    for (final k in ['tab-home', 'tab-wallet', 'tab-me']) {
      expect(tabItem(k), findsOneWidget, reason: k);
    }
    expect(tabItem('tab-host'), findsNothing);
    // The selected item (Browse) is the tinted pill with its label; the others are icon buttons.
    expect(tabLabel('Discover'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('nav-selected')), findsOneWidget);
    expect(tabLabel('Wallet'), findsNothing);
  });

  testWidgets('a person with a host profile also sees the Host tab', (
    tester,
  ) async {
    await pumpApp(tester, session: signedInState(host: true));
    expect(tabItem('tab-host'), findsOneWidget);
  });

  testWidgets('a signed-in non-host has no Host tab', (tester) async {
    await pumpApp(tester, session: signedInState());
    expect(tabItem('tab-host'), findsNothing);
  });

  testWidgets(
    'the shell lets screens scroll under the bar and exposes the reserved space',
    (tester) async {
      await pumpApp(tester);
      expect(
        tester
            .widget<Scaffold>(
              find
                  .ancestor(
                    of: find.byType(HfFloatingNav),
                    matching: find.byType(Scaffold),
                  )
                  .first,
            )
            .extendBody,
        isTrue,
      );
      expect(kHfNavReserved, 88);
      late double pad;
      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(),
          child: Builder(
            builder: (c) {
              pad = hfNavPadding(c);
              return const SizedBox();
            },
          ),
        ),
      );
      expect(pad, 88 + 12);
    },
  );

  testWidgets('tapping a tab opens its screen', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.byKey(const ValueKey<String>('tab-home')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('open-filters')), findsOneWidget);
    expect(find.text('Discover'), findsWidgets);
  });

  testWidgets('Wallet needs sign-in: a guest lands on sign-in with next', (
    tester,
  ) async {
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
      ..onJson('GET', '/api/hf/wallet', {
        'paidBalance': 0,
        'testBalance': 0,
        'spendable': 0,
        'history': [],
      })
      ..onJson('GET', '/api/hf/tokens/products', {
        'ok': true,
        'enabled': false,
        'products': [],
      })
      ..onJson('GET', '/api/hf/wallet/refunds', {
        'enabled': false,
        'requests': [],
      })
      ..onJson('GET', '/api/hf/wallet/receipts', {'ok': true, 'receipts': []});
    final container = await pumpApp(tester, session: signedInState(), api: api);
    await tester.tap(find.byKey(const ValueKey<String>('tab-wallet')));
    await tester.pumpAndSettle();
    expect(
      container.read(appRouterProvider).routeInformationProvider.value.uri.path,
      '/wallet',
    );
    await tester.scrollUntilVisible(
      find.text('Balance'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Balance'), findsWidgets);
    expect(
      api.callsTo('GET', '/api/hf/wallet'),
      isNotEmpty,
    ); // the rebuilt wallet screen fetches it twice
  });

  testWidgets('Explore and host profiles open without an account', (
    tester,
  ) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/h/asha');
    await tester.pumpAndSettle();
    expect(
      find.byType(HostProfileScreen),
      findsOneWidget,
    ); // no sign-in redirect
  });

  testWidgets(
    'a call link for a guest goes to sign-in, then keeps the target',
    (tester) async {
      final c = await pumpApp(tester);
      c.read(appRouterProvider).go('/call/abc');
      await tester.pumpAndSettle();
      expect(find.text(SignInCopy.numberHint), findsOneWidget);
      expect(
        c
            .read(appRouterProvider)
            .routeInformationProvider
            .value
            .uri
            .queryParameters['next'],
        '/call/abc',
      );
    },
  );

  testWidgets('a review token link needs no account', (tester) async {
    final c = await pumpApp(tester);
    c.read(appRouterProvider).go('/review/tok123');
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget); // no sign-in redirect
  });

  testWidgets('the tab bar survives the largest system font without overflow', (
    tester,
  ) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await pumpApp(tester, session: signedInState(host: true));
    expect(tester.takeException(), isNull);
    expect(find.byType(HfFloatingNav), findsOneWidget);
  });

  for (final host in [false, true]) {
    testWidgets('Me shows all labels at 320 px and 2x text (host: $host)', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final c = await pumpApp(tester, location: '/me', session: signedInState(host: host),
        overrides: [notificationControlProvider.overrideWithValue(FakeNotificationControl())]);
      tester.view.physicalSize = const Size(960, 2400);
      tester.view.viewPadding = const FakeViewPadding(bottom: 72);
      tester.view.padding = const FakeViewPadding(bottom: 72);
      addTearDown(tester.view.resetViewPadding);
      addTearDown(tester.view.resetPadding);
      await tester.pumpAndSettle();
      expect(tester.widget<HfFloatingNav>(find.byType(HfFloatingNav)).profileStyle, isTrue);
      for (final label in ['Discover', 'Wallet', 'Me', if (host) 'Host']) {
        expect(tabLabel(label), findsOneWidget);
        expect(tester.widget<Text>(tabLabel(label)).maxLines, isNull);
      }
      for (final key in ['tab-home', 'tab-wallet', 'tab-me', if (host) 'tab-host']) {
        expect(tester.getSize(tabItem(key)).height, greaterThanOrEqualTo(48));
      }
      expect(tabItem('tab-host'), host ? findsOneWidget : findsNothing);
      expect(tester.takeException(), isNull);
      await tester.tap(tabItem(host ? 'tab-host' : 'tab-home'));
      await tester.pumpAndSettle();
      expect(c.read(appRouterProvider).routeInformationProvider.value.uri.path,
          host ? '/host' : '/');
      expect(tester.widget<HfFloatingNav>(find.byType(HfFloatingNav)).profileStyle, isFalse);
    });
  }

  testWidgets('the selected tab label is at least 14 sp', (tester) async {
    await pumpApp(tester, session: signedInState(host: true));
    // The test font (Ahem) is far wider than the real one; give the bar room so the label is not swapped
    // for the icon-only pill that HfFloatingNav uses when a label would not fit.
    tester.view.physicalSize = const Size(1800, 2400);
    await tester.pump();
    final text = tester.widget<Text>(tabLabel('Discover'));
    final style = DefaultTextStyle.of(
      tester.element(tabLabel('Discover')),
    ).style.merge(text.style);
    expect(style.fontSize, greaterThanOrEqualTo(14));
  });
}
