import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/brand.dart';
import '../../../core/config/flags.dart';
import '../../../core/router/routes.dart';
import '../data/hf_booking_models.dart';
import '../data/hf_bookings_providers.dart';
import 'booking_unavailable_screen.dart';
import 'host_booking_summary_card.dart';

/// The HF appointment calendar is independent of the legacy calendar feature.
class BookingCalendarScreen extends ConsumerWidget {
  const BookingCalendarScreen({super.key, required this.role});
  final String role;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final flags = ref.watch(flagsProvider);
    if (session.isLoading || flags.isLoading) {
      return Scaffold(appBar: AppBar(title: const Text('Appointments calendar')),
        body: const Center(child: CircularProgressIndicator()));
    }
    if (!session.isSignedIn || session.user == null) {
      return Scaffold(appBar: AppBar(title: const Text('Appointments calendar')),
        body: Center(child: FilledButton(
          onPressed: () => context.push(Routes.signInTo(
            role == 'host' ? Routes.hostBookings : Routes.customerBookings)),
          child: const Text('Sign in to view appointments'))));
    }
    if (flags.hasError) {
      return Scaffold(appBar: AppBar(title: const Text('Appointments calendar')),
        body: Center(child: _Message('Calendar could not be loaded.',
          onRetry: () => ref.invalidate(flagsProvider))));
    }
    if (flags.asData?.value.hfBookingsEnabled != true) {
      return const BookingUnavailableScreen(title: 'Appointments calendar');
    }
    return _CalendarBody(key: ValueKey('${session.user!.id}:$role'),
      account: session.user!.id, role: role);
  }
}

class _CalendarBody extends ConsumerStatefulWidget {
  const _CalendarBody({super.key, required this.account, required this.role});
  final String account, role;
  @override
  ConsumerState<_CalendarBody> createState() => _CalendarBodyState();
}

class _CalendarBodyState extends ConsumerState<_CalendarBody> {
  late DateTime _selected;
  late DateTime _month;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _selected = DateTime(now.year, now.month, now.day);
    _month = DateTime(now.year, now.month);
  }

  BookingCalendarQuery get _query =>
      (account: widget.account, role: widget.role, month: _month);

  void _move(int months) => setState(() {
    _month = DateTime(_month.year, _month.month + months);
    _selected = _month;
  });

  void _today() => setState(() {
    final now = DateTime.now();
    _selected = DateTime(now.year, now.month, now.day);
    _month = DateTime(now.year, now.month);
  });

  Future<void> _refresh() async {
    ref.invalidate(bookingCalendarProvider(_query));
    if (widget.role == 'host') ref.invalidate(hostBookingSummaryProvider);
    try { await ref.read(bookingCalendarProvider(_query).future); } catch (_) {
      // The provider displays the error and retry control.
    }
  }

  @override
  Widget build(BuildContext context) {
    final result = ref.watch(bookingCalendarProvider(_query));
    // Never render retained data from a previous account, month or refresh.
    final rows = result.isLoading || result.hasError
        ? <BookingRecord>[] : result.asData?.value ?? <BookingRecord>[];
    final agenda = rows.where((b) => bookingOverlapsDay(b, _selected)).toList();
    final localizations = MaterialLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.role == 'host' ? 'Host calendar' : 'My calendar'),
        actions: [IconButton(tooltip: 'Refresh appointments', onPressed: _refresh,
          icon: const Icon(Icons.refresh))]),
      body: SafeArea(child: Center(child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 920),
        child: RefreshIndicator(onRefresh: _refresh, child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(padding: const EdgeInsets.all(12), sliver: SliverToBoxAdapter(
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (widget.role == 'host') ...[
                  const HostBookingSummaryCard(openCalendarOnTap: false),
                  Align(alignment: Alignment.centerLeft, child: TextButton.icon(
                    icon: const Icon(Icons.edit_calendar_outlined),
                    label: const Text('Edit availability'),
                    onPressed: () => context.push(Routes.hostAvailability))),
                ],
                Text('${Brand.name} calendar', style: Theme.of(context).textTheme.headlineSmall),
                Text('Times shown in device local time: ${_zone(_selected)}.'),
                const SizedBox(height: 12),
                Semantics(header: true, child: Text(localizations.formatMonthYear(_month),
                  style: Theme.of(context).textTheme.titleLarge)),
                Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, children: [
                  IconButton(tooltip: 'Previous month', onPressed: () => _move(-1),
                    icon: const Icon(Icons.chevron_left)),
                  OutlinedButton(onPressed: _today, child: const Text('Today')),
                  IconButton(tooltip: 'Next month', onPressed: () => _move(1),
                    icon: const Icon(Icons.chevron_right)),
                ]),
                _monthGrid(context, rows, result.isLoading || result.hasError),
                const SizedBox(height: 20),
                Semantics(header: true, child: Text(localizations.formatFullDate(_selected),
                  style: Theme.of(context).textTheme.titleLarge)),
                const SizedBox(height: 8),
                if (result.isLoading)
                  const Padding(padding: EdgeInsets.all(20), child: Center(
                    child: CircularProgressIndicator(semanticsLabel: 'Loading appointments')))
                else if (result.hasError)
                  _Message(result.error is ApiError
                      ? (result.error as ApiError).userMessage
                      : 'Appointments could not be loaded.', onRetry: _refresh)
                else if (agenda.isEmpty)
                  const _Message('No appointments on this day. Select another date to view its agenda.')
                else
                  Text('${agenda.length} ${agenda.length == 1 ? 'appointment' : 'appointments'}'),
              ]),
            )),
            SliverPadding(padding: const EdgeInsets.symmetric(horizontal: 12),
              sliver: SliverList(delegate: SliverChildBuilderDelegate((context, index) {
                final booking = agenda[index];
                return Card(child: ListTile(
                  minVerticalPadding: 16,
                  title: Text('${_when(context, booking.startUtc)} – ${_when(context, booking.endUtc)}'),
                  subtitle: Text('Appointment with your ${widget.role == 'host' ? 'customer' : 'host'}\n'
                    '${booking.status.replaceAll('_', ' ')} · ${_zone(booking.startUtc.toLocal())}'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () async {
                    await context.push(Routes.bookingDetailOf(booking.id));
                    if (mounted) await _refresh();
                  },
                ));
              }, childCount: agenda.length))),
            const SliverToBoxAdapter(child: SizedBox(height: 24)),
          ],
        )),
      ))),
    );
  }

  Widget _monthGrid(BuildContext context, List<BookingRecord> rows, bool unknown) {
    final loc = MaterialLocalizations.of(context);
    final firstWeekday = loc.firstDayOfWeekIndex;
    final offset = (_month.weekday % 7 - firstWeekday + 7) % 7;
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final cellCount = ((offset + days + 6) ~/ 7) * 7;
    return LayoutBuilder(builder: (context, constraints) {
      // Keep seven true calendar columns and 48dp targets even on 320dp screens.
      // Large text expands the grid instead of truncating day numbers.
      final cellWidth = math.max(48.0, MediaQuery.textScalerOf(context).scale(28) + 16);
      final width = math.max(constraints.maxWidth, cellWidth * 7);
      return SingleChildScrollView(scrollDirection: Axis.horizontal,
        child: SizedBox(width: width, child: Column(children: [
          Row(children: [for (var i = 0; i < 7; i++) Expanded(child: Center(
            child: Text(loc.narrowWeekdays[(firstWeekday + i) % 7])))]),
          for (var week = 0; week < cellCount ~/ 7; week++)
            Row(children: [for (var col = 0; col < 7; col++) Expanded(child: Builder(
              builder: (context) {
                final dayNumber = week * 7 + col - offset + 1;
                if (dayNumber < 1 || dayNumber > days) return SizedBox(height: cellWidth + 12);
                final day = DateTime(_month.year, _month.month, dayNumber);
                final selected = day == _selected;
                final today = DateUtils.isSameDay(day, DateTime.now());
                final count = rows.where((b) => bookingOverlapsDay(b, day)).length;
                return Semantics(
                  label: '${loc.formatFullDate(day)}${today ? ', today' : ''}, ${unknown ? 'appointments not loaded' : '$count appointments'}',
                  selected: selected, button: true,
                  onTap: () => setState(() => _selected = day),
                  child: ExcludeSemantics(child: AnimatedContainer(
                    duration: MediaQuery.disableAnimationsOf(context)
                        ? Duration.zero : const Duration(milliseconds: 180),
                    curve: Curves.easeOut,
                    decoration: BoxDecoration(
                      color: selected ? Theme.of(context).colorScheme.primaryContainer : Colors.transparent,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: TextButton(
                    style: TextButton.styleFrom(
                      minimumSize: Size(48, cellWidth + 12), padding: EdgeInsets.zero,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      side: today ? BorderSide(color: Theme.of(context).colorScheme.primary) : null,
                    ),
                    onPressed: () => setState(() => _selected = day),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Text('$dayNumber'),
                      SizedBox(height: 10, child: count > 0
                        ? const Icon(Icons.circle, size: 6) : null),
                    ]),
                  ))),
                );
              },
            ))]),
        ])),
      );
    });
  }

  static String _when(BuildContext context, DateTime utc) {
    final value = utc.toLocal();
    final loc = MaterialLocalizations.of(context);
    return '${loc.formatMediumDate(value)} ${loc.formatTimeOfDay(TimeOfDay.fromDateTime(value))} ${value.timeZoneName}';
  }

  static String _zone(DateTime day) {
    final offset = day.timeZoneOffset.inMinutes;
    final hours = (offset.abs() ~/ 60).toString().padLeft(2, '0');
    final minutes = (offset.abs() % 60).toString().padLeft(2, '0');
    return '${day.timeZoneName} (UTC${offset < 0 ? '-' : '+'}$hours:$minutes)';
  }
}

class _Message extends StatelessWidget {
  const _Message(this.text, {this.onRetry});
  final String text;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.all(16),
    child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start,
      children: [Text(text), if (onRetry != null)
        TextButton(onPressed: onRetry, child: const Text('Try again'))]));
}
