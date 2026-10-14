import 'package:flutter/material.dart';
import '../../../core/config/flags.dart';
import 'booking_unavailable_screen.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/router/routes.dart';
import '../data/hf_booking_models.dart';
import '../data/hf_bookings_providers.dart';

class CustomerBookingsScreen extends ConsumerWidget {
  const CustomerBookingsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(flagsProvider).valueOrNull?.hfBookingsEnabled != true) {
      return const BookingUnavailableScreen(title: 'My bookings');
    }
    final rows = ref.watch(customerBookingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('My bookings')),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(customerBookingsProvider),
        child: Center(child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: rows.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (_, __) => ListView(children: [
              ListTile(title: const Text('Bookings could not be loaded.'), trailing: TextButton(
                onPressed: () => ref.invalidate(customerBookingsProvider), child: const Text('Retry'))),
            ]),
            data: (items) => items.isEmpty
              ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('Your confirmed bookings will appear here.'))])
              : ListView.builder(
                  padding: const EdgeInsets.all(16), itemCount: items.length,
                  itemBuilder: (context, index) => _CustomerBookingTile(booking: items[index]),
                ),
          ),
        )),
      ),
    );
  }
}

class _CustomerBookingTile extends StatelessWidget {
  const _CustomerBookingTile({required this.booking});
  final BookingRecord booking;
  @override
  Widget build(BuildContext context) {
    final local = booking.startUtc.toLocal();
    final date = MaterialLocalizations.of(context).formatMediumDate(local);
    final time = MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(local));
    return Card(child: ListTile(
      minVerticalPadding: 12,
      title: Text('$date · $time'),
      subtitle: Text('${booking.status} · ${booking.hostTimezone ?? 'your time zone'}'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push(Routes.bookingDetailOf(booking.id)),
    ));
  }
}
