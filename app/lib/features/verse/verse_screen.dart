import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verse_api.dart';
import '../listings/my_listings_screen.dart';
import '../wallet/wallet_screen.dart';

/// AvaVerse (Phase 8) — the creator's bird's-eye dashboard. Pure aggregation
/// over wallet/listings/bookings/reviews + PostHog audience snapshot; every
/// card deep-links into its app. Visuals follow the 'AvaVerse Earnings'
/// reference (mint money sub-brand, metric cards, ledger rows).
class VerseScreen extends StatefulWidget {
  const VerseScreen({super.key});
  @override
  State<VerseScreen> createState() => _VerseScreenState();
}

class _VerseScreenState extends State<VerseScreen> {
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
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'AvaVerse',
        markWord: 'Verse',
        tag: 'creator earnings',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : s == null
              ? _error()
              : RefreshIndicator(
                  onRefresh: () => _load(fresh: true),
                  color: Zine.blueInk,
                  child: ListView(padding: const EdgeInsets.fromLTRB(18, 14, 18, 8), children: [
                    _periodChips(),
                    const SizedBox(height: 14),
                    ..._nudgeBanners(s),
                    _earningsCard(s),
                    const SizedBox(height: 14),
                    _projectionsCard(s),
                    const SizedBox(height: 14),
                    _momentumCard(s),
                    const SizedBox(height: 14),
                    _topEventsCard(s),
                    const SizedBox(height: 14),
                    _audienceCard(s),
                    const SizedBox(height: 14),
                    _reachCard(s),
                    const SizedBox(height: 14),
                    _reviewsCard(s),
                    const SizedBox(height: 24),
                  ]),
                ),
    );
  }

  Widget _error() => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineEmptyState(
            icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
            text: 'Could not load your dashboard',
          ),
          const SizedBox(height: 14),
          ZineButton(label: 'Retry', variant: ZineButtonVariant.ghost,
              fontSize: 16, onPressed: _load),
        ]),
      );

  Widget _periodChips() => Wrap(spacing: 8, runSpacing: 8, children: [
        for (final p in const [('today', 'Today'), ('7d', '7 days'), ('30d', '30 days'), ('all', 'All time')])
          ZineChip(
            label: p.$2,
            active: _period == p.$1,
            onTap: () { setState(() => _period = p.$1); _load(); },
          ),
      ]);

  // ---- cards ----------------------------------------------------------------

  Widget _card({
    required String title,
    required IconData icon,
    Color accent = Zine.blue,
    Color? fill,
    Widget? trailing,
    required List<Widget> children,
    VoidCallback? onTap,
  }) {
    return ZineCard(
      color: fill ?? Zine.card,
      padding: const EdgeInsets.all(16),
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: icon, color: accent),
          const SizedBox(width: 11),
          Expanded(child: Text(title, style: ZineText.cardTitle())),
          if (trailing != null) trailing,
        ]),
        const SizedBox(height: 12),
        ...children,
      ]),
    );
  }

  Widget _delta(int v, {String suffix = ''}) {
    if (v == 0) return const SizedBox.shrink();
    final up = v > 0;
    return ZineSticker('${up ? '+' : ''}$v$suffix',
        kind: up ? ZineStickerKind.ok : ZineStickerKind.no);
  }

  /// Ledger row (§7.10): label + dotted leader + Nunito 900 value.
  /// [pill] renders the highlighted-row treatment: mint pill value.
  Widget _kv(String label, String value, {Color? color, bool pill = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Flexible(
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 13)),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ZineText.sub(size: 13, color: Zine.inkMute)),
          ),
          const SizedBox(width: 6),
          if (pill)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              decoration: BoxDecoration(
                color: Zine.mint,
                borderRadius: BorderRadius.circular(100),
                border: Zine.border,
                boxShadow: Zine.shadowXs,
              ),
              child: Text(value, style: ZineText.value(size: 13, weight: FontWeight.w900)),
            )
          else
            Text(value, style: ZineText.value(size: 13.5, weight: FontWeight.w900, color: color ?? Zine.ink)),
        ]),
      );

  List<Widget> _nudgeBanners(VerseSummary s) => [
        for (final n in s.nudges)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: ZineCard(
              color: Zine.paper2,
              radius: Zine.rSm,
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                ZineIconBadge(icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold), color: Zine.lilac, size: 30),
                const SizedBox(width: 10),
                Expanded(child: Text(
                    '"${n['title']}" starts soon and joins are below your average — remind your followers?',
                    style: ZineText.sub(size: 12.5))),
                const SizedBox(width: 8),
                ZineLink('REMIND',
                    onTap: () => _announce(n['listing_id'].toString(), n['title'].toString())),
              ]),
            ),
          ),
      ];

  Widget _earningsCard(VerseSummary s) {
    final e = s.earnings;
    return _card(
      title: 'Earnings',
      icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
      accent: Zine.card,
      fill: Zine.mint,
      trailing: _delta(s.n(e, 'delta_vs_yesterday') ~/ 100, suffix: ' vs yday'),
      onTap: () => _push(const WalletScreen()),
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(verseUsd(s.n(e, 'settled')), style: ZineText.stat(size: 40)),
        ),
        const SizedBox(height: 2),
        Text('SETTLED THIS PERIOD', style: ZineText.kicker(size: 10, color: Zine.ink)),
        const SizedBox(height: 10),
        _kv('Pending in escrow (your 80%)', verseUsd(s.n(e, 'pending_escrow_net'))),
        _kv('Maturing (7-day hold)', verseUsd(s.n(e, 'maturing'))),
        _kv('Ready to pay out', verseUsd(s.n(e, 'payoutable')), pill: true),
        const SizedBox(height: 10),
        Row(children: [
          ZineButton(
            label: 'Statements',
            variant: ZineButtonVariant.ghost,
            fontSize: 15,
            trailingIcon: false,
            icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold),
            onPressed: () => _push(const StatementsScreen()),
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
      icon: PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
      accent: Zine.blue,
      onTap: () => _push(const MyListingsScreen()),
      children: [
        if (ev.isEmpty && (ct['sessions'] as num? ?? 0) == 0)
          Text('No upcoming events or consults yet.', style: ZineText.sub(size: 13)),
        for (final p in ev.take(4))
          _kv('${p['title']} — ${p['joined']} joined', '≈ ${verseUsd((p['projected_net'] as num?) ?? 0)}'),
        if ((ct['sessions'] as num? ?? 0) > 0)
          _kv('Today: ${ct['sessions']} consult(s) booked', '≈ ${verseUsd((ct['projected_net'] as num?) ?? 0)} by tonight',
              color: Zine.mintInk),
      ],
    );
  }

  Widget _momentumCard(VerseSummary s) {
    final m = s.momentum;
    return _card(
      title: 'Live momentum',
      icon: PhosphorIcons.lightning(PhosphorIconsStyle.bold),
      accent: Zine.lime,
      trailing: _delta(s.n(m, 'delta_vs_prev_24h'), suffix: ' vs prev 24h'),
      children: [
        Text('${s.n(m, 'joins_24h')} joins in the last 24 h',
            style: ZineText.value(size: 15, weight: FontWeight.w800)),
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
      icon: PhosphorIcons.trophy(PhosphorIconsStyle.bold),
      accent: Zine.coral,
      onTap: () => _push(const MyListingsScreen()),
      children: [
        if (top.isEmpty) Text('No sales in this period yet.', style: ZineText.sub(size: 13)),
        for (final e in top)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('${e['title']}', maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 13))),
                Text('${verseUsd((e['revenue'] as num?) ?? 0)} · ${e['orders']} orders',
                    style: ZineText.value(size: 12.5, weight: FontWeight.w800, color: Zine.mintInk)),
              ]),
              const SizedBox(height: 4),
              // mini bar (no chart package) — flat poster fill + ink edge
              FractionallySizedBox(
                widthFactor: (((e['revenue'] as num?) ?? 0) / maxRev).clamp(0.02, 1.0).toDouble(),
                child: Container(
                  height: 8,
                  decoration: BoxDecoration(
                    color: Zine.blue,
                    borderRadius: BorderRadius.circular(3),
                    border: Border.all(color: Zine.ink, width: 1.5),
                  ),
                ),
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
      icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
      accent: Zine.lilac,
      children: [
        _kv('Followers', '${s.n(a, 'followers')}'),
        if (views != null) _kv('Views → opens → joins (30 d)', '$views → $opens → $joins')
        else Text('Funnel data warming up — check back soon.', style: ZineText.sub(size: 12.5)),
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
      icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold),
      accent: Zine.blue,
      children: [
        _kv('Followers', '${s.n(r, 'followers')}'),
        _kv('Announcements left today', '$left of ${s.n(r, 'announce_daily_cap')}'),
        const SizedBox(height: 8),
        ZineButton(
          label: left <= 0 ? 'Daily limit reached' : 'Notify followers',
          fontSize: 15,
          trailingIcon: false,
          icon: PhosphorIcons.bellRinging(PhosphorIconsStyle.bold),
          onPressed: left <= 0 || events.isEmpty
              ? null
              : () async {
                  final p = events.length == 1 ? events.first : await _pickListing(events);
                  if (p != null) _announce(p['listing_id'].toString(), p['title'].toString());
                },
        ),
        if (events.isEmpty && left > 0)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Publish an upcoming listing to announce it.', style: ZineText.sub(size: 12)),
          ),
      ],
    );
  }

  Future<Map<String, dynamic>?> _pickListing(List<Map<String, dynamic>> events) =>
      showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        backgroundColor: Zine.paper,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        builder: (s) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            for (final e in events)
              ListTile(
                  title: Text('${e['title']}', style: ZineText.value(size: 15)),
                  subtitle: Text('${e['joined']} JOINED', style: ZineText.kicker(size: 10, color: Zine.inkMute)),
                  onTap: () => Navigator.pop(s, e)),
          ]),
        ),
      );

  Future<void> _announce(String listingId, String title) async {
    final ctl = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Notify followers', style: ZineText.cardTitle()),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('"$title" — followers with notifications on will get a push.',
              style: ZineText.sub(size: 13)),
          const SizedBox(height: 12),
          ZineField(controller: ctl, maxLength: 200, hint: 'Optional message'),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false),
              child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Send', fontSize: 15, onPressed: () => Navigator.pop(d, true)),
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
      icon: PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold),
      accent: Zine.lime,
      children: [
        if (rs.isEmpty) Text('All caught up 🎉', style: ZineText.sub(size: 13)),
        for (final r in rs.take(5))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                width: 30, height: 30,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Zine.lilac,
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                child: Text('${r['rating']}★', style: ZineText.tag(size: 9)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${r['author_name'] ?? 'A buyer'} on ${r['listing_title']}',
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 13, weight: FontWeight.w800)),
                  Text('${r['body'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: ZineText.sub(size: 12)),
                ]),
              ),
              const SizedBox(width: 8),
              ZineLink('REPLY', onTap: () => _reply(r)),
            ]),
          ),
      ],
    );
  }

  Future<void> _reply(Map<String, dynamic> review) async {
    final ctl = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Reply to ${review['author_name'] ?? 'review'}', style: ZineText.cardTitle(size: 18)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('"${review['body'] ?? ''}"', maxLines: 3, overflow: TextOverflow.ellipsis,
              style: ZineText.sub(size: 13)),
          const SizedBox(height: 12),
          ZineField(controller: ctl, maxLines: 3, maxLength: 1000, autofocus: true,
              hint: 'Your public reply'),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false),
              child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Post reply', fontSize: 15, onPressed: () => Navigator.pop(d, true)),
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
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'Statements',
        markWord: 'Statements',
        tag: 'monthly earnings csv',
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(18, 14, 18, 24), children: [
        for (final m in _months)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: ZineCard(
              radius: Zine.rSm,
              padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
              boxShadow: Zine.shadowXs,
              child: Row(children: [
                ZineIconBadge(icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold), color: Zine.mint, size: 30),
                const SizedBox(width: 12),
                Expanded(child: Text(m, style: ZineText.value(size: 15))),
                ZineBackButton(
                  icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
                  onTap: () async {
                    final csv = await VerseApi.statementCsv(m);
                    if (csv == null) return;
                    await Share.shareXFiles(
                      [XFile.fromData(Uint8List.fromList(csv.codeUnits), mimeType: 'text/csv', name: 'avatok-statement-$m.csv')],
                      subject: 'AvaTok statement $m',
                    );
                  },
                ),
                const SizedBox(width: 8),
                ZineBackButton(
                  icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
                  onTap: () async {
                    final ok = await VerseApi.emailStatement(m);
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(ok ? 'Statement emailed' : 'Could not email statement')));
                    }
                  },
                ),
              ]),
            ),
          ),
      ]),
    );
  }
}
