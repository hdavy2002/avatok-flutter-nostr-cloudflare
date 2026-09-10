// Phase 5 — shared AvaCalendar/AvaBooking data layer. Local-first: the last
// fetched blocks/bookings are cached per-account via DiskCache (rulebook §1 —
// DiskCache already namespaces by AccountScope.id), so the month grid renders
// offline; a network refresh follows.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../identity/identity.dart';

DateTime? _availabilityDateTime(Object? value) {
  if (value is num)
    return DateTime.fromMillisecondsSinceEpoch(value.toInt(), isUtc: true);
  if (value is String) {
    final n = int.tryParse(value);
    if (n != null) return DateTime.fromMillisecondsSinceEpoch(n, isUtc: true);
    return DateTime.tryParse(value);
  }
  return null;
}

DateTime _requiredAvailabilityDateTime(Object? value, String field) {
  final parsed = _availabilityDateTime(value);
  if (parsed == null)
    throw FormatException('Availability response is missing $field');
  return parsed;
}

/// source_app → blip styling (one color per app, used by both screens).
class SourceStyle {
  final String label;
  final Color color;
  final IconData icon;
  const SourceStyle(this.label, this.color, this.icon);
}

// [UI-ICONS-1 2026-08-05] Material glyphs → Phosphor. `PhosphorIcons.x(...)` is
// a FUNCTION CALL, so this map can no longer be `const`; it is `final` instead.
// Both consumers (`avacalendar_screen._legend`, `booking_card`) read it at
// runtime, so nothing downstream needed to change.
final kSourceStyles = <String, SourceStyle>{
  'avacalendar': SourceStyle('AvaCalendar', const Color(0xFFEAB308),
      PhosphorIcons.calendarBlank(PhosphorIconsStyle.regular)),
  'avabooking': SourceStyle('AvaBooking', const Color(0xFFE1306C),
      PhosphorIcons.calendarCheck(PhosphorIconsStyle.regular)),
  'avalive': SourceStyle('AvaLive', const Color(0xFFFF3B30),
      PhosphorIcons.broadcast(PhosphorIconsStyle.regular)),
  'avaconsult': SourceStyle('AvaConsult', const Color(0xFF22C9C0),
      PhosphorIcons.videoCamera(PhosphorIconsStyle.regular)),
  'gcal': SourceStyle('Google Calendar', const Color(0xFF4285F4),
      PhosphorIcons.calendarDots(PhosphorIconsStyle.regular)),
  'manual': SourceStyle('Manual block', const Color(0xFF737A86),
      PhosphorIcons.prohibit(PhosphorIconsStyle.regular)),
};

SourceStyle styleFor(String? sourceApp) =>
    kSourceStyles[sourceApp] ??
    SourceStyle('Busy', const Color(0xFF737A86),
        PhosphorIcons.calendarX(PhosphorIconsStyle.regular));

class CalBlock {
  final String id;
  final String sourceApp;
  final String? sourceRef;
  final int startsAt;
  final int endsAt;
  final String? title;
  CalBlock(this.id, this.sourceApp, this.sourceRef, this.startsAt, this.endsAt,
      this.title);

  factory CalBlock.fromJson(Map<String, dynamic> j) => CalBlock(
        j['id'] as String? ?? '',
        j['source_app'] as String? ?? 'manual',
        j['source_ref'] as String?,
        (j['starts_at'] as num?)?.toInt() ?? 0,
        (j['ends_at'] as num?)?.toInt() ?? 0,
        j['title'] as String?,
      );
  Map<String, dynamic> toJson() => {
        'id': id,
        'source_app': sourceApp,
        'source_ref': sourceRef,
        'starts_at': startsAt,
        'ends_at': endsAt,
        'title': title,
      };
}

/// The server-owned availability schedule shared by the creator calendar and
/// listing booking flows. Keep these models free of widgets so booking can
/// reuse the exact wire contract without importing the calendar screen.
enum AvailabilityMode { shared, custom, exclusive }

AvailabilityMode availabilityModeFromWire(Object? value) {
  switch (value?.toString()) {
    case 'custom':
      return AvailabilityMode.custom;
    case 'exclusive':
      return AvailabilityMode.exclusive;
    default:
      return AvailabilityMode.shared;
  }
}

String availabilityModeToWire(AvailabilityMode value) {
  switch (value) {
    case AvailabilityMode.custom:
      return 'custom';
    case AvailabilityMode.exclusive:
      return 'exclusive';
    case AvailabilityMode.shared:
      return 'shared';
  }
}

enum AvailabilityExceptionStatus { available, unavailable, reserved }

AvailabilityExceptionStatus availabilityExceptionStatusFromWire(Object? value) {
  switch (value?.toString()) {
    case 'available':
      return AvailabilityExceptionStatus.available;
    case 'reserved':
      return AvailabilityExceptionStatus.reserved;
    default:
      return AvailabilityExceptionStatus.unavailable;
  }
}

String availabilityExceptionStatusToWire(AvailabilityExceptionStatus value) {
  switch (value) {
    case AvailabilityExceptionStatus.available:
      return 'available';
    case AvailabilityExceptionStatus.reserved:
      return 'reserved';
    case AvailabilityExceptionStatus.unavailable:
      return 'unavailable';
  }
}

class AvailabilityRule {
  final int weekday;
  final int startMin;
  final int endMin;

  const AvailabilityRule(
      {required this.weekday, required this.startMin, required this.endMin});

  factory AvailabilityRule.fromJson(Map<String, dynamic> json) =>
      AvailabilityRule(
        weekday: (json['weekday'] as num?)?.toInt() ?? 0,
        startMin: (json['start_min'] as num?)?.toInt() ?? 0,
        endMin: (json['end_min'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'weekday': weekday,
        'start_min': startMin,
        'end_min': endMin,
      };

  AvailabilityRule copyWith({int? weekday, int? startMin, int? endMin}) =>
      AvailabilityRule(
        weekday: weekday ?? this.weekday,
        startMin: startMin ?? this.startMin,
        endMin: endMin ?? this.endMin,
      );
}

class AvailabilityException {
  final String id;
  final String date;
  final int startMin;
  final int endMin;
  final AvailabilityExceptionStatus status;
  final String? listingId;

  const AvailabilityException({
    required this.id,
    required this.date,
    required this.startMin,
    required this.endMin,
    required this.status,
    this.listingId,
  });

  factory AvailabilityException.fromJson(Map<String, dynamic> json) =>
      AvailabilityException(
        id: (json['id'] ?? '').toString(),
        date: (json['date'] ?? '').toString(),
        startMin: (json['start_min'] as num?)?.toInt() ?? 0,
        endMin: (json['end_min'] as num?)?.toInt() ?? 1440,
        status: availabilityExceptionStatusFromWire(json['status']),
        listingId: json['listing_id']?.toString(),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        if (id.isNotEmpty) 'id': id,
        'date': date,
        'start_min': startMin,
        'end_min': endMin,
        'status': availabilityExceptionStatusToWire(status),
        if (listingId != null && listingId!.isNotEmpty) 'listing_id': listingId,
      };

  AvailabilityException copyWith({
    String? id,
    String? date,
    int? startMin,
    int? endMin,
    AvailabilityExceptionStatus? status,
    String? listingId,
  }) =>
      AvailabilityException(
        id: id ?? this.id,
        date: date ?? this.date,
        startMin: startMin ?? this.startMin,
        endMin: endMin ?? this.endMin,
        status: status ?? this.status,
        listingId: listingId ?? this.listingId,
      );
}

class AvailabilitySchedule {
  final String? listingId;
  final String timezone;
  final AvailabilityMode mode;
  final int durationMin;
  final int slotIntervalMin;
  final int bufferMin;
  final int minNoticeMin;
  final int maxPerDay;
  final int horizonDays;
  final int version;
  final List<AvailabilityRule> rules;
  final List<AvailabilityException> exceptions;

  const AvailabilitySchedule({
    this.listingId,
    this.timezone = 'UTC',
    this.mode = AvailabilityMode.shared,
    this.durationMin = 60,
    this.slotIntervalMin = 60,
    this.bufferMin = 0,
    this.minNoticeMin = 0,
    this.maxPerDay = 0,
    this.horizonDays = 90,
    this.version = 0,
    this.rules = const <AvailabilityRule>[],
    this.exceptions = const <AvailabilityException>[],
  });

  factory AvailabilitySchedule.fromJson(Map<String, dynamic> json) {
    final rules = (json['rules'] as List?)
        ?.whereType<Map>()
        .map((e) => AvailabilityRule.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
    final exceptions = (json['exceptions'] as List?)
        ?.whereType<Map>()
        .map((e) => AvailabilityException.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false);
    return AvailabilitySchedule(
      listingId: json['listing_id']?.toString(),
      timezone: (json['timezone'] ?? 'UTC').toString(),
      mode: availabilityModeFromWire(json['mode']),
      durationMin: (json['duration_min'] as num?)?.toInt() ?? 60,
      slotIntervalMin: (json['slot_interval_min'] as num?)?.toInt() ?? 60,
      bufferMin: (json['buffer_min'] as num?)?.toInt() ?? 0,
      minNoticeMin: (json['min_notice_min'] as num?)?.toInt() ?? 0,
      maxPerDay: (json['max_per_day'] as num?)?.toInt() ?? 0,
      horizonDays: (json['horizon_days'] as num?)?.toInt() ?? 90,
      version: (json['version'] as num?)?.toInt() ?? 0,
      rules: rules ?? const <AvailabilityRule>[],
      exceptions: exceptions ?? const <AvailabilityException>[],
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'listing_id': listingId,
        'timezone': timezone,
        'mode': availabilityModeToWire(mode),
        'duration_min': durationMin,
        'slot_interval_min': slotIntervalMin,
        'buffer_min': bufferMin,
        'min_notice_min': minNoticeMin,
        'max_per_day': maxPerDay,
        'horizon_days': horizonDays,
        'version': version,
        'rules': rules.map((e) => e.toJson()).toList(growable: false),
        'exceptions': exceptions.map((e) => e.toJson()).toList(growable: false),
      };

  AvailabilitySchedule copyWith({
    String? listingId,
    String? timezone,
    AvailabilityMode? mode,
    int? durationMin,
    int? slotIntervalMin,
    int? bufferMin,
    int? minNoticeMin,
    int? maxPerDay,
    int? horizonDays,
    int? version,
    List<AvailabilityRule>? rules,
    List<AvailabilityException>? exceptions,
  }) =>
      AvailabilitySchedule(
        listingId: listingId ?? this.listingId,
        timezone: timezone ?? this.timezone,
        mode: mode ?? this.mode,
        durationMin: durationMin ?? this.durationMin,
        slotIntervalMin: slotIntervalMin ?? this.slotIntervalMin,
        bufferMin: bufferMin ?? this.bufferMin,
        minNoticeMin: minNoticeMin ?? this.minNoticeMin,
        maxPerDay: maxPerDay ?? this.maxPerDay,
        horizonDays: horizonDays ?? this.horizonDays,
        version: version ?? this.version,
        rules: rules ?? this.rules,
        exceptions: exceptions ?? this.exceptions,
      );
}

class AvailabilityDay {
  final String date;
  final int availableCount;

  const AvailabilityDay({required this.date, required this.availableCount});

  factory AvailabilityDay.fromJson(Map<String, dynamic> json) =>
      AvailabilityDay(
        date: (json['date'] ?? '').toString(),
        availableCount: (json['available_count'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'date': date, 'available_count': availableCount};
}

class AvailabilitySlot {
  final String id;
  final DateTime startAt;
  final DateTime endAt;
  final bool available;
  final String? reason;

  const AvailabilitySlot({
    required this.id,
    required this.startAt,
    required this.endAt,
    required this.available,
    this.reason,
  });

  factory AvailabilitySlot.fromJson(Map<String, dynamic> json) =>
      AvailabilitySlot(
        id: (json['id'] ?? '').toString(),
        startAt: _requiredAvailabilityDateTime(json['start_at'], 'start_at'),
        endAt: _requiredAvailabilityDateTime(json['end_at'], 'end_at'),
        available: json['available'] == true,
        reason: json['reason']?.toString(),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'start_at': startAt.millisecondsSinceEpoch,
        'end_at': endAt.millisecondsSinceEpoch,
        'available': available,
        if (reason != null) 'reason': reason,
      };
}

class ListingAvailability {
  final String timezone;
  final int version;
  final DateTime? generatedAt;
  final List<AvailabilityDay> days;
  final List<AvailabilitySlot> slots;

  const ListingAvailability({
    required this.timezone,
    required this.version,
    required this.generatedAt,
    required this.days,
    required this.slots,
  });

  factory ListingAvailability.fromJson(Map<String, dynamic> json) =>
      ListingAvailability(
        timezone: (json['timezone'] ?? 'UTC').toString(),
        version: (json['version'] as num?)?.toInt() ?? 0,
        generatedAt: _availabilityDateTime(json['generated_at']),
        days: ((json['days'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => AvailabilityDay.fromJson(e.cast<String, dynamic>()))
            .toList(growable: false),
        slots: ((json['slots'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => AvailabilitySlot.fromJson(e.cast<String, dynamic>()))
            .toList(growable: false),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'timezone': timezone,
        'version': version,
        'generated_at': generatedAt?.millisecondsSinceEpoch,
        'days': days.map((e) => e.toJson()).toList(growable: false),
        'slots': slots.map((e) => e.toJson()).toList(growable: false),
      };
}

class AvailabilityConflict {
  final String title;
  final DateTime startAt;
  final DateTime endAt;

  const AvailabilityConflict(
      {required this.title, required this.startAt, required this.endAt});

  factory AvailabilityConflict.fromJson(Map<String, dynamic> json) =>
      AvailabilityConflict(
        title: (json['title'] ?? 'Busy').toString(),
        startAt: _requiredAvailabilityDateTime(json['start_at'], 'start_at'),
        endAt: _requiredAvailabilityDateTime(json['end_at'], 'end_at'),
      );
}

class AvailabilityAlternative {
  final DateTime startAt;
  final DateTime endAt;

  const AvailabilityAlternative({required this.startAt, required this.endAt});

  factory AvailabilityAlternative.fromJson(Map<String, dynamic> json) =>
      AvailabilityAlternative(
        startAt: _requiredAvailabilityDateTime(json['start_at'], 'start_at'),
        endAt: _requiredAvailabilityDateTime(json['end_at'], 'end_at'),
      );
}

class AvailabilityConflictPreview {
  final bool ok;
  final List<AvailabilityConflict> conflicts;
  final List<AvailabilityAlternative> alternatives;

  const AvailabilityConflictPreview(
      {required this.ok, required this.conflicts, required this.alternatives});

  factory AvailabilityConflictPreview.fromJson(Map<String, dynamic> json) =>
      AvailabilityConflictPreview(
        ok: json['ok'] == true,
        conflicts: ((json['conflicts'] as List?) ?? const [])
            .whereType<Map>()
            .map(
                (e) => AvailabilityConflict.fromJson(e.cast<String, dynamic>()))
            .toList(growable: false),
        alternatives: ((json['alternatives'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) =>
                AvailabilityAlternative.fromJson(e.cast<String, dynamic>()))
            .toList(growable: false),
      );
}

/// Local-first blocks store: cached render first, then network refresh.
class CalendarStore {
  static const _cacheName = 'avacalendar_blocks_v1';

  static Future<List<CalBlock>> cached() async {
    final scope = AccountScope.id;
    try {
      final raw = await DiskCache.readForScope(_cacheName, scope: scope);
      if (scope != AccountScope.id) return const [];
      if (raw == null) return const [];
      return (jsonDecode(raw) as List)
          .map((e) => CalBlock.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  /// Fetch [from,to) from the API and refresh the cache.
  static Future<List<CalBlock>> refresh(
      {required int from, required int to}) async {
    final scope = AccountScope.id;
    final response =
        await ApiAuth.getSigned('$kCalendarBase/blocks?from=$from&to=$to');
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(
          'Calendar blocks request failed (${response.statusCode}).');
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map || decoded['blocks'] is! List) {
      throw const FormatException('Calendar blocks response was invalid.');
    }
    final rows = (decoded['blocks'] as List)
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>());
    if (scope != AccountScope.id) {
      throw StateError(
          'The active account changed while calendar data was loading.');
    }
    final blocks = rows.map(CalBlock.fromJson).toList(growable: false);
    try {
      await DiskCache.writeForScope(
          _cacheName, jsonEncode(blocks.map((b) => b.toJson()).toList()),
          scope: scope);
    } catch (_) {/* cache is best-effort */}
    return blocks;
  }
}

/// A2: cross-tz rendering — "10:00 (your time) · 14:00 UTC". The server keys
/// everything in UTC epoch ms; the device renders local + UTC so two parties
/// in different zones never misread a booking time.
String fmtTimeBoth(int epochMs) {
  final local = DateTime.fromMillisecondsSinceEpoch(epochMs);
  final utc = local.toUtc();
  String hm(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  return '${hm(local)} (your time) · ${hm(utc)} UTC';
}

String fmtDate(int epochMs) {
  final d = DateTime.fromMillisecondsSinceEpoch(epochMs);
  const months = [
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
    'Dec'
  ];
  return '${d.day} ${months[d.month - 1]} ${d.year}';
}

String fmtRange(int startMs, int endMs) {
  String hm(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  final s = DateTime.fromMillisecondsSinceEpoch(startMs);
  final e = DateTime.fromMillisecondsSinceEpoch(endMs);
  return '${hm(s)}–${hm(e)}';
}
