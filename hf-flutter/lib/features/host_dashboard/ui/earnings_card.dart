import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config/flags.dart';
import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../data/dash_format.dart';
import '../data/host_dashboard_models.dart';
import '../host_dashboard_providers.dart';
import 'dash_surface.dart';
import 'host_dashboard_copy.dart';
import 'money_count_up.dart';
import 'payouts_section.dart';
import 'section_async.dart';

/// Earnings in rupees (white card, radius 26): the total, what is ready to withdraw, what is on the 7-day
/// hold (with the day each part unlocks), and the "Withdraw to bank" button that opens the payout sheet.
/// Hosts never see tokens. Both server shapes render: the token-mode host ledger and the legacy rupee wallet.
class EarningsCard extends ConsumerWidget {
  const EarningsCard({super.key, required this.onFinishSetup});

  /// Opens onboarding at the identity or bank step.
  final void Function(String step) onFinishSetup;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final standardPlan = hfStdPlanOn(ref.watch(flagsProvider));
    final earnings = ref.watch(hostEarningsProvider);
    final payouts = dashValueOf(ref.watch(hostPayoutsProvider));
    // The wallet answer carries the host block; when it is missing or fails, the withdrawals answer has the
    // same available and on-hold numbers, so the host still sees them.
    final AsyncValue<HostEarnings?> effective = earnings
        .when<AsyncValue<HostEarnings?>>(
          skipLoadingOnReload: true,
          skipLoadingOnRefresh: true,
          data: (e) => AsyncData<HostEarnings?>(
            e ?? (payouts == null ? null : HostEarnings.fromPayouts(payouts)),
          ),
          loading: () => const AsyncLoading<HostEarnings?>(),
          error: (e, st) {
            if (payouts != null && !(e is ApiError && e.isOffline)) {
              return AsyncData<HostEarnings?>(
                HostEarnings.fromPayouts(payouts),
              );
            }
            return AsyncError<HostEarnings?>(e, st);
          },
        );
    return SectionAsync<HostEarnings?>(
      title: HostCopy.earningsTitle,
      value: effective,
      onRetry: () => ref.invalidate(hostEarningsProvider),
      skeletonHeight: 210,
      builder: (e) {
        if (e == null) return const SizedBox.shrink();
        final holdDays = payouts?.holdDays ?? 7;
        final releases = e.releases(ref.read(dashboardClockProvider)());
        final muted = dashMuted(context);
        final big = HfText.of(context, HfText.title);
        return DashSurface(
          key: const ValueKey<String>('earnings-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  const DashHeading(HostCopy.earningsTitle),
                  const SizedBox(width: HfSpacing.sm),
                  Expanded(
                    child: e.total.isEmpty
                        ? const SizedBox.shrink()
                        : Text(
                            HostCopy.earningsTotalLine(e.total),
                            key: const ValueKey<String>('earn-total'),
                            textAlign: TextAlign.end,
                            style: muted,
                          ),
                  ),
                ],
              ),
              const SizedBox(height: HfSpacing.lg),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(HostCopy.earningsReady, style: muted),
                        MoneyCountUp(
                          e.available,
                          key: const ValueKey<String>('earn-available'),
                          style: big,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: HfSpacing.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(HostCopy.earningsHold(holdDays), style: muted),
                        MoneyCountUp(
                          e.pending,
                          key: const ValueKey<String>('earn-pending'),
                          style: big.copyWith(color: muted.color),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              if (releases.isNotEmpty ||
                  e.paidOut != null ||
                  e.testEarnings != null) ...[
                const SizedBox(height: HfSpacing.lg),
                for (final r in releases)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Text(
                      '${formatPaise(r.paise)} unlocks on ${DashFormat.day(r.date)}',
                      key: ValueKey<String>(
                        'release-${r.date.millisecondsSinceEpoch}',
                      ),
                      style: muted,
                    ),
                  ),
                if (e.paidOut != null)
                  _NoteLine(
                    label: HostCopy.earningsPaidOut,
                    value: e.paidOut!,
                    keyName: 'earn-paidout',
                  ),
                if (e.testEarnings != null)
                  _NoteLine(
                    label: HostCopy.earningsTest,
                    value: e.testEarnings!,
                    keyName: 'earn-test',
                  ),
              ],
              const SizedBox(height: HfSpacing.sm),
              if (standardPlan) Text(HostCopy.standardPlan, style: muted),
              Text(HostCopy.holdNote(holdDays), style: muted),
              if (e.testEarnings != null)
                Text(HostCopy.earningsTestNote, style: muted),
              WithdrawArea(onFinishSetup: onFinishSetup),
            ],
          ),
        );
      },
    );
  }
}

class _NoteLine extends StatelessWidget {
  const _NoteLine({
    required this.label,
    required this.value,
    required this.keyName,
  });

  final String label;
  final String value;
  final String keyName;

  @override
  Widget build(BuildContext context) {
    final muted = dashMuted(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Expanded(child: Text(label, style: muted)),
          const SizedBox(width: HfSpacing.sm),
          Text(
            value,
            key: ValueKey<String>(keyName),
            style: HfText.of(context, HfText.bodyStrong.copyWith(fontSize: 15)),
          ),
        ],
      ),
    );
  }
}
