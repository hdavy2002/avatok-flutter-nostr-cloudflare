import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';
import 'package:hf_app/features/explore/data/explore_controller.dart';
import 'package:hf_app/features/explore/ui/discovery_header.dart';
import 'package:hf_app/features/explore/ui/explore_screen.dart';
import 'package:hf_app/features/explore/widgets/host_card_view.dart';
import 'package:hf_app/features/welcome/ui/welcome_screen.dart';
import '../../support/app_harness.dart';
import '../explore/explore_test_support.dart';

Finder hostNamed(String name) =>
    find.descendant(of: find.byType(HostCardView), matching: find.text(name));

Future<void> revealHome(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target,
    240,
    scrollable: find
        .descendant(
          of: find.byType(CustomScrollView),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pump();
}

Future<void> returnToHeader(WidgetTester tester) async {
  // The header has been disposed when the lazy viewport is down in the list.
  tester
      .state<ScrollableState>(
        find
            .descendant(
              of: find.byType(CustomScrollView),
              matching: find.byType(Scrollable),
            )
            .first,
      )
      .position
      .jumpTo(0);
  await tester.pump();
}

/// Reveal a lazy topic chip by scrolling its horizontal list.
Future<void> revealMood(
  WidgetTester tester,
  Finder target, {
  double delta = 120,
}) async {
  final list = find.descendant(
    of: find.byType(DiscoveryHeader),
    matching: find.byWidgetPredicate(
      (widget) => widget is ListView &&
          widget.scrollDirection == Axis.horizontal,
    ),
  );
  await tester.scrollUntilVisible(
    target,
    delta,
    scrollable: find.descendant(
      of: list,
      matching: find.byType(Scrollable),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('guest home is the marketplace without account onboarding', (
    tester,
  ) async {
    final api = fakeApi()
      ..onJson(
        'GET',
        '/api/hf/hosts',
        pageJson([hostJson('asha', name: 'Asha')]),
      );
    await pumpScreen(tester, api: api, location: '/');
    expect(find.byType(ExploreScreen), findsOneWidget);
    expect(find.byType(SignInScreen), findsNothing);
    expect(find.byType(WelcomeScreen), findsNothing);
    expect(find.text('Explore'), findsWidgets);
    expect(find.text('Real people. Real conversations.'), findsOneWidget);
    expect(find.text('Topic, language or name'), findsOneWidget);
    expect(find.text('Everyone'), findsOneWidget);
    expect(find.text('Women-only'), findsOneWidget);
    expect(find.text('LGBTQ+'), findsOneWidget);
    await revealHome(tester, hostNamed('Asha'));
    expect(hostNamed('Asha'), findsOneWidget);
    expect(api.callsTo('GET', '/api/hf/hosts').first.query!['online'], isNull);
  });

  testWidgets(
    'guest header shows discovery copy and a Sign in wallet pill',
    (tester) async {
      final api = fakeApi()
        ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      await pumpScreen(tester, api: api, location: '/');
      expect(find.text('Real people. Real conversations.'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey<String>('wallet-pill')),
          matching: find.text('Sign in'),
        ),
        findsOneWidget,
      );
      expect(api.callsTo('GET', '/api/hf/wallet'), isEmpty);
    },
  );

  testWidgets(
    'signed-in discovery shows the live rupee balance on the wallet pill',
    (tester) async {
      final api = fakeApi()
        ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]))
        ..onJson('GET', '/api/hf/wallet', {
          'mode': 'tokens',
          'tokens': {'balanceMicro': 342000000, 'availableMicro': 342000000},
        });
      await pumpScreen(
        tester,
        api: api,
        session: signedInState(),
        location: '/',
      );
      expect(find.text('Real people. Real conversations.'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey<String>('wallet-pill')),
          matching: find.text('₹342'),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets('mood choices use server topic groups', (tester) async {
    final api = fakeApi()
      ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    final container = await pumpScreen(tester, api: api, location: '/');
    await revealMood(
      tester,
      find.byKey(const ValueKey<String>('mood-tension')),
    );
    await tester.tap(find.byKey(const ValueKey<String>('mood-tension')));
    await tester.pumpAndSettle();
    expect(
      container
          .read(appRouterProvider)
          .routeInformationProvider
          .value
          .uri
          .queryParameters['topics'],
      'tension-a',
    );
    expect(
      api
          .callsTo('GET', '/api/hf/hosts')
          .any((c) => c.query!['topic'] == 'tension-a'),
      isTrue,
    );
  });

  testWidgets('search uses server results and clearing restores the feed', (
    tester,
  ) async {
    final api = fakeApi()
      ..on(
        'GET',
        '/api/hf/hosts',
        (call) => switch (call.query?['q']) {
          'Bela' => pageJson([hostJson('bela', name: 'Bela')]),
          'no match' => pageJson([]),
          _ => pageJson([hostJson('asha', name: 'Asha')]),
        },
      );
    final container = await pumpScreen(tester, api: api, location: '/');
    await tester.enterText(find.byType(TextField), 'Bela');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(container.read(exploreControllerProvider).filters.search, 'Bela');
    expect(api.callsTo('GET', '/api/hf/hosts').last.query?['q'], 'Bela');
    await revealHome(tester, hostNamed('Bela'));
    expect(hostNamed('Bela'), findsOneWidget);
    expect(find.text('Asha'), findsNothing);
    await returnToHeader(tester);
    await tester.ensureVisible(find.byType(TextField));
    await tester.enterText(find.byType(TextField), 'no match');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    await revealHome(tester, find.text('No one matches. Try fewer filters.'));
    expect(find.text('No one matches. Try fewer filters.'), findsOneWidget);
    await returnToHeader(tester);
    await tester.ensureVisible(find.byTooltip('Clear search'));
    await tester.tap(find.byTooltip('Clear search'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(api.callsTo('GET', '/api/hf/hosts').last.query?['q'], isNull);
    await revealHome(tester, hostNamed('Asha'));
    expect(hostNamed('Asha'), findsOneWidget);
  });

  testWidgets('home forwards incoming filter queries', (tester) async {
    final api = fakeApi()
      ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    await pumpScreen(tester, api: api, location: '/?lang=hi&online=1');
    final query = api.callsTo('GET', '/api/hf/hosts').first.query!;
    expect(query['lang'], 'hi');
    expect(query['online'], '1');
    await revealHome(tester, hostNamed('Host asha'));
    expect(hostNamed('Host asha'), findsOneWidget);
  });

  testWidgets('bento marketplace adapts to 320 width and double-size text', (
    tester,
  ) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final api = fakeApi()
      ..onJson(
        'GET',
        '/api/hf/hosts',
        pageJson([
          hostJson(
            'asha',
            name: 'Asha with a long name',
            intro: 'https://x/a.m4a',
          ),
        ]),
      );
    await pumpScreen(
      tester,
      api: api,
      location: '/',
      size: const Size(320, 800),
    );
    expect(find.text('Real people. Real conversations.'), findsOneWidget);
    await revealHome(tester, hostNamed('Asha with a long name'));
    expect(hostNamed('Asha with a long name'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
