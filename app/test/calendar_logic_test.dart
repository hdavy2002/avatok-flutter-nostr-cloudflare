// Regression tests for the creator-calendar audit fixes of 15 September 2026.
//
// These cover findings 2–10 / 12 and the phone findings A1–A8 through the pure
// decision layer (lib/features/calendar/calendar_logic.dart) plus the additive
// wire fields on CalBlock. Nothing here needs an emulator, a network or a live
// backend, so CI can run the whole set.
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/listings_api.dart';
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

  group('A1 / review-4 — the SERVER role decides the management route', () {
    CalBlock block({
      String source = 'availability',
      String? bookingId,
      String? listingId,
      String? kind,
      String? status,
      String? role,
      String? ref,
    }) =>
        CalBlock('b', source, ref, 1000, 2000, 'Consultation',
            bookingId: bookingId,
            listingId: listingId,
            bookingKind: kind,
            bookingStatus: status,
            bookingRole: role);

    test('role=creator opens the creator appointment screen', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'bk1', listingId: 'L1', kind: 'consult',
              role: 'creator'));
      expect(route.management, BookingManagement.creatorAppointments);
      expect(route.listingId, 'L1');
      expect(route.actionLabel, 'Manage appointment');
    });

    test('role=creator opens the creator events screen for a live event', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'ev1', listingId: 'L1', kind: 'live',
              role: 'creator'));
      expect(route.management, BookingManagement.creatorEvents);
    });

    test('a purchase opens my sessions only when the server says customer', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'bk2', listingId: 'L9', kind: 'consult',
              role: 'customer'),
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.customerSessions);
      expect(route.bookingId, 'bk2');
    });

    test('personal availability busy blocks do not open commercial management',
        () {
      final personalBusy = block(
        bookingId: null,
        listingId: null,
        kind: 'block',
        role: 'creator',
      );

      final route = bookingRouteForBlock(personalBusy);

      expect(route.management, BookingManagement.none);
      expect(blockSourceLabel(personalBusy), 'Blocked time');
    });

    test('a PURCHASED live event never opens the creator event console', () {
      final route = bookingRouteForBlock(
          block(source: 'avalive', bookingId: 'ev9', listingId: 'L9',
              kind: 'live', role: 'customer'),
          // Even when the creator owns other listings, a bought event is not
          // theirs to manage as a creator.
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.customerSessions);
      expect(route.isEvent, isFalse);
    });

    test('an unknown role with an incomplete listing fetch claims no ownership',
        () {
      // The listings request failed (empty set) — old code read that as "not
      // mine" for a foreign listing and as "mine" for a known one.
      final route = bookingRouteForBlock(
          block(bookingId: 'bk1', listingId: 'L1', kind: 'consult'),
          ownedListingIds: const <String>{});
      expect(route.management, BookingManagement.review);
      expect(route.actionLabel, 'Review this booking');
    });

    test('an unknown role on an event does not claim the creator console', () {
      expect(
          bookingRouteForBlock(
                  block(source: 'avalive', bookingId: 'ev1', kind: 'live'))
              .management,
          BookingManagement.review);
      expect(
          bookingRouteForBlock(CalBlock('b', 'avalive', 'x', 1, 2, 'Live'))
              .management,
          BookingManagement.review);
    });

    test('positive ownership evidence still opens creator appointments', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'bk1', listingId: 'L1', kind: 'consult'),
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.creatorAppointments);
    });

    test('a listing that is not in a loaded list is not assumed foreign', () {
      final route = bookingRouteForBlock(
          block(bookingId: 'bk2', listingId: 'L9', kind: 'consult'),
          ownedListingIds: {'L1'});
      expect(route.management, BookingManagement.review);
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
    });

    test('schedule-zone date labels match the primary schedule-zone time', () {
      final epoch = DateTime.utc(2026, 1, 1, 23, 30).millisecondsSinceEpoch;

      expect(blockDateLabel(epochMs: epoch, timezone: 'UTC'), '1 Jan 2026');
      expect(blockDateLabel(epochMs: epoch, timezone: 'Asia/Kolkata'),
          '2 Jan 2026');
      expect(
        blockTimeLabel(
            startMs: epoch,
            endMs: epoch + const Duration(minutes: 30).inMilliseconds,
            timezone: 'Asia/Kolkata'),
        '05:00–05:30',
      );
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
      // The helper's parameter is `List<ListingCard>`, so this pins the
      // cross-file type the CI analyzer once failed to resolve (the import in
      // calendar_logic.dart is what makes this call compile at all).
      final listing = ListingCard.fromJson(const <String, dynamic>{
        'id': 'L1',
        'title': '1:1 Consult',
      });
      expect(editingScopeLabel(selectedListingId: 'L1', listings: [listing]),
          'Editing: 1:1 Consult');
      expect(
          editingScopeLabel(selectedListingId: 'L404', listings: [listing]),
          'Editing: this listing');
    });
  });

  group('review-1 — a day edit never transplants another scope\'s rows', () {
    AvailabilityException row(String id, String date, int start, int end,
            {AvailabilityExceptionStatus status =
                AvailabilityExceptionStatus.unavailable,
            String? listingId}) =>
        AvailabilityException(
            id: id,
            date: date,
            startMin: start,
            endMin: end,
            status: status,
            listingId: listingId);

    test('a delta from the listing scope keeps every global interval', () {
      // Global schedule holds a break on the same date plus an unrelated day.
      final global = [
        row('g1', '2026-09-18', 13 * 60, 14 * 60),
        row('g2', '2026-09-19', 9 * 60, 10 * 60),
      ];
      // The creator was filtered to a listing, switched the sheet to "All
      // listings" and added one busy block there.
      final delta = DayEditDelta(
        date: '2026-09-18',
        added: [row('local:1', '2026-09-18', 9 * 60, 17 * 60)],
      );
      final applied = applyDayEditDelta(global, delta);
      expect(applied.skippedIds, isEmpty);
      expect(applied.exceptions.length, 3);
      expect(applied.exceptions.where((e) => e.id == 'g1').single.endMin,
          14 * 60);
      expect(applied.exceptions.where((e) => e.id == 'g2').single.date,
          '2026-09-19');
      final added = applied.exceptions.where((e) => e.id.isEmpty).toList();
      expect(added.length, 1);
      expect(added.single.startMin, 9 * 60);
    });

    test('listing-only rows are never copied into the global schedule', () {
      final global = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final listingOnly = [
        row('l1', '2026-09-18', 16 * 60, 17 * 60, status:
            AvailabilityExceptionStatus.reserved, listingId: 'L1'),
      ];
      // The listing's rows were shown while the scope said "All listings"; the
      // delta only names what the creator actually touched (nothing here).
      final delta = dayEditDelta(
          date: '2026-09-18', before: listingOnly, after: listingOnly);
      expect(delta.isEmpty, isTrue);
      final applied = applyDayEditDelta(global, delta);
      expect(applied.exceptions.map((e) => e.id).toList(), ['g1']);
      expect(applied.exceptions.any((e) => e.listingId == 'L1'), isFalse);
    });

    test('editing a listing row leaves the same date in the global scope alone',
        () {
      final global = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final delta = DayEditDelta(
        date: '2026-09-18',
        added: [
          row('local:1', '2026-09-18', 16 * 60, 17 * 60,
              status: AvailabilityExceptionStatus.reserved, listingId: 'L1'),
        ],
      );
      final applied = applyDayEditDelta(global, delta);
      expect(applied.exceptions.where((e) => e.id == 'g1').length, 1);
      expect(
          applied.exceptions
              .where((e) => e.listingId == 'L1')
              .single
              .status,
          AvailabilityExceptionStatus.reserved);
    });

    test('the same delta also leaves the listing schedule intact', () {
      final listingSchedule = [
        row('l1', '2026-09-18', 16 * 60, 17 * 60, listingId: 'L1'),
      ];
      final delta = DayEditDelta(
        date: '2026-09-18',
        added: [row('local:1', '2026-09-18', 9 * 60, 17 * 60)],
      );
      final listingApplied = applyDayEditDelta(listingSchedule, delta);
      expect(listingApplied.exceptions.any((e) => e.id == 'l1'), isTrue);
      expect(listingApplied.skippedIds, isEmpty);
    });

    test('removals only ever name ids the target actually held', () {
      final target = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final delta = DayEditDelta(
          date: '2026-09-18', removedIds: {'l1', 'g1'});
      final applied = applyDayEditDelta(target, delta);
      expect(applied.exceptions, isEmpty);
      expect(applied.skippedIds, ['l1']);
      expect(applied.hadSkipped, isTrue);
    });

    test('an edit for an id the target does not hold is skipped, not created',
        () {
      final target = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final delta = DayEditDelta(
        date: '2026-09-18',
        edited: {
          'l1': row('l1', '2026-09-18', 16 * 60, 17 * 60),
        },
      );
      final applied = applyDayEditDelta(target, delta);
      expect(applied.exceptions.map((e) => e.id).toList(), ['g1']);
      expect(applied.skippedIds, ['l1']);
    });

    test('adding an interval already present does not duplicate the key', () {
      final target = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final delta = DayEditDelta(
        date: '2026-09-18',
        added: [row('local:1', '2026-09-18', 13 * 60, 14 * 60)],
      );
      final applied = applyDayEditDelta(target, delta);
      expect(applied.exceptions.length, 1);
    });

    test('a local row that is added then removed is not sent as a removal', () {
      final before = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final after = [
        row('g1', '2026-09-18', 13 * 60, 14 * 60),
        row('local:1', '2026-09-18', 15 * 60, 16 * 60),
      ];
      final added = dayEditDelta(
          date: '2026-09-18', before: before, after: after);
      expect(added.added.length, 1);
      expect(added.removedIds, isEmpty);
      final reverted = dayEditDelta(
          date: '2026-09-18', before: before, after: before);
      expect(reverted.isEmpty, isTrue);
    });

    test('editing an existing row is reported as an edit of that id', () {
      final before = [row('g1', '2026-09-18', 13 * 60, 14 * 60)];
      final after = [
        row('g1', '2026-09-18', 13 * 60, 15 * 60,
            status: AvailabilityExceptionStatus.available),
      ];
      final delta = dayEditDelta(
          date: '2026-09-18', before: before, after: after);
      expect(delta.added, isEmpty);
      expect(delta.removedIds, isEmpty);
      expect(delta.edited['g1']!.endMin, 15 * 60);
      final applied = applyDayEditDelta(before, delta);
      expect(applied.exceptions.single.endMin, 15 * 60);
    });
  });

  group('review-2 — end of day stays 1440 for partial intervals', () {
    test('18:00 to midnight is 1080..1440, not 1080..0', () {
      expect(pickedMinutes(endOfDay: true, hour: 18, minute: 0), 1440);
      expect(pickedMinutes(endOfDay: false, hour: 18, minute: 0), 1080);
      expect(pickedRangeError(1080, 1440), isNull);
      expect(isValidMinuteRange(1080, 1440), isTrue);
      expect(minutesRangeLabel(1080, 1440), '18:00–24:00');
    });

    test('midnight as an end time is rejected with the end-of-day hint', () {
      expect(pickedMinutes(endOfDay: false, hour: 0, minute: 0), 0);
      final error = pickedRangeError(1080, 0);
      expect(error, isNotNull);
      expect(error, contains('Ends at midnight'));
      expect(isValidMinuteRange(1080, 0), isFalse);
    });

    test('end of day does not make an interval all-day', () {
      final partial = AvailabilityException(
          id: '',
          date: '2026-09-18',
          startMin: 1080,
          endMin: 1440,
          status: AvailabilityExceptionStatus.unavailable);
      expect(partial.isAllDay, isFalse);
      expect(exceptionLabel(partial), "I'm busy · 18:00–24:00");
    });

    test('a weekly working-hours window can end at 1440', () {
      final start = pickedMinutes(endOfDay: false, hour: 18, minute: 0);
      final end = pickedMinutes(endOfDay: true, hour: 17, minute: 0);
      expect(end, 1440);
      expect(pickedRangeError(start, end), isNull);
      expect(minutesRangeLabel(start, end), '18:00–24:00');
      final rule =
          AvailabilityRule(weekday: 5, startMin: start, endMin: end);
      expect(rule.toJson()['end_min'], 1440);
    });

    test('an all-day interval still wins for a whole-day block', () {
      expect(isValidMinuteRange(0, 1440), isTrue);
      expect(minutesRangeLabel(0, 1440), 'All day');
    });
  });

  group('review-3 — holiday ranges respect the existing schedule', () {
    AvailabilityException row(String id, String date, int start, int end,
            {AvailabilityExceptionStatus status =
                AvailabilityExceptionStatus.unavailable,
            String? listingId}) =>
        AvailabilityException(
            id: id,
            date: date,
            startMin: start,
            endMin: end,
            status: status,
            listingId: listingId);

    test('a day with lunch breaks is replaced by ONE all-day block', () {
      final plan = planHolidayRange(
        existing: [
          row('e1', '2026-09-20', 13 * 60, 14 * 60),
          row('e2', '2026-09-20', 16 * 60, 17 * 60),
          row('e3', '2026-09-19', 9 * 60, 10 * 60),
        ],
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 21),
      );
      expect(plan.ok, isTrue);
      expect(plan.replacedDates, ['2026-09-20']);
      expect(plan.blockedDays, 2);
      expect(plan.removedIds, {'e1', 'e2'});
      // Unrelated dates keep every interval.
      expect(plan.exceptions.where((e) => e.id == 'e3').length, 1);
      final blocked = plan.exceptions
          .where((e) => e.date == '2026-09-20')
          .toList(growable: false);
      expect(blocked.length, 1);
      expect(blocked.single.isAllDay, isTrue);
      final same = plan.exceptions.where((e) => e.date == '2026-09-21');
      expect(same.length, 1);
      expect(same.single.isAllDay, isTrue);
    });

    test('an already-blocked day is kept exactly once, never duplicated', () {
      final existing = [
        row('b1', '2026-09-20', 0, 1440),
      ];
      final plan = planHolidayRange(
        existing: existing,
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 20),
      );
      expect(plan.ok, isTrue);
      expect(plan.alreadyBlockedDates, ['2026-09-20']);
      expect(plan.added, isEmpty);
      expect(plan.removedIds, isEmpty);
      expect(plan.exceptions.length, 1);
      expect(plan.exceptions.single.id, 'b1');
    });

    test('a reserved window is preserved and the day is blocked around it', () {
      final plan = planHolidayRange(
        existing: [
          row('r1', '2026-09-20', 10 * 60, 11 * 60,
              status: AvailabilityExceptionStatus.reserved, listingId: 'L1'),
        ],
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 20),
      );
      expect(plan.ok, isTrue);
      expect(plan.reservationDates, ['2026-09-20']);
      expect(plan.removedIds, isEmpty);
      expect(plan.exceptions.where((e) => e.id == 'r1').length, 1);
      final blocks = plan.added.map((e) => '${e.startMin}-${e.endMin}').toList();
      expect(blocks, ['0-600', '660-1440']);
    });

    test('a whole-day reservation leaves no block to add', () {
      final plan = planHolidayRange(
        existing: [
          row('r1', '2026-09-20', 0, 1440,
              status: AvailabilityExceptionStatus.reserved, listingId: 'L1'),
        ],
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 20),
      );
      expect(plan.ok, isTrue);
      expect(plan.added, isEmpty);
      expect(plan.reservationDates, ['2026-09-20']);
    });

    test('the schedule\'s OWN horizon bounds the range (not always 62)', () {
      final plan = planHolidayRange(
        existing: const <AvailabilityException>[],
        from: DateTime(2026, 9, 1),
        to: DateTime(2026, 10, 10),
        horizonDays: 30,
      );
      expect(plan.ok, isFalse);
      expect(plan.error, contains('30 day'));
    });

    test('an invalid legacy horizon is capped at 62 and explained', () {
      final plan = planHolidayRange(
        existing: const <AvailabilityException>[],
        from: DateTime(2026, 9, 1),
        to: DateTime(2026, 9, 5),
        horizonDays: 90,
      );
      expect(plan.ok, isTrue);
      expect(plan.horizonUnknown, isTrue);
      expect(plan.blockedDays, 5);
    });

    test('a range longer than 62 days is refused before saving', () {
      final plan = planHolidayRange(
        existing: const <AvailabilityException>[],
        from: DateTime(2026, 1, 1),
        to: DateTime(2026, 3, 31),
      );
      expect(plan.ok, isFalse);
      expect(plan.error, contains('at most $kMaxHorizonDays'));
    });

    test('the 100-exception ceiling is enforced by the plan', () {
      final existing = List<AvailabilityException>.generate(
          99,
          (i) => AvailabilityException(
                id: 'e$i',
                date: '2026-09-${(i % 28) + 1}',
                startMin: 8 * 60,
                endMin: 9 * 60,
                status: AvailabilityExceptionStatus.unavailable,
              ));
      final plan = planHolidayRange(
        existing: existing,
        from: DateTime(2026, 10, 1),
        to: DateTime(2026, 10, 2),
      );
      expect(plan.ok, isFalse);
      expect(plan.error, contains('$kMaxExceptions'));
    });

    test('an end date before the start date changes nothing', () {
      final plan = planHolidayRange(
        existing: const <AvailabilityException>[],
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 19),
      );
      expect(plan.ok, isFalse);
      expect(plan.exceptions, isEmpty);
    });

    test('a failed range save is replayed across every date it blocked', () {
      final before = [
        row('e1', '2026-09-20', 13 * 60, 14 * 60),
        row('e2', '2026-09-21', 16 * 60, 17 * 60),
        row('keep', '2026-10-05', 9 * 60, 10 * 60),
      ];
      final planned = planHolidayRange(
        existing: before,
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 21),
      );
      expect(planned.ok, isTrue);
      final delta =
          scheduleDelta(before: before, after: planned.exceptions);
      expect(delta.removedIds, {'e1', 'e2'});
      expect(delta.added.map((e) => e.date).toSet(),
          {'2026-09-20', '2026-09-21'});
      // A concurrent row added by another device after the failed save survives.
      final fresh = [...before, row('new', '2026-09-25', 8 * 60, 9 * 60)];
      final application = applyScheduleDelta(fresh, delta);
      expect(application.hadSkipped, isFalse);
      expect(application.exceptions.any((e) => e.id == 'keep'), isTrue);
      expect(application.exceptions.any((e) => e.id == 'new'), isTrue);
      expect(application.exceptions.any((e) => e.id == 'e1'), isFalse);
      expect(application.exceptions.any((e) => e.id == 'e2'), isFalse);
      for (final date in ['2026-09-20', '2026-09-21']) {
        expect(
            application.exceptions
                .where((e) => e.date == date)
                .single
                .isAllDay,
            isTrue);
      }
    });

    test('a single-date delta is why a range retry must not use it', () {
      final before = [
        row('e1', '2026-09-20', 13 * 60, 14 * 60),
        row('e2', '2026-09-21', 16 * 60, 17 * 60),
      ];
      final planned = planHolidayRange(
        existing: before,
        from: DateTime(2026, 9, 20),
        to: DateTime(2026, 9, 21),
      );
      final scoped = dayEditDelta(
          date: '2026-09-20',
          before: before,
          after: planned.exceptions);
      // The second range date's removal is not on the delta's date, so the
      // date-scoped application reports it as a foreign edit and refuses.
      expect(applyDayEditDelta(before, scoped).hadSkipped, isTrue);
      expect(applyScheduleDelta(
              before, scheduleDelta(before: before, after: planned.exceptions))
          .hadSkipped,
          isFalse);
    });
  });

  group('review-6 — effective notice and horizon honesty', () {
    test('a listing with no commercial notice uses the 24 h server default', () {
      expect(commercialNoticeMinutesFromAttrs(null), 1440);
      expect(commercialNoticeMinutesFromAttrs(const <String, dynamic>{}), 1440);
      expect(
          commercialNoticeMinutesFromAttrs(
              const <String, dynamic>{'commercial_booking_notice_hours': 6}),
          360);
    });

    test('the effective notice is the LARGER of calendar and listing notice', () {
      final summary = noticePolicySummary(
          calendarNoticeMin: 120,
          listingCommercialNoticeMin: 1440,
          listingTitle: '1:1');
      expect(summary.effectiveMinNoticeMin, 1440);
      expect(noticePolicyLine(summary), contains('1 day'));
      expect(noticePolicyLine(summary), contains('24 h when unset'));

      final calendarWins = noticePolicySummary(
          calendarNoticeMin: 2880, listingCommercialNoticeMin: 60);
      expect(calendarWins.effectiveMinNoticeMin, 2880);
    });

    test('an authoritative server value wins over the client rule', () {
      final summary = noticePolicySummary(
        calendarNoticeMin: 120,
        listingCommercialNoticeMin: 60,
        authoritativeEffectiveMinNoticeMin: 600,
        listingTitle: '1:1',
      );
      expect(summary.effectiveMinNoticeMin, 600);
      expect(summary.fromServerEffective, isTrue);
      expect(noticePolicyLine(summary), contains('confirmed by the server'));
    });

    test('an unreadable listing notice is not presented as a value', () {
      final summary = noticePolicySummary(
          calendarNoticeMin: 120, listingTitle: 'this listing');
      expect(summary.effectiveMinNoticeMin, 120);
      expect(noticePolicyLine(summary),
          contains('could not be read'));
    });

    test('the calendar-only line says a listing can require longer', () {
      final line = noticePolicyLine(
          noticePolicySummary(calendarNoticeMin: 0));
      expect(line, contains('no minimum'));
      expect(line, contains('larger value applies'));
    });

    test('an unsupported stored horizon is explained, not shown as saved', () {
      final legacy = AvailabilitySchedule.fromJson({'horizon_days': 90});
      expect(storedHorizonDays(legacy), isNull);
      expect(horizonPersistenceNotice(legacy), contains('90 days'));
      expect(legacy.toJson().containsKey('horizon_days'), isFalse);

      final ok = AvailabilitySchedule.fromJson({'horizon_days': 62});
      expect(storedHorizonDays(ok), 62);
      expect(horizonPersistenceNotice(ok), isNull);
    });

    test('notice labels read in days and hours', () {
      expect(noticeMinutesLabel(0), 'no minimum');
      expect(noticeMinutesLabel(90), '90 min');
      expect(noticeMinutesLabel(120), '2 h');
      expect(noticeMinutesLabel(1440), '1 day');
      expect(noticeMinutesLabel(2880), '2 days');
    });
  });

  group('review-7 — orchestration that the screens must not re-invent', () {
    test('a partial load names its sources and denies unconfirmed free time',
        () {
      final notices = calendarNotices(
          error: 'Working hours could not be refreshed.',
          failedSources: ['busy blocks', 'bookable slots']);
      expect(notices.map((n) => n.kind).toList(),
          [CalendarNoticeKind.error, CalendarNoticeKind.partial]);
      final partial =
          notices.firstWhere((n) => n.kind == CalendarNoticeKind.partial);
      expect(partial.message, contains('busy blocks'));
      expect(partial.message, contains('NOT confirmed free'));
    });

    test('an empty failure list adds no partial warning', () {
      expect(calendarNotices(), isEmpty);
      expect(partialFailureMessage(const <String>[]), '');
    });

    test('an unverified Google status is surfaced as a warning', () {
      final notices = calendarNotices(gcal: gcalUnknown('could not be read'));
      expect(notices.single.kind, CalendarNoticeKind.google);
      expect(notices.single.message, contains('could not be read'));
    });

    test('a stale snapshot is flagged', () {
      final notices = calendarNotices(stale: true);
      expect(notices.single.kind, CalendarNoticeKind.stale);
    });

    test('resume refresh: first resume yes, a quick second one no', () {
      final now = DateTime(2026, 9, 15, 12);
      expect(shouldRefreshOnResume(lastRefreshAt: null, now: now), isTrue);
      expect(
          shouldRefreshOnResume(
              lastRefreshAt: now.subtract(const Duration(seconds: 5)),
              now: now),
          isFalse);
      expect(
          shouldRefreshOnResume(
              lastRefreshAt: now.subtract(const Duration(minutes: 2)),
              now: now),
          isTrue);
    });

    test('account identity is compared, not the load generation', () {
      expect(accountScopeChanged(captured: 'user_a', current: 'user_a'),
          isFalse);
      expect(accountScopeChanged(captured: 'user_a', current: 'user_b'),
          isTrue);
      expect(accountScopeChanged(captured: null, current: null), isFalse);
      expect(accountScopeChanged(captured: null, current: 'user_b'), isTrue);
    });

    test('sync outcomes never claim a sync that could not happen', () {
      final missingRoute = gcalSyncOutcome(ok: false, routeUnavailable: true);
      expect(missingRoute.readiness, isNull);
      expect(missingRoute.reloadStatus, isFalse);
      expect(missingRoute.message, contains('does not offer manual sync'));
      expect(missingRoute.message, contains('nothing was reported as synced'));

      final failed = gcalSyncOutcome(
          ok: false, routeUnavailable: false, error: 'token expired');
      expect(failed.message, 'token expired');
      expect(failed.reloadStatus, isTrue);

      // Relative to real "now": readiness also checks per-calendar freshness.
      final freshAt = DateTime.now().millisecondsSinceEpoch;
      final ready = gcalSyncOutcome(
        ok: true,
        routeUnavailable: false,
        json: {
          'connected': true,
          'ready': true,
          'last_success_at': freshAt,
          'calendars': [
            {
              'id': 'c1',
              'summary': 'Work',
              'selected': true,
              'last_success_at': freshAt,
            }
          ],
        },
      );
      expect(ready.readiness, isNotNull);
      expect(ready.readiness!.isReady, isTrue);
      expect(ready.message, 'Busy times synced.');

      final pending = gcalSyncOutcome(
        ok: true,
        routeUnavailable: false,
        json: {'connected': true, 'ready': false, 'reason': 'pending'},
      );
      expect(pending.readiness!.isReady, isFalse);
      expect(pending.message, contains('not synced yet'));

      final unreadable = gcalSyncOutcome(ok: true, routeUnavailable: false);
      expect(unreadable.reloadStatus, isTrue);
      expect(unreadable.messageIfReloadFails,
          contains('new status could not be read'));
    });
  });
}
