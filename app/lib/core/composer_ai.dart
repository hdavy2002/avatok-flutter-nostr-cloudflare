import 'ava_ai_client.dart';

/// ComposerAi — the quick "@ava" tools shown above the chat input box
/// (Translate · Fix grammar · Rewrite · Reply ideas).
///
/// Every tool routes through [AvaAiClient.ask], so the SAME guarantees that
/// cover open Ava chat apply here too:
///   • server-side moderation gate (llama-guard in/out),
///   • the free-tier daily-turn cap (or unlimited with a connected BYO key),
///   • optional per-request BYO Gemini key over TLS.
/// No new Worker route and no AvaCoins billing — this is the cheap text path,
/// distinct from the metered Gemini-Live VOICE translation in
/// `features/translation/` + `worker/src/routes/translate.ts`.
class ComposerAi {
  ComposerAi._();

  /// Languages offered in the Translate sheet. `code` is the human name we hand
  /// to the model (Gemini translates by name reliably); `label` is the native
  /// name shown in the UI. Curated common set — covers the bulk of AvaVerse
  /// users while staying short enough to scroll quickly.
  static const languages = <ComposerLang>[
    ComposerLang('English', 'English'),
    ComposerLang('Spanish', 'Español'),
    ComposerLang('French', 'Français'),
    ComposerLang('German', 'Deutsch'),
    ComposerLang('Portuguese', 'Português'),
    ComposerLang('Italian', 'Italiano'),
    ComposerLang('Dutch', 'Nederlands'),
    ComposerLang('Hindi', 'हिन्दी'),
    ComposerLang('Arabic', 'العربية'),
    ComposerLang('Bengali', 'বাংলা'),
    ComposerLang('Urdu', 'اردو'),
    ComposerLang('Chinese (Simplified)', '简体中文'),
    ComposerLang('Chinese (Traditional)', '繁體中文'),
    ComposerLang('Japanese', '日本語'),
    ComposerLang('Korean', '한국어'),
    ComposerLang('Russian', 'Русский'),
    ComposerLang('Turkish', 'Türkçe'),
    ComposerLang('Indonesian', 'Bahasa Indonesia'),
    ComposerLang('Vietnamese', 'Tiếng Việt'),
    ComposerLang('Thai', 'ไทย'),
    ComposerLang('Filipino', 'Filipino'),
    ComposerLang('Swahili', 'Kiswahili'),
    ComposerLang('Polish', 'Polski'),
    ComposerLang('Ukrainian', 'Українська'),
    ComposerLang('Persian', 'فارسی'),
    ComposerLang('Tamil', 'தமிழ்'),
    ComposerLang('Telugu', 'తెలుగు'),
    ComposerLang('Marathi', 'मराठी'),
  ];

  /// Tone presets for the Rewrite sheet: `label` shown to the user, `style`
  /// is the instruction phrase fed to the model.
  static const tones = <ComposerTone>[
    ComposerTone('Friendlier', 'warmer and friendlier'),
    ComposerTone('More formal', 'more formal and professional'),
    ComposerTone('Shorter & clearer', 'shorter, clearer and more concise'),
    ComposerTone('More confident', 'more confident and direct'),
    ComposerTone('More polite', 'more polite and softer'),
    ComposerTone('Simpler', 'simpler and easier to understand'),
  ];

  /// Look up a saved language by its `code`, falling back to English.
  static ComposerLang langByCode(String? code) => languages.firstWhere(
        (l) => l.code == code,
        orElse: () => languages.first,
      );

  /// Translate [text] into [language] (a name like "Spanish"). Reply is ONLY
  /// the translation, ready to drop straight back into the input box.
  static Future<AvaAnswer> translate(String text, String language) =>
      AvaAiClient.I.ask(
        message: 'Translate the message below into $language.\n'
            'Reply with ONLY the translation — no quotes, no notes, no '
            'transliteration, no original text. Preserve emoji, @mentions, '
            'line breaks and the original tone.\n\n---\n$text',
      );

  /// Fix spelling/grammar/punctuation while keeping the SAME language, meaning,
  /// tone and emoji. Reply is only the corrected message.
  static Future<AvaAnswer> fixGrammar(String text) => AvaAiClient.I.ask(
        message: 'Correct the spelling, grammar and punctuation of the message '
            'below. Keep the SAME language, meaning, tone and emoji. Do not add '
            'or remove ideas, and do not translate. Reply with ONLY the '
            'corrected message.\n\n---\n$text',
      );

  /// Rewrite [text] in the given [style] (a phrase from [tones]).
  static Future<AvaAnswer> rewrite(String text, String style) =>
      AvaAiClient.I.ask(
        message: 'Rewrite the message below to be $style. Keep the same '
            'language and core meaning; do not translate. Reply with ONLY the '
            'rewritten message.\n\n---\n$text',
      );

  /// Suggest 3 short replies to an [incoming] message. Use [parseIdeas] to
  /// split the answer into individual suggestions.
  static Future<AvaAnswer> replyIdeas(String incoming) => AvaAiClient.I.ask(
        message: 'Someone sent me this message:\n"$incoming"\n\n'
            'Suggest 3 short, natural replies I could send back. Reply in the '
            'same language as the message. Put each reply on its own line, with '
            'no numbering, no bullets, no quotes and no extra commentary — just '
            'the 3 replies separated by newlines.',
      );

  /// Split a [replyIdeas] answer into up to 3 clean suggestions, stripping any
  /// leading numbering/bullets the model may add despite instructions.
  static List<String> parseIdeas(String raw) => raw
      .split('\n')
      .map((l) =>
          l.replaceFirst(RegExp(r'^\s*(\d+[\.\)]|[-*•])\s*'), '').trim())
      .map((l) => l.replaceAll(RegExp(r'^"|"$'), '').trim())
      .where((l) => l.isNotEmpty)
      .take(3)
      .toList();
}

/// A translate-target language: [code] is the name handed to the model,
/// [label] the native name shown in the picker.
class ComposerLang {
  final String code;
  final String label;
  const ComposerLang(this.code, this.label);
}

/// A rewrite tone preset.
class ComposerTone {
  final String label;
  final String style;
  const ComposerTone(this.label, this.style);
}
