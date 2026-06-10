import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/theme.dart';
import '../../core/verse_api.dart';
import '../listings/my_listings_screen.dart';
import '../wallet/wallet_screen.dart';

/// AvaVerse (Phase 8) — the creator's bird's-eye dashboard. Pure aggregation
/// over wallet/listings/bookings/reviews + PostHog audience snapshot; every
/// card deep-links into its app.
class VerseScreen extends StatefulWidget {
  const VerseScreen({super.key});
  @override
  State<VerseScreen> createState() => _VerseScreenState();
}

class _VerseScreenState extends State<VerseScreen> {
  static const _color = Color(0xFF6C5CE7);
  String _period = '7d';
  VerseSummary? _s;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool fresh = false}) async {
    setState(() => _loading = _s == null);
    final s = await VerseApi.summary(period: _period, fresh: fresh);
    if (mounted) setState(() { _s = s ?? _s; _loading = false; });
  }

  void _push(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) {
    final s = _s;
    return Scaffold(
      appBar: AppBar(
        title: const Text('AvaVerse', style: TextStyle(fontWeight: FontWeight.w800)),
        backgroundColor: _color, foregroundColor: Colors.white,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : s == null
              ? _error()
              : RefreshIndicator(
                  onRefresh: () => _load(fresh: true),
                  child: ListView(padding: const EdgeInsets.all(14), children: [
                    _periodChips(),
                    const SizedBox(height: 10),
                    ..._nudgeBanners(s),
                    _earningsCard(s),
                    const SizedBox(height: 12),
                    _projectionsCard(s),
                    const SizedBox(height: 12),
                    _momentumCard(s),
                    const SizedBox(height: 12),
                    _topEventsCard(s),
                    const SizedBox(height: 12),
                    _audienceCard(s),
                    const SizedBox(height: 12),
                    _reachCard(s),
                    const SizedBox(height: 12),
                    _reviewsCard(s),
                    const SizedBox(height: 24),
                  ]),
                ),
    );
  }

  Widget _error() => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Could not load your dashboard'),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: _load, child: const Text('Retry')),
        ]),
      );

  Widget _periodChips() => Wrap(spacing: 8, children: [
        for (final p in const [('today', 'Today'), ('7d', '7 days'), ('30d', '30 days'), ('all', 'All time')])
          ChoiceChip(
            label: Text(p.$2),
            selected: _period == p.$1,
            selectedColor: _color.withValues(alpha: .15),
            onSelected: (_) { setState(() => _period = p.$1); _load(); },
          ),
      ]);

  // ---- cards ----------------------------------------------------------------

  Widget _card({required String title, required IconData icon, Widget? trailing, required List<Widget> children, VoidCallback? onTap}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          border: Border.all(color: AvaColors.line),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(icon, size: 18, color: _color),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5))),
            if (trailing != null) trailing,
          ]),
          const SizedBox(height: 10),
          ...children,
        ]),
      ),
    );
  }

  Widget _delta(int v, {String suffix = ''}) {
    if (v == 0) return const SizedBox.shrink();
    final up = v > 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: (up ? AvaColors.success : AvaColors.danger).withValues(alpha: .12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text('${up ? '+' : ''}$v$suffix',
          style: TextStyle(color: up ? AvaColors.success : AvaColors.danger, fontSize: 11.5, fontWeight: FontWeight.w800)),
    );
  }

  Widget _kv(String label, String value, {Color? color}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Expanded(child: Text(label, style: const TextStyle(color: AvaColors.sub, fontSize: 13))),
          Text(value, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5, color: color)),
        ]),
      );

  List<Widget> _nudgeBanners(VerseSummary s) => [
        for (final n in s.nudges)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: _color.withValues(alpha: .08), borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              const Icon(Icons.campaign_outlined, color: Color(0xFF6C5CE7)),
              const SizedBox(width: 10),
              Expanded(child: Text('"${n['title']}" starts soon and joins are below your average — remind your followers?',
                  style: const TextStyle(fontSize: 13))),
              TextButton(
                onPressed: () => _announce(n['listing_id'].toString(), n['title'].toString()),
                child: const Text('Remind'),
              ),
            ]),
          ),
      ];

  Widget _earningsCard(VerseSummary s) {
    final e = s.earnings;
    return _card(
      title: 'Earnings',
      icon: Icons.account_balance_wallet_outlined,
      trailing: _delta(s.n(e, 'delta_vs_yesterday') ~/ 100, suffix: ' vs yday'),
      onTap: () => _push(const WalletScreen()),
      children: [
        Text(verseUsd(s.n(e, 'settled')), style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900)),
        const Text('settled this period', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
        const SizedBox(height: 8),
        _kv('Pending in escrow (your 80%)', verseUsd(s.n(e, 'pending_escrow_net'))),
        _kv('Maturing (7-day hold)', verseUsd(s.n(e, 'maturing'))),
        _kv('Ready to pay out', verseUsd(s.n(e, 'payoutable')), color: AvaColors.success),
        const SizedBox(height: 6),
        Row(children: [
          OutlinedButton.icon(
            onPressed: () => _push(const StatementsScreen()),
            icon: const Icon(Icons.receipt_long_outlined, size: 16),
            label: const Text('Statements'),
          ),
        ]),
      ],
    );
  }

  Widget _projectionsCard(VerseSummary s) {
    final ev = s.projectedEvents;
    final ct = s.consultToday;
    return _card(
      title: 'Projected',
      icon: Icons.trending_up,
      onTap: () => _push(const MyListingsScreen()),
      children: [
        if (ev.isEmpty && (ct['sessions'] as num? ?? 0) == 0)
          const Text('No upcoming events or consults yet.', style: TextStyle(color: AvaColors.sub, fontSize: 13)),
        for (final p in ev.take(4))
          _kv('${p['title']} — ${p['joined']} joined', '≈ ${verseUsd((p['projected_net'] as num?) ?? 0)}'),
        if ((ct['sessions'] as num? ?? 0) > 0)
          _kv('Today: ${ct['sessions']} consult(s) booked', '≈ ${verseUsd((ct['projected_net'] as num?) ?? 0)} by tonight',
              color: AvaColors.success),
      ],
    );
  }

  Widget _momentumCard(VerseSummary s) {
    final m = s.momentum;
    return _card(
      title: 'Live momentum',
      icon: Icons.bolt_outlined,
      trailing: _delta(s.n(m, 'delta_vs_prev_24h'), suffix: ' vs prev 24h'),
      children: [
        Text('${s.n(m, 'joins_24h')} joins in the last 24 h',
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        const SizedBox(height: 6),
        for (final e in s.momentumByEvent.take(4))
          _kv('${e['title']}', '+${e['joins_24h']} · ${e['joined_count']} waiting'),
      ],
    );
  }

  Widget _topEventsCard(VerseSummary s) {
    final top = s.topEvents;
    final maxRev = top.fold<num>(1, (m, e) => ((e['revenue'] as num?) ?? 0) > m ? (e['revenue'] as num) : m);
    return _card(
      title: 'Top events',
      icon: Icons.emoji_events_outlined,
      onTap: () => _push(const MyListingsScreen()),
      children: [
        if (top.isEmpty) const Text('No sales in this period yet.', style: TextStyle(color: AvaColors.sub, fontSize: 13)),
        for (final e in top)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('${e['title']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
                Text('${verseUsd((e['revenue'] as num?) ?? 0)} · ${e['orders']} orders',
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12.5)),
              ]),
              const SizedBox(height: 3),
              // mini bar (no chart package)
              FractionallySizedBox(
                widthFactor: (((e['revenue'] as num?) ?? 0) / maxRev).clamp(0.02, 1.0).toDouble(),
                child: Container(height: 6, decoration: BoxDecoration(color: _color.withValues(alpha: .7), borderRadius: BorderRadius.circular(3))),
              ),
            ]),
          ),
      ],
    );
  }

  Widget _audienceCard(VerseSummary s) {
    final a = s.audience;
    final views = a['views'], opens = a['opens'], joins = a['joins'];
    final countries = ((a['top_countries'] as List?) ?? const []).cast<dynamic>();
    return _card(
      title: 'Audience',
      icon: Icons.groups_outlined,
      children: [
        _kv('Followers', '${s.n(a, 'followers')}'),
        if (views != null) _kv('Views → opens → joins (30 d)', '$views → $opens → $joins')
        else const Text('Funnel data warming up — check back soon.', style: TextStyle(color: AvaColors.sub, fontSize: 12.5)),
        if (countries.isNotEmpty)
          _kv('Top countries', countries.take(3).map((c) => '${c['code']} (${c['n']})').join('  ')),
      ],
    );
  }

  Widget _reachCard(VerseSummary s) {
    final r = s.reach;
    final left = s.n(r, 'announce_quota_left');
    final events = s.projectedEvents;
    return _card(
      title: 'Reach',
      icon: Icons.campaign_outlined,
      children: [
        _kv('Followers', '${s.n(r, 'followers')}'),
        _kv('Announcements left today', '$left of ${s.n(r, 'announce_daily_cap')}'),
        const SizedBox(height: 6),
        OutlinedButton.icon(
          onPressed: left <= 0 || events.isEmpty
              ? null
              : () async {
                  final p = events.length == 1 ? events.first : await _pickListing(events);
                  if (p != null) _announce(p['listing_id'].toString(), p['title'].toString());
                },
          icon: const Icon(Icons.notifications_active_outlined, size: 16),
          label: Text(left <= 0 ? 'Daily limit reached' : 'Notify followers'),
        ),
        if (events.isEmpty && left > 0)
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text('Publish an upcoming listing to announce it.', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
          ),
      ],
    );
  }

  Future<Map<String, dynamic>?> _pickListing(List<Map<String, dynamic>> events) =>
      showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        builder: (s) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            for (final e in events)
              ListTile(title: Text('${e['title']}'), subtitle: Text('${e['joined']} joined'),
                  onTap: () => Navigator.pop(s, e)),
          ]),
        ),
      );

  Future<void> _announce(String listingId, String title) async {
    final ctl = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Notify followers'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('"$title" — followers with notifications on will get a push.', style: const TextStyle(fontSize: 13)),
          const SizedBox(height: 10),
          TextField(controller: ctl, maxLength: 200,
              decoration: const InputDecoration(hintText: 'Optional message', border: OutlineInputBorder())),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Send')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    final r = await VerseApi.announce(listingId, message: ctl.text.trim());
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(r.error ?? 'Sent to ${r.sent} follower(s) — ${r.remaining} announcement(s) left today'),
    ));
    _load(fresh: true);
  }

  Widget _reviewsCard(VerseSummary s) {
    final rs = s.reviewsToReply;
    return _card(
      title: 'Reviews to reply',
      icon: Icons.reviews_outlined,
      children: [
        if (rs.isEmpty) const Text('All caught up 🎉', style: TextStyle(color: AvaColors.sub, fontSize: 13)),
        for (final r in rs.take(5))
          ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            leading: CircleAvatar(radius: 14, backgroundColor: _color.withValues(alpha: .15),
                child: Text('${r['rating']}★', style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800))),
            title: Text('${r['author_name'] ?? 'A buyer'} on ${r['listing_title']}',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
            subtitle: Text('${r['body'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
            trailing: TextButton(child: const Text('Reply'), onPressed: () => _reply(r)),
          ),
      ],
    );
  }

  Future<void> _reply(Map<String, dynamic> review) async {
    final ctl = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Reply to ${review['author_name'] ?? 'review'}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('"${review['body'] ?? ''}"', maxLines: 3, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontStyle: FontStyle.italic, fontSize: 13)),
          const SizedBox(height: 10),
          TextField(controller: ctl, maxLines: 3, maxLength: 1000, autofocus: true,
              decoration: const InputDecoration(hintText: 'Your public reply', border: OutlineInputBorder())),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Post reply')),
        ],
      ),
    );
    if (go != true || ctl.text.trim().isEmpty || !mounted) return;
    final ok = await VerseApi.replyReview(review['id'].toString(), ctl.text.trim());
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(ok ? 'Reply posted publicly' : 'Could not post reply')));
    if (ok) _load(fresh: true);
  }
}

/// A2 — monthly earnings statements: pick a month → share CSV or email it.
class StatementsScreen extends StatelessWidget {
  const StatementsScreen({super.key});

  List<String> get _months {
    final now = DateTime.now().toUtc();
    return List.generate(12, (i) {
      final d = DateTime.utc(now.year, now.month - i);
      return '${d.year}-${d.month.toString().padLeft(2, '0')}';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Earnings statements')),
      body: ListView(children: [
        for (final m in _months)
          ListTile(
            leading: const Icon(Icons.receipt_long_outlined),
            title: Text(m),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              IconButton(
                tooltip: 'Share CSV',
                icon: const Icon(Icons.ios_share),
                onPressed: () async {
                  final csv = await VerseApi.statementCsv(m);
                  if (csv == null) return;
                  await Share.shareXFiles(
                    [XFile.fromData(Uint8List.fromList(csv.codeUnits), mimeType: 'text/csv', name: 'avatok-statement-$m.csv')],
                    subject: 'AvaTok statement $m',
                  );
                },
              ),
              IconButton(
                tooltip: 'Email me',
                icon: const Icon(Icons.alternate_email),
                onPressed: () async {
                  final ok = await VerseApi.emailStatement(m);
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(ok ? 'Statement emailed' : 'Could not email statement')));
                  }
                },
              ),
            ]),
          ),
      ]),
    );
  }
}
