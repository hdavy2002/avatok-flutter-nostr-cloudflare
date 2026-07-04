import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../analytics.dart';
import '../ui/zine.dart';
import 'call_session.dart';

/// Draggable floating video thumbnail shown while a 1:1 VIDEO call is minimized.
///
/// Renders the session's REMOTE [RTCVideoRenderer] (re-attached, never a second
/// renderer — the session owns it and disposes it in hangup). ~110×180 rounded
/// card. Pan-draggable; on release it snaps to the nearest horizontal edge with
/// a spring animation, staying clear of the status bar, keyboard and safe areas.
/// Position is kept in-memory for the lifetime of the call.
///
/// Tap → restore the full call screen. Two mini controls overlay the card: a
/// mute toggle and a red end button. When the transport is recovering it shows a
/// "Reconnecting…" scrim.
class CallPipThumbnail extends StatefulWidget {
  const CallPipThumbnail({
    super.key,
    required this.session,
    required this.onReturn,
  });

  final CallSession session;

  /// Called on a plain tap — the overlay clears [CallSession.minimized] and
  /// re-presents the full call screen.
  final VoidCallback onReturn;

  @override
  State<CallPipThumbnail> createState() => _CallPipThumbnailState();
}

class _CallPipThumbnailState extends State<CallPipThumbnail>
    with SingleTickerProviderStateMixin {
  static const double _w = 110;
  static const double _h = 180;
  static const double _pad = 12; // gap from screen edges

  // Top-left position in the overlay's coordinate space. Null until first laid
  // out so we can seed it to the top-right corner honouring insets.
  Offset? _pos;
  bool _dragging = false;

  late final AnimationController _spring = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 260),
  );
  Animation<Offset>? _snap;

  @override
  void dispose() {
    _spring.dispose();
    super.dispose();
  }

  // The draggable region, inset by the status bar (top), safe areas and the
  // keyboard (bottom).
  Rect _bounds(Size screen, EdgeInsets insets, double keyboard) {
    final top = insets.top + 8;
    final bottom = screen.height -
        (keyboard > 0 ? keyboard : insets.bottom) -
        _h -
        8;
    final left = insets.left + _pad;
    final right = screen.width - insets.right - _w - _pad;
    return Rect.fromLTRB(
      left,
      top,
      right < left ? left : right,
      bottom < top ? top : bottom,
    );
  }

  Offset _clamp(Offset p, Rect b) => Offset(
        p.dx.clamp(b.left, b.right),
        p.dy.clamp(b.top, b.bottom),
      );

  void _snapToEdge(Size screen, Rect b) {
    final p = _pos!;
    // Nearest horizontal edge.
    final toLeft = (p.dx - b.left).abs();
    final toRight = (b.right - p.dx).abs();
    final targetX = toLeft <= toRight ? b.left : b.right;
    final target = Offset(targetX, p.dy.clamp(b.top, b.bottom));
    _snap = Tween<Offset>(begin: p, end: target).animate(
      CurvedAnimation(parent: _spring, curve: Curves.easeOutBack),
    );
    _spring
      ..reset()
      ..forward();
    _snap!.addListener(() {
      if (!mounted) return;
      setState(() => _pos = _snap!.value);
    });
  }

  void _restore() {
    Analytics.capture('call_restored', {
      'call_id': widget.session.room,
      'from': 'pip',
      'video': widget.session.video,
    });
    widget.onReturn();
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final screen = mq.size;
    final insets = mq.padding;
    final keyboard = mq.viewInsets.bottom;
    final b = _bounds(screen, insets, keyboard);

    // Seed / re-clamp position (e.g. when the keyboard opens or on rotation).
    _pos ??= Offset(b.right, b.top);
    if (!_dragging && !_spring.isAnimating) {
      final clamped = _clamp(_pos!, b);
      if (clamped != _pos) _pos = clamped;
    }

    return Positioned(
      left: _pos!.dx,
      top: _pos!.dy,
      width: _w,
      height: _h,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _restore,
        onPanStart: (_) {
          _spring.stop();
          setState(() => _dragging = true);
        },
        onPanUpdate: (d) {
          setState(() => _pos = _clamp(_pos! + d.delta, b));
        },
        onPanEnd: (_) {
          setState(() => _dragging = false);
          Analytics.capture('call_pip_dragged', {
            'call_id': widget.session.room,
          });
          _snapToEdge(screen, b);
        },
        child: _card(),
      ),
    );
  }

  Widget _card() {
    final s = widget.session;
    return Container(
      decoration: BoxDecoration(
        color: Zine.ink,
        borderRadius: BorderRadius.circular(Zine.rSm),
        border: Zine.border,
        boxShadow: Zine.shadowSm,
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Remote video — reuse the session's renderer (never construct a new one).
          RTCVideoView(
            s.remoteRenderer,
            objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
          ),
          // Reconnecting scrim.
          ValueListenableBuilder<CallPhase>(
            valueListenable: s.phase,
            builder: (context, phase, _) => ValueListenableBuilder<bool>(
              valueListenable: s.peerAway,
              builder: (context, away, __) {
                final reconnecting =
                    phase == CallPhase.reconnecting || away;
                if (!reconnecting) return const SizedBox.shrink();
                return Container(
                  color: Zine.ink.withValues(alpha: 0.55),
                  alignment: Alignment.center,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(
                    'Reconnecting…',
                    textAlign: TextAlign.center,
                    style: ZineText.tag(size: 11, color: Colors.white),
                  ),
                );
              },
            ),
          ),
          // Mini controls: mute (top-left) + end (bottom-right).
          Positioned(
            top: 6,
            left: 6,
            child: ValueListenableBuilder<bool>(
              valueListenable: s.muted,
              builder: (context, muted, _) => _miniBtn(
                icon: muted ? Icons.mic_off_rounded : Icons.mic_rounded,
                fill: muted ? Zine.coral : Zine.card,
                iconColor: muted ? Colors.white : Zine.ink,
                onTap: s.toggleMute,
              ),
            ),
          ),
          Positioned(
            bottom: 6,
            right: 6,
            child: _miniBtn(
              icon: Icons.call_end_rounded,
              fill: Zine.coral,
              iconColor: Colors.white,
              onTap: s.endByUser,
            ),
          ),
        ],
      ),
    );
  }

  Widget _miniBtn({
    required IconData icon,
    required Color fill,
    required Color iconColor,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      // Stop the tap from bubbling to the card's onTap (restore).
      onTap: onTap,
      child: Container(
        width: 30,
        height: 30,
        decoration: BoxDecoration(
          color: fill,
          shape: BoxShape.circle,
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: Icon(icon, size: 16, color: iconColor),
      ),
    );
  }
}
