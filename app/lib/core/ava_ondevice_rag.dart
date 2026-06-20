/// AvaOnDeviceRag (Phase A — on-device vector memory).
///
/// Wraps Cactus's `CactusRAG` (a local ObjectBox + HNSW vector store) so the app
/// can INGEST text — pasted notes, file text, and whole conversations — into an
/// on-device vector index and SEARCH it offline. Embeddings come from the same
/// loaded Qwen3-0.6B via [AvaOnDeviceLlm.embed], so one model serves chat,
/// routing, and memory.
///
/// UX contract (the "ingestion progressing / complete" status the product wants):
///   • [ingestStatus] is a live string a screen can show under the file/text
///     being added ("Ingesting…", "Ingested ✓", or an error).
///   • [docCount] is the number of documents now searchable.
///   • A document only counts as "in the vector store" once [ingestText]
///     resolves successfully (status → "Ingested ✓").
///
/// SCOPING NOTE (productionization): `CactusRAG.initialize()` uses a default
/// ObjectBox store; for release this MUST be moved to a per-account directory
/// (AccountScope.id) per the per-account-scoping rule. The test harness uses the
/// default store — flagged in INTEGRATION notes, not for shipping as-is.
///
/// NOTE: image and PDF understanding are NOT here — Qwen3-0.6B is text-only.
/// Those arrive in the next slice (a Cactus vision model captions images, PDF
/// text is extracted, then the resulting TEXT is ingested through THIS service).
library;

import 'package:flutter/foundation.dart';
import 'package:cactus/cactus.dart';

import 'ava_log.dart';
import 'ava_ondevice_llm.dart';

class RagHit {
  final String content;
  final double distance; // squared Euclidean — LOWER = more similar
  final String source;
  const RagHit(
      {required this.content, required this.distance, required this.source});
}

class AvaOnDeviceRag {
  AvaOnDeviceRag._();
  static final AvaOnDeviceRag I = AvaOnDeviceRag._();

  final CactusRAG _rag = CactusRAG();
  bool _ready = false;

  /// Live ingestion status for the UI ("", "Ingesting <name>…", "Ingested ✓").
  final ValueNotifier<String> ingestStatus = ValueNotifier<String>('');

  /// How many documents are searchable right now.
  final ValueNotifier<int> docCount = ValueNotifier<int>(0);

  /// Initialise the store + bind the embedder (Qwen) once. Idempotent.
  Future<bool> ensureReady() async {
    if (_ready) return true;
    try {
      // The embedder needs the LLM loaded (it provides embeddings).
      if (!await AvaOnDeviceLlm.I.ensureReady()) return false;

      await _rag.initialize();
      _rag.setEmbeddingGenerator((text) => AvaOnDeviceLlm.I.embed(text));
      _rag.setChunking(chunkSize: 512, chunkOverlap: 64);
      _ready = true;
      await _refreshCount();
      AvaLog.I.log('ava_ondevice', 'RAG ready (docs=${docCount.value})');
      return true;
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'RAG init FAILED: $e');
      ingestStatus.value = 'Memory unavailable: $e';
      return false;
    }
  }

  /// Ingest a blob of text under a display [name]. Chunks + embeds + stores.
  /// Sets [ingestStatus] through the lifecycle so the UI can show progress.
  Future<bool> ingestText({required String name, required String content}) async {
    final text = content.trim();
    if (text.isEmpty) return false;
    if (!await ensureReady()) return false;
    try {
      ingestStatus.value = 'Ingesting “$name”…';
      await _rag.storeDocument(
        fileName: name,
        filePath: 'mem://$name',
        content: text,
        fileSize: text.length,
      );
      await _refreshCount();
      ingestStatus.value = 'Ingested “$name” ✓ (${docCount.value} in memory)';
      AvaLog.I.log('ava_ondevice', 'ingested "$name" (${text.length} chars)');
      return true;
    } catch (e) {
      ingestStatus.value = 'Ingest failed for “$name”: $e';
      AvaLog.I.log('ava_ondevice', 'ingest FAILED "$name": $e');
      return false;
    }
  }

  /// Ingest an entire conversation so the assistant has chat context (used for
  /// both local answers and as grounding when escalating to the cloud). The
  /// turns are joined into one document keyed by the conversation name.
  Future<bool> ingestConversation({
    required String convName,
    required List<String> turns,
  }) {
    final body = turns.where((t) => t.trim().isNotEmpty).join('\n');
    return ingestText(name: 'chat: $convName', content: body);
  }

  /// Vector search. Returns top-[limit] chunks, most similar first.
  Future<List<RagHit>> search(String query, {int limit = 5}) async {
    if (!await ensureReady()) return const [];
    try {
      final results = await _rag.search(text: query, limit: limit);
      return results
          .map((r) => RagHit(
                content: r.chunk.content,
                distance: r.distance,
                source: r.chunk.document.target?.fileName ?? 'memory',
              ))
          .toList(growable: false);
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'search FAILED: $e');
      return const [];
    }
  }

  /// Convenience: top hits joined into a grounding context block for a prompt.
  Future<String> contextFor(String query, {int limit = 4}) async {
    final hits = await search(query, limit: limit);
    if (hits.isEmpty) return '';
    return hits.map((h) => '• (${h.source}) ${h.content}').join('\n');
  }

  Future<void> _refreshCount() async {
    try {
      final stats = await _rag.getStats();
      docCount.value = stats.totalDocuments;
    } catch (_) {/* best-effort */}
  }
}
