import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/avavision_api.dart';
import '../../../core/ui/zine_widgets.dart';

/// Voice catalog list — fetched from /avavision/voices (same Gemini Live
/// prebuilt voices as AvaVoice), with ▶ tap-to-preview when the server provides
/// sample clips. Copied from AvaVoice's voice_picker to stay decoupled
/// (master rule #4) rather than importing the AvaVoice module.
class VoicePicker extends StatefulWidget {
  final String selected;
  final ValueChanged<String> onSelected;
  const VoicePicker({super.key, required this.selected, required this.onSelected});
  @override
  State<VoicePicker> createState() => _VoicePickerState();
}

class _VoicePickerState extends State<VoicePicker> {
  List<VisionVoice> _voices = kFallbackVoices;
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
    final v = await AvaVisionApi.voices();
    if (mounted) setState(() => _voices = v);
  }

  Future<void> _preview(VisionVoice v) async {
    Analytics.capture('avavision_voice_previewed', {'voice': v.name, 'has_clip': v.previewUrl != null});
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
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: ZinePressable(
          onTap: () => widget.onSelected(v.name),
          color: sel ? AD.tabCalls : AD.card,
          radius: BorderRadius.circular(Msg.rLg),
          boxShadow: Msg.none,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
          child: Row(children: [
            PhosphorIcon(
                sel ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
                color: sel ? Colors.white : AD.textTertiary, size: 22),
            const SizedBox(width: Msg.s3),
            Expanded(child: Text(v.label, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3, fontWeight: sel ? FontWeight.w700 : FontWeight.w600))),
            ZineBackButton(
              icon: playing ? PhosphorIcons.stop(PhosphorIconsStyle.fill) : PhosphorIcons.play(PhosphorIconsStyle.fill),
              onTap: () => _preview(v),
            ),
          ]),
        ),
      );
    }).toList());
  }
}
