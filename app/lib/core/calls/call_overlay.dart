import 'package:flutter/material.dart';

import '../../features/avatok/call_screen.dart';
import '../../push/push_service.dart' show navigatorKey;
import '../analytics.dart';
import 'call_audio_pill.dart';
import 'call_pip_thumbnail.dart';
import 'call_session.dart';
import 'call_session_manager.dart';

/// Global in-app overlay host for a minimized 1:1 call. Wraps the app's
/// navigator (via `MaterialApp.builder`) so it paints ABOVE every route.
///
/// While `manager.active != null && session.minimized`, it shows either:
///   • a draggable video thumbnail (video call), or
///   • a green "ongoing call" pill (audio call),
/// depending on whether video is currently active. Both return to the full call
/// screen on tap. When not minimized (or no call), it renders nothing and adds
/// zero hit-test surface, so the app underneath behaves normally.
///
/// Renderer sharing: the PiP thumbnail re-attaches the session's REMOTE
/// renderer; it never creates or disposes a renderer — the session owns those.
class CallOverlay extends StatelessWidget {
  const CallOverlay({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        child,
        // Follows the active session; rebuilds when a call starts/ends.
        ValueListenableBuilder<CallSession?>(
          valueListenable: CallSessionManager.instance.active,
          builder: (context, session, _) {
            if (session == null || session.isEnded) {
              return const SizedBox.shrink();
            }
            return _MinimizedLayer(session: session);
          },
        ),
      ],
    );
  }
}

class _MinimizedLayer extends StatelessWidget {
  const _MinimizedLayer({required this.session});

  final CallSession session;

  /// Return to the full call screen: clear the minimized flag and re-present the
  /// CallScreen route. Guards against a duplicate CallScreen — if the session is
  /// no longer minimized, a full view is already on-screen and we do nothing.
  void _returnToCall() => returnToActiveCall();

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: session.minimized,
      builder: (context, minimized, _) {
        if (!minimized) return const SizedBox.shrink();
        // Choose pill vs thumbnail off the LIVE video state so an audio→video
        // upgrade while minimized swaps the pill for the thumbnail.
        return ValueListenableBuilder<bool>(
          valueListenable: session.videoActive,
          builder: (context, video, __) {
            return ValueListenableBuilder<bool>(
              valueListenable: session.cameraOn,
              builder: (context, camOn, ___) {
                final showVideo = video && camOn;
                if (showVideo) {
                  // A Stack sized to the whole screen; the thumbnail is a
                  // Positioned child and only IT hit-tests.
                  return Positioned.fill(
                    child: Stack(
                      children: [
                        CallPipThumbnail(
                          session: session,
                          onReturn: _returnToCall,
                        ),
                      ],
                    ),
                  );
                }
                return Positioned.fill(
                  child: CallAudioPill(
                    session: session,
                    onReturn: _returnToCall,
                  ),
                );
              },
            );
          },
        );
      },
    );
  }
}

/// Return to the full call screen for the active session: clear the minimized
/// flag and re-present the CallScreen route. Guards against a duplicate
/// CallScreen — if the session is no longer minimized, a full view is already
/// on-screen and we do nothing. Used both by the in-app overlay (tap pill/
/// thumbnail) and by the ongoing-call notification tap (CALL-BG-INT1, wired in
/// main.dart via NativeVoiceAudio.instance.onNotificationTapReturnToCall).
void returnToActiveCall() {
  final session = CallSessionManager.instance.current;
  if (session == null || session.isEnded) return;
  if (!session.minimized.value) return;
  session.minimized.value = false;
  final nav = navigatorKey.currentState;
  if (nav == null) return;
  nav.push(MaterialPageRoute(
    builder: (_) => CallScreen(
      room: session.config.room,
      title: session.config.title,
      seed: session.config.seed,
      video: session.config.video,
      outgoing: session.config.outgoing,
      avatarUrl: session.config.avatarUrl,
      ringbackUrl: session.config.ringbackUrl,
      teamId: session.config.teamId,
      teamSlot: session.config.teamSlot,
    ),
  ));
}

/// Helper used by [CallScreen]'s minimize triggers (back gesture / ⌄ button):
/// set the session minimized and pop the call route. Fires `call_minimized`.
void minimizeActiveCall(CallSession session, BuildContext context) {
  session.minimized.value = true;
  Analytics.capture('call_minimized', {
    'call_id': session.room,
    'video': session.videoActive.value && session.cameraOn.value,
  });
  Navigator.of(context).maybePop();
}
