import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/repos/channels_repo.dart';
import 'package:hf_app/demo/screens/channels.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// [HF-SOCIAL-STATES] Social media verification screen (/inf/channels) with a Facebook Page that was proven by login but is under the
// follower minimum: it is shown (never "Nothing verified yet"), by name or "your Facebook Page" (never the numeric id), with what it needs,
// a Remove button and LOG IN AGAIN, and the return from Facebook says "connected, does not count yet".

http.Response _json(Object body) => http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});

ChannelsRepo _repo(List<Map<String, Object?>> channels, {bool qualified = false}) => ChannelsRepo(ApiClient(
      client: MockClient((req) async => _json({'ok': true, 'minFollowers': 20, 'minViews': 1000, 'qualified': qualified, 'channels': channels})),
      origin: 'https://api.test',
      tokens: ({bool forceRefresh = false}) async => 'jwt',
      reporter: (m, e, err, ms) {},
    ));

Map<String, Object?> _fb({String handle = '1378608792005431', String? display, int followers = 0, String state = 'needs_followers'}) => {
      'id': 'hfch_fb1',
      'platform': 'facebook',
      'handle': handle,
      'displayHandle': display,
      'url': 'https://www.facebook.com/1378608792005431',
      'followers': followers,
      'views': 0,
      'state': state,
      'verified': true,
      'needsCode': false,
      'viaLogin': true,
      if (state == 'needs_followers') 'need': 'followers',
      'lastSyncAt': DateTime.now().millisecondsSinceEpoch,
      'createdAt': 1,
    };

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/inf/channels/add', builder: (_, __) => const Scaffold(body: Text('PICK PLATFORM'))),
      GoRoute(path: '/inf/channels/add/facebook', builder: (_, __) => const Scaffold(body: Text('FACEBOOK LOGIN'))),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
}

void main() {
  testWidgets('a below-minimum Facebook Page is shown as connected (not "nothing verified"), never by its numeric id', (tester) async {
    await _pump(tester, ChannelsListScreen(repo: _repo([_fb()])));
    await tester.pumpAndSettle();
    expect(find.text('Nothing verified yet'), findsNothing);
    expect(find.text('your Facebook Page'), findsOneWidget);
    expect(find.textContaining('1378608792005431'), findsNothing);
    expect(find.text('Needs 20+ followers'), findsOneWidget); // no tick
    expect(find.text('Approved'), findsNothing);
    expect(find.text('Facebook Page connected. It needs 20 followers to count. Add YouTube or Instagram, or do the Aadhaar check / video KYC.'), findsOneWidget);
    expect(find.textContaining('0 followers · Facebook'), findsOneWidget);
    expect(find.text('REMOVE'), findsOneWidget);
    expect(find.text('LOG IN AGAIN'), findsOneWidget);
    expect(find.text('RESYNC'), findsNothing);
    expect(find.text('+ ADD SOCIAL MEDIA'), findsOneWidget); // she can still add YouTube / Instagram
    await tester.tap(find.text('LOG IN AGAIN'));
    await tester.pumpAndSettle();
    expect(find.text('FACEBOOK LOGIN'), findsOneWidget);
  });

  testWidgets('a named Page shows its name; an approved Page shows Approved and no "needs" line', (tester) async {
    await _pump(tester, ChannelsListScreen(repo: _repo([_fb(handle: 'Priya Vlogs', display: 'Priya Vlogs', followers: 300, state: 'approved')], qualified: true)));
    await tester.pumpAndSettle();
    expect(find.text('Priya Vlogs'), findsOneWidget);
    expect(find.text('Approved'), findsOneWidget);
    expect(find.textContaining('to count'), findsNothing);
  });

  testWidgets('return from Facebook with result=needs_followers says connected but not counted', (tester) async {
    await _pump(tester, ChannelsListScreen(repo: _repo([_fb()]), fb: 'connected', result: 'needs_followers'));
    await tester.pump();
    expect(find.textContaining('Your Facebook Page is connected, but it does not have enough followers yet to count.'), findsOneWidget);
    await tester.pumpAndSettle(const Duration(seconds: 5));
  });

  testWidgets('return from Facebook with reason=no_page explains the Page', (tester) async {
    await _pump(tester, ChannelsListScreen(repo: _repo(const []), fb: 'error', reason: 'no_page'));
    await tester.pump();
    expect(find.textContaining('could not find a Facebook Page'), findsOneWidget);
    await tester.pumpAndSettle(const Duration(seconds: 5));
  });
}
