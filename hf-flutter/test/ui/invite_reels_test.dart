import 'package:hf_app/data/services.dart';
import 'package:hf_app/data/auth/clerk_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/repos/reels_repo.dart';
import 'package:hf_app/data/repos/search_repo.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/reel_player.dart';
import 'package:hf_app/demo/screens/feed.dart';
import 'package:hf_app/demo/screens/search.dart';
import 'package:hf_app/demo/state.dart';

// [HF-WIRE-22] Invite reels in the feed (HF-REEL-40) and the search platform filter (HF-REEL-41).

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

Map<String, Object?> _network(String id) => {
      'id': id,
      'host': {'slug': 'maya', 'name': 'Maya', 'handle': '@maya', 'avatar': null, 'ratePaise': 1200, 'followers': 5400, 'presence': 'online'},
      'platform': 'youtube',
      'embedUrl': 'https://www.youtube.com/embed/abc12345',
      'caption': 'Caption $id',
      'likes': 12,
      'views': 3400,
    };

Map<String, Object?> _invite(String id) => {
      'id': id,
      'kind': 'invite',
      'creator': {'platform': 'youtube', 'handle': '@newstar', 'name': 'New Star', 'avatar': null, 'followers': 4200, 'votes': 3},
      'platform': 'youtube',
      'embedUrl': 'https://www.youtube.com/embed/zzz12345',
      'caption': 'Invite caption $id',
      'likes': 1500,
      'views': 99,
    };

Map<String, Object?> _host(String slug, String name, {List<String> platforms = const []}) =>
    {'slug': slug, 'name': name, 'handle': '@$slug', 'avatar': null, 'ratePaise': 1500, 'followers': 100, 'presence': 'online', 'platforms': platforms};

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
    Services.instance.user = const ClerkUser(id: 'test_fan');
    InviteVotes.voted.clear();
    demo.applyAccount(name: 'Fan', email: 'f@x.in', whatsapp: '******3210');
    ReelPlayer.testPlayer = (r, active) => Container(key: ValueKey('player-${r.id}'), color: Colors.black);
  });
  tearDown(() {
    PresenceBridge.forceReal = false;
    Services.instance.user = null;
    ReelPlayer.testPlayer = null;
    demo.signOut();
  });

  group('models', () {
    test('an invite item parses its creator; a network item has no invite', () {
      final i = FeedReel.fromJson(_invite('hfiv_1'));
      expect(i.isInvite, isTrue);
      expect(i.invite, isA<InviteCreator>().having((c) => c.handle, 'handle', '@newstar').having((c) => c.votes, 'votes', 3).having((c) => c.followers, 'followers', 4200));
      expect(i.host.name, 'New Star');
      expect(i.playable, isTrue);
      final n = FeedReel.fromJson(_network('hfrl_1'));
      expect(n.isInvite, isFalse);
      expect(n.host.slug, 'maya');
      expect(n.withHost(n.host).isInvite, isFalse);
      expect(i.withHost(i.host).isInvite, isTrue);
    });

    test('hosts keep their platforms', () {
      expect(ReelHost.fromJson(_host('maya', 'Maya', platforms: ['youtube', 'instagram'])).platforms, ['youtube', 'instagram']);
      expect(ReelHost.fromJson({'slug': 'x'}).platforms, isEmpty);
    });

    test('search sends platform only for youtube / instagram', () async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'online': <Object?>[], 'offline': <Object?>[], 'notOnNetwork': <Object?>[]});
      final repo = SearchRepo(api);
      await repo.search('a');
      await repo.search('a', platform: 'all');
      await repo.search('a', platform: 'instagram');
      expect(api.queries[0], {'q': 'a'});
      expect(api.queries[1], {'q': 'a'});
      expect(api.queries[2], {'q': 'a', 'platform': 'instagram'});
    });
  });

  group('feed with invite reels', () {
    testWidgets('a feed with only invite reels is not empty: pill, stats and INVITE instead of CALL NOW', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'items': [_invite('hfiv_1')], 'nextCursor': null});
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 0));
      expect(find.text(kFeedEmptyText), findsNothing);
      expect(find.byKey(const ValueKey('player-hfiv_1')), findsOneWidget);
      expect(find.text('Not on ${Brand.name} yet'), findsOneWidget);
      expect(find.text('INVITE'), findsOneWidget);
      expect(find.text('CALL NOW'), findsNothing);
      expect(find.text('Invite caption hfiv_1'), findsOneWidget);
      expect(find.byKey(const ValueKey('invite-stats')), findsOneWidget);
      expect(find.textContaining('@newstar'), findsWidgets);
      expect(api.calls.where((c) => c.endsWith('/view')), isEmpty, reason: 'we do not count views of other people\'s reels');
    });

    testWidgets('an empty feed still shows the empty state', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'items': <Object?>[], 'nextCursor': null});
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 0));
      expect(find.text(kFeedEmptyText), findsOneWidget);
    });

    testWidgets('network cards are unchanged and come first', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/view')) return {'ok': true};
        return {'ok': true, 'items': [_network('hfrl_1'), _invite('hfiv_1')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 1));
      expect(find.text('CALL NOW'), findsOneWidget);
      expect(find.text('INVITE'), findsNothing);
      expect(find.text('Not on ${Brand.name} yet'), findsNothing);
      await tester.fling(find.byType(PageView), const Offset(0, -900), 2000);
      await tester.pumpAndSettle();
      expect(find.text('INVITE'), findsOneWidget);
      expect(find.text('CALL NOW'), findsNothing);
    });

    testWidgets('INVITE votes, toasts, and the button becomes Voted', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p == '/api/hf/invites/youtube/newstar') return {'ok': true, 'votes': 4, 'voted': true};
        return {'ok': true, 'items': [_invite('hfiv_1')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 0));
      await tester.tap(find.text('INVITE'));
      await tester.pump();
      await tester.pump();
      expect(api.calls, contains('POST /api/hf/invites/youtube/newstar'));
      expect(find.text('Voted! We will ask @newstar to join.'), findsOneWidget);
      expect(find.text('VOTED'), findsOneWidget);
      expect(find.text('INVITE'), findsNothing);
    });

    testWidgets('a failed vote shows the message and leaves INVITE tappable', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p.startsWith('/api/hf/invites/')) return const ApiException(kind: ApiFailure.http, status: 503, code: 'unavailable', message: 'Try again in a little while.');
        return {'ok': true, 'items': [_invite('hfiv_1')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 0));
      await tester.tap(find.text('INVITE'));
      await tester.pump();
      await tester.pump();
      expect(find.text('VOTED'), findsNothing);
      expect(find.text('INVITE'), findsOneWidget);
    });
  });

  group('search platform filter', () {
    Handler searchApi() => (m, p, q, b) {
          if (p == '/api/hf/options') return {'topics': <Object?>[]};
          if (p == '/api/hf/invites/top') return {'ok': true, 'items': <Object?>[]};
          return {
            'ok': true,
            'online': [_host('maya', 'Maya', platforms: ['youtube'])],
            'offline': <Object?>[],
            'notOnNetwork': [{'handle': '@newstar', 'platform': 'instagram', 'votes': 3}],
          };
        };

    testWidgets('All / YouTube / Instagram pass the platform to the API and have readable text', (tester) async {
      final api = FakeApiClient(searchApi());
      await _pump(tester, SearchScreen(repo: SearchRepo(api)));
      for (final label in ['All', 'YouTube', 'Instagram']) {
        final text = tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('platform-filter')), matching: find.text(label)));
        expect(text.style!.fontSize, greaterThanOrEqualTo(14));
      }
      Map<String, Object?>? lastSearch() => api.queries.lastWhere((q) => q != null && q.containsKey('q'));
      expect(lastSearch()!.containsKey('platform'), isFalse);

      await tester.tap(find.byKey(const ValueKey('platform-youtube')));
      await tester.pump();
      await tester.pump();
      expect(lastSearch()!['platform'], 'youtube');

      await tester.tap(find.byKey(const ValueKey('platform-instagram')));
      await tester.pump();
      await tester.pump();
      expect(lastSearch()!['platform'], 'instagram');

      // [HF-APP-CACHE-1] "All" was already read a moment ago, so it is answered from the saved copy: no new request, and the
      // cache key holds the whole query so it is not the YouTube/Instagram answer.
      final before = api.queries.length;
      await tester.tap(find.byKey(const ValueKey('platform-all')));
      await tester.pump();
      await tester.pump();
      expect(api.queries.length, before, reason: 'served from the cache');
      expect(api.queries.where((q) => q != null && q.containsKey('q') && !q.containsKey('platform')).length, 1);
    });

    testWidgets('results show a small platform icon', (tester) async {
      final api = FakeApiClient(searchApi());
      await _pump(tester, SearchScreen(repo: SearchRepo(api)));
      await tester.enterText(find.byKey(const ValueKey('search-field')), 'maya');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      expect(find.byKey(const ValueKey('plat-icon-youtube')), findsOneWidget); // Maya's channel
      expect(find.byKey(const ValueKey('plat-icon-instagram')), findsOneWidget); // the not-on-network row
    });
  });
}
