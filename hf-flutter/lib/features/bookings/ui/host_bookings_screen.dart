import 'package:flutter/material.dart';
import '../../../core/config/flags.dart';
import 'booking_unavailable_screen.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/format/money.dart';
import '../data/hf_booking_models.dart';
import '../data/hf_bookings_providers.dart';
import '../../../core/router/routes.dart';

class HostBookingsScreen extends ConsumerWidget {
  const HostBookingsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(flagsProvider).asData?.value.hfBookingsEnabled != true) {
      return const BookingUnavailableScreen(title: 'Bookings');
    }
    final summary = ref.watch(hostBookingSummaryProvider);
    final bookings = ref.watch(hostBookingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Bookings'), actions: [
        IconButton(tooltip: 'Edit availability', icon: const Icon(Icons.calendar_month_outlined),
          onPressed: () => context.push(Routes.hostAvailability)),
      ]),
      body: RefreshIndicator(
        onRefresh: () async { ref.invalidate(hostBookingSummaryProvider); ref.invalidate(hostBookingsProvider); },
        child: Center(child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: ListView(padding: const EdgeInsets.all(16), children: [
            summary.when(
              loading: () => const Card(child: ListTile(title: Text('Expected earnings on hold'), subtitle: LinearProgressIndicator())),
              error: (_, __) => Card(child: ListTile(title: const Text('Expected earnings on hold'), subtitle: const Text('Could not load. Pull to refresh.'))),
              data: (s) => Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
                crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Expected earnings on hold', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(formatPaise(s.expectedHostNetPaise), style: Theme.of(context).textTheme.headlineSmall),
                  Text('${s.upcomingCount} upcoming ${s.upcomingCount == 1 ? 'booking' : 'bookings'}'),
                  if (s.nextBooking != null) Text('Next: ${_when(context, s.nextBooking!)}'),
                ],
              ))),
            ),
            const SizedBox(height: 16),
            Text('All bookings', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            bookings.when(
              loading: () => const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
              error: (_, __) => _Retry(onTap: () => ref.invalidate(hostBookingsProvider)),
              data: (rows) => rows.isEmpty
                ? const Card(child: Padding(padding: EdgeInsets.all(20), child: Text('No bookings yet. Your confirmed appointments will appear here.')))
                : Column(children: [for (final booking in rows) Card(
                    child: ListTile(
                      minVerticalPadding: 12,
                      title: Text(_when(context, booking)),
                      subtitle: Text('${booking.status} · ${booking.hostTimezone ?? 'Your local time'}'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.push(Routes.bookingDetailOf(booking.id)),
                    ),
                  )]),
            ),
          ]),
        )),
      ),
    );
  }

  static String _when(BuildContext context, BookingRecord b) {
    final date = MaterialLocalizations.of(context).formatMediumDate(b.startUtc.toLocal());
    final time = MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(b.startUtc.toLocal()));
    return '$date · $time';
  }
}

class _Retry extends StatelessWidget {
  const _Retry({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(child: ListTile(
    title: const Text('Bookings could not be loaded.'),
    trailing: TextButton(onPressed: onTap, child: const Text('Retry')),
  ));
}
