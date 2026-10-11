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
import '../../../core/router/tab_shell.dart';
import '../../call/data/call_api.dart';
import '../billing/purchase_controller.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/wallet_models.dart';
import '../wallet_providers.dart';
import 'buy_section.dart';
import 'purchase_notice_card.dart';
import 'refund_section.dart';
import 'wallet_surface.dart';

abstract final class WalletCopy {
  static const String title = 'Wallet';
  static const String balance = 'Balance';
  static const String noTokens =
      'No money in your wallet yet. Add money below to start calling.';
  static const String testTokens = 'Test credit (spend only)';
  static const String recent = 'Recent';
  static const String historyEmpty = 'No activity yet.';
  static const String purchases = 'Purchase records';
  static const String receipts = 'Receipts';
  static const String signIn = 'Sign in';
  static const String signInBody = 'Please sign in to see your wallet.';
}

/// Muted text on the ink balance card (mockup `#D6D1EE`).
const Color _onInkMuted = Color(0xFFD6D1EE);

/// `45.00` -> `45`, `45.20` -> `45.20`: whole rupees drop the decimals, like the mockup's "₹342".
String _plainRupees(String text) =>
    text.endsWith('.00') ? text.substring(0, text.length - 3) : text;

/// Tab 3 (needs sign-in). Both wallet shapes render. Money is read live every time: nothing here is cached.
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
      if (ref.read(sessionProvider).isSignedIn) {
        unawaited(ref.read(purchaseControllerProvider.notifier).recover());
      }
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
      body = const _WalletSkeleton();
    } else if (!session.isSignedIn) {
      body = _WithHeader(
        child: EmptyPanel(
          message: WalletCopy.signInBody,
          icon: Icons.lock_outline_rounded,
          actionLabel: WalletCopy.signIn,
          onAction: () => requireSignIn(context, ref),
        ),
      );
    } else {
      body = _WalletBody(
        onRefresh: _refresh,
        next: Routes.safeNext(widget.query['next']),
      );
    }
    return Scaffold(body: SafeArea(bottom: false, child: body));
  }
}

class _Header extends StatelessWidget {
  const _Header();

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(WalletCopy.title, style: HfText.of(context, HfText.headline)),
  );
}

/// The page title above a panel (sign-in, error, offline).
class _WithHeader extends StatelessWidget {
  const _WithHeader({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Padding(
        padding: EdgeInsets.fromLTRB(
          HfSpacing.pageWide,
          16,
          HfSpacing.pageWide,
          0,
        ),
        child: _Header(),
      ),
      Expanded(child: child),
    ],
  );
}

/// Loading shape of the Wallet: title, balance card, four tiles, two rows.
class _WalletSkeleton extends StatelessWidget {
  const _WalletSkeleton();

  @override
  Widget build(BuildContext context) {
    Widget tile() => const Expanded(
      child: HfSkeleton.box(height: 88, radius: HfRadius.tile),
    );
    return Semantics(
      liveRegion: true,
      label: 'Loading your wallet',
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(
          HfSpacing.pageWide,
          16,
          HfSpacing.pageWide,
          0,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _Header(),
            const SizedBox(height: 16),
            const HfSkeleton.box(height: 136, radius: HfRadius.cardInner),
            const SizedBox(height: 16),
            const HfSkeleton.box(width: 120, height: 22, radius: 8),
            const SizedBox(height: 16),
            Row(
              children: [
                tile(),
                const SizedBox(width: HfSpacing.md),
                tile(),
              ],
            ),
            const SizedBox(height: HfSpacing.md),
            Row(
              children: [
                tile(),
                const SizedBox(width: HfSpacing.md),
                tile(),
              ],
            ),
            const SizedBox(height: 16),
            const HfSkeleton.box(height: 56, radius: HfRadius.control),
            const SizedBox(height: 20),
            const HfSkeleton.box(height: 64, radius: HfRadius.tile),
            const SizedBox(height: HfSpacing.md),
            const HfSkeleton.box(height: 64, radius: HfRadius.tile),
          ],
        ),
      ),
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
      loading: () => const _WalletSkeleton(),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) {
          return const _WithHeader(child: ComingSoonPanel());
        }
        return _WithHeader(
          child: ErrorPanel(
            error: e,
            onRetry: () => ref.invalidate(walletProvider),
          ),
        );
      },
      data: (data) => _WalletList(
        data: data,
        onRefresh: widget.onRefresh,
        next: widget.next,
      ),
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
    final notice = ref.watch(
      purchaseControllerProvider.select((s) => s.notice),
    );
    final rate = valueOf(ref.watch(walletRateProvider));
    const gap = SizedBox(height: 16);
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.fromLTRB(
          HfSpacing.pageWide,
          16,
          HfSpacing.pageWide,
          hfNavPadding(context),
        ),
        children: [
          const _Header(),
          gap,
          if (next != null) ...[
            WalletSurface(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Your call is waiting for you',
                    style: HfText.of(context, HfText.subsection),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Payments must be confirmed before money is available. You will review the latest price and balance before starting your call.',
                    style: HfText.of(context, HfText.note),
                  ),
                  const SizedBox(height: 12),
                  HfButton(
                    key: const ValueKey('wallet-return-to-call'),
                    label: 'Return to call',
                    icon: Icons.arrow_forward_rounded,
                    onPressed:
                        !data.hasDebt &&
                            (data.tokenMode
                                ? data.availableMicro > 0
                                : data.spendable > 0) &&
                            notice?.kind != NoticeKind.pending
                        ? () async {
                            final slug = Uri.parse(
                              next!,
                            ).queryParameters['host'];
                            if (slug != null) {
                              ref.invalidate(callEstimateProvider(slug));
                            }
                            await ref.read(pendingIntentProvider).clear();
                            if (context.mounted) context.go(next!);
                          }
                        : null,
                  ),
                  HfButton(
                    label: 'Keep browsing',
                    kind: HfButtonKind.text,
                    onPressed: () async {
                      await ref.read(pendingIntentProvider).clear();
                      if (context.mounted) context.go(Routes.home);
                    },
                  ),
                ],
              ),
            ),
            gap,
          ],
          if (notice != null) ...[
            PurchaseNoticeCard(
              notice: notice,
              onDismiss: () =>
                  ref.read(purchaseControllerProvider.notifier).dismissNotice(),
            ),
            gap,
          ],
          _BalanceCard(data: data, rate: rate),
          if (data.hasDebt) ...[gap, _DebtBanner(debt: data.debt)],
          gap,
          const BuySection(),
          const SizedBox(height: 20),
          const WalletSectionTitle(WalletCopy.recent),
          gap,
          _HistoryList(items: data.history),
          if (data.tokenMode) ...[
            gap,
            _PurchaseRecords(records: data.purchases),
          ],
          if (!data.tokenMode) const _Receipts(),
          gap,
          const RefundSection(),
        ],
      ),
    );
  }
}

/// "About N minutes at ₹R/min" (whole rupees); "Add money to start talking" when nothing is left to spend.
String _minutesLine(int minutes, num rate) => minutes <= 0
    ? 'Add money to start talking'
    : 'About $minutes ${minutes == 1 ? 'minute' : 'minutes'} at ₹${rate.round()}/min';

/// The ink balance card: radius 28, two decorative circles, the balance in Nunito 44.
class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.data, required this.rate});

  final WalletData data;
  final num? rate;

  /// Whole minutes the spendable money buys at [rate]: display only, null when the rate is unknown.
  int? get _minutes {
    final r = rate;
    if (r == null || r <= 0) return null;
    final spendable = data.tokenMode
        ? data.availableMicro / 1000000
        : data.spendable;
    return (spendable / r).floor();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = data.tokenMode;
    final amount = tokens
        ? '₹${_plainRupees(data.balanceText)}'
        : Money.rupees(data.paidBalance);
    final minutes = _minutes;
    final small = HfText.body.copyWith(
      fontSize: 14,
      color: _onInkMuted,
      height: 1.4,
    );
    return ClipRRect(
      key: ValueKey<String>(tokens ? 'token-balance' : 'legacy-balance'),
      borderRadius: BorderRadius.circular(HfRadius.cardInner),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: HfBrightness.isDark(context)
              ? HfColors.darkTile
              : HfColors.ink,
        ),
        child: Stack(
          clipBehavior: Clip.hardEdge,
          children: [
            Positioned(
              right: -50,
              top: -50,
              child: ExcludeSemantics(
                child: Container(
                  width: 130,
                  height: 130,
                  decoration: const BoxDecoration(
                    shape: BoxShape.circle,
                    color: HfColors.lavenderDeep,
                  ),
                ),
              ),
            ),
            Positioned(
              right: 24,
              bottom: -70,
              child: ExcludeSemantics(
                child: Container(
                  width: 120,
                  height: 120,
                  decoration: const BoxDecoration(
                    shape: BoxShape.circle,
                    color: HfColors.blushDeep,
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: Text(WalletCopy.balance, style: small),
                  ),
                  const SizedBox(height: 4),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      amount,
                      key: const ValueKey<String>('balance-total'),
                      style: HfText.hero.copyWith(
                        fontSize: 44,
                        height: 1.1,
                        color: HfColors.white,
                      ),
                    ),
                  ),
                  if (minutes != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      _minutesLine(minutes, rate!),
                      key: const ValueKey<String>('balance-minutes'),
                      style: small,
                    ),
                  ],
                  if (tokens &&
                      data.byValue.isEmpty &&
                      data.balanceMicro == 0) ...[
                    const SizedBox(height: 4),
                    Text(WalletCopy.noTokens, style: small),
                  ],
                  if (tokens && data.hasTestTokens) ...[
                    const SizedBox(height: 4),
                    Text(
                      '${WalletCopy.testTokens}: ₹${data.testTokensText}',
                      key: const ValueKey<String>('test-tokens'),
                      style: small,
                    ),
                  ],
                  if (tokens && data.hasReserved) ...[
                    const SizedBox(height: 4),
                    Text(
                      '₹${data.availableText} is free to spend. The rest is held for a call in progress.',
                      style: small,
                    ),
                  ],
                  if (!tokens && data.testBalance > 0) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Test credits (spend only): ${Money.rupees(data.testBalance)}',
                      style: small,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DebtBanner extends StatelessWidget {
  const _DebtBanner({required this.debt});

  final TokenDebt debt;

  @override
  Widget build(BuildContext context) {
    const tint = HfTint.blush;
    return Semantics(
      container: true,
      liveRegion: true,
      child: KeyedSubtree(
        key: const ValueKey<String>('debt-banner'),
        child: WalletSurface(
          color: tint.bg(context),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.info_outline_rounded,
                color: HfBrightness.isDark(context)
                    ? tint.ink(context)
                    : HfColors.accent,
                size: 28,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'You owe ₹${debt.tokensText} after a refund.',
                      style: HfText.bodyStrong.copyWith(
                        color: tint.valueInk(context),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Your next purchase clears it first. Calls stay paused until then.',
                      style: HfText.body.copyWith(
                        color: tint.valueInk(context),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
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
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const WalletSectionTitle(WalletCopy.purchases),
        const SizedBox(height: 16),
        WalletRowsCard(
          key: const ValueKey<String>('purchases'),
          emptyText: 'No purchases yet.',
          rows: [for (final r in records) _PurchaseRow(record: r)],
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
    return WalletRow(
      leading: const WalletRowTile(
        tint: HfTint.sky,
        icon: Icons.receipt_long_rounded,
      ),
      title: record.label,
      subtitle: sub,
      trailing: record.tokens ?? '',
    );
  }
}

class _HistoryList extends StatelessWidget {
  const _HistoryList({required this.items});

  final List<HistoryItem> items;

  @override
  Widget build(BuildContext context) {
    return WalletRowsCard(
      key: const ValueKey<String>('history'),
      limit: 8,
      emptyText: WalletCopy.historyEmpty,
      rows: [for (final item in items) _HistoryRow(item: item)],
    );
  }
}

final RegExp _callLabel = RegExp(r'^(Call with .+?)(?:\s*\((.+)\))?$');

/// Two kinds of line: a call (host tile, "Call with Name", "Today · 12 min", "−₹N") and a top-up (butter plus
/// tile, "Added money", "Yesterday · Google Play", "+₹N"). Anything else keeps the server's label.
class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.item});

  final HistoryItem item;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final day = walletDayLabel(item.at);
    final amount = item.amountText.replaceFirst(RegExp(r'^-'), '−');
    final isCall =
        item.callId != null ||
        item.kind == 'call_spent' ||
        item.label.startsWith('Call with ');
    if (isCall) {
      final m = _callLabel.firstMatch(item.label);
      final title = m?.group(1) ?? item.label;
      final duration = m?.group(2);
      final name = title.startsWith('Call with ')
          ? title.substring('Call with '.length).trim()
          : '';
      return WalletRow(
        leading: WalletRowTile(
          tint: HfTint.lavender,
          icon: name.isEmpty ? Icons.call_rounded : null,
          text: name.isEmpty ? null : name.substring(0, 1).toUpperCase(),
        ),
        title: title,
        subtitle: [
          day,
          if (duration != null) duration,
        ].where((s) => s.isNotEmpty).join(' · '),
        trailing: amount,
      );
    }
    if (item.kind == 'purchase') {
      return WalletRow(
        leading: const WalletRowTile(
          tint: HfTint.butter,
          icon: Icons.add_rounded,
        ),
        title: 'Added money',
        subtitle: [day, 'Google Play'].where((s) => s.isNotEmpty).join(' · '),
        trailing: amount,
        trailingColor: dark ? HfColors.lavenderLight : HfColors.lavenderDeep,
      );
    }
    return WalletRow(
      leading: const WalletRowTile(
        tint: HfTint.sky,
        icon: Icons.receipt_long_rounded,
      ),
      title: item.label,
      subtitle: day,
      trailing: amount,
      trailingColor: amount.startsWith('+')
          ? (dark ? HfColors.lavenderLight : HfColors.lavenderDeep)
          : null,
    );
  }
}

/// Receipts for old rupee money. Hidden when there are none or the list cannot be read.
class _Receipts extends ConsumerWidget {
  const _Receipts();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list =
        valueOf(ref.watch(receiptsProvider)) ?? const <WalletReceipt>[];
    if (list.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WalletSectionTitle(WalletCopy.receipts),
          const SizedBox(height: 16),
          WalletRowsCard(
            key: const ValueKey<String>('receipts'),
            rows: [
              for (final r in list)
                WalletRow(
                  leading: const WalletRowTile(
                    tint: HfTint.sky,
                    icon: Icons.receipt_long_rounded,
                  ),
                  title: 'Receipt ${r.number}',
                  subtitle: r.issuedAt == null ? '' : shortDate(r.issuedAt),
                  trailing: Money.rupees(r.amountRupees),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
