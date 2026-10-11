import 'package:flutter/material.dart';

import '../theme/hf_tokens.dart';

/// A host's presence on the profile and the cards.
enum HostPresence {
  online,
  busy,
  offline;

  /// Maps the server's `status` string (`online | busy | offline`). Anything else is offline.
  static HostPresence parse(Object? status) {
    switch ('$status') {
      case 'online':
        return HostPresence.online;
      case 'busy':
        return HostPresence.busy;
      default:
        return HostPresence.offline;
    }
  }
}

/// "Online now" / "On a call" / "Offline". Approved native status palette with
/// a pulsing dot. Text is 14 sp bold. Pass `animate: false` in widget tests (a repeating animation never
/// settles); the dot also stays still when the phone has animations turned off.
class StatusPill extends StatefulWidget {
  const StatusPill({super.key, required this.presence, this.animate = true});

  final HostPresence presence;
  final bool animate;

  @override
  State<StatusPill> createState() => _StatusPillState();
}

class _StatusPillState extends State<StatusPill> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  bool _shouldPulse(BuildContext context) =>
      widget.animate && widget.presence == HostPresence.online && !MediaQuery.disableAnimationsOf(context);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_shouldPulse(context)) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse.stop();
      _pulse.value = 1;
    }
  }

  @override
  void didUpdateWidget(StatusPill oldWidget) {
    super.didUpdateWidget(oldWidget);
    didChangeDependencies();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final (String text, Color fg, Color bg, Color border) = switch (widget.presence) {
      HostPresence.online => ('Online now', HfColors.forest, HfColors.mint, HfColors.mint),
      HostPresence.busy => ('On a call', HfColors.ink, HfColors.butter, HfColors.butter),
      HostPresence.offline => ('Offline', HfColors.mauve, HfColors.white, HfColors.line),
    };
    return Semantics(
      label: text,
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(HfRadius.pill),
          border: Border.all(color: border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            FadeTransition(
              opacity: Tween<double>(begin: 0.35, end: 1).animate(_pulse),
              child: Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(color: fg, shape: BoxShape.circle),
              ),
            ),
            const SizedBox(width: 8),
            Text(text, style: HfText.badge.copyWith(color: fg)),
          ],
        ),
      ),
    );
  }
}
