import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .8,
        builder: (_, ctrl) => Padding(
          padding: const EdgeInsets.all(20),
          child: Column(children: [
            Text('Creator agreement (v$version)', style: ZineText.cardTitle(size: 20)),
            const SizedBox(height: 12),
            Expanded(
              child: SingleChildScrollView(
                controller: ctrl,
                child: Text(
                    doc ??
                        'Please review the AvaTOK creator agreement at avatok.ai/legal/creator-agreement. '
                            'By accepting you confirm you have read and agree to it.',
                    style: ZineText.sub(size: 14, color: Zine.ink)),
              ),
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: ZineButton(
                  label: 'Decline',
                  variant: ZineButtonVariant.ghost,
                  fontSize: 17,
                  onPressed: () => Navigator.pop(ctx, false),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ZineButton(
                  label: 'I agree',
                  fontSize: 17,
                  onPressed: () => Navigator.pop(ctx, true),
                ),
              ),
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
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'AvaPayout',
        markWord: 'Payout',
        tag: 'straight to your bank',
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        color: Zine.blueInk,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
            : ListView(
                padding: const EdgeInsets.fromLTRB(18, 16, 18, 32),
                children: [
                  Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Expanded(child: _card('Wallet balance', _usd(_balance),
                        PhosphorIcons.wallet(PhosphorIconsStyle.bold), Zine.mint)),
                    const SizedBox(width: 12),
                    Expanded(child: _card('Available to withdraw', _usd(_balance),
                        PhosphorIcons.bank(PhosphorIconsStyle.bold), Zine.blue,
                        footnote: _held > 0 ? '+ ${_usd(_held)} on 7-day hold' : null)),
                  ]),
                  if (!_enabled) ...[
                    const SizedBox(height: 14),
                    ZineCard(
                      color: Zine.paper2,
                      radius: Zine.rSm,
                      boxShadow: Zine.shadowXs,
                      padding: const EdgeInsets.all(14),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const ZineSticker('coming soon', kind: ZineStickerKind.hint),
                        const SizedBox(height: 8),
                        Text(
                          'Bank transfers are not live yet — you can link a bank and your balance keeps accruing.',
                          style: ZineText.sub(size: 13.5),
                        ),
                      ]),
                    ),
                  ],
                  const SizedBox(height: 26),
                  Row(children: [
                    Expanded(child: Text('BANK ACCOUNTS', style: ZineText.kicker(size: 11.5))),
                    ZineLink('+ ADD BANK', onTap: _addBank),
                  ]),
                  const SizedBox(height: 10),
                  if (_accounts.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: ZineEmptyState(
                        icon: PhosphorIcons.bank(PhosphorIconsStyle.bold),
                        text: 'No bank linked yet. Add one to withdraw your earnings.',
                      ),
                    )
                  else
                    ..._accounts.map(_accountCard),
                  const SizedBox(height: 26),
                  Text('HISTORY', style: ZineText.kicker(size: 11.5)),
                  const SizedBox(height: 10),
                  if (_history.isEmpty)
                    Text('No withdrawals yet.', style: ZineText.sub(size: 13.5))
                  else
                    ..._history.map(_historyRow),
                ],
              ),
      ),
    );
  }

  /// Metric card (§7.11): icon badge + Nunito number + mono caption.
  Widget _card(String label, String value, IconData icon, Color accent, {String? footnote}) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(icon: icon, color: accent, size: 30),
        const SizedBox(height: 10),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, style: ZineText.stat(size: 26, color: Zine.mintInk)),
        ),
        const SizedBox(height: 3),
        Text(label.toUpperCase(), style: ZineText.kicker(size: 9.5)),
        if (footnote != null) ...[
          const SizedBox(height: 2),
          Text(footnote.toUpperCase(), style: ZineText.kicker(size: 9, color: Zine.inkMute)),
        ],
      ]),
    );
  }

  Widget _accountCard(Map<String, dynamic> a) {
    final status = (a['status'] ?? '').toString();
    final taxMissing = a['tax_form_status'] != 'collected';
    final statusKind = switch (status) {
      'verified' || 'active' => ZineStickerKind.ok,
      'blocked' || 'failed' => ZineStickerKind.no,
      _ => ZineStickerKind.hint,
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.bank(PhosphorIconsStyle.bold), color: Zine.mint),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text((a['label'] ?? 'Bank ****${a['account_number_last4'] ?? ''}').toString(),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 14.5)),
              const SizedBox(height: 5),
              Wrap(spacing: 6, runSpacing: 4, children: [
                ZineSticker('${a['currency'] ?? ''} · $status', kind: statusKind),
                if (taxMissing) const ZineSticker('tax info missing', kind: ZineStickerKind.no),
              ]),
            ]),
          ),
          const SizedBox(width: 10),
          ZineButton(
            label: 'Withdraw',
            fontSize: 15,
            onPressed: _balance >= _kMinCoins ? () => _withdraw(a) : null,
          ),
        ]),
      ),
    );
  }

  /// Payout history — ledger row (§7.10): label + dotted leader + value.
  Widget _historyRow(Map<String, dynamic> r) {
    final status = (r['status'] ?? '').toString();
    final color = switch (status) {
      'completed' => Zine.mintInk,
      'failed' || 'refunded' => Zine.coral,
      _ => Zine.inkSoft,
    };
    final when = DateTime.fromMillisecondsSinceEpoch(((r['created_at'] as num?) ?? 0).toInt());
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Flexible(
            child: Text('${_usd(((r['amount_coins'] as num?) ?? 0))} → ${r['target_currency'] ?? ''}',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.value(size: 14, weight: FontWeight.w800)),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ZineText.sub(size: 13, color: Zine.inkMute)),
          ),
          const SizedBox(width: 6),
          Text(status.toUpperCase(), style: ZineText.tag(size: 11, color: color)),
        ]),
        const SizedBox(height: 2),
        Text(
          '${when.day}/${when.month}/${when.year}'
                  '${r['failure_reason'] != null ? ' — ${r['failure_reason']}' : ''}'
              .toUpperCase(),
          style: ZineText.kicker(size: 9.5, color: Zine.inkMute),
        ),
      ]),
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
          Text('Add a bank account', style: ZineText.cardTitle(size: 21)),
          const SizedBox(height: 16),
          ZineField(controller: _holder, label: 'Account holder name'),
          const SizedBox(height: 12),
          ZineField(controller: _ifsc, label: 'IFSC code', textCapitalization: TextCapitalization.characters),
          const SizedBox(height: 12),
          ZineField(controller: _number, label: 'Account number', keyboardType: TextInputType.number),
          const SizedBox(height: 12),
          ZineField(controller: _label, label: 'Label (optional)'),
          const SizedBox(height: 20),
          Text('Tax details', style: ZineText.cardTitle(size: 16)),
          const SizedBox(height: 4),
          Text('Needed once for year-end reporting. We store only the type and last 4 digits.',
              style: ZineText.sub(size: 12.5)),
          const SizedBox(height: 12),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: ZineDropdown<String>(
                label: 'Tax residency',
                value: _taxCountry,
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
              child: ZineDropdown<String>(
                label: 'ID type',
                value: _taxIdType,
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
          const SizedBox(height: 12),
          ZineField(controller: _taxId, label: 'Tax ID', error: _error != null),
          if (_error != null) ZineErrorMsg(_error!),
          const SizedBox(height: 20),
          ZineButton(
            label: 'Save bank account',
            fullWidth: true,
            loading: _busy,
            onPressed: _busy ? null : _save,
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
    final valid = _amount >= _kMinCoins && _amount <= widget.max;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Withdraw to bank', style: ZineText.cardTitle(size: 21)),
          const SizedBox(height: 4),
          Text('Available: ${_usd(widget.max)} · minimum ${_usd(_kMinCoins)}',
              style: ZineText.sub(size: 13.5)),
          const SizedBox(height: 16),
          ZineField(
            controller: _ctrl,
            autofocus: true,
            label: 'Amount in coins (1 coin = \$0.01)',
            leadIcon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
            keyboardType: TextInputType.number,
            onChanged: (v) => setState(() => _amount = int.tryParse(v.trim()) ?? 0),
          ),
          const SizedBox(height: 12),
          if (_amount > 0)
            ZineCard(
              color: Zine.paper2,
              radius: Zine.rSm,
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.all(13),
              child: Text(
                'You\'ll receive ≈ ${_usd(_amount)} in ${widget.currency}. '
                'The Wise transfer fee is deducted from this amount; the exact '
                'rate is locked when the transfer is created.',
                style: ZineText.sub(size: 13, color: Zine.mintInk),
              ),
            ),
          const SizedBox(height: 18),
          ZineButton(
            label: valid ? 'Withdraw ${_usd(_amount)}' : 'Enter an amount',
            fullWidth: true,
            onPressed: valid ? () => Navigator.pop(context, _amount) : null,
          ),
        ]),
      ),
    );
  }
}
