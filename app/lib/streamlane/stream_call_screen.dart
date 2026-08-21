// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
//
// Visual language deliberately mirrors features/avatok/call_screen.dart (AD.*
// tokens, PhosphorIcons control row, full-bleed remote video + local preview
// thumbnail, duration timer) WITHOUT importing that file — the old lane's
// CallScreen must never depend on, or be depended on by, this one.
//
// [STREAM-UI-1] (plan P1.3/P1.4) This screen now owns the JOIN, not just the
// in-call UI. It is mounted first, in a `connecting` state, and then runs
// [StreamCallScreen.connect]. A join failure renders an error INSIDE this
// screen with a Retry button; it never leaves the user staring at the previous
// screen wondering whether the tap registered.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../core/avatar.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
import 'stream_call_service.dart';

/// What the screen is currently showing. Only [_Phase.ended] ever pops.
enum _Phase { connecting, live, reconnecting, failed }

class StreamCallScreen extends StatefulWidget {
  const StreamCallScreen({
    super.key,
    required this.call,
    required this.peerId,
    this.peerName,
    this.peerAvatarUrl,
    this.peerEmail,
    this.traceId,
    this.video = false,
    this.outgoing = true,
    this.startedAtMs,
    this.connect,
  });

  final Call call;
  final String peerId;

  /// Display name / avatar for the header. The screen used to render the raw
  /// `user_...` id because there was nowhere to pass these.
  final String? peerName;
  final String? peerAvatarUrl;

  /// Only for telemetry joins — lets either party's email retrieve the call.
  final String? peerEmail;
  final String? traceId;

  final bool video;
  final bool outgoing;

  /// When the dial/accept gesture happened, for an honest `setup_ms`.
  final int? startedAtMs;

  /// The media work: `getOrCreate` + `join` (outgoing) or `accept` + `join`
  /// (incoming). Receives the 1-based attempt number so a Retry can skip a
  /// step that already succeeded. Null means the call is already joined.
  final Future<void> Function(int attempt)? connect;

  @override
  State<StreamCallScreen> createState() => _StreamCallScreenState();
}

class _StreamCallScreenState extends State<StreamCallScreen> {
  StreamSubscription<CallState>? _sub;
  CallState? _state;
  DateTime _connectedAt = DateTime.now();
  Timer? _durationTimer;
  Timer? _connectWatchdog;
  Duration _elapsed = Duration.zero;
  bool _muted = false;
  bool _speakerOn = true;
  bool _cameraOff = false;
  bool _hangingUp = false;

  _Phase _phase = _Phase.connecting;
  String _failureReason = 'unknown';
  String _failureMessage = '';
  int _attempt = 0;
  bool _everConnected = false;
  bool _connectedReported = false;

  /// How long a join may sit in `connecting` before the screen stops
  /// pretending and offers a retry. Without this, a `join()` that never
  /// returns is an eternal spinner — the quiet cousin of the vanished screen.
  static const Duration _connectDeadline = Duration(seconds: 60);

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
    _sub = widget.call.state.valueStream.listen(_onState);
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (_phase != _Phase.live && _phase != _Phase.reconnecting) return;
      setState(() => _elapsed = DateTime.now().difference(_connectedAt));
    });
    _startConnect();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _durationTimer?.cancel();
    _connectWatchdog?.cancel();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Join
  // ---------------------------------------------------------------------------

  Future<void> _startConnect() async {
    final connect = widget.connect;
    if (connect == null) return;
    _attempt += 1;
    final attempt = _attempt;
    setState(() {
      _phase = _Phase.connecting;
      _failureMessage = '';
    });
    _connectWatchdog?.cancel();
    _connectWatchdog = Timer(_connectDeadline, () {
      if (!mounted || _everConnected || _phase != _Phase.connecting) return;
      _showFailure('timeout', attempt: attempt);
    });
    try {
      await connect(attempt);
      // join() returning is NOT "connected" — `stream_lane_call_connected` is
      // emitted from _onState when a remote participant is actually
      // publishing. Staying in `connecting` here is deliberate: for an
      // outgoing call this is the ringing period.
    } catch (e, st) {
      _connectWatchdog?.cancel();
      await StreamCallService.instance.reportJoinFailed(
        widget.call,
        e,
        st,
        peerId: widget.peerId,
        attempt: attempt,
        outgoing: widget.outgoing,
        peerEmail: widget.peerEmail,
        traceId: widget.traceId,
      );
      if (!mounted) return;
      _showFailure(StreamCallService.classifyJoinError(e), attempt: attempt);
    }
  }

  void _showFailure(String reason, {required int attempt}) {
    if (!mounted || attempt != _attempt) return;
    setState(() {
      _phase = _Phase.failed;
      _failureReason = reason;
      _failureMessage = StreamCallService.joinErrorMessage(reason);
    });
  }

  Future<void> _retry() async {
    _connectWatchdog?.cancel();
    await _startConnect();
  }

  // ---------------------------------------------------------------------------
  // Call state
  // ---------------------------------------------------------------------------

  /// Media is flowing when a remote participant is publishing at least one
  /// track. Chosen over `join()` returning (which proves nothing) and over
  /// matching a `CallStatusConnected` class name (which cannot be
  /// compile-checked here). `publishedTracks` + `otherParticipants` are the
  /// same APIs this screen already renders from.
  bool _remotePublishing(CallState s) =>
      s.otherParticipants.any((p) => p.publishedTracks.isNotEmpty);

  bool _localPublishing(CallState s) {
    final local = s.localParticipant;
    return local != null && local.publishedTracks.isNotEmpty;
  }

  void _onState(CallState s) {
    if (!mounted) return;
    setState(() => _state = s);

    if (_remotePublishing(s)) {
      if (!_everConnected) {
        _everConnected = true;
        _connectWatchdog?.cancel();
        _connectedAt = DateTime.now();
      }
      if (!_connectedReported) {
        _connectedReported = true;
        final started = widget.startedAtMs ??
            DateTime.now().millisecondsSinceEpoch;
        StreamCallService.instance.reportConnected(
          widget.call,
          peerId: widget.peerId,
          setupMs: DateTime.now().millisecondsSinceEpoch - started,
          video: _isVideo,
          localPublishing: _localPublishing(s),
          peerEmail: widget.peerEmail,
          traceId: widget.traceId,
        );
      }
      if (_phase != _Phase.live && _phase != _Phase.failed) {
        setState(() => _phase = _Phase.live);
      }
    }

    final status = s.status;
    if (status is! CallStatusDisconnected) return;
    final kind = StreamCallService.classifyDisconnect(
      status.reason,
      everConnected: _everConnected,
    );
    switch (kind) {
      case StreamDisconnectKind.transient:
        // Setup blip or reconnect — keep the screen up. THIS is P1.4: the old
        // code popped here.
        if (_everConnected && _phase != _Phase.failed) {
          setState(() => _phase = _Phase.reconnecting);
        }
        break;
      case StreamDisconnectKind.failed:
        _showFailure('unknown', attempt: _attempt);
        break;
      case StreamDisconnectKind.ended:
        _endAndPop(status.reason.runtimeType.toString());
        break;
    }
  }

  /// Genuinely over: release the mic (that is what makes `mic_released: true`
  /// truthful) and then leave the screen.
  Future<void> _endAndPop(String reason) async {
    if (_hangingUp) return;
    _hangingUp = true;
    await StreamCallService.instance
        .leave(widget.call, connectedAt: _connectedAt, reason: reason);
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  Future<void> _hangUp() async {
    if (_hangingUp) return;
    setState(() => _hangingUp = true);
    await StreamCallService.instance
        .leave(widget.call, connectedAt: _connectedAt);
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  /// Close a failed call screen. Still leaves the call so nothing is left
  /// holding the mic.
  Future<void> _closeAfterFailure() async {
    _hangingUp = true;
    await StreamCallService.instance.leave(
      widget.call,
      connectedAt: _connectedAt,
      reason: 'join_failed_$_failureReason',
    );
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  String get _displayName =>
      (widget.peerName != null && widget.peerName!.trim().isNotEmpty)
          ? widget.peerName!.trim()
          : widget.peerId;

  bool get _isVideo => _state?.settings.video.enabled ?? widget.video;

  String get _durationLabel {
    final m = _elapsed.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = _elapsed.inSeconds.remainder(60).toString().padLeft(2, '0');
    return _elapsed.inHours > 0 ? '${_elapsed.inHours}:$m:$s' : '$m:$s';
  }

  String get _statusLabel {
    switch (_phase) {
      case _Phase.connecting:
        return widget.outgoing ? 'Calling…' : 'Connecting…';
      case _Phase.reconnecting:
        return 'Reconnecting…';
      case _Phase.failed:
        return 'Call failed';
      case _Phase.live:
        return _durationLabel;
    }
  }

  @override
  Widget build(BuildContext context) {
    final isVideo = _isVideo;
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
                        if (remote == null) return _avatarFallback();
                        return StreamVideoRenderer(
                          call: widget.call,
                          participant: remote,
                          videoTrackType: SfuTrackType.video,
                        );
                      },
                    )
                  : _avatarFallback(),
            ),
            // Header: peer name + duration / connection state.
            Positioned(
              top: Msg.s4,
              left: Msg.s5,
              right: Msg.s5,
              child: Column(
                children: [
                  Text(
                    _displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AD.textPrimary,
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _statusLabel,
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
            // Failure panel — the whole point of P1.3. The screen STAYS and
            // explains itself instead of disappearing.
            if (_phase == _Phase.failed)
              Positioned(
                left: Msg.s5,
                right: Msg.s5,
                bottom: Msg.s6 + 80,
                child: _failurePanel(),
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

  Widget _avatarFallback() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Avatar(
            seed: widget.peerId,
            name: _displayName,
            size: 120,
            avatarUrl: widget.peerAvatarUrl,
          ),
          if (_phase == _Phase.connecting || _phase == _Phase.reconnecting) ...[
            const SizedBox(height: Msg.s4),
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AD.textSecondary,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _failurePanel() {
    return Container(
      padding: const EdgeInsets.all(Msg.s4),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            _failureMessage,
            textAlign: TextAlign.center,
            style: const TextStyle(color: AD.textPrimary, fontSize: 15),
          ),
          const SizedBox(height: Msg.s4),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              TextButton(
                onPressed: _closeAfterFailure,
                child: const Text(
                  'Close',
                  style: TextStyle(color: AD.textSecondary),
                ),
              ),
              const SizedBox(width: Msg.s4),
              TextButton(
                onPressed: _retry,
                child: const Text(
                  'Try again',
                  style: TextStyle(color: AD.textPrimary),
                ),
              ),
            ],
          ),
        ],
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
