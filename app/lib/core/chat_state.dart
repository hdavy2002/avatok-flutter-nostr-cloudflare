import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

// All keys below are wrapped in scopedKey(...) so each Clerk account on the same
// device (e.g. a parent and their children) keeps its OWN read-state, flags,
// drafts, timers, pins, wallpaper and stars. See account_storage.dart.
FlutterSecureStorage _store() => const FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true),
    );

/// Per-conversation last-read timestamp (drives unread badges).
/// Key: '1:<peerHex>' for DMs, 'g:<gid>' for groups.
class ReadStateStore {
  static const _key = 'avatok_readstate';
  final _s = _store();

  Future<Map<String, int>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
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
      await _s.write(key: scopedKey(_key), value: jsonEncode(m));
    }
  }
}

/// Per-conversation last-message preview: a short snippet of the most recent
/// line, its timestamp, and whether I sent it. Drives the chat-list subtitle
/// (the "Say hi" placeholder is only used when a conversation has no messages
/// yet) and recency ordering. Account-scoped like everything else here.
/// Key: '1:<peerHex>' for DMs, 'g:<gid>' for groups.
class ChatPreviewStore {
  static const _key = 'avatok_previews';
  final _s = _store();

  Future<Map<String, ({String text, int ts, bool me})>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
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
    final raw = await _s.read(key: scopedKey(_key));
    Map<String, dynamic> j = {};
    if (raw != null && raw.isNotEmpty) {
      try { j = (jsonDecode(raw) as Map).cast<String, dynamic>(); } catch (_) {}
    }
    final cur = j[convKey];
    final curTs = cur is Map ? ((cur['ts'] as num?)?.toInt() ?? 0) : 0;
    if (ts < curTs) return;
    j[convKey] = {'t': text, 'ts': ts, 'me': me};
    await _s.write(key: scopedKey(_key), value: jsonEncode(j));
  }
}

/// Block / archive / mute / pin flags, each a set of conversation keys.
class ChatFlagsStore {
  static const _key = 'avatok_chatflags';
  final _s = _store();

  Future<Map<String, Set<String>>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
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
      _s.write(key: scopedKey(_key), value: jsonEncode(m.map((k, v) => MapEntry(k, v.toList()))));
}

/// Per-conversation key → value string maps (drafts, disappear timers, pinned).
class _KvMapStore {
  final String _key;
  final _s = _store();
  _KvMapStore(this._key);

  Future<Map<String, String>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
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
    await _s.write(key: scopedKey(_key), value: jsonEncode(m));
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
  final _s = _store();

  Future<Set<String>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
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
    await _s.write(key: scopedKey(_key), value: jsonEncode(set.toList()));
    return set;
  }
}
