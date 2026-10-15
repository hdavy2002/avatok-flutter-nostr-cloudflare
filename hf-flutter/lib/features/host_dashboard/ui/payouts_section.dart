import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../wallet/data/wallet_api.dart';
import '../data/dash_format.dart';
import '../data/host_dashboard_models.dart';
import '../data/payout_rules.dart';
import '../host_dashboard_providers.dart';
import 'dash_surface.dart';
import 'host_dashboard_copy.dart';
import 'section_async.dart';

/// The bottom of the earnings card: "Withdraw to bank •• 1234" (opens the request sheet), or the one reason
/// withdrawing is off (profile not live, identity check, bank account, below the minimum) with "Finish setup"
/// where the host can fix it. Payouts are manual: the host asks, an admin approves and pays by bank transfer.
class WithdrawArea extends ConsumerWidget {
  const WithdrawArea({super.key, required this.onFinishSetup});

  /// Opens onboarding at the identity or bank step.
  final void Function(String step) onFinishSetup;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = dashValueOf(ref.watch(hostPayoutsProvider));
    if (p == null || !p.enabled) return const SizedBox.shrink();
    final block = p.block;
    return Padding(
      padding: const EdgeInsets.only(top: HfSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (block != null) ...[
            Text(
              _blockText(block, p),
              style: HfText.of(context, HfText.body),
              key: const ValueKey<String>('payout-block'),
            ),
            if (block == PayoutBlock.kyc || block == PayoutBlock.bank) ...[
              const SizedBox(height: HfSpacing.md),
              FilledButton(
                key: const ValueKey<String>('payout-finish'),
                onPressed: () => onFinishSetup(
                  block == PayoutBlock.kyc ? 'aadhaar' : 'payout',
                ),
                child: const Text(HostCopy.finishSetup),
              ),
            ],
          ] else
            FilledButton(
              key: const ValueKey<String>('payout-open'),
              style: FilledButton.styleFrom(
                minimumSize: const Size(HfSpacing.tap, 52),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(HfRadius.tileSmall),
                ),
                textStyle: HfText.buttonSmall,
              ),
              onPressed: () => _openSheet(context, ref, p),
              child: Text(
                HostCopy.withdrawToBank(p.bankLast4),
                textAlign: TextAlign.center,
              ),
            ),
        ],
      ),
    );
  }

  static String _blockText(PayoutBlock b, PayoutsData p) => switch (b) {
    PayoutBlock.notLive => HostCopy.blockNotLive,
    PayoutBlock.kyc => HostCopy.blockKyc,
    PayoutBlock.bank => HostCopy.blockBank,
    PayoutBlock.tooLow => HostCopy.blockTooLow(Money.rupees(p.minRupees)),
  };

  Future<void> _openSheet(
    BuildContext context,
    WidgetRef ref,
    PayoutsData p,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    final reduced = hfReduceMotion(context);
    final done = await showHfSheet<bool>(
      context,
      title: HostCopy.requestTitle,
      initialSize: 0.7,
      minSize: 0.4,
      builder: (_) => PayoutSheet(payouts: p, onFinishSetup: onFinishSetup),
    );
    if (done == true) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text(HostCopy.requested)));
      if (overlay != null && !reduced) showPayoutSparkle(overlay);
    }
  }
}

/// The "money on its way" moment after a withdrawal request is accepted (HF-MOTION-D): a coin and a sparkle
/// burst over the screen for about 1.6 s, never blocking taps. Only after the server said yes; skipped with
/// reduced motion.
void showPayoutSparkle(OverlayState overlay) {
  late final OverlayEntry entry;
  var removed = false;
  void remove() {
    if (removed) return;
    removed = true;
    entry.remove();
  }

  entry = OverlayEntry(
    builder: (context) => IgnorePointer(
      child: Center(
        key: const ValueKey<String>('payout-sparkle'),
        child: Stack(
          alignment: Alignment.center,
          children: [
            PopIn(
              beginScale: 0.3,
              duration: const Duration(milliseconds: 420),
              child: Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: HfGradients.sun,
                  boxShadow: [
                    BoxShadow(
                      color: HfColors.sunshine.withValues(alpha: 0.6),
                      blurRadius: 20,
                    ),
                  ],
                ),
                child: const Icon(
                  Icons.currency_rupee_rounded,
                  color: HfColors.onPrimary,
                  size: 40,
                ),
              ),
            ),
            HfLottie(
              HfLottieAssets.sparkleBurst,
              width: 260,
              height: 260,
              onFinished: remove,
            ),
          ],
        ),
      ),
    ),
  );
  overlay.insert(entry);
  // Safety net: the entry always goes, even if the animation never reports its end.
  unawaited(Future<void>.delayed(const Duration(milliseconds: 2200), remove));
}

/// "Your withdrawals": the history with status and bank reference (UTR), cancel while still requested, and
/// the calm "Withdrawals open soon." note when the feature is off.
class PayoutsSection extends ConsumerWidget {
  const PayoutsSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payouts = ref.watch(hostPayoutsProvider);
    return SectionAsync<PayoutsData>(
      title: HostCopy.payoutsTitle,
      value: payouts,
      onRetry: () => ref.invalidate(hostPayoutsProvider),
      notEnabledMessage: HostCopy.payoutsSoon,
      skeletonHeight: 90,
      builder: (p) {
        final muted = dashMuted(context);
        return DashSurface(
          key: const ValueKey<String>('payouts-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DashHeading(HostCopy.historyTitle),
              const SizedBox(height: HfSpacing.sm),
              if (!p.enabled) ...[
                Text(
                  HostCopy.payoutsSoon,
                  style: muted,
                  key: const ValueKey<String>('payouts-soon'),
                ),
                for (final r in p.requests)
                  PayoutRow(
                    request: r,
                    onCancel: r.canCancel
                        ? () => _confirmCancel(context, ref, r)
                        : null,
                  ),
              ] else if (p.requests.isEmpty)
                Text(
                  HostCopy.historyEmpty,
                  style: muted,
                  key: const ValueKey<String>('payout-history-empty'),
                )
              else
                for (final r in p.requests)
                  PayoutRow(
                    request: r,
                    onCancel: r.canCancel
                        ? () => _confirmCancel(context, ref, r)
                        : null,
                  ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _confirmCancel(
    BuildContext context,
    WidgetRef ref,
    PayoutRequest r,
  ) async {
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
      messenger.showSnackBar(
        SnackBar(content: Text(PayoutRules.failure(e).message)),
      );
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

  /// Words and tint of a status pill. `null` tint = the neutral grey pill.
  static (String, HfTint?) statusStyle(String status) => switch (status) {
    'requested' => ('Requested', HfTint.butter),
    'approved' => ('Approved, paying soon', HfTint.lavender),
    'paid' => ('Paid', HfTint.sky),
    'rejected' => ('Not paid', HfTint.blush),
    'cancelled' => ('Cancelled', null),
    _ => (status, null),
  };

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final (label, tint) = statusStyle(request.status);
    final bg =
        tint?.bg(context) ?? (dark ? HfColors.darkBar : HfColors.surfaceSoft);
    final fg =
        tint?.ink(context) ?? (dark ? HfColors.mutedSoft : HfColors.muted);
    final when = request.status == 'paid'
        ? DashFormat.dayOf(request.paidAt ?? request.createdAt)
        : DashFormat.dayOf(request.createdAt);
    final muted = dashMuted(context);
    return Container(
      key: ValueKey<String>('payout-${request.id}'),
      constraints: const BoxConstraints(minHeight: HfSpacing.tap),
      padding: const EdgeInsets.symmetric(vertical: HfSpacing.md),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: dark ? HfColors.darkLine : HfColors.line),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  Money.rupees(request.amount),
                  style: HfText.of(context, HfText.bodyStrong),
                ),
              ),
              Flexible(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: bg,
                    borderRadius: BorderRadius.circular(HfRadius.pillRadius),
                  ),
                  child: Text(
                    label,
                    style: HfText.badge.copyWith(color: fg),
                    key: ValueKey<String>('payout-status-${request.id}'),
                  ),
                ),
              ),
            ],
          ),
          if (when.isNotEmpty) Text(when, style: muted),
          if (request.accountLast4 != null)
            Text('To the account ending ${request.accountLast4}', style: muted),
          if (request.status == 'paid' && request.utr != null)
            Text(
              'Bank reference (UTR): ${request.utr}',
              style: HfText.of(context, HfText.body),
              key: ValueKey<String>('payout-utr-${request.id}'),
            ),
          if (request.status == 'rejected' && request.reason != null)
            Text(
              request.reason!,
              style: HfText.of(context, HfText.body),
              key: ValueKey<String>('payout-reason-${request.id}'),
            ),
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

/// The request form (content of the shared bottom sheet). Shows the limits, checks the amount on the phone,
/// asks the server, and says in simple English what went wrong, under the amount. One Idempotency-Key per
/// amount: a retry after a lost answer reuses it, so the money is never reserved twice.
class PayoutSheet extends ConsumerStatefulWidget {
  const PayoutSheet({
    super.key,
    required this.payouts,
    required this.onFinishSetup,
  });

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
    final check = PayoutRules.check(
      _amount.text,
      minRupees: p.minRupees,
      withdrawable: p.withdrawable,
    );
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
      await ref
          .read(hostDashboardApiProvider)
          .requestPayout(amount, idempotencyKey: _key);
      unawaited(
        Analytics.capture('hf_app_payout_requested', {
          'amount_rupees': amount,
          'outcome': 'ok',
        }),
      );
      ref.invalidate(hostPayoutsProvider);
      ref.invalidate(hostEarningsProvider);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      unawaited(
        Analytics.capture('hf_app_payout_requested', {
          'amount_rupees': amount,
          'outcome': 'error',
          'reason': e.code,
          'status': e.status,
        }),
      );
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
    final muted = dashMuted(context);
    final dark = HfBrightness.isDark(context);
    return ListView(
      padding: EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.sm,
        HfSpacing.pageWide,
        HfSpacing.section + MediaQuery.viewInsetsOf(context).bottom,
      ),
      children: [
        Text(
          HostCopy.upTo(p.withdrawableDisplay),
          style: HfText.of(context, HfText.bodyStrong),
          key: const ValueKey<String>('payout-upto'),
        ),
        const SizedBox(height: 4),
        Text(
          HostCopy.rules(Money.rupees(p.minRupees), p.maxPerWeek),
          style: muted,
        ),
        if (p.bankOk && p.bankLast4 != null) ...[
          const SizedBox(height: 4),
          Text(
            HostCopy.bank(p.bankLast4!, p.bankIfsc),
            style: muted,
            key: const ValueKey<String>('payout-bank'),
          ),
        ],
        const SizedBox(height: 4),
        Text(HostCopy.manualNote, style: muted),
        const SizedBox(height: HfSpacing.xxl),
        TextField(
          key: const ValueKey<String>('payout-amount'),
          controller: _amount,
          enabled: !_sending,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(9),
          ],
          style: HfText.of(context, HfText.title),
          decoration: const InputDecoration(
            labelText: HostCopy.amountLabel,
            prefixText: '₹ ',
          ),
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
        ),
        if (_error != null) ...[
          const SizedBox(height: HfSpacing.md),
          Text(
            _error!,
            key: const ValueKey<String>('payout-error'),
            style: HfText.body.copyWith(
              color: dark ? HfColors.blushLight : HfColors.accent,
            ),
          ),
        ],
        if (_sending) ...[
          const SizedBox(height: HfSpacing.lg),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: const LinearProgressIndicator(minHeight: 4),
          ),
        ],
        const SizedBox(height: HfSpacing.xxl),
        if (_action == PayoutAction.finishSetup)
          FilledButton(
            key: const ValueKey<String>('payout-sheet-finish'),
            onPressed: () {
              Navigator.of(context).pop(false);
              final needsKyc = !p.kycOk;
              widget.onFinishSetup(needsKyc ? 'aadhaar' : 'payout');
            },
            child: const Text(HostCopy.finishSetup),
          )
        else
          HfButton(
            key: const ValueKey<String>('payout-submit'),
            label: _action == PayoutAction.retry
                ? 'Try again'
                : HostCopy.requestAction,
            loading: _sending,
            onPressed: _submit,
          ),
      ],
    );
  }
}
