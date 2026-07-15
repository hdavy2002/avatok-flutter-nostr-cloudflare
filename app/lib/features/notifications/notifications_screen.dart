import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/notifications_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';

/// In-app notification feed (wallet, moderation, briefings, social).
/// Pass [realtime] (NostrClient.notifications) to prepend live notifications as
/// they arrive over the already-open relay socket.
class NotificationsScreen extends StatefulWidget {
  final Stream<Map<String, dynamic>>? realtime;
  const NotificationsScreen({super.key, this.realtime});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final List<AppNotification> _items = [];
  StreamSubscription? _sub;
  bool _loading = true;
  // [NOTIF-LAZY-1] Pagination state. The API has always accepted a `cursor` (the
  // last item's created_at) and returned 30 rows a page — this screen just never
  // used it, so it only ever showed the newest 30 and silently pretended that was
  // the whole feed. `_end` latches when a short page comes back.
  final _scroll = ScrollController();
  bool _paging = false;
  bool _end = false;

  @override
  void initState() {
    super.initState();
    _boot();
    _scroll.addListener(_maybePage);
    _sub = widget.realtime?.listen((m) {
      if (!mounted) return;
      setState(() => _items.insert(0, AppNotification.fromJson(m)));
    });
  }

  /// [NOTIF-CACHE-1] Paint the cached page FIRST, then refresh from the network.
  /// The feed used to open on a spinner every single time, even though its
  /// contents rarely change between opens (owner report 2026-07-15).
  Future<void> _boot() async {
    final cached = await NotificationsApi.cached();
    if (!mounted) return;
    if (cached.isNotEmpty) {
      setState(() { _items..clear()..addAll(cached); _loading = false; });
    }
    await _load();
  }

  Future<void> _load() async {
    final list = await NotificationsApi.list();
    if (!mounted) return;
    setState(() {
      _items..clear()..addAll(list);
      _loading = false;
      // A fresh first page invalidates any paging we'd already done.
      _end = list.length < 30;
    });
    // Opening the feed clears the unread badge.
    NotificationsApi.markRead(all: true);
  }

  /// [NOTIF-LAZY-1] Fetch the next page when the user nears the bottom.
  void _maybePage() {
    if (!_scroll.hasClients || _paging || _end || _loading) return;
    if (_scroll.position.pixels < _scroll.position.maxScrollExtent - 400) return;
    _pageIn();
  }

  Future<void> _pageIn() async {
    if (_paging || _end || _items.isEmpty) return;
    _paging = true;
    try {
      final next = await NotificationsApi.list(cursor: _items.last.createdAt);
      if (!mounted) return;
      setState(() {
        // De-dupe on id: a realtime insert or a row landing exactly on the cursor
        // boundary can otherwise appear twice.
        final seen = _items.map((e) => e.id).toSet();
        _items.addAll(next.where((n) => !seen.contains(n.id)));
        if (next.length < 30) _end = true;
      });
    } finally {
      _paging = false;
    }
  }

  /// [NOTIF-CLEAR-1] "Clear all" — deletes server-side + drops the local cache.
  Future<void> _clearAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.card,
        title: Text('Clear all notifications?',
            style: ADText.rowName().copyWith(fontSize: 16.5)),
        content: Text('This removes every notification from this feed. It can\'t be undone.',
            style: ADText.preview(c: AD.textSecondary)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ADText.rowName(c: AD.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Clear all', style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final n = _items.length;
    setState(() { _items.clear(); _end = true; });
    final done = await NotificationsApi.clearAll();
    Analytics.capture('notifications_cleared', {'count': n, 'server_ok': done});
    if (!done && mounted) {
      // Be honest: the list is empty locally, but the server still holds them and
      // the next refresh will bring them back. Silently "succeeding" here is how
      // you get a bug report that says "clear all doesn't work".
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Couldn't reach the server — pull to refresh to retry.")),
      );
    }
  }

  @override
  void dispose() { _scroll.dispose(); _sub?.cancel(); super.dispose(); }

  /// Phosphor icon + zine accent per notification type (accent rotation §6).
  (IconData, Color) _meta(String type) {
    switch (type) {
      case 'wallet':
      case 'payment': return (PhosphorIcons.wallet(PhosphorIconsStyle.bold), AD.online);
      case 'moderation': return (PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), AD.danger);
      case 'brain': return (PhosphorIcons.sparkle(PhosphorIconsStyle.bold), AD.iconVideo);
      case 'social': return (PhosphorIcons.usersThree(PhosphorIconsStyle.bold), AD.iconSearch);
      case 'group_invite': return (PhosphorIcons.usersThree(PhosphorIconsStyle.fill), AD.iconSearch);
      default: return (PhosphorIcons.bell(PhosphorIconsStyle.bold), AD.primaryBadge);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(76),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 18, 10),
              child: Row(children: [
                AdBackButton(onTap: () => Navigator.of(context).maybePop()),
                const SizedBox(width: 6),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text.rich(
                        TextSpan(children: [
                          const TextSpan(text: 'Notif'),
                          const TextSpan(text: 'ications',
                              style: TextStyle(color: AD.primaryBadge)),
                        ]),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.appTitle().copyWith(fontSize: 22, height: 1.08),
                      ),
                      Text('WHAT HAPPENED', style: ADText.sectionLabel()),
                    ],
                  ),
                ),
                // [NOTIF-CLEAR-1] Only offered when there's something to clear.
                if (_items.isNotEmpty)
                  TextButton(
                    onPressed: _clearAll,
                    child: Text('Clear all', style: ADText.rowName(c: AD.danger)),
                  ),
              ]),
            ),
          ),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        color: AD.iconSearch,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
            : _items.isEmpty
                ? ListView(children: [
                    const SizedBox(height: 120),
                    Center(
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Container(
                          width: 64, height: 64,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(AD.rListCard),
                            border: Border.all(color: AD.borderControl, width: 1),
                          ),
                          child: Icon(PhosphorIcons.bell(PhosphorIconsStyle.bold),
                              size: 30, color: AD.textTertiary),
                        ),
                        const SizedBox(height: 12),
                        Text('All caught up',
                            style: ADText.preview(c: AD.textSecondary),
                            textAlign: TextAlign.center),
                      ]),
                    ),
                  ])
                : ListView.separated(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
                    // [NOTIF-LAZY-1] +1 for the paging spinner / end-of-feed cap.
                    itemCount: _items.length + 1,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (_, i) {
                      if (i == _items.length) {
                        if (_end) return const SizedBox(height: 8);
                        return const Padding(
                          padding: EdgeInsets.symmetric(vertical: 18),
                          child: Center(
                            child: SizedBox(
                              width: 18, height: 18,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2, color: AD.iconSearch),
                            ),
                          ),
                        );
                      }
                      final n = _items[i];
                      final (icon, accent) = _meta(n.type);
                      return AdCard(
                        radius: AD.rListCard,
                        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
                        boxShadow: const [],
                        // A group invite taps back to the messenger — the Groups
                        // tab badge points the user at the new group.
                        onTap: n.type == 'group_invite' ? () => Navigator.of(context).maybePop() : null,
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          ZineIconBadge(icon: icon, color: accent, size: 36),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(n.title, style: ADText.rowName().copyWith(fontSize: 14.5)),
                              if (n.body.isNotEmpty) ...[
                                const SizedBox(height: 2),
                                Text(n.body, style: ADText.preview().copyWith(fontSize: 12.5)),
                              ],
                            ]),
                          ),
                          if (!n.read) ...[
                            const SizedBox(width: 8),
                            Container(
                              width: 11, height: 11,
                              margin: const EdgeInsets.only(top: 4),
                              decoration: const BoxDecoration(
                                shape: BoxShape.circle,
                                color: AD.unreadAccent,
                                border: Border.fromBorderSide(BorderSide(color: AD.card, width: 2)),
                              ),
                            ),
                          ],
                        ]),
                      );
                    },
                  ),
      ),
    );
  }
}
