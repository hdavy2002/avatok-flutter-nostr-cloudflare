import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_auth.dart';
import 'config.dart';

/// A single in-app notification (system/transactional — not chat).
class AppNotification {
  final String id;
  final String type;     // wallet|system|moderation|social|brain|payment
  final String title;
  final String body;
  final Map<String, dynamic> data;
  final bool read;
  final int createdAt;   // epoch ms
  AppNotification({required this.id, required this.type, required this.title, required this.body, required this.data, required this.read, required this.createdAt});

  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
        id: (j['id'] ?? '').toString(),
        type: (j['type'] ?? 'system').toString(),
        title: (j['title'] ?? '').toString(),
        body: (j['body'] ?? '').toString(),
        data: (j['data'] is Map) ? (j['data'] as Map).cast<String, dynamic>() : <String, dynamic>{},
        read: j['read'] == true || j['read'] == 1,
        createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
      );
}

/// Client for the in-app notification feed (`/api/notifications`). Dual-auth via
/// [ApiAuth]. Realtime arrives separately over the relay socket (NostrClient.notifications).
class NotificationsApi {
  /// Paginated feed (newest first). Pass the last item's createdAt as [cursor] to page.
  static Future<List<AppNotification>> list({int? cursor}) async {
    final url = cursor == null ? kNotificationsUrl : '$kNotificationsUrl?cursor=$cursor';
    final res = await ApiAuth.getSigned(url);
    if (res.statusCode != 200) return [];
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return ((j['items'] as List?) ?? const [])
        .map((e) => AppNotification.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  /// Count of unread notifications (for the bell badge).
  static Future<int> unreadCount() async {
    final res = await ApiAuth.getSigned('$kNotificationsUrl/unread');
    if (res.statusCode != 200) return 0;
    return ((jsonDecode(res.body) as Map<String, dynamic>)['unread'] as num?)?.toInt() ?? 0;
  }

  /// Mark specific ids (or all) read.
  static Future<void> markRead({List<String>? ids, bool all = false}) async {
    await ApiAuth.postJson('$kNotificationsUrl/read', all ? {'all': true} : {'ids': ids ?? const <String>[]});
  }
}
