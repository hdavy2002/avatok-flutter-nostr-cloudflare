/// Ava on-device memory index (Phase 4 — Two-Lane Memory, free lane).
///
/// Implements the FREE, on-device search lane: **FTS5 keyword search first**,
/// **brute-force-cosine vector search on a miss**. Both run against the EXISTING
/// per-account drift SQLite file (`avatok_<scope>.sqlite`, see `core/db.dart`),
/// so there is no parallel database and per-account scoping comes for free (the
/// whole DB file is already per-account).
///
/// ── NETWORKLESS BOUNDARY (One Brain B3, §6.1) ────────────────────────────────
/// Moved into `app/lib/core/local_brain/` — the device-private brain module. It
/// imports ONLY: `dart:convert`/`math`/`typed_data`, `package:drift` (the local
/// SQLite engine), and two audited local infra files — `../ava_log.dart`
/// (diagnostics logger; never transmits index content) and `../db.dart` (the
/// per-account SQLite source of truth). It has NO network-capable dependency.
/// `test/local_brain_networkless_test.dart` walks this module's imports and
/// fails if that ever changes. See also `AvaLocalBrain` (`local_brain.dart`),
/// the façade that callers use.
///
/// ── Why raw SQL on the existing drift DB (not a new schema) ──────────────────
/// `core/db.dart` is owned by another phase and is FROZEN to Phase 4. We must
/// not add tables to its `@DriftDatabase` declaration. Instead we run raw DDL/DML
/// through drift's `customStatement` / `customSelect` on the SAME connection
/// (`Db.I`), creating our own auxiliary objects with an `ava_` prefix:
///   • `ava_fts`         — an FTS5 virtual table (contentless) over message text.
///   • `ava_vectors`     — BLOB rows: one 256-D Float32 embedding per message id.
///   • `ava_index_state` — bookkeeping (what's been indexed) so indexing is lazy.
/// FTS5 is available because `sqlite3_flutter_libs` bundles SQLite with FTS5 on
/// every device (noted in pubspec). These objects upgrade in place and never
/// touch the drift-managed tables, so they coexist with drift's own migrations.
///
/// ── Lazy / selective indexing ────────────────────────────────────────────────
/// We do NOT index everything eagerly. Callers index a message (or batch) when
/// it is convenient (e.g. when a thread is opened or a turn runs). Trivia is
/// skipped: very short messages, emoji-only, and pure-receipt envelopes are not
/// indexed (they add noise + cost recall nothing). Vector embedding is only
/// computed when the embedder is ready, so the FTS path is never blocked by it.
library;

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:drift/drift.dart' show Variable;

import '../ava_log.dart';
import '../db.dart';
import 'embedder.dart';

/// One on-device search result before the router wraps it as a `MemoryHit`.
class LocalHit {
  final String messageId; // == Messages.rumorId
  final String convKey; // '1:<peerUid>' | 'g:<gid>'
  final double score; // FTS: bm25-derived (higher = better); vector: cosine 0..1
  final String snippet;
  const LocalHit({
    required this.messageId,
    required this.convKey,
    required this.score,
    required this.snippet,
  });
}

/// The on-device lane. A process-wide singleton; it binds to whatever account is
/// active via `Db.I` (which itself rebuilds per account), so switching accounts
/// transparently switches index files. No state is cached across accounts here.
class AvaLocalIndex {
  AvaLocalIndex._();
  static final AvaLocalIndex I = AvaLocalIndex._();

  bool _schemaReady = false;

  /// Create the FTS5 + vector + state objects if absent. Idempotent and cheap;
  /// runs once per process (re-runs harmlessly if called again). Uses
  /// `IF NOT EXISTS` so it coexists with drift's own schema/migrations.
  Future<void> _ensureSchema() async {
    if (_schemaReady) return;
    final db = Db.I;
    // Contentless-ish FTS5 table: we store the searchable text + the keys we
    // need to resolve a hit. `tokenize=porter unicode61` gives stemming +
    // unicode folding. `prefix` enables fast prefix queries for type-ahead.
    await db.customStatement('''
      CREATE VIRTUAL TABLE IF NOT EXISTS ava_fts USING fts5(
        message_id UNINDEXED,
        conv_key UNINDEXED,
        body,
        created_at UNINDEXED,
        tokenize = 'porter unicode61',
        prefix = '2 3'
      );
    ''');
    // Vector store: one row per indexed message, 256-D Float32 little-endian BLOB.
    await db.customStatement('''
      CREATE TABLE IF NOT EXISTS ava_vectors (
        message_id TEXT PRIMARY KEY,
        conv_key   TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        dim        INTEGER NOT NULL,
        vec        BLOB NOT NULL
      );
    ''');
    await db.customStatement(
        'CREATE INDEX IF NOT EXISTS ava_vectors_conv ON ava_vectors(conv_key);');
    // Bookkeeping: which message ids are already indexed (so we skip re-work).
    await db.customStatement('''
      CREATE TABLE IF NOT EXISTS ava_index_state (
        message_id TEXT PRIMARY KEY,
        fts        INTEGER NOT NULL DEFAULT 0,
        vec        INTEGER NOT NULL DEFAULT 0
      );
    ''');
    _schemaReady = true;
    await _migrateLegacyRag();
  }

  /// One-time fold of the old [AvaOnDeviceRag] store (`ava_mem_fts`, columns
  /// name/content/created_at) into the unified `ava_fts` index. B3 deferred the
  /// AvaOnDeviceRag→AvaLocalBrain merge to B4; this backfills those rows on first
  /// use so companion grounding + any note saved via the old API stays findable
  /// through `brainRecall`/`AvaLocalBrain`. Networkless (drift + SQLite only),
  /// idempotent (guarded by a sentinel row), and best-effort — a missing legacy
  /// table (fresh install) is a no-op. The old table is left in place so the
  /// legacy shim can keep counting it; re-running only ever inserts NEW rowids.
  Future<void> _migrateLegacyRag() async {
    try {
      final db = Db.I;
      final present = await db.customSelect(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ava_mem_fts'",
      ).get();
      if (present.isEmpty) return; // no legacy store on this device — nothing to do

      final rows = await db.customSelect(
        'SELECT rowid AS rid, name, content, created_at FROM ava_mem_fts',
      ).get();
      for (final r in rows) {
        final rid = r.read<int>('rid');
        final messageId = 'legacy_rag_$rid';
        // Already folded? (idempotent across launches / partial runs.)
        final done = await db.customSelect(
          'SELECT 1 FROM ava_index_state WHERE message_id = ?1',
          variables: [Variable<String>(messageId)],
        ).get();
        if (done.isNotEmpty) continue;

        final content = r.readNullable<String>('content') ?? '';
        if (_isTrivia(content)) {
          // Record it as seen so we never re-scan it, but don't index trivia.
          await db.customStatement(
            'INSERT OR IGNORE INTO ava_index_state(message_id, fts, vec) VALUES (?1, 0, 0)',
            [messageId],
          );
          continue;
        }
        final name = (r.readNullable<String>('name') ?? 'rag').trim();
        final createdAt = r.readNullable<int>('created_at') ?? 0;
        await db.customStatement(
          'INSERT INTO ava_fts(message_id, conv_key, body, created_at) VALUES (?1, ?2, ?3, ?4)',
          [messageId, 'notes:${name.isEmpty ? 'rag' : name}', content, createdAt],
        );
        await db.customStatement(
          'INSERT OR IGNORE INTO ava_index_state(message_id, fts, vec) VALUES (?1, 1, 0)',
          [messageId],
        );
      }
    } catch (e) {
      AvaLog.I.log('ava_mem', 'legacy rag migration skipped: $e');
    }
  }

  /// Ensure the unified index schema exists (and fold any legacy store on first
  /// call). Public, cheap, idempotent — used by the [AvaOnDeviceRag] compat shim
  /// and [AvaLocalBrain.ensureReady] to warm the lane without indexing anything.
  Future<void> warm() => _ensureSchema();

  /// How many rows are in the unified FTS index right now (0 on any error).
  Future<int> count() async {
    try {
      await _ensureSchema();
      final rows = await Db.I.customSelect('SELECT count(*) AS c FROM ava_fts').get();
      return rows.isNotEmpty ? rows.first.read<int>('c') : 0;
    } catch (_) {
      return 0;
    }
  }

  // ── Indexing ────────────────────────────────────────────────────────────────

  /// Index one message lazily. Skips trivia and already-indexed rows. FTS is
  /// written immediately; the vector is written only if the embedder is ready
  /// (so a cold embedder never blocks keyword search). Never throws.
  Future<void> indexMessage({
    required String messageId,
    required String convKey,
    required String payload, // the app envelope JSON ({"t":"text","body":...})
    required int createdAt,
  }) async {
    try {
      final text = extractText(payload);
      if (_isTrivia(text)) return;
      await _ensureSchema();
      final db = Db.I;

      // Has this id been FTS-indexed already?
      final state = await db.customSelect(
        'SELECT fts, vec FROM ava_index_state WHERE message_id = ?1',
        variables: [Variable<String>(messageId)],
      ).get();
      final ftsDone = state.isNotEmpty && (state.first.read<int>('fts') == 1);
      final vecDone = state.isNotEmpty && (state.first.read<int>('vec') == 1);

      if (!ftsDone) {
        await db.customStatement(
          'INSERT INTO ava_fts(message_id, conv_key, body, created_at) VALUES (?1, ?2, ?3, ?4)',
          [messageId, convKey, text, createdAt],
        );
      }

      var vecWritten = vecDone;
      if (!vecDone && defaultEmbedder.isReady) {
        final vec = await defaultEmbedder.embed(text);
        if (vec.length == kAvaEmbedDim && vec.any((v) => v != 0)) {
          final blob = _floatsToBlob(vec);
          await db.customStatement(
            'INSERT OR REPLACE INTO ava_vectors(message_id, conv_key, body, created_at, dim, vec) '
            'VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
            [messageId, convKey, text, createdAt, kAvaEmbedDim, blob],
          );
          vecWritten = true;
        }
      }

      await db.customStatement(
        'INSERT INTO ava_index_state(message_id, fts, vec) VALUES (?1, 1, ?2) '
        'ON CONFLICT(message_id) DO UPDATE SET fts = 1, vec = MAX(vec, ?2)',
        [messageId, vecWritten ? 1 : 0],
      );
    } catch (e) {
      AvaLog.I.log('ava_mem', 'indexMessage FAILED $messageId: $e');
    }
  }

  /// Backfill the index from the drift `messages` table for a conversation (or
  /// all conversations when [convKey] is null). Selective: skips trivia + rows
  /// already indexed. Bounded by [limit] so a one-shot call stays cheap; call
  /// again to continue. Returns how many NEW messages were indexed.
  Future<int> backfill({String? convKey, int limit = 500}) async {
    try {
      await _ensureSchema();
      final db = Db.I;
      final rows = convKey == null
          ? await db.customSelect(
              'SELECT rumor_id, conv_key, payload, created_at FROM messages '
              'WHERE rumor_id NOT IN (SELECT message_id FROM ava_index_state) '
              'ORDER BY created_at DESC LIMIT ?1',
              variables: [Variable<int>(limit)],
            ).get()
          : await db.customSelect(
              'SELECT rumor_id, conv_key, payload, created_at FROM messages '
              'WHERE conv_key = ?1 AND rumor_id NOT IN (SELECT message_id FROM ava_index_state) '
              'ORDER BY created_at DESC LIMIT ?2',
              variables: [Variable<String>(convKey), Variable<int>(limit)],
            ).get();
      var n = 0;
      for (final r in rows) {
        await indexMessage(
          messageId: r.read<String>('rumor_id'),
          convKey: r.read<String>('conv_key'),
          payload: r.read<String>('payload'),
          createdAt: r.read<int>('created_at'),
        );
        n++;
      }
      return n;
    } catch (e) {
      AvaLog.I.log('ava_mem', 'backfill FAILED: $e');
      return 0;
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /// FTS5 keyword search first. Returns ranked hits (best first). [convKey]
  /// restricts to one conversation when provided. Empty on no match / error.
  Future<List<LocalHit>> searchKeyword(String query, {String? convKey, int topK = 5}) async {
    final match = _toFtsMatch(query);
    if (match.isEmpty) return const [];
    try {
      await _ensureSchema();
      final db = Db.I;
      // bm25() returns LOWER = better; negate so higher == better for the router.
      final where = convKey == null ? '' : 'AND conv_key = ?2';
      final vars = <Variable>[Variable<String>(match)];
      if (convKey != null) vars.add(Variable<String>(convKey));
      vars.add(Variable<int>(topK));
      final rows = await db.customSelect(
        'SELECT message_id, conv_key, body, -bm25(ava_fts) AS score '
        'FROM ava_fts WHERE ava_fts MATCH ?1 $where '
        'ORDER BY score DESC LIMIT ?${convKey == null ? 2 : 3}',
        variables: vars,
      ).get();
      return rows
          .map((r) => LocalHit(
                messageId: r.read<String>('message_id'),
                convKey: r.read<String>('conv_key'),
                score: r.read<double>('score'),
                snippet: _snip(r.read<String>('body'), query),
              ))
          .toList(growable: false);
    } catch (e) {
      AvaLog.I.log('ava_mem', 'searchKeyword FAILED: $e');
      return const [];
    }
  }

  /// Brute-force-cosine vector search over `ava_vectors`. Loads candidate BLOBs
  /// (scoped to [convKey] when given), computes cosine in Dart, returns top-k.
  /// On-device message volumes make brute force fine; no native vector engine.
  /// Returns empty if the embedder can't produce a query vector.
  Future<List<LocalHit>> searchVector(String query, {String? convKey, int topK = 5}) async {
    try {
      await _ensureSchema();
      if (!defaultEmbedder.isReady) {
        // Try a lazy ensure (download-on-first-use); if still not ready, bail.
        await defaultEmbedder.ensureReady();
        if (!defaultEmbedder.isReady) return const [];
      }
      final q = await defaultEmbedder.embed(query);
      if (q.length != kAvaEmbedDim || !q.any((v) => v != 0)) return const [];

      final db = Db.I;
      final rows = convKey == null
          ? await db.customSelect(
              'SELECT message_id, conv_key, body, vec FROM ava_vectors',
            ).get()
          : await db.customSelect(
              'SELECT message_id, conv_key, body, vec FROM ava_vectors WHERE conv_key = ?1',
              variables: [Variable<String>(convKey)],
            ).get();

      final scored = <LocalHit>[];
      for (final r in rows) {
        final v = _blobToFloats(r.read<Uint8List>('vec'));
        if (v.length != q.length) continue;
        final cos = _cosine(q, v);
        if (cos <= 0) continue; // skip orthogonal/negative
        scored.add(LocalHit(
          messageId: r.read<String>('message_id'),
          convKey: r.read<String>('conv_key'),
          score: cos,
          snippet: _snip(r.read<String>('body'), query),
        ));
      }
      scored.sort((a, b) => b.score.compareTo(a.score));
      return scored.take(topK).toList(growable: false);
    } catch (e) {
      AvaLog.I.log('ava_mem', 'searchVector FAILED: $e');
      return const [];
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /// Pull human-readable text out of an app message envelope. Handles the
  /// `{"t":"text","body":"…"}` shape used across the chat pipeline; for non-text
  /// kinds (media/poll/etc.) it falls back to any caption/title-ish fields, else
  /// the raw string. Returns '' for receipts (never indexed).
  static String extractText(String payload) {
    try {
      final env = jsonDecode(payload);
      if (env is Map) {
        if (env['t'] == 'receipt') return '';
        final body = env['body'];
        if (body is String && body.isNotEmpty) return body;
        // best-effort caption/title for media/poll/etc.
        for (final k in const ['caption', 'title', 'text', 'name', 'q']) {
          final v = env[k];
          if (v is String && v.isNotEmpty) return v;
        }
        return '';
      }
    } catch (_) {/* not JSON — treat as plain text below */}
    return payload;
  }

  /// Skip trivia: empty, very short (<3 chars after trim), or emoji/punct-only.
  static bool _isTrivia(String text) {
    final t = text.trim();
    if (t.length < 3) return true;
    final hasWord = RegExp(r'[a-zA-Z0-9]').hasMatch(t);
    return !hasWord;
  }

  /// Build an FTS5 MATCH expression: tokenise the query, OR the prefix-terms.
  static String _toFtsMatch(String query) {
    final terms = query
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9]+'))
        .where((t) => t.length > 1)
        .map((t) => '$t*')
        .toList(growable: false);
    return terms.join(' OR ');
  }

  static String _snip(String body, String query, {int max = 160}) {
    final b = body.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (b.length <= max) return b;
    // Centre the snippet on the first query term if we can find one.
    final first = query
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9]+'))
        .firstWhere((t) => t.length > 1, orElse: () => '');
    final idx = first.isEmpty ? -1 : b.toLowerCase().indexOf(first);
    if (idx < 0) return '${b.substring(0, max)}…';
    final start = (idx - max ~/ 3).clamp(0, b.length);
    final end = (start + max).clamp(0, b.length);
    final pre = start > 0 ? '…' : '';
    final post = end < b.length ? '…' : '';
    return '$pre${b.substring(start, end)}$post';
  }

  static double _cosine(List<double> a, List<double> b) {
    // Embedder L2-normalises, so this is effectively a dot product; we still
    // divide by norms to stay correct for any non-normalised producer.
    double dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na == 0 || nb == 0) return 0;
    return dot / (math.sqrt(na) * math.sqrt(nb));
  }

  static Uint8List _floatsToBlob(List<double> v) {
    final bd = ByteData(v.length * 4);
    for (var i = 0; i < v.length; i++) {
      bd.setFloat32(i * 4, v[i], Endian.little);
    }
    return bd.buffer.asUint8List();
  }

  static List<double> _blobToFloats(Uint8List blob) {
    final bd = ByteData.sublistView(blob);
    final n = blob.length ~/ 4;
    final out = List<double>.filled(n, 0);
    for (var i = 0; i < n; i++) {
      out[i] = bd.getFloat32(i * 4, Endian.little);
    }
    return out;
  }
}
