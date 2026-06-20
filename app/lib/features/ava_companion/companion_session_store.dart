import 'dart:convert';

import 'package:drift/drift.dart' show Variable;

import '../../core/api_auth.dart';
import '../../core/ava_contracts.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/db.dart';

/// One AvaChat (talk-to-Ava) session row as the list needs it.
class CompanionSession {
  final String id;
  final String persona;
  final String title;
  final String preview;
  final bool starred;
  final bool archived;
  final double? sortOrder;
  final int updatedAt; // epoch ms

  const CompanionSession({
    required this.id,
    required this.persona,
    required this.title,
    required this.preview,
    required this.starred,
    required this.archived,
    required this.sortOrder,
    required this.updatedAt,
  });
}

/// CompanionSessionStore — the source of truth for the AvaChat session LIST.
///
/// Local-first: every session (its metadata + full transcript) lives in a raw
/// SQLite table `ava_chat_sessions` on the EXISTING per-account drift DB
/// (`avatok_<scope>.sqlite`). We use `Db.I.customStatement` / `customSelect`
/// (the same pattern as `core/ava_memory/local_index.dart`) so we add NO drift
/// table to `@DriftDatabase` and therefore need NO codegen / `db.g.dart` rebuild.
/// Per-account scoping is automatic because the whole DB file is per-account.
///
/// Cloud-backed: every local write is mirrored, best-effort, to Cloudflare D1
/// (`/api/ava/chat/history` + `/api/ava/chat/history/meta`) so history + the
/// star/archive/order survive a new device. Reads are local-first; [syncFromCloud]
/// pulls the cloud list and merges it in (e.g. first run on a fresh device).
///
/// Everything here is best-effort and never throws to the UI — a telemetry or
/// network failure must not break opening or saving a chat.
class CompanionSessionStore {
  CompanionSessionStore._();
  static final CompanionSessionStore I = CompanionSessionStore._();

  bool _schemaReady = false;

  static String _url(String path) {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin$path';
  }

  Future<void> _ensureSchema() async {
    if (_schemaReady) return;
    final db = Db.I;
    await db.customStatement('''
      CREATE TABLE IF NOT EXISTS ava_chat_sessions (
        session_id    TEXT PRIMARY KEY,
        persona       TEXT NOT NULL DEFAULT '',
        title         TEXT NOT NULL DEFAULT '',
        preview       TEXT NOT NULL DEFAULT '',
        starred       INTEGER NOT NULL DEFAULT 0,
        archived      INTEGER NOT NULL DEFAULT 0,
        sort_order    REAL,
        updated_at    INTEGER NOT NULL DEFAULT 0,
        messages_json TEXT NOT NULL DEFAULT '[]'
      );
    ''');
    await db.customStatement(
        'CREATE INDEX IF NOT EXISTS ava_chat_sessions_arch ON ava_chat_sessions(archived, updated_at);');
    _schemaReady = true;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /// All sessions for the current account, manual order first (drag order),
  /// then most-recent. [archived] selects the active vs archived bucket.
  Future<List<CompanionSession>> list({bool archived = false}) async {
    try {
      await _ensureSchema();
      final rows = await Db.I.customSelect(
        'SELECT session_id, persona, title, preview, starred, archived, sort_order, updated_at '
        'FROM ava_chat_sessions WHERE archived = ?1 '
        'ORDER BY (sort_order IS NULL) ASC, sort_order ASC, updated_at DESC',
        variables: [Variable<int>(archived ? 1 : 0)],
      ).get();
      return rows
          .map((r) => CompanionSession(
                id: r.read<String>('session_id'),
                persona: r.read<String>('persona'),
                title: r.read<String>('title'),
                preview: r.read<String>('preview'),
                starred: r.read<int>('starred') == 1,
                archived: r.read<int>('archived') == 1,
                sortOrder: r.readNullable<double>('sort_order'),
                updatedAt: r.read<int>('updated_at'),
              ))
          .toList(growable: false);
    } catch (e) {
      AvaLog.I.log('avachat', 'session list failed: $e');
      return const [];
    }
  }

  /// The full transcript for a session — `[{role:'user'|'ava', text}]`. Reads the
  /// local copy first (instant/offline); falls back to the D1 copy if this device
  /// has the metadata but not the body yet (e.g. just synced from cloud).
  Future<List<Map<String, String>>> messages(String sessionId) async {
    try {
      await _ensureSchema();
      final rows = await Db.I.customSelect(
        'SELECT messages_json FROM ava_chat_sessions WHERE session_id = ?1',
        variables: [Variable<String>(sessionId)],
      ).get();
      if (rows.isNotEmpty) {
        final raw = rows.first.read<String>('messages_json');
        final parsed = _decodeMsgs(raw);
        if (parsed.isNotEmpty) return parsed;
      }
    } catch (e) {
      AvaLog.I.log('avachat', 'local messages read failed: $e');
    }
    return _cloudMessages(sessionId);
  }

  // ── writes (local first, cloud mirror) ───────────────────────────────────────

  /// Create/update a session from a live thread. Writes the local copy instantly
  /// then mirrors to D1. Metadata flags (star/archive/order) are preserved.
  Future<void> upsert({
    required String sessionId,
    required String persona,
    required String title,
    required List<Map<String, String>> messages,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final preview = _previewOf(messages);
    final msgsJson = jsonEncode(messages);
    try {
      await _ensureSchema();
      await Db.I.customStatement(
        'INSERT INTO ava_chat_sessions (session_id, persona, title, preview, updated_at, messages_json) '
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6) '
        'ON CONFLICT(session_id) DO UPDATE SET persona=?2, title=?3, preview=?4, updated_at=?5, messages_json=?6',
        [sessionId, persona, title, preview, now, msgsJson],
      );
    } catch (e) {
      AvaLog.I.log('avachat', 'local upsert failed: $e');
    }
    // cloud mirror (best-effort)
    try {
      await ApiAuth.postJson(_url(AvaApi.chatHistory), {
        'sessionId': sessionId,
        'persona': persona,
        'title': title,
        'messages': messages,
      }, timeout: const Duration(seconds: 15));
    } catch (e) {
      AvaLog.I.log('avachat', 'cloud upsert failed: $e');
    }
  }

  Future<void> rename(String sessionId, String title) async {
    await _localSet(sessionId, 'title = ?2, updated_at = ?3',
        [sessionId, title, DateTime.now().millisecondsSinceEpoch]);
    await _meta({'action': 'rename', 'sessionId': sessionId, 'title': title});
  }

  Future<void> setStar(String sessionId, bool starred) async {
    await _localSet(sessionId, 'starred = ?2', [sessionId, starred ? 1 : 0]);
    await _meta({'action': 'star', 'sessionId': sessionId, 'starred': starred});
  }

  Future<void> setArchived(String sessionId, bool archived) async {
    await _localSet(sessionId, 'archived = ?2, updated_at = ?3',
        [sessionId, archived ? 1 : 0, DateTime.now().millisecondsSinceEpoch]);
    await _meta({'action': 'archive', 'sessionId': sessionId, 'archived': archived});
  }

  Future<void> delete(String sessionId) async {
    try {
      await _ensureSchema();
      await Db.I.customStatement(
          'DELETE FROM ava_chat_sessions WHERE session_id = ?1', [sessionId]);
    } catch (e) {
      AvaLog.I.log('avachat', 'local delete failed: $e');
    }
    await _meta({'action': 'delete', 'sessionId': sessionId});
  }

  /// Persist a manual ordering (drag-to-reorder). [orderedIds] is the list top→
  /// bottom; we stamp ascending sort_order (10,20,30…) so a later single move can
  /// slot a row between two neighbours.
  Future<void> reorder(List<String> orderedIds) async {
    try {
      await _ensureSchema();
      final db = Db.I;
      for (var i = 0; i < orderedIds.length; i++) {
        await db.customStatement(
          'UPDATE ava_chat_sessions SET sort_order = ?1 WHERE session_id = ?2',
          [(i + 1) * 10.0, orderedIds[i]],
        );
      }
    } catch (e) {
      AvaLog.I.log('avachat', 'local reorder failed: $e');
    }
    await _meta({'action': 'reorder', 'order': orderedIds});
  }

  // ── cloud merge ──────────────────────────────────────────────────────────────

  /// Pull the cloud session list and merge any rows this device is missing (or
  /// that cloud has a newer copy of). Best-effort; safe to call on screen open.
  Future<void> syncFromCloud() async {
    try {
      await _ensureSchema();
      for (final archived in const [false, true]) {
        final res = await ApiAuth.getSigned(
            '${_url(AvaApi.chatHistory)}${archived ? '?archived=1' : ''}');
        if (res.statusCode != 200) continue;
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        final sessions = (j['sessions'] as List?) ?? const [];
        for (final s in sessions) {
          if (s is! Map) continue;
          final sid = (s['session_id'] ?? '').toString();
          if (sid.isEmpty) continue;
          final updated = (s['updated_at'] as num?)?.toInt() ?? 0;
          // Only touch rows we don't have or whose cloud copy is newer. We do not
          // overwrite the local transcript here (messages load lazily on open).
          final existing = await Db.I.customSelect(
            'SELECT updated_at FROM ava_chat_sessions WHERE session_id = ?1',
            variables: [Variable<String>(sid)],
          ).get();
          final haveNewer =
              existing.isNotEmpty && existing.first.read<int>('updated_at') >= updated;
          if (haveNewer) continue;
          await Db.I.customStatement(
            'INSERT INTO ava_chat_sessions (session_id, persona, title, starred, archived, sort_order, updated_at) '
            'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) '
            'ON CONFLICT(session_id) DO UPDATE SET persona=?2, title=?3, starred=?4, archived=?5, sort_order=?6, updated_at=?7',
            [
              sid,
              (s['persona'] ?? '').toString(),
              (s['title'] ?? '').toString(),
              ((s['starred'] as num?)?.toInt() ?? 0),
              ((s['archived'] as num?)?.toInt() ?? (archived ? 1 : 0)),
              (s['sort_order'] as num?)?.toDouble(),
              updated,
            ],
          );
        }
      }
    } catch (e) {
      AvaLog.I.log('avachat', 'cloud sync failed: $e');
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  Future<void> _localSet(String sessionId, String setClause, List<Object?> vars) async {
    try {
      await _ensureSchema();
      await Db.I.customStatement(
          'UPDATE ava_chat_sessions SET $setClause WHERE session_id = ?1', vars);
    } catch (e) {
      AvaLog.I.log('avachat', 'local meta update failed: $e');
    }
  }

  Future<void> _meta(Map<String, Object?> body) async {
    try {
      await ApiAuth.postJson(_url(AvaApi.chatHistoryMeta), body,
          timeout: const Duration(seconds: 12));
    } catch (e) {
      AvaLog.I.log('avachat', 'cloud meta failed: $e');
    }
  }

  Future<List<Map<String, String>>> _cloudMessages(String sessionId) async {
    try {
      final res = await ApiAuth.getSigned('${_url(AvaApi.chatHistory)}?id=$sessionId');
      if (res.statusCode != 200) return const [];
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final session = j['session'];
      if (session is! Map) return const [];
      final msgs = _decodeMsgs(jsonEncode(session['messages'] ?? const []));
      // cache the body locally so the next open is instant/offline
      if (msgs.isNotEmpty) {
        try {
          await Db.I.customStatement(
            'UPDATE ava_chat_sessions SET messages_json = ?1 WHERE session_id = ?2',
            [jsonEncode(msgs), sessionId],
          );
        } catch (_) {}
      }
      return msgs;
    } catch (e) {
      AvaLog.I.log('avachat', 'cloud messages read failed: $e');
      return const [];
    }
  }

  static List<Map<String, String>> _decodeMsgs(String raw) {
    try {
      final list = jsonDecode(raw) as List?;
      if (list == null) return const [];
      return list
          .map((e) => (e as Map).map((k, v) => MapEntry(k.toString(), v.toString())))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  static String _previewOf(List<Map<String, String>> messages) {
    for (final m in messages.reversed) {
      final t = (m['text'] ?? '').trim();
      if (t.isNotEmpty) return t.length > 140 ? t.substring(0, 140) : t;
    }
    return '';
  }
}
