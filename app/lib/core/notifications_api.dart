import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_auth.dart';
import 'config.dart';
import 'disk_cache.dart';

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

  /// [NOTIF-CACHE-1] Round-trips through [NotificationsApi.cached]. Key names are
  /// deliberately the SERVER's wire names (`created_at`, not `createdAt`) so a
  /// cached blob and a fresh API payload both parse via [fromJson] — one shape,
  /// one parser, no drift.
  Map<String, dynamic> toJson() => {
        'id': id,
        'type': type,
        'title': title,
        'body': body,
        'data': data,
        'read': read,
        'created_at': createdAt,
      };
}

/// Client for the in-app notification feed (`/api/notifications`). Dual-auth via
/// [ApiAuth]. Realtime arrives separately over the relay socket (NostrClient.notifications).
class NotificationsApi {
  /// [NOTIF-CACHE-1] Local cache of the FIRST page, so reopening the feed paints
  /// instantly (and still shows something offline) instead of spinning on the
  /// network every time — owner report 2026-07-15 ("these notifications are not
  /// cached locally"). DiskCache is already keyed on AccountScope.id, so a parent
  /// and child on one phone never see each other's feed.
  static const _kCache = 'avatok_notifications_p1';

  /// Server-side retention. Mirrors NOTIF_TTL_MS in worker/src/routes/
  /// notifications.ts — the cache must expire on the SAME rule, or a stale entry
  /// would resurrect notifications the server has already purged.
  static const Duration ttl = Duration(hours: 24);

  /// Cached first page — newest first, already TTL-filtered. `[]` when cold.
  static Future<List<AppNotification>> cached() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return [];
      final cutoff = DateTime.now().millisecondsSinceEpoch - ttl.inMilliseconds;
      return (jsonDecode(raw) as List<dynamic>)
          .whereType<Map>()
          .map((m) => AppNotification.fromJson(m.map((k, v) => MapEntry('$k', v))))
          .where((n) => n.createdAt >= cutoff)
          .toList();
    } catch (_) {
      return [];
    }
  }

  static Future<void> _writeCache(List<AppNotification> items) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(items.map((e) => e.toJson()).toList()));
    } catch (_) {/* cache is an optimisation — never fail the caller */}
  }

  /// Drop the cached page (used by "Clear all").
  static Future<void> clearCache() async {
    try { await DiskCache.write(_kCache, jsonEncode(const [])); } catch (_) {}
  }

  /// Paginated feed (newest first). Pass the last item's createdAt as [cursor] to page.
  /// The FIRST page (cursor == null) is written to the local cache on success.
  static Future<List<AppNotification>> list({int? cursor}) async {
    final url = cursor == null ? kNotificationsUrl : '$kNotificationsUrl?cursor=$cursor';
    final res = await ApiAuth.getSigned(url);
    if (res.statusCode != 200) return [];
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final items = ((j['items'] as List?) ?? const [])
        .map((e) => AppNotification.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
    if (cursor == null) await _writeCache(items);
    return items;
  }

  /// [NOTIF-CLEAR-1] Delete every notification for this account, server + cache.
  static Future<bool> clearAll() async {
    final res = await ApiAuth.deleteSigned(kNotificationsUrl);
    final ok = res.statusCode == 200;
    // Clear locally even if the server call failed: the user asked for an empty
    // feed, and the next successful list() re-syncs the truth anyway.
    await clearCache();
    return ok;
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
