
import '../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/analytics.dart';
import '../../core/avavoice_api.dart';
import '../../core/ui/zine_widgets.dart';
import '../wallet/wallet_screen.dart';
import 'widgets.dart';

/// Booking sheet — pick date, time, duration & language; itemized total;
/// pays into escrow from the AvaWallet. Returns true when booked.
Future<bool?> showBookingSheet(BuildContext context, VoiceAgent agent) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
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
  @override
  void initState() {
    super.initState();
    Analytics.capture('avavoice_booking_sheet_opened',
        {'agent': widget.agent.id, 'payer_mode': widget.agent.payerMode});
  }

  DateTime _date = DateTime.now().add(const Duration(hours: 1));
  TimeOfDay _time = TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));
  late int _minutes = widget.agent.sessionLimitMin;
  String _language = 'en-US';
  bool _working = false;

  VoiceAgent get a => widget.agent;

  List<int> get _durationChoices =>
      kSessionLimitChoices.where((m) => m <= a.sessionLimitMin).toList();

  int get _totalTokens =>
      a.isFreeForCallers ? 0 : perMinuteTokens(a.ratePerHourTokens) * _minutes;

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
    if (l != null) {
      Analytics.capture('avavoice_language_selected',
          {'agent': a.id, 'language': l, 'where': 'booking'});
      setState(() => _language = l);
    }
  }

  Future<void> _confirm() async {
    if (_working) return;
    if (_scheduled.isBefore(DateTime.now())) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: UiText(UiMessage.m_please_pick_a_time_in_08a6bc9a06)));
      return;
    }
    setState(() => _working = true);
    Analytics.capture('avavoice_booking_confirm_tapped',
        {'agent': a.id, 'minutes': _minutes, 'total_coins': _totalTokens, 'language': _language});
    final r = await AvaVoiceApi.book(a.id,
        scheduledAt: _scheduled.millisecondsSinceEpoch,
        minutes: _minutes,
        language: _language);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavoice_booking_result',
        {'agent': a.id, 'status': (r['status'] as num?)?.toInt() ?? 0, 'minutes': _minutes});
    switch (r['status']) {
      case 200:
        Navigator.pop(context, true);
      case 402:
        Analytics.capture('avavoice_topup_prompted', {'agent': a.id, 'where': 'booking'});
        final needed = (r['needed'] as num?)?.toInt();
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: UiText(UiMessage.m_not_enough_tokens_value1_0520a4334d, params: {'value1': (needed != null ? ' — you need ${fmtTokens(needed)}' : '').toString()}),
          action: SnackBarAction(label: uiCopy(UiMessage.m_top_up_79f52e0ce6), onPressed: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const WalletScreen()))),
        ));
      case 409:
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: UiText(UiMessage.m_that_slot_just_filled_up_efabd8c0be)));
      default:
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(
            r['detail']?.toString() ?? r['error']?.toString() ?? uiCopy(UiMessage.m_booking_failed_c7f3752691))));
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final perMin = perMinuteTokens(a.ratePerHourTokens);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s5),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_book_value1_3d944bfd70, params: {'value1': (a.name).toString()}, style: ADText.threadName().copyWith(fontSize: 21, height: 1.1, letterSpacing: -0.2)),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: _picker(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                  '${_date.day}/${_date.month}/${_date.year}', _pickDate)),
              const SizedBox(width: Msg.s2),
              Expanded(child: _picker(PhosphorIcons.clock(PhosphorIconsStyle.bold), _time.format(context), _pickTime)),
            ]),
            const SizedBox(height: 16),
            UiText(UiMessage.m_session_length_c0c996d902, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
            const SizedBox(height: Msg.s2),
            Wrap(spacing: 8, runSpacing: 8, children: _durationChoices.map((m) {
              return ZineChip(
                label: '$m min',
                active: m == _minutes,
                onTap: () => setState(() => _minutes = m),
              );
            }).toList()),
            const SizedBox(height: 16),
            _picker(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                'Agent speaks: ${languageLabel(_language)}', _pickLang),
            const SizedBox(height: Msg.s4),
            // Itemized total.
            ZineCard(
              color: AD.card,
              radius: Msg.rLg,
              boxShadow: Msg.none,
              padding: const EdgeInsets.all(Msg.s4),
              child: Column(children: [
                if (a.isFreeForCallers)
                  Row(children: [
                    PhosphorIcon(PhosphorIcons.confetti(PhosphorIconsStyle.bold), size: 18, color: AD.online),
                    const SizedBox(width: 8),
                    Expanded(child: UiText(UiMessage.m_free_this_agent_s_creator_7d03c45342,
                        style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w600))),
                  ])
                else ...[
                  _row('${a.name} · $_minutes min × ${fmtTokens(perMin)}/min', fmtTokens(_totalTokens)),
                  const SizedBox(height: 8),
                  const Divider(height: 1, color: AD.borderHairline),
                  const SizedBox(height: 8),
                  _row('Held in escrow now', fmtTokens(_totalTokens), bold: true),
                  const SizedBox(height: Msg.s1),
                  Align(alignment: Alignment.centerLeft, child: UiText(
                      UiMessage.m_you_re_only_charged_for_6b74bb2250,
                      style: ADText.preview(c: AD.textTertiary).copyWith(fontSize: 11, height: 1.42))),
                ],
              ]),
            ),
            const SizedBox(height: Msg.s4),
            ZineButton(
              label: a.isFreeForCallers ? uiCopy(UiMessage.m_confirm_booking_fa1e17d8f8) : uiCopy(UiMessage.m_pay_value1_book_ddc5593a00, {'value1': (fmtTokens(_totalTokens)).toString()}),
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
        radius: BorderRadius.circular(Msg.rLg),
        boxShadow: Msg.none,
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s4),
        child: Row(children: [
          PhosphorIcon(icon, size: 17, color: AD.tabGroups),
          const SizedBox(width: Msg.s2),
          Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w600))),
          PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
        ]),
      );

  Widget _row(String l, String r, {bool bold = false}) => Row(children: [
        Expanded(child: Text(l, style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: bold ? FontWeight.w700 : FontWeight.w400))),
        Text(r, style: ADText.rowName(c: bold ? AD.online : AD.textPrimary).copyWith(fontSize: 14, height: 1.3, fontWeight: FontWeight.w700)),
      ]);
}
