import 'dart:convert';

import 'api_auth.dart';
import 'ava_contracts.dart';
import 'ava_log.dart';
import 'config.dart';
import 'disk_cache.dart';

/// Persists AvaChat (talk-to-Ava) conversations: a local copy (DiskCache, per
/// account) for instant offline access + a cloud backup in Cloudflare D1 (so
/// history survives a new device). Best-effort — never throws to the caller.
class ChatHistoryService {
  ChatHistoryService._();
  static final ChatHistoryService I = ChatHistoryService._();

  static String _url(String path) {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin$path';
  }

  String _localKey(String sessionId) => 'avachat_$sessionId';

  /// Save a session locally + to D1. [messages] is `[{role:'user'|'ava', text}]`.
  Future<void> save(String sessionId, String persona, List<Map<String, String>> messages) async {
    if (messages.isEmpty) return;
    final title = (messages.first['text'] ?? '').trim();
    final payload = {'persona': persona, 'title': title, 'messages': messages};
    // local first (instant, offline-safe)
    try { await DiskCache.write(_localKey(sessionId), jsonEncode(payload)); } catch (_) {}
    // cloud backup (best-effort)
    try {
      await ApiAuth.postJson(_url(AvaApi.chatHistory),
          {'sessionId': sessionId, ...payload}, timeout: const Duration(seconds: 15));
    } catch (e) {
      AvaLog.I.log('avachat', 'history D1 save failed: $e');
    }
  }

  /// Load a session's messages from the local copy (null if none).
  Future<List<Map<String, String>>?> loadLocal(String sessionId) async {
    try {
      final raw = await DiskCache.read(_localKey(sessionId));
      if (raw == null || raw.isEmpty) return null;
      final j = jsonDecode(raw) as Map<String, dynamic>;
      final msgs = (j['messages'] as List?) ?? const [];
      return msgs.map((e) => (e as Map).map((k, v) => MapEntry(k.toString(), v.toString()))).toList();
    } catch (_) {
      return null;
    }
  }
}
