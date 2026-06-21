/// Kokoro voice + language preference (Settings → Ava voice → "Voice & language").
///
/// TTS ENGINE — KOKORO (2026-06-21 owner decision). The earlier Supertonic-3 TTS
/// plan is dropped: AvaVerse standardises on **Kokoro** (Kokoro-82M) because it is
/// multilingual and the quality is good. This file is the SOURCE OF TRUTH for:
///   • the Kokoro voice catalog (language → male/female named voices), and
///   • the per-account PREFERENCE (which language + which voice the user picked).
///
/// Nothing here synthesises audio — that is the Kokoro engine, a later build. When
/// it comes online it reads [KokoroVoicePref.current] and speaks in the chosen
/// character/language (see [AvaVoice.synthesizer] in voice_section.dart). Storing
/// the preference now means the moment TTS is live the user already hears "their"
/// voice. Default = English (American), female "Heart".
///
/// SCOPING: the choice is per-account (a parent + each child share one phone), so
/// it is persisted via [DiskCache] which namespaces under `cache/<AccountScope.id>/`
/// automatically — never a raw global key (per the engineering rulebook).
library;

import 'package:flutter/foundation.dart';

import 'analytics.dart';
import 'disk_cache.dart';

/// One selectable Kokoro voice.
@immutable
class KokoroVoice {
  /// Kokoro voice id, e.g. `af_heart`, `bm_george`, `em_alex`.
  final String id;

  /// Friendly display name shown in the picker, e.g. "Heart", "George".
  final String name;

  /// `true` = female character, `false` = male. Drives the gender label/icon.
  final bool female;

  /// Speaker index passed to the sherpa-onnx Kokoro TTS (`sid`). ⚠️ VERIFY: these
  /// indices must match the voice ordering packed in the kokoro-multi-lang voices.bin.
  /// They are a best-effort id-sorted mapping; if a voice sounds wrong, fix the sid
  /// here against the model's published voice list. A wrong sid only picks a
  /// different voice — it never crashes.
  final int sid;

  const KokoroVoice(this.id, this.name, {required this.female, this.sid = 0});
}

/// One language group in the catalog.
@immutable
class KokoroLanguage {
  /// Stable language key stored in the preference, e.g. `en-us`, `es`, `hi`.
  final String code;

  /// Display name, e.g. "English (US)".
  final String name;

  /// The Whisper STT language code to use when this language is selected for
  /// voice-to-text (e.g. `en`, `es`, `hi`). Keeps STT + TTS language in sync.
  final String sttLang;

  /// Voices available for this language (female first, then male).
  final List<KokoroVoice> voices;

  const KokoroLanguage(this.code, this.name, this.sttLang, this.voices);
}

/// A resolved selection (language + voice), what the TTS/STT layers read.
@immutable
class KokoroSelection {
  final KokoroLanguage language;
  final KokoroVoice voice;
  const KokoroSelection(this.language, this.voice);

  /// Whisper STT language code for the chosen language.
  String get sttLang => language.sttLang;

  /// Kokoro TTS speaker index for the chosen voice.
  int get sid => voice.sid;
}

/// The Kokoro-82M voice catalog (curated subset — female + male per language).
class KokoroCatalog {
  KokoroCatalog._();

  // NOTE: `sid` values are a best-effort, id-sorted mapping into the Kokoro
  // multi-lang voices.bin. They MUST be validated on device against the model's
  // published voice list — a wrong sid only selects a different voice.
  static const List<KokoroLanguage> languages = [
    KokoroLanguage('en-us', 'English (US)', 'en', [
      KokoroVoice('af_heart', 'Heart', female: true, sid: 0),
      KokoroVoice('af_bella', 'Bella', female: true, sid: 1),
      KokoroVoice('af_nicole', 'Nicole', female: true, sid: 2),
      KokoroVoice('af_sarah', 'Sarah', female: true, sid: 3),
      KokoroVoice('am_michael', 'Michael', female: false, sid: 4),
      KokoroVoice('am_adam', 'Adam', female: false, sid: 5),
      KokoroVoice('am_eric', 'Eric', female: false, sid: 6),
      KokoroVoice('am_liam', 'Liam', female: false, sid: 7),
    ]),
    KokoroLanguage('en-gb', 'English (UK)', 'en', [
      KokoroVoice('bf_emma', 'Emma', female: true, sid: 8),
      KokoroVoice('bf_isabella', 'Isabella', female: true, sid: 9),
      KokoroVoice('bf_alice', 'Alice', female: true, sid: 10),
      KokoroVoice('bm_george', 'George', female: false, sid: 11),
      KokoroVoice('bm_daniel', 'Daniel', female: false, sid: 12),
      KokoroVoice('bm_lewis', 'Lewis', female: false, sid: 13),
    ]),
    KokoroLanguage('es', 'Spanish', 'es', [
      KokoroVoice('ef_dora', 'Dora', female: true, sid: 14),
      KokoroVoice('em_alex', 'Alex', female: false, sid: 15),
      KokoroVoice('em_santa', 'Santa', female: false, sid: 16),
    ]),
    KokoroLanguage('fr', 'French', 'fr', [
      KokoroVoice('ff_siwis', 'Siwis', female: true, sid: 17),
    ]),
    KokoroLanguage('hi', 'Hindi', 'hi', [
      KokoroVoice('hf_alpha', 'Alpha', female: true, sid: 18),
      KokoroVoice('hf_beta', 'Beta', female: true, sid: 19),
      KokoroVoice('hm_omega', 'Omega', female: false, sid: 20),
      KokoroVoice('hm_psi', 'Psi', female: false, sid: 21),
    ]),
    KokoroLanguage('it', 'Italian', 'it', [
      KokoroVoice('if_sara', 'Sara', female: true, sid: 22),
      KokoroVoice('im_nicola', 'Nicola', female: false, sid: 23),
    ]),
    KokoroLanguage('pt-br', 'Portuguese (BR)', 'pt', [
      KokoroVoice('pf_dora', 'Dora', female: true, sid: 24),
      KokoroVoice('pm_alex', 'Alex', female: false, sid: 25),
      KokoroVoice('pm_santa', 'Santa', female: false, sid: 26),
    ]),
    KokoroLanguage('ja', 'Japanese', 'ja', [
      KokoroVoice('jf_alpha', 'Alpha', female: true, sid: 27),
      KokoroVoice('jf_nezumi', 'Nezumi', female: true, sid: 28),
      KokoroVoice('jm_kumo', 'Kumo', female: false, sid: 29),
    ]),
    KokoroLanguage('zh', 'Chinese (Mandarin)', 'zh', [
      KokoroVoice('zf_xiaoxiao', 'Xiaoxiao', female: true, sid: 30),
      KokoroVoice('zf_xiaoni', 'Xiaoni', female: true, sid: 31),
      KokoroVoice('zm_yunxi', 'Yunxi', female: false, sid: 32),
      KokoroVoice('zm_yunyang', 'Yunyang', female: false, sid: 33),
    ]),
  ];

  /// Default language = English (US), the first entry.
  static KokoroLanguage get defaultLanguage => languages.first;

  /// Default voice = the first female English voice ("Heart").
  static KokoroVoice get defaultVoice => defaultLanguage.voices.first;

  static KokoroLanguage? languageByCode(String code) {
    for (final l in languages) {
      if (l.code == code) return l;
    }
    return null;
  }

  static KokoroVoice? voiceById(KokoroLanguage lang, String id) {
    for (final v in lang.voices) {
      if (v.id == id) return v;
    }
    return null;
  }
}

/// Per-account Kokoro voice/language preference. Non-secret → [DiskCache],
/// account-scoped automatically. Default English (US) / "Heart" (female).
class KokoroVoicePref {
  KokoroVoicePref._();

  static const _kLangKey = 'kokoro_lang';
  static const _kVoiceKey = 'kokoro_voice';

  /// Live selection any screen (or the future TTS engine) can listen to.
  static final ValueNotifier<KokoroSelection> selection =
      ValueNotifier<KokoroSelection>(
    KokoroSelection(KokoroCatalog.defaultLanguage, KokoroCatalog.defaultVoice),
  );

  /// The current resolved selection.
  static KokoroSelection get current => selection.value;

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  /// Load the persisted choice for the current account into [selection]. Cheap
  /// to re-call (reflects an account switch). Falls back to defaults. Never throws.
  static Future<KokoroSelection> load() async {
    try {
      final langCode = await DiskCache.read(_kLangKey);
      final voiceId = await DiskCache.read(_kVoiceKey);
      final lang = (langCode == null
              ? null
              : KokoroCatalog.languageByCode(langCode)) ??
          KokoroCatalog.defaultLanguage;
      final voice = (voiceId == null
              ? null
              : KokoroCatalog.voiceById(lang, voiceId)) ??
          lang.voices.first;
      _loaded = true;
      final sel = KokoroSelection(lang, voice);
      selection.value = sel;
      return sel;
    } catch (_) {
      _loaded = true;
      return selection.value;
    }
  }

  /// Persist a new language + voice for the current account; updates [selection]
  /// synchronously so the UI reacts at once.
  static Future<void> set(KokoroLanguage lang, KokoroVoice voice) async {
    selection.value = KokoroSelection(lang, voice);
    _loaded = true;
    await DiskCache.write(_kLangKey, lang.code);
    await DiskCache.write(_kVoiceKey, voice.id);
    // ignore: unawaited_futures
    Analytics.capture('kokoro_voice_set', {
      'lang': lang.code,
      'voice': voice.id,
      'gender': voice.female ? 'female' : 'male',
    });
  }
}
