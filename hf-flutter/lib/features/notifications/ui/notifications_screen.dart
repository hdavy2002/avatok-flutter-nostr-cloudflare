import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/notifications_api.dart';

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  List<AppNotification>? _items;
  ApiError? _error;
  bool _clearing = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final api = ref.read(notificationsApiProvider);
      final items = await api.list();
      if (!mounted) return;
      setState(() {
        _items = items;
        _error = null;
      });
      if (items.any((item) => !item.read)) await api.markAllRead();
      ref.invalidate(unreadNotificationsProvider);
    } on ApiError catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Future<void> _clear() async {
    if (_clearing) return;
    setState(() => _clearing = true);
    try {
      await ref.read(notificationsApiProvider).clear();
      if (!mounted) return;
      setState(() {
        _items = const <AppNotification>[];
        _clearing = false;
      });
      ref.invalidate(unreadNotificationsProvider);
    } on ApiError catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _clearing = false;
      });
    }
  }

  void _open(AppNotification item) {
    final path = item.path;
    if (path != null && Routes.isSafeNext(path)) context.go(path);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: const HfBackButton(),
      title: const Text('Notifications'),
      actions: [
        if ((_items?.isNotEmpty ?? false))
          TextButton(
            onPressed: _clearing ? null : _clear,
            child: Text(_clearing ? 'Clearing…' : 'Clear all'),
          ),
      ],
    ),
    body: RefreshIndicator(onRefresh: _load, child: _body()),
  );

  Widget _body() {
    if (_error != null && _items == null) {
      return ListView(children: [ErrorPanel(error: _error, onRetry: _load)]);
    }
    final items = _items;
    if (items == null) {
      return const LoadingPanel(message: 'Loading notifications…');
    }
    if (items.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 120),
          EmptyPanel(
            message: 'No notifications right now.',
            icon: Icons.notifications_none_rounded,
          ),
        ],
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(HfSpacing.page),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: HfSpacing.sm),
      itemBuilder: (context, index) {
        final item = items[index];
        final actionable = item.path != null && Routes.isSafeNext(item.path!);
        return Card(
          child: ListTile(
            leading: Icon(
              item.read ? Icons.notifications_none_rounded : Icons.notifications_rounded,
            ),
            title: Text(item.title.isEmpty ? 'Update' : item.title),
            subtitle: Text(item.body),
            trailing: actionable ? const Icon(Icons.chevron_right_rounded) : null,
            onTap: actionable ? () => _open(item) : null,
          ),
        );
      },
    );
  }
}
