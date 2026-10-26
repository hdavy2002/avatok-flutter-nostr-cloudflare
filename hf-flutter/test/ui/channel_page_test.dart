import 'fake_reel_bookmarks.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/data/reel_bookmarks.dart';
import 'package:hf_app/data/services.dart';
import 'package:hf_app/data/auth/clerk_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/favourites_store.dart';
import 'package:hf_app/data/repos/favourites_repo.dart';
import 'package:hf_app/data/repos/reels_repo.dart';
import 'package:hf_app/data/repos/search_repo.dart';
import 'package:hf_app/data/telemetry.dart';
import 'package:hf_app/demo/favourites_real.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/reel_player.dart';
import 'package:hf_app/demo/screens/creator_page.dart';
import 'package:hf_app/demo/screens/feed.dart';
import 'package:hf_app/demo/screens/page_moved.dart';
import 'package:hf_app/demo/state.dart';
import 'reel_more_helper.dart';

// [HF-REELS-FAV-1] Channel name / avatar on a reel opens the right page, the heart on a reel reaches the Favourites tab,
// and an unknown route shows the friendly page.

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
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

Future<void> _pump(WidgetTester tester, Widget home, {SearchRepo? searchRepo}) async {
  tester.view.physicalSize = const Size(900, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: '/start', errorBuilder: hfErrorPage, routes: [
    GoRoute(path: '/start', builder: (_, __) => home),
    GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS HOME'))),
    GoRoute(path: '/profile/:id', builder: (_, s) => Scaffold(body: Text('PROFILE ${s.pathParameters['id']}'))),
    GoRoute(path: '/creator/:platform/:handle', builder: (_, s) => inviteProfileFromRoute(s, searchRepo: searchRepo)),
  ]);
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  await tester.pump();
}

Widget _blank(BuildContext _) => const SizedBox();

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    Services.instance.user = const ClerkUser(id: 'test_fan');
    ReelBookmarks.override = WidgetBookmarks(FakeApiClient((m,p,q,b) => {'items': []}), () => Services.instance.user?.id);
    PresenceBridge.forceReal = true;
    InviteVotes.clear();
    demo.applyAccount(name: 'Fan', email: 'f@x.in', whatsapp: '******3210');
    ReelPlayer.testPlayer = (r, active) => Container(key: ValueKey('player-${r.id}'), color: Colors.black);
  });
  tearDown(() {
    PresenceBridge.forceReal = false;
    ReelPlayer.testPlayer = null;
    FavouritesStore.override = null;
    ReelBookmarks.override = null;
    Services.instance.user = null;
    demo.signOut();
  });

  group('channel name and avatar on a reel', () {
    testWidgets('a creator not on the app: the photo opens the invite page, never /profile/', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p.startsWith('/api/hf/invites/')) return {'ok': true, 'votes': 4, 'voted': true};
        return {'ok': true, 'items': [_invite('hfiv_1'), _invite('hfiv_2')], 'nextCursor': null};
      });
      final search = SearchRepo(api);
      final events = <String>[];
      final old = Telemetry.sink;
      Telemetry.sink = (e, props) => events.add('$e ${props['source']} ${props['kind']}');
      addTearDown(() => Telemetry.sink = old);
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: search, onlineFetch: () async => 0), searchRepo: search);
      await tester.tap(find.byKey(const ValueKey('reel-photo')).first); // [HF-REEL-RAW-APP-1] the photo in the strip under the video
      await tester.pump();
      await tester.pump();
      // The feed stays underneath the pushed page, so look inside the page only.
      Finder inPage(Finder f) => find.descendant(of: find.byKey(const ValueKey('invite-profile')), matching: f);
      expect(find.byKey(const ValueKey('invite-profile')), findsOneWidget);
      expect(events, contains('reel_profile_tap strip invite'));
      expect(find.textContaining('PROFILE'), findsNothing);
      expect(inPage(find.text('New Star')), findsOneWidget);
      expect(inPage(find.textContaining('@newstar')), findsWidgets);
      expect(inPage(find.text('Vote to invite')), findsOneWidget); // [HF-REEL-CALL-2]
      expect(inPage(find.text('New Star isn\'t on ${Brand.name} yet. Your vote tells us to invite them.')), findsOneWidget);
      expect(inPage(find.text('Not on ${Brand.name} yet')), findsNothing);
      expect(inPage(find.text('Followers')), findsOneWidget);
      expect(inPage(find.text('4.2K')), findsOneWidget);
      expect(inPage(find.byKey(const ValueKey('video-hfiv_1'))), findsOneWidget);
      expect(inPage(find.byKey(const ValueKey('video-hfiv_2'))), findsOneWidget);
      expect(inPage(find.text('CALL NOW')), findsNothing);
      expect(inPage(find.text('BOOK')), findsNothing);
      expect(inPage(find.text('VOTE TO INVITE')), findsOneWidget);

      await tester.tap(inPage(find.byKey(const ValueKey('invite-button')))); // the feed underneath has one too
      await tester.pump();
      await tester.pump();
      expect(api.calls, contains('POST /api/hf/invites/youtube/newstar'));
      expect(inPage(find.text('VOTED')), findsOneWidget);
    });

    testWidgets('[HF-REEL-RAW-APP-1] an invite reel has VOTE TO INVITE in the strip under the video (no Call bar); the name opens the same page', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'items': [_invite('hfiv_1')], 'nextCursor': null});
      final events = <String>[];
      final old = Telemetry.sink;
      Telemetry.sink = (e, props) => events.add('$e ${props['source']} ${props['kind']}');
      addTearDown(() => Telemetry.sink = old);
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 0));
      expect(find.byKey(const ValueKey('reel-strip')), findsOneWidget);
      expect(find.byKey(const ValueKey('reel-call-bar')), findsNothing);
      expect(find.descendant(of: find.byKey(const ValueKey('reel-strip')), matching: find.byKey(const ValueKey('invite-button'))), findsOneWidget);
      expect(find.textContaining('Not on ${Brand.name}'), findsNothing);
      expect(find.text('Invite caption hfiv_1'), findsNothing); // no caption over the video
      expect(find.byTooltip('Reel information'), findsNothing);
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('reel-strip')), matching: find.text('New Star')));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('invite-profile')), findsOneWidget);
      expect(events, contains('reel_profile_tap strip invite'));
    });

    testWidgets('a creator page opened from a link (no extra) still shows name, handle and VOTE TO INVITE', (tester) async {
      await _pump(tester, const Builder(key: ValueKey('home'), builder: _blank));
      final ctx = tester.element(find.byKey(const ValueKey('home')));
      GoRouter.of(ctx).go('/creator/youtube/%40bob');
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('invite-profile')), findsOneWidget);
      expect(find.text('@bob'), findsWidgets);
      expect(find.byKey(const ValueKey('invite-no-videos')), findsOneWidget);
      expect(find.text('VOTE TO INVITE'), findsOneWidget);
    });

    testWidgets('an influencer on the app: the name opens her public profile by slug', (tester) async {
      final api = FakeApiClient((m, p, q, b) => p.endsWith('/view') ? {'ok': true} : {'ok': true, 'items': [_network('hfrl_1')], 'nextCursor': null});
      FavouritesStore.override = FavouritesStore(FavouritesRepo(api));
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 1));
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      await tester.tap(find.byTooltip('Open Maya profile').first);
      await tester.pump();
      await tester.pump();
      expect(find.text('PROFILE maya'), findsOneWidget);
    });
  });

  group('heart on a reel', () {
    testWidgets('an invite card can save this video without offering call or book', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'items': [_invite('hfiv_1')], 'nextCursor': null});
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), searchRepo: SearchRepo(api), onlineFetch: () async => 0));
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      expect(find.byTooltip('Save video'), findsOneWidget);
      expect(find.byTooltip('Call now'), findsNothing);
      expect(find.byTooltip('Book a time'), findsNothing);
    });

    testWidgets('saving a reel updates an already open saved-video grid', (tester) async {
      var saved = false;
      final api = FakeApiClient((m, p, q, b) {
        if (p == '/api/hf/reel-bookmarks/hfrl_1' && m == 'PUT') saved = true;
        if (p.startsWith('/api/hf/reel-bookmarks')) return {'items': [if (saved) _network('hfrl_1')]};
        if (p.endsWith('/view')) return {'ok': true};
        return {'items': [_network('hfrl_1')]};
      });
      final store = WidgetBookmarks(api, () => Services.instance.user?.id);
      ReelBookmarks.override = store;
      await tester.pump();
      await store.load();
      await _pump(tester, Column(children: [
        Expanded(child: RealFavourites(repo: FavouritesRepo(api))),
        Expanded(child: FeedScreen(repo: ReelsRepo(api), onlineFetch: () async => 1)),
      ]));
      for (var i = 0; i < 10; i++) { await tester.pump(const Duration(milliseconds: 10)); }
      await tester.pump();
      expect(find.text('Caption hfrl_1'), findsNothing);
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      await tester.tap(find.byTooltip('Save video'));
      for (var i = 0; i < 10; i++) { await tester.pump(const Duration(milliseconds: 10)); }
      await tester.pump();
      expect(store.isSaved('hfrl_1'), isTrue);
      expect(api.calls, contains('PUT /api/hf/reel-bookmarks/hfrl_1'));
      expect(find.text('Caption hfrl_1'), findsOneWidget);
    });

    testWidgets('an unavailable bookmark endpoint keeps the local saved heart', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p.startsWith('/api/hf/reel-bookmarks')) return const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled');
        if (p.endsWith('/view')) return {'ok': true};
        return {'items': [_network('hfrl_1')]};
      });
      final store = WidgetBookmarks(api, () => Services.instance.user?.id);
      ReelBookmarks.override = store;
      await tester.pump();
      await store.load();
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), onlineFetch: () async => 1));
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      await tester.tap(find.byTooltip('Save video'));
      for (var i = 0; i < 10; i++) { await tester.pump(const Duration(milliseconds: 10)); }
      await tester.pump();
      expect(store.isSaved('hfrl_1'), isTrue);
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      expect(find.byTooltip('Remove saved video'), findsOneWidget);
    });
  });

  group('unknown route', () {
    testWidgets('shows the friendly page, never the GoException, logs telemetry, and Home goes to the reels', (tester) async {
      final events = <String>[];
      final old = Telemetry.sink;
      Telemetry.sink = (e, props) => events.add('$e ${props['path']}');
      addTearDown(() => Telemetry.sink = old);

      await _pump(tester, Builder(builder: (c) => TextButton(onPressed: () => c.push('/profile'), child: const Text('GO'))));
      await tester.tap(find.text('GO'));
      await tester.pump();
      await tester.pump();
      expect(find.text('This page moved'), findsOneWidget);
      expect(find.textContaining('GoException'), findsNothing);
      expect(find.textContaining('no routes'), findsNothing);
      expect(events, contains('hf_page_not_found /profile'));
      expect(Telemetry.catalogEvents, contains('hf_page_not_found'));

      await tester.tap(find.byKey(const ValueKey('page-moved-home')));
      await tester.pump();
      await tester.pump();
      expect(find.text('REELS HOME'), findsOneWidget);
    });
  });
}
