import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/deep_links.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';
import 'package:hf_app/data/repos/config_repo.dart';

/// [HF-BOOK-APPROVE] The data layer for booking approval: models tolerate old answers, the repo talks to the
/// API contract in Specs/PLAN-2026-10-20-HF-BOOKING-APPROVAL.md section 9b, links open the right place.
class _FakeApi extends ApiClient {
  _FakeApi(this.handler) : super(origin: 'https://api.test');

  Object? Function(String method, String path, Map<String, Object?>? query, Object? body) handler;
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

Map<String, Object?> _pending() => {
      'id': 'b1',
      'status': 'pending_approval',
      'startAt': '2026-10-22T10:30:00.000Z',
      'day': '2026-10-22',
      'time': '16:00',
      'minutes': 10,
      'holdPaise': 20000,
      'canCancel': true,
      'cancelRule': 'You can cancel any time while you wait. Your full hold comes back.',
      'approvalDeadline': '2026-10-21T10:30:00.000Z',
      'topic': {'slug': 'general-advice', 'label': 'General advice'},
      'cancelReason': null,
      'statusText': 'Waiting for Maya to accept — auto-cancels in 17 h',
      'canAccept': true,
      'canDecline': true,
      'fanHandle': 'Ravi',
    };

void main() {
  group('AppBooking', () {
    test('reads the approval fields', () {
      final b = AppBooking.fromJson(_pending());
      expect(b.isPending, isTrue);
      expect(b.approvalDeadline, isNotNull);
      expect(b.topic?.slug, 'general-advice');
      expect(b.topic?.label, 'General advice');
      expect(b.statusText, contains('Waiting for Maya'));
      expect(b.canAccept, isTrue);
      expect(b.canDecline, isTrue);
      expect(b.cancelReason, isNull);
    });

    test('an old answer without the new fields still parses', () {
      final b = AppBooking.fromJson({
        'id': 'b2',
        'status': 'confirmed',
        'startAt': '2026-10-22T10:30:00.000Z',
        'day': '2026-10-22',
        'time': '16:00',
        'holdPaise': 20000,
      });
      expect(b.isPending, isFalse);
      expect(b.isPast, isFalse);
      expect(b.approvalDeadline, isNull);
      expect(b.topic, isNull);
      expect(b.statusText, isNull);
      expect(b.canAccept, isFalse);
      expect(b.canDecline, isFalse);
    });

    test('cancelled and completed are past', () {
      expect(AppBooking.fromJson({..._pending(), 'status': 'cancelled', 'cancelReason': 'not_accepted_24h'}).isPast, isTrue);
      expect(AppBooking.fromJson({..._pending(), 'status': 'completed'}).isPast, isTrue);
    });
  });

  group('HostSlots', () {
    test('reads topics and approval mode', () {
      final s = HostSlots.fromJson({
        'minutes': 10,
        'ratePerMin': 20,
        'holdPaise': 20000,
        'days': {
          '2026-10-22': ['16:00']
        },
        'topics': [
          {'slug': 'just-friendship', 'label': 'Just friendship'},
          {'slug': 'general-advice', 'label': 'General advice'},
        ],
        'approvalMode': 'manual',
      });
      expect(s.topics.map((t) => t.slug), ['just-friendship', 'general-advice']);
      expect(s.approvalMode, 'manual');
      expect(s.needsApproval, isTrue);
    });

    test('without the fields (feature off) there are no topics and no approval', () {
      final s = HostSlots.fromJson({'minutes': 10, 'ratePerMin': 20, 'holdPaise': 20000, 'days': <String, Object?>{}});
      expect(s.topics, isEmpty);
      expect(s.approvalMode, isNull);
      expect(s.needsApproval, isFalse);
    });
  });

  group('labels', () {
    test('countdownLabel', () {
      expect(countdownLabel(const Duration(hours: 17, minutes: 10)), '17 h');
      expect(countdownLabel(const Duration(hours: 2, minutes: 20)), '2 h 20 min');
      expect(countdownLabel(const Duration(minutes: 35)), '35 min');
      expect(countdownLabel(Duration.zero), 'any moment now');
      expect(countdownLabel(const Duration(minutes: -3)), 'any moment now');
    });

    test('startsInLabel', () {
      final now = DateTime(2026, 10, 22, 12);
      expect(startsInLabel(now.add(const Duration(minutes: 25)), now), 'starts in 25 min');
      expect(startsInLabel(now.add(const Duration(hours: 3)), now), 'starts in 3 h');
      expect(startsInLabel(now.add(const Duration(days: 3)), now), 'starts in 3 days');
      expect(startsInLabel(now.subtract(const Duration(minutes: 2)), now), 'starting now');
    });
  });

  group('BookingsRepo', () {
    test('book sends the topic and reads needsApproval / approvalText', () async {
      final api = _FakeApi((m, p, q, b) => {
            'booking': _pending(),
            'needsApproval': true,
            'approvalText': 'Sent to Maya for approval. If not accepted within 24 hours, ₹200 returns to your wallet.',
          });
      final r = await BookingsRepo(api).bookRequest('maya', DateTime.utc(2026, 10, 22, 10, 30), note: ' hi ', topic: 'general-advice');
      expect(r.needsApproval, isTrue);
      expect(r.approvalText, contains('Sent to Maya'));
      expect(r.booking.isPending, isTrue);
      expect(api.calls.single, 'POST /api/hf/bookings');
      final body = api.bodies.single! as Map;
      expect(body['topic'], 'general-advice');
      expect(body['note'], 'hi');
    });

    test('book without the new fields behaves as before', () async {
      final api = _FakeApi((m, p, q, b) => {'booking': _pending()..['status'] = 'confirmed'});
      final r = await BookingsRepo(api).bookRequest('maya', DateTime.utc(2026, 10, 22, 10, 30));
      expect(r.needsApproval, isFalse);
      expect(r.approvalText, isNull);
      expect((api.bodies.single! as Map).containsKey('topic'), isFalse);
    });

    test('accept and decline', () async {
      final api = _FakeApi((m, p, q, b) => p.endsWith('/decline')
          ? {'ok': true, 'refunded': true, 'refundPaise': 20000, 'booking': {..._pending(), 'status': 'cancelled', 'cancelReason': 'declined'}}
          : {'ok': true, 'booking': {..._pending(), 'status': 'confirmed'}});
      final repo = BookingsRepo(api);
      expect((await repo.accept('b1')).status, 'confirmed');
      final d = await repo.decline('b1', reason: ' busy ');
      expect(d.refundPaise, 20000);
      expect(d.booking.cancelReason, 'declined');
      expect(api.calls, ['POST /api/hf/bookings/b1/accept', 'POST /api/hf/bookings/b1/decline']);
      expect((api.bodies[1]! as Map)['reason'], 'busy');
    });

    test('booking settings', () async {
      final api = _FakeApi((m, p, q, b) => {'approval': m == 'PUT' ? 'auto' : 'manual', 'openAlerts': true});
      final repo = BookingsRepo(api);
      expect((await repo.bookingSettings()).isManual, isTrue);
      final saved = await repo.saveBookingSettings(approval: 'auto');
      expect(saved.isManual, isFalse);
      expect(api.calls, ['GET /api/hf/hosts/me/booking-settings', 'PUT /api/hf/hosts/me/booking-settings']);
      expect(api.bodies[1], {'approval': 'auto'});
    });

    test('new error codes', () {
      ApiException err(int status, String code) => ApiException(kind: ApiFailure.http, status: status, code: code);
      expect(bookingProblemOf(err(409, 'too_soon_for_approval')), BookingProblem.tooSoon);
      expect(bookingProblemOf(err(400, 'bad_topic')), BookingProblem.badTopic);
      expect(bookingProblemOf(err(409, 'not_pending')), BookingProblem.notPending);
      expect(bookingProblemOf(err(409, 'expired')), BookingProblem.notPending);
    });
  });

  group('config and links', () {
    test('the approval flag is off unless the server says true', () {
      expect(AppConfig.fromJson(<String, dynamic>{}).bookingApprovalEnabled, isFalse);
      expect(AppConfig.fromJson({'hfBookingApprovalEnabled': true}).bookingApprovalEnabled, isTrue);
      expect(AppConfig.fromJson({'hfBookingApprovalEnabled': 'yes'}).bookingApprovalEnabled, isFalse);
    });

    test('a booking link opens that booking', () {
      const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      final web = linkTargetFor(Uri.parse('https://${Brand.domain}/bookings/$id'));
      expect(web?.location, '/bookings/$id');
      expect(web?.telemetryPath, '/bookings/:id');
      final scheme = linkTargetFor(Uri.parse('${Brand.scheme}://bookings/$id'));
      expect(scheme?.location, '/bookings/$id');
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/bookings/x')), isNull);
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/bookings')), isNull);
    });
  });
}
