import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';
import 'package:hf_app/data/repos/reels_repo.dart';
import 'package:hf_app/data/repos/wallet_repo.dart';
import 'package:hf_app/demo/screens/bookings_real.dart';
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

DateTime get _today => DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day);

/// Two neighbouring days of the same month, both after today: [open, closed].
(DateTime, DateTime) _twoDays() {
  final base = _today.add(const Duration(days: 3));
  final next = base.add(const Duration(days: 1));
  return next.month == base.month ? (base, next) : (base.subtract(const Duration(days: 1)), base);
}

Map<String, Object?> _slots(Map<String, List<String>> days, {int rate = 20, int hold = 20000}) => {
      'timezone': 'Asia/Kolkata',
      'minutes': 10,
      'ratePerMin': rate,
      'holdPaise': hold,
      'today': isoDay(_today),
      'lastDate': isoDay(_today.add(const Duration(days: 20))),
      'days': days,
      'openDays': days.keys.toList(),
    };

Map<String, Object?> _profile() => {'slug': 'maya', 'displayName': 'Maya Rao', 'status': 'online', 'pricePaisePerMin': 2000, 'followers': 900, 'handle': '@maya'};

Map<String, Object?> _wallet(int paise) => {'balancePaise': paise, 'testCreditPaise': 0, 'heldPaise': 0, 'ledger': <Object?>[], 'nextCursor': null};

Map<String, Object?> _fanBooking({String id = 'b1', String day = '2026-10-22', String time = '16:00', bool canCancel = true}) => {
      'id': id,
      'status': 'confirmed',
      'startAt': '2026-10-22T10:30:00.000Z',
      'day': day,
      'time': time,
      'minutes': 10,
      'holdPaise': 20000,
      'hostSlug': 'maya',
      'hostName': 'Maya Rao',
      'canCancel': canCancel,
      'freeCancelUntil': '2026-10-22T09:30:00.000Z',
      'cancelRule': 'You can cancel for free until 1 hour before. After that the hold is kept.',
      if (!canCancel) 'cancelBlockedText': 'It is less than 1 hour to your booking, so it can no longer be cancelled for free.',
    };

Map<String, Object?> _hostBooking(String day) => {
      'id': 'h1',
      'status': 'confirmed',
      'startAt': '2026-10-22T10:30:00.000Z',
      'day': day,
      'time': '16:00',
      'minutes': 10,
      'holdPaise': 20000,
      'canCancel': true,
      'cancelRule': "If you cancel, the fan's hold is refunded in full.",
      'fanHandle': 'Ravi',
      'note': 'Birthday surprise',
      'expectedNetPaise': 5800,
    };

Map<String, Object?> _avail({Map<String, Object?> days = const {}, Map<String, Object?> booked = const {}, bool editable = true, int rate = 100, int gets = 5800, int version = 3}) => {
      'timezone': 'Asia/Kolkata',
      'version': version,
      'minutes': 10,
      'horizonDays': 21,
      'today': isoDay(_today),
      'slotChoices': ['09:00', '10:00', '11:00', '16:00', '18:00'],
      'days': days,
      'booked': booked,
      'rate': {
        'ratePerMin': rate,
        'minRate': 5,
        'maxRate': 1000,
        'editable': editable,
        'hostGetsPerMinPaise': gets,
        if (!editable) 'fixedMessage': 'One rate is set for everyone right now, so you can not change yours.',
      },
    };

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/book/:id/confirm', builder: (_, s) => Scaffold(body: Text('CONFIRM ${s.uri.query}'))),
      GoRoute(path: '/booked/:id', builder: (_, s) => Scaffold(body: Text('BOOKED ${s.uri.query}'))),
      GoRoute(path: '/book/:id', builder: (_, s) => Scaffold(body: Text('BOOK ${s.uri.query}'))),
      GoRoute(path: '/topup', builder: (_, __) => const Scaffold(body: Text('TOPUP PAGE'))),
      GoRoute(path: '/bookings', builder: (_, __) => const Scaffold(body: Text('BOOKINGS PAGE'))),
      GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS PAGE'))),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
}

void main() {
  setUp(() => demo.signedIn = true);

  group('models and repo', () {
    test('slot labels and IST maths', () {
      expect(slotLabel('09:00'), '9:00 am');
      expect(slotLabel('12:00'), '12:00 pm');
      expect(slotLabel('16:00'), '4:00 pm');
      expect(slotLabel('00:10'), '12:10 am');
      expect(istToInstant('2026-10-22', '16:00').toIso8601String(), '2026-10-22T10:30:00.000Z');
      expect(isoDay(DateTime(2026, 3, 5)), '2026-03-05');
      expect(parseDay('2026-3-5'), DateTime(2026, 3, 5));
    });

    test('book sends the slug and the UTC instant; the note only when typed', () async {
      final api = FakeApiClient((m, p, q, b) => {'booking': _fanBooking()});
      final bk = await BookingsRepo(api).book('maya', istToInstant('2026-10-22', '16:00'), note: '  hi  ');
      expect(api.calls, ['POST /api/hf/bookings']);
      expect(api.bodies.single, {'hostSlug': 'maya', 'startAt': '2026-10-22T10:30:00.000Z', 'note': 'hi'});
      expect(bk.holdPaise, 20000);
      expect(bk.hostName, 'Maya Rao');
      await BookingsRepo(api).book('maya', istToInstant('2026-10-22', '16:00'));
      expect((api.bodies.last as Map).containsKey('note'), isFalse);
    });

    test('error codes map to problems', () {
      expect(bookingProblemOf(_err(402, 'low_balance')), BookingProblem.lowBalance);
      expect(bookingProblemOf(_err(409, 'slot_unavailable')), BookingProblem.slotTaken);
      expect(bookingProblemOf(_err(409, 'too_late')), BookingProblem.tooLate);
      expect(bookingProblemOf(_err(409, 'slot_booked')), BookingProblem.slotBooked);
      expect(bookingProblemOf(_err(409, 'rate_fixed')), BookingProblem.rateFixed);
    });

    test('availability is saved as date -> {open, slots} with sorted times', () async {
      final api = FakeApiClient((m, p, q, b) => _avail());
      await BookingsRepo(api).saveAvailability({'2026-10-22': const DayPlan(open: true, slots: {'18:00', '10:00'})}, expectedVersion: 3);
      expect(api.calls.single, 'PUT /api/hf/hosts/me/availability');
      expect(api.bodies.single, {
        'expectedVersion': 3,
        'days': {'2026-10-22': {'open': true, 'slots': ['10:00', '18:00']}},
      });
    });
  });

  group('RealBookScreen', () {
    testWidgets('open dates and free times come from the server; a closed day shows the toast', (tester) async {
      final (open, closed) = _twoDays();
      final api = FakeApiClient((m, p, q, b) {
        if (p.endsWith('/slots')) return _slots({isoDay(open): ['10:00', '16:00']});
        return _profile();
      });
      await _pump(tester, RealBookScreen(id: 'maya', day: isoDay(open), repo: BookingsRepo(api), reelsRepo: ReelsRepo(api)));
      await tester.pumpAndSettle();
      expect(api.calls, contains('GET /api/hf/hosts/maya/slots'));
      expect(find.text('Maya Rao'), findsOneWidget);
      expect(find.textContaining('₹20/min'), findsOneWidget);
      // the open day is selected (from the link), so its free times show; nothing else is offered
      expect(find.text('10:00 am'), findsOneWidget);
      expect(find.text('4:00 pm'), findsOneWidget);
      expect(find.text('6:00 pm'), findsNothing);
      await tester.tap(find.text('${closed.day}'));
      await tester.pump();
      expect(find.text('Maya is not taking bookings that day.'), findsOneWidget);
    });

    testWidgets('picking a time enables NEXT and goes to confirm with the IST date and time', (tester) async {
      final (open, _) = _twoDays();
      final api = FakeApiClient((m, p, q, b) => p.endsWith('/slots') ? _slots({isoDay(open): ['10:00', '16:00']}) : _profile());
      await _pump(tester, RealBookScreen(id: 'maya', day: isoDay(open), repo: BookingsRepo(api), reelsRepo: ReelsRepo(api)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('slot-16:00')));
      await tester.pump();
      await tester.tap(find.text('NEXT'));
      await tester.pumpAndSettle();
      expect(find.text('CONFIRM day=${isoDay(open)}&slot=16%3A00'), findsOneWidget);
    });

    testWidgets('a failed load shows Try again', (tester) async {
      var fail = true;
      final api = FakeApiClient((m, p, q, b) => fail ? ApiException.offline() : (p.endsWith('/slots') ? _slots({}) : _profile()));
      await _pump(tester, RealBookScreen(id: 'maya', repo: BookingsRepo(api), reelsRepo: ReelsRepo(api)));
      await tester.pumpAndSettle();
      expect(find.text('You are offline'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.textContaining('has not opened any times yet'), findsWidgets);
    });
  });

  group('RealBookConfirmScreen', () {
    Handler happy({int wallet = 50000, Object? bookResult}) => (m, p, q, b) {
          if (p.endsWith('/slots')) return _slots({'2026-10-22': ['16:00']});
          if (p == '/api/hf/app/wallet') return _wallet(wallet);
          if (p == '/api/hf/bookings' && m == 'POST') return bookResult ?? {'booking': _fanBooking()};
          return _profile();
        };

    Future<FakeApiClient> open(WidgetTester tester, Handler h) async {
      final api = FakeApiClient(h);
      await _pump(tester, RealBookConfirmScreen(id: 'maya', day: '2026-10-22', slot: '16:00', repo: BookingsRepo(api), walletRepo: WalletRepo(api), reelsRepo: ReelsRepo(api)));
      await tester.pumpAndSettle();
      return api;
    }

    testWidgets('shows the real rate, the 10-minute hold and the wallet', (tester) async {
      await open(tester, happy());
      expect(find.text('₹20/min'), findsOneWidget);
      expect(find.text('Held now (10 min)'), findsOneWidget);
      expect(find.text('₹200'), findsOneWidget);
      expect(find.text('₹500'), findsOneWidget);
      expect(find.text('4:00 pm'), findsOneWidget);
    });

    testWidgets('confirm books it and shows BOOKED', (tester) async {
      final api = await open(tester, happy());
      await tester.enterText(find.byType(TextField), 'Trip tips');
      await tester.tap(find.text('CONFIRM BOOKING'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('POST /api/hf/bookings'));
      expect(api.bodies.last, {'hostSlug': 'maya', 'startAt': '2026-10-22T10:30:00.000Z', 'note': 'Trip tips'});
      expect(find.textContaining('BOOKED day=2026-10-22'), findsOneWidget);
    });

    testWidgets('low balance (known up front) goes to top up without calling the server', (tester) async {
      final api = await open(tester, happy(wallet: 5000));
      await tester.tap(find.text('CONFIRM BOOKING'));
      await tester.pumpAndSettle();
      expect(find.text('TOPUP PAGE'), findsOneWidget);
      expect(api.calls.where((c) => c == 'POST /api/hf/bookings'), isEmpty);
    });

    testWidgets('the server saying low_balance also goes to top up, with its message', (tester) async {
      await open(tester, happy(bookResult: _err(402, 'low_balance', 'You need ₹200 in your wallet to hold this booking. Please top up.', {'needPaise': 20000})));
      await tester.tap(find.text('CONFIRM BOOKING'));
      await tester.pumpAndSettle();
      expect(find.text('TOPUP PAGE'), findsOneWidget);
    });

    testWidgets('a time that was just taken shows the message and leaves the page', (tester) async {
      await open(tester, happy(bookResult: _err(409, 'slot_unavailable', 'Someone just took that time. Please pick another.')));
      await tester.tap(find.text('CONFIRM BOOKING'));
      await tester.pumpAndSettle();
      expect(find.text('REELS PAGE'), findsOneWidget);
    });
  });

  group('RealBookingsScreen (fan)', () {
    testWidgets('lists bookings; Cancel shows the server rule and calls DELETE', (tester) async {
      var list = [_fanBooking()];
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'DELETE') {
          list = [];
          return {'ok': true, 'message': 'Booking cancelled. Your hold of ₹200 is back in your wallet.', 'refundPaise': 20000};
        }
        return {'role': 'fan', 'bookings': list};
      });
      await _pump(tester, RealBookingsScreen(repo: BookingsRepo(api)));
      await tester.pumpAndSettle();
      expect(api.queries.first, containsPair('role', 'fan'));
      expect(find.text('Maya Rao'), findsOneWidget);
      expect(find.text('₹200 held · 10 min'), findsOneWidget);
      expect(find.textContaining('4:00 pm'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('cancel-b1')));
      await tester.pumpAndSettle();
      expect(find.text('Cancel this booking?'), findsOneWidget);
      expect(find.textContaining('You can cancel for free until 1 hour before'), findsOneWidget);
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      expect(api.calls, contains('DELETE /api/hf/bookings/b1'));
      expect(find.text('Booking cancelled. Your hold of ₹200 is back in your wallet.'), findsOneWidget);
      expect(find.text('No bookings yet.'), findsOneWidget);
    });

    testWidgets('inside the last hour the dialog explains and nothing is cancelled', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'role': 'fan', 'bookings': [_fanBooking(canCancel: false)]});
      await _pump(tester, RealBookingsScreen(repo: BookingsRepo(api)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cancel-b1')));
      await tester.pumpAndSettle();
      expect(find.text('Too late to cancel'), findsOneWidget);
      expect(find.textContaining('less than 1 hour'), findsOneWidget);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(api.calls.where((c) => c.startsWith('DELETE')), isEmpty);
    });

    testWidgets('empty state', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'role': 'fan', 'bookings': <Object?>[]});
      await _pump(tester, RealBookingsScreen(repo: BookingsRepo(api)));
      await tester.pumpAndSettle();
      expect(find.text('No bookings yet.'), findsOneWidget);
    });
  });

  group('RealInfluencerBookingsScreen', () {
    testWidgets('shows the fan handle and note, never a number; tap, then Cancel refunds', (tester) async {
      final day = isoDay(_today);
      var list = [_hostBooking(day)];
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'DELETE') {
          list = [];
          return {'ok': true, 'message': "Booking cancelled. The fan's hold was refunded in full.", 'refundPaise': 20000};
        }
        return {'role': 'host', 'bookings': list};
      });
      await _pump(tester, RealInfluencerBookingsScreen(repo: BookingsRepo(api)));
      await tester.pumpAndSettle();
      expect(api.queries.first, containsPair('role', 'host'));
      expect(find.text('Ravi'), findsWidgets);
      expect(find.textContaining('Birthday surprise'), findsWidgets);
      await tester.tap(find.text('Ravi').first);
      await tester.pumpAndSettle();
      expect(find.textContaining('Note: Birthday surprise'), findsOneWidget);
      expect(find.textContaining('refunded in full'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('host-cancel')));
      await tester.pumpAndSettle();
      expect(api.calls, contains('DELETE /api/hf/bookings/h1'));
      expect(find.text('No bookings on this day.'), findsOneWidget);
    });

    testWidgets("today's bookings widget lists only what the server returns for today", (tester) async {
      final day = isoDay(_today);
      final api = FakeApiClient((m, p, q, b) => {'role': 'host', 'bookings': [_hostBooking(day)]});
      await _pump(tester, Scaffold(body: RealTodaysBookings(repo: BookingsRepo(api))));
      await tester.pumpAndSettle();
      expect(api.queries.first, containsPair('day', day));
      expect(find.text('Ravi'), findsOneWidget);
    });
  });

  group('RealProfileCalendar', () {
    testWidgets('free times open the booking page with the date and time', (tester) async {
      final (open, _) = _twoDays();
      final api = FakeApiClient((m, p, q, b) => _slots({isoDay(open): ['10:00', '16:00']}));
      await _pump(tester, Scaffold(body: SingleChildScrollView(child: RealProfileCalendar(slug: 'maya', repo: BookingsRepo(api)))));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cal-slot-16:00')));
      await tester.pumpAndSettle();
      expect(find.text('BOOK day=${isoDay(open)}&slot=16%3A00'), findsOneWidget);
    });

    testWidgets('no open times: an honest empty message', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _slots({}));
      await _pump(tester, Scaffold(body: RealProfileCalendar(slug: 'maya', repo: BookingsRepo(api))));
      await tester.pumpAndSettle();
      expect(find.text('No open times yet'), findsOneWidget);
    });
  });
}
