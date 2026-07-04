import 'package:flutter/material.dart';

import '../analytics.dart';
import '../ui/zine.dart';
import 'call_session.dart';

/// The slim green "ongoing call" pill shown at the top of every screen while a
/// 1:1 AUDIO call is minimized. Green mic glyph + "Ongoing call · MM:SS" live
/// chronometer; tap returns to the full call screen. When the transport is
/// recovering it flips to a "Reconnecting…" state (amber).
///
/// Hit-tests ONLY itself — the overlay host wraps it so touches elsewhere pass
/// through to the app underneath (see [CallOverlay]).
class CallAudioPill extends StatelessWidget {
  const CallAudioPill({super.key, required this.session, required this.onReturn});

  final CallSession session;

  /// Called on tap — the overlay clears [CallSession.minimized] and re-presents
  /// the full call screen.
  final VoidCallback onReturn;

  @override
  Widget build(BuildContext context) {
    final topInset = MediaQuery.of(context).padding.top;
    return Align(
      alignment: Alignment.topCenter,
      child: Padding(
        // Sit just below the status bar / notch, centred.
        padding: EdgeInsets.only(top: topInset + 6, left: 12, right: 12),
        child: SafeArea(
          top: false,
          bottom: false,
          child: _PillBody(session: session, onReturn: onReturn),
        ),
      ),
    );
  }
}

class _PillBody extends StatelessWidget {
  const _PillBody({required this.session, required this.onReturn});

  final CallSession session;
  final VoidCallback onReturn;

  void _tap() {
    Analytics.capture('call_restored', {
      'call_id': session.room,
      'from': 'pill',
      'video': session.video,
    });
    onReturn();
  }

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
                  child: InkWell(
                    onTap: _tap,
                    borderRadius: BorderRadius.circular(100),
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
