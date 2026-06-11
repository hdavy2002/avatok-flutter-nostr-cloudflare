import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'affiliate_api.dart';
import 'widgets.dart';

/// Subscribers — anonymized users bound to this link, when they bound,
/// lifetime value generated, and your cumulative commission from each.
class SubscribersScreen extends StatefulWidget {
  final AffiliateLink link;
  const SubscribersScreen({super.key, required this.link});
  @override
  State<SubscribersScreen> createState() => _SubscribersScreenState();
}

class _SubscribersScreenState extends State<SubscribersScreen> {
  List<AffiliateSubscriber>? _subs;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaaffiliate', 'subscribers');
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final s = await AffiliateApi.subscribers(widget.link.id);
      if (mounted) setState(() => _subs = s);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Subscribers', markWord: 'Subs', tag: 'bound for life'),
      body: _failed
          ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ZineEmptyState(
                  icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
                  text: 'Could not load subscribers.',
                ),
                const SizedBox(height: 14),
                ZineButton(label: 'Retry', variant: ZineButtonVariant.ghost,
                    fontSize: 16, onPressed: _load),
              ]),
            )
          : _subs == null
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : _subs!.isEmpty
                  ? const AffEmpty(
                      'No referred users yet.\nEvery user who signs up through your link binds to you for life.')
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: Zine.blueInk,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
                        itemCount: _subs!.length + 1,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) => i == 0 ? _header() : _row(_subs![i - 1]),
                      ),
                    ),
    );
  }

  Widget _header() => Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Text(
          '${_subs!.length} referred ${_subs!.length == 1 ? 'user' : 'users'} on '
          '"${widget.link.title}" — identities are anonymized for privacy.',
          style: ZineText.sub(size: 12.5),
        ),
      );

  Widget _row(AffiliateSubscriber s) => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        boxShadow: Zine.shadowXs,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
              color: Zine.blue, size: 38),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.maskedHandle, style: ZineText.value(size: 14)),
              const SizedBox(height: 2),
              Text(
                'Bound ${fmtAffDate(s.boundAt)} · spent ${affCoinsLabel(s.ltvCoins)}'.toUpperCase(),
                style: ZineText.kicker(size: 9, color: Zine.inkMute),
              ),
            ]),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('+${affCoinsLabel(s.commissionCoins)}',
                style: ZineText.value(size: 14, weight: FontWeight.w900, color: Zine.mintInk)),
            Text('YOUR CUT', style: ZineText.kicker(size: 9, color: Zine.inkMute)),
          ]),
        ]),
      );
}
