import 'package:flutter/material.dart';

import 'active_thread.dart';
import 'analytics.dart';
import 'audio_playback_service.dart';
import 'ui/avatok_dark.dart';

// Best-effort "shown" telemetry de-dupe — a top-level var (not a State field)
// is deliberate: this widget is mounted exactly ONCE at the shell root and
// only needs to remember the last track it fired the event for.
String? _lastShownTrackId;

/// [AVAVM-PLAYER-1] App-wide "now playing" bar (WhatsApp-style): pinned above
/// whatever screen the user navigates to while a voice note / voicemail keeps
/// playing in the background.
///
/// MOUNT ONCE, at the shell root (see `shell/shell_v2.dart`) — above the
/// per-app `IndexedStack`, not inside any one app's root — so it survives
/// every in-app navigation between AvaTalk/AvaDial/Marketplace. Mounting it
/// per-screen would tie its lifetime to that screen again, defeating the
/// whole point.
///
/// Hidden automatically while the user is back on the track's own
/// `originRoute` (compared against [ActiveThread.convKey] — the SAME signal
/// `chat_thread.dart` already sets/clears on thread enter/leave, so no new
/// "which thread is open" bookkeeping was needed for chat). Any OTHER screen
/// that wants this auto-hide behaviour for its own tracks (e.g. the AvaDial
/// voicemail inbox) needs to set/clear `ActiveThread.convKey` the same way in
/// its own thread screen — it isn't automatic just from calling
/// [AudioPlaybackService.play].
class MiniAudioPlayerBar extends StatelessWidget {
  const MiniAudioPlayerBar({super.key});

  static String _fmt(Duration d) {
    final m = d.inMinutes, s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<PlaybackState?>(
      valueListenable: AudioPlaybackService.I.state,
      builder: (context, st, _) {
        if (st == null) return const SizedBox.shrink();
        final onOrigin =
            st.track.originRoute != null && st.track.originRoute == ActiveThread.convKey;
        if (onOrigin) return const SizedBox.shrink();

        if (_lastShownTrackId != st.track.trackId) {
          _lastShownTrackId = st.track.trackId;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            Analytics.capture('miniplayer_shown', {
              'track_id': st.track.trackId,
              'origin_route': st.track.originRoute ?? '',
            });
          });
        }

        final dur = st.duration;
        final frac = (dur != null && dur.inMilliseconds > 0)
            ? (st.position.inMilliseconds / dur.inMilliseconds).clamp(0.0, 1.0)
            : 0.0;

        return SafeArea(
          bottom: false,
          child: Material(
            color: Colors.transparent,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                Analytics.capture('miniplayer_tap', {
                  'track_id': st.track.trackId,
                  'origin_route': st.track.originRoute ?? '',
                });
                AudioPlaybackService.onTapOrigin?.call(context, st.track);
              },
              child: Container(
                margin: const EdgeInsets.fromLTRB(8, 6, 8, 0),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: AD.headerFooter,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: AD.borderHairline, width: 1),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.18),
                      blurRadius: 10,
                      offset: const Offset(0, 3),
                    ),
                  ],
                ),
                child: Row(children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: AD.primaryBadge.withValues(alpha: 0.16),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(Icons.graphic_eq, size: 18, color: AD.primaryBadge),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          st.track.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.threadName().copyWith(fontSize: 13.5),
                        ),
                        const SizedBox(height: 3),
                        Row(children: [
                          Expanded(
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(3),
                              child: LinearProgressIndicator(
                                value: dur != null ? frac : null,
                                minHeight: 3,
                                backgroundColor: AD.borderHairline,
                                valueColor: AlwaysStoppedAnimation(AD.primaryBadge),
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            dur != null
                                ? '${_fmt(st.position)} / ${_fmt(dur)}'
                                : (st.track.subtitle ?? 'Voice'),
                            style: ADText.statCaption(c: AD.textSecondary),
                          ),
                        ]),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                    icon: Icon(st.playing ? Icons.pause : Icons.play_arrow, color: AD.textPrimary),
                    onPressed: () => st.playing
                        ? AudioPlaybackService.I.pause()
                        : AudioPlaybackService.I.resume(),
                  ),
                  IconButton(
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                    icon: Icon(Icons.close, size: 18, color: AD.textSecondary),
                    onPressed: () => AudioPlaybackService.I.stop(),
                  ),
                ]),
              ),
            ),
          ),
        );
      },
    );
  }
}
