import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avavision_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../wallet/wallet_screen.dart';
import 'widgets.dart';

/// Booking sheet — pick date, time, duration & language; itemized total;
/// pays into escrow from the AvaWallet. Returns true when booked.
Future<bool?> showBookingSheet(BuildContext context, VisionAgent agent) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r))),
    builder: (_) => _BookingSheet(agent: agent),
  );
}

class _BookingSheet extends StatefulWidget {
  final VisionAgent agent;
  const _BookingSheet({required this.agent});
  @override
  State<_BookingSheet> createState() => _BookingSheetState();
}

class _BookingSheetState extends State<_BookingSheet> {
  @override
  void initState() {
    super.initState();
    Analytics.capture('avavision_booking_sheet_opened', {'agent': widget.agent.id, 'payer_mode': widget.agent.payerMode});
  }

  DateTime _date = DateTime.now().add(const Duration(hours: 1));
  TimeOfDay _time = TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));
  late int _minutes = widget.agent.sessionLimitMin;
  String _language = 'en-US';
  bool _working = false;

  VisionAgent get a => widget.agent;

  List<int> get _durationChoices => kSessionLimitChoices.where((m) => m <= a.sessionLimitMin).toList();

  int get _totalCoins => a.isFreeForCallers ? 0 : perMinuteCoins(a.ratePerHourCoins) * _minutes;

  DateTime get _scheduled => DateTime(_date.year, _date.month, _date.day, _time.hour, _time.minute);

  Future<void> _pickDate() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 60)),
    );
    if (d != null) setState(() => _date = d);
  }

  Future<void> _pickTime() async {
    final t = await showTimePicker(context: context, initialTime: _time);
    if (t != null) setState(() => _time = t);
  }

  Future<void> _pickLang() async {
    final l = await pickLanguage(context, selected: _language);
    if (l != null) {
      Analytics.capture('avavision_language_selected', {'agent': a.id, 'language': l, 'where': 'booking'});
      setState(() => _language = l);
    }
  }

  Future<void> _confirm() async {
    if (_working) return;
    if (_scheduled.isBefore(DateTime.now())) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Please pick a time in the future.')));
      return;
    }
    setState(() => _working = true);
    Analytics.capture('avavision_booking_confirm_tapped',
        {'agent': a.id, 'minutes': _minutes, 'total_coins': _totalCoins, 'language': _language});
    final r = await AvaVisionApi.book(a.id,
        scheduledAt: _scheduled.millisecondsSinceEpoch, minutes: _minutes, language: _language);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavision_booking_result',
        {'agent': a.id, 'status': (r['status'] as num?)?.toInt() ?? 0, 'minutes': _minutes});
    switch (r['status']) {
      case 200:
        Navigator.pop(context, true);
      case 402:
        Analytics.capture('avavision_topup_prompted', {'agent': a.id, 'where': 'booking'});
        final needed = (r['needed'] as num?)?.toInt();
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Not enough AvaCoins${needed != null ? ' — you need ${fmtCoins(needed)}' : ''}.'),
          action: SnackBarAction(
              label: 'Top up',
              onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const WalletScreen()))),
        ));
      case 409:
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('That slot just filled up — pick another time.')));
      default:
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(r['detail']?.toString() ?? r['error']?.toString() ?? 'Booking failed.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final perMin = perMinuteCoins(a.ratePerHourCoins);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
          child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Book ${a.name}', style: ZineText.cardTitle(size: 21)),
                const SizedBox(height: 16),
                Row(children: [
                  Expanded(
                      child: _picker(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                          '${_date.day}/${_date.month}/${_date.year}', _pickDate)),
                  const SizedBox(width: 10),
                  Expanded(child: _picker(PhosphorIcons.clock(PhosphorIconsStyle.bold), _time.format(context), _pickTime)),
                ]),
                const SizedBox(height: 16),
                Text('SESSION LENGTH', style: ZineText.kicker()),
                const SizedBox(height: 9),
                Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: _durationChoices.map((m) {
                      return ZineChip(label: '$m min', active: m == _minutes, onTap: () => setState(() => _minutes = m));
                    }).toList()),
                const SizedBox(height: 16),
                _picker(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                    'Agent speaks: ${languageLabel(_language)}', _pickLang),
                const SizedBox(height: 18),
                ZineCard(
                  color: Zine.paper2,
                  radius: Zine.rSm,
                  boxShadow: Zine.shadowXs,
                  padding: const EdgeInsets.all(14),
                  child: Column(children: [
                    if (a.isFreeForCallers)
                      Row(children: [
                        PhosphorIcon(PhosphorIcons.confetti(PhosphorIconsStyle.bold), size: 18, color: Zine.mintInk),
                        const SizedBox(width: 8),
                        Expanded(
                            child: Text("Free — this agent's creator covers the session.",
                                style: ZineText.value(size: 13, weight: FontWeight.w800))),
                      ])
                    else ...[
                      _row('${a.name} · $_minutes min × ${fmtCoins(perMin)}/min', fmtCoins(_totalCoins)),
                      const SizedBox(height: 8),
                      const Divider(height: 1, color: Color(0x40231B14)),
                      const SizedBox(height: 8),
                      _row('Held in escrow now', fmtCoins(_totalCoins), bold: true),
                      const SizedBox(height: 6),
                      Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                              "You're only charged for minutes you actually train — unused minutes are refunded after the session.",
                              style: ZineText.sub(size: 11, color: Zine.inkMute))),
                    ],
                  ]),
                ),
                const SizedBox(height: 18),
                ZineButton(
                  label: a.isFreeForCallers ? 'Confirm booking' : 'Pay ${fmtCoins(_totalCoins)} & book',
                  fullWidth: true,
                  loading: _working,
                  icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
                  onPressed: _working ? null : _confirm,
                ),
              ]),
        ),
      ),
    );
  }

  Widget _picker(IconData icon, String label, VoidCallback onTap) => ZinePressable(
        onTap: onTap,
        radius: BorderRadius.circular(Zine.rField),
        boxShadow: Zine.shadowXs,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
        child: Row(children: [
          PhosphorIcon(icon, size: 17, color: Zine.blueInk),
          const SizedBox(width: 9),
          Expanded(
              child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 13, weight: FontWeight.w800))),
          PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
        ]),
      );

  Widget _row(String l, String r, {bool bold = false}) => Row(children: [
        Expanded(child: Text(l, style: ZineText.value(size: 12.5, weight: bold ? FontWeight.w900 : FontWeight.w700))),
        Text(r, style: ZineText.value(size: 13.5, color: bold ? Zine.mintInk : Zine.ink, weight: FontWeight.w900)),
      ]);
}
