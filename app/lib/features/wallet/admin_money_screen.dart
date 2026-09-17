
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/money_api.dart';
// [UI-DS-SWEEP-1] Migrated off `core/ui/zine.dart` tokens onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/motion/motion.dart';

/// Money ops console (Phase 2, audit A2) — admin-only (`/admin/money`).
/// User lookup → live balance/holds/KYC/strikes + ledger table → refund /
/// adjust dialogs. The SERVER enforces the admin gate (ADMIN_UIDS) and audit-
/// logs every action; this screen is just a thin client over those routes.
class AdminMoneyScreen extends StatefulWidget {
  const AdminMoneyScreen({super.key});
  @override
  State<AdminMoneyScreen> createState() => _AdminMoneyScreenState();
}

class _AdminMoneyScreenState extends State<AdminMoneyScreen> {
  final _userCtrl = TextEditingController();
  Map<String, dynamic>? _account;
  List<Map<String, dynamic>> _ledger = const [];
  List<Map<String, dynamic>> _recon = const [];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    MoneyApi.adminRecon().then((r) {
      if (mounted) setState(() => _recon = ((r['runs'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList());
    }).catchError((_) {});
  }

  @override
  void dispose() { _userCtrl.dispose(); super.dispose(); }

  Future<void> _lookup() async {
    final uid = _userCtrl.text.trim();
    if (uid.isEmpty) return;
    setState(() => _busy = true);
    try {
      final acct = await MoneyApi.adminAccount(uid);
      final led = await MoneyApi.adminLedger(user: uid);
      if (!mounted) return;
      setState(() {
        _account = acct;
        _ledger = ((led['entries'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refundDialog() async {
    final order = TextEditingController(), amount = TextEditingController(), reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: Msg.brLg,
          side: const BorderSide(color: AD.borderCard, width: 1),
        ),
        title: UiText(UiMessage.m_manual_refund_e2dedff4a5, style: ADText.threadName()),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineField(controller: order, label: uiCopy(UiMessage.m_order_id_a23d884ae7)),
          const SizedBox(height: Msg.s3),
          ZineField(controller: amount, keyboardType: TextInputType.number, label: uiCopy(UiMessage.m_amount_coins_1819c8052e)),
          const SizedBox(height: Msg.s3),
          ZineField(controller: reason, label: uiCopy(UiMessage.m_reason_required_audited_aa7224ffba)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false),
              child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.preview(c: AD.textSecondary))),
          ZineButton(label: uiCopy(UiMessage.m_refund_6b37bd3508), fontSize: 15, onPressed: () => Navigator.pop(c, true)),
        ],
      ),
    );
    if (ok != true) return;
    final r = await MoneyApi.adminRefund(orderId: order.text.trim(), amount: int.tryParse(amount.text) ?? 0, reason: reason.text.trim());
    _snack(r['ok'] == true ? uiCopy(UiMessage.m_refunded_d8e8fd56ef) : uiCopy(UiMessage.m_failed_value1_af1e8f2668, {'value1': (r['error'] ?? r['status']).toString()}));
    _lookup();
  }

  Future<void> _adjustDialog() async {
    final amount = TextEditingController(), reason = TextEditingController();
    final uid = _userCtrl.text.trim();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: Msg.brLg,
          side: const BorderSide(color: AD.borderCard, width: 1),
        ),
        title: UiText(UiMessage.m_adjust_uid_bae86db2fb, params: {'uid': (uid).toString()}, style: ADText.threadName()),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineField(controller: amount, keyboardType: const TextInputType.numberWithOptions(signed: true), label: uiCopy(UiMessage.m_amount_coins_allowed_979d0b4119)),
          const SizedBox(height: Msg.s3),
          ZineField(controller: reason, label: uiCopy(UiMessage.m_reason_required_audited_aa7224ffba)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false),
              child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.preview(c: AD.textSecondary))),
          ZineButton(label: uiCopy(UiMessage.m_apply_31e392d1c0), fontSize: 15, onPressed: () => Navigator.pop(c, true)),
        ],
      ),
    );
    if (ok != true || uid.isEmpty) return;
    final r = await MoneyApi.adminAdjust(account: uid, amount: int.tryParse(amount.text) ?? 0, reason: reason.text.trim());
    _snack(r['ok'] == true ? uiCopy(UiMessage.m_adjusted_40ce0a5493) : uiCopy(UiMessage.m_failed_value1_af1e8f2668, {'value1': (r['error'] ?? r['status']).toString()}));
    _lookup();
  }

  void _snack(String m) { if (mounted) showAdToast(context, message: m); }

  // 1 Token = ₹1 (canonical, site-wide: matches wallet/top-up + UPI payout).
  String _inr(num c) => '\u20b9${c.abs().round()}';

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final a = _account;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar:  ZineAppBar(
        title: uiCopy(UiMessage.m_money_ops_42f2dcd6fc),
        markWord: 'ops',
        tag: 'admin console',
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6), children: [
        ZineField(
          controller: _userCtrl,
          label: uiCopy(UiMessage.m_user_id_clerk_uid_9b93522327),
          leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.regular),
          onSubmitted: (_) => _lookup(),
          trailing: GestureDetector(
            onTap: _lookup,
            child: PhosphorIcon(PhosphorIcons.arrowRight(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
          ),
        ),
        if (_busy)
          const Padding(padding: EdgeInsets.all(Msg.s4),
              child: Center(child: CircularProgressIndicator(color: AD.primaryBadge))),
        if (a != null) ...[
          const SizedBox(height: Msg.s4),
          // Metric cards — accent rotation.
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _stat('Balance', _inr((a['balance'] as num?) ?? 0),
                PhosphorIcons.wallet(PhosphorIconsStyle.regular), AD.online, money: true),
            const SizedBox(width: Msg.s3),
            _stat('Held', _inr((a['held'] as num?) ?? 0),
                PhosphorIcons.lock(PhosphorIconsStyle.regular), AD.newGroup),
          ]),
          const SizedBox(height: Msg.s3),
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _stat('KYC', '${a['kyc']}', PhosphorIcons.identificationCard(PhosphorIconsStyle.regular), AD.micIdleBg),
            const SizedBox(width: Msg.s3),
            _stat('Strikes', '${a['strikes']}', PhosphorIcons.warning(PhosphorIconsStyle.regular), AD.danger),
          ]),
          const SizedBox(height: Msg.s4),
          Row(children: [
            Expanded(
              child: ZineButton(
                label: uiCopy(UiMessage.m_refund_6b37bd3508),
                variant: ZineButtonVariant.ghost,
                fontSize: 16,
                onPressed: _refundDialog,
              ),
            ),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: ZineButton(
                label: uiCopy(UiMessage.m_adjust_fd8a7d7b3e),
                variant: ZineButtonVariant.blue,
                fontSize: 16,
                onPressed: _adjustDialog,
              ),
            ),
          ]),
          const SizedBox(height: Msg.s5),
          UiText(UiMessage.m_ledger_ee69eb4afc, style: ADText.sectionLabel()),
          const SizedBox(height: Msg.s2),
          for (final e in _ledger) _ledgerRow(e),
        ],
        const SizedBox(height: Msg.s5),
        UiText(UiMessage.m_reconciliation_runs_048656be44, style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s2),
        if (_recon.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Msg.s3),
            child: ZineEmptyState(
              icon: PhosphorIcons.scales(PhosphorIconsStyle.regular),
              text: 'No runs yet',
            ),
          ),
        for (final r in _recon) _reconRow(r),
      ]),
    );
  }

  /// Metric card: icon badge + Nunito number + caption.
  Widget _stat(String label, String value, IconData icon, Color accent, {bool money = false}) => Expanded(
        child: ZineCard(
          radius: Msg.rLg,
          padding: const EdgeInsets.all(Msg.s4),
          boxShadow: const [],
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 30),
            const SizedBox(height: Msg.s3),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(value,
                  style: ADText.appTitle(c: money ? AD.online : AD.textPrimary)
                      .copyWith(fontSize: 24)),
            ),
            const SizedBox(height: Msg.s1),
            Text(label, style: ADText.sectionLabel()),
          ]),
        ),
      );

  /// Ledger row: label + dotted leader + value.
  Widget _ledgerRow(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final positive = amount >= 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Flexible(
            child: Text('${e['type']}', maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.rowName().copyWith(fontSize: 14)),
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ADText.preview(c: AD.textTertiary).copyWith(fontSize: 13)),
          ),
          const SizedBox(width: Msg.s2),
          Text(_inr(amount),
              style: ADText.rowName(c: positive ? AD.online : AD.danger)
                  .copyWith(fontSize: 14, fontWeight: FontWeight.w700)),
        ]),
        const SizedBox(height: 2),
        UiText(
          UiMessage.m_value1_value2_ref_value3_value4_21562d893b, params: {'value1': (e['debit']).toString(), 'value2': (e['credit']).toString(), 'value3': (e['ref'] ?? '—').toString(), 'value4': (DateTime.fromMillisecondsSinceEpoch(((e['created_at'] as num?) ?? 0).toInt())).toString()},
          maxLines: 2,
          style: ADText.statCaption(),
        ),
      ]),
    );
  }

  Widget _reconRow(Map<String, dynamic> r) {
    final ok = r['ok'] == 1;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s1),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineSticker(ok ? 'ok' : 'diff', kind: ok ? ZineStickerKind.ok : ZineStickerKind.no),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${r['date']}', style: ADText.rowName().copyWith(fontSize: 14)),
            if (!ok)
              Text('${r['diff_json']}', maxLines: 3, overflow: TextOverflow.ellipsis,
                  style: ADText.statCaption(c: AD.danger)),
          ]),
        ),
      ]),
    );
  }
}
