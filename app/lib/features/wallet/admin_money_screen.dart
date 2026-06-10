import 'package:flutter/material.dart';

import '../../core/money_api.dart';
import '../../core/theme.dart';

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
        title: const Text('Manual refund'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: order, decoration: const InputDecoration(labelText: 'Order id')),
          TextField(controller: amount, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Amount (coins)')),
          TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason (required, audited)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Refund')),
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
        title: Text('Adjust $uid'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: amount, keyboardType: const TextInputType.numberWithOptions(signed: true), decoration: const InputDecoration(labelText: 'Amount (coins, ± allowed)')),
          TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason (required, audited)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Apply')),
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
      appBar: AppBar(title: const Text('Money ops console')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(
          controller: _userCtrl,
          decoration: InputDecoration(
            labelText: 'User id (Clerk uid)',
            suffixIcon: IconButton(icon: const Icon(Icons.search), onPressed: _lookup),
          ),
          onSubmitted: (_) => _lookup(),
        ),
        if (_busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
        if (a != null) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Balance ${_usd((a['balance'] as num?) ?? 0)} · held ${_usd((a['held'] as num?) ?? 0)}',
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              Text('KYC: ${a['kyc']} · strikes: ${a['strikes']}', style: const TextStyle(color: AvaColors.sub)),
              const SizedBox(height: 10),
              Row(children: [
                OutlinedButton(onPressed: _refundDialog, child: const Text('Refund')),
                const SizedBox(width: 8),
                OutlinedButton(onPressed: _adjustDialog, child: const Text('Adjust')),
              ]),
            ]),
          ),
          const SizedBox(height: 12),
          const Text('Ledger', style: TextStyle(fontWeight: FontWeight.w800)),
          for (final e in _ledger)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${e['type']}  ${_usd((e['amount'] as num?) ?? 0)}', style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text('${e['debit']} → ${e['credit']}\nref ${e['ref'] ?? '—'} · ${DateTime.fromMillisecondsSinceEpoch(((e['created_at'] as num?) ?? 0).toInt())}',
                  style: const TextStyle(fontSize: 11, color: AvaColors.sub)),
            ),
        ],
        const SizedBox(height: 16),
        const Text('Reconciliation runs', style: TextStyle(fontWeight: FontWeight.w800)),
        if (_recon.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('No runs yet', style: TextStyle(color: AvaColors.sub))),
        for (final r in _recon)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(r['ok'] == 1 ? Icons.check_circle : Icons.error, color: r['ok'] == 1 ? AvaColors.success : AvaColors.danger, size: 20),
            title: Text('${r['date']}'),
            subtitle: r['ok'] == 1 ? null : Text('${r['diff_json']}', maxLines: 3, style: const TextStyle(fontSize: 11)),
          ),
      ]),
    );
  }
}
