import 'package:flutter/material.dart';

import '../../../core/ui/zine.dart';

/// Data models for the in-chat AVA calendar cards (Phase: AvaApps in-chat
/// actions). These are PURE view models — they hold what the cards render and
/// know how to parse the tolerant, provider-shaped JSON that Strata returns for
/// the Google Calendar toolkit (GOOGLECALENDAR_*). Parsing is deliberately
/// defensive: the Strata/Composio result envelope varies ({data:{items}},
/// {items}, {result:{...}}), so every reader falls back gracefully and a missing
/// field never throws — a malformed event is simply skipped.

/// A source calendar (one row in the "checked across N calendars" list).
class CalSource {
  final String id;
  final String title;
  final Color color;
  final bool primary;
  final bool shared;

  /// Number of events this calendar contributes to the queried day. 0 → "CLEAR".
  final int eventCount;

  const CalSource({
    required this.id,
    required this.title,
    required this.color,
    this.primary = false,
    this.shared = false,
    this.eventCount = 0,
  });

  CalSource copyWith({int? eventCount}) => CalSource(
        id: id,
        title: title,
        color: color,
        primary: primary,
        shared: shared,
        eventCount: eventCount ?? this.eventCount,
      );

  bool get clear => eventCount == 0;

  /// Parse one entry from GOOGLECALENDAR_LIST_CALENDARS → items[].
  static CalSource? fromJson(Map<String, dynamic> j, int index) {
    final id = (j['id'] ?? j['calendarId'] ?? '').toString();
    if (id.isEmpty) return null;
    final title =
        (j['summaryOverride'] ?? j['summary'] ?? j['title'] ?? id).toString();
    final access = (j['accessRole'] ?? '').toString().toLowerCase();
    return CalSource(
      id: id,
      title: title,
      color: _parseColor(j['backgroundColor']?.toString(), index),
      primary: j['primary'] == true,
      // owner = your own calendar; reader/writer/freeBusyReader = shared with you.
      shared: access.isNotEmpty && access != 'owner',
    );
  }
}

/// A single event (one event-item card on a busy day).
class CalEvent {
  final String id;
  final String calendarId;
  final String title;

  /// Local start/end. Null when unparseable; [allDay] true for date-only events.
  final DateTime? start;
  final DateTime? end;
  final bool allDay;

  final String? location;

  /// Google Meet / video link, when the event has one.
  final String? videoLink;

  /// Total attendees (including the user). 0 → no chip.
  final int attendeeCount;

  const CalEvent({
    required this.id,
    required this.calendarId,
    required this.title,
    this.start,
    this.end,
    this.allDay = false,
    this.location,
    this.videoLink,
    this.attendeeCount = 0,
  });

  bool get hasVideo => (videoLink ?? '').isNotEmpty;

  /// Parse one event from GOOGLECALENDAR_EVENTS_LIST(_ALL_CALENDARS) → items[].
  static CalEvent? fromJson(Map<String, dynamic> j) {
    final id = (j['id'] ?? j['eventId'] ?? '').toString();
    final status = (j['status'] ?? '').toString();
    if (status == 'cancelled') return null;
    final title =
        (j['summary'] ?? j['title'] ?? '(no title)').toString();

    final startMap = _asMap(j['start']);
    final endMap = _asMap(j['end']);
    final allDay = startMap['date'] != null && startMap['dateTime'] == null;
    final start = _parseDt(startMap['dateTime'] ?? startMap['date']);
    final end = _parseDt(endMap['dateTime'] ?? endMap['date']);

    // Attendees can be a list of maps, or absent.
    final att = j['attendees'];
    final attendeeCount = att is List ? att.length : 0;

    // The calendar an all-calendars query pulled this from. Different Strata
    // builds surface it under different keys; try the common ones.
    final calId = (j['calendarId'] ??
            j['_calendarId'] ??
            _asMap(j['organizer'])['email'] ??
            'primary')
        .toString();

    return CalEvent(
      id: id,
      calendarId: calId,
      title: title,
      start: start,
      end: end,
      allDay: allDay,
      location: (j['location']?.toString().trim().isEmpty ?? true)
          ? null
          : j['location'].toString(),
      videoLink: _videoLink(j),
      attendeeCount: attendeeCount,
    );
  }

  static String? _videoLink(Map<String, dynamic> j) {
    final hangout = j['hangoutLink']?.toString();
    if (hangout != null && hangout.isNotEmpty) return hangout;
    // conferenceData.entryPoints[].uri (video)
    final conf = _asMap(j['conferenceData']);
    final eps = conf['entryPoints'];
    if (eps is List) {
      for (final e in eps) {
        if (e is Map && (e['entryPointType'] == 'video') && e['uri'] != null) {
          return e['uri'].toString();
        }
      }
    }
    return null;
  }
}

/// Everything one calendar-day card needs.
class CalDay {
  final DateTime date;
  final List<CalEvent> events;
  final List<CalSource> sources;

  const CalDay({required this.date, required this.events, required this.sources});

  bool get isOpen => events.isEmpty;
  int get eventCount => events.length;

  /// Build a day from the two raw Strata payloads (calendars + events list),
  /// attaching per-calendar event counts so each source row shows CLEAR / N.
  factory CalDay.build({
    required DateTime date,
    required List<Map<String, dynamic>> rawCalendars,
    required List<Map<String, dynamic>> rawEvents,
  }) {
    final events = <CalEvent>[];
    for (final e in rawEvents) {
      final ev = CalEvent.fromJson(e);
      if (ev != null) events.add(ev);
    }
    events.sort((a, b) {
      final sa = a.start, sb = b.start;
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa.compareTo(sb);
    });

    final counts = <String, int>{};
    for (final e in events) {
      counts[e.calendarId] = (counts[e.calendarId] ?? 0) + 1;
    }

    final sources = <CalSource>[];
    for (var i = 0; i < rawCalendars.length; i++) {
      final s = CalSource.fromJson(rawCalendars[i], i);
      if (s == null) continue;
      sources.add(s.copyWith(eventCount: counts[s.id] ?? 0));
    }
    // Keep primary first, then the rest by title (stable, readable list).
    sources.sort((a, b) {
      if (a.primary != b.primary) return a.primary ? -1 : 1;
      return a.title.toLowerCase().compareTo(b.title.toLowerCase());
    });

    return CalDay(date: date, events: events, sources: sources);
  }
}

// ── parsing helpers ──────────────────────────────────────────────────────────

Map<String, dynamic> _asMap(Object? v) =>
    v is Map ? v.map((k, val) => MapEntry(k.toString(), val)) : <String, dynamic>{};

DateTime? _parseDt(Object? raw) {
  if (raw == null) return null;
  final s = raw.toString();
  if (s.isEmpty) return null;
  try {
    // Handles both "2026-06-21" (all-day) and full RFC3339 with offset/Z.
    return DateTime.parse(s).toLocal();
  } catch (_) {
    return null;
  }
}

/// Google calendar colors come as "#a4bdfc". Fall back to the Zine accent
/// rotation when absent so every row still has a distinct dot.
Color _parseColor(String? hex, int index) {
  if (hex != null && hex.startsWith('#') && (hex.length == 7 || hex.length == 4)) {
    try {
      var h = hex.substring(1);
      if (h.length == 3) {
        h = h.split('').map((c) => '$c$c').join();
      }
      return Color(int.parse('FF$h', radix: 16));
    } catch (_) {/* fall through */}
  }
  const palette = [Zine.blue, Zine.mint, Zine.lilac, Zine.coral, Zine.lime];
  return palette[index % palette.length];
}
