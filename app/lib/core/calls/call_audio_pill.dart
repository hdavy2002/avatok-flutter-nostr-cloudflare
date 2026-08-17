import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../analytics.dart';
import '../ui/avatok_dark.dart';
import '../ui/messenger_theme.dart';
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
            return ValueListenableBuilder<bool>(
              // [CALL-AUDIBLE-1] Flag off: `audibleReady` mirrors `_connected`
              // immediately, so this listener is a no-op and the pill's
              // behaviour is byte-for-byte what it was before this issue.
              valueListenable: session.audibleReady,
              builder: (context, audible, ____) {
                return ValueListenableBuilder<int>(
                  valueListenable: session.elapsedSeconds,
                  builder: (context, secs, ___) {
                    // [CALL-AUDIBLE-1] `session.isConnected` (raw `_connected`),
                    // NOT the coarse `phase` — that also maps the receptionist
                    // sub-phases to `CallPhase.connected`, and a call routed
                    // straight to Ava (no live human callee, `_connected`
                    // never set) must show the ordinary running clock, not get
                    // stuck on "Connecting audio…" forever.
                    final connectingAudio = session.isConnected &&
                        !reconnecting &&
                        !audible;
                    final fill = reconnecting ? AD.card : AD.online;
                    final label = reconnecting
                        ? 'Reconnecting…'
                        : (connectingAudio
                            ? 'Connecting audio…'
                            : 'Ongoing call · ${_clock(secs)}');
                    return Material(
                      color: Colors.transparent,
                      child: Container(
                        constraints: const BoxConstraints(maxWidth: 320),
                        padding: const EdgeInsets.symmetric(
                            horizontal: Msg.s4, vertical: Msg.s2),
                        decoration: BoxDecoration(
                          color: fill,
                          // A genuine status pill — one of the rPill exceptions.
                          borderRadius: Msg.brPill,
                          border: Border.all(color: AD.borderControl, width: 1),
                          boxShadow: Msg.lift,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              reconnecting
                                  ? PhosphorIcons.wifiSlash(PhosphorIconsStyle.regular)
                                  : PhosphorIcons.microphone(PhosphorIconsStyle.regular),
                              size: 18,
                              color: AD.textPrimary,
                            ),
                            const SizedBox(width: Msg.s2),
                            Flexible(
                              child: Text(
                                label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ADText.tabLabel(),
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
      },
    );
  }

  static String _clock(int secs) {
    final m = (secs ~/ 60).toString().padLeft(2, '0');
    final s = (secs % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }
}
