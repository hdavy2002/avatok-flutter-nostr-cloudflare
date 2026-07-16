import 'dart:convert';

import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';

/// [AVAINBOX-1] Per-voicemail user metadata: a renamed TITLE for the
/// recording itself (distinct from "Rename caller", which renames the
/// PERSON) and free-text TAGS (owner spec pic3: "the bubbles inside the VM
/// thread do not have all the right click menu items, like ... edit, ...
/// tag ...").
///
/// Keyed by [InboxCard.stableId] (same stable id the heard-store uses — see
/// inbox_heard_store.dart), per-account via [DiskCache] (same idiom as
/// [ContactOverrides]/[BlockList] elsewhere in this feature — DiskCache is
/// already namespaced to `AccountScope.id`, so a parent + child account
/// sharing one phone each keep their own tags/titles).
///
/// Tags are also fed to AvaBrain (see `InboxBrainIngest` in
/// inbox_thread_screen.dart) so "find the voicemail I tagged X" can work —
/// this store is the single source of truth for that text.
class InboxCardMeta {
  final String? title;
  final List<String> tags;
  const InboxCardMeta({this.title, this.tags = const []});

  bool get isEmpty => (title == null || title!.trim().isEmpty) && tags.isEmpty;

  InboxCardMeta copyWith({String? title, bool clearTitle = false, List<String>? tags}) =>
      InboxCardMeta(
        title: clearTitle ? null : (title ?? this.title),
        tags: tags ?? this.tags,
      );

  Map<String, dynamic> toJson() => {
        if (title != null && title!.trim().isNotEmpty) 'title': title,
        if (tags.isNotEmpty) 'tags': tags,
      };

  factory InboxCardMeta.fromJson(Map<String, dynamic> j) {
    final t = (j['title'] as String?)?.trim();
    return InboxCardMeta(
      title: (t == null || t.isEmpty) ? null : t,
      tags: (j['tags'] as List<dynamic>? ?? const [])
          .map((e) => e.toString())
          .where((s) => s.trim().isNotEmpty)
          .toList(),
    );
  }
}

class InboxCardMetaStore {
  InboxCardMetaStore._();
  static final InboxCardMetaStore I = InboxCardMetaStore._();

  static const _kCache = 'avadial_inbox_card_meta';

  Future<Map<String, InboxCardMeta>> _load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return {};
      final m = jsonDecode(raw) as Map<String, dynamic>;
      return m.map((k, v) => MapEntry(
          k, InboxCardMeta.fromJson((v as Map).map((k2, v2) => MapEntry('$k2', v2)))));
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox card-meta load failed: $e');
      return {};
    }
  }

  Future<void> _save(Map<String, InboxCardMeta> m) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(m.map((k, v) => MapEntry(k, v.toJson()))));
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox card-meta save failed: $e');
    }
  }

  Future<InboxCardMeta?> forCard(String stableId) async => (await _load())[stableId];

  /// Every stored meta — used by the AvaBrain ingest pass so tags/titles ride
  /// along in the descriptor text.
  Future<Map<String, InboxCardMeta>> all() => _load();

  /// Set (or clear, when [title] is null/empty) the voicemail's own title.
  /// Preserves any existing tags. Distinct from `ContactOverrides.setName`
  /// (renames the CALLER, not the recording).
  Future<void> setTitle(String stableId, String? title) async {
    final m = await _load();
    final existing = m[stableId] ?? const InboxCardMeta();
    final t = title?.trim();
    final next = existing.copyWith(title: (t == null || t.isEmpty) ? null : t, clearTitle: t == null || t.isEmpty);
    if (next.isEmpty) {
      m.remove(stableId);
    } else {
      m[stableId] = next;
    }
    await _save(m);
  }

  /// Replace the full tag list for [stableId].
  Future<void> setTags(String stableId, List<String> tags) async {
    final m = await _load();
    final existing = m[stableId] ?? const InboxCardMeta();
    final cleaned = tags.map((t) => t.trim()).where((t) => t.isNotEmpty).toSet().toList();
    final next = existing.copyWith(tags: cleaned);
    if (next.isEmpty) {
      m.remove(stableId);
    } else {
      m[stableId] = next;
    }
    await _save(m);
  }
}

/// [AVAINBOX-1] Best-effort "already fed to AvaBrain" marker per card —
/// mirrors `inbox_heard_store.dart`'s shape exactly (a flat id set) so a
/// re-open of the same thread doesn't re-ingest the same transcript into the
/// user's AI Search store on every visit. Per-account via [DiskCache].
class InboxBrainIngestStore {
  InboxBrainIngestStore._();
  static final InboxBrainIngestStore I = InboxBrainIngestStore._();

  static const _kCache = 'avadial_inbox_brain_ingested';

  Future<Set<String>> _load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return {};
      return (jsonDecode(raw) as List<dynamic>).map((e) => '$e').toSet();
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox brain-ingest store load failed: $e');
      return {};
    }
  }

  Future<void> _save(Set<String> ids) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(ids.toList()));
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox brain-ingest store save failed: $e');
    }
  }

  Future<bool> isIngested(String stableId) async => (await _load()).contains(stableId);

  Future<void> markIngested(String stableId) async {
    if (stableId.isEmpty) return;
    final ids = await _load();
    if (ids.add(stableId)) await _save(ids);
  }
}
