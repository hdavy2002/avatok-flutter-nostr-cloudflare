import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/deep_links.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/instagram_login.dart';
import 'package:hf_app/data/models/channel.dart';
import 'package:hf_app/data/repos/channels_repo.dart';
import 'package:hf_app/demo/channel_kit.dart';
import 'package:hf_app/demo/screens/channels.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// [HF-IG-LOGIN-1] "Log in with Instagram": repo calls, the login screen, the bio-code fallback, the Channels banners, the deep-link result and the
// "Switch to a Creator account" guide.

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, Object?> _ch(String id, {String state = 'approved', String platform = 'instagram', String handle = 'maya.reels', bool viaLogin = false, bool needsReconnect = false}) => {
      'id': id,
      'platform': platform,
      'handle': handle,
      'followers': 500,
      'state': state,
      'verified': true,
      'needsCode': false,
      'lastSyncAt': DateTime.now().millisecondsSinceEpoch,
      'createdAt': 1,
      'viaLogin': viaLogin,
      if (needsReconnect) 'needsReconnect': true,
    };

const _igUrl = 'https://www.instagram.com/oauth/authorize?client_id=1&state=abc';

class _Fake {
  _Fake(this.handler);

  final http.Response Function(http.Request req) handler;
  final List<http.Request> calls = [];

  ChannelsRepo get repo => ChannelsRepo(ApiClient(
        client: MockClient((req) async {
          calls.add(req);
          return handler(req);
        }),
        origin: 'https://api.test',
        tokens: ({bool forceRefresh = false}) async => 'jwt',
        reporter: (m, e, err, ms) {},
      ));

  Iterable<http.Request> to(String path) => calls.where((r) => r.url.path == path);
}

/// The browser tab, without a browser.
class _FakeLogin implements InstagramLogin {
  _FakeLogin({this.opens = true});
  final bool opens;
  final List<Uri> opened = [];

  @override
  Future<bool> open(Uri url) async {
    opened.add(url);
    return opens;
  }
}

http.Response _routes(http.Request r, {List<Map<String, Object?>> channels = const [], bool flag = true}) {
  switch (r.url.path) {
    case '/api/config':
      return _json({'hfChannelsEnabled': flag, 'hfInstagramLoginEnabled': flag});
    case '/api/hf/channels/instagram/start':
      return _json({'ok': true, 'url': _igUrl});
    case '/api/hf/channels':
      return _json({'ok': true, 'minFollowers': 10, 'qualified': true, 'channels': channels});
  }
  return _json({'ok': false, 'error': 'not_found'}, 404);
}

/// [settle] false keeps snackbars on screen (pumpAndSettle would wait for them to time out).
Future<void> _pump(WidgetTester tester, Widget home, {bool settle = true}) async {
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/inf/channels', builder: (_, __) => const Scaffold(body: Text('CHANNELS LIST'))),
      GoRoute(path: '/inf/channels/add/instagram', builder: (_, __) => const Scaffold(body: Text('IG LOGIN SCREEN'))),
      GoRoute(path: '/inf/channels/instagram-guide', builder: (_, __) => const InstagramSwitchGuideScreen()),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }
}

void main() {
  group('ChannelsRepo (Instagram login)', () {
    test('instagramLoginUrl asks the server for client=app and returns the Instagram URL', () async {
      final f = _Fake(_routes);
      final u = await f.repo.instagramLoginUrl();
      expect(u.toString(), _igUrl);
      expect(f.calls.single.url.path, '/api/hf/channels/instagram/start');
      expect(f.calls.single.url.queryParameters['client'], 'app');
      expect(f.calls.single.headers['Authorization'], 'Bearer jwt');
    });

    test('a URL that is not https://www.instagram.com is refused', () async {
      final f = _Fake((_) => _json({'ok': true, 'url': 'https://evil.example/oauth'}));
      await expectLater(f.repo.instagramLoginUrl(), throwsA(isA<Object>()));
    });

    test('instagramLoginEnabled needs both flags and is off when the config cannot be read', () async {
      expect(await _Fake((r) => _routes(r)).repo.instagramLoginEnabled(), isTrue);
      expect(await _Fake((r) => _routes(r, flag: false)).repo.instagramLoginEnabled(), isFalse);
      expect(await _Fake((_) => _json({'hfInstagramLoginEnabled': true})).repo.instagramLoginEnabled(), isFalse);
      expect(await _Fake((_) => _json({'x': 1}, 404)).repo.instagramLoginEnabled(), isFalse);
    });

    test('Channel.fromJson reads viaLogin and needsReconnect', () {
      final a = Channel.fromJson(_ch('a'));
      expect(a.viaLogin, isFalse);
      expect(a.isInstagramBioCode, isTrue);
      final b = Channel.fromJson(_ch('b', viaLogin: true, needsReconnect: true));
      expect(b.viaLogin, isTrue);
      expect(b.needsReconnect, isTrue);
      expect(b.isInstagramBioCode, isFalse);
      expect(Channel.fromJson(_ch('c', platform: 'youtube', handle: '@m')).isInstagramBioCode, isFalse);
      expect(Channel.fromJson(_ch('d', state: 'disconnected')).isInstagramBioCode, isFalse);
    });
  });

  group('ChannelConsentScreen (Instagram login)', () {
    testWidgets('shows a big Log in with Instagram button; no handle field; needs the tick; then opens the browser tab', (tester) async {
      final f = _Fake(_routes);
      final login = _FakeLogin();
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo, igLogin: IgLoginMode.on, instagramLogin: login));
      expect(find.text('LOG IN WITH INSTAGRAM'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.text("Can't log in? Verify with a code instead"), findsOneWidget);
      expect(tester.getSize(find.byType(ChannelBigButton)).height, greaterThanOrEqualTo(56));

      await tester.tap(find.text('LOG IN WITH INSTAGRAM'));
      await tester.pump();
      expect(find.textContaining('Please tick the box'), findsOneWidget);
      expect(f.calls, isEmpty);

      await tester.tap(find.byIcon(Icons.check_box_outline_blank_rounded));
      await tester.pump();
      await tester.tap(find.text('LOG IN WITH INSTAGRAM'));
      await tester.pumpAndSettle();
      expect(f.to('/api/hf/channels/instagram/start').length, 1);
      expect(login.opened.single.toString(), _igUrl);
      expect(find.textContaining('Finish logging in on Instagram'), findsOneWidget);
    });

    testWidgets('a browser that will not open says so in plain words', (tester) async {
      final f = _Fake(_routes);
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo, igLogin: IgLoginMode.on, instagramLogin: _FakeLogin(opens: false)));
      await tester.tap(find.byIcon(Icons.check_box_outline_blank_rounded));
      await tester.pump();
      await tester.tap(find.text('LOG IN WITH INSTAGRAM'));
      await tester.pumpAndSettle();
      expect(find.text('We could not open Instagram. Please try again.'), findsOneWidget);
    });

    testWidgets('the server saying "coming soon" is shown', (tester) async {
      final f = _Fake((r) => r.url.path.endsWith('/start') ? _json({'ok': false, 'error': 'provider_not_configured', 'message': 'Instagram login is coming soon.'}, 503) : _routes(r));
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo, igLogin: IgLoginMode.on, instagramLogin: _FakeLogin()));
      await tester.tap(find.byIcon(Icons.check_box_outline_blank_rounded));
      await tester.pump();
      await tester.tap(find.text('LOG IN WITH INSTAGRAM'));
      await tester.pumpAndSettle();
      expect(find.text('Instagram login is coming soon.'), findsOneWidget);
    });

    testWidgets('"Can\'t log in? Verify with a code instead" falls back to the bio-code form and says it is ownership only', (tester) async {
      final f = _Fake(_routes);
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo, igLogin: IgLoginMode.on, instagramLogin: _FakeLogin()));
      await tester.tap(find.byKey(const ValueKey('ig-code-link')));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('CONNECT'), findsOneWidget);
      expect(find.textContaining('A code only proves the account is yours'), findsOneWidget);
      expect(find.text('LOG IN WITH INSTAGRAM'), findsNothing);
    });

    testWidgets('flag off (default): only the bio-code form, no login button', (tester) async {
      final f = _Fake(_routes);
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo));
      expect(find.text('LOG IN WITH INSTAGRAM'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      expect(f.calls, isEmpty);
    });

    testWidgets('probe mode reads the public config: on shows the button, off shows the code form', (tester) async {
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: _Fake(_routes).repo, igLogin: IgLoginMode.probe));
      expect(find.text('LOG IN WITH INSTAGRAM'), findsOneWidget);
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: _Fake((r) => _routes(r, flag: false)).repo, igLogin: IgLoginMode.probe));
      expect(find.text('LOG IN WITH INSTAGRAM'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
    });
  });

  group('ChannelsListScreen (Instagram login)', () {
    testWidgets('a bio-code Instagram channel gets the banner; tapping it opens the login screen', (tester) async {
      final f = _Fake((r) => _routes(r, channels: [_ch('hfch_a'), _ch('hfch_y', platform: 'youtube', handle: '@maya')]));
      await _pump(tester, ChannelsListScreen(repo: f.repo, igLogin: IgLoginMode.on));
      expect(find.text(kInstagramBioCodeBanner), findsOneWidget);
      await tester.tap(find.text('LOG IN WITH INSTAGRAM'));
      await tester.pumpAndSettle();
      expect(find.text('IG LOGIN SCREEN'), findsOneWidget);
    });

    testWidgets('no banner for a logged-in channel, for YouTube, or when the flag is off', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake((r) => _routes(r, channels: [_ch('hfch_a', viaLogin: true)])).repo, igLogin: IgLoginMode.on));
      expect(find.text(kInstagramBioCodeBanner), findsNothing);
      expect(find.byKey(const ValueKey('ig-login-banner')), findsNothing);
      await _pump(tester, ChannelsListScreen(repo: _Fake((r) => _routes(r, channels: [_ch('hfch_a')])).repo));
      expect(find.text(kInstagramBioCodeBanner), findsNothing);
      await _pump(tester, ChannelsListScreen(repo: _Fake((r) => _routes(r, channels: [_ch('hfch_a'), _ch('y', platform: 'youtube', handle: '@m')], flag: false)).repo, igLogin: IgLoginMode.probe));
      expect(find.byKey(const ValueKey('ig-login-banner')), findsNothing);
    });

    testWidgets('probe mode shows the banner once the config says on', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake((r) => _routes(r, channels: [_ch('hfch_a')])).repo, igLogin: IgLoginMode.probe));
      expect(find.text(kInstagramBioCodeBanner), findsOneWidget);
    });

    testWidgets('an expired login asks to log in again', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake((r) => _routes(r, channels: [_ch('hfch_a', viaLogin: true, needsReconnect: true)])).repo, igLogin: IgLoginMode.on));
      expect(find.text(kInstagramReconnectBanner), findsOneWidget);
      expect(find.text('LOG IN AGAIN'), findsOneWidget);
    });

    testWidgets('deep link ig=connected -> a "connected" toast', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake((r) => _routes(r, channels: [_ch('hfch_a', viaLogin: true)])).repo, ig: 'connected', result: 'approved'), settle: false);
      expect(find.textContaining('Instagram connected'), findsOneWidget);
    });

    testWidgets('deep link reason=not_professional -> the "Switch to a Creator account" guide', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake(_routes).repo, ig: 'error', reason: 'not_professional'));
      expect(find.text('Switch to a Creator account'), findsOneWidget);
      for (final step in InstagramSwitchGuideScreen.steps) {
        expect(find.text(step), findsOneWidget);
      }
    });

    testWidgets('deep link reason=cancelled -> a toast, no guide', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake(_routes).repo, ig: 'error', reason: 'cancelled'), settle: false);
      expect(find.textContaining('Login cancelled'), findsOneWidget);
      expect(find.text('Switch to a Creator account'), findsNothing);
    });

    testWidgets('any other error reason -> a plain try-again toast', (tester) async {
      await _pump(tester, ChannelsListScreen(repo: _Fake(_routes).repo, ig: 'error', reason: 'provider_error'), settle: false);
      expect(find.textContaining('Instagram login did not work'), findsOneWidget);
    });
  });

  group('InstagramSwitchGuideScreen', () {
    testWidgets('lists the plain steps; Try again goes back to the login screen', (tester) async {
      await _pump(tester, const InstagramSwitchGuideScreen());
      expect(find.text('Tap Account type and tools.'), findsOneWidget);
      expect(find.text('Choose Creator.'), findsOneWidget);
      await tester.tap(find.text('TRY AGAIN'));
      await tester.pumpAndSettle();
      expect(find.text('IG LOGIN SCREEN'), findsOneWidget);
    });
  });

  group('deep link', () {
    test('hellofraands://channels?ig=... opens the influencer Channels screen with the result', () {
      final t = linkTargetFor(Uri.parse('${Brand.scheme}://channels?ig=error&reason=not_professional'));
      expect(t, isNotNull);
      final u = Uri.parse(t!.location);
      expect(u.path, '/inf/channels');
      expect(u.queryParameters, {'ig': 'error', 'reason': 'not_professional'});
      expect(t.telemetryPath, '/channels');
      final ok = Uri.parse(linkTargetFor(Uri.parse('${Brand.scheme}://channels?ig=connected&result=approved'))!.location);
      expect(ok.queryParameters, {'ig': 'connected', 'result': 'approved'});
    });

    test('unknown results, odd reasons and https links are not routed', () {
      expect(linkTargetFor(Uri.parse('${Brand.scheme}://channels')), isNull);
      expect(linkTargetFor(Uri.parse('${Brand.scheme}://channels?ig=hack')), isNull);
      expect(Uri.parse(linkTargetFor(Uri.parse('${Brand.scheme}://channels?ig=error&reason=../admin'))!.location).queryParameters, {'ig': 'error'});
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/channels?ig=connected')), isNull);
    });
  });
}
