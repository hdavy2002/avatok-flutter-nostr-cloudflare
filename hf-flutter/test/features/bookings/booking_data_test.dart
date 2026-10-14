import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/features/bookings/data/hf_booking_models.dart';
import 'package:hf_app/features/bookings/data/hf_bookings_providers.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

class SwitchingBookingSession extends StubSession {
  SwitchingBookingSession(String uid)
    : super(SessionState(status: SessionStatus.signedIn, user: ClerkUser(id: uid)));

  void use(String uid) {
    state = SessionState(status: SessionStatus.signedIn, user: ClerkUser(id: uid));
  }
}

void main() {
  test('booking feature flag defaults fail closed and parses public config', () {
    expect(HfFlags.unknown.hfBookingsEnabled, isFalse);
    expect(HfFlags.fromJson({'hfBookingsEnabled': true}).hfBookingsEnabled, isTrue);
  });

  test('schedule and booking dates retain UTC instants and schedule versions', () {
    final schedule = BookingSchedule.fromJson({
      'schedule': {
        'timezone': 'Asia/Kolkata',
        'version': 8,
        'durationsMinutes': [15, 30],
        'slotIntervalMinutes': 15,
        'bufferMinutes': 10,
        'minNoticeMinutes': 120,
        'horizonDays': 60,
        'rules': [
          {'weekday': 2, 'startMin': 540, 'endMin': 720},
          {'weekday': 0, 'startMin': 600, 'endMin': 660},
        ],
        'exceptions': [{'date': '2026-10-20', 'status': 'unavailable', 'startMin': 0, 'endMin': 1440}],
      },
    });
    expect(schedule.version, 8);
    expect(schedule.rules.first.weekday, 2);
    expect(schedule.rules.last.weekday, 7);
    expect(schedule.rules.last.toJson()['weekday'], 0);
    expect(schedule.exceptions.single.date, '2026-10-20');
    expect(schedule.exceptions.single.toJson()['startMin'], 0);
    expect(schedule.exceptions.single.toJson()['endMin'], 1440);

    final booking = BookingRecord.fromJson({
      'booking': {
        'id': 'booking-1',
        'status': 'confirmed',
        'startUtc': '2026-10-20T04:30:00Z',
        'endUtc': '2026-10-20T05:00:00Z',
        'hostTimezone': 'Asia/Kolkata',
        'reservedPaise': 30000,
        'expectedHostNetPaise': 12000,
      },
      'canStart': true,
      'canCancel': true,
    });
    expect(booking.startUtc, DateTime.utc(2026, 10, 20, 4, 30));
    expect(booking.endUtc, DateTime.utc(2026, 10, 20, 5));
    expect(booking.canStart, isTrue);
    expect(booking.canCancel, isTrue);
    expect(booking.expectedHostNetPaise, 12000);
  });

  test('account switch invalidates active booking list state', () async {
    final session = SwitchingBookingSession('account-a');
    final api = FakeApiClient()
      ..on('GET', '/api/hf/bookings', (_) => {
        'bookings': [{
          'id': session.state.user!.id,
          'status': 'confirmed',
          'startUtc': '2026-10-20T04:30:00Z',
          'endUtc': '2026-10-20T05:00:00Z',
        }],
      });
    final container = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => session),
      apiClientProvider.overrideWithValue(api),
    ]);
    addTearDown(container.dispose);
    final subscription = container.listen(hostBookingsProvider, (_, __) {});
    addTearDown(subscription.close);

    final first = await container.read(hostBookingsProvider.future);
    expect(first.single.id, 'account-a');
    session.use('account-b');
    for (var i = 0; i < 6; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    final second = await container.read(hostBookingsProvider.future);
    expect(second.single.id, 'account-b');
    expect(api.callsTo('GET', '/api/hf/bookings'), hasLength(2));
  });
}
