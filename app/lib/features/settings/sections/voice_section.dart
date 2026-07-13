import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/disk_cache.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/voice/google_voice.dart';
import '../settings_registry.dart';

/// Settings → "Ava voice".
///
/// Voice calls are ONLINE-only (Gemini Live native audio) — there is no on-device
/// TTS. This section just lets the user pick the Google voice (male/female) Ava
/// speaks with on a call; the choice is sent to /api/ava/live/token and locked
/// into the session server-side.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init]
/// (`registerVoiceSection()`) — never by editing settings_screen.dart.
void registerVoiceSection() {
  // On-device TTS was removed: Ava's spoken voice is the ONLINE Gemini Live call,
  // so [AvaVoice.synthesizer] stays null (the companion "Listen" affordance shows
  // its "voice coming soon" notice). On-device is kept only for STT (dictation).
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_voice',
      title: 'Ava voice',
      order: 25,
      builder: (context) => const _VoiceCard(),
    ),
  );
}

/// Per-account "Let Ava speak" preference, kept ONLY so the companion "Listen"
/// affordance has a flag to read. With on-device TTS removed it stays OFF and the
/// affordance is inert until an online synthesiser is wired. [DiskCache]-backed.
class AvaVoicePref {
  AvaVoicePref._();

  static const _kKey = 'ava_voice_enabled';

  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  static Future<bool> load() async {
    final raw = await DiskCache.read(_kKey);
    final v = raw == '1';
    _loaded = true;
    if (enabled.value != v) enabled.value = v;
    return v;
  }

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
    GoogleVoicePref.load().then((_) {
      if (mounted) setState(() {});
    });
    AvaVoiceLangPref.load().then((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  Widget build(BuildContext context) {
    return AdCard(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.phoneCall(PhosphorIconsStyle.fill),
              color: AD.iconVideo,
              size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text("Ava's voice", style: ADText.rowName()),
              const SizedBox(height: 2),
              Text('Choose the voice Ava speaks with on a hands-free call.',
                  style: ADText.preview()),
            ]),
          ),
        ]),
        const SizedBox(height: 14),
        ValueListenableBuilder<String>(
          valueListenable: GoogleVoicePref.voice,
          builder: (context, current, _) {
            final sel = GoogleVoiceCatalog.byName(current);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (sel != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      'Selected: ${sel.name} · ${sel.style} '
                      '(${sel.female ? "female" : "male"})',
                      style: ADText.preview(c: AD.iconSearch),
                    ),
                  ),
                Text('FEMALE', style: ADText.sectionLabel()),
                const SizedBox(height: 8),
                _voiceWrap(GoogleVoiceCatalog.female, current),
                const SizedBox(height: 16),
                Text('MALE', style: ADText.sectionLabel()),
                const SizedBox(height: 8),
                _voiceWrap(GoogleVoiceCatalog.male, current),
              ],
            );
          },
        ),
        const SizedBox(height: 18),
        const Divider(height: 1, color: AD.borderHairline),
        const SizedBox(height: 16),
        Text('LANGUAGE', style: ADText.sectionLabel()),
        const SizedBox(height: 4),
        Text('The language Ava speaks on a call. Auto follows whatever you speak.',
            style: ADText.preview()),
        const SizedBox(height: 10),
        ValueListenableBuilder<String>(
          valueListenable: AvaVoiceLangPref.lang,
          builder: (context, code, _) => Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final l in AvaLangCatalog.all)
                AdChip(
                  label: l.label,
                  active: l.code == code,
                  onTap: () => AvaVoiceLangPref.set(l.code),
                ),
            ],
          ),
        ),
      ]),
    );
  }

  Widget _voiceWrap(List<GoogleVoice> voices, String current) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final v in voices)
            AdChip(
              label: v.name,
              active: v.name == current,
              onTap: () => GoogleVoicePref.set(v.name),
            ),
        ],
      );
}

/// Companion "Listen" hook. With on-device TTS removed, [synthesizer] stays null
/// and [available] is false, so the companion thread shows a "voice coming soon"
/// notice instead of synthesising. Kept so the companion thread keeps compiling
/// and can be re-wired to an online synthesiser later.
class AvaVoice {
  AvaVoice._();

  /// Injected synthesiser → playable local audio path for [text], or null.
  static Future<String?> Function(String text)? synthesizer;

  static bool get enabled => AvaVoicePref.enabled.value;

  static bool get available => synthesizer != null;

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
