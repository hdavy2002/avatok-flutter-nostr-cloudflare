/// On-device embedding-model download scaffolding (Phase 4 — Two-Lane Memory).
///
/// ── Why this lives OUTSIDE `core/local_brain/` ───────────────────────────────
/// One Brain B3 (§6.1) makes `core/local_brain/` a proven-networkless module: no
/// file under it may reach `dart:io HttpClient`, `package:http`, or any other
/// network-capable dependency (enforced by
/// `test/local_brain_networkless_test.dart`). The embedder itself is networkless
/// and stays in the module; the model-WEIGHT fetch (a `dart:io` HTTP GET) does
/// not, so it was split out here.
///
/// This code is REAL but DORMANT: the shipping embedder is a deterministic
/// hashing stub ([defaultEmbedder] in `local_brain/embedder.dart`) that never
/// downloads anything, and the [AvaEmbedModel.downloadUrl]s are placeholders
/// until the model host is confirmed. A future native runtime that needs weights
/// wires them from here — never from inside the networkless module.
library;

import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../ava_log.dart';

/// Which on-device model the embedder is configured to use. bge-small is the
/// ~40 MB default; EmbeddingGemma is the larger opt-in. The enum is consumed by
/// the download scaffolding; inference is stubbed (see `local_brain/embedder.dart`).
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
  /// must be set before native inference is wired.
  String get downloadUrl => switch (this) {
        AvaEmbedModel.bgeSmall =>
          'https://blossom.avatok.ai/models/$fileName', // TODO(P4-runtime): confirm host
        AvaEmbedModel.embeddingGemma =>
          'https://blossom.avatok.ai/models/$fileName', // TODO(P4-runtime): confirm host
      };
}

/// Manages the on-device model file: where it lives and whether it is present,
/// and fetches it on first use. The model is account-AGNOSTIC (the same weights
/// serve every account on the device), so it lives under a shared `_models`
/// dir, NOT a per-account dir — the embeddings it produces ARE per-account (see
/// `local_brain/local_index.dart`). Only the model binary is shared; no user
/// data is here.
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
