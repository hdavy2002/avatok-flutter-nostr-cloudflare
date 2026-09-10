import 'package:timezone/data/latest.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;

/// DST-safe conversion for the availability contract.
///
/// The API stores instants as UTC epoch milliseconds, while working hours and
/// date exceptions are wall-clock values in an explicit IANA timezone. Never
/// derive an IANA name from a platform abbreviation or a truncated offset.
class AvailabilityTime {
  static bool _initialized = false;

  static void ensureInitialized() {
    if (_initialized) return;
    tz_data.initializeTimeZones();
    _initialized = true;
  }

  static tz.Location location(String timezone) {
    ensureInitialized();
    return tz.getLocation(timezone);
  }

  static DateTime inTimezone(DateTime instant, String timezone) =>
      tz.TZDateTime.from(instant.toUtc(), location(timezone));

  static DateTime wallTimeToUtc({
    required DateTime date,
    required int minutes,
    required String timezone,
  }) {
    final hour = minutes ~/ 60;
    final minute = minutes % 60;
    final expected = DateTime.utc(date.year,date.month,date.day,hour,minute);
    final value=tz.TZDateTime(location(timezone),date.year,date.month,date.day,hour,minute);
    if (value.year!=expected.year || value.month!=expected.month || value.day!=expected.day || value.hour!=expected.hour || value.minute!=expected.minute) {
      throw const FormatException('This local time does not exist because of a daylight-saving clock change.');
    }
    return value.toUtc();
  }
}
