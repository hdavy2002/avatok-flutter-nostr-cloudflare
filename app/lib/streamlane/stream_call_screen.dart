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
import '../core/analytics.dart';
import '../core/ringback_player.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
import '../main.dart' show RootFlow;
import 'stream_call_service.dart';
import 'stream_call_telemetry.dart';

/// What the screen is currently showing. Only [_Phase.ended] ever pops.
enum _Phase { connecting, live, reconnecting, failed }

/// The screen mounted synchronously on an outgoing tap, before authentication
/// or Stream call creation has completed. It keeps the caller informed with
/// neutral, privacy-safe copy and owns the searching tone until the server
/// confirms that the recipient has actually been rung.
class StreamOutgoingPreparationScreen extends StatefulWidget {
  const StreamOutgoingPreparationScreen({
    super.key,
    required this.peerId,
    required this.video,
    required this.attempt,
    required this.prepare,
    required this.cancel,
    this.retry,
    this.peerName,
    this.peerAvatarUrl,
    this.peerEmail,
  });

  /// [2026-08-24] Re-places the call with a FRESH attempt id after a
  /// preparation failure (the Worker dedups `place` on attempt id, so reusing
  /// the old one would be silently swallowed). The screen pops itself first;
  /// the service then pushes a new preparation screen.
  final Future<void> Function()? retry;

  final String peerId;
  final String? peerName;
  final String? peerAvatarUrl;
  final String? peerEmail;
  final bool video;
  final StreamOutgoingAttempt attempt;
  final Future<StreamPreparedOutgoing?> Function(
    void Function(String stage) onStage,
  ) prepare;
  final Future<void> Function() cancel;

  @override
  State<StreamOutgoingPreparationScreen> createState() =>
      _StreamOutgoingPreparationScreenState();
}

class _StreamOutgoingPreparationScreenState
    extends State<StreamOutgoingPreparationScreen> {
  final RingbackPlayer _tones = RingbackPlayer();
  String _stage = 'Connecting…';
  bool _handedOff = false;
  bool _cancelling = false;
  /// Preparation failed: the spinner stops and Close / Try again appear.
  bool _failed = false;
  Timer? _preparingTimer;

  @override
  void initState() {
    super.initState();
    Analytics.capture('stream_lane_call_stage', {
      'attempt_id': widget.attempt.attemptId,
      'stage': 'connecting',
      'elapsed_ms': 0,
      'provider': 'stream',
      'role': 'caller',
      'peer_id': widget.peerId,
    });
    // ignore: discarded_futures
    _tones.playSearchingTone(speakerOn: true);
    // This is an honest elapsed state: the request is still pending, so the
    // app is preparing the call. It does not claim the user/device was found.
    _preparingTimer = Timer(const Duration(milliseconds: 450), () {
      _setStage('preparing');
    });
    // ignore: discarded_futures
    _run();
  }

  int get _elapsedMs =>
      DateTime.now().millisecondsSinceEpoch - widget.attempt.startedAtMs;

  void _setStage(String stage) {
    if (!mounted || widget.attempt.cancelled || _handedOff) return;
    final label = switch (stage) {
      'ringing' => 'Ringing…',
      'preparing' => 'Preparing call…',
      _ => 'Connecting…',
    };
    if (_stage == label) return;
    setState(() => _stage = label);
    Analytics.capture('stream_lane_call_stage', {
      'attempt_id': widget.attempt.attemptId,
      'call_id': widget.attempt.callId,
      'stage': stage,
      'elapsed_ms': _elapsedMs,
      'provider': 'stream',
      'role': 'caller',
      'peer_id': widget.peerId,
    });
  }

  Future<void> _run() async {
    StreamPreparedOutgoing? prepared;
    try {
      prepared = await widget.prepare(_setStage);
    } on StreamOutgoingPreparationException catch (e) {
      if (!mounted || widget.attempt.cancelled) return;
      _preparingTimer?.cancel();
      await _tones.stop(reason: 'preparation_failed');
      if (!mounted) return;
      setState(() {
        _stage = e.message;
        _failed = true;
      });
      Analytics.capture('stream_lane_call_preparation_failed', {
        'attempt_id': widget.attempt.attemptId,
        'call_id': widget.attempt.callId,
        'code': e.code,
        'elapsed_ms': _elapsedMs,
        'provider': 'stream',
        'role': 'caller',
      });
      return;
    } catch (e) {
      if (!mounted || widget.attempt.cancelled) return;
      _preparingTimer?.cancel();
      await _tones.stop(reason: 'preparation_failed');
      if (!mounted) return;
      setState(() {
        _stage = "Couldn't start the call. Please try again.";
        _failed = true;
      });
      return;
    }
    if (!mounted || widget.attempt.cancelled || prepared == null) return;
    // [STREAM-RING-2 2026-08-21] The guard above already proves non-null, but
    // `prepared` is a REASSIGNED local read from inside the `builder:` closure
    // below, and Dart does not carry type promotion into a closure for a
    // variable that is written to anywhere. Copying it into a final local is
    // the honest fix: no `!`, so there is no way for this to become a
    // null-check crash mid-call-setup if the flow ever changes.
    final StreamPreparedOutgoing ready = prepared;
    _preparingTimer?.cancel();
    _setStage('ringing');
    // The prepare callback returns only after the server confirms the Stream
    // ring was issued. This is the first moment real ringback is truthful.
    await _tones.playRingback(ready.callId, speakerOn: true);
    if (!mounted || widget.attempt.cancelled) return;
    _handedOff = true;
    await Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => StreamCallScreen(
        call: ready.call,
        peerId: widget.peerId,
        peerName: widget.peerName,
        peerAvatarUrl: widget.peerAvatarUrl,
        peerEmail: widget.peerEmail,
        traceId: widget.attempt.traceId,
        video: widget.video,
        outgoing: true,
        startedAtMs: widget.attempt.startedAtMs,
        connect: ready.connect,
        endForEveryone: ready.endForEveryone,
        tonePlayer: _tones,
      ),
    ));
  }

  Future<void> _cancel() async {
    if (_cancelling) return;
    setState(() => _cancelling = true);
    widget.attempt.cancelled = true;
    _preparingTimer?.cancel();
    await _tones.stop(reason: 'cancel_during_preparation');
    await widget.cancel();
    if (mounted) Navigator.of(context).pop();
  }

  /// Pop this (already-failed, already-fenced) attempt and place a new one.
  Future<void> _retry() async {
    if (_cancelling) return;
    setState(() => _cancelling = true);
    widget.attempt.cancelled = true;
    _preparingTimer?.cancel();
    Analytics.capture('stream_lane_call_retry_tapped', {
      'attempt_id': widget.attempt.attemptId,
      'call_id': widget.attempt.callId,
      'trace_id': widget.attempt.traceId,
      'peer_id': widget.peerId,
      'peer_email': widget.peerEmail,
      'stage': 'preparation',
      'lane': 'streamlane',
    });
    if (!mounted) return;
    Navigator.of(context).pop();
    await widget.retry?.call();
  }

  @override
  void dispose() {
    _preparingTimer?.cancel();
    if (!_handedOff) {
      // ignore: discarded_futures
      _tones.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _cancel();
        },
        child: Scaffold(
          backgroundColor: AD.bg,
          body: SafeArea(
            child: Stack(
              children: [
                Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Avatar(
                        seed: widget.peerId,
                        name: widget.peerName ?? widget.peerId,
                        size: 120,
                        avatarUrl: widget.peerAvatarUrl,
                      ),
                      const SizedBox(height: Msg.s4),
                      Text(
                        (widget.peerName?.trim().isNotEmpty ?? false)
                            ? widget.peerName!.trim()
                            : widget.peerId,
                        style: const TextStyle(
                          color: AD.textPrimary,
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Padding(
                        padding: const EdgeInsets.symmetric(
                            horizontal: Msg.s5),
                        child: Text(
                          _stage,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: _failed
                                ? AD.textPrimary
                                : AD.textSecondary,
                          ),
                        ),
                      ),
                      const SizedBox(height: Msg.s4),
                      // [2026-08-24] A failed preparation used to leave the
                      // spinner running under the error text with no way
                      // forward except hang-up. Now the spinner stops and
                      // the same Close / Try again pair as the live-call
                      // failure panel appears.
                      if (_failed)
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            TextButton(
                              onPressed: _cancelling ? null : _cancel,
                              child: const Text(
                                'Close',
                                style: TextStyle(color: AD.textSecondary),
                              ),
                            ),
                            const SizedBox(width: Msg.s4),
                            if (widget.retry != null)
                              TextButton(
                                onPressed: _cancelling ? null : _retry,
                                child: const Text(
                                  'Try again',
                                  style: TextStyle(color: AD.textPrimary),
                                ),
                              ),
                          ],
                        )
                      else
                        const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AD.textSecondary,
                          ),
                        ),
                    ],
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: Msg.s6,
                  child: Center(
                    child: InkWell(
                      onTap: _cancelling ? null : _cancel,
                      customBorder: const CircleBorder(),
                      child: Container(
                        width: 64,
                        height: 64,
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          color: AD.primaryBadge,
                        ),
                        child: Icon(
                          PhosphorIcons.phoneDisconnect(
                              PhosphorIconsStyle.fill),
                          color: AD.tabActiveLabel,
                          size: 28,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
}

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
    this.endForEveryone,
    this.tonePlayer,
  });

  final Call call;
  final String peerId;

  /// Display name / avatar for the header. The screen used to render the raw
  /// `user_...` id because there was nowhere to pass these.
  final String? peerName;
  final String? peerAvatarUrl;

  /// [AUDIT-8 2026-08-21] No longer read for telemetry (peer_id + call_id are
  /// enough to join both sides server-side) — kept as a field only so
  /// existing call sites elsewhere in the app keep compiling.
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

  /// Server-authoritative end for an outgoing 1:1 call. Stream client roles
  /// intentionally cannot be trusted with global call termination.
  final Future<void> Function()? endForEveryone;

  /// Caller progress audio handed over by the preparation screen. The same
  /// player swaps searching beeps for honest ringback without an audible race.
  final RingbackPlayer? tonePlayer;

  @override
  State<StreamCallScreen> createState() => _StreamCallScreenState();
}

class _StreamCallScreenState extends State<StreamCallScreen> {
  StreamSubscription<CallState>? _sub;
  StreamSubscription<StreamStatsBundle>? _statsSub;
  CallState? _state;
  DateTime _connectedAt = DateTime.now();
  Timer? _durationTimer;
  Timer? _connectWatchdog;
  Timer? _qualityTimer;
  Timer? _peerGoneTimer;
  Duration _elapsed = Duration.zero;
  bool _muted = false;
  bool _speakerOn = true;
  bool _cameraOff = false;
  bool _hangingUp = false;
  late final RingbackPlayer? _tonePlayer = widget.tonePlayer;

  _Phase _phase = _Phase.connecting;
  String _failureReason = 'unknown';
  String _failureMessage = '';
  int _attempt = 0;
  bool _everConnected = false;
  bool _connectedReported = false;
  bool _firstAudioReported = false;
  bool _firstVideoReported = false;
  bool _popped = false;
  StreamStatsBundle? _lastStatsBundle;

  /// How long a join may sit in `connecting` before the screen stops
  /// pretending and offers a retry. Without this, a `join()` that never
  /// returns is an eternal spinner — the quiet cousin of the vanished screen.
  static const Duration _connectDeadline = Duration(seconds: 60);

  /// Cadence for `stream_lane_call_quality` while live. "Summaries, never
  /// continuous emission" per the task brief.
  static const Duration _qualityInterval = Duration(seconds: 15);

  @override
  void initState() {
    super.initState();
    _cameraOff = !widget.video;
    _connectedAt = DateTime.now();
    // verified: packages/stream_video/lib/src/state_emitter.dart +
    // packages/stream_video/lib/src/call/call.dart. `Call.state` is a
    // `StateEmitter<CallState>`; `.valueStream` is correct for driving this
    // whole-screen rebuild. `Call.partialState<T>(selector)` also exists and
    // is the finer-grained alternative for a widget that only cares about
    // one projected field, not needed here since this screen reads several
    // fields off the same `CallState` snapshot.
    _sub = widget.call.state.valueStream.listen(_onState);
    // [STREAM-TELEMETRY-1] `call.stats` only carries packet-loss data — see
    // stream_call_telemetry.dart's `qualityProps` doc comment for why this
    // is cached separately from `statsReporter.currentMetrics`.
    _statsSub = widget.call.stats.listen((bundle) {
      _lastStatsBundle = bundle;
    });
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
    _statsSub?.cancel();
    _durationTimer?.cancel();
    _connectWatchdog?.cancel();
    _qualityTimer?.cancel();
    _peerGoneTimer?.cancel();
    // One final summary, per the task brief ("once at end"). Fire-and-forget
    // like every other capture in this lane; skipped if media never flowed
    // (nothing to summarise).
    if (_everConnected) _emitQuality();
    // ignore: discarded_futures
    _tonePlayer?.dispose();
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
    // A terminal connection failure must silence caller ringback immediately.
    // Do not wait for the server cancel request or for this screen to dispose:
    // either can take seconds on a poor network, producing the misleading
    // "could not connect" message while the phone audibly keeps ringing.
    // ignore: discarded_futures
    _tonePlayer?.stop(reason: 'connect_failed');
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

  bool _remotePublishingKind(CallState s, SfuTrackType kind) =>
      s.otherParticipants.any((p) => p.publishedTracks.containsKey(kind));

  bool _localPublishing(CallState s) {
    final local = s.localParticipant;
    return local != null && local.publishedTracks.isNotEmpty;
  }

  void _onState(CallState s) {
    if (!mounted) return;
    setState(() => _state = s);

    // In a 1:1 call, the remaining participant must not be stranded when the
    // other side leaves locally. The caller owns the server-authoritative
    // attempt and can close the provider call for both sides.
    if (_everConnected && s.otherParticipants.isEmpty) {
      _peerGoneTimer ??= Timer(const Duration(milliseconds: 700), () async {
        if (!mounted ||
            _hangingUp ||
            (_state?.otherParticipants.isNotEmpty ?? false)) {
          _peerGoneTimer = null;
          return;
        }
        await _endAndPop('peer_left');
      });
    } else {
      _peerGoneTimer?.cancel();
      _peerGoneTimer = null;
    }

    if (_remotePublishing(s)) {
      // The recipient has answered and media exists: ringback must stop before
      // their first word, otherwise the fastest pickup is punished by a tone.
      // ignore: discarded_futures
      _tonePlayer?.stop(reason: 'remote_media');
      if (!_everConnected) {
        _everConnected = true;
        _connectWatchdog?.cancel();
        _connectedAt = DateTime.now();
        // Media is flowing for the first time — start the periodic quality
        // summary. Never before this point: `statsReporter`/`call.stats`
        // have nothing meaningful to say before a session exists.
        _qualityTimer ??=
            Timer.periodic(_qualityInterval, (_) => _emitQuality());
      }
      if (!_connectedReported) {
        _connectedReported = true;
        final started =
            widget.startedAtMs ?? DateTime.now().millisecondsSinceEpoch;
        StreamCallService.instance.reportConnected(
          widget.call,
          peerId: widget.peerId,
          setupMs: DateTime.now().millisecondsSinceEpoch - started,
          video: _isVideo,
          localPublishing: _localPublishing(s),
          outgoing: widget.outgoing,
          peerEmail: widget.peerEmail,
          traceId: widget.traceId,
        );
      }
      _maybeReportFirstMedia(s);
      if (_phase == _Phase.reconnecting) {
        // The other half of `..._reconnecting` — media resumed.
        StreamCallService.instance.reportRecovered(
          widget.call,
          peerId: widget.peerId,
          outgoing: widget.outgoing,
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
          if (_phase != _Phase.reconnecting) {
            StreamCallService.instance.reportReconnecting(
              widget.call,
              peerId: widget.peerId,
              outgoing: widget.outgoing,
              traceId: widget.traceId,
            );
          }
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

  /// `stream_lane_first_audio_received` / `..._video_received`: the first
  /// moment the remote side is actually heard/seen, not merely "a track was
  /// published" (which `..._connected` already covers).
  void _maybeReportFirstMedia(CallState s) {
    final started = widget.startedAtMs ?? DateTime.now().millisecondsSinceEpoch;
    if (!_firstAudioReported && _remotePublishingKind(s, SfuTrackType.audio)) {
      _firstAudioReported = true;
      StreamCallService.instance.reportFirstMedia(
        widget.call,
        'audio',
        peerId: widget.peerId,
        outgoing: widget.outgoing,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
        traceId: widget.traceId,
      );
    }
    if (widget.video &&
        !_firstVideoReported &&
        _remotePublishingKind(s, SfuTrackType.video)) {
      _firstVideoReported = true;
      StreamCallService.instance.reportFirstMedia(
        widget.call,
        'video',
        peerId: widget.peerId,
        outgoing: widget.outgoing,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
        traceId: widget.traceId,
      );
    }
  }

  void _emitQuality() {
    final props = StreamCallTelemetry.qualityProps(
      widget.call,
      lastRawBundle: _lastStatsBundle,
    );
    StreamCallService.instance.reportQuality(
      widget.call,
      props,
      peerId: widget.peerId,
      outgoing: widget.outgoing,
      video: _isVideo,
      traceId: widget.traceId,
    );
  }

  /// Genuinely over: release the mic (that is what makes `mic_released: true`
  /// truthful) and then leave the screen.
  Future<void> _endAndPop(String reason) async {
    if (_hangingUp) return;
    _hangingUp = true;
    if (widget.endForEveryone != null) {
      try {
        await widget.endForEveryone!().timeout(const Duration(seconds: 3));
      } catch (_) {/* local cleanup still must run */}
    }
    await StreamCallService.instance.leave(
      widget.call,
      connectedAt: _connectedAt,
      role: widget.outgoing ? 'caller' : 'callee',
      reason: reason,
    );
    _exitCallScreen(source: 'remote_end', reason: reason);
  }

  /// [AUDIT-5 2026-08-21] Hang-up now branches on whether the call was ever
  /// answered. An outgoing call still in `connecting` (i.e. still ringing —
  /// `_everConnected` false) must CANCEL the ring
  /// (`StreamCallService.cancelRinging`, which sends `reject(reason:
  /// CallRejectReason.cancel())` to the coordinator so the callee's phone
  /// actually stops ringing — see that method's doc comment for the SDK
  /// evidence). Once the call is live, or on the callee side, this stays
  /// `leave()` exactly as before this task.
  Future<void> _hangUp() async {
    if (_hangingUp) return;
    setState(() => _hangingUp = true);
    await _tonePlayer?.stop(reason: 'caller_cancelled');
    if (widget.outgoing && !_everConnected) {
      // Send both cancellation paths at once. The SDK reject produces the
      // lowest-latency call.cancelled event, while the Worker ends the call
      // with server authority. Waiting for the Worker before reject used to
      // leave the other phone ringing whenever that request timed out.
      await Future.wait<void>([
        StreamCallService.instance.cancelRinging(
          widget.call,
          startedAt: DateTime.fromMillisecondsSinceEpoch(
            widget.startedAtMs ?? DateTime.now().millisecondsSinceEpoch,
          ),
          peerId: widget.peerId,
          traceId: widget.traceId,
        ),
        if (widget.endForEveryone != null)
          widget.endForEveryone!().timeout(const Duration(seconds: 8)),
      ]).catchError((_) => <void>[]);
    } else {
      // The local state can briefly still say "ringing" after the other device
      // accepted. End server-side before leaving an established call.
      if (widget.outgoing && widget.endForEveryone != null) {
        try {
          await widget.endForEveryone!().timeout(const Duration(seconds: 8));
        } catch (_) {/* local cleanup still must run */}
      }
      if (!widget.outgoing && widget.endForEveryone != null) {
        try {
          await widget.endForEveryone!().timeout(const Duration(seconds: 3));
        } catch (_) {/* local leave remains mandatory */}
      }
      await StreamCallService.instance.leave(
        widget.call,
        connectedAt: _connectedAt,
        role: widget.outgoing ? 'caller' : 'callee',
      );
    }
    _exitCallScreen(source: 'hangup_button');
  }

  /// Close a failed call screen. Still leaves the call so nothing is left
  /// holding the mic.
  Future<void> _closeAfterFailure() async {
    _hangingUp = true;
    await _tonePlayer?.stop(reason: 'join_failed');
    if (widget.outgoing && !_everConnected) {
      await StreamCallService.instance.cancelRinging(
        widget.call,
        startedAt: DateTime.fromMillisecondsSinceEpoch(
          widget.startedAtMs ?? DateTime.now().millisecondsSinceEpoch,
        ),
        peerId: widget.peerId,
        traceId: widget.traceId,
      );
    } else {
      await StreamCallService.instance.leave(
        widget.call,
        connectedAt: _connectedAt,
        role: widget.outgoing ? 'caller' : 'callee',
        reason: 'join_failed_$_failureReason',
      );
    }
    _exitCallScreen(source: 'join_failure', reason: _failureReason);
  }

  /// Programmatic call teardown must never use `maybePop()`: that API may
  /// legitimately refuse and leave a dead call surface visible. Incoming
  /// calls opened from a notification can also make this the first route, so
  /// replace it with the normal app root when there is nothing underneath.
  void _exitCallScreen({required String source, String? reason}) {
    if (_popped || !mounted) return;
    final nav = Navigator.of(context);
    final canPop = nav.canPop();
    Analytics.capture('stream_lane_call_screen_exit', {
      'call_id': widget.call.callCid.value,
      'provider': 'stream',
      'role': widget.outgoing ? 'caller' : 'callee',
      'source': source,
      'reason': reason ?? '',
      'can_pop': canPop,
      'ever_connected': _everConnected,
      'phase': _phase.name,
      'user_email': Analytics.currentEmail ?? '',
    });
    _popped = true;
    if (canPop) {
      nav.pop();
    } else {
      nav.pushReplacement(
        MaterialPageRoute<void>(builder: (_) => const RootFlow()),
      );
    }
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
    } catch (_) {
      /* best-effort — UI reflects last confirmed state on failure */
    }
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

  // Stream's default call type permits video, so `settings.video.enabled`
  // describes a capability, not what this AvaTOK call requested. Using it
  // turned every audio call into a video UI after state hydration.
  bool get _isVideo => widget.video;

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
                        final others =
                            widget.call.state.value.otherParticipants;
                        CallParticipantState? remote;
                        for (final p in others) {
                          if (p.publishedTracks
                              .containsKey(SfuTrackType.video)) {
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
                  // [2026-08-24] On a failed call there is no media to mute
                  // or route — the panel above already offers Close / Try
                  // again, so only hang-up stays.
                  if (_phase != _Phase.failed) ...[
                    _controlButton(
                      icon: _muted
                          ? PhosphorIcons.microphoneSlash(
                              PhosphorIconsStyle.bold)
                          : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                      onTap: _toggleMute,
                      active: _muted,
                    ),
                    _controlButton(
                      icon: _speakerOn
                          ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                          : PhosphorIcons.speakerSlash(
                              PhosphorIconsStyle.bold),
                      onTap: _toggleSpeaker,
                      active: !_speakerOn,
                    ),
                    if (widget.video) ...[
                      _controlButton(
                        icon: _cameraOff
                            ? PhosphorIcons.videoCameraSlash(
                                PhosphorIconsStyle.bold)
                            : PhosphorIcons.videoCamera(
                                PhosphorIconsStyle.bold),
                        onTap: _toggleCamera,
                        active: _cameraOff,
                      ),
                      _controlButton(
                        icon: PhosphorIcons.arrowsClockwise(
                            PhosphorIconsStyle.bold),
                        onTap: _flipCamera,
                      ),
                    ],
                  ],
                  _controlButton(
                    icon:
                        PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.fill),
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

  /// [2026-08-24] Was `AD.card` (0xFFFFFAF0) on `AD.bg` (0xFFFBF3E2) — two
  /// creams a few points apart, so the mic/speaker circles vanished into the
  /// page. Idle now uses the indigo call band with a cream glyph; a toggled
  /// state (muted, speaker off, camera off) flips to marigold with an ink
  /// glyph so the state is readable at a glance; hang-up stays rani.
  Widget _controlButton({
    required PhosphorIconData icon,
    required VoidCallback onTap,
    bool danger = false,
    bool active = false,
  }) {
    final Color bg;
    final Color fg;
    if (danger) {
      bg = AD.primaryBadge;
      fg = AD.tabActiveLabel;
    } else if (active) {
      bg = AD.haldi;
      fg = AD.textPrimary;
    } else {
      bg = AD.tabCalls;
      fg = AD.tabActiveLabel;
    }
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: bg,
        ),
        child: Icon(icon, color: fg, size: 26),
      ),
    );
  }
}
