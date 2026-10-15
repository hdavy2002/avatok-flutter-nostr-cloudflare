import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../explore/widgets/browse_motion.dart';
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
  int _epoch = 0;

  /// HF-MOTION-B: ids already shown, so a row slides in only the first time it appears (not when it is
  /// scrolled back into view or the list is refreshed).
  final Set<String> _seen = <String>{};

  String? get _uid {
    final session = ref.read(sessionProvider);
    return session.isSignedIn ? session.user?.id ?? session.me?.uid : null;
  }

  bool _owns(String? uid, int epoch) =>
      mounted && uid != null && uid == _uid && epoch == _epoch;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final uid = _uid;
    final epoch = ++_epoch;
    if (uid == null) return;
    try {
      final api = ref.read(notificationsApiProvider);
      final items = await api.list();
      if (!_owns(uid, epoch)) return;
      setState(() {
        _items = items;
        _error = null;
      });
      if (items.any((item) => !item.read)) {
        if (!_owns(uid, epoch)) return;
        await api.markAllRead();
        if (!_owns(uid, epoch)) return;
      }
      ref.invalidate(unreadNotificationsProvider);
    } on ApiError catch (error) {
      if (_owns(uid, epoch)) setState(() => _error = error);
    }
  }

  Future<void> _clear() async {
    if (_clearing) return;
    setState(() => _clearing = true);
    final uid = _uid;
    final epoch = ++_epoch;
    if (uid == null) {
      if (mounted) setState(() => _clearing = false);
      return;
    }
    try {
      await ref.read(notificationsApiProvider).clear();
      if (!_owns(uid, epoch)) return;
      setState(() {
        _items = const <AppNotification>[];
        _clearing = false;
      });
      ref.invalidate(unreadNotificationsProvider);
    } on ApiError catch (error) {
      if (!_owns(uid, epoch)) return;
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
    body: RefreshIndicator(
      onRefresh: _load,
      color: HfColors.deepOrange,
      backgroundColor: HfColors.butter,
      child: _body(),
    ),
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
        final rowKey = item.id.isEmpty ? 'row-$index' : item.id;
        final fresh = _seen.add(rowKey);
        return RiseIn(
          key: ValueKey<String>('notification-$rowKey'),
          index: index,
          animate: fresh,
          child: Card(
            child: ListTile(
              leading: _NotificationIcon(read: item.read),
              title: Text(item.title.isEmpty ? 'Update' : item.title),
              subtitle: Text(item.body),
              trailing: actionable ? const Icon(Icons.chevron_right_rounded) : null,
              onTap: actionable ? () => _open(item) : null,
            ),
          ),
        );
      },
    );
  }
}

/// The bell; an unread one wears a pulsing orange dot (still with reduced motion).
class _NotificationIcon extends StatelessWidget {
  const _NotificationIcon({required this.read});

  final bool read;

  @override
  Widget build(BuildContext context) {
    final bell = Icon(
      read ? Icons.notifications_none_rounded : Icons.notifications_rounded,
    );
    if (read) return bell;
    return SizedBox(
      width: 32,
      height: 32,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          bell,
          const Positioned(
            top: -6,
            right: -8,
            child: PulseDot(
              key: ValueKey<String>('unread-pulse'),
              color: HfColors.deepOrange,
              size: 9,
              semanticLabel: 'Unread',
            ),
          ),
        ],
      ),
    );
  }
}
