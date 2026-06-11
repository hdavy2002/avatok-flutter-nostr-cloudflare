import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../widgets.dart';

/// Voice catalog list — fetched from /avavoice/voices (Gemini Live prebuilt
/// voices), with ▶ tap-to-preview when the server provides sample clips.
class VoicePicker extends StatefulWidget {
  final String selected;
  final ValueChanged<String> onSelected;
  const VoicePicker({super.key, required this.selected, required this.onSelected});
  @override
  State<VoicePicker> createState() => _VoicePickerState();
}

class _VoicePickerState extends State<VoicePicker> {
  List<VoiceOption> _voices = kFallbackVoices;
  final _player = AudioPlayer();
  String? _playing;

  @override
  void initState() {
    super.initState();
    _load();
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = null);
    });
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final v = await AvaVoiceApi.voices();
    if (mounted) setState(() => _voices = v);
  }

  Future<void> _preview(VoiceOption v) async {
    Analytics.capture('avavoice_voice_previewed',
        {'voice': v.name, 'has_clip': v.previewUrl != null});
    if (_playing == v.name) {
      await _player.stop();
      setState(() => _playing = null);
      return;
    }
    final url = v.previewUrl;
    if (url == null || url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Preview sample coming soon for this voice.')));
      return;
    }
    setState(() => _playing = v.name);
    try {
      await _player.stop();
      await _player.play(UrlSource(url));
    } catch (_) {
      if (mounted) setState(() => _playing = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: _voices.map((v) {
      final sel = v.name == widget.selected;
      final playing = _playing == v.name;
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZinePressable(
          onTap: () => widget.onSelected(v.name),
          color: sel ? Zine.lilac : Zine.card,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: sel ? Zine.shadowXs : const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          child: Row(children: [
            PhosphorIcon(
                sel ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
                color: sel ? Zine.ink : Zine.inkMute, size: 22),
            const SizedBox(width: 11),
            Expanded(child: Text(v.label,
                style: ZineText.value(size: 14.5, weight: sel ? FontWeight.w900 : FontWeight.w800))),
            ZineBackButton(
              icon: playing
                  ? PhosphorIcons.stop(PhosphorIconsStyle.fill)
                  : PhosphorIcons.play(PhosphorIconsStyle.fill),
              onTap: () => _preview(v),
            ),
          ]),
        ),
      );
    }).toList());
  }
}
