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

  /// Set the hide flag. Returns true only when the value actually CHANGED, so a
  /// caller can apply/emit/log exactly once (an idempotent re-delivery is a no-op).
  Future<bool> set(String rumorId, bool hidden) async {
    if (rumorId.isEmpty) return false;
    final m = await load();
    if ((m[rumorId] ?? false) == hidden) return false;
    m[rumorId] = hidden;
    await DiskCache.write(_key, jsonEncode(m));
    return true;
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

/// Per-message HARD-DELETE flag for a delete-for-everyone RECEIVED from a peer.
/// Key: the message rumorId (= shared client_id); presence = tombstoned on this
/// device. Recorded by [SyncHub] the moment a {t:'del'|'gdel'} control is ingested
/// — even when no chat thread is open — so the deletion is DURABLE here and gets
/// re-applied on every cold open. This is the recipient-side parity to the owner's
/// [HiddenStore]: without it, a delete-for-everyone only redrew an OPEN thread, so
/// if the recipient's thread was closed when it arrived (or their local cache
/// already held the original), the message stayed visible after reopening.
class DeletedStore {
  static const _key = 'avatok_deleted_msgs';

  Future<Set<String>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as List).map((e) => e.toString()).toSet();
    } catch (_) {
      return {};
    }
  }

  /// Record a tombstone. Returns true only when it was NEWLY added (not already
  /// present) so callers can emit "delete applied" telemetry exactly once.
  Future<bool> add(String rumorId) async {
    if (rumorId.isEmpty) return false;
    final s = await load();
    if (!s.add(rumorId)) return false;
    await DiskCache.write(_key, jsonEncode(s.toList()));
    return true;
  }
}

/// [DELETE-CHAT-1 2026-08-17] Per-conversation "cleared up to here" cursor.
///
/// WHY THIS EXISTS. "Delete chat" in the thread menu was literally
/// `() => Navigator.pop(context)` — it closed the sheet and did nothing else. No
/// local wipe, no server call, no confirmation. So a chat the owner "deleted"
/// was never deleted, and `/api/msg/sync` re-materialised the whole backlog into
/// the local database on the next launch. That is the "old deleted messages come
/// back when I load the app" report.
///
/// A cursor rather than a row-by-row wipe, deliberately: sync WILL re-insert
/// those rows (the upsert in sync_hub has no delete check and never has), so
/// deleting them locally would only work until the next connection. A cursor is
/// applied at RENDER time, exactly like the existing `_deletedIds` tombstones, so
/// re-inserted rows stay invisible no matter how often they come back.
///
/// Values are timestamps in EPOCH SECONDS — matching `_Msg.ts` — and everything
/// at or before one is hidden.
///
/// [DELETE-CHAT-XDEV-1] Entries are written under BOTH the local convKey
/// ('1:<peerUid>' / 'g:<gid>') and the SERVER conv id, because the two halves of
/// this feature speak different namespaces: the thread screen knows the convKey,
/// while the server's `thread_clears` snapshot and its wake push are keyed by
/// server conv. Writing both and reading either avoids a lookup table and keeps
/// tel threads (which have no server conv) working. The cursor is monotonic, so
/// a duplicate write is harmless.
///
/// Monotonic: a stale value must never move the cursor backward and resurrect a
/// cleared thread.
class ThreadClearStore {
  static const _key = 'avatok_thread_clears';

  Future<Map<String, int>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map)
          .map((k, v) => MapEntry(k.toString(), (v as num).toInt()));
    } catch (_) {
      return {};
    }
  }

  /// Everything in [convKey] at or before [tsSec] is cleared. Never moves back.
  Future<void> clearThrough(String convKey, int tsSec) async {
    if (convKey.isEmpty || tsSec <= 0) return;
    final m = await load();
    if ((m[convKey] ?? 0) >= tsSec) return;
    m[convKey] = tsSec;
    await DiskCache.write(_key, jsonEncode(m));
  }

  Future<int> cursorFor(String convKey) async => (await load())[convKey] ?? 0;

  /// Monotonic bulk merge, for the `thread_clears` snapshot on every `/sync`.
  Future<void> mergeBulk(Map<String, int> updates) async {
    if (updates.isEmpty) return;
    final m = await load();
    var changed = false;
    updates.forEach((k, ts) {
      if (ts > 0 && (m[k] ?? 0) < ts) { m[k] = ts; changed = true; }
    });
    if (changed) await DiskCache.write(_key, jsonEncode(m));
  }

  /// [DELETE-CHAT-XDEV-1] Canonical message id → epoch SECONDS.
  ///
  /// `canonicalMsgId` (worker/src/util.ts) is
  /// `<createdMs zero-padded to 13>.<8 hex>` — zero-padded precisely so the ids
  /// sort chronologically as plain strings. The millisecond prefix is therefore
  /// a reliable timestamp, and this store compares in seconds like `_Msg.ts`.
  static int tsSecFromMid(String mid) {
    if (mid.length < 13) return 0;
    final ms = int.tryParse(mid.substring(0, 13)) ?? 0;
    return ms <= 0 ? 0 : ms ~/ 1000;
  }

  /// [DELETE-CHAT-XDEV-1] A cursor meaning "everything up to NOW is cleared".
  ///
  /// Not a fake message id — the server stores this value as a sortable
  /// HIGH-WATER MARK and only ever compares it (`MAX(cleared_through_mid, ?)`);
  /// it never dereferences it to a row. An upper bound for the current
  /// millisecond is exactly the right thing to send, and `ffffffff` is above
  /// every real suffix because those are lowercase hex.
  static String nowCursorMid() =>
      '${DateTime.now().millisecondsSinceEpoch.toString().padLeft(13, '0')}.ffffffff';
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
  /// [DELETE-CHAT-1 2026-08-17] Forget one conversation's preview.
  ///
  /// This store had `load()` and `record()` and no way to remove anything, so a
  /// cleared chat kept its old last-message subtitle in the chat list forever —
  /// the row the owner is actually looking at when he says the deleted chat is
  /// back. Clearing the thread has to clear its preview too.
  Future<void> remove(String key) async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return;
    try {
      final j = jsonDecode(raw) as Map;
      if (j.remove(key) == null) return;
      await DiskCache.write(_key, jsonEncode(j));
    } catch (_) {/* a corrupt preview blob is not worth throwing over */}
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

/// Last time a peer was seen online (unix seconds, as string) per conversation —
/// lets a 1:1 header show "last seen <time>" the moment a thread opens, before
/// any live presence frame arrives.
class LastSeenStore extends _KvMapStore {
  // [LASTSEEN-HONEST-1] v2 key: the v1 store was poisoned by fabricated "now"
  // timestamps (every roster-absent peer got stamped as seen on thread open).
  // The new key drops the lies; honest values repopulate from real presence.
  LastSeenStore() : super('avatok_lastseen_v2');
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
