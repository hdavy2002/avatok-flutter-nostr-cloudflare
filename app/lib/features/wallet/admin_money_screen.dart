import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/money_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

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
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Manual refund', style: ZineText.cardTitle()),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineField(controller: order, label: 'Order id'),
          const SizedBox(height: 12),
          ZineField(controller: amount, keyboardType: TextInputType.number, label: 'Amount (coins)'),
          const SizedBox(height: 12),
          ZineField(controller: reason, label: 'Reason (required, audited)'),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false),
              child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Refund', fontSize: 15, onPressed: () => Navigator.pop(c, true)),
        ],
      ),
    );
    if (ok != true) return;
    final r = await MoneyApi.adminRefund(orderId: order.text.trim(), amount: int.tryParse(amount.text) ?? 0, reason: reason.text.trim());
    _snack(r['ok'] == true ? 'Refunded.' : 'Failed: ${r['error'] ?? r['status']}');
    _lookup();
  }

  Future<void> _adjustDialog() async {
    final amount = TextEditingController(), reason = TextEditingController();
    final uid = _userCtrl.text.trim();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Adjust $uid', style: ZineText.cardTitle()),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineField(controller: amount, keyboardType: const TextInputType.numberWithOptions(signed: true), label: 'Amount (coins, ± allowed)'),
          const SizedBox(height: 12),
          ZineField(controller: reason, label: 'Reason (required, audited)'),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false),
              child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Apply', fontSize: 15, onPressed: () => Navigator.pop(c, true)),
        ],
      ),
    );
    if (ok != true || uid.isEmpty) return;
    final r = await MoneyApi.adminAdjust(account: uid, amount: int.tryParse(amount.text) ?? 0, reason: reason.text.trim());
    _snack(r['ok'] == true ? 'Adjusted.' : 'Failed: ${r['error'] ?? r['status']}');
    _lookup();
  }

  void _snack(String m) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m))); }

  String _usd(num c) => '\$${(c.abs() / 100).toStringAsFixed(2)}';

  @override
  Widget build(BuildContext context) {
    final a = _account;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'Money ops',
        markWord: 'ops',
        tag: 'admin console',
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(18, 16, 18, 32), children: [
        ZineField(
          controller: _userCtrl,
          label: 'User id (Clerk uid)',
          leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
          onSubmitted: (_) => _lookup(),
          trailing: GestureDetector(
            onTap: _lookup,
            child: PhosphorIcon(PhosphorIcons.arrowRight(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
          ),
        ),
        if (_busy)
          const Padding(padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator(color: Zine.blueInk))),
        if (a != null) ...[
          const SizedBox(height: 18),
          // Metric cards (§7.11) — accent rotation.
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _stat('Balance', _usd((a['balance'] as num?) ?? 0),
                PhosphorIcons.wallet(PhosphorIconsStyle.bold), Zine.mint, money: true),
            const SizedBox(width: 12),
            _stat('Held', _usd((a['held'] as num?) ?? 0),
                PhosphorIcons.lock(PhosphorIconsStyle.bold), Zine.blue),
          ]),
          const SizedBox(height: 12),
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _stat('KYC', '${a['kyc']}', PhosphorIcons.identificationCard(PhosphorIconsStyle.bold), Zine.lilac),
            const SizedBox(width: 12),
            _stat('Strikes', '${a['strikes']}', PhosphorIcons.warning(PhosphorIconsStyle.bold), Zine.coral),
          ]),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: ZineButton(
                label: 'Refund',
                variant: ZineButtonVariant.ghost,
                fontSize: 16,
                onPressed: _refundDialog,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ZineButton(
                label: 'Adjust',
                variant: ZineButtonVariant.blue,
                fontSize: 16,
                onPressed: _adjustDialog,
              ),
            ),
          ]),
          const SizedBox(height: 22),
          Text('LEDGER', style: ZineText.kicker(size: 11.5)),
          const SizedBox(height: 8),
          for (final e in _ledger) _ledgerRow(e),
        ],
        const SizedBox(height: 22),
        Text('RECONCILIATION RUNS', style: ZineText.kicker(size: 11.5)),
        const SizedBox(height: 8),
        if (_recon.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: ZineEmptyState(
              icon: PhosphorIcons.scales(PhosphorIconsStyle.bold),
              text: 'No runs yet',
            ),
          ),
        for (final r in _recon) _reconRow(r),
      ]),
    );
  }

  /// Metric card (§7.11): icon badge + Nunito number + mono caption.
  Widget _stat(String label, String value, IconData icon, Color accent, {bool money = false}) => Expanded(
        child: ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(14),
          boxShadow: Zine.shadowXs,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 30),
            const SizedBox(height: 10),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(value, style: ZineText.stat(size: 24, color: money ? Zine.mintInk : Zine.ink)),
            ),
            const SizedBox(height: 3),
            Text(label.toUpperCase(), style: ZineText.kicker(size: 9.5)),
          ]),
        ),
      );

  /// Ledger row (§7.10): label + dotted leader + Nunito 900 value.
  Widget _ledgerRow(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final positive = amount >= 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Flexible(
            child: Text('${e['type']}', maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.value(size: 14, weight: FontWeight.w800)),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ZineText.sub(size: 13, color: Zine.inkMute)),
          ),
          const SizedBox(width: 6),
          Text(_usd(amount),
              style: ZineText.value(size: 14, weight: FontWeight.w900,
                  color: positive ? Zine.mintInk : Zine.coral)),
        ]),
        const SizedBox(height: 2),
        Text(
          '${e['debit']} → ${e['credit']} · ref ${e['ref'] ?? '—'} · '
          '${DateTime.fromMillisecondsSinceEpoch(((e['created_at'] as num?) ?? 0).toInt())}',
          maxLines: 2,
          style: ZineText.kicker(size: 9, color: Zine.inkMute),
        ),
      ]),
    );
  }

  Widget _reconRow(Map<String, dynamic> r) {
    final ok = r['ok'] == 1;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineSticker(ok ? 'ok' : 'diff', kind: ok ? ZineStickerKind.ok : ZineStickerKind.no),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${r['date']}', style: ZineText.value(size: 13.5, weight: FontWeight.w800)),
            if (!ok)
              Text('${r['diff_json']}', maxLines: 3, overflow: TextOverflow.ellipsis,
                  style: ZineText.kicker(size: 9, color: Zine.coral)),
          ]),
        ),
      ]),
    );
  }
}
