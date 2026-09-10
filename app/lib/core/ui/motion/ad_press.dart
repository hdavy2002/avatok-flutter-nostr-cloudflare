import 'package:flutter/material.dart';

import '../messenger_theme.dart';

/// A 0.96 press-scale wrapper for any tappable child — the touch-device
/// substitute for the hover states a web-first component library reaches
/// for, which have nothing to answer to on a phone.
///
/// [Msg.fast] because a press response has to feel immediate, and
/// [Msg.settle] because a button shrinking under a finger should not
/// overshoot — overshoot on press-down reads as the control fighting the
/// touch rather than yielding to it.
class AdPress extends StatefulWidget {
  const AdPress({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.pressScale = 0.96,
  });

  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final double pressScale;

  @override
  State<AdPress> createState() => _AdPressState();
}

class _AdPressState extends State<AdPress> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: Msg.fast);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _setPressed(bool pressed) {
    if (MediaQuery.of(context).disableAnimations) return;
    if (pressed) {
      _controller.forward();
    } else {
      _controller.reverse();
    }
  }

  @override
  Widget build(BuildContext context) {
    final curved = CurvedAnimation(parent: _controller, curve: Msg.settle, reverseCurve: Msg.settle);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      onLongPress: widget.onLongPress,
      onTapDown: (_) => _setPressed(true),
      onTapCancel: () => _setPressed(false),
      onTapUp: (_) => _setPressed(false),
      child: AnimatedBuilder(
        animation: curved,
        builder: (context, child) {
          final scale = 1 - (1 - widget.pressScale) * curved.value.clamp(0.0, 1.0);
          return Transform.scale(scale: scale, child: child);
        },
        child: widget.child,
      ),
    );
  }
}
