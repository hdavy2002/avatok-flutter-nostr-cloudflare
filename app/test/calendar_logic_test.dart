// Regression tests for the creator-calendar audit fixes of 15 September 2026.
//
// These cover findings 2–10 / 12 and the phone findings A1–A8 through the pure
// decision layer (lib/features/calendar/calendar_logic.dart) plus the additive
// wire fields on CalBlock. Nothing here needs an emulator, a network or a live
// backend, so CI can run the whole set.
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/calendar/calendar_data.dart';
import 'package:avatok_call/features/calendar/calendar_logic.dart';

void main() {
  group('A4/A5 — view defaults and arrow navigation', () {
    test('a phone opens on Agenda and a wide window on Month', () {
      expect(defaultCalendarView(wide: false), CalendarView.agenda);
      expect(defaultCalendarView(wide: true), CalendarView.month);
    });

    test('month view moves the month and keeps the selected day in range', () {
      final nav = calendarNavigate(
        view: CalendarView.month,
        direction: 1,
        selected: DateTime(2026, 1, 31),
        month: DateTime(2026, 1, 1),
      );
      expect(nav.month, DateTime(2026, 2, 1));
      expect(nav.selected, DateTime(2026, 2, 28));
      expect(calendarRangeLabel(
              view: CalendarView.month, month: nav.month, selected: nav.selected),
          'Feb 2026');
    });

    test('week view moves the selected date by a week and the month with it', () {
      final nav = calendarNavigate(
        view: CalendarView.week,
        direction: 1,
        selected: DateTime(2026, 9, 13),
        month: DateTime(2026, 9, 1),
      );
      expect(nav.selected, DateTime(2026, 9, 20));
      expect(nav.month, DateTime(2026, 9, 1));
      expect(
          calendarRangeLabel(
              view: CalendarView.week,
              month: nav.month,
              selected: nav.selected),
          '14–20 Sep 2026');
    });

    test('agenda arrows move one day and cross month boundaries', () {
      final nav = calendarNavigate(
        view: CalendarView.agenda,
        direction: 1,
        selected: DateTime(2026, 9, 30),
        month: DateTime(2026, 9, 1),
      );
      expect(nav.selected, DateTime(2026, 10, 1));
      expect(nav.month, DateTime(2026, 10, 1));
      expect(
          calendarRangeLabel(
              view: CalendarView.agenda, month: nav.month, selected: nav.selected),
          'Thu 1 Oct 2026');
    });

    test('startOfWeek uses a Monday-first week', () {
      expect(startOfWeek(DateTime(2026, 9, 15)), DateTime(2026, 9, 14));
      expect(startOfWeek(DateTime(2026, 9, 14)), DateTime(2026, 9, 14));
    });
  });

  group('findings 2/3 and A8 — multiple intervals, all day, day edits', () {
    final lunch = AvailabilityException(
      id: 'e1',
      date: '2026-09-18',
      startMin: 13 * 60,
      endMin: 14 * 60,
      status: AvailabilityExceptionStatus.unavailable,
    );
    final pickup = AvailabilityException(
      id: 'e2',
      date: '2026-09-18',
      startMin: 16 * 60,
      endMin: 17 * 60,
      status: AvailabilityExceptionStatus.unavailable,
    );
    final otherDay = AvailabilityException(
      id: 'e3',
      date: '2026-09-19',
      startMin: 9 * 60,
      endMin: 10 * 60,
      status: AvailabilityExceptionStatus.available,
    );

    test('every interval on a date is returned, in time order', () {
      final rows = exceptionsOnDate([pickup, otherDay, lunch], '2026-09-18');
      expect(rows.map((e) => e.id).toList(), ['e1', 'e2']);
    });

    test('editing one interval keeps the other interval and other dates', () {
      final edited = pickup.copyWith(status: AvailabilityExceptionStatus.reserved);
      final next = upsertException([lunch, pickup, otherDay], edited,
          replacingId: pickup.id);
      expect(next.length, 3);
      expect(exceptionsOnDate(next, '2026-09-18').map((e) => e.id).toList(),
          ['e1', 'e2']);
      expect(exceptionsOnDate(next, '2026-09-18').last.status,
          AvailabilityExceptionStatus.reserved);
      expect(exceptionsOnDate(next, '2026-09-19').single.id, 'e3');
    });

    test('adding an interval does not replace the existing one', () {
      final added = AvailabilityException(
        id: '',
        date: '2026-09-18',
        startMin: 12 * 60 + 30,
        endMin: 12 * 60 + 45,
        status: AvailabilityExceptionStatus.unavailable,
      );
      final next = upsertException([lunch, pickup], added);
      expect(exceptionsOnDate(next, '2026-09-18').length, 3);
    });

    test('removing one interval leaves the rest untouched', () {
      final next = removeException([lunch, pickup, otherDay], 'e1');
      expect(exceptionsOnDate(next, '2026-09-18').single.id, 'e2');
      expect(exceptionsOnDate(next, '2026-09-19').single.id, 'e3');
    });

    test('"use normal hours" clears one date only', () {
      final next = clearDateExceptions([lunch, pickup, otherDay], '2026-09-18');
      expect(exceptionsOnDate(next, '2026-09-18'), isEmpty);
      expect(exceptionsOnDate(next, '2026-09-19').single.id, 'e3');
    });

    test('saving a day replaces just that day and preserves the others', () {
      final next = replaceDateExceptions([lunch, otherDay], '2026-09-18', [pickup]);
      expect(exceptionsOnDate(next, '2026-09-18').single.id, 'e2');
      expect(exceptionsOnDate(next, '2026-09-19').single.id, 'e3');
    });

    test('a holiday range expands to whole days, inclusive', () {
      final rows = holidayRangeExceptions(
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 24),
      );
      expect(rows.length, 5);
      expect(rows.first.date, '2026-09-20');
      expect(rows.last.date, '2026-09-24');
      expect(rows.every((e) => e.isAllDay), isTrue);
      expect(rows.every((e) => e.status == AvailabilityExceptionStatus.unavailable),
          isTrue);
    });

    test('a merged holiday range never drops unrelated exceptions', () {
      final merged = mergeExceptions(
        [lunch, otherDay],
        holidayRangeExceptions(
            from: DateTime(2026, 9, 20), to: DateTime(2026, 9, 21)),
      );
      expect(merged.length, 4);
      expect(merged.where((e) => e.id == 'e1').length, 1);
      expect(merged.where((e) => e.id == 'e3').length, 1);
    });

    test('end of day is minute 1440 and all-day is detected', () {
      final allDay = AvailabilityException.fromJson({
        'id': 'x',
        'date': '2026-09-18',
        'start_min': 0,
        'end_min': 1440,
        'status': 'unavailable',
      });
      expect(allDay.isAllDay, isTrue);
      expect(allDay.toJson()['end_min'], 1440);
      expect(minutesRangeLabel(0, 1440), 'All day');
      expect(minutesRangeLabel(13 * 60, 14 * 60), '13:00–14:00');
    });

    test('legacy midnight-to-midnight rows still read as whole days', () {
      final legacy = AvailabilityException.fromJson({
        'id': 'y',
        'date': '2026-09-18',
        'start_min': 0,
        'end_min': 0,
        'status': 'unavailable',
      });
      expect(legacy.looksLikeMidnightToMidnight, isTrue);
      expect(
          exceptionLabel(legacy, listingTitle: (_) => 'listing'), "I'm busy · All day");
    });

    test('midnight as an end time is rejected — All day is the explicit control',
        () {
      expect(isValidMinuteRange(13 * 60, 0), isFalse);
      expect(isValidMinuteRange(0, 1440), isTrue);
      expect(isValidMinuteRange(9 * 60, 17 * 60), isTrue);
    });

    test('the 100-exception ceiling is enforced before saving', () {
      final rows = List<AvailabilityException>.generate(
          101,
          (i) => AvailabilityException(
                id: 'e$i',
                date: '2026-09-18',
                startMin: i,
                endMin: i + 1,
                status: AvailabilityExceptionStatus.unavailable,
              ));
      expect(validateExceptionCount(rows.length), isNotNull);
      expect(validateExceptionCount(100), isNull);
    });
  });

  group('A3 / finding 10 — policy numbers and timezone validation', () {
    test('maximum per day accepts 1..100 and never 0', () {
      expect(validateMaxPerDay(null), isNotNull);
      expect(validateMaxPerDay(0), isNotNull);
      expect(validateMaxPerDay(-3), isNotNull);
      expect(validateMaxPerDay(1), isNull);
      expect(validateMaxPerDay(100), isNull);
      expect(validateMaxPerDay(101), isNotNull);
      expect(maxPerDayLabel(0), 'Not set');
      expect(maxPerDayLabel(8), '8 per day');
    });

    test('the horizon keeps the supported 1..62 range', () {
      expect(validateHorizonDays(0), isNotNull);
      expect(validateHorizonDays(62), isNull);
      expect(validateHorizonDays(63), isNotNull);
      expect(kMaxHorizonDays, 62);
    });

    test('the other policy fields reject values the server refuses', () {
      expect(validateDurationMinutes(4), isNotNull);
      expect(validateDurationMinutes(60), isNull);
      expect(validateSlotIntervalMinutes(241), isNotNull);
      expect(validateBufferMinutes(0), isNull);
      expect(validateBufferMinutes(241), isNotNull);
      expect(validateNoticeMinutes(43200), isNull);
    });

    test('the timezone must be a real IANA name', () {
      expect(validateTimezone('Asia/Kolkata'), isNull);
      expect(validateTimezone('UTC'), isNull);
      expect(validateTimezone('IST'), isNotNull);
      expect(validateTimezone(''), isNotNull);
    });
  });

  group('A7 / finding 4 — availability is never fabricated as zero', () {
    test('an unknown count is a dash, not zero', () {
      expect(availabilityCountLabel(null), '—');
      expect(availabilityCountLabel(0), '0 open');
      expect(availabilityCountLabel(4), '4 open');
    });

    test('without a selected listing the week says so instead of "0 open"', () {
      expect(weekAvailabilityLabel(availableCount: null, listingSelected: false),
          'Select a listing');
      expect(weekAvailabilityLabel(availableCount: 3, listingSelected: true),
          '3 open');
      expect(availabilityHint(listingSelected: false), contains('unknown'));
    });
  });

  group('finding 7 — one card per booking', () {
    test('blocks sharing a booking id collapse into one span', () {
      final rows = dedupeBookingBlocks([
        CalBlock('b1', 'availability', 'r1', 1000, 2000, 'Consultation',
            bookingId: 'bk1', listingId: 'L1', bookingStatus: 'confirmed'),
        CalBlock('b2', 'availability', 'r1', 2000, 3000, null,
            bookingId: 'bk1', listingId: 'L1', bookingStatus: 'confirmed'),
        CalBlock('b3', 'gcal', 'g1', 5000, 6000, 'Dentist'),
      ]);
      expect(rows.length, 2);
      expect(rows.first.bookingId, 'bk1');
      expect(rows.first.startsAt, 1000);
      expect(rows.first.endsAt, 3000);
      expect(rows.first.title, 'Consultation');
      expect(rows.last.id, 'b3');
    });

    test('blocks without a booking id are never merged', () {
      final rows = dedupeBookingBlocks([
        CalBlock('b1', 'manual', null, 1000, 2000, 'Busy'),
        CalBlock('b2', 'manual', null, 1500, 2500, 'Busy'),
      ]);
      expect(rows.length, 2);
    });
  });

  group('A1 — modern bookings route to their own management screen', () {
    CalBlock block({
      String source = 'availability',
      String? bookingId,
      String? listingId,
      String? kind,
      String? status,
      String? ref,
    }) =>
        CalBlock('b', source, ref, 1000, 2000, 'Consultation',
            bookingId: bookingId,
            listingId: listingId,
            bookingKind: kind,
            bookingStatus: status);

    test('a modern reservation opens the creator appointment screen', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'bk1', listingId: 'L1', kind: 'consult'),
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.creatorAppointments);
      expect(route.listingId, 'L1');
      expect(route.actionLabel, 'Manage appointment');
    });

    test('a purchase on someone else\u2019s listing opens my sessions', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'bk2', listingId: 'L9', kind: 'consult'),
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.customerSessions);
      expect(route.bookingId, 'bk2');
    });

    test('a live event opens the creator events screen', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'ev1', listingId: 'L1', kind: 'live'),
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.creatorEvents);
    });

    test('legacy avabooking rows keep their booking id and legacy actions', () {
      final route = bookingRouteForBlock(
          block(source: 'avabooking', ref: 'legacy-7', status: 'confirmed'));
      expect(route.management, BookingManagement.legacy);
      expect(route.bookingId, 'legacy-7');
    });

    test('google and manual blocks have no management action', () {
      expect(bookingRouteForBlock(CalBlock('b', 'gcal', 'g1', 1, 2, 'Busy'))
          .management, BookingManagement.none);
      expect(bookingRouteForBlock(CalBlock('b', 'manual', null, 1, 2, 'Busy'))
          .management, BookingManagement.none);
      expect(
          bookingRouteForBlock(CalBlock('b', 'avalive', 'x', 1, 2, 'Live'))
              .management,
          BookingManagement.creatorEvents);
    });

    test('status text never claims a confirmation the server did not send', () {
      expect(blockStatusLabel(block(bookingId: 'bk1', status: 'confirmed')),
          'Confirmed');
      expect(blockStatusLabel(block(bookingId: 'bk1', status: 'held')),
          'Held — not confirmed yet');
      expect(blockStatusLabel(block(bookingId: 'bk1')), 'Status unavailable');
      expect(blockStatusLabel(CalBlock('b', 'manual', null, 1, 2, 'Busy')),
          'Busy time');
    });
  });

  group('findings 5/6 — Google readiness is never over-stated', () {
    Map<String, dynamic> calendar({
      String id = 'cal-1',
      bool selected = true,
      bool destination = false,
      int? lastSuccessAt,
      String? lastError,
    }) =>
        {
          'id': id,
          'summary': id,
          'timezone': 'Asia/Kolkata',
          'selected': selected,
          'destination': destination,
          'primary': false,
          'last_success_at': lastSuccessAt,
          'last_error': lastError,
        };

    test('an older backend without ready/reason is "Status unavailable"', () {
      final readiness = gcalReadinessFromStatus({
        'connected': true,
        'last_sync_at': 1000,
        'calendars': [calendar(lastSuccessAt: 1000)],
      });
      expect(readiness.state, GcalState.unknown);
      expect(readiness.isReady, isFalse);
      expect(readiness.pausesBookings, isTrue);
      expect(readiness.label, 'Status unavailable');
    });

    test('a missing status payload is unknown, not healthy', () {
      final readiness = gcalReadinessFromStatus(null);
      expect(readiness.state, GcalState.unknown);
      expect(readiness.pausesBookings, isTrue);
    });

    test('disconnected explains that customers cannot book yet', () {
      final readiness = gcalReadinessFromStatus({'connected': false});
      expect(readiness.state, GcalState.notConnected);
      expect(readiness.pausesBookings, isTrue);
      expect(readiness.detail, contains('cannot book'));
    });

    test('ready needs a verifiable last successful sync', () {
      final now = DateTime(2026, 9, 15, 12);
      final ready = gcalReadinessFromStatus({
        'connected': true,
        'ready': true,
        'reason': null,
        'last_success_at': now.subtract(const Duration(minutes: 5)).millisecondsSinceEpoch,
        'destination_calendar_id': 'cal-1',
        'calendars': [
          calendar(
              destination: true,
              lastSuccessAt: now
                  .subtract(const Duration(minutes: 5))
                  .millisecondsSinceEpoch)
        ],
      }, now: now);
      expect(ready.state, GcalState.ready);
      expect(ready.isReady, isTrue);
      expect(ready.pausesBookings, isFalse);

      // "ready" with no sync time at all cannot be verified either.
      final unverifiable = gcalReadinessFromStatus({
        'connected': true,
        'ready': true,
        'calendars': const [],
      }, now: now);
      expect(unverifiable.state, GcalState.unknown);
      expect(unverifiable.isReady, isFalse);
    });

    test('one stale selected calendar downgrades a headline "ready"', () {
      final now = DateTime(2026, 9, 15, 12);
      final readiness = gcalReadinessFromStatus({
        'connected': true,
        'ready': true,
        'last_success_at': now.millisecondsSinceEpoch,
        'calendars': [
          calendar(
              id: 'fresh',
              lastSuccessAt: now.millisecondsSinceEpoch),
          calendar(
              id: 'stale',
              lastSuccessAt:
                  now.subtract(const Duration(hours: 3)).millisecondsSinceEpoch),
        ],
      }, now: now);
      expect(readiness.state, GcalState.needsAttention);
      expect(readiness.detail, contains('stale'));
      expect(readiness.isReady, isFalse);
    });

    test('a selected calendar with an error is surfaced by name', () {
      final now = DateTime(2026, 9, 15, 12);
      final readiness = gcalReadinessFromStatus({
        'connected': true,
        'ready': true,
        'last_success_at': now.millisecondsSinceEpoch,
        'calendars': [
          calendar(
              id: 'broken',
              lastSuccessAt: now.millisecondsSinceEpoch,
              lastError: 'Google calendar was deleted or access was revoked')
        ],
      }, now: now);
      expect(readiness.state, GcalState.needsAttention);
      expect(readiness.detail, contains('broken'));
    });

    test('each reason maps to a distinct state and explanation', () {
      final pending = gcalReadinessFromStatus(
          {'connected': true, 'ready': false, 'reason': 'pending'});
      expect(pending.state, GcalState.syncing);
      expect(pending.pausesBookings, isTrue);

      final stale = gcalReadinessFromStatus(
          {'connected': true, 'ready': false, 'reason': 'stale'});
      expect(stale.state, GcalState.needsAttention);
      expect(stale.detail, contains('out of date'));

      final noneSelected = gcalReadinessFromStatus(
          {'connected': true, 'ready': false, 'reason': 'no_selected_calendars'});
      expect(noneSelected.state, GcalState.needsAttention);
      expect(noneSelected.detail, contains('No Google calendar is selected'));

      final error = gcalReadinessFromStatus({
        'connected': true,
        'ready': false,
        'reason': 'error',
        'last_error': 'token expired',
      });
      expect(error.state, GcalState.needsAttention);
      expect(error.detail, 'token expired');
    });

    test('per-calendar rows keep selection, destination and sync detail', () {
      final readiness = gcalReadinessFromStatus({
        'connected': true,
        'ready': false,
        'reason': 'pending',
        'destination_calendar_id': 'cal-2',
        'calendars': [
          calendar(id: 'cal-1'),
          calendar(id: 'cal-2', destination: true, selected: true),
          calendar(id: 'cal-3', selected: false),
        ],
      });
      expect(readiness.calendars.length, 3);
      expect(readiness.selectedCalendars.map((c) => c.id).toList(),
          ['cal-1', 'cal-2']);
      expect(readiness.calendars[1].destination, isTrue);
      expect(readiness.calendars[2].selected, isFalse);
      expect(readiness.destinationCalendarId, 'cal-2');
    });
  });

  group('finding 8 — one explicit schedule timezone', () {
    test('day bounds follow the schedule timezone, not the device', () {
      final bounds = dayBoundsUtcMs(DateTime(2026, 9, 15), 'Asia/Kolkata');
      expect(bounds, isNotNull);
      // 00:00 in IST is 18:30 UTC of the previous day.
      expect(DateTime.fromMillisecondsSinceEpoch(bounds!.from, isUtc: true),
          DateTime.utc(2026, 9, 14, 18, 30));
      expect(bounds.to - bounds.from, const Duration(days: 1).inMilliseconds);
    });

    test('an unknown timezone degrades instead of throwing', () {
      expect(dayBoundsUtcMs(DateTime(2026, 9, 15), 'Not/AZone'), isNull);
    });

    test('clock ranges render in the schedule timezone and are labelled', () {
      final start = DateTime.utc(2026, 9, 15, 13).millisecondsSinceEpoch;
      final end = DateTime.utc(2026, 9, 15, 14).millisecondsSinceEpoch;
      expect(clockRangeInZone(start, end, 'Asia/Kolkata'), '18:30–19:30');
      expect(timezoneLabel('Asia/Kolkata'), 'Times in Asia/Kolkata');
      expect(timezoneLabel(null), 'Timezone unknown');
      expect(deviceTimeLabel(start), startsWith('Your device:'));
    });

    test('a whole-day block reads as "All day" in any timezone', () {
      final bounds = dayBoundsUtcMs(DateTime(2026, 9, 15), 'Asia/Kolkata')!;
      expect(
          blockTimeLabel(
              startMs: bounds.from, endMs: bounds.to, timezone: 'Asia/Kolkata'),
          'All day');
    });

    test('the freshness line never implies a successful refresh', () {
      expect(updatedAtLabel(null), 'Not updated yet');
      expect(updatedAtLabel(DateTime(2026, 9, 15, 9, 5)), 'Updated 09:05');
    });
  });

  group('finding 9 — display filter and edit scope are separate', () {
    test('the scope label names the listing being edited', () {
      expect(
          editingScopeLabel(selectedListingId: null, listings: const []),
          'Editing: all listings');
      expect(blockScopeLabel(listingScoped: false),
          'All listings (personal busy time)');
      expect(blockScopeLabel(listingScoped: true, listingTitle: '1:1'),
          'Only this listing (1:1)');
    });
  });
}
