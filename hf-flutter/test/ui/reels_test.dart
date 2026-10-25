import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/repos/reels_repo.dart';
import 'package:hf_app/data/share.dart';
import 'package:hf_app/data/telemetry.dart';
import 'package:hf_app/demo/my_reels_section.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/reel_player.dart';
import 'package:hf_app/demo/screens/feed.dart';
import 'package:hf_app/demo/screens/profile.dart';
import 'reel_more_helper.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    final out = handler(method, path, query, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _item(String id, {String slug = 'maya', String name = 'Maya', String? embed}) => {
      'id': id,
      'host': {'slug': slug, 'name': name, 'handle': '@maya', 'avatar': null, 'ratePaise': 1200, 'followers': 5400, 'presence': 'online'},
      'platform': 'youtube',
      'embedUrl': embed ?? 'https://www.youtube.com/embed/abc12345',
      'thumbUrl': null,
      'caption': 'Caption $id',
      'likes': 12,
      'views': 3400,
    };

const _serverDown = ApiException(kind: ApiFailure.http, status: 503, code: 'unavailable', message: 'Try again in a little while.');

/// Records which reels the (stubbed) player was told to play.
Map<String, bool> _stubPlayer() {
  final seen = <String, bool>{};
  ReelPlayer.testPlayer = (reel, active) {
    seen[reel.id] = active;
    return Container(key: ValueKey('player-${reel.id}'), color: Colors.black);
  };
  return seen;
}

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: '/start', routes: [
    GoRoute(path: '/start', builder: (_, __) => home),
    GoRoute(path: '/inf/channels', builder: (_, __) => const Scaffold(body: Text('CHANNELS'))),
  ]);
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  await tester.pump();
}

void main() {
  setUp(() => PresenceBridge.forceReal = true);
  tearDown(() {
    PresenceBridge.forceReal = false;
    ReelPlayer.testPlayer = null;
  });

  group('ReelsRepo', () {
    test('[HF-REEL-SKIP-2] reportUnplayable posts the reason, signed out, and never throws', () async {
      Object? sent;
      final api = FakeApiClient((m, p, q, b) {
        sent = b;
        return {'ok': true};
      });
      await ReelsRepo(api).reportUnplayable('hfrl_abc12345', 'appOnly');
      expect(api.calls, ['POST /api/hf/reels/hfrl_abc12345/unplayable']);
      expect(sent, {'reason': 'appOnly'});
      final down = FakeApiClient((m, p, q, b) => throw Exception('offline'));
      await ReelsRepo(down).reportUnplayable('hfrl_abc12345', 'appOnly');
    });

    test('feed parses items, host and the next cursor, and asks without sign-in', () async {
      final api = FakeApiClient((m, p, q, b) => {
            'ok': true,
            'items': [_item('hfrl_1'), _item('hfrl_2')],
            'nextCursor': '5_hfrl_2',
          });
      final page = await ReelsRepo(api).feed(cursor: 'abc');
      expect(api.calls, ['GET /api/hf/reels']);
      expect(page.nextCursor, '5_hfrl_2');
      expect(page.items.length, 2);
      expect(page.items.first.host, isA<ReelHost>().having((h) => h.rateRupees, 'rate', 12).having((h) => h.followers, 'followers', 5400));
      expect(page.items[1].playable, isTrue); // embeds only: playable means it has an embed address
    });

    test('flag off becomes a friendly message; one() returns null on 404', () async {
      final off = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: 'x'));
      await expectLater(ReelsRepo(off).feed(), throwsA(isA<ApiException>().having((e) => e.message, 'message', ReelsRepo.notOpenText)));
      final gone = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_found', message: 'x'));
      expect(await ReelsRepo(gone).one('hfrl_x'), isNull);
    });

    test('mine and setVisible use the owner routes', () async {
      final api = FakeApiClient((m, p, q, b) => m == 'GET'
          ? {'ok': true, 'reels': [{'id': 'hfrl_1', 'visible': false, 'views': 7, 'platform': 'instagram'}]}
          : {'ok': true, 'reel': {'id': 'hfrl_1', 'visible': true}});
      final repo = ReelsRepo(api);
      final mine = await repo.mine();
      expect(mine.single.visible, isFalse);
      final r = await repo.setVisible('hfrl_1', true);
      expect(r.visible, isTrue);
      expect(api.calls, ['GET /api/hf/hosts/me/reels', 'PATCH /api/hf/reels/hfrl_1']);
      expect(api.bodies.last, {'visible': true});
    });

    test('profile parses reels and the host block', () async {
      final api = FakeApiClient((m, p, q, b) => {
            'slug': 'maya', 'displayName': 'Maya', 'status': 'online', 'pricePaisePerMin': 1500, 'followers': 900, 'handle': '@maya',
            'aboutPolished': 'Hi', 'reels': [_item('hfrl_1')..remove('host')],
          });
      final p = await ReelsRepo(api).profile('maya');
      expect(p.host.rateRupees, 15);
      expect(p.host.online, isTrue);
      expect(p.reels.single.host.slug, 'maya');
      expect(p.likes, 12);
    });
  });

  group('player url', () {
    test('YouTube runs in the IFrame API page with the app id as origin; the tap layer drives it', () {
      final u = ReelPlayer.embedUri('https://www.youtube.com/embed/abc12345');
      expect(u.queryParameters['autoplay'], '1');
      expect(u.queryParameters['playlist'], 'abc12345');
      final html = ReelPlayer.youtubeHtml('https://www.youtube.com/embed/abc12345')!;
      expect(html, contains('new YT.Player'));
      expect(html, contains('videoId:"abc12345"'));
      expect(html, contains('controls:0'));
      expect(html, contains('origin:"https://${Brand.domain}"'));
      expect(html, contains('window.hfToggle'));
      expect(html, contains('error:'));
      // [HF-REEL-ZOOM-1] zoomed in so YouTube's own header, side buttons and title strip sit off screen
      expect(html, contains('backdrop-filter:blur('));
      expect(html, contains('id="bb"'));
      expect(html, contains('id="bc"')); // [HF-REEL-YT-CENTER-1]
      expect(html, contains('id="bt"'));
      expect(html, contains('chrome(4000)'));
      expect(html, contains('function fit()'));
      expect(html, contains('*1.0)')); // [HF-REEL-YT-ZOOM-2]
      expect(html, isNot(contains('id="br"')));
      expect(html, isNot(contains('hfZoom')));
      expect(ReelPlayer.youtubeHtml('https://www.instagram.com/reel/Cx12345/embed'), isNull);
      expect(ReelPlayer.youtubeHtml('https://evil.example/embed/abc12345'), isNull);
      expect(ReelPlayer.embedUri('https://www.instagram.com/reel/Cx12345/embed').toString(), 'https://www.instagram.com/reel/Cx12345/embed');
    });

    test('Instagram opens the reel embed page and the script fills the page with the video', () {
      expect(ReelPlayer.instagramUri('https://www.instagram.com/reel/Cx12345/embed').toString(), 'https://www.instagram.com/reel/Cx12345/embed/');
      expect(ReelPlayer.instagramUri('https://www.instagram.com/p/Cx12345/embed/').toString(), 'https://www.instagram.com/reel/Cx12345/embed/');
      final js = ReelPlayer.instagramScript(sound: false);
      expect(js, contains('object-fit:cover'));
      expect(js, contains('querySelector(\'video\')'));
      expect(js, contains('SOUND=false'));
      expect(js, contains('HFPlayer.postMessage'));
      expect(js, contains('error:novideo'));
    });
  });

  group('RealFeed', () {
    testWidgets('empty feed says nobody is online', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'items': <Object?>[], 'nextCursor': null});
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), onlineFetch: () async => 0));
      expect(find.text(kFeedEmptyText), findsOneWidget);
    });

    testWidgets('failure shows Try again and retries', (tester) async {
      var fail = true;
      final api = FakeApiClient((m, p, q, b) => fail ? _serverDown : {'ok': true, 'items': [_item('hfrl_1')], 'nextCursor': null});
      _stubPlayer();
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), onlineFetch: () async => 1));
      expect(find.text('Try again'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('player-hfrl_1')), findsOneWidget);
    });

    testWidgets('plays the visible reel only, pages on, and counts a view once', (tester) async {
      final seen = _stubPlayer();
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/view')) return {'ok': true};
        return {'ok': true, 'items': [_item('hfrl_1'), _item('hfrl_2', name: 'Riya', slug: 'riya')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), onlineFetch: () async => 2));
      expect(seen['hfrl_1'], isTrue);
      expect(seen['hfrl_2'], isFalse); // readied, not playing
      expect(find.text('Caption hfrl_1'), findsNothing);
      // [HF-REEL-CALL-2] no information sheet any more: the bar says Call <name>, the photo sits in the rail, nothing else
      expect(find.byTooltip('Reel information'), findsNothing);
      expect(find.text('Call Maya'), findsOneWidget);
      expect(find.byKey(const ValueKey('reel-photo')), findsWidgets);
      expect(find.byTooltip('Book a time'), findsWidgets);
      await tester.fling(find.byType(PageView), const Offset(0, -900), 2000);
      await tester.pumpAndSettle();
      expect(seen['hfrl_1'], isFalse);
      expect(seen['hfrl_2'], isTrue);
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      expect(find.byTooltip('Open Riya profile'), findsOneWidget);
      expect(api.calls.where((c) => c.endsWith('/view')).toSet(), {'POST /api/hf/reels/hfrl_1/view', 'POST /api/hf/reels/hfrl_2/view'});
    });

    testWidgets('a shared reel opens first and is not repeated', (tester) async {
      final seen = _stubPlayer();
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/view')) return {'ok': true};
        if (p == '/api/hf/reels/hfrl_2') return {'ok': true, 'item': _item('hfrl_2', name: 'Riya', slug: 'riya')};
        return {'ok': true, 'items': [_item('hfrl_1'), _item('hfrl_2', name: 'Riya', slug: 'riya')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(reelId: 'hfrl_2', repo: ReelsRepo(api), onlineFetch: () async => 2));
      await tester.pump();
      expect(seen['hfrl_2'], isTrue);
      expect(seen['hfrl_1'], isFalse);
      expect(find.text('Caption hfrl_2'), findsNothing);
      await openReelMore(tester); // [HF-REEL-RAIL-2]
      expect(find.byTooltip('Open Riya profile'), findsOneWidget);
    });

    testWidgets('[HF-REEL-CALL-2] a link while the feed is already open: that reel plays at once, the old first reel never plays again before it', (tester) async {
      final log = <String>[];
      ReelPlayer.testPlayer = (reel, active) {
        log.add('${reel.id}:$active');
        return Container(key: ValueKey('player-${reel.id}'), color: Colors.black);
      };
      final events = <String>[];
      final old = Telemetry.sink;
      Telemetry.sink = (e, props) => events.add('$e ${props['reel_id']} ${props['cached']}');
      addTearDown(() => Telemetry.sink = old);
      final link = ValueNotifier<String?>(null);
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/view')) return {'ok': true};
        if (p == '/api/hf/reels/hfrl_9') return {'ok': true, 'item': _item('hfrl_9', name: 'Zara', slug: 'zara')};
        return {'ok': true, 'items': [_item('hfrl_1'), _item('hfrl_2', name: 'Riya', slug: 'riya')], 'nextCursor': null};
      });
      await _pump(tester, ValueListenableBuilder<String?>(
        valueListenable: link,
        builder: (_, id, __) => FeedScreen(reelId: id, repo: ReelsRepo(api), onlineFetch: () async => 2),
      ));
      expect(log, contains('hfrl_1:true'));
      log.clear();
      link.value = 'hfrl_9';
      for (var i = 0; i < 4; i++) {
        await tester.pump();
      }
      expect(log, contains('hfrl_9:true'));
      expect(log, isNot(contains('hfrl_1:true')));
      expect(log, isNot(contains('hfrl_2:true')));
      expect(find.text('Call Zara'), findsOneWidget);
      expect(api.calls.where((c) => c == 'GET /api/hf/reels/hfrl_9'), hasLength(1));
      expect(api.calls.where((c) => c == 'GET /api/hf/reels'), hasLength(2)); // the opening feed + the one attached behind the link
      expect(events, contains('reel_deeplink_open hfrl_9 false'));
    });

    testWidgets('[HF-REEL-CALL-2] a link to a reel that is gone falls back to the ordinary feed', (tester) async {
      final seen = _stubPlayer();
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/view')) return {'ok': true};
        if (p == '/api/hf/reels/hfrl_gone') return const ApiException(kind: ApiFailure.http, status: 404, code: 'not_found', message: 'x');
        return {'ok': true, 'items': [_item('hfrl_1')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(reelId: 'hfrl_gone', repo: ReelsRepo(api), onlineFetch: () async => 1));
      await tester.pump();
      expect(seen['hfrl_1'], isTrue);
    });

    testWidgets('[HF-REEL-CALL-2] Share sends this reel\'s own caption and link, on every page', (tester) async {
      _stubPlayer();
      final sent = <String>[];
      ShareSheet.testSink = (text) async => sent.add(text);
      addTearDown(() => ShareSheet.testSink = null);
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/view')) return {'ok': true};
        return {'ok': true, 'items': [_item('hfrl_1'), _item('hfrl_2', name: 'Riya', slug: 'riya')], 'nextCursor': null};
      });
      await _pump(tester, FeedScreen(repo: ReelsRepo(api), onlineFetch: () async => 2));
      Finder share(String id) => find.descendant(of: find.byKey(ValueKey('$id~0')), matching: find.byTooltip('Share this reel'));
      await tester.tap(share('hfrl_1'));
      await tester.pump();
      expect(sent.last, 'Caption hfrl_1\n${reelShareUrl('hfrl_1')}');
      await tester.fling(find.byType(PageView), const Offset(0, -900), 2000);
      await tester.pumpAndSettle();
      await tester.tap(share('hfrl_2'));
      await tester.pump();
      expect(sent.last, 'Caption hfrl_2\n${reelShareUrl('hfrl_2')}');
    });
  });

  group('MyReelsSection', () {
    Map<String, Object?> mine(String id, bool visible) => {'id': id, 'visible': visible, 'views': 1200, 'platform': 'youtube', 'caption': 'c'};

    testWidgets('shows the copy and toggles Show on feed / Hide with the real PATCH', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'GET') return {'ok': true, 'reels': [mine('hfrl_1', false), mine('hfrl_2', true)]};
        return {'ok': true, 'reel': mine('hfrl_1', true)};
      });
      await _pump(tester, Scaffold(body: MyReelsSection(repo: ReelsRepo(api))));
      expect(find.text(kPickReelsText), findsOneWidget);
      expect(find.text('1 of 2 are in the feed.'), findsOneWidget);
      expect(find.text('Show on feed'), findsOneWidget);
      expect(find.text('Hide'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('toggle-hfrl_1')));
      await tester.pump();
      await tester.pump();
      expect(api.calls.last, 'PATCH /api/hf/reels/hfrl_1');
      expect(api.bodies.last, {'visible': true});
      expect(find.text('2 of 2 are in the feed.'), findsOneWidget);
    });

    testWidgets('rolls back when the server says no', (tester) async {
      final api = FakeApiClient((m, p, q, b) => m == 'GET' ? {'ok': true, 'reels': [mine('hfrl_1', false)]} : _serverDown);
      await _pump(tester, Scaffold(body: MyReelsSection(repo: ReelsRepo(api))));
      await tester.tap(find.byKey(const ValueKey('toggle-hfrl_1')));
      await tester.pump();
      await tester.pump();
      expect(find.text('0 of 1 are in the feed.'), findsOneWidget);
      expect(find.text('Show on feed'), findsOneWidget);
    });

    testWidgets('empty list explains what to do', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'reels': <Object?>[]});
      await _pump(tester, Scaffold(body: MyReelsSection(repo: ReelsRepo(api))));
      expect(find.textContaining('No videos yet'), findsOneWidget);
    });
  });

  group('Profile videos', () {
    testWidgets('real videos fill the grid and open the full-screen player', (tester) async {
      final seen = _stubPlayer();
      final api = FakeApiClient((m, p, q, b) => {
            'slug': 'maya', 'displayName': 'Maya', 'status': 'online', 'pricePaisePerMin': 1500, 'followers': 900, 'handle': '@maya',
            'reels': [_item('hfrl_1')..remove('host'), _item('hfrl_2')..remove('host')],
          });
      await _pump(tester, ProfileScreen(id: 'maya', repo: ReelsRepo(api)));
      expect(find.text('Maya'), findsWidgets);
      expect(find.byKey(const ValueKey('video-hfrl_1')), findsOneWidget);
      expect(find.byKey(const ValueKey('video-hfrl_2')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey('video-hfrl_2')));
      await tester.tap(find.byKey(const ValueKey('video-hfrl_2')));
      await tester.pumpAndSettle();
      expect(seen['hfrl_2'], isTrue);
      expect(find.byKey(const ValueKey('preview-mute')), findsOneWidget); // [HF-REEL-CALL-2] light preview: close X + mute only
      expect(find.byKey(const ValueKey('reel-call-bar')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('preview-close')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('preview-close')), findsNothing);
    });

    testWidgets('unavailable profile shows the error with Try again', (tester) async {
      final api = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_found', message: 'Not here'));
      await _pump(tester, ProfileScreen(id: 'nobody', repo: ReelsRepo(api)));
      expect(find.text('Try again'), findsOneWidget);
    });
  });
}
