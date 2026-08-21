// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
//
// Visual language deliberately mirrors features/avatok/call_screen.dart (AD.*
// tokens, PhosphorIcons control row, full-bleed remote video + local preview
// thumbnail, duration timer) WITHOUT importing that file — the old lane's
// CallScreen must never depend on, or be depended on by, this one.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../core/avatar.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
import 'stream_call_service.dart';

class StreamCallScreen extends StatefulWidget {
  const StreamCallScreen({super.key, required this.call, required this.peerId});

  final Call call;
  final String peerId;

  @override
  State<StreamCallScreen> createState() => _StreamCallScreenState();
}

class _StreamCallScreenState extends State<StreamCallScreen> {
  StreamSubscription<CallState>? _sub;
  CallState? _state;
  DateTime _connectedAt = DateTime.now();
  Timer? _durationTimer;
  Duration _elapsed = Duration.zero;
  bool _muted = false;
  bool _speakerOn = true;
  bool _cameraOff = false;
  bool _hangingUp = false;

  @override
  void initState() {
    super.initState();
    _connectedAt = DateTime.now();
    // verified: packages/stream_video/lib/src/state_emitter.dart +
    // packages/stream_video/lib/src/call/call.dart. `Call.state` is a
    // `StateEmitter<CallState>`; `.valueStream` is correct for driving this
    // whole-screen rebuild. `Call.partialState<T>(selector)` also exists and
    // is the finer-grained alternative for a widget that only cares about
    // one projected field, not needed here since this screen reads several
    // fields off the same `CallState` snapshot.
    _sub = widget.call.state.valueStream.listen((s) {
      if (!mounted) return;
      setState(() => _state = s);
      if (s.status is CallStatusDisconnected) {
        _autoPop(s.status as CallStatusDisconnected);
      }
    });
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _elapsed = DateTime.now().difference(_connectedAt));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _durationTimer?.cancel();
    super.dispose();
  }

  Future<void> _autoPop(CallStatusDisconnected status) async {
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  Future<void> _hangUp() async {
    if (_hangingUp) return;
    setState(() => _hangingUp = true);
    await StreamCallService.instance.leave(widget.call, connectedAt: _connectedAt);
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  // verified: packages/stream_video/lib/src/call/call.dart — there is no
  // `call.microphone`/`call.camera` object; the real API is direct methods
  // on `Call`: `setMicrophoneEnabled({required bool enabled})` and
  // `setCameraEnabled({required bool enabled})`, both returning
  // `Future<Result<None>>`.
  Future<void> _toggleMute() async {
    try {
      await widget.call.setMicrophoneEnabled(enabled: _muted);
      if (mounted) setState(() => _muted = !_muted);
    } catch (_) {/* best-effort — UI reflects last confirmed state on failure */}
  }

  // verified: packages/stream_video/lib/src/webrtc/rtc_media_device/
  // rtc_media_device_notifier.dart + call.dart. There is no `speaker: bool`
  // param on `Call` — `Call.setAudioOutputDevice(RtcMediaDevice device)`
  // takes a concrete device, chosen from `RtcMediaDeviceNotifier.instance
  // .audioOutputs()`; `RtcMediaDevice.isSpeaker` identifies the speaker
  // device among them.
  Future<void> _toggleSpeaker() async {
    try {
      final result = await RtcMediaDeviceNotifier.instance.audioOutputs();
      final devices = result.getDataOrNull() ?? const [];
      if (devices.isEmpty) return;
      final wantSpeaker = !_speakerOn;
      final device = devices.firstWhere(
        (d) => wantSpeaker ? d.isSpeaker : !d.isSpeaker,
        orElse: () => devices.first,
      );
      await widget.call.setAudioOutputDevice(device);
      if (mounted) setState(() => _speakerOn = wantSpeaker);
    } catch (_) {/* best-effort */}
  }

  Future<void> _toggleCamera() async {
    try {
      await widget.call.setCameraEnabled(enabled: _cameraOff);
      if (mounted) setState(() => _cameraOff = !_cameraOff);
    } catch (_) {/* best-effort */}
  }

  // verified: packages/stream_video/lib/src/call/call.dart — `Call.flipCamera()`
  // is a direct method (not `call.camera.flip()`).
  Future<void> _flipCamera() async {
    try {
      await widget.call.flipCamera();
    } catch (_) {/* best-effort */}
  }

  String get _durationLabel {
    final m = _elapsed.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = _elapsed.inSeconds.remainder(60).toString().padLeft(2, '0');
    return _elapsed.inHours > 0
        ? '${_elapsed.inHours}:$m:$s'
        : '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final isVideo = _state?.settings.video.enabled ?? false;
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Stack(
          children: [
            // Remote video full-bleed, or an avatar fallback for audio-only.
            //
            // verified: packages/stream_video_flutter/lib/src/call_screen/
            // call_content/call_content.dart — `StreamCallContent` IS a real
            // exported widget, but it renders its OWN app bar, participants
            // grid AND control row, which would double-render underneath
            // this screen's custom AD.*/Phosphor control row below. Using it
            // was the flagged risk at dark-lane build time (2026-08-21); at
            // activation it is replaced with a bare `StreamVideoRenderer`
            // scoped to the first remote participant — verified against
            // packages/stream_video/lib/src/call_state.dart
            // (`CallState.otherParticipants`) + video_renderer.dart, same
            // building block already used a few lines down for the local
            // preview thumbnail — so this screen owns the only control row.
            Positioned.fill(
              child: isVideo
                  ? Builder(
                      builder: (_) {
                        final others = widget.call.state.value.otherParticipants;
                        CallParticipantState? remote;
                        for (final p in others) {
                          if (p.publishedTracks.containsKey(SfuTrackType.video)) {
                            remote = p;
                            break;
                          }
                        }
                        remote ??= others.isNotEmpty ? others.first : null;
                        if (remote == null) {
                          return Center(
                            child: Avatar(
                              seed: widget.peerId,
                              name: widget.peerId,
                              size: 120,
                            ),
                          );
                        }
                        return StreamVideoRenderer(
                          call: widget.call,
                          participant: remote,
                          videoTrackType: SfuTrackType.video,
                        );
                      },
                    )
                  : Center(
                      child: Avatar(
                        seed: widget.peerId,
                        name: widget.peerId,
                        size: 120,
                      ),
                    ),
            ),
            // Header: peer name + duration.
            Positioned(
              top: Msg.s4,
              left: Msg.s5,
              right: Msg.s5,
              child: Column(
                children: [
                  Text(
                    widget.peerId,
                    style: const TextStyle(
                      color: AD.textPrimary,
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _durationLabel,
                    style: const TextStyle(
                      color: AD.textSecondary,
                      fontSize: 14,
                    ),
                  ),
                ],
              ),
            ),
            // Local preview thumbnail (video calls only).
            if (isVideo)
              Positioned(
                top: Msg.s4,
                right: Msg.s5,
                width: 96,
                height: 128,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Container(
                    color: AD.card,
                    // verified: packages/stream_video_flutter/lib/src/
                    // renderer/video_renderer.dart +
                    // src/models/call_participant_state.dart +
                    // src/sfu/data/models/sfu_track_type.dart. There is no
                    // `StreamCallLocalVideoContent` widget in the SDK. The
                    // real building block is `StreamVideoRenderer({required
                    // Call call, required CallParticipantState participant,
                    // required SfuTrackTypeVideo videoTrackType})`, scoped to
                    // the local participant via `call.state.value
                    // .localParticipant` and `SfuTrackType.video`.
                    // (`StreamLocalVideo` also exists but is a floating-
                    // overlay wrapper that takes a `child` — overkill for a
                    // fixed thumbnail slot like this one.)
                    child: Builder(
                      builder: (_) {
                        final local = widget.call.state.value.localParticipant;
                        if (local == null) return const SizedBox.shrink();
                        return StreamVideoRenderer(
                          call: widget.call,
                          participant: local,
                          videoTrackType: SfuTrackType.video,
                        );
                      },
                    ),
                  ),
                ),
              ),
            // Control row.
            Positioned(
              left: 0,
              right: 0,
              bottom: Msg.s6,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _controlButton(
                    icon: _muted
                        ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                        : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                    onTap: _toggleMute,
                  ),
                  _controlButton(
                    icon: _speakerOn
                        ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                        : PhosphorIcons.speakerSlash(PhosphorIconsStyle.bold),
                    onTap: _toggleSpeaker,
                  ),
                  _controlButton(
                    icon: _cameraOff
                        ? PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold)
                        : PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                    onTap: _toggleCamera,
                  ),
                  _controlButton(
                    icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                    onTap: _flipCamera,
                  ),
                  _controlButton(
                    icon: PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.fill),
                    onTap: _hangUp,
                    danger: true,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _controlButton({
    required PhosphorIconData icon,
    required VoidCallback onTap,
    bool danger = false,
  }) {
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: danger ? AD.primaryBadge : AD.card,
        ),
        child: Icon(
          icon,
          color: danger ? AD.tabActiveLabel : AD.iconNeutral,
          size: 26,
        ),
      ),
    );
  }
}
