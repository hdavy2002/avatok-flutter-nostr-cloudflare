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

/// One selectable Gemini Live voice. [style] is Google's published voice
/// characteristic (e.g. "Bright", "Firm"); shown so the user can pick by feel.
@immutable
class GoogleVoice {
  final String name; // the Gemini prebuilt voice id, e.g. "Aoede"
  final bool female;
  final String style;
  const GoogleVoice(this.name, {required this.female, this.style = ''});
}

/// All 30 prebuilt Gemini Live voices (verified accepted by gemini-3.1-flash-live
/// via a live BidiGenerateContent handshake). Grouped female/male (best-effort —
/// Google labels style, not gender); each carries its published style.
class GoogleVoiceCatalog {
  GoogleVoiceCatalog._();

  static const List<GoogleVoice> female = [
    GoogleVoice('Aoede', female: true, style: 'Breezy'),
    GoogleVoice('Kore', female: true, style: 'Firm'),
    GoogleVoice('Leda', female: true, style: 'Youthful'),
    GoogleVoice('Zephyr', female: true, style: 'Bright'),
    GoogleVoice('Autonoe', female: true, style: 'Bright'),
    GoogleVoice('Callirrhoe', female: true, style: 'Easy-going'),
    GoogleVoice('Despina', female: true, style: 'Smooth'),
    GoogleVoice('Erinome', female: true, style: 'Clear'),
    GoogleVoice('Laomedeia', female: true, style: 'Upbeat'),
    GoogleVoice('Achernar', female: true, style: 'Soft'),
    GoogleVoice('Gacrux', female: true, style: 'Mature'),
    GoogleVoice('Pulcherrima', female: true, style: 'Forward'),
    GoogleVoice('Vindemiatrix', female: true, style: 'Gentle'),
    GoogleVoice('Sulafat', female: true, style: 'Warm'),
    GoogleVoice('Achird', female: true, style: 'Friendly'),
    GoogleVoice('Sadachbia', female: true, style: 'Lively'),
  ];
  static const List<GoogleVoice> male = [
    GoogleVoice('Puck', female: false, style: 'Upbeat'),
    GoogleVoice('Charon', female: false, style: 'Informative'),
    GoogleVoice('Fenrir', female: false, style: 'Excitable'),
    GoogleVoice('Orus', female: false, style: 'Firm'),
    GoogleVoice('Enceladus', female: false, style: 'Breathy'),
    GoogleVoice('Iapetus', female: false, style: 'Clear'),
    GoogleVoice('Umbriel', female: false, style: 'Easy-going'),
    GoogleVoice('Algieba', female: false, style: 'Smooth'),
    GoogleVoice('Algenib', female: false, style: 'Gravelly'),
    GoogleVoice('Rasalgethi', female: false, style: 'Informative'),
    GoogleVoice('Alnilam', female: false, style: 'Firm'),
    GoogleVoice('Schedar', female: false, style: 'Even'),
    GoogleVoice('Zubenelgenubi', female: false, style: 'Casual'),
    GoogleVoice('Sadaltager', female: false, style: 'Knowledgeable'),
  ];

  static const String defaultVoice = 'Aoede';

  static bool isValid(String name) =>
      female.any((v) => v.name == name) || male.any((v) => v.name == name);

  static GoogleVoice? byName(String name) {
    for (final v in [...female, ...male]) {
      if (v.name == name) return v;
    }
    return null;
  }
}

/// A spoken language for the voice call. [code] is a BCP-47 tag (e.g. "en-US");
/// '' means Auto (let Gemini detect from what the user speaks).
@immutable
class AvaLang {
  final String code;
  final String label;
  const AvaLang(this.code, this.label);
}

/// Languages offered for the Ava voice call. Every code here is verified to
/// complete the Gemini Live handshake (gemini-3.1-flash-live-preview), so the
/// picker can never break a call.
class AvaLangCatalog {
  AvaLangCatalog._();

  static const List<AvaLang> all = [
    AvaLang('', 'Auto-detect'),
    AvaLang('en-US', 'English (US)'),
    AvaLang('en-GB', 'English (UK)'),
    AvaLang('es-ES', 'Spanish (Spain)'),
    AvaLang('es-US', 'Spanish (US)'),
    AvaLang('fr-FR', 'French'),
    AvaLang('de-DE', 'German'),
    AvaLang('it-IT', 'Italian'),
    AvaLang('pt-BR', 'Portuguese (Brazil)'),
    AvaLang('nl-NL', 'Dutch'),
    AvaLang('pl-PL', 'Polish'),
    AvaLang('ru-RU', 'Russian'),
    AvaLang('tr-TR', 'Turkish'),
    AvaLang('ar-XA', 'Arabic'),
    AvaLang('hi-IN', 'Hindi'),
    AvaLang('bn-IN', 'Bengali'),
    AvaLang('ta-IN', 'Tamil'),
    AvaLang('te-IN', 'Telugu'),
    AvaLang('mr-IN', 'Marathi'),
    AvaLang('gu-IN', 'Gujarati'),
    AvaLang('kn-IN', 'Kannada'),
    AvaLang('ml-IN', 'Malayalam'),
    AvaLang('id-ID', 'Indonesian'),
    AvaLang('vi-VN', 'Vietnamese'),
    AvaLang('th-TH', 'Thai'),
    AvaLang('ja-JP', 'Japanese'),
    AvaLang('ko-KR', 'Korean'),
    AvaLang('cmn-CN', 'Chinese (Mandarin)'),
  ];

  static const String defaultCode = ''; // Auto

  static bool isValid(String code) => all.any((l) => l.code == code);

  static AvaLang? byCode(String code) {
    for (final l in all) {
      if (l.code == code) return l;
    }
    return null;
  }

  static String labelFor(String code) => byCode(code)?.label ?? 'Auto-detect';
}

/// Per-account preferred call language. '' = Auto. Sent to /api/ava/live/token
/// (locked into the session's speechConfig.languageCode + system prompt).
class AvaVoiceLangPref {
  AvaVoiceLangPref._();

  static const _kKey = 'ava_voice_lang';

  static final ValueNotifier<String> lang =
      ValueNotifier<String>(AvaLangCatalog.defaultCode);

  static String get current => lang.value;

  static Future<void> load() async {
    try {
      final raw = await DiskCache.read(_kKey);
      lang.value = (raw != null && AvaLangCatalog.isValid(raw))
          ? raw
          : AvaLangCatalog.defaultCode;
    } catch (_) {/* keep default */}
  }

  static Future<void> set(String code) async {
    if (!AvaLangCatalog.isValid(code)) return;
    lang.value = code;
    try { await DiskCache.write(_kKey, code); } catch (_) {}
    Analytics.capture('ava_voice_lang_set', {'lang': code.isEmpty ? 'auto' : code});
  }
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
