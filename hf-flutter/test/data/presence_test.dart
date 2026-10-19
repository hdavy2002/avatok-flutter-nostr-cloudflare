import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/presence_store.dart';
import 'package:hf_app/data/repos/presence_repo.dart';
import 'package:hf_app/demo/notify_me_button.dart';
import 'package:hf_app/demo/online_now_pill.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/screens/influencer.dart';
import 'package:hf_app/demo/state.dart';

typedef Handler = Object? Function(String method, String path, Object? body);

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
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }
}

const _serverDown = ApiException(kind: ApiFailure.http, status: 503, code: 'unavailable', message: 'Try again in a little while.');

void main() {
  tearDown(() {
    PresenceBridge.forceReal = false;
    PresenceStore.instance = null;
  });

  group('PresenceStore', () {
    test('goes online with the real PUT and keeps the server answer (busy stays busy)', () async {
      final api = FakeApiClient((m, p, b) => {'ok': true, 'presence': 'busy'});
      final store = PresenceStore(PresenceRepo(api));
      expect(await store.setOnline(true), isNull);
      expect(api.calls, ['PUT /api/hosts/me/presence']);
      expect(api.bodies.single, {'online': true});
      expect(store.presence, 'busy');
      expect(store.online, isTrue);
    });

    test('rolls back and explains when the server says no', () async {
      final api = FakeApiClient((m, p, b) => _serverDown);
      final store = PresenceStore(PresenceRepo(api));
      expect(await store.setOnline(true), 'Try again in a little while.');
      expect(store.presence, 'offline');
    });

    test('optimistic: the switch moves before the server answers', () async {
      final seen = <String>[];
      late PresenceStore store;
      final api = FakeApiClient((m, p, b) {
        seen.add(store.presence);
        return {'ok': true, 'presence': 'online'};
      });
      store = PresenceStore(PresenceRepo(api));
      await store.setOnline(true);
      expect(seen, ['online']);
    });

    test('load reads GET and a failure keeps the old value', () async {
      var fail = false;
      final api = FakeApiClient((m, p, b) => fail ? ApiException.offline() : {'ok': true, 'presence': 'online'});
      final store = PresenceStore(PresenceRepo(api));
      await store.load();
      expect(store.presence, 'online');
      fail = true;
      await store.load();
      expect(store.presence, 'online');
    });
  });

  group('Online / Offline screen', () {
    Future<FakeApiClient> pumpStatus(WidgetTester tester, Handler h) async {
      final api = FakeApiClient(h);
      PresenceBridge.forceReal = true;
      PresenceStore.instance = PresenceStore(PresenceRepo(api));
      await tester.pumpWidget(const MaterialApp(home: InfluencerStatusScreen()));
      return api;
    }

    testWidgets('tap to go online, then offline shows the booking toast', (tester) async {
      final api = await pumpStatus(tester, (m, p, b) => {'ok': true, 'presence': (b as Map)['online'] == true ? 'online' : 'offline'});
      expect(find.text('OFFLINE'), findsOneWidget);
      await tester.tap(find.text('TAP TO GO ONLINE'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('ONLINE'), findsOneWidget);
      await tester.tap(find.text('TAP TO GO OFFLINE'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('OFFLINE'), findsOneWidget);
      expect(find.text('You are offline. Bookings stay open.'), findsOneWidget);
      expect(api.calls, ['PUT /api/hosts/me/presence', 'PUT /api/hosts/me/presence']);
    });

    testWidgets('a failed PUT rolls back and shows the reason', (tester) async {
      await pumpStatus(tester, (m, p, b) => _serverDown);
      await tester.tap(find.text('TAP TO GO ONLINE'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('OFFLINE'), findsOneWidget);
      expect(find.text('Try again in a little while.'), findsOneWidget);
    });
  });

  group('Feed pill', () {
    testWidgets('shows the real count and refreshes every 60 seconds', (tester) async {
      PresenceBridge.forceReal = true;
      var n = 3;
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: OnlineNowPill(demoCount: 99, fetch: () async => n++))));
      await tester.pump();
      expect(find.text('3 online now'), findsOneWidget);
      await tester.pump(const Duration(seconds: 61));
      expect(find.text('4 online now'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('hides itself on error', (tester) async {
      PresenceBridge.forceReal = true;
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: OnlineNowPill(demoCount: 99, fetch: () async => throw ApiException.offline()))));
      await tester.pump();
      expect(find.textContaining('online now'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Notify me', () {
    testWidgets('signed in: posts to the notify route and toasts the first name', (tester) async {
      demo.signedIn = true;
      final api = FakeApiClient((m, p, b) => {'ok': true, 'subscribed': true});
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: NotifyMeButton(slug: 'priya-rao', firstName: 'Priya', repo: PresenceRepo(api)))));
      await tester.tap(find.text('Notify me'));
      await tester.pump();
      await tester.pump();
      expect(api.calls, ['POST /api/hf/hosts/priya-rao/notify']);
      expect(find.text('We will WhatsApp you when Priya is online.'), findsOneWidget);
      demo.signedIn = false;
    });

    testWidgets('a server refusal shows its message', (tester) async {
      demo.signedIn = true;
      final api = FakeApiClient((m, p, b) => const ApiException(kind: ApiFailure.http, status: 403, code: 'not_verified', message: 'Verify your WhatsApp number first.'));
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: NotifyMeButton(slug: 'priya-rao', firstName: 'Priya', repo: PresenceRepo(api)))));
      await tester.tap(find.text('Notify me'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Verify your WhatsApp number first.'), findsOneWidget);
      demo.signedIn = false;
    });
  });
}
