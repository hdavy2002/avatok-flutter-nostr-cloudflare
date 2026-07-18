/// Ava on-device text embedder (Phase 4 — Two-Lane Memory; moved into the
/// networkless `local_brain/` module by One Brain B3, §6.1).
///
/// The free, on-device memory lane uses FTS5 keyword search FIRST and falls
/// back to a small dense-vector index on a miss. This file owns the embedder
/// behind a tiny interface so the index code never cares which model produced
/// a vector, and so the real model runtime can be swapped in later without
/// touching `local_index.dart`.
///
/// ── NETWORKLESS BOUNDARY (One Brain §6.1) ────────────────────────────────────
/// This file lives inside `app/lib/core/local_brain/`, the device-private brain.
/// It MUST NOT import any network-capable package (no `package:http`, `dio`,
/// `web_socket_channel`, and no `dart:io` `HttpClient`/`Socket`). It imports only
/// `dart:math` + `dart:typed_data`. The model download-on-first-use scaffolding
/// (which DID use `dart:io HttpClient`) was split out to
/// `../ava_memory/embedder_model_store.dart` — it is unused today (placeholder
/// hosts) and deliberately kept OUTSIDE this module so the networkless proof
/// (`test/local_brain_networkless_test.dart`) holds. A future native runtime that
/// needs to fetch weights lives there, never here.
///
/// ── What ships today ─────────────────────────────────────────────────────────
/// The actual `embed()` inference is a DETERMINISTIC HASH STUB
/// ([_HashingEmbedder]) — a 256-D, L2-normalised "hashing trick" vector. It is
/// stable (same text → same vector) so the brute-force-cosine vector path is
/// fully exercisable end-to-end, but it is NOT semantic. Until a native runtime
/// lands, FTS5 keyword search carries real-world recall and vector search
/// degrades gracefully (lexical-ish similarity, never a crash).
///
/// Swapping in a real model later is a one-class change: implement [AvaEmbedder]
/// over the native runtime, point [defaultEmbedder] at it, and the 256-D contract
/// stays identical. The (networkful) weight fetch stays in the model store file.
library;

import 'dart:math' as math;
import 'dart:typed_data';

/// Fixed embedding dimensionality for the on-device lane. 256-D keeps the
/// brute-force cosine cheap for on-device message volumes and matches the
/// Phase-4 spec. (bge-small is natively 384-D and EmbeddingGemma 768-D; a real
/// runtime would project/truncate to 256 so the on-device store stays uniform.)
const int kAvaEmbedDim = 256;

/// The embedder contract. One method: turn text into a [kAvaEmbedDim]-D vector.
abstract class AvaEmbedder {
  /// Whether this embedder can produce vectors right now (model present /
  /// runtime loaded). The hashing stub is always available; a real model
  /// returns false until [ensureReady] has fetched + loaded its weights.
  bool get isReady;

  /// Download-on-first-use + load. Idempotent; safe to call repeatedly. Returns
  /// true when the embedder is ready to embed. The stub returns true instantly.
  Future<bool> ensureReady();

  /// Embed [text] → a [kAvaEmbedDim]-D L2-normalised vector. Must never throw:
  /// on any failure it returns a zero vector (the index treats that as "no
  /// vector" and relies on FTS5 instead).
  Future<List<double>> embed(String text);
}

/// The process-wide default embedder. Today: the deterministic hashing stub
/// (always ready, no download, no native dep). To enable real semantic search,
/// replace the construction here with a native-runtime implementation of
/// [AvaEmbedder] — nothing else in Phase 4 changes.
AvaEmbedder defaultEmbedder = _HashingEmbedder();

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic hashing stub (the only inference that ships today).
// ─────────────────────────────────────────────────────────────────────────────

/// A zero-dependency, deterministic 256-D embedder using the classic "hashing
/// trick": each token is hashed into a bucket with a signed contribution, then
/// the vector is L2-normalised. Stable, fast, and good enough to exercise the
/// vector path end-to-end (cosine top-k works), but NOT semantic — it captures
/// lexical overlap only. This is the documented stub; a real model replaces it.
class _HashingEmbedder implements AvaEmbedder {
  @override
  bool get isReady => true; // no model file, no runtime — always ready.

  @override
  Future<bool> ensureReady() async => true;

  @override
  Future<List<double>> embed(String text) async {
    final vec = Float64List(kAvaEmbedDim);
    final tokens = _tokenize(text);
    if (tokens.isEmpty) return vec.toList(growable: false); // zero vector
    for (final tok in tokens) {
      final h = _fnv1a(tok);
      final bucket = h % kAvaEmbedDim;
      final sign = ((h >> 31) & 1) == 0 ? 1.0 : -1.0;
      vec[bucket] += sign;
    }
    // L2 normalise so cosine == dot product downstream.
    double norm = 0;
    for (final v in vec) {
      norm += v * v;
    }
    norm = math.sqrt(norm);
    if (norm > 0) {
      for (var i = 0; i < vec.length; i++) {
        vec[i] = vec[i] / norm;
      }
    }
    return vec.toList(growable: false);
  }

  static List<String> _tokenize(String text) => text
      .toLowerCase()
      .split(RegExp(r'[^a-z0-9]+'))
      .where((t) => t.length > 1)
      .toList(growable: false);

  /// 32-bit FNV-1a — cheap, stable, well-distributed for the hashing trick.
  static int _fnv1a(String s) {
    var h = 0x811c9dc5;
    for (final c in s.codeUnits) {
      h ^= c & 0xff;
      h = (h * 0x01000193) & 0xffffffff;
    }
    return h;
  }
}
