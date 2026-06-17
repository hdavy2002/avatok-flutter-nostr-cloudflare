/// Ava on-device text embedder (Phase 4 — Two-Lane Memory).
///
/// The free, on-device memory lane uses FTS5 keyword search FIRST and falls
/// back to a small dense-vector index on a miss. This file owns the embedder
/// behind a tiny interface so the index code never cares which model produced
/// a vector, and so the real model runtime can be swapped in later without
/// touching `local_index.dart`.
///
/// ── What ships today vs. what is stubbed ─────────────────────────────────────
/// Real on-device embedding inference needs a native model runtime (LiteRT /
/// TFLite, ONNX Runtime, or llama.cpp-style GGUF) plus the model file itself.
/// Wiring a native inference engine cannot be done or verified headless (no
/// local Flutter/Gradle toolchain here — see project memory), and pinning a
/// native ML dep we can't compile would risk breaking the whole APK build. So:
///
///   • The INTERFACE, the download-on-first-use scaffolding, the availability
///     check, the per-account model cache path, and the wiring into the vector
///     index are all REAL and complete.
///   • The actual `embed()` inference is a DETERMINISTIC HASH STUB
///     ([_HashingEmbedder]) — a 256-D, L2-normalised "hashing trick" vector. It
///     is stable (same text → same vector) so the brute-force-cosine vector
///     path is fully exercisable end-to-end, but it is NOT semantic. Until the
///     native runtime lands, FTS5 keyword search carries real-world recall and
///     vector search degrades gracefully (lexical-ish similarity, never a crash).
///
/// Swapping in a real model later is a one-class change: implement
/// [AvaEmbedder] over the native runtime, point [defaultEmbedder] at it, and the
/// 256-D contract + download flow stay identical. See INTEGRATION-NOTES.md.
library;

import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import '../ava_log.dart';

/// Fixed embedding dimensionality for the on-device lane. 256-D keeps the
/// brute-force cosine cheap for on-device message volumes and matches the
/// Phase-4 spec. (bge-small is natively 384-D and EmbeddingGemma 768-D; a real
/// runtime would project/truncate to 256 so the on-device store stays uniform.)
const int kAvaEmbedDim = 256;

/// Which on-device model the embedder is configured to use. bge-small is the
/// ~40 MB default; EmbeddingGemma is the larger opt-in. The enum is consumed by
/// the download scaffolding; inference is stubbed (see file header).
enum AvaEmbedModel {
  /// BAAI bge-small-en-v1.5, ~40 MB. Default. (Matches the SERVER lane model
  /// `@cf/baai/bge-small-en-v1.5` so the two lanes stay conceptually aligned.)
  bgeSmall,

  /// EmbeddingGemma — larger, higher-quality, opt-in (heavier download).
  embeddingGemma,
}

extension on AvaEmbedModel {
  String get fileName => switch (this) {
        AvaEmbedModel.bgeSmall => 'bge-small-en-v1.5-int8.onnx',
        AvaEmbedModel.embeddingGemma => 'embeddinggemma-256.onnx',
      };

  /// Download origin for the model file. These are PLACEHOLDERS — the real
  /// hosting URL (a public R2/CDN path under blossom.avatok.ai, or a HF mirror)
  /// must be set before native inference is wired. Documented in INTEGRATION-NOTES.
  String get downloadUrl => switch (this) {
        AvaEmbedModel.bgeSmall =>
          'https://blossom.avatok.ai/models/$fileName', // TODO(P4-runtime): confirm host
        AvaEmbedModel.embeddingGemma =>
          'https://blossom.avatok.ai/models/$fileName', // TODO(P4-runtime): confirm host
      };
}

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
// Download-on-first-use scaffolding (REAL — reused by a future native runtime).
// ─────────────────────────────────────────────────────────────────────────────

/// Manages the on-device model file: where it lives and whether it is present,
/// and fetches it on first use. The model is account-AGNOSTIC (the same weights
/// serve every account on the device), so it lives under a shared `_models`
/// dir, NOT a per-account dir — the embeddings it produces ARE per-account (see
/// local_index.dart). Only the model binary is shared; no user data is here.
class AvaModelStore {
  AvaModelStore._();
  static final AvaModelStore I = AvaModelStore._();

  Future<String>? _dirFut;
  Future<String> _modelsDir() => _dirFut ??= () async {
        final base = await getApplicationSupportDirectory();
        final dir = Directory('${base.path}/ava_models');
        if (!await dir.exists()) await dir.create(recursive: true);
        return dir.path;
      }();

  /// Absolute path the given model file would live at (whether or not present).
  Future<String> pathFor(AvaEmbedModel model) async =>
      '${await _modelsDir()}/${model.fileName}';

  /// Whether the model file is already on disk.
  Future<bool> isDownloaded(AvaEmbedModel model) async {
    try {
      final f = File(await pathFor(model));
      return await f.exists() && await f.length() > 0;
    } catch (_) {
      return false;
    }
  }

  bool _downloading = false;

  /// Fetch the model file once (download-on-first-use). Best-effort and
  /// non-throwing: returns true if the file is present afterwards. A single
  /// in-flight guard prevents concurrent double-downloads.
  ///
  /// NOTE: this performs a plain streamed HTTP GET via dart:io (no extra dep).
  /// It is wired and correct, but the [downloadUrl]s are placeholders until the
  /// model host is confirmed — so today the stub embedder never calls this.
  Future<bool> ensureDownloaded(AvaEmbedModel model) async {
    if (await isDownloaded(model)) return true;
    if (_downloading) return false;
    _downloading = true;
    try {
      final dest = File(await pathFor(model));
      final tmp = File('${dest.path}.part');
      final client = HttpClient();
      try {
        final req = await client.getUrl(Uri.parse(model.downloadUrl));
        final resp = await req.close();
        if (resp.statusCode != 200) {
          AvaLog.I.log('ava_mem', 'model download ${model.fileName} HTTP ${resp.statusCode}');
          return false;
        }
        final sink = tmp.openWrite();
        await resp.pipe(sink);
        await sink.flush();
        await sink.close();
        if (await tmp.length() == 0) return false;
        await tmp.rename(dest.path);
        AvaLog.I.log('ava_mem', 'model ${model.fileName} downloaded ✓');
        return true;
      } finally {
        client.close(force: true);
      }
    } catch (e) {
      AvaLog.I.log('ava_mem', 'model download FAILED ${model.fileName}: $e');
      return false;
    } finally {
      _downloading = false;
    }
  }
}

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
