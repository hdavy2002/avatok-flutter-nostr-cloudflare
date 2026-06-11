import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/theme.dart';
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Subscribers'),
      ),
      body: _failed
          ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Text('Could not load subscribers.',
                    style: TextStyle(color: AvaColors.sub)),
                const SizedBox(height: 10),
                OutlinedButton(onPressed: _load, child: const Text('Retry')),
              ]),
            )
          : _subs == null
              ? const Center(child: CircularProgressIndicator())
              : _subs!.isEmpty
                  ? const AffEmpty(
                      'No referred users yet.\nEvery user who signs up through your link binds to you for life.')
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(16),
                        itemCount: _subs!.length + 1,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) => i == 0 ? _header() : _row(_subs![i - 1]),
                      ),
                    ),
    );
  }

  Widget _header() => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(
          '${_subs!.length} referred ${_subs!.length == 1 ? 'user' : 'users'} on '
          '"${widget.link.title}" — identities are anonymized for privacy.',
          style: const TextStyle(fontSize: 12.5, color: AvaColors.sub),
        ),
      );

  Widget _row(AffiliateSubscriber s) => ListTile(
        contentPadding: const EdgeInsets.symmetric(vertical: 6),
        leading: Container(width: 42, height: 42,
            decoration: BoxDecoration(
                color: kAffiliateOrange.withValues(alpha: .12),
                shape: BoxShape.circle),
            child: const Icon(Icons.person, color: kAffiliateOrange, size: 20)),
        title: Text(s.maskedHandle,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        subtitle: Text(
          'Bound ${fmtAffDate(s.boundAt)} · spent ${affCoinsLabel(s.ltvCoins)}',
          style: const TextStyle(fontSize: 11.5, color: AvaColors.sub),
        ),
        trailing: Column(mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text('+${affCoinsLabel(s.commissionCoins)}',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14,
                  color: AvaColors.success)),
          const Text('your commission',
              style: TextStyle(fontSize: 9.5, color: AvaColors.sub)),
        ]),
      );
}
