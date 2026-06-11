import 'package:flutter/material.dart';

import '../../core/avavoice_api.dart';
import '../../core/theme.dart';
import '../wallet/wallet_screen.dart';
import 'widgets.dart';

/// Booking sheet — pick date, time, duration & language; itemized total;
/// pays into escrow from the AvaWallet. Returns true when booked.
Future<bool?> showBookingSheet(BuildContext context, VoiceAgent agent) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (_) => _BookingSheet(agent: agent),
  );
}

class _BookingSheet extends StatefulWidget {
  final VoiceAgent agent;
  const _BookingSheet({required this.agent});
  @override
  State<_BookingSheet> createState() => _BookingSheetState();
}

class _BookingSheetState extends State<_BookingSheet> {
  DateTime _date = DateTime.now().add(const Duration(hours: 1));
  TimeOfDay _time = TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));
  late int _minutes = widget.agent.sessionLimitMin;
  String _language = 'en-US';
  bool _working = false;

  VoiceAgent get a => widget.agent;

  List<int> get _durationChoices =>
      kSessionLimitChoices.where((m) => m <= a.sessionLimitMin).toList();

  int get _totalCoins =>
      a.isFreeForCallers ? 0 : perMinuteCoins(a.ratePerHourCoins) * _minutes;

  DateTime get _scheduled => DateTime(
      _date.year, _date.month, _date.day, _time.hour, _time.minute);

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
    if (l != null) setState(() => _language = l);
  }

  Future<void> _confirm() async {
    if (_working) return;
    if (_scheduled.isBefore(DateTime.now())) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Please pick a time in the future.')));
      return;
    }
    setState(() => _working = true);
    final r = await AvaVoiceApi.book(a.id,
        scheduledAt: _scheduled.millisecondsSinceEpoch,
        minutes: _minutes,
        language: _language);
    if (!mounted) return;
    setState(() => _working = false);
    switch (r['status']) {
      case 200:
        Navigator.pop(context, true);
      case 402:
        final needed = (r['needed'] as num?)?.toInt();
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Not enough AvaCoins'
              '${needed != null ? ' — you need ${fmtCoins(needed)}' : ''}.'),
          action: SnackBarAction(label: 'Top up', onPressed: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const WalletScreen()))),
        ));
      case 409:
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('That slot just filled up — pick another time.')));
      default:
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(
            r['detail']?.toString() ?? r['error']?.toString() ?? 'Booking failed.')));
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
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Book ${a.name}',
                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: _picker(Icons.calendar_today_outlined,
                  '${_date.day}/${_date.month}/${_date.year}', _pickDate)),
              const SizedBox(width: 10),
              Expanded(child: _picker(Icons.schedule, _time.format(context), _pickTime)),
            ]),
            const SizedBox(height: 14),
            const Text('Session length', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: _durationChoices.map((m) {
              final sel = m == _minutes;
              return ChoiceChip(
                label: Text('$m min'),
                selected: sel,
                selectedColor: kAvaVoicePurple.withValues(alpha: .15),
                labelStyle: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: sel ? kAvaVoicePurple : AvaColors.sub),
                onSelected: (_) => setState(() => _minutes = m),
              );
            }).toList()),
            const SizedBox(height: 14),
            _picker(Icons.translate, 'Agent speaks: ${languageLabel(_language)}', _pickLang),
            const SizedBox(height: 16),
            // Itemized total.
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                  color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
              child: Column(children: [
                if (a.isFreeForCallers)
                  const Row(children: [
                    Icon(Icons.celebration_outlined, size: 18, color: AvaColors.success),
                    SizedBox(width: 8),
                    Expanded(child: Text('Free — this agent\'s creator covers the call.',
                        style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13))),
                  ])
                else ...[
                  _row('${a.name} · $_minutes min × ${fmtCoins(perMin)}/min', fmtCoins(_totalCoins)),
                  const SizedBox(height: 6),
                  const Divider(height: 1),
                  const SizedBox(height: 6),
                  _row('Held in escrow now', fmtCoins(_totalCoins), bold: true),
                  const SizedBox(height: 4),
                  const Align(alignment: Alignment.centerLeft, child: Text(
                      'You\'re only charged for minutes you actually talk — unused minutes are refunded after the call.',
                      style: TextStyle(fontSize: 11, color: AvaColors.sub))),
                ],
              ]),
            ),
            const SizedBox(height: 16),
            SizedBox(width: double.infinity, child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: kAvaVoicePurple),
              onPressed: _working ? null : _confirm,
              child: _working
                  ? const SizedBox(width: 18, height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : Text(a.isFreeForCallers
                      ? 'Confirm booking'
                      : 'Pay ${fmtCoins(_totalCoins)} & book',
                      style: const TextStyle(fontWeight: FontWeight.w800)),
            )),
          ]),
        ),
      ),
    );
  }

  Widget _picker(IconData icon, String label, VoidCallback onTap) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          decoration: BoxDecoration(
              border: Border.all(color: AvaColors.line),
              borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            Icon(icon, size: 17, color: kAvaVoicePurple),
            const SizedBox(width: 8),
            Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13))),
            const Icon(Icons.expand_more, size: 18, color: AvaColors.sub),
          ]),
        ),
      );

  Widget _row(String l, String r, {bool bold = false}) => Row(children: [
        Expanded(child: Text(l, style: TextStyle(
            fontSize: 12.5, fontWeight: bold ? FontWeight.w800 : FontWeight.w600))),
        Text(r, style: TextStyle(
            fontSize: 13, fontWeight: bold ? FontWeight.w800 : FontWeight.w700)),
      ]);
}
