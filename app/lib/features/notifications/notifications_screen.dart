import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/notifications_api.dart';

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

  IconData _icon(String type) {
    switch (type) {
      case 'wallet':
      case 'payment': return Icons.account_balance_wallet_outlined;
      case 'moderation': return Icons.gpp_maybe_outlined;
      case 'brain': return Icons.auto_awesome_outlined;
      case 'social': return Icons.people_outline;
      default: return Icons.notifications_none;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Notifications')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _items.isEmpty
                ? ListView(children: const [SizedBox(height: 120), Center(child: Text("You're all caught up"))])
                : ListView.separated(
                    itemCount: _items.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final n = _items[i];
                      return ListTile(
                        leading: Icon(_icon(n.type)),
                        title: Text(n.title),
                        subtitle: n.body.isEmpty ? null : Text(n.body),
                        trailing: n.read ? null : const Icon(Icons.circle, size: 10, color: Colors.blue),
                      );
                    },
                  ),
      ),
    );
  }
}
