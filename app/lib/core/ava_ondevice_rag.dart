/// AvaOnDeviceRag — the user's PRIVATE on-device memory, now backed by SQLite
/// FTS5 keyword search (NO Cactus, NO LLM, NO embeddings).
///
/// Architecture decision (2026-06-21): the on-device LLM was removed (too weak —
/// it hallucinated). All generation is now the cloud (Gemini 3). What stays on
/// the phone is the user's DATA + a fast local keyword index, so retrieval is
/// private and offline. FTS5 ("find Bob", "trout note", "April") covers the vast
/// majority of real searches; semantic embeddings become an optional rerank
/// LATER, only if telemetry proves users need it.
///
/// Public API is unchanged for callers (ingestText / rememberMessage / search →
/// List<RagHit>) so the rest of the app didn't need rewiring.
library;

import 'package:drift/drift.dart' show Variable;
import 'package:flutter/foundation.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'db.dart';

class RagHit {
  final String content;
  final double distance; // FTS5 bm25 rank — LOWER = more relevant
  final String source;
  const RagHit(
      {required this.content, required this.distance, required this.source});
}

class AvaOnDeviceRag {
  AvaOnDeviceRag._();
  static final AvaOnDeviceRag I = AvaOnDeviceRag._();

  bool _ready = false;

  /// Live status string a screen can show ("", "Saved …", "…").
  final ValueNotifier<String> ingestStatus = ValueNotifier<String>('');

  /// How many items are in the on-device index right now.
  final ValueNotifier<int> docCount = ValueNotifier<int>(0);

  /// On-device memory budget — at ~200–400 bytes/row this keeps the index tiny.
  /// When over, the oldest CONVERSATION rows are pruned (explicit notes/files go
  /// through [ingestText] and aren't capped here).
  static const int kMaxConversationDocs = 5000;

  /// Greetings / acks that are never worth storing.
  static final RegExp _kLowValue = RegExp(
    r"^(hi+|hey+|hello+|yo|ok(ay)?|k|thanks?|thank you|ty|cool|nice|great|lol+|haha+|good (morning|night|evening|day)|gm|gn|yes|yeah|no|nope|sure|np|done|got it|right|correct|exactly|same)[\s!.,]*$",
    caseSensitive: false,
  );

  /// Is [text] substantive enough to keep? Skips the 80–95% of low-signal chatter.
  static bool worthEmbedding(String text) {
    final t = text.trim();
    if (t.length < 12) return false;
    if (_kLowValue.hasMatch(t)) return false;
    final words = t.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).length;
    return words >= 3;
  }

  /// Create the FTS5 virtual table on the per-account SQLite DB. unicode61
  /// tokenizes Latin AND Devanagari/other scripts by codepoint class, so Hindi
  /// + regional keyword search works. Idempotent.
  Future<bool> ensureReady() async {
    if (_ready) return true;
    try {
      await Db.I.customStatement(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ava_mem_fts USING fts5("
        "name, content, created_at UNINDEXED, "
        "tokenize = 'unicode61 remove_diacritics 2');",
      );
      _ready = true;
      await _refreshCount();
      AvaLog.I.log('ava_ondevice', 'FTS5 memory ready (rows=${docCount.value})');
      return true;
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'FTS5 init FAILED: $e');
      ingestStatus.value = 'Memory unavailable: $e';
      return false;
    }
  }

  /// Store a blob of text under a display [name]. Always kept (explicit content).
  Future<bool> ingestText({required String name, required String content}) async {
    final text = content.trim();
    if (text.isEmpty) return false;
    if (!await ensureReady()) return false;
    final sw = Stopwatch()..start();
    try {
      await Db.I.customStatement(
        'INSERT INTO ava_mem_fts (name, content, created_at) VALUES (?1, ?2, ?3)',
        [name, text, DateTime.now().millisecondsSinceEpoch],
      );
      await _refreshCount();
      await _enforceCap();
      // ignore: unawaited_futures
      Analytics.capture('ondevice_rag_ingest', {
        'ms': sw.elapsedMilliseconds,
        'chars': text.length,
        'docs': docCount.value,
        'store': 'fts5',
      });
      ingestStatus.value = 'Saved "$name" ✓ (${docCount.value} in memory)';
      return true;
    } catch (e) {
      ingestStatus.value = 'Save failed for "$name": $e';
      AvaLog.I.log('ava_ondevice', 'ingest FAILED "$name": $e');
      return false;
    }
  }

  /// Remember a CONVERSATION line — gated by [worthEmbedding] and the cap so the
  /// index never bloats. Chatter is skipped; substantive lines are stored.
  Future<bool> rememberMessage(String who, String text,
      {String name = 'chat'}) async {
    final t = text.trim();
    if (!worthEmbedding(t)) {
      _skip('low_value');
      return false;
    }
    if (docCount.value >= kMaxConversationDocs) {
      _skip('over_cap');
      return false;
    }
    return ingestText(name: name, content: '$who: $t');
  }

  /// Ingest a whole conversation as one document.
  Future<bool> ingestConversation({
    required String convName,
    required List<String> turns,
  }) {
    final body = turns.where((t) => t.trim().isNotEmpty).join('\n');
    return ingestText(name: 'chat: $convName', content: body);
  }

  /// Keyword search over the on-device index. Returns the most relevant rows
  /// first (FTS5 bm25). The query is tokenised + OR-matched so partial/typo'd
  /// phrasing still finds things, and FTS5 operators are stripped so raw user
  /// text can never throw a syntax error.
  Future<List<RagHit>> search(String query, {int limit = 5}) async {
    if (!await ensureReady()) return const [];
    final sw = Stopwatch()..start();
    final match = _ftsQuery(query);
    if (match.isEmpty) {
      _emitSearch(sw, 0, query, null);
      return const [];
    }
    try {
      final rows = await Db.I.customSelect(
        'SELECT name, content, bm25(ava_mem_fts) AS rank FROM ava_mem_fts '
        'WHERE ava_mem_fts MATCH ?1 ORDER BY rank LIMIT ?2',
        variables: [Variable<String>(match), Variable<int>(limit)],
      ).get();
      final hits = rows
          .map((r) => RagHit(
                content: r.read<String>('content'),
                distance: r.read<double>('rank'),
                source: r.read<String>('name'),
              ))
          .toList(growable: false);
      _emitSearch(sw, hits.length, query,
          hits.isNotEmpty ? hits.first.distance : null);
      return hits;
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'FTS5 search FAILED: $e');
      _emitSearch(sw, 0, query, null, error: true);
      return const [];
    }
  }

  /// Convenience: top hits joined into a grounding block for a cloud prompt.
  Future<String> contextFor(String query, {int limit = 4}) async {
    final hits = await search(query, limit: limit);
    if (hits.isEmpty) return '';
    return hits.map((h) => '• (${h.source}) ${h.content}').join('\n');
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  static String _ftsQuery(String q) {
    final tokens = q
        .split(RegExp(r'\s+'))
        .map((t) => t.replaceAll(RegExp(r'["()*:^]'), '').trim())
        .where((t) => t.isNotEmpty)
        .toList();
    if (tokens.isEmpty) return '';
    return tokens.map((t) => '"$t"').join(' OR ');
  }

  Future<void> _refreshCount() async {
    try {
      final rows =
          await Db.I.customSelect('SELECT count(*) AS c FROM ava_mem_fts').get();
      docCount.value = rows.isNotEmpty ? rows.first.read<int>('c') : 0;
    } catch (_) {/* best-effort */}
  }

  Future<void> _enforceCap() async {
    if (docCount.value <= kMaxConversationDocs) return;
    try {
      await Db.I.customStatement(
        'DELETE FROM ava_mem_fts WHERE rowid IN '
        '(SELECT rowid FROM ava_mem_fts ORDER BY rowid ASC LIMIT ?1)',
        [docCount.value - kMaxConversationDocs],
      );
      await _refreshCount();
    } catch (_) {/* best-effort */}
  }

  void _skip(String reason) {
    // ignore: unawaited_futures
    Analytics.capture('ondevice_rag_skip', {
      'reason': reason,
      'docs': docCount.value,
    });
  }

  void _emitSearch(Stopwatch sw, int hits, String query, double? best,
      {bool error = false}) {
    // ignore: unawaited_futures
    Analytics.capture('ondevice_rag_search', {
      'ms': sw.elapsedMilliseconds,
      'hits': hits,
      'query_chars': query.length,
      'docs': docCount.value,
      'store': 'fts5',
      if (best != null) 'best_rank': double.parse(best.toStringAsFixed(3)),
      if (error) 'error': 1,
    });
  }
}
