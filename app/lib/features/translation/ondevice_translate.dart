import 'dart:async';

import 'package:google_mlkit_language_id/google_mlkit_language_id.dart';
import 'package:google_mlkit_translation/google_mlkit_translation.dart';

/// On-device, offline TEXT translation for the composer Translate tool (pic4).
///
/// Instant (~tens of ms) vs the multi-second Gemini round-trip. Strategy that
/// guarantees NO regression:
///  - Language models download ON DEMAND, in the BACKGROUND (deferred — never at
///    install, Wi-Fi only). Until a pair is ready, [translate] returns null so
///    the caller falls back to the existing server (Gemini) translate.
///  - The source language is auto-detected via on-device language identification.
///  - Any unsupported language or error → null → server fallback.
class OnDeviceTranslate {
  OnDeviceTranslate._();
  static final OnDeviceTranslate I = OnDeviceTranslate._();

  final _modelManager = OnDeviceTranslatorModelManager();
  final _langId = LanguageIdentifier(confidenceThreshold: 0.4);
  final _downloading = <String>{}; // bcp codes currently downloading

  /// The composer hands us an English language NAME ("Spanish", "French", …).
  /// Names ML Kit can't do on-device (e.g. Traditional Chinese, Filipino) map to
  /// null → the caller uses the server path for those.
  static const Map<String, TranslateLanguage> _byName = {
    'English': TranslateLanguage.english,
    'Spanish': TranslateLanguage.spanish,
    'French': TranslateLanguage.french,
    'German': TranslateLanguage.german,
    'Portuguese': TranslateLanguage.portuguese,
    'Italian': TranslateLanguage.italian,
    'Dutch': TranslateLanguage.dutch,
    'Hindi': TranslateLanguage.hindi,
    'Arabic': TranslateLanguage.arabic,
    'Bengali': TranslateLanguage.bengali,
    'Urdu': TranslateLanguage.urdu,
    'Chinese (Simplified)': TranslateLanguage.chinese,
    'Japanese': TranslateLanguage.japanese,
    'Korean': TranslateLanguage.korean,
    'Russian': TranslateLanguage.russian,
    'Turkish': TranslateLanguage.turkish,
    'Indonesian': TranslateLanguage.indonesian,
    'Vietnamese': TranslateLanguage.vietnamese,
    'Thai': TranslateLanguage.thai,
    'Swahili': TranslateLanguage.swahili,
    'Polish': TranslateLanguage.polish,
    'Ukrainian': TranslateLanguage.ukrainian,
    'Persian': TranslateLanguage.persian,
    'Tamil': TranslateLanguage.tamil,
    'Telugu': TranslateLanguage.telugu,
    'Marathi': TranslateLanguage.marathi,
  };

  static TranslateLanguage? _target(String name) => _byName[name];

  /// Resolve a BCP-47 code (e.g. "en", "zh", "pt-BR") from language
  /// identification to a [TranslateLanguage] by matching its bcpCode, or null.
  static TranslateLanguage? _fromBcp(String code) {
    final c = code.trim().toLowerCase();
    if (c.isEmpty) return null;
    final base = c.split(RegExp(r'[-_]')).first;
    for (final l in TranslateLanguage.values) {
      final b = l.bcpCode.toLowerCase();
      if (b == c || b == base) return l;
    }
    return null;
  }

  /// True when the model is present. If absent, kicks off a deferred background
  /// download (Wi-Fi only) and returns false so the current request falls back.
  Future<bool> _ensure(TranslateLanguage lang) async {
    final code = lang.bcpCode;
    if (await _modelManager.isModelDownloaded(code)) return true;
    if (!_downloading.contains(code)) {
      _downloading.add(code);
      unawaited(_modelManager
          .downloadModel(code, isWifiRequired: true)
          .whenComplete(() => _downloading.remove(code)));
    }
    return false;
  }

  /// Translate [text] into the language NAMED [targetName] (e.g. "Spanish").
  /// Returns the translation, or NULL when on-device isn't possible yet — the
  /// caller should then fall back to the server translate.
  Future<String?> translate(String text, String targetName) async {
    try {
      final target = _target(targetName);
      if (target == null) return null;
      final srcCode = await _langId.identifyLanguage(text);
      if (srcCode.isEmpty || srcCode == 'und') return null;
      final source = _fromBcp(srcCode);
      if (source == null) return null;
      if (source == target) return text; // already in the target language
      final haveSrc = await _ensure(source);
      final haveTgt = await _ensure(target);
      if (!haveSrc || !haveTgt) return null; // downloading → fall back this time
      final translator = OnDeviceTranslator(sourceLanguage: source, targetLanguage: target);
      try {
        final out = await translator.translateText(text);
        return out.trim().isEmpty ? null : out;
      } finally {
        await translator.close();
      }
    } catch (_) {
      return null; // any failure → server fallback
    }
  }

  /// Warm the target-language model in the background (deferred) so the FIRST
  /// translate is already instant. Safe to call repeatedly.
  Future<void> prefetch(String targetName) async {
    final target = _target(targetName);
    if (target != null) { try { await _ensure(target); } catch (_) { /* best-effort */ } }
  }
}
