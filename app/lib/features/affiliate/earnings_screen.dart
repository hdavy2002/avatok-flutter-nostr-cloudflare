import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../payout/payout_screen.dart';
import 'affiliate_api.dart';
import 'widgets.dart';

/// Earnings & Payout — the wallet ledger filtered to affiliate_commission
/// entries, held vs available, Withdraw hands off to the existing AvaPayout
/// flow (commissions live in the same AvaWallet; payout rules unchanged).
class AffiliateEarningsScreen extends StatefulWidget {
  final AffiliateTotals totals;
  const AffiliateEarningsScreen({super.key, required this.totals});
  @override
  State<AffiliateEarningsScreen> createState() => _AffiliateEarningsScreenState();
}

class _AffiliateEarningsScreenState extends State<AffiliateEarningsScreen> {
  List<Map<String, dynamic>>? _entries;
  String? _cursor;
  bool _loadingMore = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaaffiliate', 'earnings');
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final r = await MoneyApi.ledger(types: const ['affiliate_commission']);
      if (!mounted) return;
      setState(() {
        _entries = ((r['entries'] as List?) ?? const [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
        _cursor = r['cursor']?.toString();
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _more() async {
    if (_cursor == null || _cursor!.isEmpty || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final r = await MoneyApi.ledger(types: const ['affiliate_commission'], cursor: _cursor);
      if (!mounted) return;
      setState(() {
        _entries!.addAll(((r['entries'] as List?) ?? const [])
            .map((e) => (e as Map).cast<String, dynamic>()));
        _cursor = r['cursor']?.toString();
      });
    } catch (_) {/* keep what we have */} finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _withdraw() {
    Analytics.capture('affiliate_payout_requested',
        {'amount_coins': widget.totals.availableCoins});
    Navigator.push(context, MaterialPageRoute(builder: (_) => const PayoutScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.totals;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Earnings', markWord: 'Earnings', tag: 'your 10%, for life'),
      body: RefreshIndicator(
        onRefresh: _load,
        color: Zine.blueInk,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 32),
          children: [
            Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Expanded(child: StatCard(label: 'Available',
                  icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
                  color: Zine.mint, value: affCoinsLabel(t.availableCoins),
                  sub: '${t.availableCoins} coins')),
              const SizedBox(width: 12),
              Expanded(child: StatCard(label: 'Held (refund window)',
                  icon: PhosphorIcons.hourglass(PhosphorIconsStyle.bold),
                  color: Zine.lilac, value: affCoinsLabel(t.heldCoins),
                  sub: 'releases after 7 days')),
            ]),
            const SizedBox(height: 16),
            ZineButton(
              label: 'Withdraw with AvaPayout',
              fullWidth: true,
              fontSize: 18,
              icon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _withdraw,
            ),
            const SizedBox(height: 10),
            Text(
              'Commissions land in your AvaWallet instantly at settlement and become withdrawable after the 7-day refund window.',
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 11.5),
            ),
            const SizedBox(height: 22),
            Text('COMMISSION HISTORY', style: ZineText.kicker(size: 11.5)),
            const SizedBox(height: 8),
            if (_failed)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Column(children: [
                  ZineEmptyState(
                    icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
                    text: 'Could not load your history.',
                  ),
                  const SizedBox(height: 14),
                  ZineButton(label: 'Retry', variant: ZineButtonVariant.ghost,
                      fontSize: 16, onPressed: _load),
                ]),
              )
            else if (_entries == null)
              const Padding(padding: EdgeInsets.all(32),
                  child: Center(child: CircularProgressIndicator(color: Zine.blueInk)))
            else if (_entries!.isEmpty)
              const AffEmpty('No commissions yet.\nShare your links — every referred purchase pays you 10%.')
            else ...[
              ..._entries!.map(_entryRow),
              if (_cursor != null && _cursor!.isNotEmpty)
                Center(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: _loadingMore
                        ? const SizedBox(width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))
                        : ZineLink('LOAD MORE', onTap: _more),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  /// Ledger row (§7.10): icon badge + label + mint/coral value.
  Widget _entryRow(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final positive = amount >= 0;
    final createdAt = ((e['created_at'] as num?) ?? 0).toInt();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        ZineIconBadge(
          icon: positive
              ? PhosphorIcons.trendUp(PhosphorIconsStyle.bold)
              : PhosphorIcons.arrowUUpLeft(PhosphorIconsStyle.bold),
          color: positive ? Zine.mint : Zine.coral,
          size: 32,
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${e['title'] ?? (positive ? 'Affiliate commission' : 'Commission reversed')}',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.value(size: 13.5)),
            const SizedBox(height: 1),
            Text(fmtAffDate(createdAt).toUpperCase(),
                style: ZineText.kicker(size: 9, color: Zine.inkMute)),
          ]),
        ),
        const SizedBox(width: 8),
        Text('${positive ? '+' : '−'}${affCoinsLabel(amount.abs())}',
            style: ZineText.value(size: 14, weight: FontWeight.w900,
                color: positive ? Zine.mintInk : Zine.coral)),
      ]),
    );
  }
}
