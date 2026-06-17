import '../../core/disk_cache.dart';

/// Ava companion PERSONAS (Phase 6 — Companion / Blank Ava Chat).
///
/// A persona is just a system-prompt preset that steers a free-form Ava chat
/// (brainstorm / language practice / roleplay). The companion conversation runs
/// through the EXISTING moderated proxy ([AvaAiClient.ask] → `/api/ava/gemini`),
/// so every persona's text is sent as the `context` (grounding/system) string;
/// llama-guard (server-side, in the P2 gate) still moderates input + output for
/// EVERY persona, including roleplay.
///
/// Persona SELECTION is stored client-side, per account, via [DiskCache] (it is
/// non-secret UI preference data, account-scoped automatically under
/// `cache/<AccountScope.id>/`). We deliberately do NOT add a worker route for
/// persona storage — the brief froze `worker/src/index.ts` and registered no
/// companion route, so personas live entirely on the device. (See the Phase 6
/// block in INTEGRATION-NOTES.md for the AgentDO-persona option we declined.)
class AvaPersona {
  /// Stable id (used as the DiskCache value + analytics tag).
  final String id;

  /// Display name shown in the picker + thread header.
  final String name;

  /// One-line description for the picker card.
  final String tagline;

  /// Phosphor-ish emoji glyph for the picker tile (kept text so we add no deps).
  final String glyph;

  /// The system-prompt / grounding text sent as `context` to the gated proxy.
  final String systemPrompt;

  /// True for personas that must be limited to verified adults (roleplay).
  /// The companion home checks the identity ladder before opening these.
  final bool adultOnly;

  const AvaPersona({
    required this.id,
    required this.name,
    required this.tagline,
    required this.glyph,
    required this.systemPrompt,
    this.adultOnly = false,
  });
}

/// Shared persona preamble. Keeps Ava's voice feminine, warm, and on-brand, and
/// re-states the safety stance the server gate enforces (defence in depth — the
/// prompt asks for it, llama-guard guarantees it).
const String _kAvaBase =
    'You are Ava, the friendly AI companion built into AvaTOK. You speak in a '
    "warm, feminine, encouraging voice — like a sharp, kind friend. You're "
    'concise by default and expand when asked. You never pretend to be a human, '
    'never give medical/legal/financial advice as if licensed, and you decline '
    'anything unsafe, hateful, or sexual involving minors. ';

/// The built-in personas. `none` is the default blank companion.
class AvaPersonas {
  AvaPersonas._();

  static const AvaPersona blank = AvaPersona(
    id: 'blank',
    name: 'Just chat',
    tagline: 'Open conversation — vent, ask, or think out loud.',
    glyph: '💬',
    systemPrompt: '${_kAvaBase}Be a supportive, open-ended companion. Listen, '
        'reflect, and help the user untangle whatever is on their mind.',
  );

  static const AvaPersona brainstorm = AvaPersona(
    id: 'brainstorm',
    name: 'Brainstorm',
    tagline: 'Ideas, plans, names, angles — fast and divergent.',
    glyph: '💡',
    systemPrompt: '${_kAvaBase}Act as a high-energy brainstorming partner. Offer '
        'lots of distinct ideas, build on the user\'s direction, and end turns '
        'with a nudging question to keep the momentum going.',
  );

  static const AvaPersona language = AvaPersona(
    id: 'language',
    name: 'Language practice',
    tagline: 'Practise a language — gentle corrections as you go.',
    glyph: '🗣️',
    systemPrompt: '${_kAvaBase}Act as a patient language tutor. Detect the '
        'language the user is practising, converse in it at their level, and '
        'gently correct mistakes inline (show the fix + a one-line why). Keep it '
        'encouraging.',
  );

  /// ADULT-ONLY. Gated behind verified identity in companion_home.dart; the
  /// server gate (llama-guard) still moderates the content of every turn.
  static const AvaPersona roleplay = AvaPersona(
    id: 'roleplay',
    name: 'Roleplay',
    tagline: 'Collaborative fiction & scenes. Adults only.',
    glyph: '🎭',
    adultOnly: true,
    systemPrompt: '${_kAvaBase}Act as a collaborative-fiction partner for an '
        'adult user. Stay in character for light scenes and storytelling, follow '
        "the user's creative lead, and keep everything within safe, respectful "
        'bounds — no sexual content involving minors, no real-person sexual '
        'content, no illegal instructions. If a request crosses a line, break '
        'character briefly to redirect.',
  );

  /// All personas, in picker order.
  static const List<AvaPersona> all = [blank, brainstorm, language, roleplay];

  static AvaPersona byId(String? id) =>
      all.firstWhere((p) => p.id == id, orElse: () => blank);
}

/// Per-account persona selection store (last-used persona). Non-secret →
/// [DiskCache], account-scoped automatically. Defaults to [AvaPersonas.blank].
class AvaPersonaStore {
  AvaPersonaStore._();
  static const _kKey = 'ava_companion_persona';

  /// Read the last-used persona for the current account (defaults to blank).
  static Future<AvaPersona> load() async {
    final raw = await DiskCache.read(_kKey);
    return AvaPersonas.byId(raw);
  }

  /// Persist the chosen persona for the current account.
  static Future<void> save(AvaPersona p) => DiskCache.write(_kKey, p.id);
}
