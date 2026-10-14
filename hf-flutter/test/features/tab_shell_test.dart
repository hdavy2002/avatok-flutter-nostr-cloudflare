import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/features/host_profile/ui/host_profile_screen.dart';
import 'package:hf_app/features/bookings/ui/customer_bookings_screen.dart';
import 'package:hf_app/features/review/ui/review_screen.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/features/explore/ui/explore_screen.dart';
import 'package:hf_app/core/router/tab_shell.dart';
import 'package:hf_app/core/widgets/hf_floating_nav.dart';
import 'package:hf_app/features/me/data/notification_control.dart';

import 'package:hf_app/features/auth/ui/sign_in_screen.dart';

import 'me/me_test_support.dart' show FakeNotificationControl;

import '../support/app_harness.dart';
import '../support/fake_api_client.dart';

Finder tabLabel(String label) =>
    find.descendant(of: find.byType(HfFloatingNav), matching: find.text(label));

/// Every nav item is icon-only; its name remains available to assistive technology.
Finder tabItem(String key) => find.byKey(ValueKey<String>(key));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));
  testWidgets('a guest sees Browse, Wallet and Me, and no Host tab', (
    tester,
  ) async {
    await pumpApp(tester);
    expect(find.byType(HfFloatingNav), findsOneWidget);
    for (final k in ['tab-home', 'tab-wallet', 'tab-me', 'tab-more']) {
      expect(tabItem(k), findsOneWidget, reason: k);
    }
    expect(tabItem('tab-host'), findsNothing);
    // The selected icon has a tinted background; all labels are accessible names.
    expect(tabLabel('Discover'), findsNothing);
    expect(find.byTooltip('Discover'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('nav-selected')), findsOneWidget);
    expect(tabLabel('Wallet'), findsNothing);
  });

  testWidgets('More opens Calendar and Back dismisses the menu', (tester) async {
    final container = await pumpApp(tester);
    final before = container.read(appRouterProvider).routeInformationProvider.value.uri;
    expect(find.byTooltip('More'), findsOneWidget);
    await tester.tap(tabItem('tab-more'));
    await tester.pumpAndSettle();
    expect(find.text('Calendar'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('menu-host-bookings')), findsNothing);
    expect(find.byKey(const ValueKey<String>('menu-availability')), findsNothing);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Calendar'), findsNothing);
    expect(find.text('Exit?'), findsNothing);
    expect(container.read(appRouterProvider).routeInformationProvider.value.uri, before);
  });

  testWidgets('Calendar keeps the sign-in destination for guests', (tester) async {
    await pumpApp(tester);
    await tester.tap(tabItem('tab-more'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('menu-calendar')));
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsOneWidget);
    expect(tester.widget<SignInScreen>(find.byType(SignInScreen)).next,
        Routes.customerBookings);
  });

  testWidgets('Calendar opens bookings and app-bar Back restores the footer', (tester) async {
    await pumpApp(tester, location: Routes.explore, session: signedInState());
    await tester.tap(tabItem('tab-more'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('menu-calendar')));
    await tester.pumpAndSettle();
    expect(find.byType(CustomerBookingsScreen), findsOneWidget);
    expect(find.byType(BackButton), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.byType(CustomerBookingsScreen), findsNothing);
    expect(find.byType(ExploreScreen), findsOneWidget);
    expect(tabItem('tab-more'), findsOneWidget);
  });

  testWidgets('host menu and five footer targets fit at 320 dp and 2x text', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final semantics = tester.ensureSemantics();
    addTearDown(semantics.dispose);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetDevicePixelRatio);
    tester.view.physicalSize = const Size(960, 2400);
    addTearDown(tester.view.resetPhysicalSize);
    await pumpApp(tester, session: signedInState(host: true));
    await tester.pumpAndSettle();
    for (final key in ['tab-home', 'tab-wallet', 'tab-host', 'tab-me', 'tab-more']) {
      final size = tester.getSize(tabItem(key));
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
    }
    expect(tester.getSemantics(tabItem('tab-more')).label, 'More');
    expect(tester.takeException(), isNull);
    await tester.tap(tabItem('tab-more'));
    await tester.pumpAndSettle();
    expect(find.text('Calendar'), findsOneWidget);
    expect(find.text('Host bookings'), findsOneWidget);
    expect(find.text('Availability'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byTooltip('Close menu'));
    await tester.pumpAndSettle();
    expect(find.text('Calendar'), findsNothing);
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
    final c = await pumpApp(tester);
    await tester.tap(find.byKey(const ValueKey<String>('tab-home')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('open-filters')), findsOneWidget);
    expect(find.byType(ExploreScreen), findsOneWidget);
    expect(c.read(appRouterProvider).routeInformationProvider.value.uri.path, Routes.explore);
  });

  testWidgets('Wallet needs sign-in: a guest lands on sign-in with next', (
    tester,
  ) async {
    final c = await pumpApp(tester);
    await tester.tap(find.byKey(const ValueKey<String>('tab-wallet')));
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsOneWidget);
    expect(find.byKey(const ValueKey('identity-email')), findsOneWidget);
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
      expect(find.byType(SignInScreen), findsOneWidget);
      expect(find.byKey(const ValueKey('identity-email')), findsOneWidget);
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
    testWidgets('Me keeps icon-only accessible tabs at 320 px and 2x text (host: $host)', (tester) async {
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
      for (final label in ['Discover', 'Wallet', 'Me', 'More', if (host) 'Host']) {
        expect(tabLabel(label), findsNothing);
        expect(find.byTooltip(label), findsOneWidget);
      }
      for (final key in ['tab-home', 'tab-wallet', 'tab-me', 'tab-more', if (host) 'tab-host']) {
        expect(tester.getSize(tabItem(key)).height, greaterThanOrEqualTo(48));
      }
      expect(tabItem('tab-host'), host ? findsOneWidget : findsNothing);
      expect(tester.takeException(), isNull);
      await tester.tap(tabItem(host ? 'tab-host' : 'tab-home'));
      await tester.pumpAndSettle();
      expect(c.read(appRouterProvider).routeInformationProvider.value.uri.path,
          host ? '/host' : '/explore');
      expect(tester.widget<HfFloatingNav>(find.byType(HfFloatingNav)).profileStyle, isFalse);
    });
  }

  testWidgets('nav icons are 32 dp with accessible labels and visible destination colours', (tester) async {
    final semantics = tester.ensureSemantics();
    try {
      await pumpApp(tester, session: signedInState(host: true));
      final colours = <Color>{};
      for (final entry in {
        'tab-home': 'Discover', 'tab-wallet': 'Wallet', 'tab-host': 'Host', 'tab-me': 'Me',
      }.entries) {
        expect(tabLabel(entry.value), findsNothing);
        expect(find.byTooltip(entry.value), findsOneWidget);
        expect(tester.getSemantics(tabItem(entry.key)).label, entry.value);
        final icon = tester.widget<Icon>(find.descendant(of: tabItem(entry.key), matching: find.byType(Icon)));
        expect(icon.size, 32);
        colours.add(icon.color!);
        expect(tester.getSize(tabItem(entry.key)).height, greaterThanOrEqualTo(48));
      }
      expect(colours, hasLength(4));
    } finally {
      semantics.dispose();
    }
  });
}
