// [CAL-TIME-1 2026-09-15] Pure, widget-free value objects behind the native
// listing wizard's Time step (AUDIT-2026-09-15 §1 and §11).
//
// WHY THIS FILE EXISTS
// The active wizard used to ask the creator to TYPE `2026-12-31T18:00` into a
// raw ISO box and offered no shared/custom/exclusive availability choice at
// all. The backend only reserves a fixed 1:1 listing at publication when its
// schedule row says `mode: exclusive` (worker/src/routes/listings.ts — the
// `availability_schedules.mode` lookup before publishFixedListing), so a start
// time typed into the form reserved nothing. Everything here is the small,
// testable core of the fix: the window a listing commits to, the wall-clock
// conversion in the LISTING's zone, and the schedule payload built for
// AvailabilityApi.saveSchedule.
import '../../../core/availability_time.dart';
import '../../calendar/calendar_data.dart';

const List<String> _kWeekdayNames = <String>['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const List<String> _kMonthNames = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/// The schema's weekday — 0 = Sunday through 6 = Saturday (availability_rules
/// and availability_schedule_rules both use it).
const List<String> _kSchemaWeekdays = <String>['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

String nativeListingWeekdayName(int weekday) => _kSchemaWeekdays[weekday.clamp(0, 6).toInt()];

/// The shortest horizon the server accepts. putSchedule() validates
/// `horizon_days` as 1..62 (calendar_availability.ts): anything larger is a 400,
/// so a listing schedule that must be re-saved through the wizard has to be
/// clamped — but NOT forced. The web wizard hard-codes 62 and the dead
/// controller forces 62; both silently discard a creator's shorter, deliberate
/// horizon.
const int kNativeListingMinHorizonDays = 1;
const int kNativeListingMaxHorizonDays = 62;

/// `YYYY-MM-DDTHH:MM` — the wall-clock shape `listings.starts_at` is built from.
String nativeListingLocalInput(DateTime value) {
  String p(int n) => n.toString().padLeft(2, '0');
  return '${value.year.toString().padLeft(4, '0')}-${p(value.month)}-${p(value.day)}'
      'T${p(value.hour)}:${p(value.minute)}';
}

/// Reads the stored wall clock back. Never interpreted as a device-local
/// instant — see [nativeListingEpochForWallClock].
DateTime? nativeListingParseLocal(Object? value) {
  final raw = value?.toString().trim() ?? '';
  if (raw.isEmpty) return null;
  return DateTime.tryParse(raw);
}

/// The epoch for a wall clock read in [timezone]. Null when that local time
/// does not exist (a DST spring-forward gap): the server rejects those with
/// "This local time does not exist because of a daylight-saving clock change",
/// so the wizard must report it instead of silently shifting the instant the
/// way `DateTime.tryParse(text)` on the phone's zone did.
int? nativeListingEpochForWallClock({required DateTime wallClock, required String timezone}) {
  try {
    return AvailabilityTime.wallTimeToUtc(
      date: DateTime(wallClock.year, wallClock.month, wallClock.day),
      minutes: wallClock.hour * 60 + wallClock.minute,
      timezone: timezone,
    ).millisecondsSinceEpoch;
  } catch (_) {
    return null;
  }
}

/// `18:00`, and `24:00` for the end-of-day sentinel (end_min = 1440), which is
/// NOT midnight-to-zero: the server's schedule contract allows end_min 1440 and
/// web/src/lib/availability.ts losing that value is exactly AUDIT §2.
String nativeListingClockLabel(int minutes) {
  if (minutes >= 1440) return '24:00';
  final h = (minutes ~/ 60) % 24;
  final m = minutes % 60;
  return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
}

/// `Fri 18 Dec 2026 · 18:00` — no zone suffix; callers add the zone they used.
String nativeListingHumanDateTime(DateTime value) {
  final day = _kWeekdayNames[(value.weekday - 1).clamp(0, 6).toInt()];
  final month = _kMonthNames[(value.month - 1).clamp(0, 11).toInt()];
  return '$day ${value.day} $month ${value.year} · '
      '${nativeListingClockLabel(value.hour * 60 + value.minute)}';
}

/// Converts an instant into a zone for display. Falls back to the device zone
/// only when the zone is unknown to the timezone database — never silently for a
/// real zone, so a DST gap is visible instead of shifted.
DateTime nativeListingInZone(DateTime instant, String timezone) {
  try {
    return AvailabilityTime.inTimezone(instant, timezone);
  } catch (_) {
    return instant.toLocal();
  }
}

/// `Fri 18 Dec 2026 · 18:00–19:00 (Asia/Kolkata)` for a concrete window.
String nativeListingHumanRange(int startAt, int endAt, String timezone) {
  final start = nativeListingInZone(DateTime.fromMillisecondsSinceEpoch(startAt, isUtc: true), timezone);
  final end = nativeListingInZone(DateTime.fromMillisecondsSinceEpoch(endAt, isUtc: true), timezone);
  final sameDay = start.year == end.year && start.month == end.month && start.day == end.day;
  final tail = sameDay
      ? '–${nativeListingClockLabel(end.hour * 60 + end.minute)}'
      : ' – ${nativeListingHumanDateTime(end)}';
  return '${nativeListingHumanDateTime(start)}$tail ($timezone)';
}

int nativeListingClampHorizon(int horizonDays) {
  if (horizonDays < kNativeListingMinHorizonDays) return kNativeListingMinHorizonDays;
  if (horizonDays > kNativeListingMaxHorizonDays) return kNativeListingMaxHorizonDays;
  return horizonDays;
}

/// The window this listing commits to, in epoch millis. Built only when the
/// creator has picked a concrete wall clock (a live event, or an exclusive
/// consult); an on-request consult has none and nothing to preview.
class NativeListingWindow {
  const NativeListingWindow({required this.startAt, required this.endAt, required this.timezone});

  final int startAt;
  final int endAt;
  final String timezone;

  int get durationMin => (endAt - startAt) ~/ 60000;

  /// Identity of the inputs that produced a preview. A response whose signature
  /// no longer matches the screen is stale and must be dropped.
  String get signature => '$startAt:$endAt:$timezone';

  @override
  String toString() => 'NativeListingWindow($signature)';
}

/// [CAL-TIME-1] Which IANA zone the listing's weekly windows are written in.
///
/// putSchedule() refuses a schedule timezone that differs from the creator's
/// other schedules ("All listing schedules use the creator calendar timezone"),
/// so once a listing has its own schedule row (version > 0) its zone is kept.
/// A listing with no row yet adopts the zone the creator just chose for the
/// listing itself.
String nativeListingScheduleZone(AvailabilitySchedule? base, String listingTimezone) {
  if (base != null && base.version > 0 && base.timezone.trim().isNotEmpty) return base.timezone;
  return listingTimezone;
}

/// [CAL-TIME-1] The availability choice plus what the wizard will PUT.
class NativeListingSchedulePlan {
  const NativeListingSchedulePlan({
    required this.mode,
    required this.rules,
    required this.listingTimezone,
  });

  final AvailabilityMode mode;
  final List<AvailabilityRule> rules;
  final String listingTimezone;

  static NativeListingSchedulePlan fromSchedule(AvailabilitySchedule schedule, {required String listingTimezone}) =>
      NativeListingSchedulePlan(
        mode: schedule.mode,
        rules: List<AvailabilityRule>.of(schedule.rules),
        listingTimezone: listingTimezone,
      );

  /// Applies the creator's choice to the schedule the SERVER returned, changing
  /// only what the Time step owns:
  ///  * mode — the shared/custom/exclusive choice the backend reads at publish;
  ///  * rules — replaced for `custom`, preserved otherwise (so switching back to
  ///    "my usual hours" and forth does not silently drop a window the creator
  ///    set on the web);
  ///  * horizon_days — clamped to the server's 1..62, never forced;
  ///  * everything else — timezone, slot interval, buffer, notice, daily cap and
  ///    the FULL exception list — carried through untouched. `exceptions` is a
  ///    full replace on the server, so dropping it here would delete unrelated
  ///    blocked and reserved time.
  AvailabilitySchedule applyTo(AvailabilitySchedule base) {
    final zone = nativeListingScheduleZone(base, listingTimezone);
    return base.copyWith(
      listingId: base.listingId,
      timezone: zone,
      mode: mode,
      // putSchedule() accepts duration_min 5..480 only, and the listing's own
      // duration_min is what the engine actually uses for windows.
      durationMin: base.durationMin < 5 ? 5 : (base.durationMin > 480 ? 480 : base.durationMin),
      slotIntervalMin: base.slotIntervalMin,
      bufferMin: base.bufferMin,
      minNoticeMin: base.minNoticeMin,
      maxPerDay: base.maxPerDay,
      horizonDays: nativeListingClampHorizon(base.horizonDays),
      version: base.version,
      rules: mode == AvailabilityMode.custom ? List<AvailabilityRule>.of(rules) : base.rules,
      exceptions: List<AvailabilityException>.of(base.exceptions),
    );
  }

  /// Client-side mirror of the server's rule shape (putSchedule validates
  /// weekday 0..6 and 0 <= start < end <= 1440). Returns null when acceptable.
  String? validate() {
    if (mode != AvailabilityMode.custom) return null;
    if (rules.isEmpty) {
      return 'Add at least one weekly window for this listing, or use your usual hours.';
    }
    for (final rule in rules) {
      if (rule.weekday < 0 || rule.weekday > 6) return 'Pick a weekday for every window.';
      if (rule.startMin < 0 || rule.endMin > 1440 || rule.endMin <= rule.startMin) {
        return 'Every window needs a start time before its end time.';
      }
    }
    return null;
  }
}
