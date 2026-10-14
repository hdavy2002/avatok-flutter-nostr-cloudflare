import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/format/money.dart';
import '../../../core/router/routes.dart';
import '../data/hf_bookings_providers.dart';

class HostBookingSummaryCard extends ConsumerWidget {
  const HostBookingSummaryCard({super.key, this.openCalendarOnTap = true});
  final bool openCalendarOnTap;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = ref.watch(hostBookingSummaryProvider);
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: openCalendarOnTap ? () => context.push(Routes.hostBookings) : null,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: summary.when(
            skipLoadingOnRefresh: false,
            skipLoadingOnReload: false,
            loading: () => const Row(children: [
              Expanded(child: Text('Expected earnings on hold')),
              SizedBox(width: 18,height: 18,child: CircularProgressIndicator(strokeWidth: 2)),
            ]),
            error: (_, __) => Row(children: [
              const Expanded(child: Text('Bookings')),
              TextButton(onPressed: () => ref.invalidate(hostBookingSummaryProvider), child: const Text('Retry')),
            ]),
            data: (s) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Expected earnings on hold'),
              Text(formatPaise(s.expectedHostNetPaise), style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text('${s.upcomingCount} upcoming ${s.upcomingCount == 1 ? 'booking' : 'bookings'}'),
              if (s.nextBooking != null)
                Text('Next: ${MaterialLocalizations.of(context).formatMediumDate(s.nextBooking!.startUtc.toLocal())}'),
            ]),
          ),
        ),
      ),
    );
  }
}
