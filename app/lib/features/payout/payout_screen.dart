
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/motion/motion.dart';
import '../identity/identity_api.dart';
import '../identity/identity_gate.dart';
import 'payout_api.dart';

/// AvaPayout (Phase 3) — withdraw earned coins to a bank via Wise.
/// Flow: choose/add bank → (IdentityGate fires here if unverified) → amount →
/// confirm (Wise fee deducted from the amount) → history with statuses.
/// Server enforces the same gates API-side: KYC, tax fields, creator agreement.
const _kMinTokens = 1000; // ₹1,000 — keep in sync with worker routes/payout.ts

String _inr(num tokens) => '\u20b9${tokens.round()}';

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
    showAdToast(context, message: msg);
  }

  // ── add bank (KYC gate fires first) ───────────────────────────────────────
  Future<void> _addBank() async {
    final verified = await IdentityGate.ensureVerified(context, reason: 'add a bank account');
    if (!verified || !mounted) return;
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.bg,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
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
      backgroundColor: AD.bg,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
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
      _snack(uiCopy(UiMessage.m_withdrawal_submitted_value1_on_its_efa3eb38cf, {'value1': (_inr(amount)).toString()}));
      _refresh();
    } else if (r['reason'] == 'tax_info_required') {
      _snack(uiCopy(UiMessage.m_tax_information_is_missing_for_4ec0733aea));
    } else if (r['reason'] == 'pending_legal_approval') {
      _snack(uiCopy(UiMessage.m_payouts_aren_t_live_yet_6a5cf96c64));
    } else {
      _snack((r['error'] ?? uiCopy(UiMessage.m_withdrawal_failed_de6410e9d1)).toString());
    }
  }

  Future<bool> _acceptAgreement(String version) async {
    final doc = await IdentityApi.agreementDoc();
    if (!mounted) return false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.bg,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .8,
        builder: (_, ctrl) => Padding(
          padding: const EdgeInsets.all(Msg.s5),
          child: Column(children: [
            UiText(UiMessage.m_creator_agreement_v_version_b9afc72def, params: {'version': (version).toString()}, style: ADText.appTitle()),
            const SizedBox(height: Msg.s3),
            Expanded(
              child: SingleChildScrollView(
                controller: ctrl,
                child: Text(
                    doc ??
                        uiCopy(UiMessage.m_please_review_the_avatok_creator_26fbf553e8),
                    style: ADText.preview(c: AD.textPrimary)),
              ),
            ),
            const SizedBox(height: Msg.s3),
            Row(children: [
              Expanded(
                child: ZineButton(
                  label: uiCopy(UiMessage.m_decline_a2d285b352),
                  variant: ZineButtonVariant.ghost,
                  fontSize: 17,
                  onPressed: () => Navigator.pop(ctx, false),
                ),
              ),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: ZineButton(
                  label: uiCopy(UiMessage.m_i_agree_99955b75e0),
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
    if (!accepted) _snack(uiCopy(UiMessage.m_could_not_record_acceptance_please_809c670d68));
    return accepted;
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar:  ZineAppBar(
        title: uiCopy(UiMessage.m_avapayout_4b5ee9ea3c),
        markWord: 'Payout',
        tag: 'straight to your bank',
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        color: AD.primaryBadge,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
            : ListView(
                padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
                children: [
                  Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Expanded(child: _card('Wallet balance', _inr(_balance),
                        PhosphorIcons.wallet(PhosphorIconsStyle.bold), AD.online)),
                    const SizedBox(width: Msg.s3),
                    Expanded(child: _card('Available to withdraw', _inr(_balance),
                        PhosphorIcons.bank(PhosphorIconsStyle.bold), AD.newGroup,
                        footnote: _held > 0 ? '+ ${_inr(_held)} on 7-day hold' : null)),
                  ]),
                  if (!_enabled) ...[
                    const SizedBox(height: Msg.s4),
                    ZineCard(
                      color: AD.card,
                      radius: Msg.rLg,
                      boxShadow: const <BoxShadow>[],
                      padding: const EdgeInsets.all(Msg.s4),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const ZineSticker('coming soon', kind: ZineStickerKind.hint),
                        const SizedBox(height: Msg.s2),
                        UiText(
                          UiMessage.m_bank_transfers_are_not_live_a03635d474,
                          style: ADText.preview(),
                        ),
                      ]),
                    ),
                  ],
                  const SizedBox(height: Msg.s5),
                  Row(children: [
                    Expanded(child: UiText(UiMessage.m_bank_accounts_65e0d05950, style: ADText.sectionLabel())),
                    ZineLink('+ Add bank', onTap: _addBank),
                  ]),
                  const SizedBox(height: Msg.s3),
                  if (_accounts.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: Msg.s4),
                      child: ZineEmptyState(
                        icon: PhosphorIcons.bank(PhosphorIconsStyle.bold),
                        text: 'No bank linked yet. Add one to withdraw your earnings.',
                      ),
                    )
                  else
                    ..._accounts.map(_accountCard),
                  const SizedBox(height: Msg.s5),
                  UiText(UiMessage.m_history_0e76960093, style: ADText.sectionLabel()),
                  const SizedBox(height: Msg.s3),
                  if (_history.isEmpty)
                    UiText(UiMessage.m_no_withdrawals_yet_5abaf9af8a, style: ADText.preview())
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
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      boxShadow: const <BoxShadow>[],
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(icon: icon, color: accent, size: 30),
        const SizedBox(height: Msg.s3),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, style: ADText.appTitle(c: AD.online).copyWith(fontSize: 26)),
        ),
        const SizedBox(height: Msg.s1),
        Text(label, style: ADText.sectionLabel()),
        if (footnote != null) ...[
          const SizedBox(height: 2),
          Text(footnote, style: ADText.sectionLabel(c: AD.textTertiary)),
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
      padding: const EdgeInsets.only(bottom: Msg.s3),
      child: ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.all(Msg.s4),
        boxShadow: const <BoxShadow>[],
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.bank(PhosphorIconsStyle.bold), color: AD.online),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text((a['label'] ?? uiCopy(UiMessage.m_bank_value1_109e885f49, {'value1': (a['account_number_last4'] ?? '').toString()})).toString(),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName()),
              const SizedBox(height: Msg.s1),
              Wrap(spacing: Msg.s1, runSpacing: 4, children: [
                ZineSticker('${a['currency'] ?? ''} · $status', kind: statusKind),
                if (taxMissing) const ZineSticker('tax info missing', kind: ZineStickerKind.no),
              ]),
            ]),
          ),
          const SizedBox(width: Msg.s3),
          ZineButton(
            label: uiCopy(UiMessage.m_withdraw_164546a9c5),
            fontSize: 15,
            onPressed: _balance >= _kMinTokens ? () => _withdraw(a) : null,
          ),
        ]),
      ),
    );
  }

  /// Payout history — ledger row (§7.10): label + dotted leader + value.
  Widget _historyRow(Map<String, dynamic> r) {
    final status = (r['status'] ?? '').toString();
    final color = switch (status) {
      'completed' => AD.online,
      'failed' || 'refunded' => AD.danger,
      _ => AD.textSecondary,
    };
    final when = DateTime.fromMillisecondsSinceEpoch(((r['created_at'] as num?) ?? 0).toInt());
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Flexible(
            child: Text('${_inr(((r['amount_coins'] as num?) ?? 0))} → ${r['target_currency'] ?? ''}',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.rowName().copyWith(fontWeight: FontWeight.w600)),
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ADText.preview(c: AD.textTertiary)),
          ),
          const SizedBox(width: Msg.s2),
          Text(status, style: ADText.sectionLabel(c: color)),
        ]),
        const SizedBox(height: 2),
        Text(
          '${when.day}/${when.month}/${when.year}'
          '${r['failure_reason'] != null ? ' — ${r['failure_reason']}' : ''}',
          style: ADText.sectionLabel(c: AD.textTertiary),
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
    UiLocaleScope.watch(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s6),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          UiText(UiMessage.m_add_a_bank_account_14b7765b2f, style: ADText.appTitle()),
          const SizedBox(height: Msg.s4),
          ZineField(controller: _holder, label: uiCopy(UiMessage.m_account_holder_name_5596842fc1)),
          const SizedBox(height: Msg.s3),
          ZineField(controller: _ifsc, label: uiCopy(UiMessage.m_ifsc_code_cf583c60fb), textCapitalization: TextCapitalization.characters),
          const SizedBox(height: Msg.s3),
          ZineField(controller: _number, label: uiCopy(UiMessage.m_account_number_f7573b7f5d), keyboardType: TextInputType.number),
          const SizedBox(height: Msg.s3),
          ZineField(controller: _label, label: uiCopy(UiMessage.m_label_optional_7df60cafd5)),
          const SizedBox(height: Msg.s5),
          UiText(UiMessage.m_tax_details_0c9ac13862, style: ADText.threadName()),
          const SizedBox(height: Msg.s1),
          UiText(UiMessage.m_needed_once_for_year_end_3e8df8c476,
              style: ADText.preview()),
          const SizedBox(height: Msg.s3),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: ZineDropdown<String>(
                label: uiCopy(UiMessage.m_tax_residency_47bf7784ca),
                value: _taxCountry,
                items: const [
                  DropdownMenuItem(value: 'IN', child: UiText(UiMessage.m_india_abd1492145)),
                  DropdownMenuItem(value: 'US', child: UiText(UiMessage.m_united_states_49dca65f36)),
                  DropdownMenuItem(value: 'GB', child: UiText(UiMessage.m_united_kingdom_8d23a6e37e)),
                  DropdownMenuItem(value: 'EU', child: UiText(UiMessage.m_eu_other_cd4f49f519)),
                ],
                onChanged: (v) => setState(() {
                  _taxCountry = v ?? 'IN';
                  _taxIdType = switch (_taxCountry) { 'IN' => 'pan', 'US' => 'ssn', _ => 'tin' };
                }),
              ),
            ),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: ZineDropdown<String>(
                label: uiCopy(UiMessage.m_id_type_0f16bc151e),
                value: _taxIdType,
                items: const [
                  DropdownMenuItem(value: 'pan', child: UiText(UiMessage.m_pan_e6205bc8ab)),
                  DropdownMenuItem(value: 'ssn', child: UiText(UiMessage.m_ssn_f96e4bd5ab)),
                  DropdownMenuItem(value: 'ein', child: UiText(UiMessage.m_ein_e24891dd2d)),
                  DropdownMenuItem(value: 'tin', child: UiText(UiMessage.m_tin_eb431a7b39)),
                  DropdownMenuItem(value: 'vat', child: UiText(UiMessage.m_vat_4885a17383)),
                ],
                onChanged: (v) => setState(() => _taxIdType = v ?? 'pan'),
              ),
            ),
          ]),
          const SizedBox(height: Msg.s3),
          ZineField(controller: _taxId, label: uiCopy(UiMessage.m_tax_id_b39071d6ed), error: _error != null),
          if (_error != null) ZineErrorMsg(_error!),
          const SizedBox(height: Msg.s5),
          ZineButton(
            label: uiCopy(UiMessage.m_save_bank_account_aefe472640),
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
    UiLocaleScope.watch(context);
    final valid = _amount >= _kMinTokens && _amount <= widget.max;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s6),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          UiText(UiMessage.m_withdraw_to_bank_049fbebd7d, style: ADText.appTitle()),
          const SizedBox(height: Msg.s1),
          UiText(UiMessage.m_available_value1_minimum_value2_b1fe80c7d1, params: {'value1': (_inr(widget.max)).toString(), 'value2': (_inr(_kMinTokens)).toString()},
              style: ADText.preview()),
          const SizedBox(height: Msg.s4),
          ZineField(
            controller: _ctrl,
            autofocus: true,
            label: uiCopy(UiMessage.m_amount_in_tokens_1_token_b0755e09ed),
            leadIcon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
            keyboardType: TextInputType.number,
            onChanged: (v) => setState(() => _amount = int.tryParse(v.trim()) ?? 0),
          ),
          const SizedBox(height: Msg.s3),
          if (_amount > 0)
            ZineCard(
              color: AD.card,
              radius: Msg.rLg,
              boxShadow: const <BoxShadow>[],
              padding: const EdgeInsets.all(Msg.s3),
              child: UiText(
                UiMessage.m_you_ll_receive_value1_in_adb8ffa04c, params: {'value1': (_inr(_amount)).toString(), 'value2': (widget.currency).toString()},
                style: ADText.preview(c: AD.online),
              ),
            ),
          const SizedBox(height: Msg.s4),
          ZineButton(
            label: valid ? uiCopy(UiMessage.m_withdraw_value1_5c8d8847e3, {'value1': (_inr(_amount)).toString()}) : uiCopy(UiMessage.m_enter_an_amount_d8a7700e1f),
            fullWidth: true,
            onPressed: valid ? () => Navigator.pop(context, _amount) : null,
          ),
        ]),
      ),
    );
  }
}
