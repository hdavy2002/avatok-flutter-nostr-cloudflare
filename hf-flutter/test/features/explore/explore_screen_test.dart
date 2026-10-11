import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/explore/data/explore_controller.dart';
import 'package:hf_app/features/explore/data/host_filters.dart';
import 'package:hf_app/features/explore/data/hosts_repository.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/features/explore/ui/filter_sheet.dart';
import 'package:hf_app/features/host_profile/ui/host_profile_screen.dart';
import 'package:hf_app/features/lanes/ui/lanes_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import 'explore_test_support.dart';

Uri location(ProviderContainer c) => c.read(appRouterProvider).routeInformationProvider.value.uri;

List<RecordedCall> listCalls(FakeApiClient api) => api.callsTo('GET', '/api/hf/hosts');

Future<void> tapInSheet(WidgetTester tester, Finder f) async {
  final target = inSheet(f);
  await tester.ensureVisible(target);
  await tester.pump();
  await tester.tap(target);
  await tester.pump();
}

Finder inSheet(Finder f) => find.descendant(of: find.byType(FilterSheet), matching: f);

void main() {
  group('cached then fresh', () {
    testWidgets('an old saved list shows at once with the pill, then the fresh list replaces it', (tester) async {
      final cache = MemoryJsonCache()
        ..seed(
          kExploreCacheKey,
          {
            'key': HostFilters.none.cacheKey,
            'page': pageJson([hostJson('old', name: 'Old Asha')]),
          },
          at: DateTime.now().subtract(const Duration(hours: 1)),
        );
      final fresh = Completer<Object?>();
      final api = fakeApi()..on('GET', '/api/hf/hosts', (_) => fresh.future);
      final c = await pumpScreen(tester, api: api, cache: cache);

      // Saved copy on screen while the network answer is still on its way.
      expect(find.text('Old Asha'), findsOneWidget);
      expect(find.text('Showing saved list'), findsOneWidget);
      expect(c.read(exploreControllerProvider).awaitingFresh, isTrue);

      fresh.complete(pageJson([hostJson('new', name: 'New Bela')]));
      await tester.pumpAndSettle();

      expect(find.text('New Bela'), findsOneWidget);
      expect(find.text('Old Asha'), findsNothing);
      expect(find.text('Showing saved list'), findsNothing);
      // The fresh page replaced the saved copy for next time.
      final saved = cache.store[kExploreCacheKey]!.data! as Map;
      expect(((saved['page'] as Map)['items'] as List).single['slug'], 'new');
      // An anonymous list is requested without the bearer token (so it can sit in the edge cache).
      expect(listCalls(api).single.auth, isFalse);
      expect(listCalls(api).single.query, {'limit': 24, 'offset': 0});
    });

    testWidgets('a fresh saved list shows with no pill; offline keeps it and says so', (tester) async {
      final cache = MemoryJsonCache()
        ..seed(kExploreCacheKey, {
          'key': HostFilters.none.cacheKey,
          'page': pageJson([hostJson('old', name: 'Old Asha')]),
        });
      final api = fakeApi()..onError('GET', '/api/hf/hosts', ApiError.network());
      await pumpScreen(tester, api: api, cache: cache);
      expect(find.text('Old Asha'), findsOneWidget);
      // The refresh failed: the saved copy is all there is, and the pill says so.
      expect(find.text('Showing saved list'), findsOneWidget);
      expect(find.text('Try again'), findsNothing);
    });

    testWidgets('a saved list for other filters is not shown', (tester) async {
      final cache = MemoryJsonCache()
        ..seed(kExploreCacheKey, {
          'key': const HostFilters(online: true).cacheKey,
          'page': pageJson([hostJson('old', name: 'Old Asha')]),
        });
      final api = fakeApi()..onError('GET', '/api/hf/hosts', ApiError.network());
      await pumpScreen(tester, api: api, cache: cache);
      expect(find.text('Old Asha'), findsNothing);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });
  });

  group('empty and error', () {
    testWidgets('empty list with no filters', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(tester, api: api);
      expect(find.text('No hosts are live yet. Check back soon.'), findsOneWidget);
      expect(find.text('Clear filters'), findsNothing);
    });

    testWidgets('empty with filters offers Clear filters, which asks again without them', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      final c = await pumpScreen(tester, api: api, location: '/explore?online=1');
      expect(find.text('No one matches. Try fewer filters.'), findsOneWidget);
      expect(listCalls(api).first.query!['online'], '1');

      await tester.ensureVisible(find.text('Clear filters'));
      await tester.tap(find.text('Clear filters'));
      await tester.pumpAndSettle();
      expect(listCalls(api).last.query!.containsKey('online'), isFalse);
      expect(location(c).toString(), '/explore');
      expect(find.text('No hosts are live yet. Check back soon.'), findsOneWidget);
    });

    testWidgets('error shows the message and Try again loads the list', (tester) async {
      final api = fakeApi()..onError('GET', '/api/hf/hosts', ApiError.network());
      await pumpScreen(tester, api: api);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);

      api.onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      await tester.ensureVisible(find.text('Try again'));
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Host asha'), findsOneWidget);
      expect(find.text('No internet. Check your connection.'), findsNothing);
    });

    testWidgets('a flag that is off shows Coming soon, not an error', (tester) async {
      final api = fakeApi()
        ..onError('GET', '/api/hf/hosts', const ApiError(status: 404, code: 'not_enabled'));
      await pumpScreen(tester, api: api);
      expect(find.text('Coming soon'), findsOneWidget);
      expect(find.text('Try again'), findsNothing);
    });
  });

  group('lanes', () {
    testWidgets('signed out: a lane link explains the space before registration and does not read private hosts', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      await pumpScreen(tester, api: api, location: '/explore?lane=women');
      expect(find.text('Sign in to enter this space'), findsOneWidget);
      expect(listCalls(api), isEmpty);

      await tester.ensureVisible(find.widgetWithText(HfButton, 'About this space'));
      await tester.tap(find.widgetWithText(HfButton, 'About this space'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(LanesScreen), findsOneWidget);
    });

    testWidgets('403 lane_required shows the Verify to join panel that opens the lanes route', (tester) async {
      final api = fakeApi()
        ..onError('GET', '/api/hf/hosts', const ApiError(status: 403, code: 'lane_required'));
      await pumpScreen(tester, api: api, session: signedInState(), location: '/explore?lane=lgbtq');
      expect(find.text('Verify to join'), findsWidgets);
      // The lane list carries the bearer token, and says which lane.
      expect(listCalls(api).single.auth, isTrue);
      expect(listCalls(api).single.query!['lane'], 'lgbtq');

      await tester.ensureVisible(find.widgetWithText(HfButton, 'Verify to join'));
      await tester.tap(find.widgetWithText(HfButton, 'Verify to join'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(LanesScreen), findsOneWidget);
    });

    testWidgets('a joined member sees the lane list; the tabs switch lanes and keep the route in step', (tester) async {
      final api = fakeApi()
        ..on('GET', '/api/hf/hosts', (call) {
          final lane = call.query!['lane'];
          return pageJson([hostJson(lane == null ? 'all' : 'lane-$lane', name: lane == null ? 'Public host' : 'Lane host')]);
        });
      final c = await pumpScreen(tester, api: api, session: const SessionState(
        status: SessionStatus.signedIn, me: HfMe(uid: 'member', womenLane: true)));
      expect(find.text('Public host'), findsOneWidget);

      await tester.tap(find.text('Women-only'));
      await tester.pumpAndSettle();
      expect(find.text('Lane host'), findsOneWidget);
      expect(location(c).queryParameters['lane'], 'women');
      expect(listCalls(api).last.query!['lane'], 'women');

      await tester.tap(find.text('Everyone'));
      await tester.pumpAndSettle();
      expect(find.text('Public host'), findsOneWidget);
      expect(location(c).toString(), '/explore');
    });
  });

  group('filters', () {
    testWidgets('choices in the sheet become query parameters and route parameters', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      final c = await pumpScreen(tester, api: api);
      expect(listCalls(api), hasLength(1));

      await tester.tap(find.byKey(const ValueKey<String>('open-filters')));
      await tester.pumpAndSettle();
      expect(find.byType(FilterSheet), findsOneWidget);

      await tapInSheet(tester, find.text('Exam tension'));
      await tapInSheet(tester, find.text('Hindi'));
      await tapInSheet(tester, find.byKey(const ValueKey<String>('filter-online')));
      await tapInSheet(tester, find.text('Price: low to high'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Show results'));
      await tester.pumpAndSettle();

      expect(find.byType(FilterSheet), findsNothing);
      expect(listCalls(api), hasLength(2));
      expect(listCalls(api).last.query, {
        'topic': 'tension-a',
        'lang': 'hi',
        'online': '1',
        'sort': 'price_low',
        'limit': 24,
        'offset': 0,
      });
      final route = location(c);
      expect(route.path, '/explore');
      expect(route.queryParameters, {'topics': 'tension-a', 'lang': 'hi', 'online': '1'});
      expect(c.read(exploreControllerProvider).filters.sort, HostSort.priceLow);
    });

    testWidgets('a deep link brings its filters; Clear all in the sheet removes them', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      await pumpScreen(tester, api: api, location: '/explore?topics=tension-a&max=20');
      expect(listCalls(api).first.query, {'topic': 'tension-a', 'maxPrice': 20, 'limit': 24, 'offset': 0});

      await tester.tap(find.byKey(const ValueKey<String>('open-filters')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Clear all'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Show results'));
      await tester.pumpAndSettle();
      expect(listCalls(api).last.query, {'limit': 24, 'offset': 0});
    });

    testWidgets('closing the sheet without Show results changes nothing', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      await pumpScreen(tester, api: api);
      await tester.tap(find.byKey(const ValueKey<String>('open-filters')));
      await tester.pumpAndSettle();
      await tapInSheet(tester, find.text('Hindi'));
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(listCalls(api), hasLength(1));
    });

    testWidgets('the sheet shows Try again when the choices cannot load', (tester) async {
      final api = FakeApiClient()
        ..onError('GET', '/api/hf/options', ApiError.network())
        ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
      await pumpScreen(tester, api: api);
      await tester.tap(find.byKey(const ValueKey<String>('open-filters')));
      await tester.pumpAndSettle();
      expect(find.text('We could not load the filter choices.'), findsOneWidget);
    });
  });

  group('pagination', () {
    testWidgets('scrolling to the end asks for the next page at nextOffset and appends it', (tester) async {
      final api = fakeApi()
        ..on('GET', '/api/hf/hosts', (call) {
          final offset = call.query!['offset'] as int;
          if (offset == 0) {
            return pageJson([for (var i = 1; i <= 4; i++) hostJson('p1-$i')], next: 4, total: 6);
          }
          return pageJson([hostJson('p2-1'), hostJson('p2-2')], total: 6);
        });
      final c = await pumpScreen(tester, api: api);
      expect(listCalls(api), hasLength(1));
      expect(c.read(exploreControllerProvider).items, hasLength(4));

      await tester.drag(find.byType(CustomScrollView), const Offset(0, -3000));
      await tester.pumpAndSettle();

      expect(listCalls(api), hasLength(2));
      expect(listCalls(api).last.query!['offset'], 4);
      final st = c.read(exploreControllerProvider);
      expect(st.items.map((h) => h.slug), ['p1-1', 'p1-2', 'p1-3', 'p1-4', 'p2-1', 'p2-2']);
      expect(st.hasMore, isFalse);

      // No more pages: more scrolling asks for nothing.
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -3000));
      await tester.pumpAndSettle();
      expect(listCalls(api), hasLength(2));
    });

    testWidgets('a short first page on a tall screen still loads the next page', (tester) async {
      final api = fakeApi()
        ..on('GET', '/api/hf/hosts', (call) {
          final offset = call.query!['offset'] as int;
          return offset == 0
              ? pageJson([hostJson('a')], next: 1, total: 2)
              : pageJson([hostJson('b')], total: 2);
        });
      final c = await pumpScreen(tester, api: api, size: const Size(360, 2400));
      expect(listCalls(api), hasLength(2));
      expect(c.read(exploreControllerProvider).items.map((h) => h.slug), ['a', 'b']);
    });

    testWidgets('a failed next page shows Try again under the list and keeps the list', (tester) async {
      var fail = true;
      final api = fakeApi()
        ..on('GET', '/api/hf/hosts', (call) {
          final offset = call.query!['offset'] as int;
          if (offset == 0) return pageJson([for (var i = 1; i <= 4; i++) hostJson('p1-$i')], next: 4, total: 5);
          if (fail) throw ApiError.network();
          return pageJson([hostJson('p2-1')], total: 5);
        });
      final c = await pumpScreen(tester, api: api);
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -3000));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -3000));
      await tester.pumpAndSettle();
      expect(find.text('Could not load more people.'), findsOneWidget);
      expect(c.read(exploreControllerProvider).items, hasLength(4));

      fail = false;
      await tester.ensureVisible(find.text('Try again'));
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(c.read(exploreControllerProvider).items, hasLength(5));
    });
  });

  testWidgets('pull to refresh asks again and keeps the list on screen', (tester) async {
    var n = 0;
    final api = fakeApi()
      ..on('GET', '/api/hf/hosts', (_) => pageJson([hostJson('a', name: n++ == 0 ? 'Before' : 'After')]));
    await pumpScreen(tester, api: api);
    expect(find.text('Before'), findsOneWidget);
    await tester.fling(find.byType(CustomScrollView), const Offset(0, 400), 1000);
    await tester.pumpAndSettle();
    expect(listCalls(api), hasLength(2));
    expect(find.text('After'), findsOneWidget);
  });

  testWidgets('a card shows name, tagline, languages, topic label, price, rating, status and the AI picture label',
      (tester) async {
    final api = fakeApi()
      ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha', name: 'Asha', price: 12, status: 'busy')]));
    await pumpScreen(tester, api: api);
    expect(find.text('Asha'), findsOneWidget);
    expect(find.text('Tagline of asha'), findsOneWidget);
    expect(find.text('Hindi · English'), findsOneWidget);
    expect(find.text('Exam tension'), findsOneWidget);
    expect(find.text('₹12/min'), findsOneWidget);
    expect(find.text('On a call'), findsOneWidget);
    expect(find.text('AI picture'), findsOneWidget);
  });

  testWidgets('tapping a card opens the host profile', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha', name: 'Asha')]));
    await pumpScreen(tester, api: api);
    await tester.tap(find.text('Asha'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byType(HostProfileScreen), findsOneWidget);
  });

  testWidgets('the screen survives the largest system font without overflow', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final api = fakeApi()
      ..onJson('GET', '/api/hf/hosts',
          pageJson([hostJson('asha', name: 'Asha with a rather long name indeed', intro: 'https://x/a.m4a')]));
    await pumpScreen(tester, api: api, size: const Size(360, 800));
    expect(tester.takeException(), isNull);
  });
}
