/// Small date helpers for the dashboard (no intl package). Times show in the phone's own time zone.
abstract final class DashFormat {
  static const List<String> _months = <String>[
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

  /// `14 Oct`.
  static String day(DateTime d) => '${d.day} ${_months[d.month - 1]}';

  /// `14 Oct` from epoch milliseconds, or an empty string when unknown.
  static String dayOf(int? epochMs) =>
      epochMs == null ? '' : day(DateTime.fromMillisecondsSinceEpoch(epochMs));

  /// `4:30 pm` from epoch milliseconds, or an empty string when unknown.
  static String timeOf(int? epochMs) {
    if (epochMs == null) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final h12 = d.hour % 12 == 0 ? 12 : d.hour % 12;
    final mm = d.minute.toString().padLeft(2, '0');
    return '$h12:$mm ${d.hour < 12 ? 'am' : 'pm'}';
  }

  /// True when [epochMs] falls on the same calendar day as [now].
  static bool isSameDay(int? epochMs, DateTime now) {
    if (epochMs == null) return false;
    final d = DateTime.fromMillisecondsSinceEpoch(epochMs);
    return d.year == now.year && d.month == now.month && d.day == now.day;
  }

  /// `14 Oct, 4:30 pm`.
  static String dayTimeOf(int? epochMs) {
    if (epochMs == null) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final h12 = d.hour % 12 == 0 ? 12 : d.hour % 12;
    final mm = d.minute.toString().padLeft(2, '0');
    final ap = d.hour < 12 ? 'am' : 'pm';
    return '${day(d)}, $h12:$mm $ap';
  }
}
