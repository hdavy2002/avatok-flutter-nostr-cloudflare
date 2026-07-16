import 'dart:convert';

import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';
import 'inbox_api.dart';

/// [AVA-INBOX-READSTATE] Per-account cache of the last-fetched AvaDial Inbox
/// thread list, so the Inbox renders INSTANTLY from disk on open and refreshes
/// from the network in the background — no full-screen spinner on the frequent
/// resume/reconnect (telemetry showed 176 `inbox_resume_reconnect` events in 3
/// days, so a blank-then-spin on every reconnect was a constant papercut).
///
/// Stored via [DiskCache], which is already namespaced to `AccountScope.id`
/// (`cache/<scope>/…`, see core/disk_cache.dart) — the SAME per-account idiom
/// as [InboxHeardStore]/[InboxCardMetaStore] in this feature, so a parent + a
/// child account sharing one phone never see each other's inbox. Never a raw
/// global key (per the mandatory per-account-scoping rule).
class InboxThreadCache {
  InboxThreadCache._();
  static final InboxThreadCache I = InboxThreadCache._();

  static const _kCache = 'avadial_inbox_threads';

  /// Returns the last-persisted thread list, or null when nothing is cached
  /// yet / the blob is unreadable. Threads that somehow deserialized with no
  /// cards are dropped (InboxThread.latest reads `cards.last`).
  Future<List<InboxThread>?> load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! List) return null;
      final out = decoded
          .whereType<Map>()
          .map((m) => InboxThread.fromJson(m.cast<String, dynamic>()))
          .where((t) => t.cards.isNotEmpty)
          .toList();
      return out;
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox thread-cache load failed: $e');
      return null;
    }
  }

  Future<void> save(List<InboxThread> threads) async {
    try {
      await DiskCache.write(
          _kCache, jsonEncode(threads.map((t) => t.toJson()).toList()));
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox thread-cache save failed: $e');
    }
  }
}
