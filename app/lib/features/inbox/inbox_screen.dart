import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/avatar.dart';
import '../../core/commercial_notification.dart';
import '../../core/listings_api.dart';
import '../../core/notifications_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verse_api.dart';
import '../../identity/identity.dart';
import '../avabrain/agent_inbox_screen.dart';
import '../avatok/chat_thread.dart';
import '../avatok/data.dart';
import '../booking/avabooking_screen.dart';
import '../booking/commercial_customer_screens.dart';
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
  static const _store = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), );
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
    ('all', 'All'),
    ('event', 'Events'),
    ('channel', 'Channels'),
    ('consult', 'Consults'),
    ('dm', 'DMs'),
    ('system', 'System'),
  ];

  // Accent per source. Each entry is a dark-mode avatar FAMILY, not a single
  // colour, because the source tag needs a fill AND a legible ink: the old code
  // painted dark `Zine.ink` text on a pale poster fill, which on the dark
  // surface would have been white-ish text on a bright pastel. `chipBg` is the
  // dark fill, `chipInk` the light ink that goes on it, `solid` the saturated
  // variant for the filled icon badge (which takes white).
  static final _sourceFamily = <String, AvatarFamily>{
    'event': AD.familyByName('mint'),
    'channel': AD.familyByName('lilac'),
    'consult': AD.familyByName('sky'),
    'dm': AD.familyByName('aqua'),
    'system': AD.familyByName('terra'),
  };
  static const _sourceLabel = <String, String>{
    'event': 'Event', 'channel': 'Channel', 'consult': 'Consult', 'dm': 'DM', 'system': 'System',
  };

  @override
  Widget build(BuildContext context) {
    final shown = _filter == 'all' ? _rows : _rows.where((r) => r.source == _filter).toList();
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: 'AvaInbox',
        markWord: 'Inbox',
        tag: 'every message · one list',
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.robot(PhosphorIconsStyle.regular),
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AgentInboxScreen())),
          ),
        ],
      ),
      body: Column(children: [
        SizedBox(
          height: 56,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2), children: [
            for (final c in _chipDefs)
              Padding(
                padding: const EdgeInsets.only(right: Msg.s2),
                child: ZineChip(
                  label: c.$2,
                  active: _filter == c.$1,
                  onTap: () => setState(() => _filter = c.$1),
                ),
              ),
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: Msg.accent))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: Msg.accent,
                  backgroundColor: AD.card,
                  child: shown.isEmpty
                      ? ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
                          const SizedBox(height: 120),
                          Center(child: ZineEmptyState(
                              icon: PhosphorIcons.tray(PhosphorIconsStyle.regular),
                              text: 'All caught up')),
                        ])
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s1, Msg.s4, Msg.s5),
                          itemCount: shown.length,
                          separatorBuilder: (_, __) => const SizedBox(height: Msg.s3),
                          itemBuilder: (_, i) => _tile(shown[i]),
                        ),
                ),
        ),
      ]),
    );
  }

  Widget _tile(_Row r) {
    final fam = _sourceFamily[r.source] ?? AD.familyByName('sky');
    return ZinePressable(
      onTap: () => _open(r),
      radius: Msg.brLg,
      boxShadow: Msg.none,
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
        if (r.conv != null)
          Container(
            decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: AD.borderControl, width: 1)),
            child: Avatar(seed: r.conv!.id, name: r.title, size: 42, avatarUrl: r.conv!.avatarUrl),
          )
        else
          ZineIconBadge(
            icon: r.notice != null ? _noticeIcon(r.notice!.type) : PhosphorIcons.bell(PhosphorIconsStyle.regular),
            color: fam.solid,
            size: 42,
          ),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(children: [
              Expanded(child: Text(r.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName().copyWith(
                      fontSize: 15,
                      fontWeight: r.unread ? FontWeight.w700 : FontWeight.w600))),
              const SizedBox(width: Msg.s2),
              Text(_when(r.ts), style: ADText.timestamp()),
            ]),
            const SizedBox(height: Msg.s1),
            Row(children: [
              Container(
                margin: const EdgeInsets.only(right: Msg.s2),
                padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 2),
                decoration: BoxDecoration(
                  // Dark chip fill + its matching light ink — the pair is
                  // designed together, so the label can never collapse into
                  // the fill the way ink-on-poster-colour did.
                  color: fam.chipBg,
                  borderRadius: Msg.brPill,
                  border: Border.all(color: AD.borderHairline, width: 1),
                ),
                child: Text(_sourceLabel[r.source] ?? r.source,
                    style: ADText.statCaption(c: fam.chipInk).copyWith(fontSize: 10)),
              ),
              Expanded(child: Text(r.snippet, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.preview().copyWith(fontSize: 13))),
              if (r.unread)
                Container(
                  margin: const EdgeInsets.only(left: Msg.s2),
                  width: 10, height: 10,
                  decoration: const BoxDecoration(
                    color: Msg.accent, shape: BoxShape.circle,
                  ),
                ),
            ]),
          ]),
        ),
      ]),
    );
  }

  IconData _noticeIcon(String type) => switch (type) {
        'wallet' || 'payment' => PhosphorIcons.wallet(PhosphorIconsStyle.regular),
        'moderation' => PhosphorIcons.shieldCheck(PhosphorIconsStyle.regular),
        'social' => PhosphorIcons.heart(PhosphorIconsStyle.regular),
        'brain' => PhosphorIcons.brain(PhosphorIconsStyle.regular),
        _ => PhosphorIcons.bell(PhosphorIconsStyle.regular),
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
      final commercial = CommercialNotificationPayload.fromData(n.data);
      if (commercial != null) {
        Navigator.push(context, MaterialPageRoute(
          builder: (_) => MySessionsScreen(
            focusListingId: commercial.listingId,
            focusBookingId: commercial.bookingId,
          ),
        ));
      } else if (link.contains('wallet') || n.type == 'wallet' || n.type == 'payment') {
        Navigator.push(context, MaterialPageRoute(builder: (_) => const WalletScreen()));
      } else if (link.contains('booking')) {
        Navigator.push(context, MaterialPageRoute(builder: (_) => const AvaBookingScreen()));
      }
    }
  }
}
