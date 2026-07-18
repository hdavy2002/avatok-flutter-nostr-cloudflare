/// AvaOnDeviceRag — now a THIN COMPATIBILITY SHIM over [AvaLocalBrain].
///
/// [ONEBRAIN-B4-APP] B3 deferred the AvaOnDeviceRag→AvaLocalBrain fold to B4.
/// Done: this class no longer owns its own `ava_mem_fts` FTS store. Its ingest
/// AND search now delegate to the ONE device lane ([AvaLocalBrain] → the unified
/// `ava_fts` index), so everything the app saved through the old API is written
/// to, and recalled from, the same place `brainRecall` reads. Legacy rows already
/// sitting in `ava_mem_fts` are folded into the unified index on first use by
/// [AvaLocalIndex] (`_migrateLegacyRag`), so nothing saved before B4 is lost.
///
/// The public surface is unchanged (ingestText / rememberMessage /
/// ingestConversation / search → List<RagHit>, plus ensureReady / docCount /
/// ingestStatus / worthEmbedding) so existing callers ([AvaLocalMode], chat) keep
/// compiling. New code should prefer [AvaLocalBrain] (ingest) and [brainRecall]
/// (recall) directly — this shim exists only so the migration didn't have to
/// rewrite every call site at once.
library;

import 'package:flutter/foundation.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'local_brain/local_brain.dart';

/// A single on-device recall result. `distance` LOWER = more relevant (kept for
/// backward compatibility; derived as the negated unified score).
class RagHit {
  final String content;
  final double distance;
  final String source;
  const RagHit(
      {required this.content, required this.distance, required this.source});
}

class AvaOnDeviceRag {
  AvaOnDeviceRag._();
  static final AvaOnDeviceRag I = AvaOnDeviceRag._();

  /// Live status string a screen can show ("", "Saved …", "…").
  final ValueNotifier<String> ingestStatus = ValueNotifier<String>('');

  /// How many items are in the on-device index right now (unified `ava_fts`).
  final ValueNotifier<int> docCount = ValueNotifier<int>(0);

  int _seq = 0;

  /// Kept for the (now soft) episodic cap in [rememberMessage].
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

  /// Warm the unified device lane (creates the schema + folds any legacy store on
  /// first call). Idempotent; returns false only on error.
  Future<bool> ensureReady() async {
    try {
      await AvaLocalBrain.I.ensureReady();
      await _refreshCount();
      AvaLog.I.log('ava_ondevice', 'device lane ready (rows=${docCount.value})');
      return true;
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'device lane init FAILED: $e');
      ingestStatus.value = 'Memory unavailable: $e';
      return false;
    }
  }

  /// Store a blob of text under a display [name]. Delegates to the device lane.
  Future<bool> ingestText({required String name, required String content}) async {
    final text = content.trim();
    if (text.isEmpty) return false;
    final sw = Stopwatch()..start();
    try {
      await AvaLocalBrain.I.ingest(
        domain: 'notes',
        kind: 'note',
        text: text,
        meta: {'convKey': 'notes:$name'},
        ts: DateTime.now().millisecondsSinceEpoch,
        sourceId: 'rag_${DateTime.now().microsecondsSinceEpoch}_${_seq++}',
      );
      await _refreshCount();
      // ignore: unawaited_futures
      Analytics.capture('ondevice_rag_ingest', {
        'ms': sw.elapsedMilliseconds,
        'chars': text.length,
        'docs': docCount.value,
        'store': 'ava_fts',
      });
      ingestStatus.value = 'Saved "$name" ✓ (${docCount.value} in memory)';
      return true;
    } catch (e) {
      ingestStatus.value = 'Save failed for "$name": $e';
      AvaLog.I.log('ava_ondevice', 'ingest FAILED "$name": $e');
      return false;
    }
  }

  /// Remember a CONVERSATION line — gated by [worthEmbedding] so chatter is
  /// skipped; substantive lines are indexed into the device lane.
  Future<bool> rememberMessage(String who, String text,
      {String name = 'chat'}) async {
    final t = text.trim();
    if (!worthEmbedding(t)) {
      _skip('low_value');
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

  /// Keyword-first search over the unified device index (delegates to
  /// [AvaLocalBrain]). Returns the most relevant rows first.
  Future<List<RagHit>> search(String query, {int limit = 5}) async {
    final sw = Stopwatch()..start();
    try {
      final hits = await AvaLocalBrain.I.search(query, k: limit);
      final out = hits
          .map((h) => RagHit(
                content: h.snippet,
                distance: -h.score, // higher score → lower distance (better)
                source: h.convKey,
              ))
          .toList(growable: false);
      _emitSearch(sw, out.length, query);
      return out;
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'search FAILED: $e');
      _emitSearch(sw, 0, query, error: true);
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

  Future<void> _refreshCount() async {
    try {
      docCount.value = await AvaLocalBrain.I.count();
    } catch (_) {/* best-effort */}
  }

  void _skip(String reason) {
    // ignore: unawaited_futures
    Analytics.capture('ondevice_rag_skip', {
      'reason': reason,
      'docs': docCount.value,
    });
  }

  void _emitSearch(Stopwatch sw, int hits, String query, {bool error = false}) {
    // ignore: unawaited_futures
    Analytics.capture('ondevice_rag_search', {
      'ms': sw.elapsedMilliseconds,
      'hits': hits,
      'query_chars': query.length,
      'docs': docCount.value,
      'store': 'ava_fts',
      if (error) 'error': 1,
    });
  }
}
