import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';

/// [HF-APP-PARITY-BOOKINGS] The booking shapes the details page and the influencer calendar read.
class _FakeApi extends ApiClient {
  _FakeApi(this.handler) : super(origin: 'https://api.test');

  Object? Function(String method, String path) handler;
  final List<String> calls = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    final out = handler(method, path);
    if (out is ApiException) throw out;
    return out;
  }
}

/// The older detail answer (`GET /api/hf/bookings/:id`), influencer side.
Map<String, Object?> _webHost({String status = 'pending_approval'}) => {
      'id': 'h1',
      'status': status,
      'hostUid': 'u1',
      'customerUid': 'u2',
      'startUtc': '2026-10-24T13:00:00.000Z', // 6:30 pm in India
      'endUtc': '2026-10-24T13:30:00.000Z',
      'reservedPaise': 30000,
      'durationMinutes': 30,
      'canCancel': true,
      'expectedHostNetPaise': 9000,
      'customerHandle': 'Ravi',
      'hostName': 'Maya Rao',
      'hostSlug': 'maya',
    };

Map<String, Object?> _row(String id, String status, String day) => {
      'id': id,
      'status': status,
      'startAt': '${day}T10:30:00.000Z',
      'day': day,
      'time': '16:00',
      'minutes': 10,
      'holdPaise': 20000,
      'fanHandle': 'Ravi',
    };

void main() {
  group('AppBooking reads both server shapes', () {
    test('customerHandle, durationMinutes, startUtc and reservedPaise fill the app fields', () {
      final b = AppBooking.fromJson(_webHost());
      expect(b.fanHandle, 'Ravi');
      expect(b.viewerIsHost, isTrue);
      expect(b.minutes, 30);
      expect(b.holdPaise, 30000);
      expect(b.expectedNetPaise, 9000);
      expect(b.day, '2026-10-24');
      expect(b.time, '18:30');
      expect(indianWhen(b.day, b.time), '24 Oct, 6:30 pm');
      // no accept/decline flags in the older answer: a waiting booking on the influencer's side can be decided
      expect(b.canAccept, isTrue);
      expect(b.canDecline, isTrue);
    });

    test('the app shape wins when both are present', () {
      final b = AppBooking.fromJson({..._row('a', 'confirmed', '2026-10-24'), 'customerHandle': 'Other', 'durationMinutes': 45});
      expect(b.fanHandle, 'Ravi');
      expect(b.minutes, 10);
    });

    test('a confirmed influencer booking from the older shape cannot be accepted', () {
      final b = AppBooking.fromJson(_webHost(status: 'confirmed'));
      expect(b.canAccept, isFalse);
      expect(b.canDecline, isFalse);
    });

    test('a fan booking is not the influencer view', () {
      final b = AppBooking.fromJson({'id': 'f1', 'status': 'confirmed', 'startAt': '2026-10-24T13:00:00Z', 'day': '2026-10-24', 'time': '18:30', 'minutes': 10, 'holdPaise': 100, 'hostName': 'Maya', 'hostSlug': 'maya'});
      expect(b.viewerIsHost, isFalse);
    });
  });

  test('indianWhen writes an Indian date and a 12-hour time', () {
    expect(indianWhen('2026-01-05', '09:05'), '5 Jan, 9:05 am');
    expect(indianWhen('', '16:00'), '4:00 pm');
  });

  group('HostBookingSummary', () {
    test('reads waitingCount and bookedDays from the summary answer', () {
      final s = HostBookingSummary.fromJson({
        'summary': {'waitingCount': 2, 'bookedDays': 3, 'upcomingCount': 4, 'expectedHostNetPaise': 5000}
      });
      expect(s.waitingCount, 2);
      expect(s.bookedDays, 3);
      expect(s.upcomingCount, 4);
      expect(s.expectedNetPaise, 5000);
      expect(s.bookedDaysText, '3 days booked');
      expect(s.waitingText, '2 requests waiting');
    });

    test('says "1 day booked" and "1 request waiting"', () {
      const s = HostBookingSummary(waitingCount: 1, bookedDays: 1);
      expect(s.bookedDaysText, '1 day booked');
      expect(s.waitingText, '1 request waiting');
      expect(const HostBookingSummary(waitingCount: 0, bookedDays: 0).bookedDaysText, '0 days booked');
    });

    test('counts from a list: different days, waiting ones, never finished ones', () {
      final s = HostBookingSummary.fromBookings([
        AppBooking.fromJson(_row('1', 'pending_approval', '2026-10-24')),
        AppBooking.fromJson(_row('2', 'confirmed', '2026-10-24')),
        AppBooking.fromJson(_row('3', 'confirmed', '2026-10-25')),
        AppBooking.fromJson(_row('4', 'cancelled', '2026-10-26')),
        AppBooking.fromJson(_row('5', 'completed', '2026-10-27')),
      ]);
      expect(s.bookedDays, 2);
      expect(s.waitingCount, 1);
      expect(s.upcomingCount, 2);
    });
  });

  group('BookingsRepo', () {
    test('hostSummary asks the summary route and reads the numbers', () async {
      final api = _FakeApi((m, p) => {
            'summary': {'waitingCount': 5, 'bookedDays': 7}
          });
      final s = await BookingsRepo(api).hostSummary();
      expect(api.calls, ['GET /api/hf/bookings/summary']);
      expect(s.waitingCount, 5);
      expect(s.bookedDays, 7);
    });

    test('hostSummary throws on an answer that is not a summary', () async {
      final api = _FakeApi((m, p) => {'bookings': <Object?>[]});
      expect(BookingsRepo(api).hostSummary(), throwsA(isA<ApiException>()));
    });

    test('booking(id) reads the detail answer', () async {
      final api = _FakeApi((m, p) => {'booking': _webHost()});
      final b = await BookingsRepo(api).booking('h1');
      expect(api.calls, ['GET /api/hf/bookings/h1']);
      expect(b.fanHandle, 'Ravi');
      expect(b.minutes, 30);
    });
  });
}
