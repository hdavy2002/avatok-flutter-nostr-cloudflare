import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/dash_format.dart';
import '../data/host_dashboard_models.dart';
import '../host_dashboard_providers.dart';
import 'host_dashboard_copy.dart';
import 'section_async.dart';

/// Earnings in rupees: total, available to withdraw, on hold (with the day each part unlocks).
/// Hosts never see tokens. Both server shapes render: the token-mode host ledger and the legacy rupee wallet.
class EarningsCard extends ConsumerWidget {
  const EarningsCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final earnings = ref.watch(hostEarningsProvider);
    final payouts = dashValueOf(ref.watch(hostPayoutsProvider));
    // The wallet answer carries the host block; when it is missing or fails, the withdrawals answer has the
    // same available and on-hold numbers, so the host still sees them.
    final AsyncValue<HostEarnings?> effective = earnings.when<AsyncValue<HostEarnings?>>(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      data: (e) => AsyncData<HostEarnings?>(e ?? (payouts == null ? null : HostEarnings.fromPayouts(payouts))),
      loading: () => const AsyncLoading<HostEarnings?>(),
      error: (e, st) {
        if (payouts != null && !(e is ApiError && e.isOffline)) {
          return AsyncData<HostEarnings?>(HostEarnings.fromPayouts(payouts));
        }
        return AsyncError<HostEarnings?>(e, st);
      },
    );
    return SectionAsync<HostEarnings?>(
      title: HostCopy.earningsTitle,
      value: effective,
      onRetry: () => ref.invalidate(hostEarningsProvider),
      builder: (e) {
        if (e == null) return const SizedBox.shrink();
        final holdDays = payouts?.holdDays ?? 7;
        final releases = e.releases(ref.read(dashboardClockProvider)());
        return HfCard(
          key: const ValueKey<String>('earnings-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(HostCopy.earningsTitle, style: HfText.subtitle),
              const SizedBox(height: 12),
              _Line(label: HostCopy.earningsAvailable, value: e.available, keyName: 'earn-available', big: true),
              _Line(label: HostCopy.earningsPending, value: e.pending, keyName: 'earn-pending'),
              for (final r in releases)
                Padding(
                  padding: const EdgeInsets.only(left: 12, bottom: 4),
                  child: Text(
                    '${Money.paise(r.paise)} unlocks on ${DashFormat.day(r.date)}',
                    key: ValueKey<String>('release-${r.date.millisecondsSinceEpoch}'),
                    style: HfText.note,
                  ),
                ),
              if (e.total.isNotEmpty) _Line(label: HostCopy.earningsTotal, value: e.total, keyName: 'earn-total'),
              if (e.paidOut != null) _Line(label: HostCopy.earningsPaidOut, value: e.paidOut!, keyName: 'earn-paidout'),
              if (e.testEarnings != null)
                _Line(label: HostCopy.earningsTest, value: e.testEarnings!, keyName: 'earn-test'),
              const SizedBox(height: 8),
              Text(HostCopy.holdNote(holdDays), style: HfText.note),
              if (e.testEarnings != null) const Text(HostCopy.earningsTestNote, style: HfText.note),
            ],
          ),
        );
      },
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.label, required this.value, required this.keyName, this.big = false});

  final String label;
  final String value;
  final String keyName;
  final bool big;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(child: Text(label, style: big ? HfText.bodyStrong : HfText.bodyText)),
          const SizedBox(width: 12),
          Text(value, key: ValueKey<String>(keyName), style: big ? HfText.title : HfText.bodyStrong),
        ],
      ),
    );
  }
}
