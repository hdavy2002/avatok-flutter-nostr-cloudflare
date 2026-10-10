import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../../wallet/data/wallet_api.dart';
import '../data/dash_format.dart';
import '../data/host_dashboard_models.dart';
import '../data/payout_rules.dart';
import '../host_dashboard_providers.dart';
import 'host_dashboard_copy.dart';
import 'section_async.dart';

/// Withdrawals: what can be taken out now, the request form, and the history with status and UTR.
/// Payouts are manual: the host asks, an admin approves and pays by bank transfer, then enters the UTR.
class PayoutsSection extends ConsumerWidget {
  const PayoutsSection({super.key, required this.onFinishSetup});

  /// Opens onboarding at the identity or bank step.
  final void Function(String step) onFinishSetup;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payouts = ref.watch(hostPayoutsProvider);
    return SectionAsync<PayoutsData>(
      title: HostCopy.payoutsTitle,
      value: payouts,
      onRetry: () => ref.invalidate(hostPayoutsProvider),
      notEnabledMessage: HostCopy.payoutsSoon,
      builder: (p) {
        if (!p.enabled) {
          return HfCard(
            key: const ValueKey<String>('payouts-card'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(HostCopy.payoutsTitle, style: HfText.subtitle),
                const SizedBox(height: 8),
                const Text(HostCopy.payoutsSoon, style: HfText.bodyText, key: ValueKey<String>('payouts-soon')),
                if (p.requests.isNotEmpty) ..._history(context, ref, p),
              ],
            ),
          );
        }
        final block = p.block;
        return HfCard(
          key: const ValueKey<String>('payouts-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(HostCopy.payoutsTitle, style: HfText.subtitle),
              const SizedBox(height: 10),
              Text(HostCopy.upTo(p.withdrawableDisplay), style: HfText.bodyStrong, key: const ValueKey<String>('payout-upto')),
              const SizedBox(height: 4),
              Text(HostCopy.rules(Money.rupees(p.minRupees), p.maxPerWeek), style: HfText.note),
              if (p.bankOk && p.bankLast4 != null) ...[
                const SizedBox(height: 4),
                Text(HostCopy.bank(p.bankLast4!, p.bankIfsc), style: HfText.note, key: const ValueKey<String>('payout-bank')),
              ],
              const SizedBox(height: 4),
              const Text(HostCopy.manualNote, style: HfText.note),
              const SizedBox(height: 14),
              if (block != null) ...[
                Text(_blockText(block, p), style: HfText.bodyText, key: const ValueKey<String>('payout-block')),
                const SizedBox(height: 10),
                if (block == PayoutBlock.kyc || block == PayoutBlock.bank)
                  HfButton(
                    key: const ValueKey<String>('payout-finish'),
                    label: HostCopy.finishSetup,
                    onPressed: () => onFinishSetup(block == PayoutBlock.kyc ? 'aadhaar' : 'payout'),
                  ),
              ] else
                HfButton(
                  key: const ValueKey<String>('payout-open'),
                  label: HostCopy.withdraw,
                  icon: Icons.account_balance_rounded,
                  onPressed: () => _openSheet(context, ref, p),
                ),
              ..._history(context, ref, p),
            ],
          ),
        );
      },
    );
  }

  static String _blockText(PayoutBlock b, PayoutsData p) => switch (b) {
        PayoutBlock.notLive => HostCopy.blockNotLive,
        PayoutBlock.kyc => HostCopy.blockKyc,
        PayoutBlock.bank => HostCopy.blockBank,
        PayoutBlock.tooLow => HostCopy.blockTooLow(Money.rupees(p.minRupees)),
      };

  List<Widget> _history(BuildContext context, WidgetRef ref, PayoutsData p) {
    return [
      const SizedBox(height: 18),
      const Text(HostCopy.historyTitle, style: HfText.bodyStrong),
      const SizedBox(height: 6),
      if (p.requests.isEmpty)
        const Text(HostCopy.historyEmpty, style: HfText.note, key: ValueKey<String>('payout-history-empty'))
      else
        for (final r in p.requests) PayoutRow(request: r, onCancel: r.canCancel ? () => _confirmCancel(context, ref, r) : null),
    ];
  }

  Future<void> _openSheet(BuildContext context, WidgetRef ref, PayoutsData p) async {
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: HfColors.cream,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(HfRadius.card))),
      builder: (_) => PayoutSheet(payouts: p, onFinishSetup: onFinishSetup),
    );
    if (done == true && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text(HostCopy.requested)));
    }
  }

  Future<void> _confirmCancel(BuildContext context, WidgetRef ref, PayoutRequest r) async {
    final messenger = ScaffoldMessenger.of(context);
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(HostCopy.cancelTitle),
        content: const Text(HostCopy.cancelBody),
        actions: [
          TextButton(
            key: const ValueKey<String>('cancel-no'),
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(HostCopy.cancelNo),
          ),
          TextButton(
            key: const ValueKey<String>('cancel-yes'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(HostCopy.cancelYes),
          ),
        ],
      ),
    );
    if (yes != true) return;
    try {
      await ref.read(hostDashboardApiProvider).cancelPayout(r.id);
      messenger.showSnackBar(const SnackBar(content: Text(HostCopy.cancelled)));
    } on ApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(PayoutRules.failure(e).message)));
    }
    ref.invalidate(hostPayoutsProvider);
    ref.invalidate(hostEarningsProvider);
  }
}

/// One withdrawal in the history: amount, status, bank reference (UTR) once paid, the reason if not paid.
class PayoutRow extends StatelessWidget {
  const PayoutRow({super.key, required this.request, this.onCancel});

  final PayoutRequest request;
  final VoidCallback? onCancel;

  static (String, Color, Color) statusStyle(String status) => switch (status) {
        'requested' => ('Requested', HfColors.plum, HfColors.butter),
        'approved' => ('Approved, paying soon', HfColors.orchid, HfColors.lilac),
        'paid' => ('Paid', HfColors.rose, HfColors.blush),
        'rejected' => ('Not paid', HfColors.accent, HfColors.blush),
        'cancelled' => ('Cancelled', HfColors.mauve, HfColors.white),
        _ => (status, HfColors.mauve, HfColors.white),
      };

  @override
  Widget build(BuildContext context) {
    final (label, fg, bg) = statusStyle(request.status);
    final when = request.status == 'paid' ? DashFormat.dayOf(request.paidAt ?? request.createdAt) : DashFormat.dayOf(request.createdAt);
    return Container(
      key: ValueKey<String>('payout-${request.id}'),
      constraints: const BoxConstraints(minHeight: HfSpacing.tap),
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: HfColors.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(Money.rupees(request.amount), style: HfText.bodyStrong)),
              Flexible(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(
                    color: bg,
                    borderRadius: BorderRadius.circular(HfRadius.pill),
                    border: Border.all(color: HfColors.line),
                  ),
                  child: Text(label, style: HfText.badge.copyWith(color: fg), key: ValueKey<String>('payout-status-${request.id}')),
                ),
              ),
            ],
          ),
          if (when.isNotEmpty) Text(when, style: HfText.note),
          if (request.accountLast4 != null)
            Text('To the account ending ${request.accountLast4}', style: HfText.note),
          if (request.status == 'paid' && request.utr != null)
            Text('Bank reference (UTR): ${request.utr}', style: HfText.bodyText, key: ValueKey<String>('payout-utr-${request.id}')),
          if (request.status == 'rejected' && request.reason != null)
            Text(request.reason!, style: HfText.bodyText, key: ValueKey<String>('payout-reason-${request.id}')),
          if (onCancel != null)
            HfButton(
              key: ValueKey<String>('cancel-${request.id}'),
              label: HostCopy.cancelAction,
              kind: HfButtonKind.text,
              expand: false,
              onPressed: onCancel,
            ),
        ],
      ),
    );
  }
}

/// The request form (a bottom sheet). Checks the amount on the phone, asks the server, and says in simple
/// English what went wrong. One Idempotency-Key per amount: a retry after a lost answer reuses it, so the
/// money is never reserved twice.
class PayoutSheet extends ConsumerStatefulWidget {
  const PayoutSheet({super.key, required this.payouts, required this.onFinishSetup});

  final PayoutsData payouts;
  final void Function(String step) onFinishSetup;

  @override
  ConsumerState<PayoutSheet> createState() => _PayoutSheetState();
}

class _PayoutSheetState extends ConsumerState<PayoutSheet> {
  final TextEditingController _amount = TextEditingController();
  String? _error;
  PayoutAction _action = PayoutAction.none;
  bool _sending = false;
  String _key = WalletApi.newIdempotencyKey();
  String _keyAmount = '';

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final p = widget.payouts;
    final check = PayoutRules.check(_amount.text, minRupees: p.minRupees, withdrawable: p.withdrawable);
    if (!check.isOk) {
      setState(() {
        _error = check.error;
        _action = PayoutAction.none;
      });
      return;
    }
    final amount = check.amount!;
    final text = _amount.text.trim();
    if (text != _keyAmount) {
      _key = WalletApi.newIdempotencyKey();
      _keyAmount = text;
    }
    setState(() {
      _sending = true;
      _error = null;
      _action = PayoutAction.none;
    });
    try {
      await ref.read(hostDashboardApiProvider).requestPayout(amount, idempotencyKey: _key);
      unawaited(Analytics.capture('hf_app_payout_requested', {'amount_rupees': amount, 'outcome': 'ok'}));
      ref.invalidate(hostPayoutsProvider);
      ref.invalidate(hostEarningsProvider);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      unawaited(Analytics.capture('hf_app_payout_requested', {
        'amount_rupees': amount,
        'outcome': 'error',
        'reason': e.code,
        'status': e.status,
      }));
      if (!PayoutRules.keepsKey(e)) _keyAmount = '';
      final f = PayoutRules.failure(e, minRupees: p.minRupees);
      // The numbers may have moved (a payout was approved, a hold ended): read them again.
      ref.invalidate(hostPayoutsProvider);
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = f.message;
        _action = f.action;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.payouts;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(HostCopy.requestTitle, style: HfText.title),
            const SizedBox(height: 6),
            Text(HostCopy.upTo(p.withdrawableDisplay), style: HfText.note),
            Text(HostCopy.rules(Money.rupees(p.minRupees), p.maxPerWeek), style: HfText.note),
            const SizedBox(height: 14),
            TextField(
              key: const ValueKey<String>('payout-amount'),
              controller: _amount,
              enabled: !_sending,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(9)],
              style: HfText.title,
              decoration: const InputDecoration(labelText: HostCopy.amountLabel, prefixText: '₹ '),
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, key: const ValueKey<String>('payout-error'), style: HfText.bodyText.copyWith(color: HfColors.accent)),
            ],
            const SizedBox(height: 16),
            if (_action == PayoutAction.finishSetup)
              HfButton(
                key: const ValueKey<String>('payout-sheet-finish'),
                label: HostCopy.finishSetup,
                onPressed: () {
                  Navigator.of(context).pop(false);
                  final needsKyc = !p.kycOk;
                  widget.onFinishSetup(needsKyc ? 'aadhaar' : 'payout');
                },
              )
            else
              HfButton(
                key: const ValueKey<String>('payout-submit'),
                label: _action == PayoutAction.retry ? 'Try again' : HostCopy.requestAction,
                loading: _sending,
                onPressed: _submit,
              ),
          ],
        ),
      ),
    );
  }
}
