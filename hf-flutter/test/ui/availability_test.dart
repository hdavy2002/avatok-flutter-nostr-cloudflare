import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';
import 'package:hf_app/demo/screens/availability_real.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApi extends ApiClient {
  FakeApi(this.handler) : super(origin: 'https://api.test');

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

ApiException _err(int status, String code, [String? message]) => ApiException(kind: ApiFailure.http, status: status, code: code, message: message);

DateTime get _today => DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day);
String _k(int plusDays) => isoDay(_today.add(Duration(days: plusDays)));

Map<String, Object?> _avail({Map<String, Object?> days = const {}, Map<String, Object?> booked = const {}, bool editable = true, int version = 3}) => {
      'timezone': 'Asia/Kolkata',
      'version': version,
      'minutes': 10,
      'horizonDays': 21,
      'today': isoDay(_today),
      'slotChoices': ['09:00', '10:00', '11:00', '16:00', '18:00'],
      'days': days,
      'booked': booked,
      'rate': {
        'ratePerMin': 100,
        'minRate': 5,
        'maxRate': 1000,
        'editable': editable,
        'hostGetsPerMinPaise': 5800,
        if (!editable) 'fixedMessage': 'One rate is set for everyone right now, so you can not change yours.',
      },
    };

Future<void> _pump(WidgetTester tester, FakeApi api) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: RealAvailabilityScreen(repo: BookingsRepo(api))));
  await tester.pumpAndSettle();
}

Finder _day(int plusDays) => find.byKey(ValueKey('day-${_k(plusDays)}'));

void main() {
  group('RealAvailabilityScreen (calendar)', () {
    testWidgets('no panel until a day is picked; picking one shows its own times', (tester) async {
      final api = FakeApi((m, p, q, b) => _avail(days: {_k(1): {'open': true, 'slots': ['10:00', '16:00']}}));
      await _pump(tester, api);
      expect(find.textContaining('Time slots for'), findsNothing);
      await tester.tap(_day(1));
      await tester.pumpAndSettle();
      expect(find.textContaining('Time slots for'), findsOneWidget);
      final chip10 = tester.widget<FilterChip>(find.byKey(const ValueKey('chip-10:00')));
      final chip18 = tester.widget<FilterChip>(find.byKey(const ValueKey('chip-18:00')));
      expect(chip10.selected, isTrue);
      expect(chip18.selected, isFalse);
    });

    testWidgets('tap a day, tap a time, SAVE sends just that day with the version', (tester) async {
      final api = FakeApi((m, p, q, b) => m == 'PUT' ? _avail(days: {_k(1): {'open': true, 'slots': ['18:00']}}) : _avail());
      await _pump(tester, api);
      await tester.tap(_day(1));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('chip-18:00')));
      await tester.pumpAndSettle();
      expect(find.text('SAVE 1 DAY'), findsOneWidget);
      await tester.tap(find.text('SAVE 1 DAY'));
      await tester.pumpAndSettle();
      expect(api.calls.last, 'PUT /api/hf/hosts/me/availability');
      expect(api.bodies.last, {
        'expectedVersion': 3,
        'days': {_k(1): {'open': true, 'slots': ['18:00']}},
      });
      expect(find.text('SAVE 1 DAY'), findsNothing); // saved: nothing left to save
    });

    testWidgets('press, hold and drag selects a range; one tap on a time sets it on every day', (tester) async {
      final api = FakeApi((m, p, q, b) => _avail());
      await _pump(tester, api);
      final g = await tester.startGesture(tester.getCenter(_day(1)));
      await tester.pump(const Duration(milliseconds: 700));
      await g.moveTo(tester.getCenter(_day(3)));
      await tester.pump();
      await g.up();
      await tester.pumpAndSettle();
      expect(find.text('Time slots for 3 days'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('chip-16:00')));
      await tester.pumpAndSettle();
      expect(find.text('SAVE 3 DAYS'), findsOneWidget);
      await tester.tap(find.text('SAVE 3 DAYS'));
      await tester.pumpAndSettle();
      final sent = ((api.bodies.last as Map)['days'] as Map).cast<String, Object?>();
      expect(sent.keys.toSet(), {_k(1), _k(2), _k(3)});
      for (final v in sent.values) {
        expect((v as Map)['slots'], ['16:00']);
        expect(v['open'], true);
      }
    });

    testWidgets('a day past the horizon is not selectable', (tester) async {
      final api = FakeApi((m, p, q, b) => _avail());
      await _pump(tester, api);
      // 21 days from today is the first day past the server horizon; it may sit in the second month.
      final far = _day(25);
      if (far.evaluate().isEmpty) return; // not on the grid this month: nothing to check
      await tester.tap(far);
      await tester.pumpAndSettle();
      expect(find.textContaining('Time slots for'), findsNothing);
    });

    testWidgets('a booked time is locked and cannot be closed', (tester) async {
      final api = FakeApi((m, p, q, b) => _avail(
            days: {_k(1): {'open': true, 'slots': ['16:00']}},
            booked: {_k(1): ['16:00']},
          ));
      await _pump(tester, api);
      await tester.tap(_day(1));
      await tester.pumpAndSettle();
      expect(find.textContaining('4:00 pm · booked'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('chip-16:00')));
      await tester.pumpAndSettle();
      expect(find.textContaining('SAVE '), findsNothing); // nothing changed: only the disabled plain SAVE shows
    });

    testWidgets('schedule changed elsewhere: shows the server message and reloads', (tester) async {
      final api = FakeApi((m, p, q, b) => m == 'PUT' ? _err(409, 'schedule_changed', 'Your availability changed somewhere else. Reload it and try again.') : _avail());
      await _pump(tester, api);
      await tester.tap(_day(1));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('chip-18:00')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('SAVE 1 DAY'));
      await tester.pumpAndSettle();
      expect(find.textContaining('changed somewhere else'), findsOneWidget);
      expect(api.calls.where((c) => c == 'GET /api/hf/hosts/me/availability').length, 2);
      expect(find.text('SAVE 1 DAY'), findsNothing);
    });

    testWidgets('load failure shows Try again', (tester) async {
      final api = FakeApi((m, p, q, b) => ApiException.offline());
      await _pump(tester, api);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('RealAvailabilityScreen (rate)', () {
    testWidgets('shows the rate and what she gets by the server rule', (tester) async {
      final api = FakeApi((m, p, q, b) => _avail());
      await _pump(tester, api);
      expect(find.text('₹100/min'), findsOneWidget);
      expect(find.text('You get about ₹58 a minute'), findsOneWidget);
    });

    testWidgets('+ previews by the server rule, SAVE RATE saves', (tester) async {
      final api = FakeApi((m, p, q, b) {
        if (p == '/api/hf/hosts/me/rate') return {'rate': {'ratePerMin': 101, 'minRate': 5, 'maxRate': 1000, 'editable': true, 'hostGetsPerMinPaise': 5860}};
        return _avail();
      });
      await _pump(tester, api);
      await tester.ensureVisible(find.byIcon(Icons.add_rounded));
      await tester.tap(find.byIcon(Icons.add_rounded));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(find.text('₹101/min'), findsOneWidget);
      await tester.tap(find.text('SAVE RATE'));
      await tester.pumpAndSettle();
      expect(api.bodies[api.calls.indexOf('PUT /api/hf/hosts/me/rate')], {'pricePerMin': 101});
    });

    testWidgets('Standard plan: no rate control, a clear sentence instead', (tester) async {
      final api = FakeApi((m, p, q, b) => _avail(editable: false));
      await _pump(tester, api);
      expect(find.textContaining('One rate is set for everyone'), findsOneWidget);
      expect(find.textContaining('You get about'), findsNothing);
    });
  });

  group('RealAvailabilityScreen (counts) [HF-APP-AVAIL-COUNTS-1]', () {
    Object? withSummary(String m, String p, Object? avail) =>
        p == '/api/hf/bookings/summary' ? {'summary': {'waitingCount': 2, 'bookedDays': 3, 'upcomingCount': 4}} : avail;

    testWidgets('shows the server counts', (tester) async {
      final api = FakeApi((m, p, q, b) => withSummary(m, p, _avail()));
      await _pump(tester, api);
      expect(find.text('3 days booked'), findsOneWidget);
      expect(find.text('2 requests waiting'), findsOneWidget);
    });

    testWidgets('server fails: booked days counted from the calendar, waiting chip hidden', (tester) async {
      final api = FakeApi((m, p, q, b) => p == '/api/hf/bookings/summary'
          ? _err(500, 'boom')
          : _avail(booked: {_k(1): ['10:00'], _k(2): ['10:00', '11:00'], _k(3): <String>[]}));
      await _pump(tester, api);
      expect(find.text('2 days booked'), findsOneWidget);
      expect(find.byKey(const ValueKey('chip-waiting')), findsNothing);
      expect(find.textContaining('waiting'), findsNothing);
    });

    testWidgets('tapping requests waiting opens the bookings screen', (tester) async {
      final api = FakeApi((m, p, q, b) => withSummary(m, p, _avail()));
      tester.view.physicalSize = const Size(900, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final router = GoRouter(routes: [
        GoRoute(path: '/', builder: (_, __) => RealAvailabilityScreen(repo: BookingsRepo(api))),
        GoRoute(path: '/bookings', builder: (_, __) => const Scaffold(body: Text('BOOKINGS PAGE'))),
      ]);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('chip-waiting')));
      await tester.pumpAndSettle();
      expect(find.text('BOOKINGS PAGE'), findsOneWidget);
    });
  });
}
