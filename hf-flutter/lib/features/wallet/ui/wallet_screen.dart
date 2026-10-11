import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/pending_intent.dart';
import '../../call/data/call_api.dart';
import '../billing/purchase_controller.dart';
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
  static const String noTokens = 'No money in your wallet yet. Add money below to start calling.';
  static const String testTokens = 'Test credit (spend only)';
  static const String history = 'History';
  static const String historyEmpty = 'Nothing here yet.';
  static const String purchases = 'Purchases';
  static const String receipts = 'Receipts';
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
    final next = Routes.safeNext(widget.query['next']);
    if (next != null) unawaited(ref.read(pendingIntentProvider).save(next));
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
      body = _WalletBody(onRefresh: _refresh, next: Routes.safeNext(widget.query['next']));
    }
    return Scaffold(
      appBar: AppBar(automaticallyImplyLeading: false, title: const Text(WalletCopy.title)),
      body: SafeArea(child: body),
    );
  }
}

/// Only built for a signed-in person, so a guest never reads the wallet.
class _WalletBody extends ConsumerStatefulWidget {
  const _WalletBody({required this.onRefresh, this.next});

  final String? next;

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
      data: (data) => _WalletList(data: data, onRefresh: widget.onRefresh, next: widget.next),
    );
  }
}

class _WalletList extends ConsumerWidget {
  const _WalletList({required this.data, required this.onRefresh, this.next});

  final String? next;

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
          const HfScene(kind: HfSceneKind.wallet, height: 135),
          const SizedBox(height: 16),
          const Text('More room for good conversations', style: HfText.headline),
          const SizedBox(height: 16),
          if (next != null) ...[
            HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('Your call is waiting for you', style: HfText.subtitle),
              const SizedBox(height: 8),
              const Text('Payments must be confirmed before money is available. You will review the latest price and balance before starting your call.', style: HfText.note),
              const SizedBox(height: 12),
              HfButton(key: const ValueKey('wallet-return-to-call'), label: 'Return to call',
                icon: Icons.arrow_forward_rounded,
                onPressed: !data.hasDebt && (data.tokenMode ? data.availableMicro > 0 : data.spendable > 0) && notice?.kind != NoticeKind.pending
                  ? () async {
                      final slug = Uri.parse(next!).queryParameters['host'];
                      if (slug != null) ref.invalidate(callEstimateProvider(slug));
                      await ref.read(pendingIntentProvider).clear();
                      if (context.mounted) context.go(next!);
                    } : null),
              HfButton(label: 'Keep browsing', kind: HfButtonKind.text, onPressed: () async {
                await ref.read(pendingIntentProvider).clear();
                if (context.mounted) context.go(Routes.home);
              }),
            ])),
            gap,
          ],
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
      color: HfColors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Icon(Icons.account_balance_wallet_rounded, color: HfColors.ink),
            Text(WalletCopy.balance, style: HfText.label),
          ]),
          const SizedBox(height: 4),
          Text('₹${data.balanceText}', key: const ValueKey<String>('balance-total'), style: HfText.hero),
          const SizedBox(height: 8),
          if (data.byValue.isEmpty && data.balanceMicro == 0) const Text(WalletCopy.noTokens, style: HfText.bodyText),
          if (data.hasTestTokens) ...[
            const SizedBox(height: 8),
            Text(
              '${WalletCopy.testTokens}: ₹${data.testTokensText}',
              key: const ValueKey<String>('test-tokens'),
              style: HfText.bodyText,
            ),
          ],
          if (data.hasReserved) ...[
            const SizedBox(height: 8),
            Text(
              '₹${data.availableText} is free to spend. The rest is held for a call in progress.',
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
      color: HfColors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Icon(Icons.account_balance_wallet_rounded, color: HfColors.ink),
            Text(WalletCopy.balance, style: HfText.label),
          ]),
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
                  Text('You owe ₹${debt.tokensText} after a refund.', style: HfText.bodyStrong),
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
          Container(padding: const EdgeInsets.all(10), margin: const EdgeInsets.only(right: 12),
            decoration: BoxDecoration(color: HfColors.sky, borderRadius: BorderRadius.circular(14)),
            child: const Icon(Icons.receipt_long_rounded, size: 22, color: HfColors.ink)),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(record.label, style: HfText.bodyStrong),
                if (sub.isNotEmpty) Text(sub, style: HfText.note),
              ],
            ),
          ),
          if (record.tokens != null) Flexible(child: Text(record.tokens!, style: HfText.bodyStrong, textAlign: TextAlign.end)),
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
            Flexible(child: Text(item.amountText, style: HfText.bodyStrong, textAlign: TextAlign.end)),
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
