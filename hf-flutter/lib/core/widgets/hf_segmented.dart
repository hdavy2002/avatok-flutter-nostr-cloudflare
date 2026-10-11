import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Segmented control (Everyone / Women-only / LGBTQ+).
///
/// The track is `segmentTrack` (radius 16, padding 4); the selected pill (white, `darkSelected` in dark mode)
/// slides between segments with an [AnimatedAlign] (220 ms, instant on reduced motion). Items are 40 px tall:
/// the selected label is 14/700, the others 14/600 muted. When [tints] is given (same length as [options])
/// the selected pill takes that tint instead of white.
class HfSegmented extends StatelessWidget {
  const HfSegmented({
    super.key,
    required this.options,
    required this.selected,
    required this.onChanged,
    this.tints,
  }) : assert(options.length > 0);

  final List<String> options;

  /// Index into [options].
  final int selected;
  final ValueChanged<int> onChanged;
  final List<HfTint>? tints;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final n = options.length;
    final index = selected.clamp(0, n - 1);
    final tint = (tints != null && tints!.length == n) ? tints![index] : null;
    final pillColor = tint != null
        ? tint.bg(context)
        : (dark ? HfColors.darkSelected : HfColors.white);
    final selectedText = tint != null
        ? tint.ink(context)
        : (dark ? HfColors.darkText : HfColors.ink);
    final idleText = dark ? HfColors.mutedSoft : HfColors.muted;
    final duration = HfMotion.of(context, HfMotion.base);
    final hPad = MediaQuery.textScalerOf(context).scale(14) > 20 ? 6.0 : 0.0;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.segmentTrack,
        borderRadius: BorderRadius.circular(HfRadius.segment),
      ),
      child: Stack(
        children: [
          Positioned.fill(
            child: IgnorePointer(
              child: AnimatedAlign(
                duration: duration,
                curve: HfMotion.curve,
                alignment: Alignment(n == 1 ? 0 : -1 + 2 * index / (n - 1), 0),
                child: FractionallySizedBox(
                  widthFactor: 1 / n,
                  heightFactor: 1,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: pillColor,
                      borderRadius: BorderRadius.circular(HfRadius.segmentItem),
                      boxShadow: dark ? null : HfShadows.segment,
                    ),
                  ),
                ),
              ),
            ),
          ),
          // The labels size the control (min 40 tall, growing with wrapped text); the pill fills that box.
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < n; i++)
                  Expanded(
                    child: Semantics(
                      button: true,
                      selected: i == index,
                      label: options[i],
                      excludeSemantics: true,
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          if (i != index) onChanged(i);
                        },
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minHeight: 40),
                          child: Padding(
                            padding: EdgeInsets.symmetric(
                              horizontal: hPad,
                              vertical: 4,
                            ),
                            child: Center(
                              child: Text(
                                options[i],
                                maxLines: 2,
                                softWrap: true,
                                textAlign: TextAlign.center,
                                overflow: TextOverflow.clip,
                                style: HfText.badge.copyWith(
                                  fontWeight: i == index
                                      ? FontWeight.w700
                                      : FontWeight.w600,
                                  color: i == index ? selectedText : idleText,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
