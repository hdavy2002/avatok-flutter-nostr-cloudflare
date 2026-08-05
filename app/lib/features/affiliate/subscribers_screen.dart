import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(title: 'Subscribers', markWord: 'Subs', tag: 'bound for life'),
      body: _failed
          ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ZineEmptyState(
                  icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
                  text: 'Could not load subscribers.',
                ),
                const SizedBox(height: Msg.s4),
                ZineButton(label: 'Retry', variant: ZineButtonVariant.ghost,
                    fontSize: 16, onPressed: _load),
              ]),
            )
          : _subs == null
              ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
              : _subs!.isEmpty
                  ? const AffEmpty(
                      'No referred users yet.\nEvery user who signs up through your link binds to you for life.')
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: AD.primaryBadge,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
                        itemCount: _subs!.length + 1,
                        separatorBuilder: (_, __) => const SizedBox(height: Msg.s3),
                        itemBuilder: (_, i) => i == 0 ? _header() : _row(_subs![i - 1]),
                      ),
                    ),
    );
  }

  Widget _header() => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s1),
        child: Text(
          '${_subs!.length} referred ${_subs!.length == 1 ? 'user' : 'users'} on '
          '"${widget.link.title}" — identities are anonymized for privacy.',
          style: ADText.preview(),
        ),
      );

  Widget _row(AffiliateSubscriber s) => ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
        boxShadow: const <BoxShadow>[],
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
              color: AD.newGroup, size: 38),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.maskedHandle, style: ADText.rowName()),
              const SizedBox(height: 2),
              Text(
                'Bound ${fmtAffDate(s.boundAt)} · spent ${affCoinsLabel(s.ltvCoins)}',
                style: ADText.sectionLabel(c: AD.textTertiary),
              ),
            ]),
          ),
          const SizedBox(width: Msg.s2),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('+${affCoinsLabel(s.commissionCoins)}',
                style: ADText.rowName(c: AD.online).copyWith(fontWeight: FontWeight.w700)),
            Text('Your cut', style: ADText.sectionLabel(c: AD.textTertiary)),
          ]),
        ]),
      );
}
