import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/theme.dart';
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Earnings & payout'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
          children: [
            Row(children: [
              Expanded(child: StatCard(label: 'Available', icon: Icons.account_balance_wallet,
                  color: AvaColors.success, value: affCoinsLabel(t.availableCoins),
                  sub: '${t.availableCoins} coins')),
              const SizedBox(width: 10),
              Expanded(child: StatCard(label: 'Held (refund window)', icon: Icons.hourglass_top,
                  color: kAffiliateOrange, value: affCoinsLabel(t.heldCoins),
                  sub: 'releases after 7 days')),
            ]),
            const SizedBox(height: 12),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: kAffiliateOrange,
                  padding: const EdgeInsets.symmetric(vertical: 14)),
              icon: const Icon(Icons.payments, size: 18),
              label: const Text('Withdraw with AvaPayout'),
              onPressed: _withdraw,
            ),
            const SizedBox(height: 6),
            const Text(
              'Commissions land in your AvaWallet instantly at settlement and become withdrawable after the 7-day refund window.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11.5, color: AvaColors.sub),
            ),
            const SizedBox(height: 18),
            const Text('Commission history',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const SizedBox(height: 4),
            if (_failed)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Column(children: [
                  const Text('Could not load your history.',
                      style: TextStyle(color: AvaColors.sub)),
                  const SizedBox(height: 10),
                  OutlinedButton(onPressed: _load, child: const Text('Retry')),
                ]),
              )
            else if (_entries == null)
              const Padding(padding: EdgeInsets.all(32),
                  child: Center(child: CircularProgressIndicator()))
            else if (_entries!.isEmpty)
              const AffEmpty('No commissions yet.\nShare your links — every referred purchase pays you 10%.')
            else ...[
              ..._entries!.map(_entryRow),
              if (_cursor != null && _cursor!.isNotEmpty)
                Center(
                  child: TextButton(
                    onPressed: _loadingMore ? null : _more,
                    child: _loadingMore
                        ? const SizedBox(width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Load more'),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _entryRow(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final positive = amount >= 0;
    final createdAt = ((e['created_at'] as num?) ?? 0).toInt();
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Container(width: 36, height: 36,
          decoration: BoxDecoration(
              color: (positive ? AvaColors.success : AvaColors.danger).withValues(alpha: .12),
              borderRadius: BorderRadius.circular(10)),
          child: Icon(positive ? Icons.trending_up : Icons.undo, size: 18,
              color: positive ? AvaColors.success : AvaColors.danger)),
      title: Text('${e['title'] ?? (positive ? 'Affiliate commission' : 'Commission reversed')}',
          maxLines: 1, overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
      subtitle: Text(fmtAffDate(createdAt),
          style: const TextStyle(fontSize: 11, color: AvaColors.sub)),
      trailing: Text('${positive ? '+' : '−'}${affCoinsLabel(amount.abs())}',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14,
              color: positive ? AvaColors.success : AvaColors.danger)),
    );
  }
}
