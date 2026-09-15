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

List<AvailabilityException> mergeExceptions(
  List<AvailabilityException> existing,
  List<AvailabilityException> additions,
) =>
    [...existing, ...additions];

String? validateExceptionCount(int count) => count > kMaxExceptions
    ? 'A schedule can hold at most $kMaxExceptions exceptions. Remove some before adding more.'
    : null;

/// True when [value] describes an interval the server will accept.
bool isValidMinuteRange(int startMin, int endMin) =>
    startMin >= 0 && endMin <= AvailabilityException.allDayEndMin && endMin > startMin;

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
enum BookingManagement { none, legacy, creatorAppointments, creatorEvents, customerSessions }

class BookingRoute {
  final BookingManagement management;
  final String? bookingId;
  final String? listingId;
  final String? actionLabel;

  const BookingRoute({
    required this.management,
    this.bookingId,
    this.listingId,
    this.actionLabel,
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
  final bookingId = block.bookingId;
  final kind = (block.bookingKind ?? '').toLowerCase();
  final role = (bookingRole ?? '').toLowerCase();

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

  final isEvent = block.sourceApp == 'avalive' || _eventKinds.contains(kind);
  final isCommercialSource = block.sourceApp == 'availability' ||
      block.sourceApp == 'avaconsult' ||
      isEvent ||
      _appointmentKinds.contains(kind);
  if (!isCommercialSource) {
    return const BookingRoute(management: BookingManagement.none);
  }

  if (isEvent) {
    return BookingRoute(
      management: BookingManagement.creatorEvents,
      bookingId: bookingId,
      listingId: block.listingId,
      actionLabel: 'Open live event',
    );
  }

  final listingId = block.listingId;
  // A listing the creator provably does NOT own means this occupancy is their
  // own purchase → the customer session screen. With no ownership data (older
  // backend / listings not loaded) the creator surface stays the default: this
  // is the creator diary.
  final knownForeignListing = listingId != null &&
      ownedListingIds.isNotEmpty &&
      !ownedListingIds.contains(listingId);
  if (role == 'customer' || knownForeignListing) {
    if (bookingId == null || bookingId.isEmpty) {
      return BookingRoute(
        management: BookingManagement.customerSessions,
        listingId: listingId,
        actionLabel: 'Open my bookings',
      );
    }
    return BookingRoute(
      management: BookingManagement.customerSessions,
      bookingId: bookingId,
      listingId: listingId,
      actionLabel: 'Manage booking',
    );
  }
  return BookingRoute(
    management: BookingManagement.creatorAppointments,
    bookingId: bookingId,
    listingId: listingId,
    actionLabel: 'Manage appointment',
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
