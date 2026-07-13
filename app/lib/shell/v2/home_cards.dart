import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/call_log_store.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../shell_v2.dart';
import 'home_cards_api.dart';
import 'home_cards_store.dart';
import 'shell_destinations.dart';

/// The Home dashboard body (plan §3): a scrollable, user-ORDERED column of cards,
/// each toggleable per-account (see [HomeCardPrefs]). Phase 3 completes the set:
/// Wallet · Call logs · Messages · Analytics (local) · Earnings · Visitors ·
/// Listings. The last three read ONE precomputed server aggregate
/// ([HomeCardsApi] → /api/home/cards), so Home never fans out and never touches
/// PostHog (card contract §8). Every card defines a loading, empty and failure
/// state and its own eligibility (Visitors hides when unavailable; Listings hides
/// with no listings).
class HomeCards extends StatefulWidget {
  const HomeCards({super.key});

  @override
  State<HomeCards> createState() => _HomeCardsState();
}

class _UnreadPreview {
  final String name;
  final String preview;
  final int count;
  const _UnreadPreview(this.name, this.preview, this.count);
}

class _HomeCardsState extends State<HomeCards> {
  Map<String, bool> _visible = {for (final id in HomeCardPrefs.ids) id: true};
  List<String> _order = List<String>.from(HomeCardPrefs.ids);

  int? _coins;
  bool _walletLoading = true;

  List<CallEntry> _calls = const [];
  bool _callsLoading = true;

  List<_UnreadPreview> _unread = const [];
  bool _messagesLoading = true;

  int _msgTab = 0; // 0 = Talk, 1 = SMS

  // Local analytics (from on-device stores only — never PostHog).
  int _callsToday = 0;
  int _messagesToday = 0;
  bool _analyticsLoading = true;

  // Server aggregate (earnings / visitors / listings).
  HomeCardsData? _agg;
  bool _aggLoading = true;
  bool _aggFailed = false;

  @override
  void initState() {
    super.initState();
    HomeCardPrefs.revision.addListener(_reloadPrefs);
    _reloadPrefs();
    _loadWallet();
    _loadCalls();
    _loadMessages();
    _loadAnalytics();
    _loadAggregate();
  }

  @override
  void dispose() {
    HomeCardPrefs.revision.removeListener(_reloadPrefs);
    super.dispose();
  }

  Future<void> _reloadPrefs() async {
    final v = await HomeCardPrefs.load();
    final o = await HomeCardPrefs.order();
    if (mounted) setState(() { _visible = v; _order = o; });
  }

  Future<void> _loadWallet() async {
    try {
      final b = await MoneyApi.balance();
      if (!mounted) return;
      setState(() {
        _coins = (b['balance'] is num) ? (b['balance'] as num).toInt() : null;
        _walletLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _walletLoading = false);
    }
  }

  Future<void> _loadCalls() async {
    try {
      final list = await CallLogStore().load();
      if (!mounted) return;
      setState(() {
        _calls = list.take(4).toList();
        _callsLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _callsLoading = false);
    }
  }

  Future<void> _loadMessages() async {
    try {
      final rows = await Db.I.chatsOnce();
      final out = <_UnreadPreview>[];
      for (final r in rows) {
        if (r.json.isEmpty) continue;
        try {
          final m = jsonDecode(r.json) as Map<String, dynamic>;
          final u = (m['u'] as num?)?.toInt() ?? 0;
          if (u <= 0) continue;
          out.add(_UnreadPreview(
            (m['n'] ?? '').toString(),
            (m['pv'] ?? '').toString(),
            u,
          ));
        } catch (_) {/* skip a bad row */}
      }
      if (!mounted) return;
      setState(() {
        _unread = out.take(5).toList(); // rows already ts-desc from chatsOnce
        _messagesLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _messagesLoading = false);
    }
  }

  Future<void> _loadAnalytics() async {
    try {
      final startOfToday = _startOfTodaySeconds();
      final calls = await CallLogStore().load();
      final callsToday = calls.where((c) => c.ts >= startOfToday).length;
      final chats = await Db.I.chatsOnce();
      // "Messages today" = conversations with activity since local midnight (ts is
      // epoch seconds on the chat-list projection). Local-only, no server call.
      final msgsToday = chats.where((r) => r.ts >= startOfToday).length;
      if (!mounted) return;
      setState(() {
        _callsToday = callsToday;
        _messagesToday = msgsToday;
        _analyticsLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _analyticsLoading = false);
    }
  }

  Future<void> _loadAggregate() async {
    try {
      final data = await HomeCardsApi.fetch();
      if (!mounted) return;
      setState(() {
        _agg = data;
        _aggFailed = data == null;
        _aggLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() { _aggFailed = true; _aggLoading = false; });
    }
  }

  static int _startOfTodaySeconds() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day).millisecondsSinceEpoch ~/ 1000;
  }

  void _tap(String card) => Analytics.capture('shellv2_card_tap', {'card': card});

  /// Dark v2 replacement for the old ZineCardHead row: icon badge (ZineIconBadge
  /// kept as-is per the re-skin plan) + Nunito title + optional right caption.
  Widget _cardHead({
    required IconData icon,
    required String title,
    Color accent = AD.iconSearch,
    String? tag,
  }) {
    return Row(children: [
      ZineIconBadge(icon: icon, color: accent),
      const SizedBox(width: 11),
      Expanded(child: Text(title, style: ADText.threadName())),
      if (tag != null)
        Text(tag.toUpperCase(), style: ADText.statCaption(c: AD.textTertiary)),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final cards = <Widget>[];
    for (final id in _order) {
      if (_visible[id] == false) continue;
      switch (id) {
        case 'wallet':
          cards.add(_walletCard(context));
          break;
        case 'calllogs':
          cards.add(_callsCard(context));
          break;
        case 'messages':
          cards.add(_messagesCard(context));
          break;
        case 'analytics':
          cards.add(_analyticsCard(context));
          break;
        case 'earnings':
          cards.add(_earningsCard(context));
          break;
        case 'visitors':
          final w = _visitorsCard(context);
          if (w != null) cards.add(w); // eligibility: hidden when unavailable
          break;
        case 'listings':
          final w = _listingsCard(context);
          if (w != null) cards.add(w); // eligibility: hidden with no listings
          break;
      }
    }

    if (cards.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 36),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(icon: PhosphorIcons.squaresFour(PhosphorIconsStyle.bold), color: AD.primaryBadge, size: 52),
            const SizedBox(height: 14),
            Text('No cards on Home', textAlign: TextAlign.center, style: ADText.threadName().copyWith(fontSize: 17)),
            const SizedBox(height: 6),
            Text('Turn cards on from the menu → Cards.',
                textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13.5)),
          ]),
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      itemCount: cards.length,
      separatorBuilder: (_, __) => const SizedBox(height: 14),
      itemBuilder: (_, i) => cards[i],
    );
  }

  // ── Wallet card ─────────────────────────────────────────────────────────
  Widget _walletCard(BuildContext context) {
    return AdCard(
      radius: AD.rStatCard,
      onTap: () {
        _tap('wallet');
        openShellDestination(context, 'wallet');
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
            title: 'Wallet', accent: AD.online, tag: 'AVACOINS'),
        const SizedBox(height: 14),
        if (_walletLoading)
          _skeletonLine(120)
        else
          Text('${_coins ?? '—'}',
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w900,
                  fontSize: 34, color: AD.textPrimary)),
        const SizedBox(height: 4),
        Text('Tap to open your wallet',
            style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13)),
      ]),
    );
  }

  // ── Call logs card ──────────────────────────────────────────────────────
  Widget _callsCard(BuildContext context) {
    return AdCard(
      radius: AD.rStatCard,
      onTap: () {
        _tap('calllogs');
        ShellScope.of(context).switchRoot(RootId.avaTalk);
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
            title: 'Call logs', accent: AD.iconSearch),
        const SizedBox(height: 12),
        if (_callsLoading)
          _skeletonLine(180)
        else if (_calls.isEmpty)
          Text('No recent calls yet.',
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13.5))
        else
          ...[for (final c in _calls) _callRow(c)],
      ]),
    );
  }

  Widget _callRow(CallEntry c) {
    IconData icon;
    Color color;
    switch (c.dir) {
      case CallDir.incoming:
        icon = PhosphorIcons.phoneIncoming(PhosphorIconsStyle.bold);
        color = AD.online;
        break;
      case CallDir.outgoing:
        icon = PhosphorIcons.phoneOutgoing(PhosphorIconsStyle.bold);
        color = AD.iconSearch;
        break;
      case CallDir.missed:
        icon = PhosphorIcons.phoneX(PhosphorIconsStyle.bold);
        color = AD.danger;
        break;
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        PhosphorIcon(icon, size: 16, color: color),
        const SizedBox(width: 10),
        Expanded(
          child: Text(c.name.isEmpty ? 'Unknown' : c.name,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
        ),
        Text(c.timeLabel, style: ADText.statCaption(c: AD.textTertiary).copyWith(fontSize: 11)),
      ]),
    );
  }

  // ── Messages card (Talk-only; SMS is an explicit unavailable state) ──────
  Widget _messagesCard(BuildContext context) {
    return AdCard(
      radius: AD.rStatCard,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
            title: 'Messages', accent: AD.iconVideo),
        const SizedBox(height: 12),
        Row(children: [
          _msgChip('Talk', 0),
          const SizedBox(width: 8),
          _msgChip('SMS', 1),
        ]),
        const SizedBox(height: 12),
        if (_msgTab == 1)
          // Plan §3 correction: the in-network inbox is NOT carrier SMS, so the
          // SMS tab is an explicit unavailable state until the SMS role ships.
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text('SMS available once Ava is your SMS app.',
                style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13.5)),
          )
        else if (_messagesLoading)
          _skeletonLine(200)
        else if (_unread.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text('You are all caught up.',
                style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13.5)),
          )
        else
          ...[for (final m in _unread) _unreadRow(context, m)],
      ]),
    );
  }

  Widget _msgChip(String label, int tab) {
    final active = _msgTab == tab;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() => _msgTab = tab),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: active ? AD.primaryBadge : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: active ? AD.primaryBadge : AD.borderControl, width: 1),
        ),
        child: Text(label,
            style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
                fontSize: 12.5, color: active ? Colors.white : AD.textSecondary)),
      ),
    );
  }

  Widget _unreadRow(BuildContext context, _UnreadPreview m) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          _tap('messages');
          ShellScope.of(context).switchRoot(RootId.avaTalk);
        },
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(m.name.isEmpty ? 'Unknown' : m.name,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
              if (m.preview.isNotEmpty)
                Text(m.preview,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5)),
            ]),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: AD.unreadAccent,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Text('${m.count}',
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
                    fontSize: 11, color: Colors.white)),
          ),
        ]),
      ),
    );
  }

  // ── Analytics card (LOCAL stores only — plan §3 item 2, never PostHog) ────
  Widget _analyticsCard(BuildContext context) {
    return AdCard(
      radius: AD.rStatCard,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
            title: 'Analytics', accent: AD.iconSearch, tag: 'TODAY'),
        const SizedBox(height: 14),
        if (_analyticsLoading)
          _skeletonLine(160)
        else
          Row(children: [
            Expanded(child: _stat('Calls', '$_callsToday')),
            Expanded(child: _stat('Messages', '$_messagesToday')),
          ]),
      ]),
    );
  }

  Widget _stat(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w900,
                  fontSize: 30, color: AD.textPrimary)),
          const SizedBox(height: 2),
          Text(label, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5)),
        ],
      );

  // ── Earnings card (server aggregate + a tiny 7-day bar chart) ────────────
  Widget _earningsCard(BuildContext context) {
    final e = _agg?.earnings;
    return AdCard(
      radius: AD.rStatCard,
      onTap: () {
        _tap('earnings');
        openShellDestination(context, 'wallet');
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
            title: 'Earnings', accent: AD.online, tag: 'AVACOINS'),
        const SizedBox(height: 12),
        if (_aggLoading)
          _skeletonLine(200)
        else if (e == null)
          Text(_aggFailed ? 'Earnings are unavailable right now.' : 'No earnings yet.',
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13.5))
        else ...[
          Row(children: [
            Expanded(child: _stat('Today', '${e.today}')),
            Expanded(child: _stat('Week', '${e.week}')),
            Expanded(child: _stat('Month', '${e.month}')),
          ]),
          const SizedBox(height: 14),
          SizedBox(
            height: 44,
            child: CustomPaint(
              size: const Size(double.infinity, 44),
              painter: _MiniBarChartPainter(e.series7d, AD.online),
            ),
          ),
          const SizedBox(height: 4),
          Text('Last 7 days', style: ADText.statCaption(c: AD.textTertiary).copyWith(fontSize: 10.5)),
        ],
      ]),
    );
  }

  // ── Visitors card (server aggregate; hidden entirely when unavailable) ────
  Widget? _visitorsCard(BuildContext context) {
    if (_aggLoading) {
      return AdCard(
        radius: AD.rStatCard,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _cardHead(
              icon: PhosphorIcons.mapPin(PhosphorIconsStyle.bold),
              title: 'Visitors', accent: AD.danger),
          const SizedBox(height: 12),
          _skeletonLine(180),
        ]),
      );
    }
    final v = _agg?.visitors;
    if (v == null || !v.available) return null; // eligibility: hide when no data source
    return AdCard(
      radius: AD.rStatCard,
      onTap: () {
        _tap('visitors');
        openShellDestination(context, 'mylistings');
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.mapPin(PhosphorIconsStyle.bold),
            title: 'Visitors', accent: AD.danger, tag: '7 DAYS'),
        const SizedBox(height: 12),
        Text('${v.total7d}',
            style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w900,
                fontSize: 30, color: AD.textPrimary)),
        Text('listing views', style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5)),
        if (v.byCountry.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('TOP COUNTRIES', style: ADText.sectionLabel(c: AD.textTertiary)),
          const SizedBox(height: 4),
          ...[for (final g in v.byCountry.take(5)) _geoRow(g.label, g.views)],
        ],
        if (v.byCity.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text('TOP CITIES', style: ADText.sectionLabel(c: AD.textTertiary)),
          const SizedBox(height: 4),
          ...[for (final g in v.byCity.take(5)) _geoRow(g.label, g.views)],
        ],
      ]),
    );
  }

  Widget _geoRow(String label, int views) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Expanded(
            child: Text(label.isEmpty ? 'Unknown' : label,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.rowName().copyWith(fontSize: 13.5, fontWeight: FontWeight.w600)),
          ),
          Text('$views', style: ADText.statCaption(c: AD.textTertiary).copyWith(fontSize: 11)),
        ]),
      );

  // ── Listings card (server aggregate; hidden when the user has no listings) ─
  Widget? _listingsCard(BuildContext context) {
    if (_aggLoading) {
      return AdCard(
        radius: AD.rStatCard,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _cardHead(
              icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
              title: 'Listings', accent: AD.primaryBadge),
          const SizedBox(height: 12),
          _skeletonLine(180),
        ]),
      );
    }
    final list = _agg?.listings ?? const <ListingAgg>[];
    if (list.isEmpty) return null; // eligibility: only when the user has listings
    return AdCard(
      radius: AD.rStatCard,
      onTap: () {
        _tap('listings');
        openShellDestination(context, 'mylistings');
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _cardHead(
            icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
            title: 'Listings', accent: AD.primaryBadge, tag: 'TOP'),
        const SizedBox(height: 10),
        ...[for (final l in list.take(3)) _listingRow(l)],
      ]),
    );
  }

  Widget _listingRow(ListingAgg l) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(l.title.isEmpty ? 'Untitled listing' : l.title,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
              Text('${l.views7d} views · ${l.joinedCount} joined',
                  style: ADText.statCaption(c: AD.textTertiary).copyWith(fontSize: 10.5)),
            ]),
          ),
        ]),
      );

  Widget _skeletonLine(double width) => Container(
        width: width,
        height: 20,
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
      );
}

/// A tiny 7-bar chart drawn with [CustomPaint] — no chart dependency (plan §B).
/// Bars are normalised to the max value; a flat/zero series draws faint baselines.
class _MiniBarChartPainter extends CustomPainter {
  final List<int> values;
  final Color color;
  const _MiniBarChartPainter(this.values, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final n = values.isEmpty ? 7 : values.length;
    final maxV = values.isEmpty ? 0 : values.reduce((a, b) => a > b ? a : b);
    final gap = 6.0;
    final barW = (size.width - gap * (n - 1)) / n;
    final radius = Radius.circular(barW < 6 ? barW / 2 : 3);

    final barPaint = Paint()..color = color;
    final basePaint = Paint()..color = AD.textFaint;

    for (var i = 0; i < n; i++) {
      final v = i < values.length ? values[i] : 0;
      final x = i * (barW + gap);
      if (maxV <= 0) {
        // Flat baseline for an all-zero week.
        canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(x, size.height - 2, barW, 2), radius),
          basePaint,
        );
        continue;
      }
      final h = (v / maxV) * size.height;
      final top = size.height - (h < 2 ? 2 : h);
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(x, top, barW, size.height - top), radius),
        v > 0 ? barPaint : basePaint,
      );
    }
  }

  @override
  bool shouldRepaint(_MiniBarChartPainter old) =>
      old.values != values || old.color != color;
}
