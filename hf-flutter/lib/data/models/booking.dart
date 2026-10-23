/// Booking shapes (HF-WIRE-8). Dates are IST dates written `YYYY-MM-DD`, times are 24-hour `HH:MM` in IST.
/// Money is whole paise.
library;

import '../call_flags.dart';

int _i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;
String? _s(Object? v) => v is String && v.isNotEmpty ? v : null;

/// `2026-10-21` for a calendar day (no time zone maths: the person's calendar day).
String isoDay(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// Accepts `2026-10-21` and the demo's unpadded `2026-10-21` style (`2026-10-2`). Null when it is not a date.
DateTime? parseDay(String? k) {
  if (k == null || k.isEmpty) return null;
  final p = k.split('-').map(int.tryParse).toList();
  if (p.length != 3 || p.any((x) => x == null)) return null;
  return DateTime(p[0]!, p[1]!, p[2]!);
}

/// `16:00` -> `4:00 pm`, `09:00` -> `9:00 am`, `12:00` -> `12:00 pm`. Anything else is returned as it came.
String slotLabel(String hhmm) {
  final m = RegExp(r'^(\d{2}):(\d{2})$').firstMatch(hhmm);
  if (m == null) return hhmm;
  final h = int.parse(m.group(1)!);
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:${m.group(2)} ${h < 12 ? 'am' : 'pm'}';
}

/// One topic a fan can pick for a booking (`{slug, label}`), [HF-BOOK-APPROVE].
class BookingTopic {
  const BookingTopic({required this.slug, required this.label});

  /// Null when the value is not a `{slug, label}` map (an old server, or a booking with no topic).
  static BookingTopic? tryParse(Object? v) {
    if (v is! Map) return null;
    final slug = _s(v['slug']);
    if (slug == null) return null;
    return BookingTopic(slug: slug, label: _s(v['label']) ?? slug);
  }

  final String slug;
  final String label;
}

/// "17 h", "2 h 20 min", "35 min", "any moment now". Used for the 24-hour approval countdown.
String countdownLabel(Duration left) {
  if (left.inSeconds <= 0) return 'any moment now';
  final mins = (left.inSeconds / 60).ceil();
  if (mins < 60) return '$mins min';
  final h = mins ~/ 60;
  final m = mins % 60;
  if (h >= 6 || m == 0) return '$h h';
  return '$h h $m min';
}

/// "starts in 25 min", "starts in 3 h", "starts in 2 days", or "starting now" / "started" when it is not ahead of [now].
String startsInLabel(DateTime start, DateTime now) {
  final left = start.difference(now);
  if (left.inSeconds <= 0) return left.inMinutes > -10 ? 'starting now' : 'started';
  final mins = (left.inSeconds / 60).ceil();
  if (mins < 60) return 'starts in $mins min';
  if (mins < 48 * 60) return 'starts in ${mins ~/ 60} h';
  return 'starts in ${mins ~/ (24 * 60)} days';
}

/// `GET/PUT /api/hf/hosts/me/rate` and the `rate` block of the availability response.
/// [hostGetsPerMinPaise] comes from the SERVER's split rule; the app never does this maths itself.
class RateInfo {
  const RateInfo({
    required this.ratePerMin,
    required this.minRate,
    required this.maxRate,
    required this.editable,
    required this.hostGetsPerMinPaise,
    this.fixedMessage,
  });

  factory RateInfo.fromJson(Map<String, dynamic> j) => RateInfo(
        ratePerMin: _i(j['ratePerMin']),
        minRate: _i(j['minRate']),
        maxRate: _i(j['maxRate']),
        editable: j['editable'] != false,
        hostGetsPerMinPaise: _i(j['hostGetsPerMinPaise']),
        fixedMessage: _s(j['fixedMessage']),
      );

  final int ratePerMin;
  final int minRate;
  final int maxRate;

  /// False when the Standard plan sets one rate for everyone.
  final bool editable;
  final int hostGetsPerMinPaise;
  final String? fixedMessage;

  RateInfo withRate(int rate, int hostGetsPaise) => RateInfo(
        ratePerMin: rate,
        minRate: minRate,
        maxRate: maxRate,
        editable: editable,
        hostGetsPerMinPaise: hostGetsPaise,
        fixedMessage: fixedMessage,
      );
}

/// One calendar day of the influencer's availability.
class DayPlan {
  const DayPlan({required this.open, required this.slots});
  final bool open;
  final Set<String> slots;
}

/// `GET /api/hf/hosts/me/availability`.
class HostAvailability {
  const HostAvailability({
    required this.version,
    required this.today,
    required this.horizonDays,
    required this.slotChoices,
    required this.days,
    required this.booked,
    required this.rate,
    this.chipMinutes = 0,
    this.durationsMinutes = const [],
  });

  factory HostAvailability.fromJson(Map<String, dynamic> j) {
    final days = <String, DayPlan>{};
    final rawDays = j['days'];
    if (rawDays is Map) {
      rawDays.forEach((k, v) {
        if (v is Map) {
          final slots = v['slots'];
          days['$k'] = DayPlan(open: v['open'] == true, slots: {if (slots is List) for (final s in slots) '$s'});
        }
      });
    }
    final booked = <String, Set<String>>{};
    final rawBooked = j['booked'];
    if (rawBooked is Map) {
      rawBooked.forEach((k, v) => booked['$k'] = {if (v is List) for (final s in v) '$s'});
    }
    final choices = j['slotChoices'];
    return HostAvailability(
      version: _i(j['version']),
      today: _s(j['today']) ?? isoDay(DateTime.now()),
      horizonDays: _i(j['horizonDays']) == 0 ? 21 : _i(j['horizonDays']),
      slotChoices: choices is List ? [for (final c in choices) '$c'] : const [],
      days: days,
      booked: booked,
      rate: RateInfo.fromJson(j['rate'] is Map ? Map<String, dynamic>.from(j['rate'] as Map) : <String, dynamic>{}),
      chipMinutes: _i(j['chipMinutes']),
      durationsMinutes: [
        if (j['durationsMinutes'] is List)
          for (final e in j['durationsMinutes'] as List)
            if (e is num && e > 0) e.round(),
      ],
    );
  }

  /// [HF-CALL-MODES-INT-CLIENTS] How long one tick opens (60 = a whole hour) and the lengths sold, sent by the server only while
  /// booking lengths are on. 0 / empty on an old server or with the flag off (one tick = one 10-minute time).
  final int chipMinutes;
  final List<int> durationsMinutes;

  final int version;
  final String today;
  final int horizonDays;
  final List<String> slotChoices;
  final Map<String, DayPlan> days;
  final Map<String, Set<String>> booked;
  final RateInfo rate;

  /// Last date the server lets her open (`YYYY-MM-DD`).
  String get lastDay => isoDay(parseDay(today)!.add(Duration(days: horizonDays - 1)));

  bool isOpen(String day) => days[day]?.open == true;
  Set<String> slotsOn(String day) => days[day]?.slots ?? const <String>{};
}

/// `GET /api/hf/hosts/:slug/slots`: only free slots.
class HostSlots {
  const HostSlots({
    required this.minutes,
    required this.ratePerMin,
    required this.holdPaise,
    required this.today,
    required this.lastDate,
    required this.days,
    this.topics = const [],
    this.approvalMode,
    this.durationsMinutes = const [],
    this.holdMinutes,
  });

  factory HostSlots.fromJson(Map<String, dynamic> j) {
    final days = <String, List<String>>{};
    final raw = j['days'];
    if (raw is Map) {
      raw.forEach((k, v) {
        if (v is List && v.isNotEmpty) days['$k'] = [for (final s in v) '$s'];
      });
    }
    return HostSlots(
      minutes: _i(j['minutes']) == 0 ? defaultBookingMinutes() : _i(j['minutes']),
      ratePerMin: _i(j['ratePerMin']),
      holdPaise: _i(j['holdPaise']),
      today: _s(j['today']) ?? isoDay(DateTime.now()),
      lastDate: _s(j['lastDate']) ?? isoDay(DateTime.now().add(const Duration(days: 20))),
      days: days,
      topics: [
        if (j['topics'] is List)
          for (final e in j['topics'] as List)
            if (BookingTopic.tryParse(e) != null) BookingTopic.tryParse(e)!,
      ],
      approvalMode: j['approvalMode'] == 'manual' || j['approvalMode'] == 'auto' ? j['approvalMode'] as String : null,
      durationsMinutes: [
        if (j['durationsMinutes'] is List)
          for (final e in j['durationsMinutes'] as List)
            if (e is num && e > 0) e.round(),
      ],
      holdMinutes: _i(j['holdMinutes']) > 0 ? _i(j['holdMinutes']) : null,
    );
  }

  /// [HF-CALL-MODES-E2] The lengths this influencer sells (minutes), when booking lengths are on server-side. Empty on an old server.
  final List<int> durationsMinutes;

  /// [HF-CALL-MODES-E2] How many minutes the hold covers (15), when the server says. Null on an old server.
  final int? holdMinutes;

  final int minutes;
  final int ratePerMin;
  final int holdPaise;
  final String today;
  final String lastDate;

  /// Date -> free `HH:MM` slots. Closed days are simply missing.
  final Map<String, List<String>> days;

  /// This influencer's topics for the fan's picker. Empty when the approval feature is off on the server.
  final List<BookingTopic> topics;

  /// `manual` or `auto`; null while the approval feature is off (the server then sends neither field).
  final String? approvalMode;

  /// True when a booking waits for the influencer to accept it.
  bool get needsApproval => approvalMode == 'manual';

  Set<String> get openDays => days.keys.toSet();
  List<String> slotsOn(String day) => days[day] ?? const [];
}

/// One booking, from either side. Fan rows have [hostSlug]/[hostName]; influencer rows have [fanHandle]/[note].
/// There is never a phone number in here.
class AppBooking {
  const AppBooking({
    required this.id,
    required this.status,
    required this.startAt,
    required this.day,
    required this.time,
    required this.minutes,
    required this.holdPaise,
    required this.canCancel,
    required this.cancelRule,
    this.cancelBlockedText,
    this.hostSlug,
    this.hostName,
    this.fanHandle,
    this.note = '',
    this.expectedNetPaise = 0,
    this.approvalDeadline,
    this.topic,
    this.cancelReason,
    this.statusText,
    this.canAccept = false,
    this.canDecline = false,
    this.freeCancelUntil,
  });

  /// Reads both server shapes: the app list (`startAt`, `minutes`, `fanHandle`, `holdPaise`) and the older detail
  /// shape (`startUtc`, `durationMinutes`, `customerHandle`, `reservedPaise`). Day and time are worked out in IST when absent.
  factory AppBooking.fromJson(Map<String, dynamic> j) {
    final start = DateTime.tryParse('${j['startAt'] ?? j['startUtc'] ?? ''}')?.toLocal() ?? DateTime.fromMillisecondsSinceEpoch(0);
    final haveStart = start.millisecondsSinceEpoch > 0;
    final ist = start.toUtc().add(const Duration(hours: 5, minutes: 30));
    final mins = _i(j['minutes']) > 0 ? _i(j['minutes']) : _i(j['durationMinutes']);
    final status = '${j['status'] ?? ''}';
    final hostView = _s(j['fanHandle']) != null || _s(j['customerHandle']) != null;
    return AppBooking(
        id: '${j['id'] ?? ''}',
        status: status,
        startAt: start,
        day: _s(j['day']) ?? (haveStart ? isoDay(DateTime(ist.year, ist.month, ist.day)) : ''),
        time: _s(j['time']) ?? (haveStart ? '${ist.hour.toString().padLeft(2, '0')}:${ist.minute.toString().padLeft(2, '0')}' : ''),
        minutes: mins == 0 ? defaultBookingMinutes() : mins,
        holdPaise: _i(j['holdPaise']) > 0 ? _i(j['holdPaise']) : _i(j['reservedPaise']),
        canCancel: j['canCancel'] == true,
        cancelRule: _s(j['cancelRule']) ?? '',
        cancelBlockedText: _s(j['cancelBlockedText']),
        hostSlug: _s(j['hostSlug']),
        hostName: _s(j['hostName']),
        fanHandle: _s(j['fanHandle']) ?? _s(j['customerHandle']),
        note: _s(j['note']) ?? '',
        expectedNetPaise: _i(j['expectedNetPaise']) > 0 ? _i(j['expectedNetPaise']) : _i(j['expectedHostNetPaise']),
        approvalDeadline: j['approvalDeadline'] is String ? DateTime.tryParse(j['approvalDeadline'] as String)?.toLocal() : null,
        topic: BookingTopic.tryParse(j['topic']),
        cancelReason: _s(j['cancelReason']),
        statusText: _s(j['statusText']),
        // The older detail shape has no accept/decline flags: an influencer's waiting booking can be decided (the server still checks).
        canAccept: j.containsKey('canAccept') ? j['canAccept'] == true : (status == 'pending_approval' && hostView),
        canDecline: j.containsKey('canDecline') ? j['canDecline'] == true : (status == 'pending_approval' && hostView),
        freeCancelUntil: j['freeCancelUntil'] is String ? DateTime.tryParse(j['freeCancelUntil'] as String)?.toLocal() : null,
      );
  }

  final String id;
  final String status;
  final DateTime startAt;

  /// IST date `YYYY-MM-DD` and `HH:MM`.
  final String day;
  final String time;
  final int minutes;
  final int holdPaise;
  final bool canCancel;
  final String cancelRule;

  /// Why the fan can no longer cancel for free (shown instead of the normal dialog text).
  final String? cancelBlockedText;
  final String? hostSlug;
  final String? hostName;
  final String? fanHandle;
  final String note;
  final int expectedNetPaise;

  /// [HF-BOOK-APPROVE] All absent (null / false) while the approval feature is off on the server.
  /// While [isPending]: when the booking is cancelled and refunded if nobody accepts it.
  final DateTime? approvalDeadline;
  final BookingTopic? topic;

  /// `declined`, `not_accepted_24h`, `fan`, `host` on a cancelled booking.
  final String? cancelReason;

  /// The server's own plain-English line for this booking's state, in the viewer's words.
  final String? statusText;
  final bool canAccept;
  final bool canDecline;

  /// Fan rows: the last moment the booking can be cancelled for free (an hour before the call). Null when the server did not say.
  final DateTime? freeCancelUntil;

  /// True for the influencer's own view of a booking (it carries the fan's handle), false for the fan's.
  bool get viewerIsHost => fanHandle != null;

  bool get isPending => status == 'pending_approval';
  bool get isCancelled => status == 'cancelled';

  /// Over for good: not waiting, not upcoming.
  bool get isPast => status == 'completed' || status == 'cancelled' || status == 'failed';

  DateTime get date => parseDay(day) ?? DateTime(startAt.year, startAt.month, startAt.day);
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "24 Oct, 6:30 pm" for an IST [day] (`YYYY-MM-DD`) and [hhmm] (`18:30`). Falls back to what it was given.
String indianWhen(String day, String hhmm) {
  final d = parseDay(day);
  if (d == null) return slotLabel(hhmm);
  return '${d.day} ${_months[d.month - 1]}, ${slotLabel(hhmm)}';
}

/// The influencer's bird's-eye numbers for her calendar chips: `GET /api/hf/bookings/summary` -> `{summary}`.
/// [waitingCount] = requests waiting for her yes; [bookedDays] = different days (IST) that have a booking or a request.
class HostBookingSummary {
  const HostBookingSummary({required this.waitingCount, required this.bookedDays, this.upcomingCount = 0, this.expectedNetPaise = 0});

  factory HostBookingSummary.fromJson(Map<String, dynamic> j) {
    final s = j['summary'] is Map ? Map<String, dynamic>.from(j['summary'] as Map) : j;
    return HostBookingSummary(
      waitingCount: _i(s['waitingCount']),
      bookedDays: _i(s['bookedDays']),
      upcomingCount: _i(s['upcomingCount']),
      expectedNetPaise: _i(s['expectedHostNetPaise']),
    );
  }

  /// The same two numbers worked out from a list already on screen (used until, or when, the server's own cannot be read).
  factory HostBookingSummary.fromBookings(Iterable<AppBooking> all) {
    final live = [for (final b in all) if (!b.isPast && b.day.isNotEmpty) b];
    return HostBookingSummary(
      waitingCount: live.where((b) => b.isPending).length,
      bookedDays: live.map((b) => b.day).toSet().length,
      upcomingCount: live.where((b) => !b.isPending).length,
    );
  }

  final int waitingCount;
  final int bookedDays;
  final int upcomingCount;
  final int expectedNetPaise;

  String get bookedDaysText => bookedDays == 1 ? '1 day booked' : '$bookedDays days booked';
  String get waitingText => waitingCount == 1 ? '1 request waiting' : '$waitingCount requests waiting';
}

/// The answer to a cancel: the server's own sentence for the toast.
class CancelResult {
  const CancelResult({required this.message, required this.refundPaise});

  factory CancelResult.fromJson(Map<String, dynamic> j) =>
      CancelResult(message: _s(j['message']) ?? 'Booking cancelled.', refundPaise: _i(j['refundPaise']));

  final String message;
  final int refundPaise;
}

/// `POST /api/hf/bookings` answer. [needsApproval] / [approvalText] are only set while the approval feature is on.
class BookResult {
  const BookResult({required this.booking, required this.needsApproval, this.approvalText});

  final AppBooking booking;
  final bool needsApproval;
  final String? approvalText;
}

/// `POST /api/hf/bookings/:id/decline` answer.
class DeclineResult {
  const DeclineResult({required this.booking, required this.refundPaise});

  final AppBooking booking;
  final int refundPaise;
}

/// `GET/PUT /api/hf/hosts/me/booking-settings`.
class BookingSettings {
  const BookingSettings({required this.approval, required this.openAlerts});

  factory BookingSettings.fromJson(Map<String, dynamic> j) =>
      BookingSettings(approval: j['approval'] == 'auto' ? 'auto' : 'manual', openAlerts: j['openAlerts'] != false);

  /// `manual` (default) or `auto`.
  final String approval;
  final bool openAlerts;

  bool get isManual => approval != 'auto';
}
