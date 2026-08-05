part of '../chat_thread.dart';


/// [CHAT-UI-GESTURES-1] Swipe-to-reply. A horizontal drag on a bubble toward
/// its "inner" edge (left for my own right-aligned bubbles, right for a
/// peer's left-aligned ones) past a ~40px threshold arms the same Reply
/// action the long-press menu already invokes (`_replyTo = m`); releasing
/// past the threshold fires it, with a light haptic the moment it arms. The
/// bubble itself translates with the drag and a small reply-arrow fades in on
/// the revealed side. `onReply == null` disables the gesture entirely (system
/// pills, soft-deleted rows, the transient "Ava is thinking…" chip) and the
/// wrapper becomes a transparent passthrough — the existing long-press menu
/// (owned by the child) is completely untouched either way.
class _SwipeToReply extends StatefulWidget {
  const _SwipeToReply({required this.mine, required this.onReply, required this.child});
  final bool mine;
  final VoidCallback? onReply;
  final Widget child;

  @override
  State<_SwipeToReply> createState() => _SwipeToReplyState();
}

class _SwipeToReplyState extends State<_SwipeToReply> {
  static const double _threshold = 40;
  static const double _maxDrag = 72;
  double _dx = 0;
  bool _armed = false;

  @override
  Widget build(BuildContext context) {
    final onReply = widget.onReply;
    if (onReply == null) return widget.child;
    final progress = (_dx.abs() / _threshold).clamp(0.0, 1.0);
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onHorizontalDragUpdate: (d) {
        final raw = _dx + d.delta.dx;
        final clamped = widget.mine ? raw.clamp(-_maxDrag, 0.0) : raw.clamp(0.0, _maxDrag);
        setState(() => _dx = clamped);
        final crossed = clamped.abs() >= _threshold;
        if (crossed && !_armed) {
          _armed = true;
          HapticFeedback.lightImpact();
        } else if (!crossed && _armed) {
          _armed = false;
        }
      },
      onHorizontalDragEnd: (_) {
        final fire = _armed;
        setState(() { _dx = 0; _armed = false; });
        if (fire) onReply();
      },
      onHorizontalDragCancel: () => setState(() { _dx = 0; _armed = false; }),
      child: Stack(clipBehavior: Clip.none, children: [
        if (_dx != 0)
          Positioned(
            top: 0,
            bottom: 0,
            right: widget.mine ? 6 : null,
            left: widget.mine ? null : 6,
            child: Center(
              child: Opacity(
                opacity: progress,
                child: Icon(PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), size: 18, color: AD.iconSearch),
              ),
            ),
          ),
        Transform.translate(offset: Offset(_dx, 0), child: widget.child),
      ]),
    );
  }
}

/// [CHAT-UI-VIEWER-1] Fullscreen, pinch-to-zoom image viewer pushed via a
/// fade `PageRouteBuilder` from `_openImageBytes` (replacing the old bare
/// `showDialog`). `heroTag` — when it matches the tag on the thumbnail that
/// was tapped — lets the platform Navigator's HeroController fly the image
/// from its list position into the fullscreen frame instead of a hard cut.
/// Swipe-down-to-dismiss: a vertical drag translates + fades the image; past
/// ~120px (or a fast downward fling) the viewer pops itself.
class _FullscreenImageViewer extends StatefulWidget {
  const _FullscreenImageViewer({
    required this.bytes,
    required this.heroTag,
    required this.onCopy,
    this.onDecodeError,
  });
  final Uint8List bytes;
  final Object? heroTag;
  final VoidCallback onCopy;
  final VoidCallback? onDecodeError;

  @override
  State<_FullscreenImageViewer> createState() => _FullscreenImageViewerState();
}

class _FullscreenImageViewerState extends State<_FullscreenImageViewer> {
  double _dy = 0;

  static const double _dismissDrag = 120;

  Widget _btn(IconData icon, String tooltip, VoidCallback onTap) => DecoratedBox(
        decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
        child: IconButton(
          tooltip: tooltip,
          icon: Icon(icon, color: Colors.white),
          onPressed: onTap,
        ),
      );

  @override
  Widget build(BuildContext context) {
    final h = MediaQuery.of(context).size.height;
    final progress = (_dy.abs() / (h * 0.4)).clamp(0.0, 1.0);
    final image = Image.memory(widget.bytes, errorBuilder: (_, __, ___) {
      widget.onDecodeError?.call();
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text("Couldn't load image", style: TextStyle(color: Colors.white)),
      );
    });
    return Scaffold(
      backgroundColor: Colors.black.withOpacity(1 - progress * 0.7),
      body: GestureDetector(
        onVerticalDragUpdate: (d) => setState(() => _dy += d.delta.dy),
        onVerticalDragEnd: (d) {
          final fling = (d.primaryVelocity ?? 0).abs() > 800;
          if (_dy.abs() > _dismissDrag || fling) {
            Navigator.of(context).maybePop();
          } else {
            setState(() => _dy = 0);
          }
        },
        child: Stack(children: [
          Positioned.fill(
            child: Transform.translate(
              offset: Offset(0, _dy),
              child: Opacity(
                opacity: 1 - progress * 0.7,
                child: InteractiveViewer(
                  minScale: 0.8,
                  maxScale: 5,
                  child: Center(
                    child: widget.heroTag == null
                        ? image
                        : Hero(tag: widget.heroTag!, child: image),
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            top: 40, right: 8,
            child: _btn(PhosphorIcons.x(PhosphorIconsStyle.bold), 'Close', () => Navigator.of(context).maybePop()),
          ),
          Positioned(
            top: 40, left: 8,
            child: _btn(PhosphorIcons.copy(PhosphorIconsStyle.bold), 'Copy', widget.onCopy),
          ),
        ]),
      ),
    );
  }
}

/// [CHAT-UI-COMPOSER-1] Three dots that bounce in a staggered wave — the
/// classic "someone is typing" indicator. No new package: a single
/// AnimationController driving three `sin`-offset dots.
class _TypingDots extends StatefulWidget {
  const _TypingDots({required this.color});
  final Color color;

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        return Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) const SizedBox(width: 4),
            Builder(builder: (context) {
              // Stagger each dot by a third of the cycle; bounce via |sin|.
              final phase = (_c.value + i / 3) % 1.0;
              final lift = (math.sin(phase * math.pi * 2).abs()) * 4;
              return Transform.translate(
                offset: Offset(0, -lift),
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(color: widget.color.withValues(alpha: 0.65), shape: BoxShape.circle),
                ),
              );
            }),
          ],
        ]);
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [VOICE-REC-1] Recording-bar chrome (owner report 2026-07-16, pic 5).
// ─────────────────────────────────────────────────────────────────────────────

/// A red dot that pulses while the recorder is live and holds steady while
/// paused. Small, but it is the ambient "this is running" signal that the old
/// bar's static text couldn't give — a still icon reads the same whether the
/// mic is hot or the recorder has quietly fallen over.
class _RecordingDot extends StatefulWidget {
  const _RecordingDot({required this.active});
  final bool active;

  @override
  State<_RecordingDot> createState() => _RecordingDotState();
}

class _RecordingDotState extends State<_RecordingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) {
      return const _Dot(opacity: 0.45);
    }
    return FadeTransition(
      opacity: Tween<double>(begin: 1.0, end: 0.25).animate(_c),
      child: const _Dot(opacity: 1),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.opacity});
  final double opacity;

  @override
  Widget build(BuildContext context) => Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(
          color: AD.danger.withValues(alpha: opacity),
          shape: BoxShape.circle,
        ),
      );
}
