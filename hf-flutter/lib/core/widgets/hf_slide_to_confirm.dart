import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/hf_theme.dart';

/// "Slide to call" control (mockup `CallSheet`): a 68 px ink track (radius 34, padding 6) with a 56 px white
/// knob carrying [icon]. Dragging the knob past 90% of the track gives a `mediumImpact` haptic and calls
/// [onConfirm]; a shorter drag springs back (instant on reduced motion). Below the track there is ALWAYS a
/// text button [fallbackLabel] (for example "Or tap here to call", min 44 px high) that calls [onFallback], so
/// the action never depends on a drag gesture. Screen readers get one button named [label] whose activation
/// calls [onConfirm]. With [enabled] false both controls are inert and dimmed.
class HfSlideToConfirm extends StatefulWidget {
  const HfSlideToConfirm({
    super.key,
    required this.label,
    required this.icon,
    required this.onConfirm,
    required this.fallbackLabel,
    required this.onFallback,
    this.enabled = true,
  });

  final String label;
  final IconData icon;
  final VoidCallback onConfirm;
  final String fallbackLabel;
  final VoidCallback onFallback;
  final bool enabled;

  @override
  State<HfSlideToConfirm> createState() => _HfSlideToConfirmState();
}

class _HfSlideToConfirmState extends State<HfSlideToConfirm> with SingleTickerProviderStateMixin {
  static const double _knob = 56;
  static const double _pad = 6;
  static const double _threshold = 0.9;

  late final AnimationController _back = AnimationController(vsync: this);
  double _fraction = 0;
  Animation<double>? _backAnim;

  @override
  void initState() {
    super.initState();
    _back.addListener(() {
      final a = _backAnim;
      if (a != null) setState(() => _fraction = a.value);
    });
  }

  @override
  void dispose() {
    _back.dispose();
    super.dispose();
  }

  void _springBack() {
    if (!mounted) return;
    _backAnim = Tween<double>(begin: _fraction, end: 0).animate(CurvedAnimation(parent: _back, curve: HfMotion.curve));
    _back.duration = HfMotion.of(context, HfMotion.slow);
    _back.forward(from: 0);
    if (_back.duration == Duration.zero) setState(() => _fraction = 0);
  }

  void _confirm() {
    if (!widget.enabled) return;
    HapticFeedback.mediumImpact();
    widget.onConfirm();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final trackColor = dark ? HfColors.darkSelected : HfColors.ink;
    final knobColor = dark ? HfColors.lavender : HfColors.white;
    return Opacity(
      opacity: widget.enabled ? 1 : 0.5,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LayoutBuilder(
            builder: (context, constraints) {
              final maxDrag = (constraints.maxWidth - _knob - _pad * 2).clamp(1.0, double.infinity);
              return Semantics(
                button: true,
                enabled: widget.enabled,
                label: widget.label,
                onTap: widget.enabled ? _confirm : null,
                excludeSemantics: true,
                child: Container(
                  height: 68,
                  padding: const EdgeInsets.all(_pad),
                  decoration: BoxDecoration(color: trackColor, borderRadius: BorderRadius.circular(34)),
                  child: Stack(
                    alignment: Alignment.centerLeft,
                    children: [
                      Positioned.fill(
                        child: Padding(
                          padding: const EdgeInsets.only(left: _knob),
                          child: Center(
                            child: Opacity(
                              opacity: (1 - _fraction * 1.5).clamp(0.0, 1.0),
                              child: Text(
                                widget.label,
                                textAlign: TextAlign.center,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: HfText.button.copyWith(color: dark ? HfColors.darkText : HfColors.white),
                              ),
                            ),
                          ),
                        ),
                      ),
                      Positioned(
                        left: _fraction * maxDrag,
                        child: GestureDetector(
                          key: const ValueKey<String>('hf-slide-knob'),
                          behavior: HitTestBehavior.opaque,
                          onHorizontalDragStart: (_) {
                            if (_back.isAnimating) _back.stop();
                          },
                          onHorizontalDragUpdate: (d) {
                            if (!widget.enabled) return;
                            setState(() => _fraction = (_fraction + d.delta.dx / maxDrag).clamp(0.0, 1.0));
                          },
                          onHorizontalDragEnd: (_) {
                            if (!widget.enabled) return;
                            if (_fraction >= _threshold) {
                              setState(() => _fraction = 1);
                              _confirm();
                            }
                            _springBack();
                          },
                          onHorizontalDragCancel: _springBack,
                          child: Container(
                            width: _knob,
                            height: _knob,
                            decoration: BoxDecoration(
                              color: knobColor,
                              shape: BoxShape.circle,
                              boxShadow: HfShadows.knob,
                            ),
                            child: Icon(widget.icon, size: 22, color: HfColors.ink),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          const SizedBox(height: HfSpacing.xs),
          Center(
            child: TextButton(
              onPressed: widget.enabled ? widget.onFallback : null,
              style: TextButton.styleFrom(minimumSize: const Size(HfSpacing.tap, 44)),
              child: Text(widget.fallbackLabel),
            ),
          ),
        ],
      ),
    );
  }
}
