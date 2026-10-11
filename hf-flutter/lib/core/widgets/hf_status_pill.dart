import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// A host's presence. [fromApi] maps the server `status` string.
enum HfPresence {
  online,
  busy,
  offline,
  away;

  /// `online`, `busy` (also `on_call`), `away`; anything else (including null) is offline.
  static HfPresence fromApi(String? status) {
    switch (status) {
      case 'online':
        return HfPresence.online;
      case 'busy':
      case 'on_call':
        return HfPresence.busy;
      case 'away':
        return HfPresence.away;
      default:
        return HfPresence.offline;
    }
  }

  /// The words on the pill.
  String get label => switch (this) {
        HfPresence.online => 'Online now',
        HfPresence.busy => 'On a call',
        HfPresence.offline => 'Offline',
        HfPresence.away => 'Not taking calls',
      };
}

/// Presence pill: online is blush with a rose dot, busy is butter with an amber dot, offline and away are soft
/// grey. 14/700 text, padding 8x12 (10x14 and 16 sp when [large]), radius 16, 9 px dot. The online dot pulses
/// gently (1.6 s) unless [animate] is false or the phone asks for no animations: pass `animate: false` in
/// widget tests that use `pumpAndSettle`.
class HfStatusPill extends StatefulWidget {
  const HfStatusPill({super.key, required this.status, this.large = false, this.animate = true});

  final HfPresence status;
  final bool large;
  final bool animate;

  @override
  State<HfStatusPill> createState() => _HfStatusPillState();
}

class _HfStatusPillState extends State<HfStatusPill> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(HfStatusPill old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final run = widget.animate && widget.status == HfPresence.online && !MediaQuery.disableAnimationsOf(context);
    if (run) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse.stop();
      _pulse.value = 1;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final (Color bg, Color fg, Color dot) = switch (widget.status) {
      HfPresence.online => dark
          ? (HfColors.darkTileBlush, HfColors.blushLight, HfColors.blushDot)
          : (HfColors.blush, HfColors.blushDeep, HfColors.roseDot),
      HfPresence.busy => dark
          ? (HfColors.darkBar, HfColors.star, HfColors.star)
          : (HfColors.butter, HfColors.butterDeep, HfColors.amberDot),
      HfPresence.offline || HfPresence.away => dark
          ? (HfColors.darkBar, HfColors.mutedSoft, HfColors.mutedSoft)
          : (HfColors.surfaceSoft, HfColors.muted, HfColors.muted),
    };
    final text = widget.status.label;
    return Semantics(
      label: text,
      excludeSemantics: true,
      child: Container(
        padding: widget.large ? const EdgeInsets.symmetric(horizontal: 14, vertical: 10) : const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(HfRadius.segment)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            FadeTransition(
              opacity: Tween<double>(begin: 0.4, end: 1).animate(_pulse),
              child: Container(width: 9, height: 9, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
            ),
            const SizedBox(width: 7),
            Flexible(
              child: Text(text,
                  style: HfText.badge.copyWith(color: fg, fontSize: widget.large ? 16 : 14)),
            ),
          ],
        ),
      ),
    );
  }
}
