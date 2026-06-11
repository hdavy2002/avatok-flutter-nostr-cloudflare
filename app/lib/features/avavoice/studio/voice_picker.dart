import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';

import '../../../core/avavoice_api.dart';
import '../../../core/theme.dart';
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
      return Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          border: Border.all(color: sel ? kAvaVoicePurple : AvaColors.line, width: sel ? 2 : 1),
          borderRadius: BorderRadius.circular(14),
          color: sel ? kAvaVoicePurple.withValues(alpha: .05) : null,
        ),
        child: ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          leading: Icon(sel ? Icons.radio_button_checked : Icons.radio_button_off,
              color: sel ? kAvaVoicePurple : AvaColors.sub, size: 20),
          title: Text(v.label, style: TextStyle(
              fontWeight: sel ? FontWeight.w800 : FontWeight.w600, fontSize: 14)),
          trailing: IconButton(
            icon: Icon(playing ? Icons.stop_circle_outlined : Icons.play_circle_outline,
                color: kAvaVoicePurple, size: 26),
            onPressed: () => _preview(v),
          ),
          onTap: () => widget.onSelected(v.name),
        ),
      );
    }).toList());
  }
}
