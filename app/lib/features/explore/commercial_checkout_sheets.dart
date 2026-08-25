import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/commercial_checkout_api.dart';
import '../../core/listings_api.dart';
import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../wallet/wallet_screen.dart';

Future<CommercialCheckoutResult?> showLiveCheckoutSheet(
  BuildContext context, {
  required ListingCard listing,
}) =>
    showModalBottomSheet<CommercialCheckoutResult>(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => LiveCheckoutSheet(listing: listing));

Future<CommercialCheckoutResult?> showConsultCheckoutSheet(
  BuildContext context, {
  required ListingCard listing,
}) =>
    showModalBottomSheet<CommercialCheckoutResult>(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => ConsultCheckoutSheet(listing: listing));

abstract class _CommercialCheckoutSheet extends StatefulWidget {
  const _CommercialCheckoutSheet({super.key, required this.listing});
  final ListingCard listing;
}

abstract class _CommercialCheckoutSheetState<T extends _CommercialCheckoutSheet>
    extends State<T> {
  bool acceptedPolicy = false;
  bool busy = false;
  int? balance;
  bool walletUnavailable = false;
  bool showTopUp = false;
  String? error;
  late final String idempotencyKey;

  ListingCard get listing => widget.listing;
  bool get checkoutEnabled;
  String get productLabel;

  @override
  void initState() {
    super.initState();
    idempotencyKey = CommercialCheckoutApi.newIdempotencyKey();
    _loadBalance();
  }

  Future<void> _loadBalance() async {
    try {
      final result = await MoneyApi.balanceResult();
      if (!mounted) return;
      if (!result.ok) {
        // A free reservation does not need wallet state. Paid checkout must
        // fail closed when spendable funds cannot be verified.
        setState(() => walletUnavailable = listing.effectivePrice > 0);
        return;
      }
      final value = result.data;
      final spendable = value['spendable'] ?? value['spendable_tokens'];
      // Older balance responses expose `balance` as the spendable amount. Use
      // it only as a compatibility fallback; never use paid-only held data.
      final resolved = spendable is num
          ? spendable.toInt()
          : (value['balance'] as num?)?.toInt();
      setState(() {
        balance = resolved;
        walletUnavailable = listing.effectivePrice > 0 && resolved == null;
        showTopUp = resolved != null &&
            listing.effectivePrice > 0 &&
            resolved < listing.effectivePrice;
      });
    } catch (_) {
      if (mounted)
        setState(() => walletUnavailable = listing.effectivePrice > 0);
    }
  }

  bool get insufficientBalance =>
      balance != null &&
      listing.effectivePrice > 0 &&
      balance! < listing.effectivePrice;

  Future<void> confirm();

  Widget policyBlock(
          {required String scheduleLine, required String cancellationLine}) =>
      ZineCard(
        radius: Msg.rMd,
        padding: const EdgeInsets.all(Msg.s3),
        boxShadow: const <BoxShadow>[],
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.bold),
                color: AD.primaryBadge),
            const SizedBox(width: Msg.s2),
            Text('Payment and session terms', style: ADText.rowName()),
          ]),
          const SizedBox(height: Msg.s2),
          Text('Total: ${listing.priceLabel}',
              style: ADText.preview(c: AD.textPrimary)),
          Text('Held safely until the session rules are completed.',
              style: ADText.preview()),
          Text(scheduleLine, style: ADText.preview()),
          Text(cancellationLine, style: ADText.preview()),
          Text(
              'No-show policy: the session charge applies when the customer does not attend.',
              style: ADText.preview()),
        ]),
      );

  Widget consentBlock() => CheckboxListTile(
        contentPadding: EdgeInsets.zero,
        value: acceptedPolicy,
        onChanged: busy
            ? null
            : (value) => setState(() => acceptedPolicy = value == true),
        title: Text(
          'I understand the session, price and cancellation terms.',
          style: ADText.preview(c: AD.textPrimary),
        ),
        controlAffinity: ListTileControlAffinity.leading,
      );

  Widget actionButton() => FilledButton.icon(
        style: FilledButton.styleFrom(minimumSize: const Size(0, 48)),
        onPressed: !checkoutEnabled ||
                busy ||
                !acceptedPolicy ||
                insufficientBalance ||
                (walletUnavailable && listing.effectivePrice > 0)
            ? null
            : confirm,
        icon: busy
            ? const SizedBox.square(
                dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
            : Icon(PhosphorIcons.lockKey(PhosphorIconsStyle.bold)),
        label: Text(
          busy
              ? 'Confirming securely…'
              : insufficientBalance
                  ? 'Not enough Tokens'
                  : 'Confirm & pay',
        ),
      );

  Widget _topUpButton() => OutlinedButton.icon(
        onPressed: busy
            ? null
            : () async {
                await Navigator.push(context,
                    MaterialPageRoute(builder: (_) => const WalletScreen()));
                if (mounted) _loadBalance();
              },
        icon: Icon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold)),
        label: const Text('Add Tokens'),
      );

  Widget shell({required List<Widget> children}) => Container(
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          border: Border(top: BorderSide(color: AD.borderHairline)),
        ),
        padding: EdgeInsets.fromLTRB(
          Msg.s5,
          Msg.s4,
          Msg.s5,
          20 +
              MediaQuery.of(context).viewInsets.bottom +
              MediaQuery.of(context).viewPadding.bottom,
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                      child: Container(
                          width: 40,
                          height: 5,
                          margin: const EdgeInsets.only(bottom: Msg.s4),
                          decoration: BoxDecoration(
                              color: AD.borderControl,
                              borderRadius: Msg.brPill))),
                  Text(productLabel, style: ADText.appTitle()),
                  const SizedBox(height: Msg.s1),
                  Text(listing.title, style: ADText.preview(c: AD.textPrimary)),
                  const SizedBox(height: Msg.s4),
                  if (!checkoutEnabled)
                    const _CheckoutInfo(
                        text: 'Commercial checkout is not available yet.')
                  else
                    ...children,
                  if (error != null) ...[
                    const SizedBox(height: Msg.s3),
                    Text(error!, style: ADText.preview(c: AD.danger)),
                  ],
                  if (showTopUp) ...[
                    const SizedBox(height: Msg.s2),
                    _topUpButton(),
                  ],
                ]),
          ),
        ),
      );

  void showResult(CommercialCheckoutResult result) {
    if (result.ok) {
      Analytics.capture('commercial_checkout_confirmed', {
        'kind': productLabel,
        'listing_id': listing.id,
        'idempotent_replay': result.idempotentReplay,
      });
      Navigator.pop(context, result);
      return;
    }
    final insufficient =
        result.status == 402 || result.error == 'insufficient_funds';
    setState(() {
      busy = false;
      showTopUp = insufficient;
      error = insufficient
          ? 'Not enough Tokens. Add funds, then use Confirm again; this checkout key remains safe to retry.'
          : result.error == 'policy confirmation required'
              ? 'Confirm the policy checkbox before paying.'
              : result.error == 'consultation slot already booked'
                  ? 'That time was just booked. Choose another available slot.'
                  : 'Checkout could not be completed. Nothing was admitted; try again.';
    });
  }

  @override
  Widget build(BuildContext context);
}

class LiveCheckoutSheet extends _CommercialCheckoutSheet {
  const LiveCheckoutSheet({super.key, required ListingCard listing})
      : super(listing: listing);

  @override
  State<LiveCheckoutSheet> createState() => _LiveCheckoutSheetState();
}

class _LiveCheckoutSheetState
    extends _CommercialCheckoutSheetState<LiveCheckoutSheet> {
  @override
  bool get checkoutEnabled => RemoteConfig.commercialLiveCheckoutEnabled;

  @override
  String get productLabel => 'Buy live-event ticket';

  @override
  Future<void> confirm() async {
    if (busy || !acceptedPolicy) return;
    setState(() {
      busy = true;
      error = null;
    });
    final result = await CommercialCheckoutApi.liveTicket(
      listingId: listing.id,
      acceptPolicy: acceptedPolicy,
      idempotencyKey: idempotencyKey,
    );
    if (mounted) showResult(result);
  }

  String _when() {
    final start = listing.startsAt;
    if (start == null) return 'Event time will be confirmed by the server.';
    final date = DateTime.fromMillisecondsSinceEpoch(start).toLocal();
    return 'Starts ${date.day}/${date.month}/${date.year} at ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')} local time.';
  }

  @override
  Widget build(BuildContext context) => shell(children: [
        policyBlock(
          scheduleLine: _when(),
          cancellationLine: listing.commercialRefundWindowHours == 0
              ? 'Tickets are non-refundable.'
              : 'Refunds are available until ${listing.commercialRefundWindowHours}h before start.',
        ),
        const SizedBox(height: Msg.s3),
        if (balance != null)
          Text('Spendable wallet balance: $balance ${listing.currency}',
              style: ADText.preview()),
        if (walletUnavailable)
          const _CheckoutInfo(
              text:
                  'Wallet balance could not be verified. Checkout is paused until it is available.'),
        if (insufficientBalance) ...[
          const SizedBox(height: Msg.s2),
          const _CheckoutInfo(
              text:
                  'Your wallet balance is below the server listing price. Top up before confirming.'),
        ],
        consentBlock(),
        actionButton(),
      ]);
}

class ConsultCheckoutSheet extends _CommercialCheckoutSheet {
  const ConsultCheckoutSheet({super.key, required ListingCard listing})
      : super(listing: listing);

  @override
  State<ConsultCheckoutSheet> createState() => _ConsultCheckoutSheetState();
}

class _ConsultCheckoutSheetState
    extends _CommercialCheckoutSheetState<ConsultCheckoutSheet> {
  List<Map<String, dynamic>> slots = const [];
  Map<String, dynamic>? selected;
  DateTime day = DateTime.now().add(const Duration(days: 1));
  bool loadingSlots = true;

  @override
  bool get checkoutEnabled => RemoteConfig.commercialConsultCheckoutEnabled;

  @override
  String get productLabel => 'Book 1:1 consultation';

  @override
  void initState() {
    super.initState();
    _loadSlots();
  }

  String get _ymd =>
      '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';

  Future<void> _loadSlots() async {
    if (!checkoutEnabled) {
      if (mounted) setState(() => loadingSlots = false);
      return;
    }
    setState(() {
      loadingSlots = true;
      selected = null;
    });
    final loaded = await ListingsApi.slotGrid(
        listing.creator.uid, _ymd, listing.durationMin ?? 60);
    if (!mounted) return;
    setState(() {
      slots = loaded.where((slot) => slot['available'] != false).toList();
      loadingSlots = false;
    });
  }

  int _slotStart(Map<String, dynamic> slot) => (slot['start_at'] ??
          slot['starts_at'] ??
          slot['start']) is num
      ? ((slot['start_at'] ?? slot['starts_at'] ?? slot['start']) as num)
          .toInt()
      : int.tryParse(
              '${slot['start_at'] ?? slot['starts_at'] ?? slot['start']}') ??
          0;

  int _slotEnd(Map<String, dynamic> slot) => (slot['end_at'] ??
          slot['ends_at'] ??
          slot['end']) is num
      ? ((slot['end_at'] ?? slot['ends_at'] ?? slot['end']) as num).toInt()
      : int.tryParse('${slot['end_at'] ?? slot['ends_at'] ?? slot['end']}') ??
          0;

  String _slotLabel(Map<String, dynamic> slot) {
    final start =
        DateTime.fromMillisecondsSinceEpoch(_slotStart(slot)).toLocal();
    return '${start.hour.toString().padLeft(2, '0')}:${start.minute.toString().padLeft(2, '0')}';
  }

  @override
  Future<void> confirm() async {
    if (busy || !acceptedPolicy || selected == null) {
      if (selected == null && mounted)
        setState(() => error = 'Choose an available time first.');
      return;
    }
    final start = _slotStart(selected!);
    final end = _slotEnd(selected!);
    if (start <= 0 || end <= start) {
      setState(
          () => error = 'This slot has no valid server time. Choose another.');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    final result = await CommercialCheckoutApi.consultation(
      listingId: listing.id,
      startAt: start,
      endAt: end,
      acceptPolicy: acceptedPolicy,
      idempotencyKey: idempotencyKey,
    );
    if (mounted) showResult(result);
  }

  @override
  Widget build(BuildContext context) => shell(children: [
        Text('Choose a time · $_ymd', style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s2),
        OutlinedButton.icon(
          onPressed: busy
              ? null
              : () async {
                  final chosen = await showDatePicker(
                    context: context,
                    initialDate: day,
                    firstDate: DateTime.now(),
                    lastDate: DateTime.now().add(const Duration(days: 90)),
                  );
                  if (chosen != null && mounted) {
                    setState(() => day = chosen);
                    _loadSlots();
                  }
                },
          icon: Icon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold)),
          label: const Text('Change day'),
        ),
        const SizedBox(height: Msg.s2),
        if (loadingSlots)
          const Center(
              child: Padding(
                  padding: EdgeInsets.all(Msg.s3),
                  child: CircularProgressIndicator()))
        else if (slots.isEmpty)
          const _CheckoutInfo(
              text:
                  'No available times were returned by AvaCalendar for this day.')
        else
          Wrap(
            spacing: Msg.s2,
            runSpacing: Msg.s2,
            children: [
              for (final slot in slots)
                ChoiceChip(
                  label: Text(_slotLabel(slot)),
                  selected: identical(selected, slot),
                  onSelected:
                      busy ? null : (_) => setState(() => selected = slot),
                ),
            ],
          ),
        const SizedBox(height: Msg.s3),
        policyBlock(
          scheduleLine: selected == null
              ? 'Select an AvaCalendar time before confirming.'
              : 'Selected time: ${_slotLabel(selected!)} · ${listing.durationMin ?? 60} min.',
          cancellationLine:
              'Cancel up to ${listing.commercialCancellationWindowHours}h before start; rescheduling is ${listing.commercialRescheduleAllowed ? 'allowed' : 'not available'}.',
        ),
        const SizedBox(height: Msg.s3),
        if (balance != null)
          Text('Spendable wallet balance: $balance ${listing.currency}',
              style: ADText.preview()),
        if (walletUnavailable)
          const _CheckoutInfo(
              text:
                  'Wallet balance could not be verified. Checkout is paused until it is available.'),
        if (insufficientBalance) ...[
          const SizedBox(height: Msg.s2),
          const _CheckoutInfo(
              text:
                  'Your wallet balance is below the server listing price. Top up before confirming.'),
        ],
        consentBlock(),
        actionButton(),
      ]);
}

class _CheckoutInfo extends StatelessWidget {
  const _CheckoutInfo({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: ADText.preview(c: AD.textSecondary));
}
