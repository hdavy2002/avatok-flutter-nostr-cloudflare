import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

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
                    padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
                    itemCount: _items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (_, i) {
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
