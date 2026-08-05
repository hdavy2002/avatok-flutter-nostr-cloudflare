import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
        {'amount_coins': widget.totals.availableTokens});
    Navigator.push(context, MaterialPageRoute(builder: (_) => const PayoutScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.totals;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(title: 'Earnings', markWord: 'Earnings', tag: 'your 10%, for life'),
      body: RefreshIndicator(
        onRefresh: _load,
        color: AD.primaryBadge,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
          children: [
            Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Expanded(child: StatCard(label: 'Available',
                  icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
                  color: AD.online, value: affTokensLabel(t.availableTokens),
                  sub: '${t.availableTokens} coins')),
              const SizedBox(width: Msg.s3),
              Expanded(child: StatCard(label: 'Held (refund window)',
                  icon: PhosphorIcons.hourglass(PhosphorIconsStyle.bold),
                  color: AD.micIdleBg, value: affTokensLabel(t.heldTokens),
                  sub: 'releases after 7 days')),
            ]),
            const SizedBox(height: Msg.s4),
            ZineButton(
              label: 'Withdraw with AvaPayout',
              fullWidth: true,
              fontSize: 18,
              icon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _withdraw,
            ),
            const SizedBox(height: Msg.s3),
            Text(
              'Commissions land in your AvaWallet instantly at settlement and become withdrawable after the 7-day refund window.',
              textAlign: TextAlign.center,
              style: ADText.preview(),
            ),
            const SizedBox(height: Msg.s5),
            Text('Commission history', style: ADText.sectionLabel()),
            const SizedBox(height: Msg.s2),
            if (_failed)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: Msg.s5),
                child: Column(children: [
                  ZineEmptyState(
                    icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
                    text: 'Could not load your history.',
                  ),
                  const SizedBox(height: Msg.s4),
                  ZineButton(label: 'Retry', variant: ZineButtonVariant.ghost,
                      fontSize: 16, onPressed: _load),
                ]),
              )
            else if (_entries == null)
              const Padding(padding: EdgeInsets.all(Msg.s6),
                  child: Center(child: CircularProgressIndicator(color: AD.primaryBadge)))
            else if (_entries!.isEmpty)
              const AffEmpty('No commissions yet.\nShare your links — every referred purchase pays you 10%.')
            else ...[
              ..._entries!.map(_entryRow),
              if (_cursor != null && _cursor!.isNotEmpty)
                Center(
                  child: Padding(
                    padding: const EdgeInsets.only(top: Msg.s2),
                    child: _loadingMore
                        ? const SizedBox(width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: AD.primaryBadge))
                        : ZineLink('Load more', onTap: _more),
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
      padding: const EdgeInsets.symmetric(vertical: Msg.s1),
      child: Row(children: [
        ZineIconBadge(
          icon: positive
              ? PhosphorIcons.trendUp(PhosphorIconsStyle.bold)
              : PhosphorIcons.arrowUUpLeft(PhosphorIconsStyle.bold),
          color: positive ? AD.online : AD.danger,
          size: 32,
        ),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${e['title'] ?? (positive ? 'Affiliate commission' : 'Commission reversed')}',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.rowName()),
            const SizedBox(height: 1),
            Text(fmtAffDate(createdAt),
                style: ADText.sectionLabel(c: AD.textTertiary)),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        Text('${positive ? '+' : '−'}${affTokensLabel(amount.abs())}',
            style: ADText.rowName(c: positive ? AD.online : AD.danger).copyWith(fontWeight: FontWeight.w700)),
      ]),
    );
  }
}
