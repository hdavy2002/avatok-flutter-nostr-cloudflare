import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/disk_cache.dart';
import '../../../core/paid_feature.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../settings_registry.dart';

/// Settings → "Ava voice" section (Phase 6 — Companion / Blank Ava Chat).
///
/// A PREMIUM (paid) toggle: when ON, Ava can speak her replies in the companion
/// chat (rendered on demand — the user taps "Listen", we never synthesise ahead
/// of time). The toggle stores a per-account preference via [AvaVoicePref]
/// ([DiskCache], account-scoped). Actual synthesis goes through the existing TTS
/// path on the Worker (no NEW worker route is added — `index.ts` is frozen).
///
/// Because turning the feature on is the premium gate, the ENABLE action is
/// wrapped in [PaidFeature]: a non-entitled tap routes to the top-up sheet
/// (Phase-0 stub wallet = empty today). Turning it OFF is always free.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init]
/// (`registerVoiceSection()`), the one sanctioned bootstrap append — never by
/// editing settings_screen.dart.
void registerVoiceSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_voice',
      title: 'Ava voice',
      order: 25, // between Tools (30) and the upper sections
      builder: (context) => const _VoiceCard(),
    ),
  );
}

/// Per-account "Ava voice" on/off preference (premium feature). Non-secret →
/// [DiskCache], account-scoped automatically under `cache/<AccountScope.id>/`.
/// Default OFF (premium, opt-in). Exposes a [ValueListenable] so the companion
/// thread's "Listen" affordance reacts instantly when the toggle flips.
class AvaVoicePref {
  AvaVoicePref._();

  static const _kKey = 'ava_voice_enabled';

  /// Live value any screen can listen to. Default OFF.
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  /// Read the persisted value for the current account into [enabled]. Cheap to
  /// re-call (reflects an account switch). Never throws.
  static Future<bool> load() async {
    final raw = await DiskCache.read(_kKey);
    final v = raw == '1';
    _loaded = true;
    if (enabled.value != v) enabled.value = v;
    return v;
  }

  /// Flip + persist for the current account; updates [enabled] synchronously.
  static Future<void> set(bool v) async {
    enabled.value = v;
    _loaded = true;
    await DiskCache.write(_kKey, v ? '1' : '0');
  }
}

class _VoiceCard extends StatefulWidget {
  const _VoiceCard();
  @override
  State<_VoiceCard> createState() => _VoiceCardState();
}

class _VoiceCardState extends State<_VoiceCard> {
  @override
  void initState() {
    super.initState();
    AvaVoicePref.load();
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: ValueListenableBuilder<bool>(
        valueListenable: AvaVoicePref.enabled,
        builder: (context, on, _) {
          final body = Row(children: [
            ZineIconBadge(
                icon: PhosphorIcons.waveform(PhosphorIconsStyle.fill),
                color: Zine.lilac,
                size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Text('Let Ava speak', style: ZineText.value(size: 14.5)),
                  const SizedBox(width: 8),
                  const PaidBadge(),
                ]),
                const SizedBox(height: 2),
                Text(
                  on
                      ? 'Ava can read her replies aloud in companion chats. Tap '
                          '“Listen” on a message to hear it — nothing is voiced '
                          'until you ask.'
                      : 'Premium. Turn on so Ava can voice her replies in '
                          'companion chats (on-demand only).',
                  style: ZineText.sub(size: 12),
                ),
              ]),
            ),
            const SizedBox(width: 10),
            // Turning OFF is free; turning ON is the premium gate → wrap the
            // "enable" tap in PaidFeature. The toggle itself is non-interactive
            // (its onChanged is null) so taps flow through PaidFeature/our handler.
            if (on)
              ZineToggle(value: true, onChanged: (_) => AvaVoicePref.set(false))
            else
              PaidFeature(
                actionLabel: 'Enable Ava voice',
                onRun: () async => AvaVoicePref.set(true),
                child: const IgnorePointer(
                    child: ZineToggle(value: false, onChanged: null)),
              ),
          ]);
          return body;
        },
      ),
    );
  }
}

/// Companion voice synthesis (Phase 6).
///
/// STATUS — DEFERRED SYNTHESIS WIRING. The brief asked to reuse the existing
/// `/api/agent/tts` route if it fits. It does NOT fit the companion case: that
/// route ([worker/src/routes/agent_tts.ts]) synthesises a whole
/// `agent_conversations` TRANSCRIPT keyed by `conversation_id` (Deepgram Aura-2),
/// and a free-form companion chat has no agent_conversation row and no
/// conversation_id. Adding a general "voice this text" route would mean a NEW
/// worker route, which the Phase 6 brief forbids (`index.ts` is frozen).
///
/// So this phase ships the per-account PREFERENCE + the on-demand "Listen"
/// affordance, and leaves the actual synthesis call as a single documented hook:
/// [synthesizer]. When a text→speech endpoint that returns audio for arbitrary
/// text exists (e.g. a future `/api/ava/voice` using ElevenLabs, or an extension
/// of `/api/agent/tts` that accepts raw text), assign [synthesizer] to a function
/// that returns the spoken bytes (or a streamable URL) for [text]. The companion
/// thread already calls [AvaVoice.speak] on demand and plays the result via
/// audioplayers; until [synthesizer] is wired it shows a friendly "voice is
/// coming soon" notice instead of failing.
class AvaVoice {
  AvaVoice._();

  /// Injected synthesiser. Returns the path to a playable local audio file for
  /// [text], or null if synthesis is unavailable. Defaults to null (deferred).
  static Future<String?> Function(String text)? synthesizer;

  /// Whether the premium voice feature is enabled for this account.
  static bool get enabled => AvaVoicePref.enabled.value;

  /// Whether synthesis is actually wired (else "Listen" shows the coming-soon
  /// notice). Today this is false until [synthesizer] is set (see class doc).
  static bool get available => synthesizer != null;

  /// Synthesise [text] to a local audio file path, or null if unavailable.
  static Future<String?> speak(String text) async {
    final s = synthesizer;
    if (s == null) return null;
    try {
      return await s(text);
    } catch (e) {
      if (kDebugMode) debugPrint('AvaVoice.speak failed: $e');
      return null;
    }
  }
}
