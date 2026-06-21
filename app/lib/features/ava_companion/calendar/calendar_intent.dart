/// Lightweight, on-device intent router for the AVA calendar cards.
///
/// Decides whether a free-text turn is really "show me my calendar" and, if so,
/// which day. This lets the companion thread render a live calendar CARD instead
/// of a plain model reply, without changing the model tool-calling loop. It is
/// deliberately conservative: a turn must mention the calendar (or be a bare
/// day-reference follow-up right after a calendar card) to be intercepted, so
/// normal chat ("what should I do today?") still flows to the model.
library;

class CalendarRoute {
  CalendarRoute._();

  static final _calWords = RegExp(
    r'\b(calendar|schedule|agenda|my day|whats on|what.?s on|meetings?|free today|busy today|appointments?)\b',
    caseSensitive: false,
  );

  static final _bareDay = RegExp(
    r'^\s*(and\s+)?(today|tomorrow|day after|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\??\s*$',
    caseSensitive: false,
  );

  /// Returns the target day when [text] is a calendar request, else null.
  /// When [lastWasCalendar] is true, a bare "and tomorrow?" follow-up also
  /// resolves (so the conversation can step day-by-day like the mockups).
  static DateTime? resolve(String text, {bool lastWasCalendar = false}) {
    final t = text.trim();
    if (t.isEmpty) return null;
    final isCal = _calWords.hasMatch(t);
    final isBare = lastWasCalendar && _bareDay.hasMatch(t);
    if (!isCal && !isBare) return null;
    return _resolveDay(t.toLowerCase());
  }

  static DateTime _resolveDay(String t) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    if (t.contains('day after')) return today.add(const Duration(days: 2));
    if (t.contains('tomorrow')) return today.add(const Duration(days: 1));
    if (t.contains('yesterday')) return today.subtract(const Duration(days: 1));

    const days = {
      'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
      'friday': 5, 'saturday': 6, 'sunday': 7,
    };
    for (final e in days.entries) {
      if (t.contains(e.key)) {
        var delta = (e.value - today.weekday) % 7;
        if (delta == 0) delta = 7; // "monday" = next monday, not today
        return today.add(Duration(days: delta));
      }
    }
    return today; // default: today
  }
}
