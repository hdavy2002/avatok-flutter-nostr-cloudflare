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
