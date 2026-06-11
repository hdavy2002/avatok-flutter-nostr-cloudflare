import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/notifications_api.dart';
import '../../core/ui/zine.dart';
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

  @override
  void initState() {
    super.initState();
    _load();
    _sub = widget.realtime?.listen((m) {
      if (!mounted) return;
      setState(() => _items.insert(0, AppNotification.fromJson(m)));
    });
  }

  Future<void> _load() async {
    final list = await NotificationsApi.list();
    if (!mounted) return;
    setState(() { _items..clear()..addAll(list); _loading = false; });
    // Opening the feed clears the unread badge.
    NotificationsApi.markRead(all: true);
  }

  @override
  void dispose() { _sub?.cancel(); super.dispose(); }

  /// Phosphor icon + zine accent per notification type (accent rotation §6).
  (IconData, Color) _meta(String type) {
    switch (type) {
      case 'wallet':
      case 'payment': return (PhosphorIcons.wallet(PhosphorIconsStyle.bold), Zine.mint);
      case 'moderation': return (PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), Zine.coral);
      case 'brain': return (PhosphorIcons.sparkle(PhosphorIconsStyle.bold), Zine.lilac);
      case 'social': return (PhosphorIcons.usersThree(PhosphorIconsStyle.bold), Zine.blue);
      default: return (PhosphorIcons.bell(PhosphorIconsStyle.bold), Zine.lime);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Notifications', markWord: 'Notif', tag: 'what happened'),
      body: RefreshIndicator(
        onRefresh: _load,
        color: Zine.blueInk,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
            : _items.isEmpty
                ? ListView(children: [
                    const SizedBox(height: 120),
                    Center(
                      child: ZineEmptyState(
                        icon: PhosphorIcons.bell(PhosphorIconsStyle.bold),
                        text: 'All caught up',
                      ),
                    ),
                  ])
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
                    itemCount: _items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (_, i) {
                      final n = _items[i];
                      final (icon, accent) = _meta(n.type);
                      return ZineCard(
                        radius: Zine.rSm,
                        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
                        boxShadow: Zine.shadowXs,
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          ZineIconBadge(icon: icon, color: accent, size: 36),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(n.title, style: ZineText.value(size: 14.5)),
                              if (n.body.isNotEmpty) ...[
                                const SizedBox(height: 2),
                                Text(n.body, style: ZineText.sub(size: 12.5)),
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
                                color: Zine.coral,
                                border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: 2)),
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
