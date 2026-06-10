import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/theme.dart';
import '../identity/identity_api.dart';
import '../identity/identity_gate.dart';
import 'payout_api.dart';

/// AvaPayout (Phase 3) — withdraw earned coins to a bank via Wise.
/// Flow: choose/add bank → (IdentityGate fires here if unverified) → amount →
/// confirm (Wise fee deducted from the amount) → history with statuses.
/// Server enforces the same gates API-side: KYC, tax fields, creator agreement.
const _kMinCoins = 1000; // $10 — keep in sync with worker routes/payout.ts

String _usd(num coins) => '\$${(coins / 100).toStringAsFixed(2)}';

class PayoutScreen extends StatefulWidget {
  const PayoutScreen({super.key});
  @override
  State<PayoutScreen> createState() => _PayoutScreenState();
}

class _PayoutScreenState extends State<PayoutScreen> {
  int _balance = 0, _held = 0;
  List<Map<String, dynamic>> _accounts = [];
  List<Map<String, dynamic>> _history = [];
  bool _loading = true, _enabled = true;

  @override
  void initState() {
    super.initState();
    Analytics.capture('payout_viewed');
    _refresh();
  }

  Future<void> _refresh() async {
    final results = await Future.wait([
      MoneyApi.balance(),
      PayoutApi.accounts(),
      PayoutApi.history(),
    ]);
    if (!mounted) return;
    final b = results[0] as Map<String, dynamic>;
    final h = results[2] as ({List<Map<String, dynamic>> requests, bool enabled});
    setState(() {
      if (b['balance'] is num) _balance = (b['balance'] as num).toInt();
      if (b['held'] is num) _held = (b['held'] as num).toInt();
      _accounts = results[1] as List<Map<String, dynamic>>;
      _history = h.requests;
      _enabled = h.enabled;
      _loading = false;
    });
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // ── add bank (KYC gate fires first) ───────────────────────────────────────
  Future<void> _addBank() async {
    final verified = await IdentityGate.ensureVerified(context, reason: 'add a bank account');
    if (!verified || !mounted) return;
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _AddBankSheet(),
    );
    if (added == true) _refresh();
  }

  // ── withdraw ───────────────────────────────────────────────────────────────
  Future<void> _withdraw(Map<String, dynamic> acct) async {
    final verified = await IdentityGate.ensureVerified(context, reason: 'withdraw your earnings');
    if (!verified || !mounted) return;

    final amount = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _AmountSheet(max: _balance, currency: (acct['currency'] ?? 'INR').toString()),
    );
    if (amount == null || !mounted) return;

    var r = await PayoutApi.request((acct['id'] ?? '').toString(), amount);

    // A1 — creator agreement required before first withdrawal: show + accept + retry.
    if (r['status_code'] == 403 && r['reason'] == 'agreement_required') {
      final accepted = await _acceptAgreement((r['current_version'] ?? '1').toString());
      if (!accepted || !mounted) return;
      r = await PayoutApi.request((acct['id'] ?? '').toString(), amount);
    }

    if (!mounted) return;
    if (r['ok'] == true) {
      Analytics.capture('payout_requested_ui', {'amount': amount});
      _snack('Withdrawal submitted — ${_usd(amount)} on its way to your bank.');
      _refresh();
    } else if (r['reason'] == 'tax_info_required') {
      _snack('Tax information is missing for this bank. Remove it and add it again with your tax details.');
    } else if (r['reason'] == 'pending_legal_approval') {
      _snack('Payouts aren\'t live yet — your balance is safe and waiting.');
    } else {
      _snack((r['error'] ?? 'Withdrawal failed').toString());
    }
  }

  Future<bool> _acceptAgreement(String version) async {
    final doc = await IdentityApi.agreementDoc();
    if (!mounted) return false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .8,
        builder: (_, ctrl) => Padding(
          padding: const EdgeInsets.all(20),
          child: Column(children: [
            Text('Creator agreement (v$version)',
                style: Theme.of(ctx).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            Expanded(
              child: SingleChildScrollView(
                controller: ctrl,
                child: Text(doc ??
                    'Please review the AvaTOK creator agreement at avatok.ai/legal/creator-agreement. '
                        'By accepting you confirm you have read and agree to it.'),
              ),
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Decline'))),
              const SizedBox(width: 12),
              Expanded(child: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('I agree'))),
            ]),
          ]),
        ),
      ),
    );
    if (ok != true) return false;
    final accepted = await IdentityApi.acceptAgreement(version);
    if (!accepted) _snack('Could not record acceptance — please try again.');
    return accepted;
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('AvaPayout')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Row(children: [
                    Expanded(child: _card('Wallet balance', _usd(_balance), Icons.account_balance_wallet, const Color(0xFF10B981))),
                    const SizedBox(width: 12),
                    Expanded(child: _card('Available to withdraw', _usd(_balance), Icons.payments, const Color(0xFF0A66C2),
                        footnote: _held > 0 ? '+ ${_usd(_held)} on 7-day hold' : null)),
                  ]),
                  if (!_enabled) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.amber.withValues(alpha: .12),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Text(
                        'Bank transfers are not live yet — you can link a bank and your balance keeps accruing.',
                        style: TextStyle(fontSize: 13),
                      ),
                    ),
                  ],
                  const SizedBox(height: 24),
                  Row(children: [
                    Expanded(child: Text('Bank accounts', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
                    TextButton.icon(onPressed: _addBank, icon: const Icon(Icons.add), label: const Text('Add bank')),
                  ]),
                  if (_accounts.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text('No bank linked yet. Add one to withdraw your earnings.',
                          style: TextStyle(color: cs.onSurfaceVariant)),
                    )
                  else
                    ..._accounts.map((a) => Card(
                          margin: const EdgeInsets.symmetric(vertical: 6),
                          child: ListTile(
                            leading: const Icon(Icons.account_balance),
                            title: Text((a['label'] ?? 'Bank ****${a['account_number_last4'] ?? ''}').toString()),
                            subtitle: Text('${a['currency'] ?? ''} · ${a['status'] ?? ''}'
                                '${a['tax_form_status'] == 'collected' ? '' : ' · tax info missing'}'),
                            trailing: FilledButton.tonal(
                              onPressed: _balance >= _kMinCoins ? () => _withdraw(a) : null,
                              child: const Text('Withdraw'),
                            ),
                          ),
                        )),
                  const SizedBox(height: 24),
                  Text('History', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  if (_history.isEmpty)
                    Text('No withdrawals yet.', style: TextStyle(color: cs.onSurfaceVariant))
                  else
                    ..._history.map(_historyTile),
                ],
              ),
      ),
    );
  }

  Widget _card(String label, String value, IconData icon, Color color, {String? footnote}) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: .25)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, color: color, size: 22),
        const SizedBox(height: 8),
        Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        Text(label, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
        if (footnote != null) Text(footnote, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
      ]),
    );
  }

  Widget _historyTile(Map<String, dynamic> r) {
    final status = (r['status'] ?? '').toString();
    final (icon, color) = switch (status) {
      'completed' => (Icons.check_circle, const Color(0xFF10B981)),
      'failed' || 'refunded' => (Icons.error, Colors.redAccent),
      _ => (Icons.hourglass_top, Colors.amber),
    };
    final when = DateTime.fromMillisecondsSinceEpoch(((r['created_at'] as num?) ?? 0).toInt());
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: color),
      title: Text('${_usd(((r['amount_coins'] as num?) ?? 0))} → ${r['target_currency'] ?? ''}'),
      subtitle: Text('${when.day}/${when.month}/${when.year} · $status'
          '${r['failure_reason'] != null ? ' — ${r['failure_reason']}' : ''}'),
    );
  }
}

// ── add-bank sheet: bank + A1 tax fields (after KYC, before 1st withdrawal) ──
class _AddBankSheet extends StatefulWidget {
  const _AddBankSheet();
  @override
  State<_AddBankSheet> createState() => _AddBankSheetState();
}

class _AddBankSheetState extends State<_AddBankSheet> {
  final _holder = TextEditingController();
  final _ifsc = TextEditingController();
  final _number = TextEditingController();
  final _label = TextEditingController();
  final _taxId = TextEditingController();
  String _taxIdType = 'pan';
  String _taxCountry = 'IN';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_holder, _ifsc, _number, _label, _taxId]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (_holder.text.trim().isEmpty || _ifsc.text.trim().isEmpty || _number.text.trim().isEmpty) {
      setState(() => _error = 'Account holder, IFSC and account number are required.');
      return;
    }
    if (_taxId.text.trim().isEmpty) {
      setState(() => _error = 'Tax ID is required before your first withdrawal.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await PayoutApi.setup(
      accountHolder: _holder.text.trim(),
      ifsc: _ifsc.text.trim().toUpperCase(),
      accountNumber: _number.text.trim(),
      label: _label.text.trim(),
      taxCountry: _taxCountry,
      taxIdType: _taxIdType,
      taxId: _taxId.text.trim(),
    );
    if (!mounted) return;
    if (r['ok'] == true) {
      Analytics.capture('payout_bank_added');
      Navigator.pop(context, true);
    } else {
      setState(() {
        _busy = false;
        _error = (r['reason'] == 'kyc_required'
                ? 'Identity verification is required first.'
                : (r['error'] ?? 'Could not save the bank account.'))
            .toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Add a bank account',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 14),
          TextField(controller: _holder, decoration: const InputDecoration(labelText: 'Account holder name')),
          const SizedBox(height: 10),
          TextField(controller: _ifsc, decoration: const InputDecoration(labelText: 'IFSC code')),
          const SizedBox(height: 10),
          TextField(
              controller: _number,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Account number')),
          const SizedBox(height: 10),
          TextField(controller: _label, decoration: const InputDecoration(labelText: 'Label (optional)')),
          const SizedBox(height: 18),
          Text('Tax details', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          Text('Needed once for year-end reporting. We store only the type and last 4 digits.',
              style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 12)),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _taxCountry,
                decoration: const InputDecoration(labelText: 'Tax residency'),
                items: const [
                  DropdownMenuItem(value: 'IN', child: Text('India')),
                  DropdownMenuItem(value: 'US', child: Text('United States')),
                  DropdownMenuItem(value: 'GB', child: Text('United Kingdom')),
                  DropdownMenuItem(value: 'EU', child: Text('EU (other)')),
                ],
                onChanged: (v) => setState(() {
                  _taxCountry = v ?? 'IN';
                  _taxIdType = switch (_taxCountry) { 'IN' => 'pan', 'US' => 'ssn', _ => 'tin' };
                }),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _taxIdType,
                decoration: const InputDecoration(labelText: 'ID type'),
                items: const [
                  DropdownMenuItem(value: 'pan', child: Text('PAN')),
                  DropdownMenuItem(value: 'ssn', child: Text('SSN')),
                  DropdownMenuItem(value: 'ein', child: Text('EIN')),
                  DropdownMenuItem(value: 'tin', child: Text('TIN')),
                  DropdownMenuItem(value: 'vat', child: Text('VAT')),
                ],
                onChanged: (v) => setState(() => _taxIdType = v ?? 'pan'),
              ),
            ),
          ]),
          const SizedBox(height: 10),
          TextField(controller: _taxId, decoration: const InputDecoration(labelText: 'Tax ID')),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 13)),
          ],
          const SizedBox(height: 18),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: _busy ? null : _save,
            child: _busy
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Save bank account'),
          ),
        ]),
      ),
    );
  }
}

// ── amount sheet: amount → quote preview (fee note) → confirm ────────────────
class _AmountSheet extends StatefulWidget {
  final int max;
  final String currency;
  const _AmountSheet({required this.max, required this.currency});
  @override
  State<_AmountSheet> createState() => _AmountSheetState();
}

class _AmountSheetState extends State<_AmountSheet> {
  final _ctrl = TextEditingController();
  int _amount = 0;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final valid = _amount >= _kMinCoins && _amount <= widget.max;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Withdraw to bank', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text('Available: ${_usd(widget.max)} · minimum ${_usd(_kMinCoins)}',
              style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13)),
          const SizedBox(height: 14),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Amount in coins (1 coin = \$0.01)'),
            onChanged: (v) => setState(() => _amount = int.tryParse(v.trim()) ?? 0),
          ),
          const SizedBox(height: 10),
          if (_amount > 0)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
              child: Text(
                'You\'ll receive ≈ ${_usd(_amount)} in ${widget.currency}. '
                'The Wise transfer fee is deducted from this amount; the exact '
                'rate is locked when the transfer is created.',
                style: const TextStyle(fontSize: 13, height: 1.35),
              ),
            ),
          const SizedBox(height: 16),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: valid ? () => Navigator.pop(context, _amount) : null,
            child: Text(valid ? 'Withdraw ${_usd(_amount)}' : 'Enter an amount'),
          ),
        ]),
      ),
    );
  }
}
