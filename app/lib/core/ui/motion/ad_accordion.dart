import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../messenger_theme.dart';

/// A header plus a collapsible body. The body height animates with
/// [AnimatedSize] and the chevron flips through a flat line rather than
/// snapping between down/up glyphs — the flat instant reads as a hinge, the
/// same shape change [AnimatedSize] is already giving the body.
///
/// [Msg.base] and [Msg.settle] in both directions: expand and collapse are
/// both ordinary enters/exits of the same UI element, not a dismissal (which
/// would want [Msg.fast]) or a reward (which would want [Msg.pop]).
class AdAccordion extends StatefulWidget {
  const AdAccordion({
    super.key,
    required this.header,
    required this.body,
    this.initiallyExpanded = false,
    this.onExpansionChanged,
  });

  final Widget header;
  final Widget body;
  final bool initiallyExpanded;
  final ValueChanged<bool>? onExpansionChanged;

  @override
  State<AdAccordion> createState() => _AdAccordionState();
}

class _AdAccordionState extends State<AdAccordion> {
  late bool _expanded = widget.initiallyExpanded;

  void _toggle() {
    setState(() => _expanded = !_expanded);
    widget.onExpansionChanged?.call(_expanded);
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    final duration = reduce ? Duration.zero : Msg.base;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: _toggle,
          child: Row(
            children: [
              Expanded(child: widget.header),
              const SizedBox(width: Msg.s2),
              TweenAnimationBuilder<double>(
                tween: Tween(begin: _expanded ? 1.0 : 0.0, end: _expanded ? 1.0 : 0.0),
                duration: duration,
                curve: Msg.settle,
                builder: (context, t, child) {
                  // cos(pi*t) runs 1 -> 0 (flat) -> -1, a continuous vertical
                  // flip through the flat line at the midpoint.
                  final scaleY = math.cos(math.pi * t);
                  return Transform(
                    alignment: Alignment.center,
                    transform: Matrix4.diagonal3Values(1, scaleY, 1),
                    child: child,
                  );
                },
                child: Icon(
                  PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                  size: 18,
                  color: Msg.icon,
                ),
              ),
            ],
          ),
        ),
        ClipRect(
          child: AnimatedSize(
            duration: duration,
            curve: Msg.settle,
            alignment: Alignment.topCenter,
            child: _expanded
                ? Padding(
                    padding: const EdgeInsets.only(top: Msg.s2),
                    child: widget.body,
                  )
                : const SizedBox(width: double.infinity, height: 0),
          ),
        ),
      ],
    );
  }
}
