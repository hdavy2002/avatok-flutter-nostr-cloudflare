import 'package:flutter/material.dart';

import '../analytics.dart';
import '../ui/zine.dart';
import 'call_session.dart';

/// The slim green "ongoing call" pill shown while a 1:1 AUDIO call is minimized.
/// Green mic glyph + "Ongoing call · MM:SS" live chronometer; tap returns to the
/// full call screen. When the transport is recovering it flips to a
/// "Reconnecting…" state (amber).
///
/// The pill is DRAGGABLE: by default it parks just BELOW the app header (so the
/// header menus stay clear), but the user can drag it anywhere on screen to
/// uncover whatever sits behind it. Position is clamped to the visible bounds.
///
/// Hit-tests ONLY itself — the overlay host wraps it so touches elsewhere pass
/// through to the app underneath (see [CallOverlay]).
class CallAudioPill extends StatefulWidget {
  const CallAudioPill({super.key, required this.session, required this.onReturn});

  final CallSession session;

  /// Called on tap — the overlay clears [CallSession.minimized] and re-presents
  /// the full call screen.
  final VoidCallback onReturn;

  @override
  State<CallAudioPill> createState() => _CallAudioPillState();
}

class _CallAudioPillState extends State<CallAudioPill> {
  /// Top-left of the pill. `null` until the user first drags it, so we keep the
  /// default (centred, below the header) layout and stay responsive to rotation
  /// / keyboard insets until then.
  Offset? _pos;

  /// Measured size of the pill, so drag-clamping knows its extent.
  final GlobalKey _pillKey = GlobalKey();
  Size _pillSize = Size.zero;

  // Horizontal side padding kept clear at the screen edges.
  static const double _side = 12;

  void _measure(_) {
    final box = _pillKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    if (box.size != _pillSize) {
      setState(() => _pillSize = box.size);
    }
  }

  void _tap() {
    Analytics.capture('call_restored', {
      'call_id': widget.session.room,
      'from': 'pill',
      'video': widget.session.video,
    });
    widget.onReturn();
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final topInset = media.padding.top;
    // Park BELOW the header by default so header actions stay tappable.
    final double defaultTop = topInset + kToolbarHeight + 6;

    WidgetsBinding.instance.addPostFrameCallback(_measure);

    return LayoutBuilder(
      builder: (context, constraints) {
        final maxW = constraints.maxWidth;
        final maxH = constraints.maxHeight;

        // Default (undragged) top-left, used as the drag origin too.
        final double defaultLeft = _pillSize.width > 0
            ? ((maxW - _pillSize.width) / 2).clamp(_side, maxW - _side)
            : _side;
        final Offset origin = _pos ?? Offset(defaultLeft, defaultTop);

        Offset clamp(Offset o) {
          final w = _pillSize.width;
          final h = _pillSize.height;
          final maxX = (maxW - w - _side).clamp(_side, double.infinity);
          final maxY = (maxH - h - _side).clamp(topInset, double.infinity);
          return Offset(
            o.dx.clamp(_side, maxX),
            o.dy.clamp(topInset, maxY),
          );
        }

        final pill = GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: _tap,
          onPanStart: (_) {
            // Freeze the current position as the drag origin.
            _pos ??= origin;
          },
          onPanUpdate: (d) {
            setState(() => _pos = clamp((_pos ?? origin) + d.delta));
          },
          child: _PillBody(
            key: _pillKey,
            session: widget.session,
          ),
        );

        return Stack(
          children: [
            Positioned(
              left: origin.dx,
              top: origin.dy,
              child: pill,
            ),
          ],
        );
      },
    );
  }
}

class _PillBody extends StatelessWidget {
  const _PillBody({super.key, required this.session});

  final CallSession session;

  @override
  Widget build(BuildContext context) {
    // Rebuild on phase (reconnecting label) and the 1 Hz timer (chronometer).
    return ValueListenableBuilder<CallPhase>(
      valueListenable: session.phase,
      builder: (context, phase, _) {
        return ValueListenableBuilder<bool>(
          valueListenable: session.peerAway,
          builder: (context, away, __) {
            final reconnecting =
                phase == CallPhase.reconnecting || away;
            return ValueListenableBuilder<int>(
              valueListenable: session.elapsedSeconds,
              builder: (context, secs, ___) {
                final fill = reconnecting ? Zine.card : Zine.mint;
                final label = reconnecting
                    ? 'Reconnecting…'
                    : 'Ongoing call · ${_clock(secs)}';
                return Material(
                  color: Colors.transparent,
                  child: Container(
                    constraints: const BoxConstraints(maxWidth: 320),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                    decoration: BoxDecoration(
                      color: fill,
                      borderRadius: BorderRadius.circular(100),
                      border: Zine.border,
                      boxShadow: Zine.shadowXs,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          reconnecting
                              ? Icons.wifi_tethering_error_rounded_outlined
                              : Icons.mic_rounded,
                          size: 18,
                          color: Zine.ink,
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ZineText.tag(size: 13, color: Zine.ink),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  static String _clock(int secs) {
    final m = (secs ~/ 60).toString().padLeft(2, '0');
    final s = (secs % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }
}
