import '../../../core/analytics.dart';
import '../../../core/ava_tools/strata_client.dart';
import 'calendar_models.dart';

/// AvaCalendarService — the in-chat calendar/gmail action layer.
///
/// Wraps [StrataClient] (Worker → self-hosted Klavis Strata → Composio) for the
/// handful of Google Calendar / Gmail actions the AVA chat cards need. Ava only
/// ever runs ONE action at a time (progressive disclosure), so this service maps
/// each card intent to a single `executeAction`:
///
///   • fetchDay     → GOOGLECALENDAR_LIST_CALENDARS  +  *_EVENTS_LIST_ALL_CALENDARS
///   • createEvent  → GOOGLECALENDAR_CREATE_EVENT
///   • sendInvite   → GMAIL_SEND_EMAIL
///
/// Every call returns a typed outcome so the UI can branch into the three states
/// that actually happen in the field: ok, needs-connect (open the OAuth URL),
/// and unavailable/error (the tool layer isn't configured yet, or a transient
/// failure). Results are parsed via [CalDay]/[CalEvent] which tolerate the
/// varying Strata envelope shapes.
///
/// Caching: a process-local, per-fetch memo lets a repeat "what's my calendar"
/// in the same session repaint instantly while a fresh fetch runs. No persistent
/// store is introduced here, so there is no cross-account key to scope — when a
/// disk cache is added later it MUST go through `scopedKey(...)` per the rulebook.

const String _kCalProvider = 'gcalendar';
const String _kGmailProvider = 'gmail';

const String _aList = 'GOOGLECALENDAR_LIST_CALENDARS';
const String _aEventsAll = 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS';
const String _aEvents = 'GOOGLECALENDAR_EVENTS_LIST';
const String _aCreate = 'GOOGLECALENDAR_CREATE_EVENT';
const String _aGmailSend = 'GMAIL_SEND_EMAIL';

enum CalState { ok, needsConnect, unavailable, error }

class CalDayOutcome {
  final CalState state;
  final CalDay? day;
  final String? authUrl; // when needsConnect
  final String? message;
  const CalDayOutcome(this.state, {this.day, this.authUrl, this.message});
}

class CreateOutcome {
  final CalState state;
  final CalEvent? event;
  final String? authUrl;
  final String? message;
  const CreateOutcome(this.state, {this.event, this.authUrl, this.message});
}

class AvaCalendarService {
  AvaCalendarService._();
  static final AvaCalendarService I = AvaCalendarService._();

  final Map<String, CalDay> _memo = {};

  CalDay? cachedDay(DateTime date) => _memo[_dayKey(date)];

  /// Fetch one day's calendars + events and assemble a [CalDay].
  Future<CalDayOutcome> fetchDay(DateTime date) async {
    final (minIso, maxIso) = _dayBoundsUtc(date);

    // 1) calendars (chrome / per-source CLEAR rows)
    final calsRes = await StrataClient.I.executeAction(_aList,
        provider: _kCalProvider, args: const {});
    final gate = _gate(calsRes);
    if (gate != null) {
      Analytics.capture('ava_calendar_fetch', {
        'state': gate.state.name,
        'date': _dayKey(date),
      });
      return gate;
    }
    final rawCalendars = _items(calsRes.result);

    // 2) events across all calendars for the day
    var evRes = await StrataClient.I.executeAction(_aEventsAll,
        provider: _kCalProvider,
        args: {
          'timeMin': minIso,
          'timeMax': maxIso,
          'singleEvents': true,
          'orderBy': 'startTime',
          'maxResults': 50,
        });
    // Fallback to the primary-calendar list if the all-calendars action isn't
    // available on this Strata build.
    var rawEvents = _items(evRes.result);
    if (!evRes.ok && rawEvents.isEmpty) {
      evRes = await StrataClient.I.executeAction(_aEvents,
          provider: _kCalProvider,
          args: {
            'calendarId': 'primary',
            'timeMin': minIso,
            'timeMax': maxIso,
            'singleEvents': true,
            'orderBy': 'startTime',
            'maxResults': 50,
          });
      rawEvents = _items(evRes.result);
    }

    final day = CalDay.build(
      date: date,
      rawCalendars: rawCalendars,
      rawEvents: rawEvents,
    );
    _memo[_dayKey(date)] = day;

    Analytics.capture('ava_calendar_fetch', {
      'state': 'ok',
      'date': _dayKey(date),
      'events': day.eventCount,
      'calendars': day.sources.length,
      'open_day': day.isOpen,
    });
    return CalDayOutcome(CalState.ok, day: day);
  }

  /// Create an event / focus block / reminder. [durationMinutes] derives the end
  /// time; [attendees] + [withVideo] + [notify] drive guest invites + Meet link.
  Future<CreateOutcome> createEvent({
    required String calendarId,
    required String title,
    required DateTime start,
    int durationMinutes = 30,
    List<String> attendees = const [],
    bool withVideo = false,
    bool notify = false,
    String? description,
    String? location,
    int? reminderMinutes,
  }) async {
    final args = <String, Object?>{
      'calendar_id': calendarId,
      'summary': title,
      'start_datetime': _rfc3339(start),
      'event_duration_minutes': durationMinutes,
      if (attendees.isNotEmpty) 'attendees': attendees,
      if (withVideo) 'create_meeting_room': true,
      if (notify) 'send_updates': 'all',
      if (description != null && description.isNotEmpty) 'description': description,
      if (location != null && location.isNotEmpty) 'location': location,
      if (reminderMinutes != null)
        'reminders': {
          'useDefault': false,
          'overrides': [
            {'method': 'popup', 'minutes': reminderMinutes}
          ],
        },
    };

    final res = await StrataClient.I.executeAction(_aCreate,
        provider: _kCalProvider, args: args);
    final gate = _gate(res);
    if (gate != null) {
      Analytics.capture('ava_calendar_create', {'state': gate.state.name});
      return CreateOutcome(gate.state, authUrl: gate.authUrl, message: gate.message);
    }

    // The created event echoes back under data / result; reuse the event parser.
    final created = _single(res.result);
    final ev = created == null
        ? CalEvent(
            id: '',
            calendarId: calendarId,
            title: title,
            start: start,
            end: start.add(Duration(minutes: durationMinutes)),
            attendeeCount: attendees.length,
            videoLink: withVideo ? '' : null,
          )
        : (CalEvent.fromJson(created) ??
            CalEvent(id: '', calendarId: calendarId, title: title, start: start));

    Analytics.capture('ava_calendar_create', {
      'state': 'ok',
      'with_video': withVideo,
      'guests': attendees.length,
      'duration_min': durationMinutes,
      'is_reminder': reminderMinutes != null,
    });
    return CreateOutcome(CalState.ok, event: ev);
  }

  /// Send a plain invite email via the user's connected Gmail.
  Future<bool> sendInvite({
    required String to,
    required String subject,
    required String body,
  }) async {
    final res = await StrataClient.I.executeAction(_aGmailSend,
        provider: _kGmailProvider,
        args: {'recipient_email': to, 'subject': subject, 'body': body});
    Analytics.capture('ava_calendar_invite_email', {'ok': res.ok});
    return res.ok;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /// Maps a non-ok [StrataResult] into a typed gate outcome, or null when the
  /// call succeeded and the caller should parse data.
  CalDayOutcome? _gate(StrataResult res) {
    if (res.authRequired != null) {
      return CalDayOutcome(CalState.needsConnect,
          authUrl: res.authRequired!.authUrl,
          message: 'Connect Google Calendar to let Ava see your schedule.');
    }
    if (StrataClient.I.isUnavailable(res.raw)) {
      return const CalDayOutcome(CalState.unavailable,
          message: 'The tool layer is still being set up.');
    }
    if (res.paymentRequired) {
      return const CalDayOutcome(CalState.error,
          message: 'This connector needs an active plan.');
    }
    if (!res.ok) {
      // A 401-ish / missing-connection often arrives as a plain failure; treat
      // it as "needs connect" so the card can offer the connect CTA.
      final status = (res.raw['_status'] as int?) ?? 0;
      if (status == 401 || status == 403) {
        return const CalDayOutcome(CalState.needsConnect,
            message: 'Reconnect Google Calendar to continue.');
      }
      return const CalDayOutcome(CalState.error,
          message: 'Couldn\'t reach your calendar — try again.');
    }
    return null;
  }

  /// Pull a list of item maps out of whatever envelope Strata returned.
  List<Map<String, dynamic>> _items(Object? result) {
    final m = result is Map ? result : const {};
    final data = m['data'] is Map ? m['data'] as Map : m;
    final list = (data['items'] ??
        data['events'] ??
        data['calendars'] ??
        data['messages'] ??
        m['items']);
    if (list is List) {
      return [
        for (final e in list)
          if (e is Map) e.map((k, v) => MapEntry(k.toString(), v))
      ];
    }
    return const [];
  }

  /// Pull a single object (e.g. the just-created event) out of the envelope.
  Map<String, dynamic>? _single(Object? result) {
    final m = result is Map ? result : const {};
    final data = m['data'];
    if (data is Map && (data['id'] != null || data['summary'] != null)) {
      return data.map((k, v) => MapEntry(k.toString(), v));
    }
    if (m['id'] != null || m['summary'] != null) {
      return m.map((k, v) => MapEntry(k.toString(), v));
    }
    return null;
  }

  String _dayKey(DateTime d) =>
      '${d.year}-${_2(d.month)}-${_2(d.day)}';

  /// UTC day bounds (local midnight → next local midnight, in UTC ISO/Z).
  (String, String) _dayBoundsUtc(DateTime date) {
    final startLocal = DateTime(date.year, date.month, date.day);
    final endLocal = startLocal.add(const Duration(days: 1));
    return (startLocal.toUtc().toIso8601String(), endLocal.toUtc().toIso8601String());
  }

  /// RFC3339 with the device's local UTC offset, e.g. 2026-06-21T15:00:00+05:30.
  String _rfc3339(DateTime dt) {
    final off = dt.timeZoneOffset;
    final sign = off.isNegative ? '-' : '+';
    final h = _2(off.inHours.abs());
    final mm = _2((off.inMinutes.abs() % 60));
    return '${dt.year}-${_2(dt.month)}-${_2(dt.day)}'
        'T${_2(dt.hour)}:${_2(dt.minute)}:00$sign$h:$mm';
  }

  static String _2(int n) => n.toString().padLeft(2, '0');
}
