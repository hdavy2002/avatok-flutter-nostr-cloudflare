import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';
import 'package:hf_app/features/explore/data/host_filters.dart';
import 'package:hf_app/features/host_dashboard/ui/host_dashboard_screen.dart';
import 'package:hf_app/features/host_onboarding/ui/host_onboarding_screen.dart';
import 'package:hf_app/features/explore/data/hosts_repository.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../explore/explore_test_support.dart';

Uri location(ProviderContainer c) => c.read(appRouterProvider).routeInformationProvider.value.uri;

/// Online-only list calls Home makes.
List<RecordedCall> onlineCalls(FakeApiClient api) =>
    api.callsTo('GET', '/api/hf/hosts').where((c) => c.query!['online'] == '1').toList();

const Size tall = Size(360, 3000);

void main() {
  testWidgets('a guest sees the greeting, Online now, mood tiles, spaces, safety and Become a host', (tester) async {
    final api = fakeApi()
      ..onJson('GET', '/api/hf/hosts',
          pageJson([hostJson('asha', name: 'Asha'), hostJson('bela', name: 'Bela', intro: 'https://x/b.m4a')]));
    await pumpScreen(tester, api: api, location: '/', size: tall);

    expect(find.text('Hello!'), findsOneWidget);
    expect(find.text('Online now'), findsWidgets); // section title and the pills
    expect(find.text('Asha'), findsOneWidget);
    expect(find.text('Bela'), findsOneWidget);
    // Mood tiles come from /api/hf/options.
    expect(find.text('Naye dost'), findsOneWidget);
    expect(find.text('Tension'), findsOneWidget);
    expect(find.text('Women-only space'), findsOneWidget);
    expect(find.text('LGBTQ+ space'), findsOneWidget);
    expect(find.text('AI-powered, ends bad calls automatically'), findsOneWidget);
    expect(find.byType(CrisisStrip), findsOneWidget);
    expect(find.text('Become a host'), findsWidgets);
    // No endpoint lists a caller's regulars yet, so the section is hidden.
    expect(find.text('Your regulars'), findsNothing);
    // The strip asks for online hosts only.
    expect(onlineCalls(api).single.query, {'online': '1', 'limit': 12, 'offset': 0});
  });

  testWidgets('a signed-in person is greeted by first name', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    const session = SessionState(
      status: SessionStatus.signedIn,
      me: HfMe(uid: 'u1', displayName: 'Asha Rao'),
    );
    await pumpScreen(tester, api: api, session: session, location: '/', size: tall);
    expect(find.text('Hello, Asha'), findsOneWidget);
  });

  testWidgets('a mood tile opens Explore filtered to that group, and Explore asks for those topics', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    final c = await pumpScreen(tester, api: api, location: '/', size: tall);

    await tester.tap(find.byKey(const ValueKey<String>('mood-tension')));
    await tester.pumpAndSettle();

    expect(location(c).path, '/explore');
    expect(location(c).queryParameters['topics'], 'tension-a');
    expect(
      api.callsTo('GET', '/api/hf/hosts').any((call) => call.query!['topic'] == 'tension-a'),
      isTrue,
    );
  });

  testWidgets('the space cards open Explore on that lane', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    final c = await pumpScreen(tester, api: api, location: '/', size: tall);
    await tester.tap(find.text('Women-only space'));
    await tester.pumpAndSettle();
    expect(location(c).path, '/explore');
    expect(location(c).queryParameters['lane'], 'women');
  });

  testWidgets('See all opens Explore with Online now on', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    final c = await pumpScreen(tester, api: api, location: '/', size: tall);
    await tester.tap(find.text('See all'));
    await tester.pumpAndSettle();
    expect(location(c).path, '/explore');
    expect(location(c).queryParameters['online'], '1');
  });

  testWidgets('nobody online: a friendly line and a way to browse everyone', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
    final c = await pumpScreen(tester, api: api, location: '/', size: tall);
    expect(find.text('Nobody is online right now. Browse everyone below.'), findsOneWidget);
    await tester.tap(find.text('Browse everyone'));
    await tester.pumpAndSettle();
    expect(location(c).path, '/explore');
  });

  testWidgets('the strip shows the saved list at once and the pill when it is old', (tester) async {
    final cache = MemoryJsonCache()
      ..seed(
        kOnlineCacheKey,
        {
          'key': const HostFilters(online: true).cacheKey,
          'page': pageJson([hostJson('old', name: 'Old Asha')]),
        },
        at: DateTime.now().subtract(const Duration(hours: 2)),
      );
    final api = fakeApi()..onError('GET', '/api/hf/hosts', ApiError.network());
    await pumpScreen(tester, api: api, cache: cache, location: '/', size: tall);
    expect(find.text('Old Asha'), findsOneWidget);
    expect(find.text('Showing saved list'), findsOneWidget);
  });

  testWidgets('the strip shows an error with Try again, and Try again loads it', (tester) async {
    final api = fakeApi()..onError('GET', '/api/hf/hosts', ApiError.network());
    await pumpScreen(tester, api: api, location: '/', size: tall);
    expect(find.text('No internet. Check your connection.'), findsOneWidget);

    api.onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha', name: 'Asha')]));
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Asha'), findsOneWidget);
  });

  testWidgets('mood tiles stay hidden when the options cannot load', (tester) async {
    final api = FakeApiClient()
      ..onError('GET', '/api/hf/options', ApiError.network())
      ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    await pumpScreen(tester, api: api, location: '/', size: tall);
    expect(find.text('What is on your mind?'), findsNothing);
    expect(find.text('Host asha'), findsOneWidget);
  });

  group('Become a host', () {
    testWidgets('a guest is asked to sign in first', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(tester, api: api, location: '/', size: tall);
      await tester.tap(find.widgetWithText(HfButton, 'Become a host'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(SignInScreen), findsOneWidget);
    });

    testWidgets('a signed-in person goes to host onboarding', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(tester, api: api, session: signedInState(), location: '/', size: tall);
      await tester.tap(find.widgetWithText(HfButton, 'Become a host'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(HostOnboardingScreen), findsOneWidget);
    });

    testWidgets('a person who already hosts is sent to the Host tab instead', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(tester, api: api, session: signedInState(host: true), location: '/', size: tall);
      expect(find.text('Your host profile'), findsOneWidget);
      await tester.tap(find.widgetWithText(HfButton, 'Open host tab'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(HostDashboardScreen), findsOneWidget);
    });
  });

  testWidgets('Home survives the largest system font without overflow', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final api = fakeApi()
      ..onJson('GET', '/api/hf/hosts',
          pageJson([hostJson('asha', name: 'Asha with a long name', intro: 'https://x/a.m4a')]));
    await pumpScreen(tester, api: api, location: '/', size: const Size(360, 4000));
    final e = tester.takeException();
    final where = <String>[];
    void walk(RenderObject ro) {
      if (ro.toStringShort().contains('OVERFLOWING')) {
        final c = ro.debugCreator;
        where.add(c is DebugCreator ? c.element.debugGetCreatorChain(10) : ro.toStringShort());
      }
      ro.visitChildren(walk);
    }

    final root = tester.binding.rootElement?.renderObject;
    if (root != null) walk(root);
    expect(e, isNull, reason: where.join('\n---\n'));
  });
}
