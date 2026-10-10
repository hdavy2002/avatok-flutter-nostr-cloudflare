import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/wallet_models.dart';
import '../wallet_providers.dart';
import 'buy_section.dart';
import 'purchase_notice_card.dart';
import 'refund_section.dart';

abstract final class WalletCopy {
  static const String title = 'Wallet';
  static const String balance = 'Your balance';
  static const String noTokens = 'No tokens yet. Buy tokens below to start calling.';
  static const String testTokens = 'Test tokens (spend only)';
  static const String history = 'History';
  static const String historyEmpty = 'Nothing here yet.';
  static const String purchases = 'Purchases';
  static const String receipts = 'Receipts';
  static const String limits = 'Your limits';
  static const String signIn = 'Sign in';
  static const String signInBody = 'Please sign in to see your wallet.';
}

/// Tab 3 (needs sign-in). Both wallet shapes render: tokens, and the old rupee shape while tokens are off.
/// Money is read live every time: nothing here is cached.
class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key, this.query = const <String, String>{}});

  /// A top-up return may carry query parameters. Nothing here needs them: the balance is always read live.
  final Map<String, String> query;

  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  @override
  void initState() {
    super.initState();
    // Recovery on each Wallet open: finish any purchase Play still lists but the server has not confirmed.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (ref.read(sessionProvider).isSignedIn) unawaited(ref.read(purchaseControllerProvider.notifier).recover());
    });
  }

  Future<void> _refresh() async {
    ref.invalidate(walletProvider);
    ref.invalidate(refundsProvider);
    ref.invalidate(receiptsProvider);
    ref.invalidate(packOffersProvider);
    try {
      await ref.read(walletProvider.future);
    } catch (_) {
      // the error panel shows it
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);

    final Widget body;
    if (session.isLoading) {
      body = const LoadingPanel();
    } else if (!session.isSignedIn) {
      body = EmptyPanel(
        message: WalletCopy.signInBody,
        icon: Icons.lock_outline_rounded,
        actionLabel: WalletCopy.signIn,
        onAction: () => requireSignIn(context, ref),
      );
    } else {
      body = _WalletBody(onRefresh: _refresh);
    }
    return Scaffold(
      appBar: AppBar(automaticallyImplyLeading: false, title: const Text(WalletCopy.title)),
      body: SafeArea(child: body),
    );
  }
}

/// Only built for a signed-in person, so a guest never reads the wallet.
class _WalletBody extends ConsumerStatefulWidget {
  const _WalletBody({required this.onRefresh});

  final Future<void> Function() onRefresh;

  @override
  ConsumerState<_WalletBody> createState() => _WalletBodyState();
}

class _WalletBodyState extends ConsumerState<_WalletBody> {
  bool _viewed = false;

  @override
  Widget build(BuildContext context) {
    ref.listen<AsyncValue<WalletData>>(walletProvider, (prev, next) {
      final data = valueOf(next);
      if (data == null || _viewed) return;
      _viewed = true;
      Analytics.capture('hf_app_wallet_viewed', {
        'mode': data.tokenMode ? 'tokens' : 'legacy',
        'has_debt': data.hasDebt,
      });
    });
    final wallet = ref.watch(walletProvider);
    return wallet.when(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      loading: () => const LoadingPanel(),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
        return ErrorPanel(error: e, onRetry: () => ref.invalidate(walletProvider));
      },
      data: (data) => _WalletList(data: data, onRefresh: widget.onRefresh),
    );
  }
}

class _WalletList extends ConsumerWidget {
  const _WalletList({required this.data, required this.onRefresh});

  final WalletData data;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notice = ref.watch(purchaseControllerProvider.select((s) => s.notice));
    const gap = SizedBox(height: HfSpacing.gapLarge);
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(HfSpacing.page),
        children: [
          if (notice != null) ...[
            PurchaseNoticeCard(notice: notice, onDismiss: () => ref.read(purchaseControllerProvider.notifier).dismissNotice()),
            gap,
          ],
          data.tokenMode ? _TokenBalanceCard(data: data) : _LegacyBalanceCard(data: data),
          if (data.hasDebt) ...[
            const SizedBox(height: HfSpacing.gap),
            _DebtBanner(debt: data.debt),
          ],
          gap,
          const BuySection(),
          if (data.limits != null) ...[
            gap,
            _LimitsCard(limits: data.limits!),
          ],
          gap,
          const RefundSection(),
          if (data.tokenMode) ...[
            gap,
            _PurchaseRecords(records: data.purchases),
          ],
          gap,
          _HistoryList(items: data.history),
          if (!data.tokenMode) ...[
            gap,
            const _Receipts(),
          ],
          const SizedBox(height: HfSpacing.gapLarge),
        ],
      ),
    );
  }
}

class _TokenBalanceCard extends StatelessWidget {
  const _TokenBalanceCard({required this.data});

  final WalletData data;

  @override
  Widget build(BuildContext context) {
    return HfCard(
      key: const ValueKey<String>('token-balance'),
      color: HfColors.lilac,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(WalletCopy.balance, style: HfText.label),
          const SizedBox(height: 4),
          Text('${data.balanceText} tokens', key: const ValueKey<String>('balance-total'), style: HfText.hero),
          const SizedBox(height: 8),
          if (data.byValue.isEmpty && data.balanceMicro == 0) const Text(WalletCopy.noTokens, style: HfText.bodyText),
          for (final b in data.byValue)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '${Money.microTokens(b.micro)} tokens worth ${Money.paise(b.valuePaisePerToken)} each',
                style: HfText.bodyText,
              ),
            ),
          if (data.hasTestTokens) ...[
            const SizedBox(height: 8),
            Text(
              '${WalletCopy.testTokens}: ${data.testTokensText} tokens',
              key: const ValueKey<String>('test-tokens'),
              style: HfText.bodyText,
            ),
          ],
          if (data.hasReserved) ...[
            const SizedBox(height: 8),
            Text(
              '${data.availableText} tokens are free to spend. The rest is held for a call in progress.',
              style: HfText.note,
            ),
          ],
        ],
      ),
    );
  }
}

class _LegacyBalanceCard extends StatelessWidget {
  const _LegacyBalanceCard({required this.data});

  final WalletData data;

  @override
  Widget build(BuildContext context) {
    return HfCard(
      key: const ValueKey<String>('legacy-balance'),
      color: HfColors.lilac,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(WalletCopy.balance, style: HfText.label),
          const SizedBox(height: 4),
          Text(Money.rupees(data.paidBalance), key: const ValueKey<String>('balance-total'), style: HfText.hero),
          if (data.testBalance > 0) ...[
            const SizedBox(height: 8),
            Text('Test credits (spend only): ${Money.rupees(data.testBalance)}', style: HfText.bodyText),
          ],
        ],
      ),
    );
  }
}

class _DebtBanner extends StatelessWidget {
  const _DebtBanner({required this.debt});

  final TokenDebt debt;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      child: HfCard(
        key: const ValueKey<String>('debt-banner'),
        color: HfColors.blush,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.info_outline_rounded, color: HfColors.accent, size: 28),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('You owe ${debt.tokensText} tokens after a refund.', style: HfText.bodyStrong),
                  const SizedBox(height: 4),
                  const Text(
                    'Your next purchase clears it first. Calls stay paused until then.',
                    style: HfText.bodyText,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LimitsCard extends StatelessWidget {
  const _LimitsCard({required this.limits});

  final WalletLimits limits;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(WalletCopy.limits, style: HfText.title),
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: const ValueKey<String>('limits'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Today ${Money.rupees(limits.spentToday)} of ${Money.rupees(limits.daily)}', style: HfText.bodyStrong),
              const SizedBox(height: 4),
              Text(
                'This month ${Money.rupees(limits.spentThisMonth)} of ${Money.rupees(limits.monthly)}',
                style: HfText.bodyStrong,
              ),
              const SizedBox(height: 8),
              Text(
                limits.paidTokensBasis ? 'These count the rupees you pay for tokens.' : 'These count the money you spend.',
                style: HfText.note,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _PurchaseRecords extends StatelessWidget {
  const _PurchaseRecords({required this.records});

  final List<PurchaseRecord> records;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(WalletCopy.purchases, style: HfText.title),
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: const ValueKey<String>('purchases'),
          child: records.isEmpty
              ? const Text('No purchases yet.', style: HfText.bodyText)
              : Column(
                  children: [
                    for (var i = 0; i < records.length; i++) ...[
                      if (i > 0) const Divider(color: HfColors.line, height: 1),
                      _PurchaseRow(record: records[i]),
                    ],
                  ],
                ),
        ),
      ],
    );
  }
}

class _PurchaseRow extends StatelessWidget {
  const _PurchaseRow({required this.record});

  final PurchaseRecord record;

  @override
  Widget build(BuildContext context) {
    final sub = [
      if (record.orderId != null) 'Order ${record.orderId}',
      if (record.at != null) shortDate(record.at),
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(record.label, style: HfText.bodyStrong),
                if (sub.isNotEmpty) Text(sub, style: HfText.note),
              ],
            ),
          ),
          if (record.tokens != null) Text(record.tokens!, style: HfText.bodyStrong),
        ],
      ),
    );
  }
}

class _HistoryList extends StatelessWidget {
  const _HistoryList({required this.items});

  final List<HistoryItem> items;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(WalletCopy.history, style: HfText.title),
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: const ValueKey<String>('history'),
          child: items.isEmpty
              ? const Text(WalletCopy.historyEmpty, style: HfText.bodyText)
              : Column(
                  children: [
                    for (var i = 0; i < items.length; i++) ...[
                      if (i > 0) const Divider(color: HfColors.line, height: 1),
                      _HistoryRow(item: items[i]),
                    ],
                  ],
                ),
        ),
      ],
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.item});

  final HistoryItem item;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: HfSpacing.tap),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item.label, style: HfText.bodyText),
                  if (item.at != null) Text(shortDate(item.at), style: HfText.note),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(item.amountText, style: HfText.bodyStrong),
          ],
        ),
      ),
    );
  }
}

/// Receipts for old rupee money. Hidden when there are none or the list cannot be read.
class _Receipts extends ConsumerWidget {
  const _Receipts();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = valueOf(ref.watch(receiptsProvider)) ?? const <WalletReceipt>[];
    if (list.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(WalletCopy.receipts, style: HfText.title),
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: const ValueKey<String>('receipts'),
          child: Column(
            children: [
              for (var i = 0; i < list.length; i++) ...[
                if (i > 0) const Divider(color: HfColors.line, height: 1),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Receipt ${list[i].number}', style: HfText.bodyText),
                            if (list[i].issuedAt != null) Text(shortDate(list[i].issuedAt), style: HfText.note),
                          ],
                        ),
                      ),
                      Text(Money.rupees(list[i].amountRupees), style: HfText.bodyStrong),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
