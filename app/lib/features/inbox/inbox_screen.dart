import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/notifications_api.dart';
import '../../core/theme.dart';
import '../../core/verse_api.dart';
import '../../identity/identity.dart';
import '../avabrain/agent_inbox_screen.dart';
import '../avatok/chat_thread.dart';
import '../avatok/data.dart';
import '../booking/avabooking_screen.dart';
import '../wallet/wallet_screen.dart';

/// AvaInbox (Phase 8) — every message from anywhere in ONE list. A unified
/// VIEW over the existing InboxDO conversations (now tagged with `context`)
/// plus the system-notice feed (/api/notifications) and the AI-agent inbox.
/// No new message store; threads open in the existing messenger UI.
class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});
  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _Row {
  final String source;             // dm|event|channel|consult|system
  final String title, snippet;
  final int ts;
  final bool unread;
  final InboxConv? conv;           // null → system row
  final AppNotification? notice;
  _Row({required this.source, required this.title, required this.snippet, required this.ts, this.unread = false, this.conv, this.notice});
}

class _InboxScreenState extends State<InboxScreen> {
  static const _store = FlutterSecureStorage();
  static const _cacheKey = 'avainbox_cache_v1';        // per-account via scopedKey
  static final _listingTitles = <String, String>{};    // listingId → title (session cache)

  String _filter = 'all';
  List<_Row> _rows = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadCached().then((_) => _load());
  }

  // Per-account local cache → the list paints instantly on reopen.
  Future<void> _loadCached() async {
    try {
      final raw = await readScoped(_store, _cacheKey);
      if (raw == null || raw.isEmpty) return;
      final j = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      if (mounted && _rows.isEmpty) {
        setState(() {
          _rows = j.map((m) => _Row(
                source: (m['source'] ?? 'dm').toString(),
                title: (m['title'] ?? '').toString(),
                snippet: (m['snippet'] ?? '').toString(),
                ts: (m['ts'] as num?)?.toInt() ?? 0,
                unread: m['unread'] == true,
                conv: m['conv'] is Map ? InboxConv.fromJson((m['conv'] as Map).cast<String, dynamic>()) : null,
              )).toList();
          _loading = false;
        });
      }
    } catch (_) {/* cold start */}
  }

  Future<void> _load() async {
    final results = await Future.wait([
      VerseApi.conversations(),
      NotificationsApi.list(),
    ]);
    final convs = results[0] as List<InboxConv>;
    final notices = results[1] as List<AppNotification>;
    final my = AccountScope.id ?? '';

    final rows = <_Row>[
      for (final c in convs)
        _Row(
          source: c.source,
          title: c.title ?? _fallbackTitle(c, my),
          snippet: _contextLabel(c),
          ts: c.updatedAt,
          conv: c,
        ),
      for (final n in notices)
        _Row(source: 'system', title: n.title, snippet: n.body, ts: n.createdAt, unread: !n.read, notice: n),
    ]..sort((a, b) => b.ts.compareTo(a.ts));

    if (mounted) setState(() { _rows = rows; _loading = false; });
    _resolveEventTitles(convs);

    // Persist (per-account scoped — rulebook rule 1).
    try {
      await _store.write(key: scopedKey(_cacheKey), value: jsonEncode([
        for (final r in rows.take(100))
          {
            'source': r.source, 'title': r.title, 'snippet': r.snippet, 'ts': r.ts, 'unread': r.unread,
            if (r.conv != null) 'conv': {'id': r.conv!.id, 'kind': r.conv!.kind, 'title': r.conv!.title,
                'avatar_url': r.conv!.avatarUrl, 'context': r.conv!.context, 'updated_at': r.conv!.updatedAt},
          },
      ]));
    } catch (_) {/* best-effort */}
  }

  String _fallbackTitle(InboxConv c, String my) {
    if (c.kind == 'group') return 'Group chat';
    final peer = c.peerOf(my);
    return peer == null ? 'Conversation' : 'User ${peer.length > 10 ? peer.substring(peer.length - 6) : peer}';
  }

  String _contextLabel(InboxConv c) {
    final ctx = c.context ?? '';
    if (ctx.startsWith('event:')) {
      final lid = ctx.substring(6);
      return _listingTitles[lid] != null ? 'About: ${_listingTitles[lid]}' : 'Event inquiry';
    }
    if (ctx.startsWith('consult:')) return 'Consult thread';
    if (ctx.startsWith('channel:')) return 'Channel message';
    return c.kind == 'group' ? 'Group conversation' : 'Direct message';
  }

  /// Lazily resolve event names for "Event inquiry — <event name>" rows.
  Future<void> _resolveEventTitles(List<InboxConv> convs) async {
    final ids = convs
        .map((c) => c.context ?? '')
        .where((x) => x.startsWith('event:'))
        .map((x) => x.substring(6))
        .where((id) => !_listingTitles.containsKey(id))
        .toSet()
        .take(10);
    var changed = false;
    for (final id in ids) {
      final d = await ListingsApi.detail(id);
      if (d != null) { _listingTitles[id] = d.listing.title; changed = true; }
    }
    if (changed && mounted) setState(() {});
  }

  // ---- UI ---------------------------------------------------------------

  static const _chipDefs = [
    ('all', 'All', Icons.all_inbox),
    ('event', 'Events', Icons.event),
    ('channel', 'Channels', Icons.podcasts),
    ('consult', 'Consults', Icons.video_call_outlined),
    ('dm', 'DMs', Icons.chat_bubble_outline),
    ('system', 'System', Icons.notifications_none),
  ];

  static const _sourceColor = <String, Color>{
    'event': Color(0xFFF59E0B), 'channel': Color(0xFF8B5CF6), 'consult': Color(0xFF0EA5E9),
    'dm': AvaColors.brand, 'system': AvaColors.sub,
  };
  static const _sourceLabel = <String, String>{
    'event': 'Event inquiry', 'channel': 'Channel', 'consult': 'Consult', 'dm': 'DM', 'system': 'System',
  };

  @override
  Widget build(BuildContext context) {
    final shown = _filter == 'all' ? _rows : _rows.where((r) => r.source == _filter).toList();
    return Scaffold(
      appBar: AppBar(
        title: const Text('AvaInbox', style: TextStyle(fontWeight: FontWeight.w800)),
        backgroundColor: const Color(0xFF0EA5E9), foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'Agent inbox',
            icon: const Icon(Icons.smart_toy_outlined),
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AgentInboxScreen())),
          ),
        ],
      ),
      body: Column(children: [
        SizedBox(
          height: 52,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), children: [
            for (final c in _chipDefs)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  avatar: Icon(c.$3, size: 15),
                  label: Text(c.$2),
                  selected: _filter == c.$1,
                  onSelected: (_) => setState(() => _filter = c.$1),
                ),
              ),
          ]),
        ),
        const Divider(height: 1),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: shown.isEmpty
                      ? ListView(children: const [
                          SizedBox(height: 120),
                          Center(child: Text('Nothing here yet', style: TextStyle(color: AvaColors.sub))),
                        ])
                      : ListView.separated(
                          itemCount: shown.length,
                          separatorBuilder: (_, __) => const Divider(height: 1, indent: 72),
                          itemBuilder: (_, i) => _tile(shown[i]),
                        ),
                ),
        ),
      ]),
    );
  }

  Widget _tile(_Row r) {
    final color = _sourceColor[r.source] ?? AvaColors.sub;
    return ListTile(
      leading: r.conv != null
          ? Avatar(seed: r.conv!.id, name: r.title, size: 44, avatarUrl: r.conv!.avatarUrl)
          : CircleAvatar(backgroundColor: color.withValues(alpha: .14),
              child: Icon(r.notice != null ? _noticeIcon(r.notice!.type) : Icons.notifications_none, color: color, size: 20)),
      title: Row(children: [
        Expanded(child: Text(r.title, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: TextStyle(fontWeight: r.unread ? FontWeight.w800 : FontWeight.w600, fontSize: 14))),
        Text(_when(r.ts), style: const TextStyle(color: AvaColors.sub, fontSize: 11)),
      ]),
      subtitle: Row(children: [
        Container(
          margin: const EdgeInsets.only(right: 6, top: 2),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
          decoration: BoxDecoration(color: color.withValues(alpha: .12), borderRadius: BorderRadius.circular(8)),
          child: Text(_sourceLabel[r.source] ?? r.source,
              style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w800)),
        ),
        Expanded(child: Text(r.snippet, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12.5, color: AvaColors.sub))),
        if (r.unread)
          Container(width: 9, height: 9, decoration: const BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle)),
      ]),
      onTap: () => _open(r),
    );
  }

  IconData _noticeIcon(String type) => switch (type) {
        'wallet' || 'payment' => Icons.account_balance_wallet_outlined,
        'moderation' => Icons.shield_outlined,
        'social' => Icons.favorite_outline,
        'brain' => Icons.psychology_outlined,
        _ => Icons.notifications_none,
      };

  String _when(int ts) {
    if (ts <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return 'now';
    if (diff.inHours < 1) return '${diff.inMinutes}m';
    if (diff.inDays < 1) return '${diff.inHours}h';
    if (diff.inDays < 7) return '${diff.inDays}d';
    return '${d.day}/${d.month}';
  }

  void _open(_Row r) {
    final my = AccountScope.id ?? '';
    if (r.conv != null) {
      final c = r.conv!;
      final peer = c.peerOf(my);
      if (peer != null) {
        // Reuse the existing messenger thread UI — replies flow back through
        // the same InboxDO conversation (acceptance criterion).
        Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(
          chat: Chat(name: r.title, seed: peer, last: '', time: '', avatarUrl: c.avatarUrl ?? ''),
        )));
      } else if (c.kind == 'group') {
        Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(
          chat: Chat(name: r.title, seed: c.id, last: '', time: '', group: true, gid: c.id, avatarUrl: c.avatarUrl ?? ''),
        )));
      }
      return;
    }
    // System rows deep-link: refunds/settlements → wallet, booking changes → bookings.
    final n = r.notice;
    if (n != null) {
      NotificationsApi.markRead(ids: [n.id]);
      setState(() {});
      final link = (n.data['deeplink'] ?? '').toString();
      if (link.contains('wallet') || n.type == 'wallet' || n.type == 'payment') {
        Navigator.push(context, MaterialPageRoute(builder: (_) => const WalletScreen()));
      } else if (link.contains('booking')) {
        Navigator.push(context, MaterialPageRoute(builder: (_) => const AvaBookingScreen()));
      }
    }
  }
}
