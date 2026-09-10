import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_gate.dart';
import '../../core/analytics.dart';
import '../../core/availability_api.dart';
import '../../core/availability_time.dart';
import '../../core/commercial_checkout_api.dart';
import '../../core/listings_api.dart';
import '../../core/money_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/motion/motion.dart';
import '../../features/calendar/calendar_data.dart';
import '../../identity/identity.dart';
import '../wallet/wallet_screen.dart';

/// A self-contained native replacement for the browser booking island.
///
/// This widget intentionally owns its complete visual/state flow. It does not
/// import the legacy listing detail screen or any checkout sheet.
class NativeListingBookingFlow extends StatefulWidget {
  const NativeListingBookingFlow({super.key, required this.listing});

  final ListingCard listing;

  @override
  State<NativeListingBookingFlow> createState() =>
      _NativeListingBookingFlowState();
}

enum _BookingStep { choose, you, pay, done }

class _NativeListingBookingFlowState extends State<NativeListingBookingFlow> {
  _BookingStep _step = _BookingStep.choose;
  DateTime _day = DateTime.now().toLocal();
  ListingAvailability? _availability;
  AvailabilitySlot? _selectedSlot;
  bool _loadingAvailability = false;
  bool _availabilityStale = false;
  bool _accepted = false;
  bool _busy = false;
  int? _balance;
  String? _error;
  CommercialCheckoutResult? _receipt;
  late final String _idempotencyKey = CommercialCheckoutApi.newIdempotencyKey();
  late final String _viewerTimezone = _resolveViewerTimezone();

  bool get _isConsult =>
      widget.listing.kind == 'consult' || widget.listing.kind == 'consult_1to1';
  bool get _free =>
      widget.listing.freeEntry || widget.listing.effectivePrice <= 0;
  String get _ymd =>
      '${_day.year}-${_day.month.toString().padLeft(2, '0')}-${_day.day.toString().padLeft(2, '0')}';
  int get _price => widget.listing.effectivePrice > 0
      ? widget.listing.effectivePrice
      : widget.listing.price;

  @override
  void initState() {
    super.initState();
    Analytics.capture('native_booking_opened',
        {'listing_id': widget.listing.id, 'render_mode': 'native'});
    if (_isConsult) _loadAvailability();
  }

  String _formatYmd(DateTime value) =>
      '${value.year}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

  String _resolveViewerTimezone() {
    final candidate = DateTime.now().timeZoneName.trim();
    if (candidate.contains('/')) {
      try {
        AvailabilityTime.location(candidate);
        return candidate;
      } catch (_) {
        // Some Android builds report a non-IANA abbreviation. UTC is the
        // explicit, valid fallback sent to the server in that case.
      }
    }
    return 'UTC';
  }

  DateTime? _parseDate(String value) {
    final parsed = DateTime.tryParse(value);
    return parsed == null
        ? null
        : DateTime(parsed.year, parsed.month, parsed.day);
  }

  DateTime? _firstServerDay(ListingAvailability value) {
    for (final day in value.days.where((day) => day.availableCount > 0)) {
      final parsed = _parseDate(day.date);
      if (parsed != null) return parsed;
    }
    for (final day in value.days) {
      final parsed = _parseDate(day.date);
      if (parsed != null) return parsed;
    }
    return null;
  }

  Future<void> _loadAvailability() async {
    final now = DateTime.now().toLocal();
    final from = _formatYmd(now);
    // The endpoint accepts at most 62 inclusive dates. Keep the request under
    // that limit and let the server decide which dates are bookable.
    final to = _formatYmd(now.add(const Duration(days: 60)));
    final scope = AccountScope.id;
    AvailabilityCache<ListingAvailability>? cached;
    if (mounted) {
      setState(() {
        _loadingAvailability = true;
        _error = null;
      });
    }
    setState(() {
      _selectedSlot = null;
    });
    try {
      cached = await AvailabilityApi.cachedListingAvailability(
        listingId: widget.listing.id,
        from: from,
        to: to,
        timezone: _viewerTimezone,
      );
      if (scope != AccountScope.id) return;
      if (cached != null && mounted) {
        setState(() {
          _availability = cached!.value;
          _availabilityStale = true;
          _day = _firstServerDay(cached!.value) ?? _day;
        });
      }

      final fresh = await ListingsApi.listingAvailability(
        listingId: widget.listing.id,
        from: from,
        to: to,
        timezone: _viewerTimezone,
      );
      if (scope != AccountScope.id || !mounted) return;
      if (fresh.timezone != _viewerTimezone) {
        throw const AvailabilityApiException(
          statusCode: 200,
          code: 'timezone_mismatch',
          message: 'The server returned availability in a different timezone.',
        );
      }
      setState(() {
        _availability = fresh;
        _availabilityStale = false;
        _selectedSlot = null;
        _day = _firstServerDay(fresh) ?? _day;
        _error = null;
      });
    } on AvailabilityApiException catch (error) {
      if (!mounted || scope != AccountScope.id) return;
      setState(() {
        _availabilityStale = _availability != null;
        _error = error.code == 'account_changed'
            ? error.message
            : 'We could not refresh availability. Please try again.';
      });
    } catch (_) {
      if (mounted && scope == AccountScope.id) {
        setState(() {
          _availabilityStale = _availability != null;
          _error = 'We could not refresh availability. Please try again.';
        });
      }
    } finally {
      if (mounted && scope == AccountScope.id) {
        setState(() => _loadingAvailability = false);
      }
    }
  }

  List<AvailabilitySlot> get _daySlots {
    final value = _availability;
    if (value == null || _availabilityStale) return const <AvailabilitySlot>[];
    return value.slots
        .where((slot) => slot.available && _slotDate(slot) == _ymd)
        .toList(growable: false);
  }

  String _slotDate(AvailabilitySlot slot) =>
      _formatYmd(AvailabilityTime.inTimezone(slot.startAt, _viewerTimezone));

  String? _holdId;
  int? _holdExpiresAt;
  String _holdKey=CommercialCheckoutApi.newIdempotencyKey();

  Future<void> _continueFromChoose() async {
    if (_isConsult && (_selectedSlot == null || _availabilityStale)) {
      if (_availabilityStale) {
        await _loadAvailability();
      }
      if (!mounted) return;
      setState(() => _error = 'Choose an available time first.');
      return;
    }
    if(_step==_BookingStep.you)return;
    _holdKey=CommercialCheckoutApi.newIdempotencyKey();
    setState(() => _step = _BookingStep.you);
    final ok = await AccountGate.ensureMember(context,
        reason: 'sign in to receive your booking');
    if (!mounted || !ok) {
      if (mounted) setState(() => _step = _BookingStep.choose);
      return;
    }
    if(_isConsult){
      final scope=AccountScope.id;
      final slot=_selectedSlot!;
      try{
        final held=await CommercialCheckoutApi.holdConsultation(listingId:widget.listing.id,slotId:slot.id,startAt:slot.startAt.millisecondsSinceEpoch,endAt:slot.endAt.millisecondsSinceEpoch,idempotencyKey:_holdKey);
        if(!mounted || scope!=AccountScope.id)return;
        _holdId=held.id;_holdExpiresAt=held.expiresAt;
      }catch(error){
        if(!mounted || scope!=AccountScope.id)return;
        setState((){_step=_BookingStep.choose;_error='This time could not be reserved. Please select an available time.';_holdKey=CommercialCheckoutApi.newIdempotencyKey();});
        await _loadAvailability();return;
      }
    }
    setState(() => _step = _BookingStep.pay);
    if (!_free) _loadBalance();
  }

  Future<void> _loadBalance() async {
    final result = await MoneyApi.balanceResult();
    if (mounted && result.ok) {
      final value = result.data['spendable'] ??
          result.data['spendable_tokens'] ??
          result.data['balance'];
      setState(() =>
          _balance = value is num ? value.toInt() : int.tryParse('$value'));
    }
  }

  Future<void> _submit() async {
    if (_busy) return;
    if (!_accepted) {
      setState(() => _error = 'Please accept the cancellation policy.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    CommercialCheckoutResult result;
    if (_isConsult) {
      final slot = _selectedSlot;
      if (slot == null || _availabilityStale || !slot.available || _holdId==null || (_holdExpiresAt??0)<=DateTime.now().millisecondsSinceEpoch) {
        setState(() {
          _busy = false;
          _step = _BookingStep.choose;
          _error = 'That availability is out of date. Choose another time.';
        });
        await _loadAvailability();
        return;
      }
      result = await CommercialCheckoutApi.consultation(
        listingId: widget.listing.id,
        startAt: slot.startAt.millisecondsSinceEpoch,
        endAt: slot.endAt.millisecondsSinceEpoch,
        holdId:_holdId,
        acceptPolicy: true,
        idempotencyKey: _idempotencyKey,
      );
    } else if (widget.listing.kind == 'live_event') {
      result = await CommercialCheckoutApi.liveTicket(
        listingId: widget.listing.id,
        acceptPolicy: true,
        idempotencyKey: _idempotencyKey,
      );
    } else {
      // Legacy/agent listings still use the server-owned booking endpoint;
      // they are presented in this same native flow rather than falling back
      // to the retired browser or bottom-sheet experience.
      try {
        final booking = await ListingsApi.book(widget.listing.id,
            slotStart: _selectedSlot?.startAt.millisecondsSinceEpoch,
            slotEnd: _selectedSlot?.endAt.millisecondsSinceEpoch);
        result = CommercialCheckoutResult(
            status: 200,
            ok: true,
            listingId: widget.listing.id,
            bookingId: booking['booking_id']?.toString(),
            orderId: booking['order_id']?.toString(),
            grossAmount: _price);
      } catch (_) {
        result = const CommercialCheckoutResult(
            status: 0, ok: false, error: 'network');
      }
    }
    if (!mounted) return;
    if (!result.ok && _isConsult && _slotWasStolen(result)) {
      setState(() {
        _busy = false;
        _selectedSlot = null;
        _step = _BookingStep.choose;
        _error = 'That time was just booked. Choose another available slot.';
      });
      await _loadAvailability();
      if (mounted) {
        setState(() => _error =
            'That time was just booked. Choose another available slot.');
      }
      return;
    }
    final receipt = result;
    setState(() {
      _busy = false;
      _receipt = receipt;
      if (receipt.ok)
        _step = _BookingStep.done;
      else
        _error = receipt.error == 'insufficient_funds'
            ? 'Your wallet needs more balance before this booking can be confirmed.'
            : 'Booking could not be completed. Please try again.';
    });
  }

  bool _slotWasStolen(CommercialCheckoutResult result) {
    if (result.status != 409 && result.status != 400) return false;
    final error = (result.error ?? '').toLowerCase();
    return error.contains('slot') ||
        error.contains('availability') ||
        error.contains('booked') ||
        error.contains('conflict') ||
        error.contains('reservation') ||
        error.contains('hold');
  }

  String _slotLabel(AvailabilitySlot slot) {
    final d = AvailabilityTime.inTimezone(slot.startAt, _viewerTimezone);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
            title: const Text('Book your spot'),
            backgroundColor: AD.bg),
        body: SafeArea(child: LayoutBuilder(builder: (context, constraints) {
          final content = ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                _header(),
                const SizedBox(height: 20),
                _stepBody(),
              ]);
          return Center(
              child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 620),
                  child: content));
        })),
      );

  Widget _header() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(widget.listing.title,
            style: const TextStyle(fontFamily: ADText.display, fontSize: 25, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text(widget.listing.oneLiner,
            style: const TextStyle(color: AD.textSecondary)),
        const SizedBox(height: 18),
        Row(children: [
          for (final s in _BookingStep.values) Expanded(child: _dot(s))
        ]),
      ]);

  Widget _dot(_BookingStep s) {
    final active = s.index <= _step.index;
    return Column(children: [
      CircleAvatar(
          radius: 16,
          backgroundColor: active ? AD.haldi : AD.borderDivider,
          child: Text('${s.index + 1}')),
      const SizedBox(height: 5),
      Text(['Choose', 'You', 'Pay', 'Done'][s.index],
          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700))
    ]);
  }

  Widget _stepBody() {
    switch (_step) {
      case _BookingStep.choose:
        return _choose();
      case _BookingStep.you:
        return _you();
      case _BookingStep.pay:
        return _pay();
      case _BookingStep.done:
        return _done();
    }
  }

  Widget _choose() =>
      _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(_isConsult ? 'Choose a date and time' : 'Your ticket',
            style: const TextStyle(fontFamily: ADText.display, fontSize: 20, fontWeight: FontWeight.w700)),
        if (_isConsult) ...[
          const SizedBox(height: 14),
          Text('Times shown in $_viewerTimezone',
              style: const TextStyle(color: AD.textSecondary)),
          const SizedBox(height: 10),
          OutlinedButton.icon(
              onPressed: _loadingAvailability || _availability == null
                  ? null
                  : () async {
                      final days = _availability!.days
                          .map((day) => _parseDate(day.date))
                          .whereType<DateTime>()
                          .toList(growable: false);
                      if (days.isEmpty) return;
                      final d = await showDatePicker(
                          context: context,
                          initialDate: _day,
                          firstDate: days.first,
                          lastDate: days.last,
                          selectableDayPredicate: (candidate) =>
                              _availability!.days.any((day) =>
                                  day.availableCount > 0 &&
                                  day.date == _formatYmd(candidate)));
                      if (d != null && mounted) {
                        setState(() => _day = d);
                        setState(() => _selectedSlot = null);
                      }
                    },
              icon: PhosphorIcon(PhosphorIcons.calendar(PhosphorIconsStyle.bold)),
              label: Text(_ymd)),
          const SizedBox(height: 14),
          if (_loadingAvailability && _availability == null)
            const Center(child: CircularProgressIndicator())
          else if (_availability == null && _error != null) ...[
            _errorText(),
            const SizedBox(height: 8),
            OutlinedButton.icon(
                onPressed: _loadingAvailability ? null : _loadAvailability,
                icon: PhosphorIcon(
                    PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold)),
                label: const Text('Retry')),
          ]
          else if (_availabilityStale) ...[
            const Text(
                'Availability is out of date. Refresh before choosing a time.',
                style: TextStyle(color: AD.terracotta)),
            const SizedBox(height: 8),
            OutlinedButton.icon(
                onPressed: _loadingAvailability ? null : _loadAvailability,
                icon: PhosphorIcon(
                    PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold)),
                label: const Text('Refresh availability')),
          ]
          else if (_daySlots.isEmpty)
            const Text('No available times were returned for this date.',
                style: TextStyle(color: AD.textSecondary))
          else
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final slot in _daySlots)
                ChoiceChip(
                    label: Text(_slotLabel(slot)),
                    selected: _selectedSlot?.id == slot.id,
                    onSelected: (_) =>
                        setState(() => _selectedSlot = slot))
            ]),
        ] else
          Text(
              'Live event ticket · ${widget.listing.startsAt == null ? 'Schedule shown after confirmation' : 'Event access included'}'),
        if (_error != null) _errorText(),
        const SizedBox(height: 22),
        _primary('Continue', _continueFromChoose),
      ]));

  Widget _you() =>
      _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('You',
            style: TextStyle(fontFamily: ADText.display, fontSize: 20, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        const Text('Your account protects the booking and receives reminders.'),
        const SizedBox(height: 18),
        _primary('Continue to payment', () {
          setState(() => _step = _BookingStep.pay);
          if (!_free) _loadBalance();
        })
      ]));

  Widget _pay() =>
      _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(_free ? 'Confirm free booking' : 'Review and pay',
            style: const TextStyle(fontFamily: ADText.display, fontSize: 20, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        Text(_free
            ? '₹0 · Free entry'
            : 'Wallet price · $_price ${widget.listing.currency}'),
        if (_balance != null)
          Text('Wallet balance: $_balance ${widget.listing.currency}',
              style: const TextStyle(color: AD.textSecondary)),
        const SizedBox(height: 14),
        Text(_isConsult
            ? 'Cancel according to the creator policy before your selected time. No-shows may not be refunded.'
            : 'Ticket refund terms follow the event policy.'),
        CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _accepted,
            onChanged: (v) => setState(() => _accepted = v ?? false),
            title: const Text('I accept the cancellation policy')),
        if (!_free && _balance != null && _balance! < _price) ...[
          const Text('Your wallet is short for this booking.',
              style: const TextStyle(color: AD.terracotta)),
          const SizedBox(height: 8),
          OutlinedButton.icon(
              onPressed: _busy
                  ? null
                  : () async {
                      await Navigator.push(
                          context,
                          MaterialPageRoute(
                              builder: (_) => const WalletScreen()));
                      if (mounted) _loadBalance();
                    },
              icon: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold)),
              label: const Text('Add Tokens')),
        ],
        if (_error != null) _errorText(),
        _primary(
            _busy
                ? 'Processing…'
                : (_free ? 'Reserve for free' : 'Pay and confirm'),
            _busy ? null : _submit)
      ]));

  Widget _done() =>
      _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const AdSuccessCheck(size: 52, color: AD.online),
        const SizedBox(height: 10),
        const Text('You’re booked',
            style: TextStyle(fontFamily: ADText.display, fontSize: 24, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Text(_receipt?.bookingId == null
            ? 'Your access is ready.'
            : 'Confirmation ${_receipt!.bookingId}'),
        const SizedBox(height: 18),
        _primary('Done', () => Navigator.of(context).pop(true))
      ]));

  Widget _card(Widget child) => Card(
      elevation: 0,
      color: AD.card,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rSheet),
          side: const BorderSide(color: AD.borderDivider)),
      child: Padding(padding: const EdgeInsets.all(20), child: child));
  Widget _primary(String label, VoidCallback? onPressed) => SizedBox(
      width: double.infinity,
      child: FilledButton(
          onPressed: onPressed,
          style: FilledButton.styleFrom(
              backgroundColor: AD.textPrimary,
              foregroundColor: AD.bg,
              padding: const EdgeInsets.symmetric(vertical: 16)),
          child: Text(label)));
  Widget _errorText() => Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Text(_error!,
          style:
              const TextStyle(color: AD.danger, fontWeight: FontWeight.w600)));
}
