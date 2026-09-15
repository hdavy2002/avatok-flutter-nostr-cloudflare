// Pure decision logic for the creator calendar (audit findings 2–12 and the
// phone findings A1–A8, 15 September 2026).
//
// Nothing in this file touches widgets, the network or the disk cache, so every
// behaviour that the audit called out — view navigation, multiple exceptions on
// one day, all-day round-tripping, numeric policy limits, unknown-versus-zero
// availability, one card per booking, Google readiness and timezone-safe time
// formatting — is regression-testable without an emulator or a live backend.
import 'calendar_data.dart';
import '../../core/availability_time.dart';
import '../../core/listings_api.dart';

/// A4 — Agenda is the useful phone default; a wide window still opens on Month.
enum CalendarView { month, week, agenda }

CalendarView defaultCalendarView({required bool wide}) =>
    wide ? CalendarView.month : CalendarView.agenda;

/// A5 — the arrows must follow the active view, not always the month.
class CalendarNavigation {
  final DateTime month;
  final DateTime selected;

  const CalendarNavigation({required this.month, required this.selected});
}

DateTime dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

String dateKey(DateTime value) =>
    '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

DateTime? parseDateKey(String value) {
  final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (match == null) return null;
  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = int.parse(match.group(3)!);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  final parsed = DateTime(year, month, day);
  if (parsed.month != month || parsed.day != day) return null;
  return parsed;
}

DateTime startOfWeek(DateTime day) {
  final base = dateOnly(day);
  return base.subtract(Duration(days: (base.weekday + 6) % 7));
}

/// UTC-epoch bounds of one calendar day in the SCHEDULE timezone. Days are
/// grouped in that timezone everywhere (finding 8), so the diary never mixes a
/// local-clock day boundary with a card rendered in another zone.
({int from, int to})? dayBoundsUtcMs(DateTime day, String timezone) {
  try {
    final start = AvailabilityTime.wallTimeToUtc(
        date: dateOnly(day), minutes: 0, timezone: timezone);
    final end = AvailabilityTime.wallTimeToUtc(
        date: DateTime(day.year, day.month, day.day + 1),
        minutes: 0,
        timezone: timezone);
    return (from: start.millisecondsSinceEpoch, to: end.millisecondsSinceEpoch);
  } catch (_) {
    return null;
  }
}

DateTime _clampDayOfMonth(DateTime selected, DateTime targetMonth) {
  final days = DateTime(targetMonth.year, targetMonth.month + 1, 0).day;
  final day = selected.day > days ? days : selected.day;
  return DateTime(targetMonth.year, targetMonth.month, day);
}

CalendarNavigation calendarNavigate({
  required CalendarView view,
  required int direction,
  required DateTime selected,
  required DateTime month,
}) {
  final step = direction.isNegative ? -1 : 1;
  switch (view) {
    case CalendarView.month:
      final targetMonth = DateTime(month.year, month.month + step);
      return CalendarNavigation(
        month: targetMonth,
        selected: _clampDayOfMonth(selected, targetMonth),
      );
    case CalendarView.week:
      final next = DateTime(selected.year, selected.month, selected.day + 7 * step);
      return CalendarNavigation(
          month: DateTime(next.year, next.month, 1), selected: next);
    case CalendarView.agenda:
      final next = DateTime(selected.year, selected.month, selected.day + step);
      return CalendarNavigation(
          month: DateTime(next.year, next.month, 1), selected: next);
  }
}

const List<String> _monthShort = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const List<String> _weekdayShort = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
];

String weekdayShort(DateTime day) => _weekdayShort[(day.weekday - 1) % 7];

String monthShort(DateTime day) => _monthShort[(day.month - 1) % 12];

/// Header caption for the active view: one month, one week or one day.
String calendarRangeLabel({
  required CalendarView view,
  required DateTime month,
  required DateTime selected,
}) {
  switch (view) {
    case CalendarView.month:
      return '${monthShort(month)} ${month.year}';
    case CalendarView.week:
      final start = startOfWeek(selected);
      final end = DateTime(start.year, start.month, start.day + 6);
      final sameMonth = start.month == end.month;
      final sameYear = start.year == end.year;
      if (sameMonth) {
        return '${start.day}–${end.day} ${monthShort(start)} ${start.year}';
      }
      if (sameYear) {
        return '${start.day} ${monthShort(start)} – ${end.day} ${monthShort(end)} ${start.year}';
      }
      return '${start.day} ${monthShort(start)} ${start.year} – ${end.day} ${monthShort(end)} ${end.year}';
    case CalendarView.agenda:
      return '${weekdayShort(selected)} ${selected.day} ${monthShort(selected)} ${selected.year}';
  }
}

/// True when [value] falls on [dateKeyValue] (used by tests and callers that
/// only hold the wire-format date string).
bool dateKeyMatches(String dateKeyValue, DateTime day) =>
    dateKeyValue == dateKey(day);

// ── Exceptions (findings 2, 3, A8) ─────────────────────────────────────────
const int kMaxExceptions = 100;
const int kMaxHorizonDays = 62;
const int kDefaultMaxPerDay = 8;

/// Every interval stored for one date, ordered. Never a "first match" lookup.
List<AvailabilityException> exceptionsOnDate(
    List<AvailabilityException> all, String dateKeyValue) {
  final matches = all.where((e) => e.date == dateKeyValue).toList();
  matches.sort((a, b) {
    final byStart = a.startMin.compareTo(b.startMin);
    if (byStart != 0) return byStart;
    final byEnd = a.endMin.compareTo(b.endMin);
    if (byEnd != 0) return byEnd;
    return a.id.compareTo(b.id);
  });
  return matches;
}

/// Replaces only the edited interval; every other interval on the date — and
/// every other date — is preserved verbatim.
List<AvailabilityException> upsertException(
  List<AvailabilityException> all,
  AvailabilityException value, {
  String? replacingId,
}) {
  final target = replacingId ?? value.id;
  final next = <AvailabilityException>[];
  var replaced = false;
  for (final existing in all) {
    if (target.isNotEmpty && existing.id == target) {
      next.add(value);
      replaced = true;
      continue;
    }
    next.add(existing);
  }
  if (!replaced) next.add(value);
  return next;
}

List<AvailabilityException> removeException(
        List<AvailabilityException> all, String id) =>
    all.where((e) => e.id != id).toList();

/// "Remove all exceptions / use normal hours" for a single date: that date's
/// intervals disappear, unrelated dates are untouched.
List<AvailabilityException> clearDateExceptions(
        List<AvailabilityException> all, String dateKeyValue) =>
    all.where((e) => e.date != dateKeyValue).toList();

/// Replaces the whole set for one date — what the day editor saves after the
/// creator adds/edits/removes intervals individually.
List<AvailabilityException> replaceDateExceptions(
  List<AvailabilityException> all,
  String dateKeyValue,
  List<AvailabilityException> dayExceptions,
) =>
    [
      ...all.where((e) => e.date != dateKeyValue),
      ...dayExceptions,
    ];

/// Finding 2 / A8 — a holiday is one action over a date range, expanding to one
/// whole-day (0–1440) interval per date. Callers merge the result; nothing is
/// dropped for dates that already had intervals.
List<AvailabilityException> holidayRangeExceptions({
  required DateTime from,
  required DateTime to,
  AvailabilityExceptionStatus status = AvailabilityExceptionStatus.unavailable,
  int startMin = AvailabilityException.allDayStartMin,
  int endMin = AvailabilityException.allDayEndMin,
  String? listingId,
}) {
  final start = dateOnly(from);
  final end = dateOnly(to);
  if (end.isBefore(start)) return const [];
  final rows = <AvailabilityException>[];
  var cursor = start;
  var guard = 0;
  while (!cursor.isAfter(end) && guard < 400) {
    guard++;
    rows.add(AvailabilityException(
      id: '',
      date: dateKey(cursor),
      startMin: startMin,
      endMin: endMin,
      status: status,
      listingId: listingId,
    ));
    cursor = DateTime(cursor.year, cursor.month, cursor.day + 1);
  }
  return rows;
}

/// Merges [additions] into [existing], SKIPPING any addition whose
/// (date, start, end) key is already present. The server rejects duplicate date
/// intervals outright, so a blind append used to turn "block a holiday" into a
/// 400 whenever the range contained an already-blocked day. Prefer
/// [planHolidayRange] for ranges; this stays for simple additive merges.
List<AvailabilityException> mergeExceptions(
  List<AvailabilityException> existing,
  List<AvailabilityException> additions,
) {
  final keys = <String>{...existing.map(exceptionIntervalKey)};
  final out = List<AvailabilityException>.from(existing);
  for (final row in additions) {
    if (keys.add(exceptionIntervalKey(row))) out.add(row);
  }
  return out;
}

String? validateExceptionCount(int count) => count > kMaxExceptions
    ? 'A schedule can hold at most $kMaxExceptions exceptions. Remove some before adding more.'
    : null;

/// The server's duplicate key for one date interval ("Duplicate date interval").
String exceptionIntervalKey(AvailabilityException row) =>
    '${row.date}:${row.startMin}:${row.endMin}';

/// A provisional id the day editor gives an interval it added locally and that
/// the server has never seen. It is stripped before the schedule is saved.
bool isProvisionalExceptionId(String id) => id.startsWith('local:');


/// True when [value] describes an interval the server will accept.
bool isValidMinuteRange(int startMin, int endMin) =>
    startMin >= 0 && endMin <= AvailabilityException.allDayEndMin && endMin > startMin;

// ── End of day is an explicit choice (finding 2 regression) ────────────────
/// Minutes since midnight for a picked clock time.
///
/// Ending at midnight is an EXPLICIT, independent choice ([endOfDay]) — it is
/// NOT the same as "All day". Without it, a partial 18:00→24:00 interval is
/// mapped to 18:00→00:00 and refused as "end before start", so a creator simply
/// cannot save an evening block any more. With it, the interval keeps the
/// contract's 1440 end-of-day value for partial intervals AND weekly hours.
int pickedMinutes({
  required bool endOfDay,
  required int hour,
  required int minute,
}) {
  if (endOfDay) return AvailabilityException.allDayEndMin;
  final value = hour * 60 + minute;
  if (value < 0) return 0;
  return value > AvailabilityException.allDayEndMin
      ? AvailabilityException.allDayEndMin
      : value;
}

/// Why a picked range cannot be saved, in creator language, or null when it can.
String? pickedRangeError(int startMin, int endMin) {
  if (endMin > startMin && startMin >= 0 &&
      endMin <= AvailabilityException.allDayEndMin) {
    return null;
  }
  if (endMin == AvailabilityException.allDayStartMin && startMin > 0) {
    return 'Midnight is the START of a day. Turn on "Ends at midnight" to run '
        'until the end of the day, or pick an earlier end time.';
  }
  return 'The end time must be after the start time.';
}

// ── Scope-safe day edits (review item 1) ───────────────────────────────────
/// The creator's INTENDED change to one date: additions (never seen by the
/// server), edits keyed by the server id they replace, and removals by id.
///
/// A delta is always derived against the scope that was actually loaded, so
/// applying it to another scope cannot transplant that scope's rows — and
/// cannot drop rows the creator never touched.
class DayEditDelta {
  final String date;
  final List<AvailabilityException> added;
  final Map<String, AvailabilityException> edited;
  final Set<String> removedIds;

  const DayEditDelta({
    required this.date,
    this.added = const <AvailabilityException>[],
    this.edited = const <String, AvailabilityException>{},
    this.removedIds = const <String>{},
  });

  bool get isEmpty => added.isEmpty && edited.isEmpty && removedIds.isEmpty;
}

/// Difference between the intervals a scope held before editing and the
/// intended set afterwards. Removals only ever name ids the loaded scope had;
/// a locally-added interval that is then removed simply never appears.
DayEditDelta dayEditDelta({
  required String date,
  required List<AvailabilityException> before,
  required List<AvailabilityException> after,
}) {
  final beforeById = <String, AvailabilityException>{
    for (final row in before)
      if (row.id.isNotEmpty && !isProvisionalExceptionId(row.id)) row.id: row,
  };
  final afterIds = <String>{
    for (final row in after)
      if (row.id.isNotEmpty && !isProvisionalExceptionId(row.id)) row.id,
  };
  final added = <AvailabilityException>[];
  final edited = <String, AvailabilityException>{};
  for (final row in after) {
    if (row.id.isEmpty || isProvisionalExceptionId(row.id)) {
      added.add(row);
      continue;
    }
    final previous = beforeById[row.id];
    if (previous == null) {
      // The loaded scope never held this row: treat it as an addition rather
      // than an edit, so nothing is invented in the target scope.
      added.add(row.copyWith(id: ''));
      continue;
    }
    if (!_sameException(previous, row)) edited[row.id] = row;
  }
  final removedIds = <String>{
    for (final row in before)
      if (row.id.isNotEmpty &&
          !isProvisionalExceptionId(row.id) &&
          !afterIds.contains(row.id))
        row.id,
  };
  return DayEditDelta(
      date: date, added: added, edited: edited, removedIds: removedIds);
}

bool _sameException(AvailabilityException a, AvailabilityException b) =>
    a.date == b.date &&
    a.startMin == b.startMin &&
    a.endMin == b.endMin &&
    a.status == b.status &&
    a.listingId == b.listingId;

class DayEditApplication {
  final List<AvailabilityException> exceptions;

  /// Ids the target schedule did NOT hold. A concurrent save on another device
  /// can produce these; the app surfaces them instead of silently writing a row
  /// into the wrong scope.
  final List<String> skippedIds;

  const DayEditApplication(this.exceptions, this.skippedIds);

  bool get hadSkipped => skippedIds.isNotEmpty;
}

/// Applies [delta] to [target] ONLY. Every other date — and every interval on
/// the edited date the creator did not touch — survives verbatim. Provisional
/// ids are stripped so the server assigns the real ids.
DayEditApplication applyDayEditDelta(
    List<AvailabilityException> target, DayEditDelta delta) {
  final targetIds = <String>{
    for (final row in target)
      if (row.date == delta.date && row.id.isNotEmpty) row.id,
  };
  final out = <AvailabilityException>[];
  for (final existing in target) {
    if (existing.date != delta.date) {
      out.add(existing);
      continue;
    }
    if (delta.removedIds.contains(existing.id)) continue;
    final edit = delta.edited[existing.id];
    if (edit != null) {
      out.add(edit);
      continue;
    }
    out.add(existing);
  }
  final skipped = <String>[
    for (final id in <String>{...delta.edited.keys, ...delta.removedIds})
      if (!targetIds.contains(id)) id,
  ];
  final keys = <String>{
    for (final row in out)
      if (row.date == delta.date) exceptionIntervalKey(row),
  };
  for (final row in delta.added) {
    if (keys.add(exceptionIntervalKey(row))) {
      out.add(row.id.isEmpty ? row : row.copyWith(id: ''));
    }
  }
  return DayEditApplication(out, skipped);
}

/// Difference between two FULL schedule exception lists, across every date.
///
/// [dayEditDelta] is deliberately date-scoped: the day editor only ever changes
/// one date. A holiday range changes several dates at once, so replaying a
/// failed range save needs the same rule WITHOUT the single-date filter —
/// otherwise the retry reports every other date's intended change as somebody
/// else's edit and aborts, silently dropping the creator's block.
class ScheduleDelta {
  final List<AvailabilityException> added;
  final Map<String, AvailabilityException> edited;
  final Set<String> removedIds;

  const ScheduleDelta({
    this.added = const <AvailabilityException>[],
    this.edited = const <String, AvailabilityException>{},
    this.removedIds = const <String>{},
  });

  bool get isEmpty => added.isEmpty && edited.isEmpty && removedIds.isEmpty;
}

ScheduleDelta scheduleDelta({
  required List<AvailabilityException> before,
  required List<AvailabilityException> after,
}) {
  final beforeById = <String, AvailabilityException>{
    for (final row in before)
      if (row.id.isNotEmpty && !isProvisionalExceptionId(row.id)) row.id: row,
  };
  final afterIds = <String>{
    for (final row in after)
      if (row.id.isNotEmpty && !isProvisionalExceptionId(row.id)) row.id,
  };
  final added = <AvailabilityException>[];
  final edited = <String, AvailabilityException>{};
  for (final row in after) {
    if (row.id.isEmpty || isProvisionalExceptionId(row.id)) {
      added.add(row);
      continue;
    }
    final previous = beforeById[row.id];
    if (previous == null) {
      added.add(row.copyWith(id: ''));
      continue;
    }
    if (!_sameException(previous, row)) edited[row.id] = row;
  }
  final removedIds = <String>{
    for (final row in before)
      if (row.id.isNotEmpty &&
          !isProvisionalExceptionId(row.id) &&
          !afterIds.contains(row.id))
        row.id,
  };
  return ScheduleDelta(added: added, edited: edited, removedIds: removedIds);
}

/// Applies a whole-schedule [delta] to [target] ONLY: every interval the
/// creator did not touch survives verbatim, a locally-added provisional id is
/// stripped so the server assigns the real one, and an edit or removal naming an
/// id the target no longer holds is reported instead of invented.
DayEditApplication applyScheduleDelta(
    List<AvailabilityException> target, ScheduleDelta delta) {
  final targetIds = <String>{
    for (final row in target)
      if (row.id.isNotEmpty) row.id,
  };
  final out = <AvailabilityException>[];
  for (final existing in target) {
    if (delta.removedIds.contains(existing.id)) continue;
    out.add(delta.edited[existing.id] ?? existing);
  }
  final skipped = <String>[
    for (final id in <String>{...delta.edited.keys, ...delta.removedIds})
      if (!targetIds.contains(id)) id,
  ];
  final keys = <String>{for (final row in out) exceptionIntervalKey(row)};
  for (final row in delta.added) {
    if (keys.add(exceptionIntervalKey(row))) {
      out.add(row.id.isEmpty ? row : row.copyWith(id: ''));
    }
  }
  return DayEditApplication(out, skipped);
}

// ── Holiday ranges (review item 3) ─────────────────────────────────────────
class HolidayRangePlan {
  final List<AvailabilityException> exceptions;
  final Set<String> removedIds;
  final List<AvailabilityException> added;

  /// Dates that already held intervals which the range replaces. The UI asks
  /// for explicit confirmation before these windows are covered.
  final List<String> replacedDates;

  /// Dates already blocked for the same scope: kept as-is, never duplicated.
  final List<String> alreadyBlockedDates;

  /// Dates holding a reserved window: the window is preserved and the day is
  /// blocked around it, because the server refuses overlapping date
  /// reservations and AvaTOK never cancels reserved commitments silently.
  final List<String> reservationDates;

  final int blockedDays;

  /// The stored horizon is outside 1..62, so it will be omitted on save and the
  /// server default applies. The UI explains that instead of implying the
  /// horizon it shows was enforced.
  final bool horizonUnknown;

  final String? error;

  const HolidayRangePlan({
    required this.exceptions,
    this.removedIds = const <String>{},
    this.added = const <AvailabilityException>[],
    this.replacedDates = const <String>[],
    this.alreadyBlockedDates = const <String>[],
    this.reservationDates = const <String>[],
    this.blockedDays = 0,
    this.horizonUnknown = false,
    this.error,
  });

  bool get ok => error == null;
  int get replacedDateCount => replacedDates.length;
}

/// Builds the holiday-range edit for ONE schedule scope without touching
/// unrelated dates, duplicating an already-blocked day, or removing a reserved
/// window. Bounded by the schedule's OWN policy horizon (never forced to 62),
/// the 62-day hard cap and the 100-exception ceiling.
HolidayRangePlan planHolidayRange({
  required List<AvailabilityException> existing,
  required DateTime from,
  required DateTime to,
  String? scopeListingId,
  int? horizonDays,
  int maxExceptions = kMaxExceptions,
  AvailabilityExceptionStatus status = AvailabilityExceptionStatus.unavailable,
}) {
  final start = dateOnly(from);
  final end = dateOnly(to);
  if (end.isBefore(start)) {
    return HolidayRangePlan(
        exceptions: existing, error: 'Choose an end date on or after the start date.');
  }
  final days = <DateTime>[];
  var cursor = start;
  var guard = 0;
  while (!cursor.isAfter(end) && guard < 400) {
    guard++;
    days.add(cursor);
    cursor = DateTime(cursor.year, cursor.month, cursor.day + 1);
  }
  if (days.length > kMaxHorizonDays) {
    return HolidayRangePlan(
        exceptions: existing,
        error:
            'A holiday can cover at most $kMaxHorizonDays days at a time. Split it into shorter ranges.');
  }
  final horizonValid =
      horizonDays != null && horizonDays >= 1 && horizonDays <= kMaxHorizonDays;
  if (horizonValid && days.length > horizonDays!) {
    return HolidayRangePlan(
        exceptions: existing,
        error:
            'This schedule can be booked $horizonDays day(s) ahead, so a ${days.length}-day holiday goes past it. Shorten the range or raise the booking horizon in Booking policy.');
  }

  final removedIds = <String>{};
  final added = <AvailabilityException>[];
  final replaced = <String>[];
  final alreadyBlocked = <String>[];
  final reservedDates = <String>[];

  for (final day in days) {
    final key = dateKey(day);
    final dayRows = existing.where((row) => row.date == key).toList();
    final reserved = dayRows
        .where((row) => row.status == AvailabilityExceptionStatus.reserved)
        .toList();
    final replaceable = dayRows
        .where((row) => row.status != AvailabilityExceptionStatus.reserved)
        .toList();
    final alreadyWholeDay = reserved.isEmpty &&
        replaceable.length == 1 &&
        replaceable.single.status == status &&
        replaceable.single.isAllDay &&
        (replaceable.single.listingId ?? null) == (scopeListingId ?? null);
    if (alreadyWholeDay) {
      alreadyBlocked.add(key);
      continue;
    }
    if (reserved.isNotEmpty) reservedDates.add(key);
    if (replaceable.isNotEmpty) replaced.add(key);
    for (final row in replaceable) {
      if (row.id.isNotEmpty) removedIds.add(row.id);
    }
    if (reserved.isEmpty) {
      added.add(_wholeDayBlock(key, status, scopeListingId));
    } else {
      added.addAll(
          _blocksAroundReserved(key, reserved, status, scopeListingId));
    }
  }

  final next = <AvailabilityException>[
    for (final row in existing)
      if (!removedIds.contains(row.id)) row,
    ...added,
  ];
  final tooMany = validateExceptionCount(next.length);
  if (tooMany != null) {
    return HolidayRangePlan(exceptions: existing, error: tooMany);
  }
  return HolidayRangePlan(
    exceptions: next,
    removedIds: removedIds,
    added: added,
    replacedDates: replaced,
    alreadyBlockedDates: alreadyBlocked,
    reservationDates: reservedDates,
    blockedDays: days.length,
    horizonUnknown: !horizonValid,
  );
}

AvailabilityException _wholeDayBlock(
        String key, AvailabilityExceptionStatus status, String? listingId) =>
    AvailabilityException(
      id: '',
      date: key,
      startMin: AvailabilityException.allDayStartMin,
      endMin: AvailabilityException.allDayEndMin,
      status: status,
      listingId: listingId,
    );

List<AvailabilityException> _blocksAroundReserved(
  String key,
  List<AvailabilityException> reserved,
  AvailabilityExceptionStatus status,
  String? listingId,
) {
  final ordered = [...reserved]
    ..sort((a, b) => a.startMin.compareTo(b.startMin));
  final out = <AvailabilityException>[];
  var cursor = 0;
  for (final row in ordered) {
    final from = _clampMinute(row.startMin);
    final to = _clampMinute(row.endMin);
    if (from > cursor) {
      out.add(AvailabilityException(
        id: '',
        date: key,
        startMin: cursor,
        endMin: from,
        status: status,
        listingId: listingId,
      ));
    }
    if (to > cursor) cursor = to;
  }
  if (cursor < AvailabilityException.allDayEndMin) {
    out.add(AvailabilityException(
      id: '',
      date: key,
      startMin: cursor,
      endMin: AvailabilityException.allDayEndMin,
      status: status,
      listingId: listingId,
    ));
  }
  return out;
}

int _clampMinute(int value) {
  if (value < 0) return 0;
  if (value > AvailabilityException.allDayEndMin) {
    return AvailabilityException.allDayEndMin;
  }
  return value;
}

// ── Policy numbers (finding 10, A3) ────────────────────────────────────────
String? validateIntInRange(int? value,
    {required int min, required int max}) {
  if (value == null) return 'Enter a number between $min and $max.';
  if (value < min || value > max) return 'Enter a number between $min and $max.';
  return null;
}

/// A3 — the server accepts 1..100 and refuses 0, so 0 can never be offered as
/// "no limit". `null` means the field was empty, which is also invalid.
String? validateMaxPerDay(int? value) =>
    validateIntInRange(value, min: 1, max: 100);

String? validateHorizonDays(int? value) =>
    validateIntInRange(value, min: 1, max: kMaxHorizonDays);

String? validateDurationMinutes(int? value) =>
    validateIntInRange(value, min: 5, max: 480);

String? validateSlotIntervalMinutes(int? value) =>
    validateIntInRange(value, min: 5, max: 240);

String? validateBufferMinutes(int? value) =>
    validateIntInRange(value, min: 0, max: 240);

String? validateNoticeMinutes(int? value) =>
    validateIntInRange(value, min: 0, max: 43200);

/// The schedule timezone must be a real IANA name — never a device abbreviation
/// or a guessed offset (finding 8: one explicit schedule timezone everywhere).
String? validateTimezone(String raw) {
  final value = raw.trim();
  if (value.isEmpty) return 'Enter a timezone such as Asia/Kolkata.';
  try {
    AvailabilityTime.location(value);
    return null;
  } catch (_) {
    return 'That timezone is not recognised. Use an IANA name such as Asia/Kolkata.';
  }
}

/// Never render an unset/legacy 0 as a promise of "no limit".
String maxPerDayLabel(int maxPerDay) =>
    maxPerDay >= 1 && maxPerDay <= 100 ? '$maxPerDay per day' : 'Not set';

// ── Availability display (finding 4, A7) ───────────────────────────────────
/// Unknown availability must never be rendered as zero bookable slots.
String availabilityCountLabel(int? availableCount) =>
    availableCount == null ? '—' : '$availableCount open';

String weekAvailabilityLabel({
  required int? availableCount,
  required bool listingSelected,
}) {
  if (!listingSelected) return 'Select a listing';
  return availabilityCountLabel(availableCount);
}

String availabilityHint({required bool listingSelected}) => listingSelected
    ? 'Counts come from the selected listing’s bookable slots.'
    : 'Select a listing to see bookable slots. Availability is unknown, not zero.';

// ── One card per booking (finding 7, A1) ───────────────────────────────────
/// Blocks that carry the same canonical booking id are one commitment shown
/// once, spanning the whole reserved interval. Ids the backend could not
/// resolve stay separate: merging unknowns would hide real busy time.
List<CalBlock> dedupeBookingBlocks(List<CalBlock> blocks) {
  final byBooking = <String, CalBlock>{};
  final out = <CalBlock>[];
  for (final block in blocks) {
    final bookingId = block.bookingId;
    if (bookingId == null || bookingId.isEmpty) {
      out.add(block);
      continue;
    }
    final previous = byBooking[bookingId];
    if (previous == null) {
      byBooking[bookingId] = block;
      out.add(block);
      continue;
    }
    final merged = CalBlock(
      previous.id,
      previous.sourceApp,
      previous.sourceRef,
      previous.startsAt < block.startsAt ? previous.startsAt : block.startsAt,
      previous.endsAt > block.endsAt ? previous.endsAt : block.endsAt,
      previous.title ?? block.title,
      bookingId: bookingId,
      listingId: previous.listingId ?? block.listingId,
      bookingKind: previous.bookingKind ?? block.bookingKind,
      bookingStatus: previous.bookingStatus ?? block.bookingStatus,
      bookingRole: previous.bookingRole ?? block.bookingRole,
    );
    byBooking[bookingId] = merged;
    out[out.indexOf(previous)] = merged;
  }
  out.sort((a, b) => a.startsAt.compareTo(b.startsAt));
  return out;
}

/// Which existing screen manages this diary item. Modern unified reservations
/// (`availability`) and commercial commitments (`avaconsult`) must route to the
/// commercial appointment/session screens with their canonical booking id —
/// never into the legacy /api/calendar/cancel + /reschedule endpoints.
///
/// [review] is the honest answer when the response does not prove whether this
/// account is the creator or the customer: the app offers the safe generic
/// choices instead of guessing an owner.
enum BookingManagement {
  none,
  legacy,
  creatorAppointments,
  creatorEvents,
  customerSessions,
  review,
}

class BookingRoute {
  final BookingManagement management;
  final String? bookingId;
  final String? listingId;
  final String? actionLabel;

  /// True when the commitment is a live event, so the generic "review" choice
  /// can offer the creator's EVENT console rather than their appointments list.
  final bool isEvent;

  const BookingRoute({
    required this.management,
    this.bookingId,
    this.listingId,
    this.actionLabel,
    this.isEvent = false,
  });

  bool get hasManagementAction => management != BookingManagement.none;
}

const Set<String> _eventKinds = {
  'live',
  'live_event',
  'event',
  'avlive',
  'avalive',
};

const Set<String> _appointmentKinds = {
  'consult',
  'consultation',
  'booking',
  'appointment',
  'appointments',
  'session',
  'reservation',
  'availability',
};

BookingRoute bookingRouteForBlock(
  CalBlock block, {
  String? bookingRole,
  Set<String> ownedListingIds = const <String>{},
}) {
  // Legacy AvaBooking rows keep their existing popup actions (they are served
  // by the legacy booking endpoints that already own them).
  if (block.sourceApp == 'avabooking') {
    final legacyId = block.sourceRef;
    if (legacyId == null || legacyId.isEmpty) {
      return const BookingRoute(management: BookingManagement.none);
    }
    return BookingRoute(
      management: BookingManagement.legacy,
      bookingId: legacyId,
      listingId: block.listingId,
      actionLabel: 'Manage booking',
    );
  }

  final isEvent = block.sourceApp == 'avalive' || _eventKinds.contains(
      (block.bookingKind ?? '').toLowerCase());
  if (isPersonalAvailabilityBlock(block)) {
    return const BookingRoute(management: BookingManagement.none);
  }
  final isCommercialSource = block.sourceApp == 'availability' ||
      block.sourceApp == 'avaconsult' ||
      isEvent ||
      _appointmentKinds.contains((block.bookingKind ?? '').toLowerCase());
  if (!isCommercialSource) {
    return const BookingRoute(management: BookingManagement.none);
  }

  final bookingId = block.bookingId;
  final listingId = block.listingId;
  final hasBookingId = bookingId != null && bookingId.isNotEmpty;

  // The server's authoritative role decides FIRST — for events as well as
  // consultations. A purchased live event (role=customer) must never open the
  // creator's event console.
  final role = (block.bookingRole ?? bookingRole ?? '').trim().toLowerCase();
  if (role == 'customer') {
    return BookingRoute(
      management: BookingManagement.customerSessions,
      bookingId: hasBookingId ? bookingId : null,
      listingId: listingId,
      actionLabel: hasBookingId ? 'Manage booking' : 'Open my bookings',
    );
  }
  if (role == 'creator') {
    return BookingRoute(
      management:
          isEvent ? BookingManagement.creatorEvents : BookingManagement.creatorAppointments,
      bookingId: hasBookingId ? bookingId : null,
      listingId: listingId,
      actionLabel: isEvent ? 'Open live event' : 'Manage appointment',
      isEvent: isEvent,
    );
  }

  // No role from the server. Positive ownership evidence is still usable when
  // the creator's listings actually loaded AND contain this listing; an empty
  // or failed listing fetch proves nothing, so it must not be read as "mine".
  final ownershipProven = listingId != null &&
      listingId.isNotEmpty &&
      ownedListingIds.contains(listingId);
  if (ownershipProven) {
    return BookingRoute(
      management:
          isEvent ? BookingManagement.creatorEvents : BookingManagement.creatorAppointments,
      bookingId: hasBookingId ? bookingId : null,
      listingId: listingId,
      actionLabel: isEvent ? 'Open live event' : 'Manage appointment',
      isEvent: isEvent,
    );
  }
  // Unknown role and no ownership proof: offer both safe choices, claim neither.
  return BookingRoute(
    management: BookingManagement.review,
    bookingId: hasBookingId ? bookingId : null,
    listingId: listingId,
    actionLabel: 'Review this booking',
    isEvent: isEvent,
  );
}

/// Real status text for a diary item. When the backend did not resolve a status
/// the app says "Status unavailable" rather than implying a confirmation.
String blockStatusLabel(CalBlock block) {
  final status = (block.bookingStatus ?? '').toLowerCase();
  switch (status) {
    case 'confirmed':
    case 'scheduled':
      return 'Confirmed';
    case 'reserved':
      return 'Reserved';
    case 'held':
      return 'Held — not confirmed yet';
    case 'pending':
      return 'Awaiting confirmation';
    case 'cancelled':
    case 'canceled':
      return 'Cancelled';
    case '':
      return block.bookingId == null || block.bookingId!.isEmpty
          ? 'Busy time'
          : 'Status unavailable';
    default:
      return status[0].toUpperCase() + status.substring(1);
  }
}

/// Sticker kind for a resolved status; unknown stays neutral (never green).
ZineStickerKindHint statusStickerHint(String status) {
  switch (status.toLowerCase()) {
    case 'confirmed':
    case 'scheduled':
    case 'completed':
      return ZineStickerKindHint.ok;
    case 'pending':
    case 'held':
    case 'reserved':
      return ZineStickerKindHint.hint;
    case 'cancelled':
    case 'canceled':
      return ZineStickerKindHint.no;
    default:
      return ZineStickerKindHint.plain;
  }
}

enum ZineStickerKindHint { ok, no, hint, plain }

/// "Editing: all listings" / "Editing: <title>" — finding 9, A8.
String editingScopeLabel({
  required String? selectedListingId,
  required List<ListingCard> listings,
}) {
  if (selectedListingId == null || selectedListingId.isEmpty) {
    return 'Editing: all listings';
  }
  for (final listing in listings) {
    if (listing.id == selectedListingId) return 'Editing: ${listing.title}';
  }
  return 'Editing: this listing';
}

/// Personal busy time is creator-wide by default; a listing filter changes what
/// is DISPLAYED, not what a new block applies to unless the creator asks.
String blockScopeLabel({required bool listingScoped, String? listingTitle}) =>
    listingScoped
        ? 'Only this listing${listingTitle == null ? '' : ' ($listingTitle)'}'
        : 'All listings (personal busy time)';

// ── Effective notice + horizon honesty (finding 10, review item 6) ─────────
/// The server's fallback when a listing does not set a commercial notice:
/// 24 hours (worker/src/cal/engine.ts — `commercial_booking_notice_hours ?? 24`).
const int kDefaultCommercialNoticeMin = 24 * 60;

/// A listing's own commercial booking notice in minutes, matching the server
/// rule. The LISTING attrs are read directly (never [ListingCard]'s convenience
/// getter, whose fallback is 2 h) so the app cannot under-report a listing that
/// relies on the server's 24 h default.
int commercialNoticeMinutesFromAttrs(Map<String, dynamic>? attrs) {
  final raw = attrs == null ? null : attrs['commercial_booking_notice_hours'];
  if (raw is num) {
    final minutes = (raw * 60).round();
    return minutes < 0 ? 0 : minutes;
  }
  return kDefaultCommercialNoticeMin;
}

class NoticePolicySummary {
  final int effectiveMinNoticeMin;
  final int calendarNoticeMin;
  final int? listingCommercialNoticeMin;
  final bool fromServerEffective;
  final String? listingTitle;

  const NoticePolicySummary({
    required this.effectiveMinNoticeMin,
    required this.calendarNoticeMin,
    this.listingCommercialNoticeMin,
    this.fromServerEffective = false,
    this.listingTitle,
  });
}

/// The effective notice a customer actually faces. When the backend exposes an
/// authoritative effective value (additive `effective_min_notice_min`), that
/// wins; otherwise the app applies the same "larger value applies" rule the
/// engine uses, with the listing's commercial notice defaulting to 24 h.
NoticePolicySummary noticePolicySummary({
  required int calendarNoticeMin,
  int? listingCommercialNoticeMin,
  int? authoritativeEffectiveMinNoticeMin,
  String? listingTitle,
}) {
  final calendar = calendarNoticeMin < 0 ? 0 : calendarNoticeMin;
  if (authoritativeEffectiveMinNoticeMin != null &&
      authoritativeEffectiveMinNoticeMin >= 0) {
    return NoticePolicySummary(
      effectiveMinNoticeMin: authoritativeEffectiveMinNoticeMin,
      calendarNoticeMin: calendar,
      listingCommercialNoticeMin: listingCommercialNoticeMin,
      fromServerEffective: true,
      listingTitle: listingTitle,
    );
  }
  final listing = listingCommercialNoticeMin;
  final effective =
      listing == null || calendar >= listing ? calendar : listing;
  return NoticePolicySummary(
    effectiveMinNoticeMin: effective,
    calendarNoticeMin: calendar,
    listingCommercialNoticeMin: listing,
    listingTitle: listingTitle,
  );
}

String noticeMinutesLabel(int minutes) {
  if (minutes <= 0) return 'no minimum';
  if (minutes % 1440 == 0) {
    final days = minutes ~/ 1440;
    return days == 1 ? '1 day' : '$days days';
  }
  if (minutes % 60 == 0) return '${minutes ~/ 60} h';
  return '$minutes min';
}

String noticePolicyLine(NoticePolicySummary summary) {
  if (summary.listingTitle == null) {
    return 'Effective minimum notice: ${noticeMinutesLabel(summary.effectiveMinNoticeMin)} '
        'from your calendar. A listing can require longer notice; the larger value applies.';
  }
  if (summary.fromServerEffective) {
    return 'Effective minimum notice for ${summary.listingTitle}: '
        '${noticeMinutesLabel(summary.effectiveMinNoticeMin)} (confirmed by the server).';
  }
  if (summary.listingCommercialNoticeMin == null) {
    return 'Effective minimum notice for ${summary.listingTitle}: at least '
        '${noticeMinutesLabel(summary.effectiveMinNoticeMin)} from your calendar. This '
        'listing\u2019s commercial notice could not be read, so the real value may be longer.';
  }
  return 'Effective minimum notice for ${summary.listingTitle}: '
      '${noticeMinutesLabel(summary.effectiveMinNoticeMin)} — the larger of the calendar '
      '(${noticeMinutesLabel(summary.calendarNoticeMin)}) and the listing\u2019s commercial notice '
      '(${noticeMinutesLabel(summary.listingCommercialNoticeMin!)}, 24 h when unset).';
}

/// The stored horizon the server will actually accept, or null when the cached
/// value is outside 1..62 and the next save omits it.
int? storedHorizonDays(AvailabilitySchedule schedule) =>
    schedule.horizonDays >= 1 && schedule.horizonDays <= kMaxHorizonDays
        ? schedule.horizonDays
        : null;

/// Explains an omitted horizon instead of implying the value on screen was saved.
String? horizonPersistenceNotice(AvailabilitySchedule schedule) {
  if (storedHorizonDays(schedule) != null) return null;
  return 'Your stored booking horizon (${schedule.horizonDays} days) is outside the '
      'supported 1–$kMaxHorizonDays-day range. AvaTOK will not save a horizon until you set '
      'one, so listings fall back to the server default.';
}

// ── View orchestration (review item 7) ─────────────────────────────────────
enum CalendarNoticeKind { error, stale, google, partial }

class CalendarNotice {
  final CalendarNoticeKind kind;
  final String message;

  const CalendarNotice({required this.kind, required this.message});
}

/// The diary's banners as data, so the orchestration (which failure produces
/// which warning) is testable without an emulator. An empty list means the page
/// may be treated as complete.
List<CalendarNotice> calendarNotices({
  String? error,
  bool stale = false,
  GcalReadiness? gcal,
  List<String> failedSources = const <String>[],
}) {
  final notices = <CalendarNotice>[];
  if (error != null && error.isNotEmpty) {
    notices.add(CalendarNotice(kind: CalendarNoticeKind.error, message: error));
  }
  if (stale) {
    notices.add(const CalendarNotice(
        kind: CalendarNoticeKind.stale,
        message: 'Showing a saved snapshot until the refresh completes.'));
  }
  if (gcal != null && gcal.pausesBookings) {
    notices.add(CalendarNotice(
        kind: CalendarNoticeKind.google,
        message: 'Google Calendar: ${gcal.detail}'));
  }
  if (failedSources.isNotEmpty) {
    notices.add(CalendarNotice(
        kind: CalendarNoticeKind.partial,
        message: partialFailureMessage(failedSources)));
  }
  return notices;
}

String partialFailureMessage(List<String> failedSources) {
  if (failedSources.isEmpty) return '';
  return 'Some calendar data could not be refreshed (${failedSources.join(', ')}). '
      'Time you cannot see here is NOT confirmed free — pull to refresh before relying on this day.';
}

/// Foreground refresh gate. The first resume after opening always refreshes; a
/// second resume inside [minGap] does not, so a creator flicking between apps
/// does not hammer the API.
bool shouldRefreshOnResume({
  DateTime? lastRefreshAt,
  required DateTime now,
  Duration minGap = const Duration(seconds: 20),
}) {
  if (lastRefreshAt == null) return true;
  final elapsed = now.difference(lastRefreshAt);
  if (elapsed.isNegative) return true;
  return elapsed >= minGap;
}

/// Identity is the account, not the load counter: an async load that started
/// under account A must never render or save under account B.
bool accountScopeChanged({String? captured, required String? current}) =>
    captured != current;

class GcalSyncOutcome {
  final GcalReadiness? readiness;
  final bool reloadStatus;
  final String message;
  final String messageIfReloadFails;

  const GcalSyncOutcome({
    this.readiness,
    this.reloadStatus = false,
    required this.message,
    String? messageIfReloadFails,
  }) : messageIfReloadFails = messageIfReloadFails ?? message;
}

/// What the manual-sync button may say. A 404/405 means the deployed backend
/// has no sync route: that is "not synced", never "synced".
GcalSyncOutcome gcalSyncOutcome({
  required bool ok,
  required bool routeUnavailable,
  Map<String, dynamic> json = const <String, dynamic>{},
  String? error,
}) {
  if (routeUnavailable) {
    return GcalSyncOutcome(
        message:
            'This server does not offer manual sync yet. Busy times still import automatically — nothing was reported as synced.');
  }
  if (!ok) {
    return GcalSyncOutcome(
      reloadStatus: true,
      message: error ?? 'Google sync failed. Nothing was reported as synced.',
    );
  }
  if (json['connected'] is bool) {
    final readiness = gcalReadinessFromStatus(json);
    return GcalSyncOutcome(
      readiness: readiness,
      message: readiness.isReady ? 'Busy times synced.' : readiness.detail,
    );
  }
  return GcalSyncOutcome(
    reloadStatus: true,
    message: 'Sync request sent. Busy times were re-checked.',
    messageIfReloadFails: 'Sync ran, but the new status could not be read.',
  );
}

// ── Google readiness (findings 5, 6) ───────────────────────────────────────
enum GcalState { notConnected, checking, syncing, ready, needsAttention, unknown }

class GcalCalendarStatus {
  final String id;
  final String summary;
  final String timezone;
  final bool selected;
  final bool destination;
  final bool primary;
  final int? lastSuccessAt;
  final String? lastError;

  const GcalCalendarStatus({
    required this.id,
    required this.summary,
    this.timezone = 'UTC',
    this.selected = false,
    this.destination = false,
    this.primary = false,
    this.lastSuccessAt,
    this.lastError,
  });

  factory GcalCalendarStatus.fromJson(Map<String, dynamic> json) {
    final rawError = json['last_error'];
    final error = rawError is String && rawError.trim().isNotEmpty
        ? rawError.trim()
        : null;
    return GcalCalendarStatus(
      id: (json['id'] ?? '').toString(),
      summary: (json['summary'] ?? 'Calendar').toString(),
      timezone: (json['timezone'] ?? 'UTC').toString(),
      selected: json['selected'] == true,
      destination: json['destination'] == true,
      primary: json['primary'] == true,
      lastSuccessAt: (json['last_success_at'] as num?)?.toInt(),
      lastError: error,
    );
  }

  bool get failed => lastError != null;
  bool get hasSynced => (lastSuccessAt ?? 0) > 0;

  bool isStale(DateTime now, Duration maxAge) {
    if (!hasSynced) return true;
    return now.millisecondsSinceEpoch - lastSuccessAt! > maxAge.inMilliseconds;
  }
}

class GcalReadiness {
  final GcalState state;
  final String label;
  final String detail;
  final int? lastSuccessAt;
  final List<GcalCalendarStatus> calendars;
  final String? destinationCalendarId;

  const GcalReadiness({
    required this.state,
    required this.label,
    required this.detail,
    this.lastSuccessAt,
    this.calendars = const <GcalCalendarStatus>[],
    this.destinationCalendarId,
  });

  bool get isReady => state == GcalState.ready;

  /// Never label an unverifiable response healthy (finding 5/6).
  bool get pausesBookings =>
      state == GcalState.notConnected ||
      state == GcalState.needsAttention ||
      state == GcalState.syncing ||
      state == GcalState.unknown;

  List<GcalCalendarStatus> get selectedCalendars =>
      calendars.where((c) => c.selected).toList(growable: false);

  List<GcalCalendarStatus> get staleSelections => selectedCalendars
      .where((c) => c.failed || !c.hasSynced)
      .toList(growable: false);
}

GcalReadiness gcalChecking() => const GcalReadiness(
      state: GcalState.checking,
      label: 'Checking…',
      detail: 'Reading Google Calendar status.',
    );

GcalReadiness gcalUnknown(String detail) => GcalReadiness(
      state: GcalState.unknown,
      label: 'Status unavailable',
      detail: detail,
    );

/// Readiness derived from `GET /api/calendar/gcal/status`.
///
/// `ready`/`reason`/`last_success_at` are additive fields. When a deployed
/// backend predates them the app reports "Status unavailable" and keeps the
/// booking call-to-action honest instead of claiming the calendar is healthy.
GcalReadiness gcalReadinessFromStatus(
  Map<String, dynamic>? status, {
  DateTime? now,
  Duration maxAge = const Duration(minutes: 30),
}) {
  if (status == null) {
    return gcalUnknown(
        'Google Calendar status could not be read. Treat busy times as unverified.');
  }
  final connected = status['connected'] == true;
  final calendars = ((status['calendars'] as List?) ?? const [])
      .whereType<Map>()
      .map((row) => GcalCalendarStatus.fromJson(row.cast<String, dynamic>()))
      .toList(growable: false);
  final lastSuccessAt = (status['last_success_at'] as num?)?.toInt();
  final rawError = status['last_error'];
  final lastError =
      rawError is String && rawError.trim().isNotEmpty ? rawError.trim() : null;
  final destination = (status['destination_calendar_id'] as String?)?.trim();

  if (!connected) {
    return GcalReadiness(
      state: GcalState.notConnected,
      label: 'Not connected',
      detail:
          'Customers cannot book until Google Calendar is connected and its busy times have synced.',
      calendars: calendars,
      destinationCalendarId: destination,
    );
  }

  if (!status.containsKey('ready')) {
    return GcalReadiness(
      state: GcalState.unknown,
      label: 'Status unavailable',
      detail:
          'This build cannot verify Google sync readiness yet. New bookings stay paused until the server confirms a recent sync.',
      lastSuccessAt: lastSuccessAt,
      calendars: calendars,
      destinationCalendarId: destination,
    );
  }

  final ready = status['ready'] == true;
  final reason = (status['reason'] as String?)?.trim();

  if (ready) {
    if (lastError != null) {
      return GcalReadiness(
        state: GcalState.needsAttention,
        label: 'Needs attention',
        detail: lastError,
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    }
    final clock = now ?? DateTime.now();
    final stale = calendars
        .where((c) => c.selected && (c.failed || c.isStale(clock, maxAge)))
        .toList(growable: false);
    if (stale.isNotEmpty) {
      final names = stale
          .map((c) => c.failed ? '${c.summary} (failed)' : '${c.summary} (stale)')
          .join(', ');
      return GcalReadiness(
        state: GcalState.needsAttention,
        label: 'Needs attention',
        detail: 'Some selected calendars are not syncing: $names.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    }
    if (lastSuccessAt == null) {
      return GcalReadiness(
        state: GcalState.unknown,
        label: 'Status unavailable',
        detail:
            'The server reports readiness without a successful sync time, so recency cannot be verified.',
        calendars: calendars,
        destinationCalendarId: destination,
      );
    }
    return GcalReadiness(
      state: GcalState.ready,
      label: 'Ready',
      detail: 'Busy times from the selected Google calendars are imported.',
      lastSuccessAt: lastSuccessAt,
      calendars: calendars,
      destinationCalendarId: destination,
    );
  }

  switch (reason) {
    case 'disconnected':
      return GcalReadiness(
        state: GcalState.notConnected,
        label: 'Not connected',
        detail:
            'Customers cannot book until Google Calendar is connected and its busy times have synced.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    case 'pending':
      return GcalReadiness(
        state: GcalState.syncing,
        label: 'Syncing',
        detail:
            'Busy times have not synced yet. Sync now, or wait for the next automatic import.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    case 'stale':
      return GcalReadiness(
        state: GcalState.needsAttention,
        label: 'Needs attention',
        detail:
            'Busy times are out of date. Sync now so AvaTOK does not offer time that Google already holds.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    case 'no_selected_calendars':
      return GcalReadiness(
        state: GcalState.needsAttention,
        label: 'Needs attention',
        detail:
            'No Google calendar is selected, so its busy times cannot protect this schedule.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    case 'error':
      return GcalReadiness(
        state: GcalState.needsAttention,
        label: 'Needs attention',
        detail: lastError ??
            'Google sync reported an error. Reconnect or sync again to recover.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
    default:
      return GcalReadiness(
        state: GcalState.needsAttention,
        label: 'Needs attention',
        detail: lastError ??
            'Google sync is not ready. New bookings stay paused until this is resolved.',
        lastSuccessAt: lastSuccessAt,
        calendars: calendars,
        destinationCalendarId: destination,
      );
  }
}

// ── Timezone-safe rendering (finding 8) ────────────────────────────────────
DateTime calendarTime(DateTime instant, String timezone) {
  try {
    return AvailabilityTime.inTimezone(instant, timezone);
  } catch (_) {
    return instant.toUtc();
  }
}

String hm(DateTime value) =>
    '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';

String clockRangeInZone(int startMs, int endMs, String timezone) {
  final start = calendarTime(DateTime.fromMillisecondsSinceEpoch(startMs), timezone);
  final end = calendarTime(DateTime.fromMillisecondsSinceEpoch(endMs), timezone);
  return '${hm(start)}–${hm(end)}';
}

/// Whole-day blocks read as "All day"; a 0–1440 interval never renders as an
/// apparently empty "00:00–00:00".
String blockTimeLabel({
  required int startMs,
  required int endMs,
  required String timezone,
}) {
  final start = calendarTime(DateTime.fromMillisecondsSinceEpoch(startMs), timezone);
  final end = calendarTime(DateTime.fromMillisecondsSinceEpoch(endMs), timezone);
  final minutes = (endMs - startMs) ~/ 60000;
  // A whole-day block runs local midnight → local midnight, i.e. the end is the
  // NEXT day, so "same day" can never describe it. It must read as "All day"
  // rather than as an apparently empty 00:00–00:00.
  if (minutes >= 1440 && start.hour == 0 && start.minute == 0) {
    if (minutes == 1440) return 'All day';
    return 'All day · ${start.day} ${monthShort(start)} – ${end.day} ${monthShort(end)}';
  }
  return clockRangeInZone(startMs, endMs, timezone);
}

String blockDateLabel({
  required int epochMs,
  required String timezone,
}) {
  final day = calendarTime(DateTime.fromMillisecondsSinceEpoch(epochMs), timezone);
  return '${day.day} ${monthShort(day)} ${day.year}';
}

String minutesRangeLabel(int startMin, int endMin) {
  if (startMin <= AvailabilityException.allDayStartMin &&
      endMin >= AvailabilityException.allDayEndMin) {
    return 'All day';
  }
  final start = '${(startMin ~/ 60).toString().padLeft(2, '0')}:${(startMin % 60).toString().padLeft(2, '0')}';
  final end = '${(endMin ~/ 60).toString().padLeft(2, '0')}:${(endMin % 60).toString().padLeft(2, '0')}';
  return '$start–$end';
}

String timezoneLabel(String? timezone) =>
    timezone == null || timezone.isEmpty ? 'Timezone unknown' : 'Times in $timezone';

String deviceTimeLabel(int epochMs) {
  final local = DateTime.fromMillisecondsSinceEpoch(epochMs);
  return 'Your device: ${hm(local)}';
}

String updatedAtLabel(DateTime? at) {
  if (at == null) return 'Not updated yet';
  return 'Updated ${hm(at)}';
}

/// Human label for an exception row in the day editor.
String exceptionLabel(
  AvailabilityException exception, {
  String Function(String? listingId)? listingTitle,
}) {
  final range = exception.isAllDay || exception.looksLikeMidnightToMidnight
      ? 'All day'
      : minutesRangeLabel(exception.startMin, exception.endMin);
  switch (exception.status) {
    case AvailabilityExceptionStatus.available:
      return "I'm available · $range";
    case AvailabilityExceptionStatus.unavailable:
      return "I'm busy · $range";
    case AvailabilityExceptionStatus.reserved:
      final title = listingTitle?.call(exception.listingId);
      return 'Kept for ${title ?? 'a listing'} · $range';
  }
}
