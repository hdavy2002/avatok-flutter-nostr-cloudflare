import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_client.dart';
import '../../../core/auth/session.dart';

class AppNotification {
  const AppNotification({
    required this.id,
    required this.title,
    required this.body,
    required this.read,
    required this.createdAt,
    this.path,
  });

  final String id;
  final String title;
  final String body;
  final bool read;
  final DateTime createdAt;
  final String? path;

  factory AppNotification.fromJson(Map<String, dynamic> json) {
    final data = json['data'] is Map
        ? Map<String, dynamic>.from(json['data'] as Map)
        : const <String, dynamic>{};
    final rawPath = '${data['path'] ?? ''}'.trim();
    final millis = (json['created_at'] as num?)?.toInt() ?? 0;
    return AppNotification(
      id: '${json['id'] ?? ''}',
      title: '${json['title'] ?? ''}'.trim(),
      body: '${json['body'] ?? ''}'.trim(),
      read: json['read'] == true,
      createdAt: DateTime.fromMillisecondsSinceEpoch(millis),
      path: rawPath.isEmpty ? null : rawPath,
    );
  }
}

class NotificationsApi {
  const NotificationsApi(this._api);
  final ApiClient _api;

  Future<List<AppNotification>> list() async {
    final json = await _api.getJson('/api/notifications');
    final raw = json['items'];
    if (raw is! List) return const <AppNotification>[];
    return [
      for (final item in raw)
        if (item is Map)
          AppNotification.fromJson(Map<String, dynamic>.from(item)),
    ];
  }

  Future<int> unread() async {
    final json = await _api.getJson('/api/notifications/unread');
    return (json['unread'] as num?)?.toInt() ?? 0;
  }

  Future<void> markAllRead() async {
    await _api.postJson('/api/notifications/read', body: {'all': true});
  }

  Future<void> clear() async {
    await _api.deleteJson('/api/notifications');
  }
}

final notificationsApiProvider = Provider<NotificationsApi>(
  (ref) => NotificationsApi(ref.watch(apiClientProvider)),
);

final unreadNotificationsProvider = FutureProvider.autoDispose<int>((ref) {
  final uid = ref.watch(
    sessionProvider.select(
      (value) => value.isSignedIn ? value.user?.id ?? value.me?.uid : null,
    ),
  );
  if (uid == null || uid.isEmpty) {
    return 0;
  }
  return ref.watch(notificationsApiProvider).unread();
});
