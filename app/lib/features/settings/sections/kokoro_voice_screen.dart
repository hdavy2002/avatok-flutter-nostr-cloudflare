/// Settings → Ava voice → "Voice & language" (Kokoro TTS).
///
/// Lets the user pick the LANGUAGE and the named male/female VOICE their Ava will
/// speak in once Kokoro TTS comes online. The choice is stored per-account via
/// [KokoroVoicePref]; the Kokoro engine (a later build) reads it at synthesis time.
/// Default = English (US), female "Heart". No audio is produced here yet — a short
/// "preview available when voice is on" note sets the expectation.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/kokoro_voice.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';

class KokoroVoiceScreen extends StatefulWidget {
  const KokoroVoiceScreen({super.key});
  @override
  State<KokoroVoiceScreen> createState() => _KokoroVoiceScreenState();
}

class _KokoroVoiceScreenState extends State<KokoroVoiceScreen> {
  late KokoroLanguage _lang;
  late KokoroVoice _voice;

  @override
  void initState() {
    super.initState();
    final sel = KokoroVoicePref.current;
    _lang = sel.language;
    _voice = sel.voice;
    // Make sure we reflect the persisted account value.
    KokoroVoicePref.load().then((loaded) {
      if (!mounted) return;
      setState(() {
        _lang = loaded.language;
        _voice = loaded.voice;
      });
    });
  }

  void _pickLanguage(KokoroLanguage lang) {
    setState(() {
      _lang = lang;
      // If the current voice isn't in the new language, fall back to its first.
      if (KokoroCatalog.voiceById(lang, _voice.id) == null) {
        _voice = lang.voices.first;
      }
    });
    KokoroVoicePref.set(_lang, _voice);
  }

  void _pickVoice(KokoroVoice v) {
    setState(() => _voice = v);
    KokoroVoicePref.set(_lang, _voice);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Voice & language',
        markWord: 'Voice',
        tag: 'KOKORO TTS',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
          children: [
            _intro(),
            const SizedBox(height: 16),
            _sectionLabel('LANGUAGE'),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final l in KokoroCatalog.languages)
                  ZineChip(
                    label: l.name,
                    active: l.code == _lang.code,
                    onTap: () => _pickLanguage(l),
                  ),
              ],
            ),
            const SizedBox(height: 22),
            _sectionLabel('VOICE'),
            const SizedBox(height: 10),
            ZineCard(
              radius: Zine.rSm,
              padding: const EdgeInsets.all(6),
              boxShadow: Zine.shadowXs,
              child: Column(
                children: [
                  for (final v in _lang.voices) _voiceRow(v),
                ],
              ),
            ),
            const SizedBox(height: 18),
            _previewNote(),
          ],
        ),
      ),
    );
  }

  Widget _intro() => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: Row(children: [
          ZineIconBadge(
            icon: PhosphorIcons.translate(PhosphorIconsStyle.fill),
            color: Zine.lilac,
            size: 36,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Choose the language and the voice your Ava speaks in. '
              'You\'ll hear this character once voice replies are on.',
              style: ZineText.sub(size: 12.5),
            ),
          ),
        ]),
      );

  Widget _sectionLabel(String s) =>
      Text(s, style: ZineText.kicker(size: 11));

  Widget _voiceRow(KokoroVoice v) {
    final selected = v.id == _voice.id;
    return ZinePressable(
      onTap: () => _pickVoice(v),
      color: selected ? Zine.lilac : Zine.card,
      radius: BorderRadius.circular(Zine.rBadge),
      boxShadow: const <BoxShadow>[],
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Row(children: [
        Icon(
          v.female ? Icons.female_rounded : Icons.male_rounded,
          size: 20,
          color: v.female ? Zine.coral : Zine.blueInk,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Row(children: [
            Text(v.name, style: ZineText.value(size: 14.5)),
            const SizedBox(width: 8),
            Text(v.female ? 'Female' : 'Male',
                style: ZineText.kicker(size: 10.5)),
          ]),
        ),
        if (selected)
          PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
              size: 22, color: Zine.ink),
      ]),
    );
  }

  Widget _previewNote() => Row(children: [
        PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.bold),
            size: 15, color: Zine.inkSoft),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'Voice preview plays here once Kokoro TTS is switched on.',
            style: ZineText.sub(size: 12),
          ),
        ),
      ]);
}
