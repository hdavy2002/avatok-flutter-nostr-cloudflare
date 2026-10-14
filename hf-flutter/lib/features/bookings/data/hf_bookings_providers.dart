import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';
import 'hf_booking_models.dart';
import 'hf_bookings_api.dart';

final hfBookingsApiProvider = Provider<HfBookingsApi>(
  (ref) => HfBookingsApi(ref.watch(apiClientProvider)),
);

final bookingAccountScopeProvider = Provider<String?>(
  (ref) => ref.watch(sessionProvider.select((session) => session.user?.id)),
);

final hostAvailabilityProvider = FutureProvider.autoDispose<BookingSchedule>(
  (ref) { ref.watch(bookingAccountScopeProvider); return ref.watch(hfBookingsApiProvider).availability(); },
);

final hostBookingSummaryProvider = FutureProvider.autoDispose<BookingSummary>(
  (ref) { ref.watch(bookingAccountScopeProvider); return ref.watch(hfBookingsApiProvider).hostSummary(); },
);

final hostBookingsProvider = FutureProvider.autoDispose<List<BookingRecord>>(
  (ref) { ref.watch(bookingAccountScopeProvider); return ref.watch(hfBookingsApiProvider).list(role: 'host'); },
);

final customerBookingsProvider = FutureProvider.autoDispose<List<BookingRecord>>(
  (ref) { ref.watch(bookingAccountScopeProvider); return ref.watch(hfBookingsApiProvider).list(role: 'customer'); },
);

final bookingDetailProvider = FutureProvider.autoDispose.family<BookingRecord, String>(
  (ref, id) { ref.watch(bookingAccountScopeProvider); return ref.watch(hfBookingsApiProvider).detail(id); },
);

/// Account, role and month form the cache identity. Disposed requests stop paging.
typedef BookingCalendarQuery = ({String account, String role, DateTime month});
final bookingCalendarProvider = FutureProvider.autoDispose
    .family<List<BookingRecord>, BookingCalendarQuery>((ref, query) {
  final account = ref.watch(bookingAccountScopeProvider);
  if (account == null || account != query.account) return const [];
  var active = true;
  ref.onDispose(() => active = false);
  return ref.watch(hfBookingsApiProvider).calendar(
    role: query.role,
    from: query.month,
    to: DateTime(query.month.year, query.month.month + 1),
    isCurrent: () => active && ref.read(bookingAccountScopeProvider) == query.account,
  );
});

/// Half-open intervals prevent an appointment ending at midnight from occupying
/// the following day. Civil midnights also handle daylight-saving transitions.
bool bookingOverlapsDay(BookingRecord booking, DateTime day) {
  final start = DateTime(day.year, day.month, day.day);
  final end = DateTime(day.year, day.month, day.day + 1);
  return booking.startUtc.isBefore(end) && booking.endUtc.isAfter(start);
}
