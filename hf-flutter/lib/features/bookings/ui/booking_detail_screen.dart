import 'package:flutter/material.dart';
import '../../../core/config/flags.dart';
import 'booking_unavailable_screen.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/routes.dart';
import '../data/hf_booking_models.dart';
import '../data/hf_bookings_providers.dart';

class BookingDetailScreen extends ConsumerWidget {
  const BookingDetailScreen({super.key, required this.bookingId});
  final String bookingId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(flagsProvider).asData?.value.hfBookingsEnabled != true) {
      return const BookingUnavailableScreen(title: 'Booking details');
    }
    final booking = ref.watch(bookingDetailProvider(bookingId));
    final viewerUid = ref.watch(sessionProvider).user?.id;
    return Scaffold(
      appBar: AppBar(title: const Text('Booking details')),
      body: booking.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('This booking could not be loaded.'),
          TextButton(onPressed: () => ref.invalidate(bookingDetailProvider(bookingId)), child: const Text('Try again')),
        ])),
        data: (b) => Center(child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: ListView(padding: const EdgeInsets.all(20), children: [
            Card(child: Padding(padding: const EdgeInsets.all(18), child: Column(
              crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_date(context, b), style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                Text('Status: ${b.status}'),
                Text('Host time zone: ${b.hostTimezone ?? 'shown in your device time zone'}'),
                const SizedBox(height: 8),
                Text('Reserved: ${formatPaise(b.reservedPaise)}'),
                if (viewerUid != null && viewerUid == b.hostUid && b.expectedHostNetPaise != null)
                  Text('Expected host net: ${formatPaise(b.expectedHostNetPaise!)}'),
              ],
            ))),
            if (b.canStart) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () async {
                  try {
                    final started = await ref.read(hfBookingsApiProvider).start(b.id);
                    ref.invalidate(bookingDetailProvider(b.id));
                    await Analytics.capture('hf_app_booking_started', {'booking_id': b.id});
                    ref.invalidate(hostBookingsProvider);
                    ref.invalidate(customerBookingsProvider);
                    ref.invalidate(bookingCalendarProvider);
                    if (started.callId != null && context.mounted) context.go(Routes.callOf(started.callId!));
                  } catch (_) {
                    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The call could not start. Refresh the booking and try again.')));
                  }
                },
                icon: const Icon(Icons.call), label: const Text('Start booked call'),
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              ),
            ],
            if (b.canCancel) ...[
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: () => _cancel(context, ref, b),
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                child: const Text('Cancel booking'),
              ),
            ],
          ]),
        )),
      ),
    );
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref, BookingRecord booking) async {
    final ok = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: const Text('Cancel this booking?'),
      content: const Text('The reserved amount will be returned under the cancellation policy.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep booking')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Cancel booking')),
      ],
    ));
    if (ok != true) return;
    try {
      await ref.read(hfBookingsApiProvider).cancel(booking.id);
      await Analytics.capture('hf_app_booking_cancelled', {'booking_id': booking.id});
      ref.invalidate(bookingDetailProvider(booking.id));
      ref.invalidate(hostBookingsProvider);
      ref.invalidate(customerBookingsProvider);
      ref.invalidate(bookingCalendarProvider);
      ref.invalidate(hostBookingSummaryProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Booking cancelled')));
    } catch (error) {
      await Analytics.capture('hf_app_booking_conflict', {
        'stage': 'cancel', 'booking_id': booking.id,
        if (error is ApiError) 'status_code': error.status,
      });
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not cancel this booking. Refresh and try again.')));
    }
  }

  String _date(BuildContext context, BookingRecord b) {
    final local = b.startUtc.toLocal();
    final date = MaterialLocalizations.of(context).formatMediumDate(local);
    final time = MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(local));
    return '$date · $time';
  }
}
