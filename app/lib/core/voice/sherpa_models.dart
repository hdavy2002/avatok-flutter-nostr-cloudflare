/// VoiceModels — downloads & caches the on-device sherpa-onnx model files.
///
/// The voice stack (Silero VAD + Whisper-tiny STT + Kokoro-82M TTS) needs model
/// files on local disk. They are too big to bundle in the APK (Kokoro alone is
/// ~330 MB), so we fetch them once on first use and cache under the app-support
/// dir. Everything here is defensive: a failed or offline download just leaves
/// the feature "not ready" (the UI degrades gracefully), never crashes.
///
/// ⚠️ VERIFY IN CI / ON DEVICE: the download URLs + in-archive filenames below are
/// the k2-fsa canonical names as of 2026-06; if a release renames a file this is
/// the ONE place to fix. Kokoro is a tar.bz2 → extracted with `archive` (heavy,
/// one-time). VAD + Whisper are single files (no extraction).
library;

import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../ava_log.dart';

/// A single downloadable file (VAD / Whisper parts).
class _RemoteFile {
  final String url;
  final String dest; // path relative to the voice base dir
  const _RemoteFile(this.url, this.dest);
}

class VoiceModels {
  VoiceModels._();
  static final VoiceModels I = VoiceModels._();

  // ── Canonical k2-fsa sources (VERIFY names if a release changes) ──────────
  static const _kVad = _RemoteFile(
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    'silero_vad.onnx',
  );
  // Multilingual whisper-tiny (matches the multilingual Kokoro voices).
  static const _kWhisper = <_RemoteFile>[
    _RemoteFile(
      'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-encoder.int8.onnx',
      'whisper/tiny-encoder.int8.onnx',
    ),
    _RemoteFile(
      'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-decoder.int8.onnx',
      'whisper/tiny-decoder.int8.onnx',
    ),
    _RemoteFile(
      'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-tokens.txt',
      'whisper/tiny-tokens.txt',
    ),
  ];
  // TTS = SupertonicTTS-3 (owner decision 2026-06-21, replacing Kokoro): ~10x
  // smaller + far faster, int8, multi-speaker, 31 languages, no espeak-ng-data dir.
  static const _kTtsTarUrl =
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2';
  // The tarball extracts into this top-level folder.
  static const _kTtsDir = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11';

  String? _base;
  Future<String> _baseDir() async {
    if (_base != null) return _base!;
    final d = await getApplicationSupportDirectory();
    _base = p.join(d.path, 'ava_voice');
    await Directory(_base!).create(recursive: true);
    return _base!;
  }

  // Live status for whichever ensure*() is running.
  final ValueNotifier<String> status = ValueNotifier<String>('');
  final ValueNotifier<double> progress = ValueNotifier<double>(0); // 0..1, -1 = indeterminate

  bool _vadSttReady = false;
  bool _ttsReady = false;
  bool get isVadSttReady => _vadSttReady;
  bool get isTtsReady => _ttsReady;

  // Resolved paths (valid after the matching ensure*() returns true).
  String vadPath = '';
  String whisperEncoder = '';
  String whisperDecoder = '';
  String whisperTokens = '';
  // SupertonicTTS-3 files (no tokens/voices/espeak-data — different from Kokoro).
  String ttsDurationPredictor = '';
  String ttsTextEncoder = '';
  String ttsVectorEstimator = '';
  String ttsVocoder = '';
  String ttsJson = '';
  String ttsUnicodeIndexer = '';
  String ttsVoiceStyle = '';

  /// Download (if needed) the VAD + Whisper files. Cheap when already cached.
  Future<bool> ensureVadAndStt() async {
    if (_vadSttReady) return true;
    try {
      final base = await _baseDir();
      status.value = 'Preparing speech models…';
      vadPath = await _ensureFile(_kVad, base);
      whisperEncoder = await _ensureFile(_kWhisper[0], base);
      whisperDecoder = await _ensureFile(_kWhisper[1], base);
      whisperTokens = await _ensureFile(_kWhisper[2], base);
      _vadSttReady = vadPath.isNotEmpty &&
          whisperEncoder.isNotEmpty &&
          whisperDecoder.isNotEmpty &&
          whisperTokens.isNotEmpty;
      status.value = _vadSttReady ? '' : 'Speech model download failed';
      return _vadSttReady;
    } catch (e) {
      AvaLog.I.log('voice_models', 'ensureVadAndStt FAILED: $e');
      status.value = 'Speech model download failed';
      return false;
    } finally {
      progress.value = 0;
    }
  }

  /// Resolve VAD + Whisper paths from cache WITHOUT downloading. Returns true if
  /// all files already exist on disk (so the engine can load on demand).
  Future<bool> resolveVadStt() async {
    if (_vadSttReady) return true;
    final base = await _baseDir();
    vadPath = await _existing(base, _kVad.dest);
    whisperEncoder = await _existing(base, _kWhisper[0].dest);
    whisperDecoder = await _existing(base, _kWhisper[1].dest);
    whisperTokens = await _existing(base, _kWhisper[2].dest);
    _vadSttReady = vadPath.isNotEmpty &&
        whisperEncoder.isNotEmpty &&
        whisperDecoder.isNotEmpty &&
        whisperTokens.isNotEmpty;
    return _vadSttReady;
  }

  /// DOWNLOAD + extract the SupertonicTTS-3 bundle (small int8 ~tens of MB).
  /// Called only from the explicit "Enable Ava Voice" flow — never silently.
  Future<bool> downloadTts() async {
    if (_ttsReady) return true;
    try {
      final base = await _baseDir();
      final ttsRoot = p.join(base, _kTtsDir);
      final encoder = p.join(ttsRoot, 'text_encoder.int8.onnx');
      if (!await File(encoder).exists()) {
        status.value = 'Downloading Ava Voice (one time)…';
        final tarPath = p.join(base, 'supertonic.tar.bz2');
        final ok = await _download(_kTtsTarUrl, tarPath);
        if (!ok) { status.value = 'Voice download failed'; return false; }
        status.value = 'Unpacking Ava Voice…';
        progress.value = -1;
        await _extractTarBz2(tarPath, base);
        try { await File(tarPath).delete(); } catch (_) {}
      }
      await _setTtsPaths(ttsRoot);
      status.value = _ttsReady ? '' : 'Voice files incomplete';
      return _ttsReady;
    } catch (e) {
      AvaLog.I.log('voice_models', 'downloadTts FAILED: $e');
      status.value = 'Voice download failed';
      return false;
    } finally {
      progress.value = 0;
    }
  }

  /// Resolve Supertonic paths from cache WITHOUT downloading. True if ready.
  Future<bool> resolveTts() async {
    if (_ttsReady) return true;
    final base = await _baseDir();
    final ttsRoot = p.join(base, _kTtsDir);
    if (!await File(p.join(ttsRoot, 'text_encoder.int8.onnx')).exists()) return false;
    await _setTtsPaths(ttsRoot);
    return _ttsReady;
  }

  /// True if every voice model (VAD + Whisper + Supertonic) is on disk. No download.
  Future<bool> isAllReady() async {
    final a = await resolveVadStt();
    final b = await resolveTts();
    return a && b;
  }

  Future<void> _setTtsPaths(String ttsRoot) async {
    ttsDurationPredictor = p.join(ttsRoot, 'duration_predictor.int8.onnx');
    ttsTextEncoder = p.join(ttsRoot, 'text_encoder.int8.onnx');
    ttsVectorEstimator = p.join(ttsRoot, 'vector_estimator.int8.onnx');
    ttsVocoder = p.join(ttsRoot, 'vocoder.int8.onnx');
    ttsJson = p.join(ttsRoot, 'tts.json');
    ttsUnicodeIndexer = p.join(ttsRoot, 'unicode_indexer.bin');
    ttsVoiceStyle = p.join(ttsRoot, 'voice.bin');
    _ttsReady = await File(ttsTextEncoder).exists() && await File(ttsVocoder).exists();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  Future<String> _ensureFile(_RemoteFile rf, String base) async {
    final dest = p.join(base, rf.dest);
    final f = File(dest);
    if (await f.exists() && await f.length() > 0) return dest;
    final ok = await _download(rf.url, dest);
    return ok ? dest : '';
  }

  /// Path if the file already exists (and is non-empty), else '' — no download.
  Future<String> _existing(String base, String rel) async {
    final pth = p.join(base, rel);
    final f = File(pth);
    return (await f.exists() && await f.length() > 0) ? pth : '';
  }

  /// Stream a URL to [dest], updating [progress]. Returns false on any error.
  Future<bool> _download(String url, String dest) async {
    final client = http.Client();
    try {
      await File(dest).parent.create(recursive: true);
      final req = http.Request('GET', Uri.parse(url));
      final resp = await client.send(req);
      if (resp.statusCode != 200) {
        AvaLog.I.log('voice_models', 'download ${resp.statusCode} $url');
        return false;
      }
      final total = resp.contentLength ?? 0;
      var received = 0;
      final sink = File(dest).openWrite();
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        received += chunk.length;
        progress.value = total > 0 ? received / total : -1;
      }
      await sink.flush();
      await sink.close();
      return true;
    } catch (e) {
      AvaLog.I.log('voice_models', 'download FAILED $url: $e');
      try { await File(dest).delete(); } catch (_) {}
      return false;
    } finally {
      client.close();
    }
  }

  /// Decompress a .tar.bz2 and write every entry under [outDir].
  ///
  /// CRITICAL: pure-Dart bzip2 on a ~330 MB bundle is CPU-heavy and was running on
  /// the UI isolate — that froze the app (Android "App isn't responding — wait or
  /// close?"). It now runs on a BACKGROUND isolate via [compute] so the UI stays
  /// responsive and just shows the indeterminate "Unpacking…" state.
  Future<void> _extractTarBz2(String tarBz2Path, String outDir) async {
    await compute(_extractTarBz2Isolate, <String>[tarBz2Path, outDir]);
  }
}

/// Top-level isolate entry point for [compute] — must not touch any instance
/// state. Decompresses [args] = [tarBz2Path, outDir] and writes every entry.
Future<void> _extractTarBz2Isolate(List<String> args) async {
  final tarBz2Path = args[0];
  final outDir = args[1];
  final bytes = await File(tarBz2Path).readAsBytes();
  final tarBytes = BZip2Decoder().decodeBytes(bytes);
  final archive = TarDecoder().decodeBytes(tarBytes);
  for (final entry in archive) {
    final outPath = p.join(outDir, entry.name);
    if (entry.isFile) {
      final f = File(outPath);
      await f.parent.create(recursive: true);
      await f.writeAsBytes(entry.content as List<int>);
    } else {
      await Directory(outPath).create(recursive: true);
    }
  }
}
