import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';

import '../avatok_dark.dart';
import '../messenger_theme.dart';

/// The visual toast card — a paper surface with the standard card outline
/// and hard-offset ink shadow, nothing about timing lives here.
///
/// Kept separate from the overlay/animation plumbing in [showAdToast] so a
/// caller that wants the toast's look inside its own transition (a preview,
/// a design-review surface) can use it without the overlay machinery.
class AdToast extends StatelessWidget {
  const AdToast({super.key, required this.message, this.icon});

  final String message;
  final Widget? icon;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 360),
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brMd,
          border: Border.fromBorderSide(Msg.border),
          boxShadow: Msg.lift,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[icon!, const SizedBox(width: Msg.s2)],
            Flexible(
              child: Text(
                message,
                style: ADText.bubbleBody(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shows an [AdToast] in the app [Overlay] and self-dismisses after
/// [visibleFor]. Uses an [OverlayEntry] rather than a [SnackBar] because a
/// `SnackBar` owns its own timing and curve — this widget needs both, and
/// needs them asymmetric.
///
/// Arrival is deliberate ([Msg.slow]): a toast interrupts, so it should not
/// feel like it snuck in. Departure is snappy ([Msg.fast]) — once the
/// message has landed there is nothing left to look at. The rise (16px),
/// the 0.97→1 scale and the 2px cross-blur are all short on purpose; this
/// library reads motion through blur and travel together, not through
/// distance alone.
///
/// Returns a [Future] that completes once the toast has fully dismissed and
/// removed itself from the overlay.
Future<void> showAdToast(
  BuildContext context, {
  required String message,
  Widget? icon,
  Duration visibleFor = const Duration(seconds: 2),
}) {
  final overlayState = Overlay.of(context);
  final completer = Completer<void>();
  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (overlayContext) => _AdToastAnimator(
      message: message,
      icon: icon,
      visibleFor: visibleFor,
      onFinished: () {
        entry.remove();
        if (!completer.isCompleted) completer.complete();
      },
    ),
  );
  overlayState.insert(entry);
  return completer.future;
}

class _AdToastAnimator extends StatefulWidget {
  const _AdToastAnimator({
    required this.message,
    required this.icon,
    required this.visibleFor,
    required this.onFinished,
  });

  final String message;
  final Widget? icon;
  final Duration visibleFor;
  final VoidCallback onFinished;

  @override
  State<_AdToastAnimator> createState() => _AdToastAnimatorState();
}

class _AdToastAnimatorState extends State<_AdToastAnimator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  Timer? _timer;
  bool _reduce = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: Msg.slow,
      reverseDuration: Msg.fast,
    );
    _reduce = MediaQuery.of(context).disableAnimations;
    if (_reduce) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
    _timer = Timer(widget.visibleFor, _dismiss);
  }

  Future<void> _dismiss() async {
    if (!mounted) return;
    if (_reduce) {
      widget.onFinished();
      return;
    }
    await _controller.reverse();
    if (!mounted) return;
    widget.onFinished();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      left: Msg.s4,
      right: Msg.s4,
      bottom: Msg.s6,
      child: IgnorePointer(
        child: Center(
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, child) {
              final t = _reduce ? 1.0 : _controller.value.clamp(0.0, 1.0);
              final dy = (1 - t) * 16;
              final scale = 0.97 + 0.03 * t;
              final blur = (1 - t) * 2;
              return Opacity(
                opacity: t,
                child: Transform.translate(
                  offset: Offset(0, dy),
                  child: Transform.scale(
                    scale: scale,
                    child: ImageFiltered(
                      imageFilter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
                      child: child,
                    ),
                  ),
                ),
              );
            },
            child: AdToast(message: widget.message, icon: widget.icon),
          ),
        ),
      ),
    );
  }
}
