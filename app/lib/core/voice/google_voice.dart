/// GoogleVoicePref — which prebuilt Google (Gemini Live) voice Ava uses on a voice
/// call. The voice call is ONLINE-only (Gemini Live native audio); there is no
/// on-device TTS. The chosen voice name is sent to /api/ava/live/token and locked
/// into the session's speechConfig server-side.
///
/// Per-account preference via [DiskCache]. Default = Aoede (a warm female voice).
library;

import 'package:flutter/foundation.dart';

import '../analytics.dart';
import '../disk_cache.dart';

/// One selectable Gemini Live voice.
@immutable
class GoogleVoice {
  final String name; // the Gemini prebuilt voice id, e.g. "Aoede"
  final bool female;
  const GoogleVoice(this.name, {required this.female});
}

class GoogleVoiceCatalog {
  GoogleVoiceCatalog._();

  // Curated subset of Gemini Live prebuilt voices, grouped by gender.
  static const List<GoogleVoice> female = [
    GoogleVoice('Aoede', female: true),
    GoogleVoice('Kore', female: true),
    GoogleVoice('Leda', female: true),
    GoogleVoice('Zephyr', female: true),
    GoogleVoice('Callirrhoe', female: true),
    GoogleVoice('Autonoe', female: true),
  ];
  static const List<GoogleVoice> male = [
    GoogleVoice('Puck', female: false),
    GoogleVoice('Charon', female: false),
    GoogleVoice('Fenrir', female: false),
    GoogleVoice('Orus', female: false),
    GoogleVoice('Enceladus', female: false),
    GoogleVoice('Iapetus', female: false),
  ];

  static const String defaultVoice = 'Aoede';

  static bool isValid(String name) =>
      female.any((v) => v.name == name) || male.any((v) => v.name == name);
}

class GoogleVoicePref {
  GoogleVoicePref._();

  static const _kKey = 'google_voice_name';

  /// Live value any screen can listen to. Default Aoede (female).
  static final ValueNotifier<String> voice =
      ValueNotifier<String>(GoogleVoiceCatalog.defaultVoice);

  static String get current => voice.value;

  static Future<void> load() async {
    try {
      final raw = await DiskCache.read(_kKey);
      voice.value = (raw != null && GoogleVoiceCatalog.isValid(raw))
          ? raw
          : GoogleVoiceCatalog.defaultVoice;
    } catch (_) {/* keep default */}
  }

  static Future<void> set(String name) async {
    if (!GoogleVoiceCatalog.isValid(name)) return;
    voice.value = name;
    try { await DiskCache.write(_kKey, name); } catch (_) {}
    Analytics.capture('google_voice_set', {'voice': name});
  }
}
