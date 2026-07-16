import 'dart:convert';

import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';

/// Per-account "heard" marker for Inbox voicemail/receptionist cards (Specs/
/// PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md, Lane D). A card is
/// marked heard the first time PLAY is pressed on it (never just on thread
/// open) — see `_VoicemailCardState._togglePlay` in inbox_thread_screen.dart.
///
/// Stored via [DiskCache], which is already per-account scoped internally
/// (`cache/<AccountScope.id>/…`, see core/disk_cache.dart) — same idiom as
/// [BlockList]/[ContactOverrides] elsewhere in this feature, so a parent +
/// child account sharing one phone each get their own heard-state.
///
/// Key format: the JSON blob is a flat list of [InboxCard.stableId] strings
/// (the row's real `client_id`, falling back to the sync-cursor row id for
/// any legacy row without one — see `InboxCard.stableId`).
class InboxHeardStore {
  InboxHeardStore._();
  static final InboxHeardStore I = InboxHeardStore._();

  static const _kCache = 'avadial_inbox_heard';

  Future<Set<String>> _load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return {};
      return (jsonDecode(raw) as List<dynamic>).map((e) => '$e').toSet();
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox heard-store load failed: $e');
      return {};
    }
  }

  Future<void> _save(Set<String> ids) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(ids.toList()));
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox heard-store save failed: $e');
    }
  }

  /// Every heard card id — used by the list screen to decide whether a
  /// thread still has unheard audio (keeps its unread accent even after the
  /// server-side "read" cursor has advanced).
  Future<Set<String>> loadAll() => _load();

  Future<bool> isHeard(String id) async => (await _load()).contains(id);

  /// Marks [id] heard. No-op (skips the write) if already marked.
  Future<void> markHeard(String id) async {
    if (id.isEmpty) return;
    final ids = await _load();
    if (ids.add(id)) await _save(ids);
  }
}
