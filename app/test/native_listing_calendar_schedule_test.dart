// [CAL-TIME-1 2026-09-15] Regression tests for the native listing wizard's
// availability payload (AUDIT-2026-09-15 §1 + the shared contract: horizon <=
// 62 but preserved, end_min = 1440 preserved, unrelated exceptions never
// dropped, atomic reservations untouched).
//
// Pure Dart: no widgets, no network, no plugins — these run in CI (the repo has
// no local toolchain by design).
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/calendar/calendar_data.dart';
import 'package:avatok_call/features/marketplace/native_listing/native_listing_time_model.dart';

AvailabilitySchedule _scheduleFromServer() => AvailabilitySchedule.fromJson(<String, dynamic>{
      'listing_id': 'listing-1',
      'timezone': 'Asia/Kolkata',
      'mode': 'custom',
      'duration_min': 45,
      'slot_interval_min': 30,
      'buffer_min': 15,
      'min_notice_min': 120,
      'max_per_day': 6,
      'horizon_days': 30,
      'version': 7,
      'rules': [
        {'weekday': 1, 'start_min': 540, 'end_min': 1020},
      ],
      'exceptions': [
        {
          'id': 'ex-1',
          'date': '2026-10-02',
          'start_min': 0,
          'end_min': 1440,
          'status': 'unavailable',
        },
        {
          'id': 'ex-2',
          'date': '2026-10-03',
          'start_min': 600,
          'end_min': 660,
          'status': 'reserved',
          'listing_id': 'listing-1',
        },
      ],
    });

void main() {
  group('NativeListingSchedulePlan hydration', () {
    test('opens an edit on the stored mode and weekly windows', () {
      final plan = NativeListingSchedulePlan.fromSchedule(
        _scheduleFromServer(),
        listingTimezone: 'Asia/Kolkata',
      );

      expect(plan.mode, AvailabilityMode.custom);
      expect(plan.rules, hasLength(1));
      expect(plan.rules.single.weekday, 1);
      expect(plan.rules.single.startMin, 540);
      expect(plan.rules.single.endMin, 1020);
    });

    test('a stored schedule round-trips through toJson with its exceptions', () {
      final schedule = _scheduleFromServer();
      final again = AvailabilitySchedule.fromJson(schedule.toJson());

      expect(again.exceptions, hasLength(2));
      expect(again.exceptions.first.id, 'ex-1');
      // end_min = 1440 is END OF DAY, not midnight-to-zero (AUDIT §2).
      expect(again.exceptions.first.endMin, 1440);
      expect(again.exceptions.last.status, AvailabilityExceptionStatus.reserved);
      expect(again.exceptions.last.listingId, 'listing-1');
    });
  });

  group('NativeListingSchedulePlan.applyTo', () {
    test('preserves a deliberate horizon instead of forcing 62', () {
      final base = _scheduleFromServer();
      final saved = NativeListingSchedulePlan(
        mode: AvailabilityMode.custom,
        rules: base.rules,
        listingTimezone: 'Asia/Kolkata',
      ).applyTo(base);

      expect(saved.horizonDays, 30, reason: 'the creator chose 30 days; the web wizard and the dead controller both force 62');
      expect(saved.version, 7, reason: 'the compare-and-swap token must survive');
    });

    test('clamps a horizon the server would refuse, without forcing the max', () {
      final base = _scheduleFromServer().copyWith(horizonDays: 90);
      final saved = NativeListingSchedulePlan(
        mode: AvailabilityMode.shared,
        rules: const <AvailabilityRule>[],
        listingTimezone: 'Asia/Kolkata',
      ).applyTo(base);

      // putSchedule() validates horizon_days 1..62 and 400s anything larger, so
      // an old row is clamped — but a smaller one is never inflated.
      expect(saved.horizonDays, 62);
      expect(
        NativeListingSchedulePlan(
          mode: AvailabilityMode.shared,
          rules: const <AvailabilityRule>[],
          listingTimezone: 'Asia/Kolkata',
        ).applyTo(base.copyWith(horizonDays: 0)).horizonDays,
        1,
      );
    });

    test('never drops unrelated exceptions', () {
      final base = _scheduleFromServer();
      final saved = NativeListingSchedulePlan(
        mode: AvailabilityMode.custom,
        rules: const <AvailabilityRule>[AvailabilityRule(weekday: 5, startMin: 600, endMin: 660)],
        listingTimezone: 'Asia/Kolkata',
      ).applyTo(base);

      expect(saved.exceptions.map((e) => e.id), <String>['ex-1', 'ex-2']);
      expect(saved.exceptions.first.endMin, 1440);
    });

    test('replaces rules only in custom mode', () {
      final base = _scheduleFromServer();
      const replacement = <AvailabilityRule>[AvailabilityRule(weekday: 3, startMin: 600, endMin: 700)];

      final custom = NativeListingSchedulePlan(
        mode: AvailabilityMode.custom,
        rules: replacement,
        listingTimezone: 'Asia/Kolkata',
      ).applyTo(base);
      expect(custom.rules.single.weekday, 3);

      final shared = NativeListingSchedulePlan(
        mode: AvailabilityMode.shared,
        rules: replacement,
        listingTimezone: 'Asia/Kolkata',
      ).applyTo(base);
      expect(shared.mode, AvailabilityMode.shared);
      expect(shared.rules, base.rules, reason: 'switching to the usual hours must not wipe the stored windows');
    });

    test('keeps an existing schedule zone but adopts the listing zone for a new row', () {
      final existing = _scheduleFromServer();
      expect(nativeListingScheduleZone(existing, 'Asia/Tokyo'), 'Asia/Kolkata');

      // version 0 == no row of its own yet (readSchedule returns the shared
      // fallback), so the creator's new choice stands.
      final fresh = _scheduleFromServer().copyWith(version: 0);
      expect(nativeListingScheduleZone(fresh, 'Asia/Tokyo'), 'Asia/Tokyo');
      expect(nativeListingScheduleZone(null, 'Asia/Tokyo'), 'Asia/Tokyo');
    });

    test('carries the policy numbers the wizard does not own', () {
      final saved = NativeListingSchedulePlan(
        mode: AvailabilityMode.exclusive,
        rules: const <AvailabilityRule>[],
        listingTimezone: 'Asia/Kolkata',
      ).applyTo(_scheduleFromServer());

      expect(saved.slotIntervalMin, 30);
      expect(saved.bufferMin, 15);
      expect(saved.minNoticeMin, 120, reason: 'the effective commercial notice stays the server value');
      expect(saved.maxPerDay, 6);
      expect(saved.listingId, 'listing-1');
    });
  });

  group('NativeListingSchedulePlan.validate', () {
    test('custom mode needs at least one window', () {
      final problem = const NativeListingSchedulePlan(
        mode: AvailabilityMode.custom,
        rules: <AvailabilityRule>[],
        listingTimezone: 'Asia/Kolkata',
      ).validate();
      expect(problem, contains('at least one weekly window'));
    });

    test('every window must start before it ends', () {
      final problem = const NativeListingSchedulePlan(
        mode: AvailabilityMode.custom,
        rules: <AvailabilityRule>[AvailabilityRule(weekday: 0, startMin: 700, endMin: 700)],
        listingTimezone: 'Asia/Kolkata',
      ).validate();
      expect(problem, contains('before its end'));
    });

    test('shared and exclusive have no window rule of their own', () {
      expect(
        const NativeListingSchedulePlan(
          mode: AvailabilityMode.shared,
          rules: <AvailabilityRule>[],
          listingTimezone: 'Asia/Kolkata',
        ).validate(),
        isNull,
      );
      expect(
        const NativeListingSchedulePlan(
          mode: AvailabilityMode.exclusive,
          rules: <AvailabilityRule>[],
          listingTimezone: 'Asia/Kolkata',
        ).validate(),
        isNull,
      );
    });
  });

  group('wall-clock handling', () {
    test('a start is read in the LISTING zone, not the phone zone', () {
      // 18:00 in Kolkata is 12:30 UTC. The old `DateTime.tryParse(text)` read it
      // in the device zone, which is how a prod show got the wrong hour.
      final epoch = nativeListingEpochForWallClock(
        wallClock: DateTime(2026, 12, 31, 18, 0),
        timezone: 'Asia/Kolkata',
      );
      expect(epoch, DateTime.utc(2026, 12, 31, 12, 30).millisecondsSinceEpoch);

      expect(
        nativeListingEpochForWallClock(wallClock: DateTime(2026, 12, 31, 18, 0), timezone: 'UTC'),
        DateTime.utc(2026, 12, 31, 18, 0).millisecondsSinceEpoch,
      );
    });

    test('a DST gap is reported instead of silently shifted', () {
      // 02:30 on 2026-03-08 does not exist in New York.
      expect(
        nativeListingEpochForWallClock(wallClock: DateTime(2026, 3, 8, 2, 30), timezone: 'America/New_York'),
        isNull,
      );
    });

    test('the stored wall clock round-trips', () {
      final parsed = nativeListingParseLocal('2026-12-31T18:00');
      expect(parsed, isNotNull);
      expect(nativeListingLocalInput(parsed!), '2026-12-31T18:00');
      expect(nativeListingParseLocal(''), isNull);
      expect(nativeListingParseLocal(null), isNull);
    });

    test('end of day stays 24:00 and is not midnight', () {
      expect(nativeListingClockLabel(1440), '24:00');
      expect(nativeListingClockLabel(0), '00:00');
      expect(nativeListingClockLabel(545), '09:05');
    });

    test('a window carries a signature that changes when the time does', () {
      const window = NativeListingWindow(startAt: 1000, endAt: 61000, timezone: 'UTC');
      expect(window.durationMin, 1);
      expect(window.signature, '1000:61000:UTC');
      expect(
        window.signature ==
            const NativeListingWindow(startAt: 1000, endAt: 62000, timezone: 'UTC').signature,
        isFalse,
      );
    });
  });
}
