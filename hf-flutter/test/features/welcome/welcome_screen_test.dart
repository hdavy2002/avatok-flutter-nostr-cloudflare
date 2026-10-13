import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';
import 'package:hf_app/features/welcome/data/ack_service.dart';
import 'package:hf_app/features/welcome/ui/welcome_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../auth/auth_harness.dart';

GoRouter welcomeRouter() => GoRouter(
  initialLocation: '/welcome',
  routes: [
    GoRoute(path: '/welcome', builder: (_, __) => const WelcomeScreen()),
    GoRoute(path: '/h/:slug', builder: (_, __) => const Scaffold(body: Text('LINKED PROFILE'))),
    GoRoute(
      path: '/explore',
      builder: (_, __) => const Scaffold(body: Text('BROWSE PAGE')),
    ),
  ],
);

const _tickKey = ValueKey<String>('welcome-tick');

bool continueEnabled(WidgetTester tester) {
  final b = tester.widget<FilledButton>(
    find.ancestor(
      of: find.text(WelcomeCopy.button),
      matching: find.bySubtype<FilledButton>(),
    ),
  );
  return b.onPressed != null;
}

/// The list builds lazily: scroll until [f] exists and is on screen.
Future<void> reveal(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(
    f,
    200,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.ensureVisible(f);
  await tester.pump();
}

void main() {
  late RecordingLinks links;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    links = RecordingLinks();
    LinkOpener.instance = links;
  });
  tearDown(() => LinkOpener.instance = const LinkOpener());

  testWidgets(
    'shows the brand, the three rules, the crisis lines and the tick text',
    (tester) async {
      await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
      expect(find.text(Brand.name.toUpperCase()), findsOneWidget);
      expect(find.text(WelcomeCopy.maskedLine), findsOneWidget);
      expect(
        find.text('${WelcomeCopy.title}\n${WelcomeCopy.titleLine2}'),
        findsOneWidget,
      );
      for (final t in [
        WelcomeCopy.rule1Title,
        WelcomeCopy.rule2Title,
        WelcomeCopy.rule3Title,
      ]) {
        await reveal(tester, find.text(t));
        expect(find.text(t), findsOneWidget);
      }
      await reveal(tester, find.text('Tele-MANAS 14416'));
      expect(find.text('Tele-MANAS 14416'), findsOneWidget);
      expect(find.text('Emergency 112'), findsOneWidget);
      expect(find.text(WelcomeCopy.tick), findsOneWidget);
      // The rulebook's Appendix B wording.
      expect(
        WelcomeCopy.tick,
        contains(
          'friendly conversation, not counselling, therapy or a relationship service',
        ),
      );
      expect(WelcomeCopy.tick, endsWith('I am 18 or older.'));
    },
  );

  testWidgets('Continue waits for the tick', (tester) async {
    await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
    await reveal(tester, find.text(WelcomeCopy.button));
    expect(continueEnabled(tester), isFalse);
    await reveal(tester, find.byKey(_tickKey));
    await tester.tap(find.byKey(_tickKey));
    await tester.pump();
    expect(continueEnabled(tester), isTrue);
    await reveal(tester, find.byKey(_tickKey));
    await tester.tap(find.byKey(_tickKey));
    await tester.pump();
    expect(continueEnabled(tester), isFalse);
  });

  testWidgets(
    'a guest taps Continue: kept on the device, nothing is sent, Home opens',
    (tester) async {
      final api = FakeApiClient();
      await pumpRouter(tester, welcomeRouter(), api: api);
      await reveal(tester, find.byKey(_tickKey));
      await tester.tap(find.byKey(_tickKey));
      await tester.pump();
      await reveal(tester, find.text(WelcomeCopy.button));
      await tester.tap(find.text(WelcomeCopy.button));
      await settle(tester);
      expect(find.text('BROWSE PAGE'), findsOneWidget);
      expect(
        api.callsTo('POST', '/api/hf/me/ack'),
        isEmpty,
        reason: 'a guest has no account to send it to',
      );
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(AckService.storageKey), isNull);
    },
  );

  testWidgets(
    'a signed-in person taps Continue: the acceptance goes to the account too',
    (tester) async {
      final api = FakeApiClient()
        ..onJson('POST', '/api/hf/me/ack', {
          'ok': true,
          'ackVersion': kFallbackAckVersion,
        });
      await pumpRouter(
        tester,
        welcomeRouter(),
        api: api,
        stubSession: signedInState(),
      );
      await reveal(tester, find.byKey(_tickKey));
      await tester.tap(find.byKey(_tickKey));
      await tester.pump();
      await reveal(tester, find.text(WelcomeCopy.button));
      await tester.tap(find.text(WelcomeCopy.button));
      await settle(tester);
      expect(find.text('BROWSE PAGE'), findsOneWidget);
      expect(api.callsTo('POST', '/api/hf/me/ack').single.body, {
        'version': kFallbackAckVersion,
        'ack18': true,
        'client': 'android',
      });
    },
  );

  testWidgets('a failing acceptance call still lets the person in', (
    tester,
  ) async {
    final api = FakeApiClient()
      ..onError(
        'POST',
        '/api/hf/me/ack',
        const ApiError(status: 503, code: 'ack_failed'),
      );
    await pumpRouter(
      tester,
      welcomeRouter(),
      api: api,
      stubSession: signedInState(),
    );
    await reveal(tester, find.byKey(_tickKey));
    await tester.tap(find.byKey(_tickKey));
    await tester.pump();
    await reveal(tester, find.text(WelcomeCopy.button));
    await tester.tap(find.text(WelcomeCopy.button));
    await settle(tester);
    expect(find.text('BROWSE PAGE'), findsOneWidget);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('${AckService.storageKey}_user_test'), isNotNull);
  });

  testWidgets(
    'Terms, Privacy, Community guidelines and Safety open the site in a Custom Tab',
    (tester) async {
      await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
      for (final label in [
        WelcomeCopy.terms,
        WelcomeCopy.privacy,
        WelcomeCopy.guidelines,
        WelcomeCopy.safety,
      ]) {
        await reveal(tester, find.text(label));
        await tester.tap(find.text(label));
        await tester.pump();
      }
      expect(links.tabs.map((u) => u.path), [
        '/terms',
        '/privacy',
        '/community-guidelines',
        '/safety',
      ]);
      expect(
        links.tabs.every((u) => u.toString().startsWith(Brand.webOrigin)),
        isTrue,
      );
    },
  );

  testWidgets('crisis lines are tel: links', (tester) async {
    await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
    await reveal(tester, find.text('Tele-MANAS 14416'));
    await tester.tap(find.text('Tele-MANAS 14416'));
    await tester.pump();
    expect(links.tels, ['14416']);
  });

  testWidgets('tap targets are 48 dp or bigger and no text is under 14 sp', (
    tester,
  ) async {
    await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
    await reveal(tester, find.byKey(_tickKey));
    expect(
      tester.getSize(find.byKey(_tickKey)).height,
      greaterThanOrEqualTo(48),
    );
    await reveal(tester, find.text(WelcomeCopy.button));
    final button = find.ancestor(
      of: find.text(WelcomeCopy.button),
      matching: find.bySubtype<FilledButton>(),
    );
    expect(tester.getSize(button).height, greaterThanOrEqualTo(48));
    expect(tester.getSize(find.byKey(_tickKey)).width, greaterThan(200));
    expectNoTinyText(tester);
  });

  testWidgets('a link that arrived during start is released after Continue', (
    tester,
  ) async {
    await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
    final container = ProviderScope.containerOf(
      tester.element(find.byType(WelcomeScreen)),
    );
    container
        .read(pendingLinkProvider.notifier)
        .set(
          const PendingLinkData(
            input: '/h/asha',
            source: 'link',
            launch: 'cold',
          ),
        );
    expect(container.read(bootDoneProvider), isFalse);
    await reveal(tester, find.byKey(_tickKey));
    await tester.tap(find.byKey(_tickKey));
    await tester.pump();
    await reveal(tester, find.text(WelcomeCopy.button));
    await tester.tap(find.text(WelcomeCopy.button));
    await settle(tester);
    expect(container.read(bootDoneProvider), isTrue);
    expect(container.read(pendingLinkProvider), isNull);
    // A distinct destination proves the queued link won over Explore fallback.
    expect(find.text('LINKED PROFILE'), findsOneWidget);
    expect(find.text('BROWSE PAGE'), findsNothing);
  });

  testWidgets('the rule rows are in place after the staggered intro', (
    tester,
  ) async {
    await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
    await tester.pumpAndSettle();
    for (final t in [WelcomeCopy.rule1Title, WelcomeCopy.rule2Title]) {
      final fade = tester.widget<FadeTransition>(
        find
            .ancestor(of: find.text(t), matching: find.byType(FadeTransition))
            .first,
      );
      expect(fade.opacity.value, 1.0, reason: t);
    }
  });

  testWidgets('no overflow at 320 wide and the largest system font', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await pumpRouter(tester, welcomeRouter(), api: FakeApiClient());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await reveal(tester, find.text(WelcomeCopy.button));
    expect(tester.takeException(), isNull);
  });

  test('WelcomeCopy never types the brand: the tick text uses Brand.name', () {
    expect(
      WelcomeCopy.tick,
      startsWith('I understand ${Brand.name} is friendly conversation'),
    );
  });
}
