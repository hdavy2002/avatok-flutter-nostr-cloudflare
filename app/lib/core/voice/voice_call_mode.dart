/// VoiceCallMode — which engine the "Voice call Ava" uses:
///   • online (default)  → Gemini Live native audio (~sub-second, audio to cloud)
///   • on-device         → Silero VAD + Whisper + Gemini + Supertonic (private,
///                          offline-capable, slower; needs the model download)
///
/// Per-account preference (parent + child share a phone), stored via [DiskCache].
/// Defaults to ONLINE because it's the fastest and needs no model download.
library;

import 'package:flutter/foundation.dart';

import '../disk_cache.dart';

class VoiceCallMode {
  VoiceCallMode._();
  static final VoiceCallMode I = VoiceCallMode._();

  static const _kKey = 'voice_call_online';

  /// true = fast online (Gemini Live); false = private on-device.
  final ValueNotifier<bool> online = ValueNotifier<bool>(true);

  bool _loaded = false;

  Future<void> load() async {
    try {
      final raw = await DiskCache.read(_kKey);
      // Default ON when unset.
      online.value = raw == null ? true : raw == '1';
    } catch (_) {/* keep default */}
    _loaded = true;
  }

  bool get isLoaded => _loaded;

  Future<void> set(bool v) async {
    online.value = v;
    try { await DiskCache.write(_kKey, v ? '1' : '0'); } catch (_) {}
  }
}
