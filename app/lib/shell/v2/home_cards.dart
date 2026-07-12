import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/call_log_store.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../shell_v2.dart';
import 'home_cards_store.dart';
import 'shell_destinations.dart';

/// The Home v1 dashboard body (plan §3): a scrollable column of cards, each
/// toggleable per-account (see [HomeCardPrefs]). v1 ships THREE cards —
/// Wallet, Call logs, Messages (Talk-only; SMS shows an explicit unavailable
/// state until the SMS role lands in Phase 3).
///
/// Data sources are the existing local stores/APIs (no new endpoints in Phase 1):
/// wallet balance (MoneyApi), recent calls (CallLogStore), unread messages (the
/// persisted chat-list projection Db.chatsOnce). Each card fires
/// `shellv2_card_tap {card}` on interaction.
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

  int? _coins;
  bool _walletLoading = true;

  List<CallEntry> _calls = const [];
  bool _callsLoading = true;

  List<_UnreadPreview> _unread = const [];
  bool _messagesLoading = true;

  int _msgTab = 0; // 0 = Talk, 1 = SMS

  @override
  void initState() {
    super.initState();
    HomeCardPrefs.revision.addListener(_reloadPrefs);
    _reloadPrefs();
    _loadWallet();
    _loadCalls();
    _loadMessages();
  }

  @override
  void dispose() {
    HomeCardPrefs.revision.removeListener(_reloadPrefs);
    super.dispose();
  }

  Future<void> _reloadPrefs() async {
    final v = await HomeCardPrefs.load();
    if (mounted) setState(() => _visible = v);
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

  void _tap(String card) => Analytics.capture('shellv2_card_tap', {'card': card});

  @override
  Widget build(BuildContext context) {
    final cards = <Widget>[];
    for (final id in HomeCardPrefs.ids) {
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
      }
    }

    if (cards.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 36),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(icon: PhosphorIcons.squaresFour(PhosphorIconsStyle.bold), color: Zine.lime, size: 52),
            const SizedBox(height: 14),
            Text('No cards on Home', textAlign: TextAlign.center, style: ZineText.cardTitle(size: 17)),
            const SizedBox(height: 6),
            Text('Turn cards on from the menu → Cards.',
                textAlign: TextAlign.center, style: ZineText.sub(size: 13.5)),
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
    return ZineCard(
      onTap: () {
        _tap('wallet');
        openShellDestination(context, 'wallet');
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineCardHead(
            icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
            title: 'Wallet', accent: Zine.mint, tag: 'AVACOINS'),
        const SizedBox(height: 14),
        if (_walletLoading)
          _skeletonLine(120)
        else
          Text('${_coins ?? '—'}', style: ZineText.stat(size: 34)),
        const SizedBox(height: 4),
        Text('Tap to open your wallet', style: ZineText.sub(size: 13)),
      ]),
    );
  }

  // ── Call logs card ──────────────────────────────────────────────────────
  Widget _callsCard(BuildContext context) {
    return ZineCard(
      onTap: () {
        _tap('calllogs');
        ShellScope.of(context).switchRoot(RootId.avaTalk);
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineCardHead(
            icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
            title: 'Call logs', accent: Zine.blue),
        const SizedBox(height: 12),
        if (_callsLoading)
          _skeletonLine(180)
        else if (_calls.isEmpty)
          Text('No recent calls yet.', style: ZineText.sub(size: 13.5))
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
        color = Zine.mintInk;
        break;
      case CallDir.outgoing:
        icon = PhosphorIcons.phoneOutgoing(PhosphorIconsStyle.bold);
        color = Zine.blueInk;
        break;
      case CallDir.missed:
        icon = PhosphorIcons.phoneX(PhosphorIconsStyle.bold);
        color = Zine.coral;
        break;
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        PhosphorIcon(icon, size: 16, color: color),
        const SizedBox(width: 10),
        Expanded(
          child: Text(c.name.isEmpty ? 'Unknown' : c.name,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 14)),
        ),
        Text(c.timeLabel, style: ZineText.tag(size: 11, color: Zine.inkSoft)),
      ]),
    );
  }

  // ── Messages card (Talk-only; SMS is an explicit unavailable state) ──────
  Widget _messagesCard(BuildContext context) {
    return ZineCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineCardHead(
            icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
            title: 'Messages', accent: Zine.lilac),
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
                style: ZineText.sub(size: 13.5)),
          )
        else if (_messagesLoading)
          _skeletonLine(200)
        else if (_unread.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text('You are all caught up.', style: ZineText.sub(size: 13.5)),
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
          color: active ? Zine.lime : Zine.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: active ? Zine.shadowXs : const <BoxShadow>[],
        ),
        child: Text(label, style: ZineText.tag(size: 12.5, color: Zine.ink)),
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
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 14)),
              if (m.preview.isNotEmpty)
                Text(m.preview,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
            ]),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: Zine.coral,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: Zine.ink, width: Zine.bw),
            ),
            child: Text('${m.count}', style: ZineText.tag(size: 11, color: Colors.white)),
          ),
        ]),
      ),
    );
  }

  Widget _skeletonLine(double width) => Container(
        width: width,
        height: 20,
        decoration: BoxDecoration(
          color: Zine.paper2,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Zine.inkMute, width: 1),
        ),
      );
}
