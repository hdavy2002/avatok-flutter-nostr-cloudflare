import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/favourites_store.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/models/search.dart';
import 'package:hf_app/data/repos/favourites_repo.dart';
import 'package:hf_app/data/repos/search_repo.dart';
import 'package:hf_app/data/share.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/reel_player.dart';
import 'package:hf_app/demo/reels_real.dart';
import 'package:hf_app/demo/screens/favourites.dart';
import 'package:hf_app/demo/screens/feed.dart';
import 'package:hf_app/demo/screens/search.dart';
import 'package:hf_app/demo/state.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Map<String, Object?>?> queries = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    queries.add(query);
    final out = handler(method, path, query, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _host(String slug, String name, {String presence = 'online'}) =>
    {'slug': slug, 'name': name, 'handle': '@$slug', 'avatar': null, 'ratePaise': 1500, 'followers': 100, 'presence': presence};

const _down = ApiException(kind: ApiFailure.http, status: 503, code: 'unavailable', message: 'Try again in a little while.');

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: '/start', routes: [
    GoRoute(path: '/start', builder: (_, __) => home),
    GoRoute(path: '/profile/:id', builder: (_, s) => Scaffold(body: Text('PROFILE ${s.pathParameters['id']}'))),
  ]);
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  await tester.pump();
}

void main() {
  setUp(() {
    PresenceBridge.forceReal = true;
    demo.applyAccount(name: 'Fan', email: 'f@x.in', whatsapp: '******3210');
  });
  tearDown(() {
    PresenceBridge.forceReal = false;
    FavouritesStore.override = null;
    ShareSheet.testSink = null;
    ReelPlayer.testPlayer = null;
    demo.signOut();
  });

  group('SearchRepo', () {
    test('search sends q and topic without sign-in, and parses the three lists', () async {
      final api = FakeApiClient((m, p, q, b) => {
            'ok': true,
            'online': [_host('maya', 'Maya')],
            'offline': [_host('ravi', 'Ravi', presence: 'offline')],
            'notOnNetwork': [{'handle': '@newstar', 'platform': 'youtube', 'followers': 4200, 'votes': 3}],
          });
      final r = await SearchRepo(api).search(' maya ', topic: 'travel-and-food');
      expect(api.calls, ['GET /api/hf/search']);
      expect(api.queries.single, {'q': 'maya', 'topic': 'travel-and-food'});
      expect(r.online.single.slug, 'maya');
      expect(r.offline.single.online, isFalse);
      expect(r.notOnNetwork.single, isA<MissingCreator>().having((c) => c.votes, 'votes', 3).having((c) => c.followers, 'followers', 4200));
    });

    test('vote posts to the platform and handle path and returns the total; flag off is friendly', () async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'votes': 7, 'voted': true});
      final n = await SearchRepo(api).vote(const MissingCreator(handle: '@newstar', platform: 'youtube'));
      expect(n, 7);
      expect(api.calls, ['POST /api/hf/invites/youtube/newstar']);
      final off = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: 'x'));
      await expectLater(SearchRepo(off).vote(const MissingCreator(handle: '@a', platform: 'instagram')),
          throwsA(isA<ApiException>().having((e) => e.message, 'message', SearchRepo.notOpenText)));
      expect(await SearchRepo(off).topInvites(), isEmpty);
    });
  });

  group('FavouritesStore', () {
    test('toggle is optimistic and rolls back when the server fails', () async {
      var fail = false;
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'GET') return {'ok': true, 'items': [{'slug': 'maya', 'displayName': 'Maya', 'presence': 'online'}]};
        return fail ? _down : {'ok': true, 'saved': m == 'PUT'};
      });
      final store = FavouritesStore(FavouritesRepo(api));
      await store.ensureLoaded();
      expect(store.isFav('maya'), isTrue);
      expect(await store.toggle('maya'), isFalse);
      expect(store.isFav('maya'), isFalse);
      expect(api.calls.last, 'DELETE /api/hf/favourites/maya');
      fail = true;
      await expectLater(store.toggle('ravi'), throwsA(isA<ApiException>()));
      expect(store.isFav('ravi'), isFalse); // rolled back
    });
  });

  group('RealSearch', () {
    testWidgets('typing is debounced 350 ms, then Online comes before Offline, and INVITE votes with a toast', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p == '/api/hf/options') return {'topics': [{'slug': 'travel-and-food', 'label': 'Travel & food'}]};
        if (p == '/api/hf/invites/top') return {'ok': true, 'items': <Object?>[]};
        if (p == '/api/hf/invites/youtube/newstar') return {'ok': true, 'votes': 4, 'voted': true};
        final text = q?['q'];
        if (text == '') return {'ok': true, 'online': [_host('maya', 'Maya')], 'offline': <Object?>[], 'notOnNetwork': <Object?>[]};
        return {
          'ok': true,
          'online': [_host('maya', 'Maya')],
          'offline': [_host('ravi', 'Ravi', presence: 'offline')],
          'notOnNetwork': [{'handle': '@newstar', 'platform': 'youtube', 'votes': 3}],
        };
      });
      await _pump(tester, SearchScreen(repo: SearchRepo(api)));
      final before = api.calls.where((c) => c == 'GET /api/hf/search').length;
      expect(find.text('Online now'), findsOneWidget);
      expect(find.byKey(const ValueKey('topic-travel-and-food')), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('search-field')), 'm');
      await tester.enterText(find.byKey(const ValueKey('search-field')), 'ma');
      await tester.pump(const Duration(milliseconds: 200));
      expect(api.calls.where((c) => c == 'GET /api/hf/search').length, before, reason: 'still inside the debounce window');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expect(api.calls.where((c) => c == 'GET /api/hf/search').length, before + 1, reason: 'one request for the settled text');
      expect(api.queries.last?['q'], 'ma');

      final online = tester.getTopLeft(find.byKey(const ValueKey('hit-maya'))).dy;
      final offline = tester.getTopLeft(find.byKey(const ValueKey('hit-ravi'))).dy;
      expect(online, lessThan(offline));
      expect(find.text('Not on ${Brand.name} yet'), findsOneWidget);

      await tester.tap(find.text('INVITE'));
      await tester.pump();
      await tester.pump();
      expect(api.calls, contains('POST /api/hf/invites/youtube/newstar'));
      expect(find.text('Voted! We will ask @newstar to join.'), findsOneWidget);
      expect(find.text('VOTED'), findsOneWidget);
      expect(find.textContaining('4 votes'), findsOneWidget);
    });

    testWidgets('a failing search shows Try again', (tester) async {
      final api = FakeApiClient((m, p, q, b) => p == '/api/hf/search' ? _down : {'topics': <Object?>[], 'items': <Object?>[]});
      await _pump(tester, SearchScreen(repo: SearchRepo(api)));
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('RealFavourites', () {
    testWidgets('shows the grid, removes optimistically, and rolls back on failure', (tester) async {
      var failDelete = true;
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'GET') {
          return {
            'ok': true,
            'items': [
              {'slug': 'maya', 'displayName': 'Maya', 'photoUrl': null, 'headline': 'Calm listener', 'presence': 'online'},
              {'slug': 'ravi', 'displayName': 'Ravi', 'presence': 'offline'},
            ],
          };
        }
        return m == 'DELETE' && failDelete ? _down : {'ok': true, 'saved': false};
      });
      final repo = FavouritesRepo(api);
      FavouritesStore.override = FavouritesStore(repo);
      await _pump(tester, FavouritesScreen(repo: repo));
      expect(find.byKey(const ValueKey('fav-maya')), findsOneWidget);
      expect(find.byKey(const ValueKey('fav-ravi')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('remove-ravi')));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('fav-ravi')), findsOneWidget, reason: 'rolled back after the failure');

      failDelete = false;
      await tester.tap(find.byKey(const ValueKey('remove-ravi')));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('fav-ravi')), findsNothing);
      expect(api.calls.where((c) => c == 'DELETE /api/hf/favourites/ravi').length, 2);
    });

    testWidgets('empty state matches the demo copy', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'items': <Object?>[]});
      final repo = FavouritesRepo(api);
      FavouritesStore.override = FavouritesStore(repo);
      await _pump(tester, FavouritesScreen(repo: repo));
      expect(find.text('No favourites yet'), findsOneWidget);
      expect(find.text('Tap ♥ on a reel to save it here.'), findsOneWidget);
    });
  });

  group('reel heart and share', () {
    FeedReel reel() => FeedReel.fromJson({'id': 'hfrl_abc12345', 'host': _host('maya', 'Maya'), 'caption': 'Hello', 'embedUrl': 'https://www.youtube.com/embed/abc12345'});

    testWidgets('the heart saves by influencer slug (optimistic) and share opens the system sheet with the brand link', (tester) async {
      ReelPlayer.testPlayer = (r, active) => const SizedBox();
      final api = FakeApiClient((m, p, q, b) => m == 'GET' ? {'ok': true, 'items': <Object?>[]} : {'ok': true, 'saved': true});
      FavouritesStore.override = FavouritesStore(FavouritesRepo(api));
      String? shared;
      ShareSheet.testSink = (text) async => shared = text;
      final r = reel();
      await _pump(tester, Scaffold(body: ReelPage(reel: demoReelFrom(r), active: true, real: r)));
      await tester.tap(find.byIcon(Icons.favorite_border_rounded));
      await tester.pump();
      expect(FavouritesStore.instance.isFav('maya'), isTrue);
      await tester.pump();
      expect(api.calls, contains('PUT /api/hf/favourites/maya'));

      await tester.tap(find.byIcon(Icons.reply_rounded));
      await tester.pump();
      expect(shared, contains(Brand.url('/r/hfrl_abc12345')));
    });
  });
}
