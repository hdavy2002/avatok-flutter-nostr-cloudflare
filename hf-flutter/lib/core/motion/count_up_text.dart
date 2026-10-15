import 'package:flutter/widgets.dart';

import 'reduced_motion.dart';

/// Text that counts from its old [value] to the new one over [duration]
/// (700 ms, easeOutCubic).
///
/// [formatter] turns the number into text. For money pass the existing
/// `Money` formatter, for example `(v) => Money.paise(v.round())`: the phone
/// never computes money, it only animates the display of a value the API gave.
/// When both ends are whole numbers the in-between values are rounded, so the
/// formatter always receives an `int` for `int` values.
///
/// On first build the text shows [value] at once, unless [from] is given, in
/// which case it counts up from [from]. With reduced motion the final text is
/// shown at once. Screen readers always hear the final value.
class CountUpText extends StatefulWidget {
  const CountUpText({
    super.key,
    required this.value,
    required this.formatter,
    this.from,
    this.style,
    this.textAlign,
    this.duration = const Duration(milliseconds: 700),
    this.curve = Curves.easeOutCubic,
  });

  final num value;
  final String Function(num value) formatter;
  final num? from;
  final TextStyle? style;
  final TextAlign? textAlign;
  final Duration duration;
  final Curve curve;

  @override
  State<CountUpText> createState() => _CountUpTextState();
}

class _CountUpTextState extends State<CountUpText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late num _begin;
  late num _end;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: widget.duration);
    _begin = widget.from ?? widget.value;
    _end = widget.value;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (_begin != _end && !hfReduceMotion(context)) {
      _c.forward(from: 0);
    } else {
      _c.value = 1;
    }
  }

  @override
  void didUpdateWidget(CountUpText oldWidget) {
    super.didUpdateWidget(oldWidget);
    _c.duration = widget.duration;
    if (widget.value != oldWidget.value) {
      _begin = _current();
      _end = widget.value;
      if (hfReduceMotion(context)) {
        _c.value = 1;
      } else {
        _c.forward(from: 0);
      }
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  num _current() {
    if (_c.value >= 1) return _end;
    final t = widget.curve.transform(_c.value);
    final v = _begin + (_end - _begin) * t;
    return (_begin is int && _end is int) ? v.round() : v;
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: widget.formatter(widget.value),
      excludeSemantics: true,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, child) => Text(
          widget.formatter(_current()),
          style: widget.style,
          textAlign: widget.textAlign,
        ),
      ),
    );
  }
}
