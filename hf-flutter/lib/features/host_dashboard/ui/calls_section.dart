import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/format/money.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/dash_format.dart';
import '../data/host_dashboard_models.dart';
import '../host_dashboard_providers.dart';
import 'host_dashboard_copy.dart';
import 'section_async.dart';

/// "Today": calls, minutes and rupees earned since midnight (the worker works out the day).
class TodayCard extends ConsumerWidget {
  const TodayCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final calls = ref.watch(hostCallsProvider);
    return SectionAsync<HostCallsData>(
      title: HostCopy.todayTitle,
      value: calls,
      onRetry: () => ref.invalidate(hostCallsProvider),
      notEnabledMessage: 'Calls open soon.',
      builder: (d) => HfCard(
        key: const ValueKey<String>('today-card'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(HostCopy.todayTitle, style: HfText.subtitle),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12, runSpacing: 12,
              children: [
                _Stat(label: HostCopy.todayCalls, value: '${d.todayCalls}', keyName: 'today-calls', color: HfColors.sky),
                _Stat(label: HostCopy.todayMinutes, value: '${d.todayMinutes}', keyName: 'today-minutes', color: HfColors.lavender),
                _Stat(label: HostCopy.todayEarned, value: Money.rupees(d.todayEarningRupees), keyName: 'today-earned', color: HfColors.butter),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.keyName, required this.color});

  final String label;
  final String value;
  final String keyName;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 120),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(20)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, key: ValueKey<String>(keyName), style: HfText.title),
          const SizedBox(height: 2),
          Text(label, style: HfText.label),
        ],
      ),
    );
  }
}

/// The recent calls: caller handle, when, how long, rupees earned, and a Paid or Test tag.
class CallsSection extends ConsumerStatefulWidget {
  const CallsSection({super.key});

  @override
  ConsumerState<CallsSection> createState() => _CallsSectionState();
}

class _CallsSectionState extends ConsumerState<CallsSection> {
  static const int _firstPage = 10;
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final calls = ref.watch(hostCallsProvider);
    // The Paid / Test tag needs the per-call earnings; without them (legacy wallet) rows just show the rupees.
    final earnings = dashValueOf(ref.watch(hostEarningsProvider));
    final byCall = earnings?.byCall ?? const <String, CallEarning>{};
    return SectionAsync<HostCallsData>(
      title: HostCopy.callsTitle,
      value: calls,
      onRetry: () => ref.invalidate(hostCallsProvider),
      notEnabledMessage: 'Calls open soon.',
      builder: (d) {
        final shown = _all ? d.calls : d.calls.take(_firstPage).toList();
        return HfCard(
          key: const ValueKey<String>('calls-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(HostCopy.callsTitle, style: HfText.subtitle),
              const SizedBox(height: 8),
              if (d.calls.isEmpty)
                const Text(HostCopy.callsEmpty, style: HfText.bodyText, key: ValueKey<String>('calls-empty'))
              else ...[
                for (final c in shown) CallRow(call: c, earning: byCall[c.id]),
                if (d.calls.length > _firstPage)
                  HfButton(
                    key: const ValueKey<String>('calls-more'),
                    label: _all ? HostCopy.showLess : HostCopy.showMore,
                    kind: HfButtonKind.text,
                    onPressed: () => setState(() => _all = !_all),
                  ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class CallRow extends StatelessWidget {
  const CallRow({super.key, required this.call, this.earning});

  final HostCall call;
  final CallEarning? earning;

  static String statusText(HostCall c) {
    switch (c.status) {
      case 'completed':
        return 'Completed';
      case 'no_answer':
        return 'You missed this call';
      case 'host_declined':
        return 'You declined this call';
      case 'caller_no_answer':
        return "The caller didn't pick up";
      case 'failed':
        return "The call didn't connect";
      case 'blocked':
        return 'Ended by the caller';
      case 'cancelled':
        return 'The caller cancelled';
      default:
        return 'Not completed';
    }
  }

  @override
  Widget build(BuildContext context) {
    final paid = call.completed && call.billedMinutes >= 1;
    final when = DashFormat.dayTimeOf(call.createdAt);
    final detail = paid
        ? '${when.isEmpty ? '' : '$when, '}${call.billedMinutes} min'
        : (call.completed ? HostCopy.underMinute : statusText(call));
    final isTest = earning?.isTest ?? false;
    return Container(
      key: ValueKey<String>('call-${call.id}'),
      constraints: const BoxConstraints(minHeight: HfSpacing.tap),
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: HfColors.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(call.callerHandle ?? 'A caller', style: HfText.bodyStrong),
                const SizedBox(height: 2),
                Text(detail, style: HfText.note),
                if (paid && earning != null) ...[
                  const SizedBox(height: 6),
                  Container(
                    key: ValueKey<String>('tag-${call.id}'),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: isTest ? HfColors.butter : HfColors.blush,
                      borderRadius: BorderRadius.circular(HfRadius.pill),
                    ),
                    child: Text(isTest ? HostCopy.testCall : HostCopy.paidCall, style: HfText.badge),
                  ),
                ],
              ],
          ),
          const SizedBox(height: 8),
          if (paid)
            Text(Money.rupees(call.earningRupees), key: ValueKey<String>('earned-${call.id}'), style: HfText.bodyStrong),
        ],
      ),
    );
  }
}
