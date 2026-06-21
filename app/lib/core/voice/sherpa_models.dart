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
  static const _kKokoroTarUrl =
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2';
  // The tarball extracts into this top-level folder.
  static const _kKokoroDir = 'kokoro-multi-lang-v1_0';

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
  String kokoroModel = '';
  String kokoroVoices = '';
  String kokoroTokens = '';
  String kokoroDataDir = '';
  String kokoroDictDir = '';
  String kokoroLexicons = ''; // comma-joined, '' if none

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

  /// DOWNLOAD + extract the Kokoro TTS bundle (~330 MB). Called only from the
  /// explicit "Enable Ava Voice" flow — never silently on first synth.
  Future<bool> downloadTts() async {
    if (_ttsReady) return true;
    try {
      final base = await _baseDir();
      final kokoroRoot = p.join(base, _kKokoroDir);
      final model = p.join(kokoroRoot, 'model.onnx');
      if (!await File(model).exists()) {
        status.value = 'Downloading Ava Voice (one time)…';
        final tarPath = p.join(base, 'kokoro.tar.bz2');
        final ok = await _download(_kKokoroTarUrl, tarPath);
        if (!ok) { status.value = 'Voice download failed'; return false; }
        status.value = 'Unpacking Ava Voice…';
        progress.value = -1;
        await _extractTarBz2(tarPath, base);
        try { await File(tarPath).delete(); } catch (_) {}
      }
      await _setKokoroPaths(kokoroRoot);
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

  /// Resolve Kokoro paths from cache WITHOUT downloading. True if ready.
  Future<bool> resolveTts() async {
    if (_ttsReady) return true;
    final base = await _baseDir();
    final kokoroRoot = p.join(base, _kKokoroDir);
    if (!await File(p.join(kokoroRoot, 'model.onnx')).exists()) return false;
    await _setKokoroPaths(kokoroRoot);
    return _ttsReady;
  }

  /// True if every voice model (VAD + Whisper + Kokoro) is on disk. No download.
  Future<bool> isAllReady() async {
    final a = await resolveVadStt();
    final b = await resolveTts();
    return a && b;
  }

  Future<void> _setKokoroPaths(String kokoroRoot) async {
    kokoroModel = p.join(kokoroRoot, 'model.onnx');
    kokoroVoices = p.join(kokoroRoot, 'voices.bin');
    kokoroTokens = p.join(kokoroRoot, 'tokens.txt');
    kokoroDataDir = p.join(kokoroRoot, 'espeak-ng-data');
    final dict = Directory(p.join(kokoroRoot, 'dict'));
    kokoroDictDir = await dict.exists() ? dict.path : '';
    final lex = <String>[];
    for (final name in ['lexicon-us-en.txt', 'lexicon-zh.txt', 'lexicon.txt']) {
      final f = File(p.join(kokoroRoot, name));
      if (await f.exists()) lex.add(f.path);
    }
    kokoroLexicons = lex.join(',');
    _ttsReady = await File(kokoroModel).exists() && await File(kokoroVoices).exists();
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

  /// Decompress a .tar.bz2 and write every entry under [outDir]. Heavy (pure
  /// Dart bzip2) but runs once. Done off the UI isolate where possible.
  Future<void> _extractTarBz2(String tarBz2Path, String outDir) async {
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
}
