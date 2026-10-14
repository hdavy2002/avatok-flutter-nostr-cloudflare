import 'dart:math';

import 'package:flutter/material.dart';
import '../../../core/config/flags.dart';
import 'booking_unavailable_screen.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../data/hf_booking_models.dart';
import '../data/hf_bookings_providers.dart';

class CustomerBookingScreen extends ConsumerStatefulWidget {
  const CustomerBookingScreen({super.key, required this.hostSlug, this.initialDate, this.initialDuration, this.initialStartUtc});
  final String hostSlug;
  final DateTime? initialDate;
  final int? initialDuration;
  final DateTime? initialStartUtc;
  @override
  ConsumerState<CustomerBookingScreen> createState() => _CustomerBookingScreenState();
}

class _CustomerBookingScreenState extends ConsumerState<CustomerBookingScreen> {
  late DateTime _day = widget.initialDate ?? DateTime.now().add(const Duration(days: 1));
  late int _duration = widget.initialDuration ?? 30;
  List<BookingSlot> _slots = const [];
  BookingSlot? _selected;
  BookingQuote? _quote;
  bool _loadingSlots = false;
  bool _busy = false;
  bool _policyAccepted = false;
  String? _error;
  String? _idempotencyKey;
  bool _restoreIntent = true;
  int _accountEpoch = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadSlots());
  }

  Future<void> _loadSlots() async {
    setState(() { _loadingSlots = true; _error = null; _selected = null; _quote = null; });
    try {
      final selectedDay = DateTime(_day.year, _day.month, _day.day);
      final rows = await ref.read(hfBookingsApiProvider).slots(
        slug: widget.hostSlug,
        from: DateTime(selectedDay.year, selectedDay.month, selectedDay.day - 1),
        to: DateTime(selectedDay.year, selectedDay.month, selectedDay.day + 2),
        durationMinutes: _duration,
      );
      if (!mounted) return;
      final customerDayRows = rows.where((slot) {
        final local = slot.startUtc.toLocal();
        return local.year == selectedDay.year && local.month == selectedDay.month && local.day == selectedDay.day;
      }).toList();
      BookingSlot? initialSlot;
      final initialStart = _restoreIntent ? widget.initialStartUtc?.toUtc() : null;
      if (initialStart != null) {
        for (final slot in customerDayRows) {
          if (slot.startUtc.isAtSameMomentAs(initialStart)) initialSlot = slot;
        }
      }
      setState(() {
        _slots = customerDayRows;
        _selected = initialSlot;
        _restoreIntent = false;
        _loadingSlots = false;
      });
      await Analytics.capture('hf_app_booking_slots_viewed', {'slot_count': customerDayRows.length, 'duration_minutes': _duration});
    } catch (e) {
      if (!mounted) return;
      setState(() { _loadingSlots = false; _error = e is ApiError && e.isNotEnabled
        ? 'Bookings are not available yet.'
        : 'Times could not be loaded. Check your connection and try again.'; });
    }
  }

  Future<void> _chooseDay() async {
    final day = await showDatePicker(
      context: context, initialDate: _day, firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 60)),
    );
    if (day == null || !mounted) return;
    setState(() { _day = day; _quote = null; });
    await _loadSlots();
  }

  Future<void> _reviewPrice() async {
    final slot = _selected;
    if (slot == null || _busy) return;
    final date = '${_day.year.toString().padLeft(4,'0')}-${_day.month.toString().padLeft(2,'0')}-${_day.day.toString().padLeft(2,'0')}';
    final next = Routes.bookingFor(widget.hostSlug, date: date, duration: _duration, startUtc: slot.startUtc);
    if (!await requireSignIn(context, ref, next: next)) return;
    final accountEpoch = _accountEpoch;
    if (!mounted) return;
    setState(() { _busy = true; _error = null; });
    try {
      final quote = await ref.read(hfBookingsApiProvider).quote(
        hostSlug: widget.hostSlug, slot: slot, durationMinutes: _duration,
      );
      if (!mounted || accountEpoch != _accountEpoch) return;
      setState(() {
        _quote = quote;
        _policyAccepted = false;
        _idempotencyKey = 'hf-book-${quote.id}-${Random.secure().nextInt(1 << 32)}';
        _busy = false;
      });
      await Analytics.capture('hf_app_booking_quote_created', {
        'duration_minutes': quote.durationMinutes, 'reserved_paise': quote.reservedPaise,
        'quote_id': quote.id,
      });
    } catch (e) {
      if (!mounted || accountEpoch != _accountEpoch) return;
      setState(() { _busy = false; _quote = null; _error = e is ApiError && e.status == 409
        ? 'That time was just taken. Choose another time.'
        : 'Price could not be confirmed. Refresh the available times and try again.'; });
      await Analytics.capture('hf_app_booking_conflict', {if (e is ApiError) 'status_code': e.status});
      await _loadSlots();
    }
  }

  Future<void> _confirm() async {
    final quote = _quote;
    final key = _idempotencyKey;
    if (quote == null || key == null || _busy || !_policyAccepted) return;
    final accountEpoch = _accountEpoch;
    if (quote.expiresAt != null && !quote.expiresAt!.isAfter(DateTime.now().toUtc())) {
      setState(() { _quote = null; _error = 'The price expired. Choose the time again to get a fresh quote.'; });
      return;
    }
    setState(() { _busy = true; _error = null; });
    try {
      final booking = await ref.read(hfBookingsApiProvider).confirm(quote.id, policyAccepted: _policyAccepted, idempotencyKey: key);
      if (!mounted || accountEpoch != _accountEpoch) return;
      if (booking.id.isEmpty || !const {'confirmed','scheduled','active'}.contains(booking.status)) {
        setState(() { _busy = false; _error = 'The server did not confirm this booking. Refresh your bookings to check its status.'; });
        return;
      }
      await Analytics.capture('hf_app_booking_confirmed', {
        'booking_id': booking.id, 'quote_id': quote.id, 'duration_minutes': quote.durationMinutes,
        'reserved_paise': booking.reservedPaise,
      });
      ref.invalidate(customerBookingsProvider);
      ref.invalidate(bookingCalendarProvider);
      if (!mounted) return;
      await showDialog<void>(context: context, barrierDismissible: false, builder: (context) => AlertDialog(
        title: const Text('Booking confirmed'),
        content: Text('Your appointment is ${MaterialLocalizations.of(context).formatMediumDate(booking.startUtc.toLocal())} at ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(booking.startUtc.toLocal()))}.'),
        actions: [
          TextButton(onPressed: () { Navigator.pop(context); context.go(Routes.customerBookings); }, child: const Text('View my bookings')),
          FilledButton(onPressed: () { Navigator.pop(context); context.pop(); }, child: const Text('Done')),
        ],
      ));
    } catch (e) {
      if (!mounted || accountEpoch != _accountEpoch) return;
      setState(() { _busy = false; _error = e is ApiError && e.status == 409
        ? 'That quote or time has expired. Refresh the times before confirming.'
        : 'Booking confirmation is still unknown. Your booking list will show the server status.'; });
      await Analytics.capture('hf_app_booking_conflict', {'stage': 'confirm', if (e is ApiError) 'status_code': e.status});
      ref.invalidate(customerBookingsProvider);
      ref.invalidate(bookingCalendarProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(bookingAccountScopeProvider, (previous, next) {
      if (previous == next) return;
      _accountEpoch++;
      setState(() {
        _slots = const [];
        _selected = null;
        _quote = null;
        _idempotencyKey = null;
        _policyAccepted = false;
        _busy = false;
        _error = null;
        _restoreIntent = false;
      });
      _loadSlots();
    });
    if (ref.watch(flagsProvider).asData?.value.hfBookingsEnabled != true) {
      return const BookingUnavailableScreen(title: 'Book a time');
    }
    final money = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Book a time'), actions: [
        IconButton(tooltip: 'My bookings', onPressed: () => context.push(Routes.customerBookings), icon: const Icon(Icons.event_note_outlined)),
      ]),
      body: Center(child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 680),
        child: ListView(padding: const EdgeInsets.all(20), children: [
          Text('Choose a duration', style: money.titleLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [for (final minutes in const [15,30,45,60])
            ChoiceChip(label: Text('$minutes min'), selected: _duration == minutes, onSelected: (_) {
              setState(() { _duration = minutes; _quote = null; });
              _loadSlots();
            }),
          ]),
          const SizedBox(height: 20),
          Text('Choose a date', style: money.titleLarge),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _chooseDay, icon: const Icon(Icons.calendar_today_outlined),
            label: Text(MaterialLocalizations.of(context).formatMediumDate(_day)),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _loadingSlots ? null : _loadSlots,
            icon: _loadingSlots ? const SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2)) : const Icon(Icons.refresh),
            label: Text(_loadingSlots ? 'Finding times…' : 'Show available times'),
          ),
          if (_error != null) Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Semantics(liveRegion: true, child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          ),
          if (_slots.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('Available times', style: money.titleLarge),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final slot in _slots) ChoiceChip(
                label: Text('${slot.hostLocalLabel ?? MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(slot.startUtc.toLocal()))}${slot.offsetLabel == null ? '' : ' ${slot.offsetLabel}'}'),
                selected: _selected == slot,
                onSelected: (_) => setState(() { _selected = slot; _quote = null; }),
              ),
            ]),
          ] else if (!_loadingSlots && _error == null)
            const Padding(padding: EdgeInsets.all(12), child: Text('No times are open on this date. Try another date.')),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _selected == null || _busy ? null : _reviewPrice,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: Text(_busy ? 'Checking…' : 'Review price'),
          ),
          if (_quote != null) ...[
            const SizedBox(height: 16),
            Card(child: Padding(padding: const EdgeInsets.all(18), child: Column(
              crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Your price', style: money.titleLarge),
                const SizedBox(height: 8),
                Text(formatRupees(_quote!.priceRupees), style: money.headlineMedium),
                Text('${_quote!.durationMinutes} minutes · reserved ${formatPaise(_quote!.reservedPaise)}'),
                const SizedBox(height: 8),
                const Text('Times are shown in the host’s local time. Your selected date and confirmation are shown in your device time.'),
                const SizedBox(height: 8),
                const Text('You can cancel before the call connects. The reserved value returns under the booking policy.'),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _policyAccepted,
                  onChanged: _busy ? null : (value) => setState(() => _policyAccepted = value ?? false),
                  title: const Text('I agree to the booking and cancellation policy.'),
                  controlAffinity: ListTileControlAffinity.leading,
                  minTileHeight: 48,
                ),
                if (_quote!.expiresAt != null) Text('Price valid until ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(_quote!.expiresAt!.toLocal()))}.'),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _busy || !_policyAccepted ? null : _confirm,
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  child: Text(_busy ? 'Confirming…' : 'Confirm booking'),
                ),
              ],
            ))),
          ],
        ]),
      )),
    );
  }
}
