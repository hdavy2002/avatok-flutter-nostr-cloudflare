import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/call_flags.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/models/queue.dart';
import 'package:hf_app/data/presence_store.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';
import 'package:hf_app/data/repos/presence_repo.dart';
import 'package:hf_app/data/repos/queue_repo.dart';
import 'package:hf_app/data/repos/reels_repo.dart';
import 'package:hf_app/demo/profile_kit.dart';
import 'package:hf_app/demo/queue_kit.dart';
import 'package:hf_app/demo/screens/bookings_real.dart';
import 'package:hf_app/demo/screens/queue_real.dart';
import 'package:hf_app/demo/state.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];
  final List<Map<String, Object?>?> queries = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    queries.add(query);
    final out = handler(method, path, query, body);
    if (out is ApiException) throw out;
    return out;
  }
}

ApiException _err(int status, String code, [String? message, Map<String, Object?> extra = const {}]) =>
    ApiException(kind: ApiFailure.http, status: status, code: code, message: message, extra: extra);

Map<String, Object?> _presence(String mode, {bool onCall = false}) => {
      'ok': true,
      'presence': onCall ? 'busy' : (mode == 'online' ? 'online' : 'offline'),
      'mode': mode,
      'onCall': onCall,
      'queue': {'waiting': 0, 'paused': false, 'open': mode == 'online'},
    };

Map<String, Object?> _booking(String id) => {
      'id': id,
      'status': 'confirmed',
      'startAt': '2099-10-22T10:30:00.000Z',
      'day': '2099-10-22',
      'time': '16:00',
      'minutes': 15,
      'holdPaise': 15000,
      'canCancel': true,
      'cancelRule': 'x',
      'fanHandle': 'Ravi',
    };

Future<void> _pumpApp(WidgetTester tester, Widget home, {List<GoRoute> extra = const []}) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/queue/:slug', builder: (_, s) => Scaffold(body: Text('QUEUE ${s.pathParameters['slug']} ${s.uri.query}'))),
      GoRoute(path: '/book/:id', builder: (_, s) => Scaffold(body: Text('BOOK ${s.pathParameters['id']}'))),
      GoRoute(path: '/book/:id/confirm', builder: (_, s) => Scaffold(body: Text('CONFIRM ${s.uri.query}'))),
      GoRoute(path: '/call/:id', builder: (_, s) => Scaffold(body: Text('CALL ${s.pathParameters['id']}'))),
      GoRoute(path: '/topup', builder: (_, __) => const Scaffold(body: Text('TOPUP PAGE'))),
      GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS PAGE'))),
      ...extra,
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
}

void main() {
  setUp(() => demo.signedIn = true);
  tearDown(() {
    CallFlags.reset();
    PresenceStore.instance = null;
  });

  // ------------------------------------------------------------------------------------------ three-way mode control
  group('three-way mode control', () {
    Future<(FakeApiClient, PresenceStore)> openSheet(WidgetTester tester, {required String mode, List<Object?> booked = const [], bool bookedFails = false}) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p == '/api/hosts/me/presence') return m == 'PUT' ? _presence((b as Map)['mode'] as String) : _presence(mode);
        if (p == '/api/hf/bookings') return bookedFails ? ApiException.offline() : {'bookings': booked};
        return <String, Object?>{};
      });
      final store = PresenceStore(PresenceRepo(api));
      await store.load();
      await _pumpApp(
        tester,
        Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => showHostModeSheet(context, store: store, bookings: BookingsRepo(api)),
                child: const Text('OPEN'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('OPEN'));
      await tester.pumpAndSettle();
      return (api, store);
    }

    testWidgets('shows all three choices with the current one ticked', (tester) async {
      await openSheet(tester, mode: 'bookings_only');
      expect(find.text('Online'), findsOneWidget);
      expect(find.text('Bookings only'), findsOneWidget);
      expect(find.text('Offline'), findsOneWidget);
      expect(find.byIcon(Icons.check_circle_rounded), findsOneWidget);
    });

    testWidgets('Online to Bookings only sends {mode} and confirms', (tester) async {
      final (api, store) = await openSheet(tester, mode: 'online');
      await tester.tap(find.byKey(const ValueKey('mode-bookings_only')));
      await tester.pumpAndSettle();
      expect(api.calls.last, 'PUT /api/hosts/me/presence');
      expect(api.bodies.last, {'mode': 'bookings_only', 'surface': 'app'});
      expect(store.mode, 'bookings_only');
      expect(find.text('Bookings only. Fans can book you, but not call right away.'), findsOneWidget);
    });

    testWidgets('Offline with booked calls warns first and only goes offline after the confirm', (tester) async {
      final (api, store) = await openSheet(tester, mode: 'online', booked: [_booking('b1'), _booking('b2')]);
      await tester.tap(find.byKey(const ValueKey('mode-offline')));
      await tester.pumpAndSettle();
      expect(find.text('You have 2 booked calls. They will still ring.'), findsOneWidget);
      expect(api.calls.where((c) => c.startsWith('PUT')), isEmpty);
      await tester.tap(find.text('Go offline'));
      await tester.pumpAndSettle();
      expect(api.bodies.last, {'mode': 'offline', 'surface': 'app'});
      expect(store.mode, 'offline');
    });

    testWidgets('cancelling the warning changes nothing', (tester) async {
      final (api, store) = await openSheet(tester, mode: 'online', booked: [_booking('b1')]);
      await tester.tap(find.byKey(const ValueKey('mode-offline')));
      await tester.pumpAndSettle();
      expect(find.text('You have 1 booked call. It will still ring.'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls.where((c) => c.startsWith('PUT')), isEmpty);
      expect(store.mode, 'online');
    });

    testWidgets('Offline with no booked calls goes straight through', (tester) async {
      final (api, store) = await openSheet(tester, mode: 'online');
      await tester.tap(find.byKey(const ValueKey('mode-offline')));
      await tester.pumpAndSettle();
      expect(find.text('Go offline?'), findsNothing);
      expect(api.bodies.last, {'mode': 'offline', 'surface': 'app'});
      expect(store.mode, 'offline');
    });

    testWidgets('a failed save rolls back and says why', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'PUT') return _err(503, 'unavailable', 'Try again in a little while.');
        if (p == '/api/hf/bookings') return {'bookings': <Object?>[]};
        return _presence('online');
      });
      final store = PresenceStore(PresenceRepo(api));
      await store.load();
      await _pumpApp(
        tester,
        Builder(
          builder: (context) => Scaffold(
            body: TextButton(onPressed: () => showHostModeSheet(context, store: store, bookings: BookingsRepo(api)), child: const Text('OPEN')),
          ),
        ),
      );
      await tester.tap(find.text('OPEN'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mode-bookings_only')));
      await tester.pumpAndSettle();
      expect(store.mode, 'online');
      expect(find.text('Try again in a little while.'), findsOneWidget);
    });

    testWidgets('the Home card names the mode', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _presence('bookings_only'));
      final store = PresenceStore(PresenceRepo(api));
      await store.load();
      await _pumpApp(tester, Scaffold(body: HostModeCard(store: store)));
      expect(find.text('You are BOOKINGS ONLY'), findsOneWidget);
    });
  });

  // ------------------------------------------------------------------------------------------ influencer queue card
  group('host queue card', () {
    testWidgets('shows the waiting count and first names, and pauses', (tester) async {
      var paused = false;
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'PUT') paused = (b as Map)['paused'] == true;
        return {
          'ok': true,
          'waiting': 3,
          'paused': paused,
          'entries': [
            {'position': 1, 'firstName': 'Priya', 'joinedAt': 1},
            {'position': 2, 'firstName': 'Amit', 'joinedAt': 2},
            {'position': 3, 'firstName': 'Neha', 'joinedAt': 3},
          ],
        };
      });
      final store = PresenceStore(PresenceRepo(api));
      await _pumpApp(tester, Scaffold(body: HostQueueCard(repo: QueueRepo(api), store: store, poll: null)));
      await tester.pumpAndSettle();
      expect(find.text('3 waiting in your queue'), findsOneWidget);
      expect(find.text('Priya, Amit and 1 more'), findsOneWidget);
      expect(store.queueWaiting, 3);
      await tester.tap(find.byKey(const ValueKey('queue-pause')));
      await tester.pumpAndSettle();
      expect(api.bodies.last, {'paused': true});
      expect(find.text('Resume queue'), findsOneWidget);
      expect(find.text('Queue paused. Fans cannot join right now.'), findsOneWidget);
    });

    testWidgets('empty queue and a failed load both read calmly', (tester) async {
      var fail = true;
      final api = FakeApiClient((m, p, q, b) => fail ? ApiException.offline() : {'ok': true, 'waiting': 0, 'paused': false, 'entries': <Object?>[]});
      await _pumpApp(tester, Scaffold(body: HostQueueCard(repo: QueueRepo(api), store: PresenceStore(PresenceRepo(api)), poll: null)));
      await tester.pumpAndSettle();
      expect(find.text('We could not load your queue.'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('No one is waiting in your queue'), findsOneWidget);
    });
  });

  // ------------------------------------------------------------------------------------------ fan buttons by callState
  group('call buttons by callState', () {
    Widget actions(HostCallState s, {bool? canQueue, bool? canBook, int waiting = 0}) => Scaffold(
          body: SingleChildScrollView(
            child: CallStateActions(slug: 'priya', first: 'Priya', state: s, canQueue: canQueue, canBook: canBook, waiting: waiting),
          ),
        );

    testWidgets('on a call, queue on: Join the queue and Book a time, no Notify me', (tester) async {
      CallFlags.modes = true;
      CallFlags.queue = true;
      await _pumpApp(tester, actions(HostCallState.onCall, waiting: 2));
      expect(find.text('JOIN THE QUEUE'), findsOneWidget);
      expect(find.text('BOOK A TIME'), findsOneWidget);
      expect(find.text('Notify me'), findsNothing);
      expect(find.textContaining('2 people are waiting'), findsOneWidget);
    });

    testWidgets('on a call, queue off: Notify me and Book a time (the old behaviour)', (tester) async {
      CallFlags.modes = true;
      await _pumpApp(tester, actions(HostCallState.onCall));
      expect(find.text('JOIN THE QUEUE'), findsNothing);
      expect(find.text('Notify me'), findsOneWidget);
      expect(find.text('BOOK A TIME'), findsOneWidget);
    });

    testWidgets('by appointment: Book a time and Notify me', (tester) async {
      CallFlags.modes = true;
      CallFlags.queue = true;
      await _pumpApp(tester, actions(HostCallState.appointments));
      expect(find.text('BOOK A TIME'), findsOneWidget);
      expect(find.text('Notify me'), findsOneWidget);
      expect(find.text('JOIN THE QUEUE'), findsNothing);
    });

    testWidgets('offline: only Notify me, no booking', (tester) async {
      CallFlags.modes = true;
      CallFlags.queue = true;
      await _pumpApp(tester, actions(HostCallState.offline));
      expect(find.text('Notify me'), findsOneWidget);
      expect(find.text('BOOK A TIME'), findsNothing);
      expect(find.text('JOIN THE QUEUE'), findsNothing);
    });

    testWidgets("the server's canQueue / canBook win", (tester) async {
      CallFlags.modes = true;
      CallFlags.queue = true;
      await _pumpApp(tester, actions(HostCallState.onCall, canQueue: false, canBook: false));
      expect(find.text('JOIN THE QUEUE'), findsNothing);
      expect(find.text('BOOK A TIME'), findsNothing);
      expect(find.text('Notify me'), findsOneWidget);
    });

    testWidgets('Join the queue opens the queue screen with the waiting count', (tester) async {
      CallFlags.modes = true;
      CallFlags.queue = true;
      await _pumpApp(tester, actions(HostCallState.onCall, waiting: 4));
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(find.text('QUEUE priya n=4'), findsOneWidget);
    });

    testWidgets('profile buttons: flags off keep Call now / Book; on follow the state', (tester) async {
      Widget profile() => Scaffold(
            body: ProfileActions(
              online: true,
              first: 'Priya',
              onCall: () {},
              onBook: () {},
              notify: const Text('NOTIFY'),
              callState: HostCallState.onCall,
              queueWaiting: 1,
              onQueue: () {},
            ),
          );
      await _pumpApp(tester, profile());
      expect(find.text('Call now'), findsOneWidget);
      expect(find.text('Book'), findsOneWidget);
      expect(find.text('Join the queue'), findsNothing);
      CallFlags.modes = true;
      CallFlags.queue = true;
      await _pumpApp(tester, profile());
      expect(find.text('Join the queue'), findsOneWidget);
      expect(find.text('Book a time'), findsOneWidget);
      expect(find.text('Call now'), findsNothing);
    });

    test('feed labels follow the state, and are the old ones with the flag off', () {
      expect(callActionLabel(null), 'Call now');
      expect(callActionLabel(HostCallState.available), 'Call now');
      expect(callActionLabel(HostCallState.onCall), isNull);
      CallFlags.queue = true;
      expect(callActionLabel(HostCallState.onCall), 'Join the queue');
      expect(callActionLabel(HostCallState.offline), isNull);
      expect(callStateDot(HostCallState.onCall), isNull); // modes still off
      CallFlags.modes = true;
      expect(callStateDot(HostCallState.onCall)!.$2, 'On a call');
      expect(callStateDot(null), isNull);
    });
  });

  // ------------------------------------------------------------------------------------------ queue screen
  group('queue screen', () {
    Map<String, Object?> profile() => {'slug': 'priya', 'displayName': 'Priya Rao', 'status': 'busy', 'pricePaisePerMin': 2000, 'followers': 10};

    Future<FakeApiClient> pumpQueue(WidgetTester tester, Handler h, {int waiting = 0, Duration? poll}) async {
      final api = FakeApiClient((m, p, q, b) => p.startsWith('/api/hosts/public') ? profile() : h(m, p, q, b));
      await _pumpApp(tester, QueueScreen(slug: 'priya', waiting: waiting, repo: QueueRepo(api), reelsRepo: ReelsRepo(api), poll: poll));
      await tester.pumpAndSettle();
      return api;
    }

    Map<String, Object?> empty() => {'ok': true, 'entry': null};

    testWidgets('ready: the WhatsApp promise, the count and a Join button', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => empty(), waiting: 2);
      expect(find.text('Priya is on a call'), findsOneWidget);
      expect(find.textContaining('2 people are waiting'), findsOneWidget);
      expect(find.text("We'll WhatsApp you just before we call. Nothing is charged until you talk."), findsOneWidget);
      expect(find.text('JOIN THE QUEUE'), findsOneWidget);
    });

    testWidgets('join shows the position, then leave goes back', (tester) async {
      final api = await pumpQueue(tester, (m, p, q, b) {
        if (m == 'POST') return {'ok': true, 'entryId': 'e1', 'position': 3, 'waiting': 3};
        if (m == 'DELETE') return <String, Object?>{'ok': true};
        return empty();
      });
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('POST /api/hf/hosts/priya/queue'));
      expect(find.text('#3'), findsOneWidget);
      expect(find.text('for Priya'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('queue-leave')));
      await tester.pumpAndSettle();
      expect(api.calls, contains('DELETE /api/hf/hosts/priya/queue'));
      expect(find.text('REELS PAGE'), findsOneWidget);
    });

    testWidgets('already in this queue on open: straight to the position', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => {'ok': true, 'entry': {'entryId': 'e1', 'hostSlug': 'priya', 'hostName': 'Priya Rao', 'position': 2, 'status': 'waiting'}});
      expect(find.text('#2'), findsOneWidget);
      expect(find.text('LEAVE THE QUEUE'), findsOneWidget);
    });

    testWidgets('already in another queue: says so and offers that queue', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => {'ok': true, 'entry': {'entryId': 'e1', 'hostSlug': 'amit', 'hostName': 'Amit Das', 'position': 1, 'status': 'waiting'}});
      expect(find.text('You are already in the queue for Amit Das.'), findsOneWidget);
      expect(find.text('GO TO THAT QUEUE'), findsOneWidget);
    });

    testWidgets('queue_closed offers a booking instead', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => m == 'POST' ? _err(409, 'queue_closed') : empty());
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('queue-problem')), findsOneWidget);
      expect(find.textContaining('queue is closed'), findsOneWidget);
      expect(find.text('BOOK A TIME'), findsOneWidget);
    });

    testWidgets('queue_full is explained', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => m == 'POST' ? _err(409, 'queue_full') : empty());
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('queue is full'), findsOneWidget);
    });

    testWidgets('low_balance shows the shortfall and a TOP UP that opens the top-up', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => m == 'POST' ? _err(402, 'low_balance', 'Your wallet needs a little more.', {'shortfallPaise': 5000}) : empty());
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Your wallet needs a little more.'), findsOneWidget);
      expect(find.textContaining('Add about'), findsOneWidget);
      await tester.tap(find.text('TOP UP'));
      await tester.pumpAndSettle();
      expect(find.text('TOPUP PAGE'), findsOneWidget);
    });

    testWidgets('not_verified is explained', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => m == 'POST' ? _err(403, 'not_verified') : empty());
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Verify your WhatsApp number'), findsOneWidget);
    });

    testWidgets('already_queued from the join shows a message', (tester) async {
      await pumpQueue(tester, (m, p, q, b) => m == 'POST' ? _err(409, 'already_queued', null, {'hostSlug': 'amit'}) : empty());
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pumpAndSettle();
      expect(find.text('You are already in a queue.'), findsOneWidget);
      expect(find.text('GO TO THAT QUEUE'), findsOneWidget);
    });

    testWidgets('a failed first read shows Try again', (tester) async {
      var fail = true;
      await pumpQueue(tester, (m, p, q, b) => fail ? ApiException.offline() : empty());
      expect(find.text('TRY AGAIN'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('TRY AGAIN'));
      await tester.pumpAndSettle();
      expect(find.text('JOIN THE QUEUE'), findsOneWidget);
    });

    testWidgets('polling moves the position, then the call when it is her turn', (tester) async {
      var step = 0;
      final api = await pumpQueue(
        tester,
        (m, p, q, b) {
          if (m == 'POST') return {'ok': true, 'entryId': 'e1', 'position': 3, 'waiting': 3};
          if (p == '/api/hf/queue/me' && step > 0) {
            if (step == 1) return {'ok': true, 'entry': {'entryId': 'e1', 'hostSlug': 'priya', 'hostName': 'Priya Rao', 'position': 1, 'status': 'waiting'}};
            return {'ok': true, 'entry': {'entryId': 'e1', 'hostSlug': 'priya', 'hostName': 'Priya Rao', 'position': 1, 'status': 'offered', 'callId': 'call-7'}};
          }
          return empty();
        },
        poll: const Duration(milliseconds: 100),
      );
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pump();
      await tester.pump();
      expect(find.text('#3'), findsOneWidget);
      step = 1;
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pump();
      expect(find.text('#1'), findsOneWidget);
      step = 2;
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(find.text('CALL call-7'), findsOneWidget);
      expect(api.calls.where((c) => c == 'GET /api/hf/queue/me').length, greaterThanOrEqualTo(3));
    });

    testWidgets('when the server closes the queue the screen says so and offers a booking', (tester) async {
      var closed = false;
      await pumpQueue(
        tester,
        (m, p, q, b) {
          if (m == 'POST') return {'ok': true, 'entryId': 'e1', 'position': 2, 'waiting': 2};
          if (closed) return {'ok': true, 'entry': {'entryId': 'e1', 'hostSlug': 'priya', 'hostName': 'Priya Rao', 'position': 2, 'status': 'closed'}};
          return empty();
        },
        poll: const Duration(milliseconds: 100),
      );
      await tester.tap(find.text('JOIN THE QUEUE'));
      await tester.pump();
      await tester.pump();
      closed = true;
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pump();
      expect(find.byKey(const ValueKey('queue-over-text')), findsOneWidget);
      expect(find.textContaining('queue is closed'), findsOneWidget);
      expect(find.text('BOOK A TIME'), findsOneWidget);
    });
  });

  // ------------------------------------------------------------------------------------------ booking length picker
  group('booking length picker', () {
    Map<String, Object?> slots({int minutes = 15, bool withLengths = true}) => {
          'timezone': 'Asia/Kolkata',
          'minutes': minutes,
          'ratePerMin': 20,
          'holdPaise': 30000,
          if (withLengths) 'holdMinutes': 15,
          if (withLengths) 'durationsMinutes': [15, 30, 60, 120, 180, 240, 300],
          'today': isoDay(DateTime.now()),
          'lastDate': isoDay(DateTime.now().add(const Duration(days: 20))),
          'days': {
            isoDay(DateTime.now().add(const Duration(days: 3))): ['10:00', '16:00'],
          },
        };

    Map<String, Object?> host() => {'slug': 'maya', 'displayName': 'Maya Rao', 'status': 'online', 'pricePaisePerMin': 2000, 'followers': 900};

    Future<FakeApiClient> pumpBook(WidgetTester tester, {bool withLengths = true}) async {
      final day = isoDay(DateTime.now().add(const Duration(days: 3)));
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/slots')) {
          final len = q?['durationMinutes'];
          return slots(minutes: len is int ? len : 15, withLengths: withLengths);
        }
        return host();
      });
      await _pumpApp(tester, RealBookScreen(id: 'maya', day: day, repo: BookingsRepo(api), reelsRepo: ReelsRepo(api)));
      await tester.pumpAndSettle();
      return api;
    }

    testWidgets('flag off: no picker, even if the server sent lengths', (tester) async {
      await pumpBook(tester);
      expect(find.text('How long?'), findsNothing);
      expect(find.text('15 min'), findsNothing);
    });

    testWidgets('flag on but an old server (no lengths): no picker', (tester) async {
      CallFlags.bookingLengths = true;
      await pumpBook(tester, withLengths: false);
      expect(find.text('How long?'), findsNothing);
    });

    testWidgets('flag on: all seven lengths with plain labels, 15 min chosen first', (tester) async {
      CallFlags.bookingLengths = true;
      await pumpBook(tester);
      expect(find.text('How long?'), findsOneWidget);
      for (final l in ['15 min', '30 min', '1 h', '2 h', '3 h', '4 h', '5 h']) {
        expect(find.text(l), findsOneWidget, reason: l);
      }
      expect(find.textContaining('hold the cost of the first 15 minutes'), findsOneWidget);
      expect(find.textContaining('15 min call'), findsOneWidget);
    });

    testWidgets('picking a length asks the server for that length and carries it to confirm', (tester) async {
      CallFlags.bookingLengths = true;
      final api = await pumpBook(tester);
      await tester.tap(find.byKey(const ValueKey('length-60')));
      await tester.pumpAndSettle();
      expect(api.queries.last?['durationMinutes'], 60);
      expect(find.textContaining('1 h call'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('slot-16:00')));
      await tester.pump();
      await tester.tap(find.text('NEXT'));
      await tester.pumpAndSettle();
      expect(find.textContaining('len=60'), findsOneWidget);
    });
  });
}
