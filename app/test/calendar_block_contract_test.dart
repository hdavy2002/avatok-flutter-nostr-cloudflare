// Additive-contract tests for the diary's block payload.
//
// The calendar backend is deployed separately from the app, so a shipped build
// will regularly talk to a backend that does NOT yet send booking_id /
// listing_id / booking_kind / booking_status or the Google readiness fields.
// These tests pin the tolerance rule: missing fields mean "not verifiable",
// never "no booking" and never "healthy".
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/platform_api.dart';
import 'package:avatok_call/features/calendar/calendar_data.dart';
import 'package:avatok_call/features/calendar/calendar_logic.dart';

void main() {
  group('CalBlock tolerates an older deployed backend', () {
    test('a block without additive fields parses with nulls', () {
      final block = CalBlock.fromJson({
        'id': 'b1',
        'source_app': 'availability',
        'source_ref': 'res-1',
        'starts_at': 1000,
        'ends_at': 2000,
        'title': 'Consultation',
      });
      expect(block.bookingId, isNull);
      expect(block.listingId, isNull);
      expect(block.bookingKind, isNull);
      expect(block.bookingStatus, isNull);
      // The legacy fields are untouched.
      expect(block.sourceRef, 'res-1');
      expect(styleFor(block.sourceApp).label, 'Appointment');
    });

    test('the additive fields are read when the backend sends them', () {
      final block = CalBlock.fromJson({
        'id': 'b1',
        'source_app': 'availability',
        'source_ref': 'res-1',
        'starts_at': 1000,
        'ends_at': 2000,
        'title': 'Consultation',
        'booking_id': 'bk-1',
        'listing_id': 'L1',
        'booking_kind': 'consult',
        'booking_status': 'confirmed',
      });
      expect(block.bookingId, 'bk-1');
      expect(block.listingId, 'L1');
      expect(block.bookingKind, 'consult');
      expect(block.bookingStatus, 'confirmed');
      expect(blockStatusLabel(block), 'Confirmed');
    });

    test('empty strings are treated as absent, never as an id to open', () {
      final block = CalBlock.fromJson({
        'id': 'b1',
        'source_app': 'availability',
        'booking_id': '',
        'listing_id': '',
      });
      expect(block.bookingId, isNull);
      expect(block.listingId, isNull);
      expect(bookingRouteForBlock(block).management,
          BookingManagement.creatorAppointments);
    });

    test('the cache round-trips the additive fields without inventing them', () {
      final block = CalBlock('b1', 'availability', 'res-1', 1000, 2000, 'A',
          bookingId: 'bk-1', listingId: 'L1', bookingKind: 'consult');
      final json = block.toJson();
      expect(json.containsKey('booking_id'), isTrue);
      expect(json.containsKey('booking_status'), isFalse);
      final restored = CalBlock.fromJson(json);
      expect(restored.bookingId, 'bk-1');
      expect(restored.bookingStatus, isNull);
    });

    test('an unknown source keeps the neutral "Busy" label', () {
      final block = CalBlock.fromJson({'id': 'b', 'source_app': 'mystery'});
      expect(styleFor(block.sourceApp).label, 'Busy');
      expect(bookingRouteForBlock(block).management, BookingManagement.none);
    });
  });

  group('pre-existing schedule contract stays intact', () {
    test('an exception without end_min keeps the 1440 end of day', () {
      final exception = AvailabilityException.fromJson({
        'id': 'e1',
        'date': '2026-09-18',
        'start_min': 0,
        'status': 'unavailable',
      });
      expect(exception.endMin, 1440);
      expect(exception.isAllDay, isTrue);
    });

    test('a schedule payload keeps every field the app already sent', () {
      final schedule = AvailabilitySchedule.fromJson({
        'listing_id': 'L1',
        'timezone': 'Asia/Kolkata',
        'mode': 'exclusive',
        'duration_min': 45,
        'slot_interval_min': 30,
        'buffer_min': 10,
        'min_notice_min': 120,
        'max_per_day': 4,
        'horizon_days': 30,
        'version': 7,
        'rules': [
          {'weekday': 5, 'start_min': 540, 'end_min': 1020}
        ],
        'exceptions': [
          {
            'id': 'e1',
            'date': '2026-09-18',
            'start_min': 0,
            'end_min': 1440,
            'status': 'unavailable',
          }
        ],
      });
      expect(schedule.listingId, 'L1');
      expect(schedule.timezone, 'Asia/Kolkata');
      expect(schedule.mode, AvailabilityMode.exclusive);
      expect(schedule.durationMin, 45);
      expect(schedule.horizonDays, 30);
      expect(schedule.version, 7);
      expect(schedule.rules.single.weekday, 5);
      expect(schedule.exceptions.single.isAllDay, isTrue);
      final wire = schedule.toJson();
      expect(wire['mode'], 'exclusive');
      expect((wire['exceptions'] as List).first['end_min'], 1440);
    });

    test('a schedule horizon of 62 is preserved, not rewritten to 60/90', () {
      final schedule = AvailabilitySchedule.fromJson({'horizon_days': 62});
      expect(schedule.horizonDays, 62);
      expect(schedule.copyWith().toJson()['horizon_days'], 62);
    });

    test('an out-of-range cached cap/horizon is omitted, never sent as 0', () {
      // Older caches hold max_per_day 0 ("no limit" as it was once advertised)
      // and the model's own default was 90 days. The server refuses both, so an
      // unrelated edit must not be able to fail because of them (A3).
      final legacy =
          AvailabilitySchedule.fromJson({'max_per_day': 0, 'horizon_days': 90});
      final wire = legacy.toJson();
      expect(wire.containsKey('max_per_day'), isFalse);
      expect(wire.containsKey('horizon_days'), isFalse);
      expect(maxPerDayLabel(legacy.maxPerDay), 'Not set');
      expect(validateMaxPerDay(legacy.maxPerDay), isNotNull);
    });
  });

  group('Google status tolerance for the settings screen', () {
    test('only legacy fields present → unavailable and bookings stay paused', () {
      final readiness = gcalReadinessFromStatus({
        'connected': true,
        'connected_at': 1,
        'last_sync_at': 2,
        'last_error': null,
        'calendars': [
          {
            'id': 'cal-1',
            'summary': 'Work',
            'timezone': 'Asia/Kolkata',
            'selected': true,
            'destination': true,
            'last_success_at': 2,
          }
        ],
        'destination_calendar_id': 'cal-1',
      });
      expect(readiness.state, GcalState.unknown);
      expect(readiness.label, 'Status unavailable');
      expect(readiness.pausesBookings, isTrue);
      expect(readiness.calendars.single.destination, isTrue);
    });

    test('a 404 from the sync route is reported as unavailable, not success', () {
      // PlatformResult is the shape PlatformApi.gcalSyncResult() returns; a
      // deployment without POST /api/calendar/gcal/sync answers 404/405 and the
      // settings screen must degrade instead of reporting a healthy sync.
      const unavailable = PlatformResult(404, <String, dynamic>{});
      expect(unavailable.routeUnavailable, isTrue);
      expect(unavailable.ok, isFalse);
      const ok = PlatformResult(200, <String, dynamic>{'ready': true});
      expect(ok.ok, isTrue);
      expect(ok.routeUnavailable, isFalse);
      expect(ok.json['ready'], isTrue);
    });
  });
}
