import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/call.dart';
import 'package:hf_app/data/repos/calls_repo.dart';
import 'package:hf_app/data/repos/presence_repo.dart';
import 'package:hf_app/data/telemetry.dart';
import 'package:hf_app/demo/data.dart';
import 'package:hf_app/demo/screens/call_real.dart';
import 'package:hf_app/demo/screens/call_records_real.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];
  final List<Map<String, Object?>?> queries = [];

  int count(String method, String path) => calls.where((c) => c == '$method $path').length;

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

const _now = 1760000000000;

Map<String, Object?> _status(String status,
        {String? phase, String? reason, int? connectedAt, int cost = 0, int? wallet, int? capAt, int minutes = 0, bool canReview = false, String? endReason}) =>
    {
      'id': 'call_abc12345',
      'status': status,
      if (phase != null) 'phase': phase,
      'reason': reason,
      'hostSlug': 'meera',
      'hostName': 'Meera Joshi',
      'rate': 15,
      'connectedAt': connectedAt,
      'endedAt': null,
      'billedMinutes': minutes,
      'costPaise': cost,
      'walletPaise': wallet,
      'capAt': capAt,
      'lowBalanceSeconds': 180,
      'canReview': canReview,
      'endReason': endReason,
    };

Map<String, Object?> _estimate({int seconds = 1200, int balance = 10000, bool canStart = true}) => {
      'mode': 'rupees',
      'ratePerMinRupees': 15,
      'ratePaisePerMin': 1500,
      'canStart': canStart,
      'balancePaise': balance,
      'startNeedPaise': 3000,
      'affordableSeconds': seconds,
      'lowBalanceSeconds': 180,
      'hasDebt': false,
    };

const _meera = Influencer(
  id: 'meera',
  name: 'Meera Joshi',
  handle: '@meera',
  city: '',
  niche: '',
  bio: '',
  rate: 15,
  likes: '',
  followers: '',
  videos: 0,
  online: true,
  tones: [Color(0xFFFF8A1F), Color(0xFFC2185B)],
);

Future<GoRouter> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS PAGE'))),
      GoRoute(path: '/topup', builder: (_, __) => const Scaffold(body: Text('TOPUP PAGE'))),
      GoRoute(path: '/book/:id', builder: (_, s) => Scaffold(body: Text('BOOK ${s.pathParameters['id']}'))),
      GoRoute(path: '/profile/:id', builder: (_, s) => Scaffold(body: Text('PROFILE ${s.pathParameters['id']}'))),
      GoRoute(path: '/call/:id', builder: (_, s) => Scaffold(body: Text('CALL ${s.pathParameters['id']}'))),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  return router;
}

/// Opens [sheet] the way startCall does, so Navigator.pop closes just the sheet.
Future<void> _openSheet(WidgetTester tester, Widget sheet) async {
  await _pump(
    tester,
    Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () => showModalBottomSheet<void>(context: context, isScrollControlled: true, backgroundColor: Colors.transparent, builder: (_) => sheet),
            child: const Text('OPEN'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('OPEN'));
  await _settle(tester, 300);
}

Future<void> _settle(WidgetTester tester, [int ms = 60]) async {
  await tester.pump(Duration(milliseconds: ms));
  await tester.pump(Duration(milliseconds: ms));
}

void main() {
  group('CallsRepo', () {
    test('estimate parses rate, balance and the low threshold', () async {
      final api = FakeApiClient((m, p, q, b) => _estimate(seconds: 120));
      final e = await CallsRepo(api).estimate('meera');
      expect(api.calls.single, 'GET /api/hf/wallet/estimate');
      expect(api.queries.single, {'host': 'meera'});
      expect(e.ratePerMinRupees, 15);
      expect(e.balancePaise, 10000);
      expect(e.talkMinutes, 2);
      expect(e.low, isTrue);
      final fine = await CallsRepo(FakeApiClient((m, p, q, b) => _estimate())).estimate('meera');
      expect(fine.low, isFalse);
    });

    test('start posts the slug and returns the call id', () async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'callId': 'call_abc12345', 'status': 'ringing_host'});
      expect(await CallsRepo(api).start('meera'), 'call_abc12345');
      expect(api.calls.single, 'POST /api/hf/calls');
      expect(api.bodies.single, {'hostSlug': 'meera'});
    });

    test('status maps every phase, and falls back to the row status on an older worker', () {
      expect(CallStatus.fromJson(_status('ringing_host', phase: 'ringing_host')).phase, CallPhase.ringingHost);
      expect(CallStatus.fromJson(_status('ringing_host', phase: 'host_accepted')).phase, CallPhase.hostAccepted);
      expect(CallStatus.fromJson(_status('ringing_caller', phase: 'dialing_fan')).phase, CallPhase.dialingFan);
      expect(CallStatus.fromJson(_status('connected', phase: 'connected')).phase, CallPhase.connected);
      final old = CallStatus.fromJson({'id': 'x', 'status': 'host_declined', 'chargedRupees': 0});
      expect(old.phase, CallPhase.ended);
      expect(old.reason, CallReason.declined);
      expect(old.unavailable, isTrue);
      expect(CallStatus.fromJson({'id': 'x', 'status': 'ringing_caller'}).phase, CallPhase.dialingFan);
      final cancelled = CallStatus.fromJson(_status('failed', phase: 'ended', reason: 'ended', endReason: 'caller_hangup'));
      expect(cancelled.unavailable, isFalse);
    });

    test('errors map to what the person should see', () {
      ApiException e(String code, [int status = 409]) => ApiException(kind: ApiFailure.http, status: status, code: code, message: 'server words');
      expect(CallProblemInfo.of(e('not_enabled', 404)).problem, CallProblem.notOpen);
      expect(CallProblemInfo.of(e('not_enabled', 404)).message, 'Calls are not open yet.');
      expect(CallProblemInfo.of(e('calls_not_ready', 503)).problem, CallProblem.notOpen);
      expect(CallProblemInfo.of(e('low_balance', 402)).problem, CallProblem.lowBalance);
      expect(CallProblemInfo.of(e('host_unavailable')).problem, CallProblem.hostUnavailable);
      expect(CallProblemInfo.of(e('host_offline')).problem, CallProblem.hostUnavailable);
      expect(CallProblemInfo.of(e('call_in_progress')).problem, CallProblem.inProgress);
      expect(CallProblemInfo.of(e('lane_required', 403)).message, 'server words');
    });

    test('history sends the cursor and parses rows', () async {
      final api = FakeApiClient((m, p, q, b) => {
            'ok': true,
            'items': [
              {'id': 'c1', 'status': 'completed', 'otherHandle': 'Meera J', 'hostSlug': 'meera', 'at': 5, 'seconds': 170, 'amountPaise': 850, 'reason': 'ended', 'myStars': 4},
            ],
            'nextCursor': 'abc',
          });
      final page = await CallsRepo(api).history(cursor: 'zzz');
      expect(api.queries.single, {'role': 'caller', 'limit': 20, 'cursor': 'zzz'});
      expect(page.nextCursor, 'abc');
      expect(page.items.single.minutes, 3);
      expect(page.items.single.stars, 4);
    });
  });

  group('Call confirm sheet', () {
    testWidgets('enough balance: shows talk time and CALL NOW starts the call and opens it', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p == '/api/hf/wallet/estimate') return _estimate();
        if (p == '/api/hf/calls' && m == 'POST') return {'ok': true, 'callId': 'call_abc12345', 'status': 'ringing_host'};
        return ApiException.offline();
      });
      await _openSheet(tester, RealCallConfirmSheet(who: _meera, repo: CallsRepo(api)));
      expect(find.text('Call Meera Joshi?'), findsOneWidget);
      expect(find.text('up to 20 min'), findsOneWidget);
      expect(find.text('CALL NOW'), findsOneWidget);
      expect(find.text('TOP UP'), findsNothing);
      await tester.tap(find.text('CALL NOW'));
      await _settle(tester, 300);
      expect(api.bodies.last, {'hostSlug': 'meera'});
      expect(find.text('CALL call_abc12345'), findsOneWidget);
    });

    testWidgets('low balance: TOP UP instead of CALL NOW', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _estimate(seconds: 120, balance: 3000));
      await _openSheet(tester, RealCallConfirmSheet(who: _meera, repo: CallsRepo(api)));
      expect(find.text('CALL NOW'), findsNothing);
      expect(find.text('TOP UP'), findsOneWidget);
      expect(api.count('POST', '/api/hf/calls'), 0);
      await tester.tap(find.text('TOP UP'));
      await _settle(tester, 300);
      expect(find.text('TOPUP PAGE'), findsOneWidget);
    });

    testWidgets('flag off: Calls are not open yet.', (tester) async {
      final api = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled'));
      await _openSheet(tester, RealCallConfirmSheet(who: _meera, repo: CallsRepo(api)));
      expect(find.text('Calls are not open yet.'), findsOneWidget);
      expect(find.text('CALL NOW'), findsNothing);
    });

    testWidgets('host went offline between estimate and start: offline sheet with Notify me and Book a time', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (p == '/api/hf/wallet/estimate') return _estimate();
        return const ApiException(kind: ApiFailure.http, status: 409, code: 'host_unavailable', message: "This host isn't available right now.");
      });
      await _openSheet(tester, RealCallConfirmSheet(who: _meera, repo: CallsRepo(api), notifyRepo: PresenceRepo(FakeApiClient((m, p, q, b) => {'ok': true}))));
      await tester.tap(find.text('CALL NOW'));
      await _settle(tester);
      expect(find.text('Meera is not available'), findsOneWidget);
      expect(find.text('Notify me'), findsOneWidget);
      expect(find.text('BOOK A TIME'), findsOneWidget);
    });
  });

  group('Call screen', () {
    Future<FakeApiClient> pumpCall(WidgetTester tester, List<Map<String, Object?>> script, {Handler? extra, Duration slow = const Duration(seconds: 5), int Function()? now}) async {
      var i = 0;
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'GET' && p == '/api/hf/calls/call_abc12345') {
          final s = script[i < script.length ? i : script.length - 1];
          i++;
          return s;
        }
        return extra?.call(m, p, q, b) ?? {'ok': true};
      });
      await _pump(
        tester,
        RealCallScreen(
          callId: 'call_abc12345',
          repo: CallsRepo(api),
          notifyRepo: PresenceRepo(FakeApiClient((m, p, q, b) => {'ok': true})),
          fastPoll: const Duration(milliseconds: 20),
          slowPoll: slow,
          now: now ?? () => _now,
        ),
      );
      return api;
    }

    testWidgets('walks through every phase with the demo wording, live cost, wallet and the 60 second warning', (tester) async {
      final events = <String>[];
      Telemetry.sink = (e, p) => events.add(e);
      addTearDown(() => Telemetry.sink = (e, p) {});
      final api = await pumpCall(
        tester,
        [
          _status('ringing_host', phase: 'ringing_host'),
          _status('ringing_host', phase: 'host_accepted'),
          _status('ringing_caller', phase: 'dialing_fan'),
          _status('connected', phase: 'connected', connectedAt: _now - 65000, cost: 3000, wallet: 7000, capAt: _now + 30000),
        ],
        slow: const Duration(seconds: 30),
      );
      await tester.pump(const Duration(milliseconds: 5));
      expect(find.text('Calling Meera…'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 25));
      expect(find.text('Meera picked up! Ringing your phone…'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 25));
      expect(find.textContaining('Answer the call from the'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 25));
      expect(find.text('On call · 01:05'), findsOneWidget);
      expect(find.text('2 min · ₹30 so far'), findsOneWidget);
      expect(find.text('Wallet: ₹70'), findsOneWidget);
      expect(find.text('About 1 minute left. Top up to keep talking.'), findsOneWidget);
      expect(events, containsAll(['hf_app_call_status', 'hf_app_call_cap_warning']));
      // Connected: polling backs off to the slow interval, so a long wait adds no more status calls.
      final before = api.count('GET', '/api/hf/calls/call_abc12345');
      await tester.pump(const Duration(milliseconds: 500));
      expect(api.count('GET', '/api/hf/calls/call_abc12345'), before);
    });

    testWidgets('END CALL before it connects cancels', (tester) async {
      final api = await pumpCall(
        tester,
        [_status('ringing_host', phase: 'ringing_host'), _status('failed', phase: 'ended', reason: 'ended', endReason: 'caller_hangup')],
      );
      await tester.pump(const Duration(milliseconds: 5));
      await tester.tap(find.text('END CALL'));
      await _settle(tester);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/cancel'), 1);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/end'), 0);
      expect(find.text('Call ended'), findsOneWidget);
      expect(find.text('No charge — the call did not connect.'), findsOneWidget);
    });

    testWidgets('END CALL while connected ends it', (tester) async {
      final api = await pumpCall(
        tester,
        [
          _status('connected', phase: 'connected', connectedAt: _now - 10000, cost: 1500, wallet: 8500, capAt: _now + 600000),
          _status('completed', phase: 'ended', reason: 'ended', connectedAt: _now - 10000, cost: 1500, minutes: 1, endReason: 'caller_hangup', canReview: true),
        ],
        slow: const Duration(milliseconds: 20),
      );
      await tester.pump(const Duration(milliseconds: 5));
      await tester.tap(find.text('END CALL'));
      await _settle(tester);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/end'), 1);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/cancel'), 0);
      expect(find.text('1 min · ₹15'), findsOneWidget);
    });

    testWidgets('cancel that arrives too late falls back to end', (tester) async {
      final api = await pumpCall(
        tester,
        [
          _status('ringing_caller', phase: 'dialing_fan'),
          _status('completed', phase: 'ended', reason: 'ended', connectedAt: _now - 1000, minutes: 1, cost: 1500, canReview: true),
        ],
        extra: (m, p, q, b) => p.endsWith('/cancel') ? const ApiException(kind: ApiFailure.http, status: 409, code: 'already_connected') : {'ok': true},
      );
      await tester.pump(const Duration(milliseconds: 5));
      await tester.tap(find.text('END CALL'));
      await _settle(tester);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/cancel'), 1);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/end'), 1);
    });

    testWidgets('ended: final cost, 1-5 stars, DONE posts the review', (tester) async {
      final api = await pumpCall(
        tester,
        [_status('completed', phase: 'ended', reason: 'ended', connectedAt: _now - 200000, minutes: 3, cost: 4500, canReview: true, endReason: 'host_hangup')],
      );
      await tester.pump(const Duration(milliseconds: 5));
      expect(find.text('Call ended'), findsOneWidget);
      expect(find.text('3 min · ₹45'), findsOneWidget);
      expect(find.text('How was it?'), findsOneWidget);
      await tester.tap(find.byTooltip('4 stars'));
      await tester.pump();
      await tester.tap(find.text('DONE'));
      await _settle(tester);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/review'), 1);
      expect(api.bodies.last, {'stars': 4});
      expect(find.text('REELS PAGE'), findsOneWidget);
    });

    testWidgets('ran out of balance: says so and offers TOP UP', (tester) async {
      await pumpCall(
        tester,
        [_status('completed', phase: 'ended', reason: 'no_balance', connectedAt: _now - 200000, minutes: 3, cost: 4500, endReason: 'balance')],
      );
      await tester.pump(const Duration(milliseconds: 5));
      expect(find.text('Your balance ran out.'), findsOneWidget);
      await tester.tap(find.text('TOP UP'));
      await _settle(tester);
      expect(find.text('TOPUP PAGE'), findsOneWidget);
    });

    testWidgets('declined: Busy right now with Notify me and Book a time, no review', (tester) async {
      final api = await pumpCall(tester, [_status('host_declined', phase: 'ended', reason: 'declined')]);
      await tester.pump(const Duration(milliseconds: 5));
      expect(find.text('Busy right now'), findsOneWidget);
      expect(find.text('Notify me'), findsOneWidget);
      expect(find.text('How was it?'), findsNothing);
      await tester.tap(find.text('BOOK A TIME'));
      await _settle(tester);
      expect(find.text('BOOK meera'), findsOneWidget);
      expect(api.count('POST', '/api/hf/calls/call_abc12345/review'), 0);
    });

    testWidgets('missed, busy and offline all read as Busy right now', (tester) async {
      for (final r in ['missed', 'busy', 'offline']) {
        await pumpCall(tester, [_status('no_answer', phase: 'ended', reason: r)]);
        await tester.pump(const Duration(milliseconds: 5));
        expect(find.text('Busy right now'), findsOneWidget, reason: r);
        await tester.pumpWidget(const SizedBox());
      }
    });

    testWidgets('flag off while following: Calls are not open yet.', (tester) async {
      final api = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled'));
      await _pump(tester, RealCallScreen(callId: 'call_abc12345', repo: CallsRepo(api), now: () => _now));
      await tester.pump(const Duration(milliseconds: 5));
      expect(find.text('Calls are not open yet.'), findsOneWidget);
    });
  });

  group('Call records', () {
    Map<String, Object?> row(String id, String name, {String status = 'completed', String? reason = 'ended', int seconds = 120, int? paise = 3000, int stars = 0, String? slug = 'meera'}) => {
          'id': id,
          'status': status,
          'reason': reason,
          'otherHandle': name,
          'hostSlug': slug,
          'at': _now,
          'seconds': seconds,
          'amountPaise': paise,
          'myStars': stars == 0 ? null : stars,
        };

    testWidgets('lists every outcome, loads the next page by cursor, Call again opens the profile', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (q?['cursor'] == 'next1') {
          return {'ok': true, 'items': [row('c3', 'Third Host', slug: 'third')], 'nextCursor': null};
        }
        return {
          'ok': true,
          'items': [
            row('c1', 'Meera Joshi', stars: 4),
            row('c2', 'Arjun Rao', status: 'host_declined', reason: 'declined', seconds: 0, paise: null, slug: 'arjun'),
          ],
          'nextCursor': 'next1',
        };
      });
      await _pump(tester, RealCallRecordsScreen(repo: CallsRepo(api)));
      await _settle(tester);
      expect(find.text('Meera Joshi'), findsOneWidget);
      expect(find.text('★★★★'), findsOneWidget);
      expect(find.text('-₹30'), findsOneWidget);
      expect(find.text("Didn't connect · declined"), findsOneWidget);
      expect(find.text('Third Host'), findsNothing);
      await tester.tap(find.text('LOAD MORE'));
      await _settle(tester);
      expect(find.text('Third Host'), findsOneWidget);
      expect(api.queries.last?['cursor'], 'next1');
      expect(find.text('LOAD MORE'), findsNothing);
      await tester.tap(find.text('Call again').first);
      await _settle(tester);
      expect(find.text('PROFILE meera'), findsOneWidget);
    });

    testWidgets('empty and error states', (tester) async {
      final empty = FakeApiClient((m, p, q, b) => {'ok': true, 'items': [], 'nextCursor': null});
      await _pump(tester, RealCallRecordsScreen(repo: CallsRepo(empty)));
      await _settle(tester);
      expect(find.text('No calls yet'), findsOneWidget);

      var down = true;
      final flaky = FakeApiClient((m, p, q, b) => down ? ApiException.offline() : {'ok': true, 'items': [row('c1', 'Meera Joshi')], 'nextCursor': null});
      await tester.pumpWidget(const SizedBox());
      await _pump(tester, RealCallRecordsScreen(repo: CallsRepo(flaky)));
      await _settle(tester);
      expect(find.text('You are offline'), findsOneWidget);
      down = false;
      await tester.tap(find.text('Try again'));
      await _settle(tester);
      expect(find.text('Meera Joshi'), findsOneWidget);
    });
  });
}
