import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/channel.dart';
import 'package:hf_app/data/repos/channels_repo.dart';
import 'package:hf_app/data/youtube_sign_in.dart';
import 'package:hf_app/demo/screens/channels.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, Object?> _ch(String id, String state, {String platform = 'instagram', String handle = 'maya.reels', int followers = 42, bool needsCode = false, String? code}) => {
      'id': id,
      'platform': platform,
      'handle': handle,
      'followers': followers,
      'state': state,
      'verified': state != 'checking' || !needsCode,
      'needsCode': needsCode,
      if (code != null) 'verifyCode': code,
      'lastSyncAt': DateTime.now().millisecondsSinceEpoch,
      'createdAt': 1,
    };

/// Google sign-in without Google. [result] is the token, or an exception to throw.
class _FakeSignIn implements YoutubeSignIn {
  _FakeSignIn([this.result = 'ya29.test-token']);

  final Object result;
  int taps = 0;
  int signOuts = 0;

  @override
  Future<String> accessToken() async {
    taps++;
    final r = result;
    if (r is Exception) throw r;
    return r as String;
  }

  @override
  Future<void> signOut() async => signOuts++;
}

/// The "fake API": the real ApiClient with a MockClient that records every call.
class _Fake {
  _Fake(this.handler, {this.gate});

  final http.Response Function(http.Request req) handler;

  /// When set, every answer waits for this to complete (to look at the loading state).
  final Completer<void>? gate;
  final List<http.Request> calls = [];

  ChannelsRepo get repo => ChannelsRepo(ApiClient(
        client: MockClient((req) async {
          calls.add(req);
          if (gate != null) await gate!.future;
          return handler(req);
        }),
        origin: 'https://api.test',
        tokens: ({bool forceRefresh = false}) async => 'jwt',
        reporter: (m, e, err, ms) {},
      ));

  Iterable<http.Request> to(String method, String path) => calls.where((r) => r.method == method && r.url.path == path);
}

Future<void> _pump(WidgetTester tester, Widget home, {Map<String, Widget Function(GoRouterState)> extra = const {}}) async {
  tester.view.physicalSize = const Size(900, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/inf/channels/add', builder: (_, __) => const Scaffold(body: Text('PICK PLATFORM'))),
      GoRoute(path: '/inf/channels/:id/checking', builder: (_, s) => Scaffold(body: Text('CHECKING ${s.pathParameters['id']} ${s.uri.query}'))),
      GoRoute(path: '/inf/channels', builder: (_, __) => const Scaffold(body: Text('CHANNELS LIST'))),
      for (final e in extra.entries) GoRoute(path: e.key, builder: (_, s) => e.value(s)),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
}

void main() {
  group('ChannelsRepo', () {
    test('connectYoutube posts only the access token to the sign-in route', () async {
      final f = _Fake((_) => _json({'ok': true, 'result': 'needs_followers', 'message': 'm', 'channel': _ch('hfch_y', 'needs_followers', platform: 'youtube', followers: 3), 'minFollowers': 10, 'qualified': false}));
      final r = await f.repo.connectYoutube('ya29.abc');
      expect(r.result, CheckResult.needsFollowers);
      expect(f.calls.single.url.path, '/api/hf/channels/youtube/connect');
      expect(jsonDecode(f.calls.single.body), {'accessToken': 'ya29.abc'});
    });

    test('list parses channels, the follower minimum and the qualified flag', () async {
      final f = _Fake((_) => _json({
            'ok': true,
            'minFollowers': 25,
            'qualified': true,
            'hostStatus': 'approved',
            'channels': [_ch('hfch_a', 'approved'), _ch('hfch_b', 'needs_followers', platform: 'youtube', handle: '@maya', followers: 3)],
          }));
      final l = await f.repo.list();
      expect(l.minFollowers, 25);
      expect(l.qualified, isTrue);
      expect(l.hostStatus, 'approved');
      expect(l.channels.map((c) => c.state), [ChannelState.approved, ChannelState.needsFollowers]);
      expect(l.channels.last.followersWord, 'subscribers');
      expect(f.calls.single.headers['Authorization'], 'Bearer jwt');
    });

    test('add posts the platform, the handle and the consent version', () async {
      final f = _Fake((_) => _json({
            'ok': true,
            'channel': _ch('hfch_a', 'checking', needsCode: true, code: 'HF-7K3Q9'),
            'verifyCode': 'HF-7K3Q9',
            'instructions': 'Add HF-7K3Q9 to your bio.',
            'minFollowers': 10,
          }));
      final a = await f.repo.add(platform: 'instagram', handleOrUrl: '  @maya.reels ');
      expect(a.verifyCode, 'HF-7K3Q9');
      final body = jsonDecode(f.calls.single.body) as Map<String, dynamic>;
      expect(body['platform'], 'instagram');
      expect(body['handleOrUrl'], '@maya.reels');
      expect(body['consent'], containsPair('version', kChannelConsentVersion));
      expect(body['consent'], containsPair('ownChannel', true));
    });

    test('a flag-off 404 becomes a friendly message and a claimed channel keeps the server text', () async {
      final off = _Fake((_) => _json({'ok': false, 'error': 'not_enabled', 'message': 'not_enabled'}, 404));
      await expectLater(off.repo.list(), throwsA(isA<ApiException>().having((e) => e.userMessage, 'message', ChannelsRepo.notOpenText)));
      final claimed = _Fake((_) => _json({'ok': false, 'error': 'channel_claimed', 'message': 'That channel is already connected to another person.'}, 409));
      await expectLater(
        claimed.repo.add(platform: 'youtube', handleOrUrl: '@x'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'channel_claimed').having((e) => e.userMessage, 'message', contains('another person'))),
      );
    });

    test('minFollowers reads the public config and falls back to 10', () async {
      expect(await _Fake((_) => _json({'hfInfluencerMinFollowers': 50})).repo.minFollowers(), 50);
      expect(await _Fake((_) => _json({}, 500)).repo.minFollowers(), 10);
    });
  });

  group('ChannelsListScreen', () {
    testWidgets('shows loading, then every channel with its status chip and the threshold from the server', (tester) async {
      final gate = Completer<void>();
      final f = _Fake(gate: gate, (_) => _json({
            'ok': true,
            'minFollowers': 25,
            'qualified': true,
            'channels': [
              _ch('hfch_a', 'approved'),
              _ch('hfch_b', 'needs_followers', platform: 'youtube', handle: '@maya', followers: 3),
              _ch('hfch_c', 'checking', handle: 'newone', followers: 7, needsCode: true, code: 'HF-AAAAA'),
            ],
          }));
      await _pump(tester, ChannelsListScreen(repo: f.repo));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('Approved'), findsOneWidget);
      expect(find.text('Needs 25+ followers'), findsOneWidget);
      expect(find.text('Checking…'), findsOneWidget);
      expect(find.textContaining('at least 25 followers or subscribers'), findsNothing); // qualified text instead
      expect(find.textContaining('25+ followers or subscribers'), findsOneWidget);
      expect(find.text('@maya.reels'), findsOneWidget);
      expect(find.text('FINISH CHECKING'), findsOneWidget);
      expect(find.text('+ ADD SOCIAL MEDIA'), findsOneWidget);
    });

    testWidgets('empty state offers to add a channel', (tester) async {
      final f = _Fake((_) => _json({'ok': true, 'minFollowers': 10, 'channels': []}));
      await _pump(tester, ChannelsListScreen(repo: f.repo));
      await tester.pumpAndSettle();
      expect(find.text('Nothing verified yet'), findsOneWidget);
      expect(find.text('Add your Instagram, YouTube or Facebook so fans can see your reels.'), findsOneWidget); // [HF-INTRO-INT]
      await tester.tap(find.text('+ ADD SOCIAL MEDIA'));
      await tester.pumpAndSettle();
      expect(find.text('PICK PLATFORM'), findsOneWidget);
    });

    testWidgets('error shows Try again and recovers', (tester) async {
      var n = 0;
      final f = _Fake((_) {
        n++;
        return n == 1 ? _json({'error': 'x', 'message': 'Kitchen is on fire.'}, 500) : _json({'ok': true, 'minFollowers': 10, 'channels': [_ch('hfch_a', 'approved')]});
      });
      await _pump(tester, ChannelsListScreen(repo: f.repo));
      await tester.pumpAndSettle();
      expect(find.text('Kitchen is on fire.'), findsOneWidget);
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Approved'), findsOneWidget);
    });

    testWidgets('flag off shows the friendly "not open yet" text', (tester) async {
      final f = _Fake((_) => _json({'ok': false, 'error': 'not_enabled'}, 404));
      await _pump(tester, ChannelsListScreen(repo: f.repo));
      await tester.pumpAndSettle();
      expect(find.text(ChannelsRepo.notOpenText), findsOneWidget);
    });

    testWidgets('Resync posts to the server and Remove asks first, then deletes', (tester) async {
      final f = _Fake((req) {
        if (req.method == 'POST') return _json({'ok': true, 'result': 'approved', 'message': 'You\'re in! Your channel is confirmed.', 'channel': _ch('hfch_a', 'approved'), 'minFollowers': 10, 'qualified': true});
        if (req.method == 'DELETE') return _json({'ok': true});
        return _json({'ok': true, 'minFollowers': 10, 'channels': [_ch('hfch_a', 'approved')]});
      });
      await _pump(tester, ChannelsListScreen(repo: f.repo));
      await tester.pumpAndSettle();
      await tester.tap(find.text('RESYNC'));
      await tester.pumpAndSettle();
      expect(f.to('POST', '/api/hf/channels/hfch_a/resync').length, 1);
      await tester.tap(find.text('REMOVE'));
      await tester.pumpAndSettle();
      expect(find.text('Remove this account?'), findsOneWidget);
      await tester.tap(find.text('KEEP IT'));
      await tester.pumpAndSettle();
      expect(f.to('DELETE', '/api/hf/channels/hfch_a'), isEmpty);
      await tester.tap(find.text('REMOVE'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'REMOVE'));
      await tester.pumpAndSettle();
      expect(f.to('DELETE', '/api/hf/channels/hfch_a').length, 1);
    });
  });

  group('ChannelPlatformScreen', () {
    testWidgets('Instagram and YouTube open; Facebook says coming soon and does nothing', (tester) async {
      await _pump(tester, const ChannelPlatformScreen(), extra: {'/inf/channels/add/instagram': (_) => const Scaffold(body: Text('IG FORM'))});
      expect(find.text('Instagram'), findsOneWidget);
      expect(find.text('YouTube'), findsOneWidget);
      expect(find.text('Coming soon'), findsOneWidget);
      await tester.tap(find.text('Facebook'));
      await tester.pumpAndSettle();
      expect(find.text('IG FORM'), findsNothing);
      await tester.tap(find.text('Instagram'));
      await tester.pumpAndSettle();
      expect(find.text('IG FORM'), findsOneWidget);
    });
  });

  group('ChannelConsentScreen', () {
    testWidgets('needs the handle and all four boxes; then shows the code and goes to the check', (tester) async {
      final f = _Fake((_) => _json({
            'ok': true,
            'channel': _ch('hfch_a', 'checking', needsCode: true, code: 'HF-7K3Q9'),
            'verifyCode': 'HF-7K3Q9',
            'instructions': 'Add HF-7K3Q9 to your Instagram bio, save it, then tap the button.',
            'minFollowers': 10,
          }));
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', from: 'join', repo: f.repo));
      await tester.tap(find.text('CONNECT'));
      await tester.pump();
      expect(find.textContaining('Type your Instagram'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '@maya.reels');
      await tester.tap(find.text('CONNECT'));
      await tester.pump();
      expect(find.textContaining('tick all four boxes'), findsOneWidget);
      expect(f.calls, isEmpty);

      for (final label in [
        'Show my public videos from this channel as embeds in the Reels feed and on my profile.',
        'Show my follower, like, comment and video counts.',
        'I choose which of my videos go on the feed, and I can remove any video.',
        'This channel is mine.',
      ]) {
        await tester.tap(find.text(label));
        await tester.pump();
      }
      await tester.tap(find.text('CONNECT'));
      await tester.pumpAndSettle();
      expect(f.to('POST', '/api/hf/channels').length, 1);
      expect(find.text('HF-7K3Q9'), findsOneWidget);
      expect(find.byTooltip('Copy the code'), findsNothing); // semantics label, not a tooltip
      expect(find.byIcon(Icons.copy_rounded), findsOneWidget);
      await tester.tap(find.text("I'VE ADDED IT, CHECK NOW"));
      await tester.pumpAndSettle();
      expect(find.text('CHECKING hfch_a from=join'), findsOneWidget);
    });

    testWidgets('a server refusal (channel already claimed) is shown in plain words', (tester) async {
      final f = _Fake((_) => _json({'ok': false, 'error': 'channel_claimed', 'message': 'That channel is already connected to another person.'}, 409));
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo));
      await tester.enterText(find.byType(TextField), '@maya');
      for (final i in [0, 1, 2, 3]) {
        await tester.tap(find.byIcon(Icons.check_box_outline_blank_rounded).first);
        await tester.pump();
        expect(find.byIcon(Icons.check_box_rounded), findsNWidgets(i + 1));
      }
      await tester.tap(find.text('CONNECT'));
      await tester.pumpAndSettle();
      expect(find.text('That channel is already connected to another person.'), findsOneWidget);
    });

    testWidgets('YouTube: sign in with Google, send the token, land on the result (no code, no handle field)', (tester) async {
      final f = _Fake((_) => _json({'ok': true, 'result': 'approved', 'message': 'You\'re in! Your channel is confirmed.', 'channel': _ch('hfch_y', 'approved', platform: 'youtube', handle: '@maya', followers: 500), 'minFollowers': 10, 'qualified': true}));
      final gs = _FakeSignIn();
      await _pump(tester, ChannelConsentScreen(platform: 'youtube', from: 'join', repo: f.repo, signIn: gs));
      expect(find.byType(TextField), findsNothing);
      expect(find.text('SIGN IN WITH YOUTUBE'), findsOneWidget);
      await tester.tap(find.text('SIGN IN WITH YOUTUBE'));
      await tester.pump();
      expect(find.textContaining('tick the box'), findsOneWidget);
      expect(gs.taps, 0);
      expect(f.calls, isEmpty);
      await tester.tap(find.byKey(const ValueKey('yt-consent')));
      await tester.pump();
      await tester.tap(find.text('SIGN IN WITH YOUTUBE'));
      await tester.pumpAndSettle();
      final posts = f.to('POST', '/api/hf/channels/youtube/connect');
      expect(posts.length, 1);
      expect(jsonDecode(posts.single.body), {'accessToken': 'ya29.test-token'});
      expect(f.to('POST', '/api/hf/channels'), isEmpty);
      expect(gs.signOuts, 1); // the Google account is forgotten on the phone; the token was used once
      expect(find.text('CHECKING hfch_y from=join'), findsOneWidget);
    });

    testWidgets('YouTube: cancelling the Google sheet and a Google failure show plain words and call nothing', (tester) async {
      final f = _Fake((_) => _json({'ok': true}));
      await _pump(tester, ChannelConsentScreen(platform: 'youtube', repo: f.repo, signIn: _FakeSignIn(const YoutubeSignInCancelled())));
      await tester.tap(find.byKey(const ValueKey('yt-consent')));
      await tester.pump();
      await tester.tap(find.text('SIGN IN WITH YOUTUBE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('cancelled'), findsOneWidget);
      expect(f.calls, isEmpty);
      await _pump(tester, ChannelConsentScreen(platform: 'youtube', repo: f.repo, signIn: _FakeSignIn(const YoutubeSignInFailed())));
      await tester.tap(find.byKey(const ValueKey('yt-consent')));
      await tester.pump();
      await tester.tap(find.text('SIGN IN WITH YOUTUBE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('could not sign in with Google'), findsOneWidget);
    });

    testWidgets('YouTube: a Google account without a channel shows the server text', (tester) async {
      final f = _Fake((_) => _json({'ok': false, 'error': 'no_youtube_channel', 'message': 'This Google account has no YouTube channel. Create one on YouTube, then try again.'}, 404));
      await _pump(tester, ChannelConsentScreen(platform: 'youtube', repo: f.repo, signIn: _FakeSignIn()));
      await tester.tap(find.byKey(const ValueKey('yt-consent')));
      await tester.pump();
      await tester.tap(find.text('SIGN IN WITH YOUTUBE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('has no YouTube channel'), findsOneWidget);
    });

    testWidgets('Instagram says "coming soon" when the provider is not switched on', (tester) async {
      final f = _Fake((_) => _json({'ok': false, 'error': 'provider_not_configured', 'message': 'Instagram is coming soon.'}, 503));
      await _pump(tester, ChannelConsentScreen(platform: 'instagram', repo: f.repo));
      await tester.enterText(find.byType(TextField), '@maya');
      for (var i = 0; i < 4; i++) {
        await tester.tap(find.byIcon(Icons.check_box_outline_blank_rounded).first);
        await tester.pump();
      }
      await tester.tap(find.text('CONNECT'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Instagram is coming soon'), findsOneWidget);
    });

    testWidgets('Facebook is not a connectable platform', (tester) async {
      await _pump(tester, const ChannelConsentScreen(platform: 'facebook'));
      expect(find.textContaining('coming soon'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
    });
  });

  group('ChannelCheckingScreen', () {
    testWidgets('a result handed over by the YouTube sign-in is shown without asking the server again', (tester) async {
      final f = _Fake((_) => _json({'ok': true}));
      final first = ChannelCheck.fromJson({'result': 'approved', 'message': 'Your channel is confirmed.', 'channel': _ch('hfch_y', 'approved', platform: 'youtube'), 'minFollowers': 10, 'qualified': true});
      await _pump(tester, ChannelCheckingScreen(id: 'hfch_y', initial: first, onApprovedDone: () {}, repo: f.repo));
      await tester.pump();
      expect(find.text("You're in!"), findsOneWidget);
      expect(f.calls, isEmpty);
    });

    ChannelsRepo repoFor(Map<String, Object?> body) => _Fake((_) => _json(body)).repo;

    testWidgets('approved: "You\'re in!" and a dashboard button', (tester) async {
      var done = 0;
      final gate = Completer<void>();
      final f = _Fake(gate: gate, (_) => _json({'ok': true, 'result': 'approved', 'message': 'You\'re in! Your channel is confirmed.', 'channel': _ch('hfch_a', 'approved', followers: 12), 'minFollowers': 10, 'qualified': true}));
      await _pump(tester, ChannelCheckingScreen(id: 'hfch_a', onApprovedDone: () => done++, repo: f.repo));
      expect(find.text('Checking your channel… This can take up to 20 seconds.'), findsOneWidget);
      expect(find.text('20'), findsOneWidget);
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text("You're in!"), findsOneWidget);
      await tester.tap(find.text('GO TO MY DASHBOARD'));
      expect(done, 1);
    });

    testWidgets('under the minimum: says how many are needed, offers another channel', (tester) async {
      await _pump(
        tester,
        ChannelCheckingScreen(
          id: 'hfch_a',
          repo: repoFor({'ok': true, 'result': 'needs_followers', 'message': 'x', 'channel': _ch('hfch_a', 'needs_followers', handle: '@maya', followers: 4), 'minFollowers': 10, 'qualified': false}),
        ),
        extra: {},
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('We need at least 10 followers or subscribers on YouTube or Instagram.'), findsOneWidget);
      expect(find.text('TRY ANOTHER CHANNEL'), findsOneWidget);
      expect(find.text('CHECK AGAIN LATER'), findsOneWidget);
    });

    testWidgets('code missing: shows the code again and Check again calls the server again', (tester) async {
      final f = _Fake((_) => _json({'ok': true, 'result': 'code_missing', 'message': 'We could not see the code yet.', 'channel': _ch('hfch_a', 'checking', needsCode: true, code: 'HF-7K3Q9'), 'minFollowers': 10, 'qualified': false}));
      await _pump(tester, ChannelCheckingScreen(id: 'hfch_a', repo: f.repo));
      await tester.pumpAndSettle();
      expect(find.text('HF-7K3Q9'), findsOneWidget);
      expect(find.text('We could not see the code yet.'), findsOneWidget);
      await tester.tap(find.text('CHECK AGAIN'));
      await tester.pumpAndSettle();
      expect(f.to('POST', '/api/hf/channels/hfch_a/check').length, 2);
    });

    final approvedBody = {'ok': true, 'result': 'approved', 'message': 'ok', 'channel': _ch('hfch_a', 'approved', followers: 12), 'minFollowers': 10, 'qualified': true};

    testWidgets('[HF-CHANNEL-CHECK-20S-1] counts down from 20 and says Instagram is slow after 8 seconds', (tester) async {
      final gate = Completer<void>();
      final f = _Fake(gate: gate, (_) => _json(approvedBody));
      await _pump(tester, ChannelCheckingScreen(id: 'hfch_a', onApprovedDone: () {}, repo: f.repo));
      expect(find.text('Checking your channel… This can take up to 20 seconds.'), findsOneWidget);
      expect(find.text('20'), findsOneWidget);
      expect(find.text('Instagram is answering slowly today. Please keep this screen open.'), findsNothing);
      await tester.pump(const Duration(seconds: 7));
      expect(find.text('13'), findsOneWidget);
      expect(find.text('Instagram is answering slowly today. Please keep this screen open.'), findsNothing);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('12'), findsOneWidget);
      expect(find.text('Instagram is answering slowly today. Please keep this screen open.'), findsOneWidget);
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text("You're in!"), findsOneWidget);
    });

    testWidgets('[HF-CHANNEL-CHECK-20S-1] a timeout shows "Still checking" and Check again asks the server again', (tester) async {
      final never = Completer<http.Response>();
      var calls = 0;
      final repo = ChannelsRepo(ApiClient(
        client: MockClient((_) {
          calls++;
          return calls == 1 ? never.future : Future.value(_json(approvedBody));
        }),
        origin: 'https://api.test',
        tokens: ({bool forceRefresh = false}) async => 'jwt',
        reporter: (m, e, err, ms) {},
      ));
      await _pump(tester, ChannelCheckingScreen(id: 'hfch_a', onApprovedDone: () {}, repo: repo));
      await tester.pump(const Duration(seconds: 23));
      await tester.pump();
      expect(find.text('Still checking'), findsOneWidget);
      expect(find.text('Instagram took longer than 20 seconds. Your check may still finish — tap Check again in a moment.'), findsOneWidget);
      expect(find.text('Slow connection'), findsNothing);
      await tester.tap(find.text('CHECK AGAIN'));
      await tester.pumpAndSettle();
      expect(calls, 2);
      expect(find.text("You're in!"), findsOneWidget);
    });

    testWidgets('a network failure shows the offline text with Try again', (tester) async {
      final repo = ChannelsRepo(ApiClient(
        client: MockClient((_) async => throw http.ClientException('down')),
        origin: 'https://api.test',
        reporter: (m, e, err, ms) {},
      ));
      await _pump(tester, ChannelCheckingScreen(id: 'hfch_a', repo: repo));
      await tester.pumpAndSettle();
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('ChannelsStep (join step 2)', () {
    testWidgets('reports what loaded so Next can decide, and shows the threshold', (tester) async {
      ChannelsList? seen;
      final f = _Fake((_) => _json({'ok': true, 'minFollowers': 10, 'qualified': false, 'channels': [_ch('hfch_b', 'needs_followers', followers: 3)]}));
      await _pump(tester, Scaffold(body: ChannelsStep(repo: f.repo, signedIn: () => true, onLoaded: (l) => seen = l)));
      await tester.pumpAndSettle();
      expect(seen?.qualified, isFalse);
      expect(seen?.minFollowers, 10);
      expect(find.textContaining('at least 10 followers or subscribers'), findsOneWidget);
      expect(find.text('Needs 10+ followers'), findsOneWidget);
    });

    testWidgets('signed out: asks to sign in and calls nothing', (tester) async {
      final f = _Fake((_) => _json({}));
      await _pump(tester, Scaffold(body: ChannelsStep(repo: f.repo, signedIn: () => false)));
      expect(find.text('SIGN IN'), findsOneWidget);
      expect(f.calls, isEmpty);
    });
  });
}
