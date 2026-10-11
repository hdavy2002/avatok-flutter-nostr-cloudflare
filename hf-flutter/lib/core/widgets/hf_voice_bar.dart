import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Voice-intro player bar (mockup `Main` / `Profile`): a peach strip with a round ink play / pause button, the
/// [title] ("Her voice"), a waveform and [durationLabel] ("0:20").
///
/// [heights] are bar heights in percent (0-100); the waveform is [compact] 20 px or 34 px high. Bars before
/// [progress] (0..1) are painted `peachInk`, the rest `peachWave`. [compact] also shrinks the button to 40 px
/// (48 px otherwise) and the radius to 18 (20). [onTap] toggles playback; the whole bar is the tap target.
class HfVoiceBar extends StatelessWidget {
  const HfVoiceBar({
    super.key,
    required this.title,
    required this.durationLabel,
    required this.heights,
    this.progress = 0,
    this.playing = false,
    this.onTap,
    this.compact = false,
  });

  final String title;
  final String durationLabel;
  final List<int> heights;
  final double progress;
  final bool playing;
  final VoidCallback? onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final bg = dark ? HfColors.darkTilePeach : HfColors.peach;
    final ink = dark ? HfColors.peachLight : HfColors.peachInk;
    final played = dark ? HfColors.peachLight : HfColors.peachInk;
    const idle = HfColors.peachWave;
    final button = compact ? 40.0 : 48.0;
    final waveHeight = compact ? 20.0 : 34.0;
    final p = progress.clamp(0.0, 1.0);
    return Semantics(
      button: onTap != null,
      label: playing ? 'Pause $title' : 'Play $title',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(6, 6, 12, 6),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(
              compact ? HfRadius.tileSmall : HfRadius.control,
            ),
          ),
          child: Row(
            children: [
              Container(
                width: button,
                height: button,
                decoration: BoxDecoration(
                  color: dark ? HfColors.peachLight : HfColors.ink,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
                  size: compact ? 20 : 24,
                  color: dark ? HfColors.ink : HfColors.white,
                ),
              ),
              const SizedBox(width: HfSpacing.md),
              Flexible(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: HfText.badge.copyWith(color: ink),
                ),
              ),
              const SizedBox(width: HfSpacing.md),
              Expanded(
                child: SizedBox(
                  height: waveHeight,
                  child: LayoutBuilder(
                    builder: (context, c) {
                      // Each bar needs ~4px (2px bar + 2px gap); with less room (big system text) sample fewer bars.
                      final fit = (c.maxWidth / 4).floor().clamp(
                        1,
                        heights.length,
                      );
                      final step = heights.length / fit;
                      final shown = [
                        for (var i = 0; i < fit; i++)
                          heights[(i * step).floor()],
                      ];
                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          for (var i = 0; i < shown.length; i++) ...[
                            if (i > 0) const SizedBox(width: 2),
                            Expanded(
                              child: Center(
                                child: Container(
                                  height:
                                      waveHeight *
                                      (shown[i].clamp(0, 100) / 100),
                                  decoration: BoxDecoration(
                                    color: (i / shown.length) < p
                                        ? played
                                        : idle,
                                    borderRadius: BorderRadius.circular(2),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ],
                      );
                    },
                  ),
                ),
              ),
              const SizedBox(width: HfSpacing.md),
              Text(durationLabel, style: HfText.badge.copyWith(color: ink)),
            ],
          ),
        ),
      ),
    );
  }
}
