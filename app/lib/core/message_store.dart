import 'dart:convert';

import 'disk_cache.dart';

/// Local cache of a chat's messages, keyed by conversation key ('1:<peerHex>'
/// or 'g:<groupId>'). Stored as a plain per-account file via [DiskCache] (NOT
/// flutter_secure_storage, whose Android backend is unreliable on some OEMs and
/// was wiping this cache on restart → the chat re-downloaded its whole history
/// from the relay every open).
///
/// We persist a compact JSON view: text, media ENVELOPES (refs/keys only — the
/// decrypted bytes live in MediaService's on-disk cache), location/contact/poll/
/// sticker cards and their metadata. Capped to the most recent [_cap] messages.
class MessageStore {
  static const _prefix = 'avatok_msgs_';
  static const _cap = 300;

  String _name(String convKey) => '$_prefix$convKey';

  Future<List<Map<String, dynamic>>> load(String convKey) async {
    final raw = await DiskCache.read(_name(convKey));
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = jsonDecode(raw) as List;
      return list
          .map((e) => (e as Map).cast<String, dynamic>())
          // Defensive: a receipt is a control-message, never a bubble. An older
          // build cached some as raw JSON ({"t":"receipt",...}); drop them so they
          // don't reappear as grey JSON messages after the user updates.
          .where((m) => !(m['text'] ?? '').toString().contains('"t":"receipt"'))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> save(String convKey, List<Map<String, dynamic>> msgs) async {
    final capped = msgs.length > _cap ? msgs.sublist(msgs.length - _cap) : msgs;
    await DiskCache.write(_name(convKey), jsonEncode(capped));
  }

  Future<void> clear(String convKey) => DiskCache.delete(_name(convKey));

  // STREAM G [GROUP-AI-5] inline-translate cache. One small per-account file maps
  // '<msgId>|<lang>' → translated text, so a re-translate of the same bubble into
  // the same language is free (no network). DiskCache is already account-scoped.
  static const _trFile = 'avatok_translations';

  Future<Map<String, String>> _trAll() async {
    final raw = await DiskCache.read(_trFile);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v.toString()));
    } catch (_) {
      return {};
    }
  }

  Future<String?> readTranslation(String msgId, String lang) async {
    if (msgId.isEmpty) return null;
    final all = await _trAll();
    return all['$msgId|$lang'];
  }

  Future<void> writeTranslation(String msgId, String lang, String text) async {
    if (msgId.isEmpty || text.isEmpty) return;
    final all = await _trAll();
    all['$msgId|$lang'] = text;
    // Bound the cache so it can't grow unbounded on a very chatty account.
    if (all.length > 800) {
      final trimmed = Map<String, String>.fromEntries(all.entries.skip(all.length - 800));
      await DiskCache.write(_trFile, jsonEncode(trimmed));
    } else {
      await DiskCache.write(_trFile, jsonEncode(all));
    }
  }

  // Voice-note TRANSCRIPT cache. One small per-account file maps '<msgId>' →
  // the Whisper transcript of that voice note, so re-opening a thread never
  // re-transcribes an already-transcribed note (no network, no cost). DiskCache
  // is already account-scoped (a parent + each child on one phone keep separate
  // files), satisfying the per-account-scoping rule. Translations of a transcript
  // reuse the SAME translation cache above ('<msgId>|<lang>').
  static const _stFile = 'avatok_transcripts';

  Future<Map<String, String>> _stAll() async {
    final raw = await DiskCache.read(_stFile);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v.toString()));
    } catch (_) {
      return {};
    }
  }

  Future<String?> readTranscript(String msgId) async {
    if (msgId.isEmpty) return null;
    final all = await _stAll();
    return all[msgId];
  }

  Future<void> writeTranscript(String msgId, String text) async {
    if (msgId.isEmpty || text.isEmpty) return;
    final all = await _stAll();
    all[msgId] = text;
    if (all.length > 800) {
      final trimmed = Map<String, String>.fromEntries(all.entries.skip(all.length - 800));
      await DiskCache.write(_stFile, jsonEncode(trimmed));
    } else {
      await DiskCache.write(_stFile, jsonEncode(all));
    }
  }
}

/// F3 (restoreV2): per-conversation cache of DEEP-ARCHIVE pages fetched from
/// `GET /api/archive/page`. Two jobs, both keyed per conversation and stored via
/// [DiskCache] (already per-account scoped — a parent and each child on one phone
/// keep separate files):
///
///   1. Remember the pager CURSOR (`next_before`, an InboxDO row id) so scrolling
///      past the hot window fetches each older page at MOST once, ever — even
///      across app restarts. `done == true` means the archive is exhausted.
///   2. Cache the fetched message ROWS (the server's `{id,conv,sender,kind,body,
///      media_ref,client_id,created_at}` envelopes — bodies/refs only, never
///      media bytes) so the older history repaints instantly on reopen without a
///      second network round-trip.
///
/// Stored shape: `{"cursor": <int?>, "done": <bool>, "rows": [ …server rows… ]}`.
/// `cursor == null && rows empty && done == false` ⇒ nothing paged yet (start
/// from the newest segment, i.e. before = MAX id).
class ArchivePageStore {
  static const _prefix = 'avatok_archive_';
  static const _rowCap = 1500; // keep the on-disk archive bounded

  String _name(String convKey) => '$_prefix$convKey';

  Future<Map<String, dynamic>> load(String convKey) async {
    final raw = await DiskCache.read(_name(convKey));
    if (raw == null || raw.isEmpty) {
      return <String, dynamic>{'cursor': null, 'done': false, 'rows': const []};
    }
    try {
      final m = (jsonDecode(raw) as Map).cast<String, dynamic>();
      return <String, dynamic>{
        'cursor': (m['cursor'] as num?)?.toInt(),
        'done': m['done'] == true,
        'rows': (m['rows'] as List? ?? const [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList(),
      };
    } catch (_) {
      return <String, dynamic>{'cursor': null, 'done': false, 'rows': const []};
    }
  }

  /// Persist a newly-fetched page: advance the cursor, mark [done] when the
  /// archive is exhausted, and APPEND the page's rows (oldest kept, capped).
  Future<void> appendPage(
      String convKey, {
      required List<Map<String, dynamic>> newRows,
      required int? nextBefore,
      required bool done}) async {
    final cur = await load(convKey);
    final rows = <Map<String, dynamic>>[
      ...newRows,
      ...(cur['rows'] as List).cast<Map<String, dynamic>>(),
    ];
    // Bound the cache: keep the newest [_rowCap] archived rows (rows ascend to
    // oldest as we page back, so trim from the tail).
    final capped = rows.length > _rowCap ? rows.sublist(0, _rowCap) : rows;
    await DiskCache.write(
        _name(convKey),
        jsonEncode(<String, dynamic>{
          'cursor': nextBefore,
          'done': done,
          'rows': capped,
        }));
  }

  Future<void> clear(String convKey) => DiskCache.delete(_name(convKey));
}

/// F6: per-account persistence of received `safety_flag` frames, keyed by
/// `msg_id` (the flagged message's client id). The InboxDO pushes
/// `{type:'safety_flag', conv, msg_id, category}` to the recipient; we persist it
/// here so the flagged bubble stays red across reopens, and so "This is fine"
/// (local dismiss) survives too. Stored via [DiskCache] (per-account scoped).
///
/// Shape on disk: `{ "<msg_id>": {"conv":.., "category":.., "dismissed":bool} }`.
class SafetyFlagStore {
  static const _file = 'avatok_safety_flags';

  Future<Map<String, Map<String, dynamic>>> load() async {
    final raw = await DiskCache.read(_file);
    if (raw == null || raw.isEmpty) return {};
    try {
      final m = (jsonDecode(raw) as Map).cast<String, dynamic>();
      return m.map((k, v) => MapEntry(k, (v as Map).cast<String, dynamic>()));
    } catch (_) {
      return {};
    }
  }

  Future<void> _saveAll(Map<String, Map<String, dynamic>> all) =>
      DiskCache.write(_file, jsonEncode(all));

  /// Record (or refresh) a flag for [msgId]. Idempotent; preserves an existing
  /// local `dismissed` so a re-pushed frame can't un-dismiss the user's choice.
  Future<void> put(String msgId,
      {required String conv, required String category}) async {
    if (msgId.isEmpty) return;
    final all = await load();
    final prev = all[msgId];
    all[msgId] = <String, dynamic>{
      'conv': conv,
      'category': category,
      'dismissed': prev?['dismissed'] == true,
    };
    await _saveAll(all);
  }

  /// Local dismiss ("This is fine") — hides the red state on THIS device. The
  /// sender is never notified (no network call).
  Future<void> dismiss(String msgId) async {
    final all = await load();
    final cur = all[msgId];
    if (cur == null) return;
    cur['dismissed'] = true;
    all[msgId] = cur;
    await _saveAll(all);
  }
}
