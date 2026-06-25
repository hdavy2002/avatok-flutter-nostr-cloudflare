import 'dart:convert';

import 'disk_cache.dart';

// All chat-state caches below are BULK, non-secret, per-account data, stored as
// plain per-account files via [DiskCache] — NOT flutter_secure_storage. Secure
// storage's Android encryptedSharedPreferences backend is unreliable on some
// OEMs (notably Samsung): after a restart it can throw or return empty, which
// silently WIPED these caches every cold start (blank chat list + full relay
// re-sync). DiskCache scopes each file per Clerk account, so a parent and their
// children on one phone still keep separate read-state, flags, drafts, etc.

/// Per-conversation last-read timestamp (drives unread badges).
/// Key: '1:<peerHex>' for DMs, 'g:<gid>' for groups.
class ReadStateStore {
  static const _key = 'avatok_readstate';

  Future<Map<String, int>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), (v as num).toInt()));
    } catch (_) {
      return {};
    }
  }

  Future<void> setRead(String key, int ts) async {
    final m = await load();
    if ((m[key] ?? 0) < ts) {
      m[key] = ts;
      await DiskCache.write(_key, jsonEncode(m));
    }
  }

  /// Monotonic bulk merge — ONE load+write for many conversations. Use when
  /// seeding the server's read high-water marks on sync; calling [setRead] in a
  /// loop would race on the shared file (load-modify-write) and lose updates.
  Future<void> mergeBulk(Map<String, int> updates) async {
    if (updates.isEmpty) return;
    final m = await load();
    var changed = false;
    updates.forEach((k, ts) {
      if ((m[k] ?? 0) < ts) { m[k] = ts; changed = true; }
    });
    if (changed) await DiskCache.write(_key, jsonEncode(m));
  }
}

/// Per-message SOFT-DELETE flag, synced across MY devices via the InboxDO.
/// Key: the message rumorId (= shared client_id); value true = hidden (with Undo).
/// Populated from the server `hidden` column on /sync + the live 'hide' frame, so
/// a BRAND-NEW device shows my deleted messages as hidden even on a cold open —
/// no local-DB migration required.
class HiddenStore {
  static const _key = 'avatok_hidden_msgs';

  Future<Map<String, bool>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v == true));
    } catch (_) {
      return {};
    }
  }

  Future<void> set(String rumorId, bool hidden) async {
    if (rumorId.isEmpty) return;
    final m = await load();
    if ((m[rumorId] ?? false) == hidden) return;
    m[rumorId] = hidden;
    await DiskCache.write(_key, jsonEncode(m));
  }

  /// One load+write for many ids (use when seeding hidden flags from a full sync).
  Future<void> mergeBulk(Map<String, bool> updates) async {
    if (updates.isEmpty) return;
    final m = await load();
    var changed = false;
    updates.forEach((k, v) { if ((m[k] ?? false) != v) { m[k] = v; changed = true; } });
    if (changed) await DiskCache.write(_key, jsonEncode(m));
  }
}

/// Per-conversation last-message preview: a short snippet of the most recent
/// line, its timestamp, and whether I sent it. Drives the chat-list subtitle and
/// recency ordering. Key: '1:<peerHex>' for DMs, 'g:<gid>' for groups.
class ChatPreviewStore {
  static const _key = 'avatok_previews';

  Future<Map<String, ({String text, int ts, bool me})>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      final j = jsonDecode(raw) as Map;
      return j.map((k, v) {
        final m = (v as Map);
        return MapEntry(k.toString(), (
          text: (m['t'] ?? '').toString(),
          ts: (m['ts'] as num?)?.toInt() ?? 0,
          me: m['me'] == true,
        ));
      });
    } catch (_) {
      return {};
    }
  }

  /// Record [text] as the latest line for [convKey]. Out-of-order relay replays
  /// (older events arriving after newer ones) never clobber a fresher preview.
  Future<void> record(String convKey, String text, int ts, bool me) async {
    if (text.isEmpty) return;
    final raw = await DiskCache.read(_key);
    Map<String, dynamic> j = {};
    if (raw != null && raw.isNotEmpty) {
      try { j = (jsonDecode(raw) as Map).cast<String, dynamic>(); } catch (_) {}
    }
    final cur = j[convKey];
    final curTs = cur is Map ? ((cur['ts'] as num?)?.toInt() ?? 0) : 0;
    if (ts < curTs) return;
    j[convKey] = {'t': text, 'ts': ts, 'me': me};
    await DiskCache.write(_key, jsonEncode(j));
  }
}

/// Per-conversation PEER receipt high-water marks for MY messages: the newest
/// message timestamp the peer has had DELIVERED to their device, and READ.
/// Persisted so the WhatsApp-style ticks survive app restarts and backfill when
/// receipts arrive while a thread is closed. Key: '1:<peerHex>'.
class ReceiptStore {
  static const _key = 'avatok_receipts';

  Future<({int delivered, int read})> get(String convKey) async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return (delivered: 0, read: 0);
    try {
      final v = (jsonDecode(raw) as Map)[convKey];
      if (v is Map) {
        return (delivered: (v['d'] as num?)?.toInt() ?? 0, read: (v['r'] as num?)?.toInt() ?? 0);
      }
    } catch (_) {}
    return (delivered: 0, read: 0);
  }

  /// Merge a high-water mark — monotonic (never goes backwards); a 'read' ts also
  /// implies 'delivered'. Returns the merged (delivered, read).
  Future<({int delivered, int read})> bump(String convKey, {int delivered = 0, int read = 0}) async {
    final raw = await DiskCache.read(_key);
    Map<String, dynamic> j = {};
    if (raw != null && raw.isNotEmpty) {
      try { j = (jsonDecode(raw) as Map).cast<String, dynamic>(); } catch (_) {}
    }
    final cur = j[convKey] is Map ? (j[convKey] as Map) : const {};
    final curD = (cur['d'] as num?)?.toInt() ?? 0;
    final curR = (cur['r'] as num?)?.toInt() ?? 0;
    final newR = read > curR ? read : curR;
    var newD = delivered > curD ? delivered : curD;
    if (newR > newD) newD = newR; // read implies delivered
    if (newD == curD && newR == curR) return (delivered: curD, read: curR);
    j[convKey] = {'d': newD, 'r': newR};
    await DiskCache.write(_key, jsonEncode(j));
    return (delivered: newD, read: newR);
  }
}

/// Block / archive / mute / pin flags, each a set of conversation keys.
class ChatFlagsStore {
  static const _key = 'avatok_chatflags';

  Future<Map<String, Set<String>>> load() async {
    final raw = await DiskCache.read(_key);
    final out = {'blocked': <String>{}, 'archived': <String>{}, 'muted': <String>{}, 'pinned': <String>{}};
    if (raw == null || raw.isEmpty) return out;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      for (final k in out.keys) {
        out[k] = ((j[k] as List?) ?? []).map((e) => e.toString()).toSet();
      }
    } catch (_) {/* defaults */}
    return out;
  }

  Future<void> toggle(String flag, String key) async {
    final m = await load();
    final set = m[flag]!;
    set.contains(key) ? set.remove(key) : set.add(key);
    await _save(m);
  }

  Future<void> _save(Map<String, Set<String>> m) =>
      DiskCache.write(_key, jsonEncode(m.map((k, v) => MapEntry(k, v.toList()))));
}

/// Per-conversation key → value string maps (drafts, disappear timers, pinned).
class _KvMapStore {
  final String _key;
  _KvMapStore(this._key);

  Future<Map<String, String>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v.toString()));
    } catch (_) {
      return {};
    }
  }

  Future<void> set(String key, String? value) async {
    final m = await load();
    if (value == null || value.isEmpty) {
      m.remove(key);
    } else {
      m[key] = value;
    }
    await DiskCache.write(_key, jsonEncode(m));
  }
}

/// Unsent draft text per conversation.
class DraftStore extends _KvMapStore {
  DraftStore() : super('avatok_drafts');
}

/// Disappearing-message timer (seconds, as string) per conversation. '' = off.
class ChatTimerStore extends _KvMapStore {
  ChatTimerStore() : super('avatok_timers');
}

/// Pinned message (JSON {id,text}) per conversation.
class PinnedMsgStore extends _KvMapStore {
  PinnedMsgStore() : super('avatok_pinned');
}

/// Wallpaper preset id per conversation; key 'global' is the default.
class WallpaperStore extends _KvMapStore {
  WallpaperStore() : super('avatok_wallpaper');
}

/// Starred (bookmarked) message ids.
class StarStore {
  static const _key = 'avatok_stars';

  Future<Set<String>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as List).map((e) => e.toString()).toSet();
    } catch (_) {
      return {};
    }
  }

  Future<Set<String>> toggle(String id) async {
    final set = await load();
    set.contains(id) ? set.remove(id) : set.add(id);
    await DiskCache.write(_key, jsonEncode(set.toList()));
    return set;
  }
}
