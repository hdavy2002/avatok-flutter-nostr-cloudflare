import 'package:flutter/material.dart';

/// Native motion vocabulary. Business state never waits for an animation.
abstract final class HfMotion {
  static const press = Duration(milliseconds: 100);
  static const quick = Duration(milliseconds: 180);
  static const standard = Duration(milliseconds: 260);
  static const entrance = Duration(milliseconds: 420);
  static const curve = Curves.easeOutCubic;

  static bool enabled(BuildContext context) {
    final active = context.dependOnInheritedWidgetOfExactType<_MotionSettings>()?.active ?? true;
    final media = MediaQuery.maybeOf(context);
    return active && !(media?.disableAnimations ?? false) &&
        !(media?.accessibleNavigation ?? false) && TickerMode.of(context);
  }

  static Duration duration(BuildContext context, [Duration value = standard]) =>
      enabled(context) ? value : Duration.zero;
}

/// Rebuilds motion consumers on background/resume and OS accessibility changes.
/// Does not mute real video or alter its independent ReelGate authority.
class HfMotionScope extends StatefulWidget {
  const HfMotionScope({super.key, required this.child});
  final Widget child;
  @override
  State<HfMotionScope> createState() => _HfMotionScopeState();
}

class _HfMotionScopeState extends State<HfMotionScope> with WidgetsBindingObserver {
  bool _active = WidgetsBinding.instance.lifecycleState == null ||
      WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final active = state == AppLifecycleState.resumed;
    if (active != _active) setState(() => _active = active);
  }
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
  @override
  Widget build(BuildContext context) => _MotionSettings(active: _active, child: widget.child);
}

class _MotionSettings extends InheritedWidget {
  const _MotionSettings({required this.active, required super.child});
  final bool active;
  @override
  bool updateShouldNotify(_MotionSettings oldWidget) => active != oldWidget.active;
}

/// A single, short entrance; a changed trigger animates the SAME child element.
/// No outgoing copy, delayed tap, recreated form, or animation completion action.
class HfReveal extends StatefulWidget {
  const HfReveal({super.key, required this.child, this.trigger, this.distance = 8,
    this.duration = HfMotion.standard});
  final Widget child;
  final Object? trigger;
  final double distance;
  final Duration duration;
  @override
  State<HfReveal> createState() => _HfRevealState();
}

class _HfRevealState extends State<HfReveal> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(vsync: this, duration: widget.duration);
  bool _started = false;
  bool _enabled = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled = HfMotion.enabled(context);
    if (!_enabled) {
      _controller.value = 1;
      _started = true;
    } else if (!_started) {
      _started = true;
      _controller.forward();
    }
  }
  @override
  void didUpdateWidget(HfReveal oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.duration = widget.duration;
    if (oldWidget.trigger != widget.trigger) {
      if (_enabled) { _controller.forward(from: 0); } else { _controller.value = 1; }
    }
  }
  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    child: widget.child,
    builder: (context, child) {
      final value = HfMotion.curve.transform(_controller.value);
      // Keep text and controls visible and accessible throughout the entrance.
      return Transform.translate(offset: Offset(0, widget.distance * (1 - value)),
        child: Opacity(opacity: 0.75 + value * 0.25, child: child));
    },
  );
}

/// Pointer feedback only: the existing button retains sole ownership of onTap.
class HfPress extends StatefulWidget {
  const HfPress({super.key, required this.child, this.enabled = true});
  final Widget child;
  final bool enabled;
  @override
  State<HfPress> createState() => _HfPressState();
}

class _HfPressState extends State<HfPress> {
  bool _pressed = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!HfMotion.enabled(context)) _pressed = false;
  }
  @override
  void didUpdateWidget(HfPress oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled) _pressed = false;
  }
  @override
  Widget build(BuildContext context) {
    final animate = widget.enabled && HfMotion.enabled(context);
    return Listener(
      onPointerDown: animate ? (_) => setState(() => _pressed = true) : null,
      onPointerUp: (_) => setState(() => _pressed = false),
      onPointerCancel: (_) => setState(() => _pressed = false),
      child: HfAnimatedValue(
        value: animate && _pressed ? 0.98 : 1,
        duration: HfMotion.duration(context, HfMotion.press), curve: HfMotion.curve,
        child: widget.child,
        builder: (context, scale, child) => Transform.scale(
          scale: scale, transformHitTests: false, child: child),
      ),
    );
  }
}

/// Small selection cue without replacing the selected content or its semantics.
class HfSelection extends StatelessWidget {
  const HfSelection({super.key, required this.selected, required this.child});
  final bool selected;
  final Widget child;
  @override
  Widget build(BuildContext context) => HfAnimatedValue(
    value: selected ? -2 : 0,
    duration: HfMotion.duration(context, HfMotion.quick), curve: HfMotion.curve,
    child: child,
    builder: (context, value, child) => Transform.translate(
      offset: Offset(0, value), transformHitTests: false, child: child),
  );
}

/// Keeps MaterialPageRoute / PageRoute and the existing route observer intact.
class HfPageTransitionsBuilder extends PageTransitionsBuilder {
  const HfPageTransitionsBuilder({this.cupertino = false});
  final bool cupertino;
  @override
  Widget buildTransitions<T>(PageRoute<T> route, BuildContext context,
      Animation<double> animation, Animation<double> secondaryAnimation, Widget child) {
    final enabled = HfMotion.enabled(context);
    // Keep the wrapper tree stable when the OS setting changes mid-route.
    if (cupertino) {
      return const CupertinoPageTransitionsBuilder().buildTransitions(
        route, context,
        enabled ? animation : const AlwaysStoppedAnimation<double>(1),
        enabled ? secondaryAnimation : const AlwaysStoppedAnimation<double>(0),
        child);
    }
    return AnimatedBuilder(animation: animation, child: child, builder: (context, child) {
      final value = enabled ? HfMotion.curve.transform(animation.value) : 1.0;
      return Transform.translate(offset: Offset(0, 12 * (1 - value)),
        child: Opacity(opacity: value, child: child));
    });
  }
}

/// Implicit transitions normally keep an existing simulation when only duration
/// changes. Explicitly settle it so OS changes take effect in the current frame.
mixin _SettleMotion<T extends ImplicitlyAnimatedWidget> on ImplicitlyAnimatedWidgetState<T> {
  @override
  void didUpdateWidget(covariant T oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.duration == Duration.zero) controller.value = 1;
  }
}

class HfAnimatedValue extends ImplicitlyAnimatedWidget {
  const HfAnimatedValue({super.key, required this.value, required this.builder,
    this.child, required super.duration, super.curve = HfMotion.curve});
  final double value;
  final Widget? child;
  final Widget Function(BuildContext, double, Widget?) builder;
  @override
  AnimatedWidgetBaseState<HfAnimatedValue> createState() => _HfAnimatedValueState();
}

class _HfAnimatedValueState extends AnimatedWidgetBaseState<HfAnimatedValue>
    with _SettleMotion<HfAnimatedValue> {
  Tween<double>? _value;
  @override
  void forEachTween(TweenVisitor<dynamic> visitor) {
    _value = visitor(_value, widget.value, (dynamic value) => Tween<double>(begin: value as double)) as Tween<double>?;
  }
  @override
  Widget build(BuildContext context) => widget.builder(context, _value!.evaluate(animation), widget.child);
}

/// AnimatedContainer vocabulary with a stable child and immediate zero-duration
/// settling, including when the selection target itself has not changed.
class HfAnimatedContainer extends AnimatedContainer {
  HfAnimatedContainer({super.key, super.child, super.color, super.decoration,
    super.width, super.height, super.padding, super.margin, super.alignment,
    required super.duration, super.curve = HfMotion.curve});
  @override
  AnimatedWidgetBaseState<AnimatedContainer> createState() => _HfAnimatedContainerState();
}

class _HfAnimatedContainerState extends AnimatedWidgetBaseState<AnimatedContainer>
    with _SettleMotion<AnimatedContainer> {
  AlignmentGeometryTween? _alignment;
  EdgeInsetsGeometryTween? _padding;
  EdgeInsetsGeometryTween? _margin;
  DecorationTween? _decoration;
  BoxConstraintsTween? _constraints;
  @override
  void forEachTween(TweenVisitor<dynamic> visitor) {
    _alignment = visitor(_alignment, widget.alignment,
      (dynamic value) => AlignmentGeometryTween(begin: value as AlignmentGeometry)) as AlignmentGeometryTween?;
    _padding = visitor(_padding, widget.padding,
      (dynamic value) => EdgeInsetsGeometryTween(begin: value as EdgeInsetsGeometry)) as EdgeInsetsGeometryTween?;
    _margin = visitor(_margin, widget.margin,
      (dynamic value) => EdgeInsetsGeometryTween(begin: value as EdgeInsetsGeometry)) as EdgeInsetsGeometryTween?;
    _decoration = visitor(_decoration, widget.decoration,
      (dynamic value) => DecorationTween(begin: value as Decoration)) as DecorationTween?;
    _constraints = visitor(_constraints, widget.constraints,
      (dynamic value) => BoxConstraintsTween(begin: value as BoxConstraints)) as BoxConstraintsTween?;
  }
  @override
  Widget build(BuildContext context) => Container(
    alignment: _alignment?.evaluate(animation),
    padding: _padding?.evaluate(animation),
    margin: _margin?.evaluate(animation),
    decoration: _decoration?.evaluate(animation),
    constraints: _constraints?.evaluate(animation),
    child: widget.child,
  );
}

class HfAnimatedOpacity extends AnimatedOpacity {
  const HfAnimatedOpacity({super.key, required super.opacity, required super.child,
    required super.duration, super.curve = HfMotion.curve});
  @override
  ImplicitlyAnimatedWidgetState<AnimatedOpacity> createState() => _HfAnimatedOpacityState();
}

class _HfAnimatedOpacityState extends AnimatedWidgetBaseState<AnimatedOpacity>
    with _SettleMotion<AnimatedOpacity> {
  Tween<double>? _opacity;
  @override
  void forEachTween(TweenVisitor<dynamic> visitor) {
    _opacity = visitor(_opacity, widget.opacity,
      (dynamic value) => Tween<double>(begin: value as double)) as Tween<double>?;
  }
  @override
  Widget build(BuildContext context) => Opacity(opacity: _opacity!.evaluate(animation), child: widget.child);
}
