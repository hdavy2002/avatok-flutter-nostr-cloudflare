import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/dash_format.dart';
import '../data/host_dashboard_models.dart';
import '../host_dashboard_providers.dart';
import 'dash_surface.dart';
import 'host_dashboard_copy.dart';
import 'section_async.dart';

/// The three tiles under the online card: calls today (sky), minutes (lavender), rupees earned (butter).
/// The worker works out "today"; the app only shows the numbers.
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
      skeletonHeight: 78,
      skeletonRadius: HfRadius.tileSmall,
      builder: (d) => IntrinsicHeight(
        key: const ValueKey<String>('today-card'),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: KeyedSubtree(
                key: const ValueKey<String>('today-calls'),
                child: HfTile(
                  tint: HfTint.sky,
                  value: '${d.todayCalls}',
                  caption: HostCopy.todayCallsCaption,
                ),
              ),
            ),
            const SizedBox(width: HfSpacing.sm),
            Expanded(
              child: KeyedSubtree(
                key: const ValueKey<String>('today-minutes'),
                child: HfTile(
                  tint: HfTint.lavender,
                  value: '${d.todayMinutes}',
                  caption: HostCopy.todayMinutesCaption,
                ),
              ),
            ),
            const SizedBox(width: HfSpacing.sm),
            Expanded(
              child: KeyedSubtree(
                key: const ValueKey<String>('today-earned'),
                child: HfTile(
                  tint: HfTint.butter,
                  value: formatRupees(d.todayEarningRupees),
                  caption: HostCopy.todayEarnedCaption,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Today's calls" with "See all": caller handle, when, how long, rupees earned, and a Paid or Test tag.
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
    final now = ref.read(dashboardClockProvider)();
    return SectionAsync<HostCallsData>(
      title: HostCopy.callsTitle,
      value: calls,
      onRetry: () => ref.invalidate(hostCallsProvider),
      notEnabledMessage: 'Calls open soon.',
      skeletonHeight: 140,
      skeletonRadius: HfRadius.control,
      builder: (d) {
        final shown = _all ? d.calls : d.calls.take(_firstPage).toList();
        return Column(
          key: const ValueKey<String>('calls-card'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                const Expanded(child: DashHeading(HostCopy.callsTitle)),
                if (d.calls.length > _firstPage)
                  TextButton(
                    key: const ValueKey<String>('calls-more'),
                    onPressed: () => setState(() => _all = !_all),
                    child: Text(_all ? HostCopy.seeFewer : HostCopy.seeAll),
                  ),
              ],
            ),
            const SizedBox(height: HfSpacing.sm),
            if (d.calls.isEmpty)
              DashSurface(
                radius: HfRadius.control,
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: HfSpacing.lg,
                ),
                child: Text(
                  HostCopy.callsEmpty,
                  key: const ValueKey<String>('calls-empty'),
                  style: dashMuted(context),
                ),
              )
            else
              StaggeredReveal(
                key: const ValueKey<String>('calls-reveal'),
                spacing: HfSpacing.sm,
                children: [
                  for (var i = 0; i < shown.length; i++)
                    CallRow(
                      call: shown[i],
                      earning: byCall[shown[i].id],
                      index: i,
                      now: now,
                    ),
                ],
              ),
          ],
        );
      },
    );
  }
}

class CallRow extends StatelessWidget {
  const CallRow({
    super.key,
    required this.call,
    this.earning,
    this.index = 0,
    this.now,
  });

  final HostCall call;
  final CallEarning? earning;

  /// Row position: even rows get a sky initial tile, odd rows a peach one.
  final int index;

  /// "Today" for the time format (a call from today shows only its time).
  final DateTime? now;

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

  /// `@handle`; a name with a space (no real handle) is shown as it is.
  static String handleOf(HostCall c) {
    final h = c.callerHandle;
    if (h == null) return 'A caller';
    return h.startsWith('@') || h.contains(' ') ? h : '@$h';
  }

  @override
  Widget build(BuildContext context) {
    final paid = call.completed && call.billedMinutes >= 1;
    final time = (now != null && DashFormat.isSameDay(call.createdAt, now!))
        ? DashFormat.timeOf(call.createdAt)
        : DashFormat.dayTimeOf(call.createdAt);
    final detail = paid
        ? '${time.isEmpty ? '' : '$time · '}${call.billedMinutes} min'
        : (call.completed ? HostCopy.underMinute : statusText(call));
    final isTest = earning?.isTest ?? false;
    final tint = index.isEven ? HfTint.sky : HfTint.peach;
    final handle = handleOf(call);
    final initial = handle.replaceFirst('@', '').trim();
    final letter = initial.isEmpty
        ? '?'
        : initial.substring(0, 1).toUpperCase();
    return DashSurface(
      key: ValueKey<String>('call-${call.id}'),
      radius: HfRadius.control,
      padding: const EdgeInsets.symmetric(
        horizontal: 14,
        vertical: HfSpacing.lg,
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 40),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: tint.bg(context),
                borderRadius: BorderRadius.circular(HfRadius.chip),
              ),
              child: Text(
                letter,
                style: HfText.bodyStrong.copyWith(
                  color: tint.valueInk(context),
                ),
              ),
            ),
            const SizedBox(width: HfSpacing.lg),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    handle,
                    style: HfText.of(
                      context,
                      HfText.bodyStrong.copyWith(fontSize: 15),
                    ),
                  ),
                  Text(detail, style: dashMuted(context)),
                  if (paid && earning != null) ...[
                    const SizedBox(height: 4),
                    Container(
                      key: ValueKey<String>('tag-${call.id}'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: (isTest ? HfTint.butter : HfTint.blush).bg(
                          context,
                        ),
                        borderRadius: BorderRadius.circular(
                          HfRadius.pillRadius,
                        ),
                      ),
                      child: Text(
                        isTest ? HostCopy.testCall : HostCopy.paidCall,
                        style: HfText.badge.copyWith(
                          color: (isTest ? HfTint.butter : HfTint.blush).ink(
                            context,
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (paid) ...[
              const SizedBox(width: HfSpacing.sm),
              Text(
                '+${formatRupees(call.earningRupees)}',
                key: ValueKey<String>('earned-${call.id}'),
                style: HfText.bodyStrong.copyWith(
                  fontSize: 15,
                  color: HfTint.lavender.ink(context),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
