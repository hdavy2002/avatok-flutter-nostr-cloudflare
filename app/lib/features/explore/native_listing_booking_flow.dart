import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_gate.dart';
import '../../core/analytics.dart';
import '../../core/commercial_checkout_api.dart';
import '../../core/listings_api.dart';
import '../../core/money_api.dart';
import '../../core/ui/avatok_dark.dart';
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
  DateTime _day = DateTime.now().add(const Duration(days: 1));
  List<Map<String, dynamic>> _slots = const [];
  Map<String, dynamic>? _selected;
  bool _loadingSlots = false;
  bool _accepted = false;
  bool _busy = false;
  int? _balance;
  String? _error;
  CommercialCheckoutResult? _receipt;
  late final String _idempotencyKey = CommercialCheckoutApi.newIdempotencyKey();

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
    if (_isConsult) _loadSlots();
  }

  Future<void> _loadSlots() async {
    setState(() {
      _loadingSlots = true;
      _selected = null;
      _error = null;
    });
    try {
      final rows = await ListingsApi.slotGrid(
          widget.listing.creator.uid, _ymd, widget.listing.durationMin ?? 60);
      if (!mounted) return;
      setState(
          () => _slots = rows.where((s) => s['available'] != false).toList());
    } catch (_) {
      if (mounted)
        setState(
            () => _error = 'We could not load availability. Please try again.');
    } finally {
      if (mounted) setState(() => _loadingSlots = false);
    }
  }

  Future<void> _continueFromChoose() async {
    if (_isConsult && _selected == null) {
      setState(() => _error = 'Choose an available time first.');
      return;
    }
    setState(() => _step = _BookingStep.you);
    final ok = await AccountGate.ensureMember(context,
        reason: 'sign in to receive your booking');
    if (!mounted || !ok) {
      if (mounted) setState(() => _step = _BookingStep.choose);
      return;
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
      result = await CommercialCheckoutApi.consultation(
        listingId: widget.listing.id,
        startAt: _slotValue('start_at', 'starts_at'),
        endAt: _slotValue('end_at', 'ends_at'),
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
            slotStart:
                _selected == null ? null : _slotValue('start_at', 'starts_at'),
            slotEnd:
                _selected == null ? null : _slotValue('end_at', 'ends_at'));
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

  int _slotValue(String a, String b) =>
      ((_selected?[a] ?? _selected?[b]) as num?)?.toInt() ?? 0;

  String _slotLabel(Map<String, dynamic> s) {
    final ms = _slotValueFrom(s, 'start_at', 'starts_at');
    if (ms == 0) return 'Time unavailable';
    final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  int _slotValueFrom(Map<String, dynamic> s, String a, String b) =>
      ((s[a] ?? s[b]) as num?)?.toInt() ?? 0;

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
            style: const TextStyle(fontSize: 25, fontWeight: FontWeight.w900)),
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
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        if (_isConsult) ...[
          const SizedBox(height: 14),
          OutlinedButton.icon(
              onPressed: _loadingSlots
                  ? null
                  : () async {
                      final d = await showDatePicker(
                          context: context,
                          initialDate: _day,
                          firstDate: DateTime.now(),
                          lastDate:
                              DateTime.now().add(const Duration(days: 90)));
                      if (d != null) {
                        setState(() => _day = d);
                        _loadSlots();
                      }
                    },
              icon: PhosphorIcon(PhosphorIcons.calendar(PhosphorIconsStyle.bold)),
              label: Text(_ymd)),
          const SizedBox(height: 14),
          if (_loadingSlots)
            const Center(child: CircularProgressIndicator())
          else
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final slot in _slots)
                ChoiceChip(
                    label: Text(_slotLabel(slot)),
                    selected: identical(_selected, slot),
                    onSelected: (_) => setState(() => _selected = slot))
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
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
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
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
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
        PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
            color: AD.online, size: 52),
        const SizedBox(height: 10),
        const Text('You’re booked',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.w900)),
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
          borderRadius: BorderRadius.circular(22),
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
