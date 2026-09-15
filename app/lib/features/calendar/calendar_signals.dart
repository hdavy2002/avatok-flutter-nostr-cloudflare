import 'package:flutter/foundation.dart';

/// Cross-screen signal: an availability save happened, so the diary reloads and
/// confirms instead of showing the schedule it had in memory (audit A6).
///
/// This carries a revision COUNTER only — never a schedule, a booking or an
/// account id — so it cannot move one account's data into another's session.
class CalendarSignals {
  CalendarSignals._();

  static final ValueNotifier<int> availabilityRevision = ValueNotifier<int>(0);

  static void availabilitySaved() => availabilityRevision.value++;
}
