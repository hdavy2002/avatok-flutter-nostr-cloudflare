/// AvaOnDeviceStt (Phase 2b) — on-device speech-to-text via Cactus Whisper.
///
/// Loads `whisper-tiny` (Cactus catalog, ~50–80 MB) on demand and transcribes a
/// recorded audio file fully offline. The transcript is then embedded into the
/// on-device vector store (see AvaOnDeviceRag), so voice notes become searchable
/// the same way typed notes and files are.
///
/// Kept SEPARATE from the LLM so STT memory is only paid while transcribing.
/// Local only, telemetry off.
library;

import 'package:cactus/cactus.dart';
import 'package:flutter/foundation.dart';

import 'ava_log.dart';

class AvaOnDeviceStt {
  AvaOnDeviceStt._();
  static final AvaOnDeviceStt I = AvaOnDeviceStt._();

  /// Cactus voice-model slug (catalog-supported, unlike Qwen3.5).
  static const String kSlug = 'whisper-tiny';

  CactusSTT? _stt;
  bool _ready = false;

  final ValueNotifier<String> statusLine = ValueNotifier<String>('');

  bool get isReady => _ready && (_stt?.isLoaded() ?? false);

  Future<bool> ensureReady() async {
    if (isReady) return true;
    try {
      CactusConfig.isTelemetryEnabled = false;
      final stt = _stt ??= CactusSTT();

      statusLine.value = 'Downloading Whisper…';
      await stt.downloadModel(
        model: kSlug,
        downloadProcessCallback: (progress, statusMessage, isError) {
          if (isError) {
            statusLine.value = 'Whisper download error: $statusMessage';
          } else {
            statusLine.value = progress != null
                ? 'Whisper ${(progress * 100).toStringAsFixed(0)}%'
                : statusMessage;
          }
        },
      );

      statusLine.value = 'Loading Whisper…';
      await stt.initializeModel(params: CactusInitParams(model: kSlug));
      _ready = stt.isLoaded();
      statusLine.value = _ready ? 'Whisper ready' : 'Whisper failed to load';
      AvaLog.I.log('ava_ondevice', 'stt ready=$_ready ($kSlug)');
      return _ready;
    } catch (e) {
      _ready = false;
      statusLine.value = 'Whisper error: $e';
      AvaLog.I.log('ava_ondevice', 'stt ensureReady FAILED: $e');
      return false;
    }
  }

  /// Transcribe a local audio file (wav, 16 kHz mono). Empty on failure.
  Future<String> transcribe(String audioFilePath) async {
    if (!await ensureReady()) return '';
    try {
      final r = await _stt!.transcribe(audioFilePath: audioFilePath);
      return r.success ? r.text.trim() : '';
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'transcribe FAILED: $e');
      return '';
    }
  }

  void unload() {
    try {
      _stt?.unload();
    } catch (_) {}
    _ready = false;
    statusLine.value = '';
  }
}
