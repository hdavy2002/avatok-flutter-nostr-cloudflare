
import '../../core/localization/ui_text.dart';

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
    UiLocaleScope.watch(context);
    final s = _s;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar:  ZineAppBar(
        title: uiCopy(UiMessage.m_avaverse_5a80bb0c8f),
        markWord: 'Verse',
        tag: 'creator earnings',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.tabGroups))
          : s == null
              ? _error()
              : RefreshIndicator(
                  onRefresh: () => _load(fresh: true),
                  color: AD.tabGroups,
                  child: ListView(padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s2), children: [
                    _periodChips(),
                    const SizedBox(height: Msg.s3),
                    ..._nudgeBanners(s),
                    _earningsCard(s),
                    const SizedBox(height: Msg.s3),
                    _projectionsCard(s),
                    const SizedBox(height: Msg.s3),
                    _momentumCard(s),
                    const SizedBox(height: Msg.s3),
                    _topEventsCard(s),
                    const SizedBox(height: Msg.s3),
                    _audienceCard(s),
                    const SizedBox(height: Msg.s3),
                    _reachCard(s),
                    const SizedBox(height: Msg.s3),
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
          const SizedBox(height: Msg.s3),
          ZineButton(label: uiCopy(UiMessage.m_retry_942087cc2d), variant: ZineButtonVariant.ghost,
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
    Color accent = AD.tabGroups,
    Color? fill,
    Widget? trailing,
    required List<Widget> children,
    VoidCallback? onTap,
  }) {
    return ZineCard(
      color: fill ?? AD.card,
      padding: const EdgeInsets.all(16),
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: icon, color: accent),
          const SizedBox(width: Msg.s3),
          Expanded(child: Text(title, style: ADText.appTitle().copyWith(fontSize: 19, height: 1.1))),
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
                style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
          ),
          const SizedBox(width: Msg.s1),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ADText.preview(c: AD.textTertiary).copyWith(fontSize: 13, height: 1.42)),
          ),
          const SizedBox(width: Msg.s1),
          if (pill)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
              decoration: BoxDecoration(
                color: AD.online,
                borderRadius: BorderRadius.circular(Msg.rPill),
                border: Border.all(color: AD.borderControl, width: 1),
                boxShadow: Msg.none,
              ),
              child: Text(value, style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w700)),
            )
          else
            Text(value, style: ADText.rowName(c: color ?? AD.textPrimary).copyWith(fontSize: 14, height: 1.3, fontWeight: FontWeight.w700)),
        ]),
      );

  List<Widget> _nudgeBanners(VerseSummary s) => [
        for (final n in s.nudges)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: ZineCard(
              color: AD.card,
              radius: Msg.rLg,
              boxShadow: Msg.none,
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                ZineIconBadge(icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold), color: AD.tabCalls, size: 30),
                const SizedBox(width: Msg.s2),
                Expanded(child: UiText(
                    UiMessage.m_value1_starts_soon_and_joins_fb55a80bf0, params: {'value1': (n['title']).toString()},
                    style: ADText.preview().copyWith(fontSize: 13, height: 1.42))),
                const SizedBox(width: 8),
                ZineLink('Remind',
                    onTap: () => _announce(n['listing_id'].toString(), n['title'].toString())),
              ]),
            ),
          ),
      ];

  Widget _earningsCard(VerseSummary s) {
    final e = s.earnings;
    return _card(
      title: uiCopy(UiMessage.m_earnings_81920761dd),
      icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
      accent: AD.online,
      trailing: _delta(s.n(e, 'delta_vs_yesterday') ~/ 100, suffix: ' vs yday'),
      onTap: () => _push(const WalletScreen()),
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(verseInr(s.n(e, 'settled')), style: ADText.appTitle().copyWith(fontSize: 40, height: 1.0, letterSpacing: 0.8)),
        ),
        const SizedBox(height: 2),
        UiText(UiMessage.m_settled_this_period_2d3e37fb93, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 10, letterSpacing: 0.8)),
        const SizedBox(height: Msg.s2),
        _kv('Pending in escrow (your 80%)', verseInr(s.n(e, 'pending_escrow_net'))),
        _kv('Maturing (7-day hold)', verseInr(s.n(e, 'maturing'))),
        _kv('Ready to pay out', verseInr(s.n(e, 'payoutable')), pill: true),
        const SizedBox(height: Msg.s2),
        Row(children: [
          ZineButton(
            label: uiCopy(UiMessage.m_statements_85f86d38c4),
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
      title: uiCopy(UiMessage.m_projected_e394afaf05),
      icon: PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
      accent: AD.tabGroups,
      onTap: () => _push(const MyListingsScreen()),
      children: [
        if (ev.isEmpty && (ct['sessions'] as num? ?? 0) == 0)
          UiText(UiMessage.m_no_upcoming_events_or_consults_cceceba185, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
        for (final p in ev.take(4))
          _kv('${p['title']} — ${p['joined']} joined', '≈ ${verseInr((p['projected_net'] as num?) ?? 0)}'),
        if ((ct['sessions'] as num? ?? 0) > 0)
          _kv('Today: ${ct['sessions']} consult(s) booked', '≈ ${verseInr((ct['projected_net'] as num?) ?? 0)} by tonight',
              color: AD.online),
      ],
    );
  }

  Widget _momentumCard(VerseSummary s) {
    final m = s.momentum;
    return _card(
      title: uiCopy(UiMessage.m_live_momentum_82abf9462a),
      icon: PhosphorIcons.lightning(PhosphorIconsStyle.bold),
      accent: AD.primaryBadge,
      trailing: _delta(s.n(m, 'delta_vs_prev_24h'), suffix: ' vs prev 24h'),
      children: [
        UiText(UiMessage.m_value1_joins_in_the_last_cb90c4b88f, params: {'value1': (s.n(m, 'joins_24h')).toString()},
            style: ADText.rowName().copyWith(fontSize: 15, height: 1.3, fontWeight: FontWeight.w600)),
        const SizedBox(height: Msg.s1),
        for (final e in s.momentumByEvent.take(4))
          _kv('${e['title']}', '+${e['joins_24h']} · ${e['joined_count']} waiting'),
      ],
    );
  }

  Widget _topEventsCard(VerseSummary s) {
    final top = s.topEvents;
    final maxRev = top.fold<num>(1, (m, e) => ((e['revenue'] as num?) ?? 0) > m ? (e['revenue'] as num) : m);
    return _card(
      title: uiCopy(UiMessage.m_top_events_b03c98ec2f),
      icon: PhosphorIcons.trophy(PhosphorIconsStyle.bold),
      accent: AD.danger,
      onTap: () => _push(const MyListingsScreen()),
      children: [
        if (top.isEmpty) UiText(UiMessage.m_no_sales_in_this_period_f14cf3ea5d, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
        for (final e in top)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('${e['title']}', maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.preview().copyWith(fontSize: 13, height: 1.42))),
                UiText(UiMessage.m_value1_value2_orders_caf5496e29, params: {'value1': (verseInr((e['revenue'] as num?) ?? 0)).toString(), 'value2': (e['orders']).toString()},
                    style: ADText.rowName(c: AD.online).copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w600)),
              ]),
              const SizedBox(height: 4),
              // mini bar (no chart package) — flat poster fill + ink edge
              FractionallySizedBox(
                widthFactor: (((e['revenue'] as num?) ?? 0) / maxRev).clamp(0.02, 1.0).toDouble(),
                child: Container(
                  height: 8,
                  decoration: BoxDecoration(
                    color: AD.tabGroups,
                    borderRadius: BorderRadius.circular(Msg.rSm),
                    border: Border.all(color: AD.borderControl, width: 1),
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
      title: uiCopy(UiMessage.m_audience_545c023576),
      icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
      accent: AD.tabCalls,
      children: [
        _kv('Followers', '${s.n(a, 'followers')}'),
        if (views != null) _kv('Views → opens → joins (30 d)', '$views → $opens → $joins')
        else UiText(UiMessage.m_funnel_data_warming_up_check_7eca41136c, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
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
      title: uiCopy(UiMessage.m_reach_2068b81b75),
      icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold),
      accent: AD.tabGroups,
      children: [
        _kv('Followers', '${s.n(r, 'followers')}'),
        _kv('Announcements left today', '$left of ${s.n(r, 'announce_daily_cap')}'),
        const SizedBox(height: 8),
        ZineButton(
          label: left <= 0 ? uiCopy(UiMessage.m_daily_limit_reached_729d0f0078) : uiCopy(UiMessage.m_notify_followers_6d504a307d),
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
            padding: const EdgeInsets.only(top: Msg.s2),
            child: UiText(UiMessage.m_publish_an_upcoming_listing_to_5eb01ca36e, style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
          ),
      ],
    );
  }

  Future<Map<String, dynamic>?> _pickListing(List<Map<String, dynamic>> events) =>
      showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        backgroundColor: AD.overlaySheet,
        shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
        builder: (s) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            for (final e in events)
              ListTile(
                  title: Text('${e['title']}', style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
                  subtitle: UiText(UiMessage.m_value1_joined_a14013d788, params: {'value1': (e['joined']).toString()}, style: ADText.sectionLabel(c: AD.textTertiary).copyWith(fontSize: 10, letterSpacing: 0.8)),
                  onTap: () => Navigator.pop(s, e)),
          ]),
        ),
      );

  Future<void> _announce(String listingId, String title) async {
    final ctl = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Msg.rLg),
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: UiText(UiMessage.m_notify_followers_6d504a307d, style: ADText.appTitle().copyWith(fontSize: 19, height: 1.1)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          UiText(UiMessage.m_title_followers_with_notifications_on_595c803abb, params: {'title': (title).toString()},
              style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
          const SizedBox(height: 12),
          ZineField(controller: ctl, maxLength: 200, hint: uiCopy(UiMessage.m_optional_message_c7f3d9c057)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false),
              child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.rowName(c: AD.textSecondary).copyWith(fontSize: 14))),
          ZineButton(label: uiCopy(UiMessage.m_send_f6f4688ff2), fontSize: 15, onPressed: () => Navigator.pop(d, true)),
        ],
      ),
    );
    if (go != true || !mounted) return;
    final r = await VerseApi.announce(listingId, message: ctl.text.trim());
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(r.error ?? uiCopy(UiMessage.m_sent_to_value1_follower_s_2feb8da8ad, {'value1': (r.sent).toString(), 'value2': (r.remaining).toString()})),
    ));
    _load(fresh: true);
  }

  Widget _reviewsCard(VerseSummary s) {
    final rs = s.reviewsToReply;
    return _card(
      title: uiCopy(UiMessage.m_reviews_to_reply_ad2b462f37),
      icon: PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold),
      accent: AD.primaryBadge,
      children: [
        if (rs.isEmpty) UiText(UiMessage.m_all_caught_up_0ffce725a6, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
        for (final r in rs.take(5))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Msg.s2),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                width: 30, height: 30,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: AD.tabCalls,
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Text('${r['rating']}★', style: ADText.tabLabel().copyWith(fontSize: 9, letterSpacing: 0.36)),
              ),
              const SizedBox(width: Msg.s2),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  UiText(UiMessage.m_value1_on_value2_8c51e8d2bb, params: {'value1': (r['author_name'] ?? 'A buyer').toString(), 'value2': (r['listing_title']).toString()},
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w600)),
                  Text('${r['body'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
                ]),
              ),
              const SizedBox(width: 8),
              ZineLink('Reply', onTap: () => _reply(r)),
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
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Msg.rLg),
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: UiText(UiMessage.m_reply_to_value1_8a50f3983c, params: {'value1': (review['author_name'] ?? uiCopy(UiMessage.m_review_c97ace4c8f)).toString()}, style: ADText.appTitle().copyWith(fontSize: 18, height: 1.1)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('"${review['body'] ?? ''}"', maxLines: 3, overflow: TextOverflow.ellipsis,
              style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
          const SizedBox(height: 12),
          ZineField(controller: ctl, maxLines: 3, maxLength: 1000, autofocus: true,
              hint: uiCopy(UiMessage.m_your_public_reply_0ea898c78d)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false),
              child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.rowName(c: AD.textSecondary).copyWith(fontSize: 14))),
          ZineButton(label: uiCopy(UiMessage.m_post_reply_860e367626), fontSize: 15, onPressed: () => Navigator.pop(d, true)),
        ],
      ),
    );
    if (go != true || ctl.text.trim().isEmpty || !mounted) return;
    final ok = await VerseApi.replyReview(review['id'].toString(), ctl.text.trim());
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(ok ? uiCopy(UiMessage.m_reply_posted_publicly_cd603d3a25) : uiCopy(UiMessage.m_could_not_post_reply_57ad07a795))));
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
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar:  ZineAppBar(
        title: uiCopy(UiMessage.m_statements_85f86d38c4),
        markWord: 'Statements',
        tag: 'monthly earnings csv',
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s5), children: [
        for (final m in _months)
          Padding(
            padding: const EdgeInsets.only(bottom: Msg.s3),
            child: ZineCard(
              radius: Msg.rLg,
              padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s3, Msg.s3),
              boxShadow: Msg.none,
              child: Row(children: [
                ZineIconBadge(icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold), color: AD.online, size: 30),
                const SizedBox(width: 12),
                Expanded(child: Text(m, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3))),
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
                          SnackBar(content: Text(ok ? uiCopy(UiMessage.m_statement_emailed_0f3d184973) : uiCopy(UiMessage.m_could_not_email_statement_58f7b0c036))));
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
