// [CALL-LOG-TIME-1] ONE formatter for the call-history subtitle.
//
// Before this file the two call lists formatted their own subtitle from
// `CallEntry.timeLabel`, and they had already drifted: AvaTalk → Calls rendered
// "Outgoing · Yesterday" (no time AT ALL) while AvaDialer → Call logs rendered
// "outgoing · 01:52" (a clock time today, a bare "Yesterday" for anything
// older). Neither showed a duration, so the owner could not tell WHEN a call
// happened or how long it lasted — which blocked a real call investigation.
//
// Both screens now call [callLogSubtitle]. Adding a third call surface means
// calling it too; do NOT re-implement this ladder.
//
// The ladder (device 12/24-hour setting is respected — never hardcode 24h):
//   today      -> "14:32"            (or "2:32 PM")
//   yesterday  -> "Yesterday 14:32"
//   this year  -> "7 Aug, 14:32"
//   older      -> "7 Aug 2025, 14:32"
//
// Then, when the call ACTUALLY CONNECTED, a duration: "· 2m 14s". When it never
// connected there is no duration to show — a "· 0s" is worse than nothing — so
// the OUTCOME takes its place: "· Declined", "· No answer", "· Cancelled".

import 'package:flutter/material.dart';

import '../call_log_store.dart';

const List<String> _kMonths = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// Clock time honouring the device's 12/24-hour preference.
///
/// [TimeOfDay.format] reads `MediaQuery.alwaysUse24HourFormat` for us, so a user
/// on a 12-hour locale sees "2:32 PM". It needs [MaterialLocalizations]; if the
/// caller has no context (or none is in scope) we fall back to 24-hour, which is
/// what the app rendered before this change.
String _clock(DateTime d, BuildContext? context) {
  if (context != null) {
    try {
      return TimeOfDay.fromDateTime(d).format(context);
    } catch (_) {
      // No MaterialLocalizations in scope — fall through to the 24h fallback.
    }
  }
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// "14:32" / "Yesterday 14:32" / "7 Aug, 14:32" / "7 Aug 2025, 14:32".
///
/// [tsSeconds] is epoch SECONDS (what [CallEntry.ts] stores). [now] is injectable
/// for tests only.
String callLogWhen(int tsSeconds, {BuildContext? context, DateTime? now}) {
  if (tsSeconds <= 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(tsSeconds * 1000);
  final n = now ?? DateTime.now();
  final time = _clock(d, context);
  // Compare CALENDAR DAYS, not elapsed hours: a call at 23:50 is "Yesterday" at
  // 00:10, not "16 hours ago".
  final today = DateTime(n.year, n.month, n.day);
  final day = DateTime(d.year, d.month, d.day);
  final diffDays = today.difference(day).inDays;
  if (diffDays == 0) return time;
  if (diffDays == 1) return 'Yesterday $time';
  final dm = '${d.day} ${_kMonths[d.month - 1]}';
  if (d.year == n.year) return '$dm, $time';
  return '$dm ${d.year}, $time';
}

/// "45s" / "2m 14s" / "1h 03m". Returns '' for a non-positive duration — the
/// caller must never print "0s".
String callLogDuration(int seconds) {
  if (seconds <= 0) return '';
  if (seconds < 60) return '${seconds}s';
  if (seconds < 3600) {
    final m = seconds ~/ 60;
    final s = seconds % 60;
    return '${m}m ${s.toString().padLeft(2, '0')}s';
  }
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  return '${h}h ${m.toString().padLeft(2, '0')}m';
}

/// Human label for a call that never connected, or '' when there is nothing
/// useful to say (an old row with no outcome recorded, or a connected call —
/// which shows its duration instead).
String callLogOutcomeLabel(CallEntry e) {
  if (e.connected) return '';
  switch (e.outcome) {
    case CallOutcome.missed:
      return 'Missed';
    case CallOutcome.declined:
      return 'Declined';
    case CallOutcome.noAnswer:
      return 'No answer';
    case CallOutcome.cancelled:
      return 'Cancelled';
    case CallOutcome.busy:
      return 'Busy';
    case CallOutcome.failed:
      return 'Failed';
  }
  // Legacy row (written before outcomes existed): the direction is all we know.
  // A missed call still deserves to say so; anything else says nothing rather
  // than guessing.
  return e.dir == CallDir.missed ? 'Missed' : '';
}

/// The direction word both lists put in front of the timestamp.
String callLogDirectionLabel(CallDir d) => switch (d) {
      CallDir.incoming => 'Incoming',
      CallDir.outgoing => 'Outgoing',
      CallDir.missed => 'Missed',
    };

/// THE subtitle both call lists render.
///
/// Examples (device on 24h):
///   connected outgoing today      -> "Outgoing · 14:32 · 2m 14s"
///   missed yesterday              -> "Missed · Yesterday 09:12"
///   declined outgoing, this year  -> "Outgoing · 7 Aug, 14:32 · Declined"
///   connected incoming, last year -> "Incoming · 7 Aug 2025, 14:32 · 1h 03m"
///
/// The trailing outcome is suppressed when it would merely repeat the direction
/// ("Missed · … · Missed").
String callLogSubtitle(
  CallEntry e, {
  BuildContext? context,
  bool withDirection = true,
  DateTime? now,
}) {
  final parts = <String>[];
  final dir = callLogDirectionLabel(e.dir);
  if (withDirection) parts.add(dir);
  final when = callLogWhen(e.ts, context: context, now: now);
  if (when.isNotEmpty) parts.add(when);
  final dur = e.connected ? callLogDuration(e.durationSec) : '';
  if (dur.isNotEmpty) {
    parts.add(dur);
  } else {
    final outcome = callLogOutcomeLabel(e);
    if (outcome.isNotEmpty && !(withDirection && outcome == dir)) parts.add(outcome);
  }
  return parts.join(' · ');
}
