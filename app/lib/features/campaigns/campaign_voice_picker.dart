import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/audio_playback_service.dart';
import '../../core/campaigns_api.dart';
import '../../core/ui/avatok_dark.dart';

/// Voice picker for the campaign wizard's Goal step (AVA-CAMP-Q-WIZARD).
/// Renders [voices] as a MALE/FEMALE/ALL-filterable list of rows, each with a
/// play button that previews the voice through the shared
/// [AudioPlaybackService] — same fetch-bytes-then-hand-to-the-app-wide-player
/// pattern as `campaign_inbox_cards.dart`'s recording player — and a
/// selected-state ring matching `_numberChoiceTile` in the wizard screen.
/// A separate file (rather than inline in the wizard) per the task brief.
class CampaignVoicePicker extends StatefulWidget {
  final List<CampaignVoice> voices;
  final String? selectedId;
  final ValueChanged<String> onSelected;
  const CampaignVoicePicker({
    super.key,
    required this.voices,
    required this.selectedId,
    required this.onSelected,
  });

  @override
  State<CampaignVoicePicker> createState() => _CampaignVoicePickerState();
}

enum _GenderFilter { all, male, female }

class _CampaignVoicePickerState extends State<CampaignVoicePicker> {
  _GenderFilter _filter = _GenderFilter.all;
  String? _loadingId;
  final Map<String, Uint8List> _bytesCache = {};

  List<CampaignVoice> get _visible {
    switch (_filter) {
      case _GenderFilter.male:
        return widget.voices.where((v) => v.gender == 'male').toList();
      case _GenderFilter.female:
        return widget.voices.where((v) => v.gender == 'female').toList();
      case _GenderFilter.all:
        return widget.voices;
    }
  }

  String _trackId(String voiceId) => 'campvoice:$voiceId';

  Future<void> _togglePlay(CampaignVoice v) async {
    final trackId = _trackId(v.id);
    final cur = AudioPlaybackService.I.state.value;
    final isThisTrack = AudioPlaybackService.I.isCurrent(trackId);
    if (isThisTrack && cur != null && cur.playing) {
      await AudioPlaybackService.I.pause();
      return;
    }
    if (isThisTrack && cur != null && !cur.playing) {
      await AudioPlaybackService.I.resume();
      return;
    }
    setState(() => _loadingId = v.id);
    try {
      var bytes = _bytesCache[v.id];
      bytes ??= await CampaignsApi.fetchVoicePreviewBytes(v.id);
      if (bytes == null || bytes.isEmpty) return;
      _bytesCache[v.id] = bytes;
      await AudioPlaybackService.I.play(
        track: AudioTrack(trackId: trackId, title: v.name, subtitle: 'Voice preview'),
        bytes: bytes,
      );
    } catch (_) {
      // Guarded — a failed preview just means no audio plays; never crash the wizard.
    } finally {
      if (mounted) setState(() => _loadingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final voices = widget.voices;
    if (voices.isEmpty) {
      return Text('Voices are loading — a default voice will be used.',
          style: ADText.preview(c: AD.textTertiary));
    }
    final visible = _visible;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 8, runSpacing: 8, children: [
        AdChip(label: 'All', active: _filter == _GenderFilter.all,
            onTap: () => setState(() => _filter = _GenderFilter.all)),
        AdChip(label: 'Female', active: _filter == _GenderFilter.female,
            onTap: () => setState(() => _filter = _GenderFilter.female)),
        AdChip(label: 'Male', active: _filter == _GenderFilter.male,
            onTap: () => setState(() => _filter = _GenderFilter.male)),
      ]),
      const SizedBox(height: 10),
      if (visible.isEmpty)
        Text('No voices in this filter.', style: ADText.preview(c: AD.textTertiary)),
      for (final v in visible) _voiceRow(v),
    ]);
  }

  Widget _voiceRow(CampaignVoice v) {
    final selected = widget.selectedId == v.id;
    final loading = _loadingId == v.id;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => widget.onSelected(v.id),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: BorderRadius.circular(AD.rListCard),
            border: Border.all(color: selected ? AD.primaryBadge : AD.borderControl, width: 1),
          ),
          child: Row(children: [
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => _togglePlay(v),
              child: ValueListenableBuilder<PlaybackState?>(
                valueListenable: AudioPlaybackService.I.state,
                builder: (context, st, _) {
                  if (loading) {
                    return const SizedBox(
                      width: 26, height: 26,
                      child: CircularProgressIndicator(strokeWidth: 2, color: AD.bubbleOutPlay),
                    );
                  }
                  final isThis = st != null && st.track.trackId == _trackId(v.id);
                  final playing = isThis && st.playing;
                  return Icon(
                    playing
                        ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill)
                        : PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
                    size: 28,
                    color: AD.bubbleOutPlay,
                  );
                },
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(v.name, style: ADText.rowName()),
                if (v.description != null && v.description!.trim().isNotEmpty)
                  Text(v.description!, style: ADText.preview(c: AD.textTertiary)),
              ]),
            ),
            const SizedBox(width: 8),
            Container(
              width: 20, height: 20,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: selected ? AD.primaryBadge : AD.textTertiary, width: 2),
              ),
              child: selected
                  ? Container(width: 10, height: 10,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: AD.primaryBadge))
                  : null,
            ),
          ]),
        ),
      ),
    );
  }
}
