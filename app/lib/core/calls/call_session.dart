import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../analytics.dart';
import '../api_auth.dart';
import '../ava_log.dart';
import '../call_log_store.dart';
import '../call_telemetry.dart';
import '../config.dart';
import '../ice_cache.dart';
import '../profile_store.dart';
import '../receptionist_api.dart';
import '../receptionist_call.dart';
import '../remote_config.dart';
import '../ringback_player.dart';
import '../voice/native_voice_audio.dart';
import '../../push/push_service.dart';
// The 1:1 call/glare globals (gInCall, gActiveCallId, gLiveCallScreens,
// gOutgoing*, gInCallSince) that gate phantom-busy/glare live in call_screen.dart
// and are DRIVEN from here. Imported for scope; call_screen.dart also imports
// this file — Dart permits the library cycle. See call_screen.dart:33-108.
import '../../features/avatok/call_screen.dart';
// [RECEPT-CALLBACK-PREEMPT-1] gReceptionistTargetPub lives in
// call_session_manager.dart (mirrors the gInCall-style globals above);
// call_session_manager.dart also imports this file — same permitted library
// cycle as call_screen.dart above.
import 'call_session_manager.dart';

/// Coarse call lifecycle exposed via [CallSession.phase]. Wave 2 (PiP/pill,
/// reconnect, Gemini parity) keys off THIS enum; the full call view also reads
/// the fine-grained [CallSession.uiPhase] string for its status label.
/// See Specs/CALL-SESSION-API.md.
enum CallPhase { dialing, ringing, connecting, connected, reconnecting, ended }

/// Immutable inputs for a 1:1 call, mirroring the old `CallScreen` widget fields
/// so the session is constructed from the same params the launch sites pass.
class CallSessionConfig {
  final String room;
  final String title;
  final String seed;
  final bool video;
  final bool outgoing;
  final String avatarUrl;
  final String ringbackUrl;
  final String? teamId;
  final int? teamSlot;
  /// [TRACE-ID-1] Correlation id minted at the dial boundary (caller) or carried
  /// in the incoming push (callee). '' when unknown → the session mints one so a
  /// trace always exists. Rides every call event + the reliability score.
  final String traceId;
  const CallSessionConfig({
    required this.room,
    required this.title,
    required this.seed,
    required this.video,
    this.outgoing = true,
    this.avatarUrl = '',
    this.ringbackUrl = '',
    this.teamId,
    this.teamSlot,
    this.traceId = '',
  });
}

/// The one true owner of a 1:1 P2P call: RTCPeerConnection, the signaling
/// WebSocket to the CallRoom DO, MediaStreams, renderers, mute/speaker/camera
/// state, call timer, ringback, CallKit sync, foreground-service start/stop and
/// telemetry. Created ONLY by [CallSessionManager]. A view attaches to it and
/// listens; the view NEVER destroys resources. [hangup] is the single teardown
/// path — see Specs/CALL-SESSION-API.md.
///
/// This is a verbatim extraction of the logic that used to live in
/// `_CallScreenState`; the hard-won phantom-busy/glare protections
/// (call_screen.dart:33–108) and every teardown-race guard are preserved.
/// [CALL-REG-SEAL-1] Capability token that authorizes constructing a
/// [CallSession]. The ONLY instance is [CallSessionManager]'s private
/// [CallSessionManager.sessionToken]; because this class has a private
/// constructor, no code outside `call_session.dart` can mint one. Passing it to
/// [CallSession.internalByManager] is therefore proof the caller is the manager
/// — the sealed-registry invariant (§#4 of DETERMINISTIC-CORE-ARCH) is enforced
/// at the type level, not just by convention.
class CallSessionToken {
  const CallSessionToken._();
}

/// [CALL-REG-SEAL-1] The single token the manager presents to build sessions.
const CallSessionToken kCallSessionToken = CallSessionToken._();

/// [CALL-NETHUD-1] A snapshot of live network health for the in-call HUD.
/// Published on [CallSession.netStats] every watchdog tick (~5s) from the SAME
/// `getStats()` poll the media watchdog already runs (no second poller). All
/// fields are cheap derivations of the RTCStatsReport.
@immutable
class CallNetStats {
  /// Round-trip time in ms (from the selected candidate pair), -1 if unknown.
  final int rttMs;
  /// Inbound (down) bitrate in kbps, computed from the byte delta / interval.
  final int downKbps;
  /// Outbound (up) bitrate in kbps.
  final int upKbps;
  /// Cumulative bytes sent + received this call (for the "data used" readout).
  final int bytesTotal;
  /// Inbound packet-loss percentage (0–100), -1 if unknown.
  final double lossPct;
  /// Discrete quality bucket 0 (worst) … 4 (best), derived from rtt + loss.
  final int quality;
  const CallNetStats({
    this.rttMs = -1,
    this.downKbps = 0,
    this.upKbps = 0,
    this.bytesTotal = 0,
    this.lossPct = -1,
    this.quality = 0,
  });

  static const CallNetStats empty = CallNetStats();

  /// Total data used this call, in MB.
  double get dataMb => bytesTotal / (1024 * 1024);
}

class CallSession {
  /// [CALL-REG-SEAL-1] Sealed construction. A [CallSession] may be built ONLY by
  /// [CallSessionManager], which is the sole holder of a [CallSessionToken]
  /// (mintable only inside this library). This preserves the [CALL-DUP-SESSION-1]
  /// registry invariant: every session is created through `manager.attach()`, so
  /// the `_byRoom` dedup map can never be bypassed by a stray direct construction.
  /// The name is deliberately awkward ("internalByManager") to signal at every
  /// (would-be) call site that this is not a public API. The assert is a
  /// debug-build tripwire in case a token is ever smuggled out.
  CallSession.internalByManager(CallSessionToken token, this.config)
      : assert(identical(token, kCallSessionToken),
            'CallSession must be constructed via CallSessionManager.attach()');

  final CallSessionConfig config;
  String get room => config.room;
  bool get video => config.video;
  bool get outgoing => config.outgoing;

  // ── Renderers (owned; survive view detach — disposed only in hangup) ────────
  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  final RTCVideoRenderer remoteRenderer = RTCVideoRenderer();
  final String _myId = 'app-${const Uuid().v4().substring(0, 6)}';

  // ── Public notifiers (listen; never dispose from a view) ────────────────────
  final ValueNotifier<CallPhase> phase = ValueNotifier<CallPhase>(CallPhase.connecting);
  /// Fine-grained UI label string (the old `_phase`). Values: ringing |
  /// connecting | connected | declined | busy | no-answer | ava-countdown |
  /// receptionist-connecting | receptionist | receptionist-wrapup | ended.
  final ValueNotifier<String> uiPhase = ValueNotifier<String>('connecting');
  final ValueNotifier<bool> minimized = ValueNotifier<bool>(false);
  final ValueNotifier<int> elapsedSeconds = ValueNotifier<int>(0);
  final ValueNotifier<bool> muted = ValueNotifier<bool>(false);
  final ValueNotifier<bool> speakerOn = ValueNotifier<bool>(true);
  final ValueNotifier<bool> cameraOn = ValueNotifier<bool>(true);
  final ValueNotifier<bool> videoActive = ValueNotifier<bool>(true);
  final ValueNotifier<bool> onCellularHold = ValueNotifier<bool>(false);
  /// SEAM for WS-D/C: true while the peer's signaling socket is gone but media
  /// may still be flowing (today: set on 'peer-left', cleared on reconnect /
  /// 'welcome'). WS-D wires the grace-period semantics onto it.
  final ValueNotifier<bool> peerAway = ValueNotifier<bool>(false);
  /// [CALL-NETHUD-1] Live network health for the in-call HUD. Updated on every
  /// media-watchdog tick from the same getStats() poll (no second poller).
  final ValueNotifier<CallNetStats> netStats =
      ValueNotifier<CallNetStats>(CallNetStats.empty);
  /// Generic "session changed" tick so a view can rebuild on anything (e.g. the
  /// receptionist duo appearing). Bumped whenever notable non-notifier state moves.
  final ValueNotifier<int> revision = ValueNotifier<int>(0);
  void _bump() => revision.value++;

  // [DIAL-NARRATION-1] First name for the dial narration ("Amy" from "Amy
  // williams"); neutral fallback when the title is empty.
  String get _peerFirst {
    final t = config.title.trim();
    return t.isEmpty ? 'them' : t.split(RegExp(r'\s+')).first;
  }

  void _setDialStage(String s) {
    if (_ended || _connected || _receptionistActive) return;
    _dialStage = s;
    _bump();
  }

  /// Schedule a narration line [after] dial start, skipped once the phone is
  /// actually ringing / connected / with Ava.
  void _stageAt(Duration after, String Function() line) {
    _dialStageTimers.add(Timer(after, () {
      if (_ended || _connected || _deviceRinging || _receptionistActive) return;
      _setDialStage(line());
    }));
  }

  ReceptionistCall? get receptionist => _receptionist;
  String get myName => _myName;
  String get myAvatar => _myAvatar;
  String get mySeed => _mySeed;

  /// Callback the session uses to ask the currently-attached view to pop its
  /// route (set by the manager/view). Never owns navigation itself.
  void Function()? onRequestPop;

  // [CALL-DUP-SESSION-1] Wired by CallSessionManager. Returns true when ANOTHER
  // live (non-ended) CallSession for THIS room already owns the room on this
  // device — i.e. this session is a duplicate/non-primary leg. Used to (a) make
  // a 'busy' signal that lands on this duplicate leg self-immune (never trigger
  // the receptionist or cancel/end fan-out that would kill the real call), and
  // (b) suppress bye/cancel/ended signalling from this leg's teardown so it can
  // never tear down the genuine call owned by the other session. Null → treat as
  // the sole owner (default single-session behaviour, unchanged).
  bool Function()? anotherLiveSessionOwnsRoom;
  bool get _anotherOwns {
    try { return anotherLiveSessionOwnsRoom?.call() ?? false; } catch (_) { return false; }
  }

  // ── Internal call state (ex-_CallScreenState fields, verbatim) ──────────────
  WebSocketChannel? _ws;
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  bool _ended = false; // guard: teardown runs exactly once
  bool _started = false; // guard: start() runs exactly once (re-attach safe)
  String? _remoteId;
  List<Map<String, dynamic>> _ice = kIceServers;
  Timer? _timer;
  int _secs = 0;
  bool _video = true;
  bool _camOn = true;
  bool _muted = false;
  bool _speaker = true;
  bool _connected = false;
  String _phase = 'connecting';
  Timer? _ringTimeout;
  final RingbackPlayer _ringback = RingbackPlayer();
  ReceptionistCall? _receptionist;
  bool _receptionistActive = false;
  // [RECEPT-START-409-1] Server refusal reason from the last failed /start.
  String? _receptFailReason;
  int _avaCount = 0;
  bool _avaCountingDown = false;
  // [AVA-CLIENT-1] Server "ava-live" ack gate. The confident "Ava is taking your
  // call" status (phase 'receptionist') must NOT be driven by the client timer /
  // WS-connected alone — the receptionist engine can 403/throw and never speak,
  // leaving a frozen countdown with dead air (PostHog ava_recept_skipped
  // reason=start_failed/unavailable). We only open this gate — flip to
  // 'receptionist' — once the server confirms Ava is actually LIVE: either a
  // {type:"ready"}/{type:"ava_live"} control frame OR the first real Ava audio
  // frame (observed here via ReceptionistCall.avaLevel rising, its client-side
  // proxy for first-audio). Until then we stay 'receptionist-connecting'
  // ("Connecting you to Ava…"). Backward-compatible: if no ack ever arrives the
  // watchdog retries once, then surfaces an honest 'receptionist-unavailable'.
  bool _avaLiveGateOpen = false;      // true once the ava-live ack has been seen
  bool _avaLiveConnecting = false;    // true while we're waiting for the ack
  int _avaLiveConnectAtMs = 0;        // when we entered receptionist-connecting
  int _avaLiveAttempt = 0;            // 1 on first wait, 2 after the single retry
  Timer? _avaLiveWatchdog;            // fires if no ack within the timeout window
  VoidCallback? _avaLevelListener;    // listens to ReceptionistCall.avaLevel
  ReceptionistCall? _avaLevelSource;  // the call we attached _avaLevelListener to
  // Fallback window only — the primary gate is now the explicit 'live' status
  // (ReceptionistCall's first inbound audio frame). Widened from 4000ms because
  // the unreachable path's dial + Gemini-connect + first-audio latency routinely
  // reached ~3.8s, landing right on the old deadline and dropping live calls
  // (AVA-RECEPT-UNREACHABLE-WATCHDOG-RACE). 8s gives the fallback real headroom.
  static const int _avaLiveTimeoutMs = 8000;
  String _myAvatar = '';
  String _myName = 'You';
  String _mySeed = 'me';
  String _receptMode = 'rings';
  int _receptRings = 5;
  // [BUSY-CARD-1] Server-provided busy metadata for the personalized busy card.
  // Populated from the 'busy' call-status only when the server sends it; null /
  // false ⇒ old cold "User is busy" behaviour (the card never renders). See
  // Specs/CALL-MESSAGING-RECEPTIONIST-REMEDIATION-PLAN.md §3.1.
  String? _busyReason;                 // active_call | receptionist | do_not_disturb
  bool _busyReceptionistEnabled = false; // gates the "Leave a message for Ava" button
  String _busyPronoun = 'they';        // he | she | they (best-effort, defaults neutral)
  bool _busyNotifyInFlight = false;    // "Notify me" register POST in flight
  bool _busyNotifyRegistered = false;  // "Notify me" succeeded (button flips)
  bool _busyCardShownLogged = false;   // one-shot busy_card_shown telemetry guard
  Timer? _busyCardTimeout;             // abandons an untouched busy card after 60s
  StreamSubscription? _statusSub;
  bool _takeoverGuard = false;
  bool _deviceRinging = false;
  Timer? _deviceRingingTimer;
  // [DIAL-NARRATION-1] (owner request 2026-07-09): progressive status lines while
  // the beeps play, tied to REAL signals, so the connecting phase never feels
  // stalled ("Finding Amy on our network…" → "Found her! Waking the phone up…"
  // → "Ah — it's ringing!"). Shown by statusText for connecting/ringing phases.
  String? _dialStage;
  final List<Timer> _dialStageTimers = [];
  Duration? _pendingRingWindow;
  Timer? _ringAckFallback;
  bool _ringAckHandled = false;
  bool? _pendingAckResult;
  bool _callUnreachable = false;
  final List<RTCIceCandidate> _pendingCandidates = [];
  bool _remoteSet = false;
  late final CallTelemetry _telemetry;
  bool _weOffered = false;
  int _iceRestarts = 0;
  Timer? _failTimer;
  StreamSubscription? _netSub;
  int _wsReconnects = 0;
  Timer? _wsReconnectTimer;
  Timer? _relayFallbackTimer;
  bool _relayForced = false;
  Timer? _placeCallTimeout;
  // [TRACE-ID-1] This call's correlation id (adopted from config or minted in
  // start()). Published to Analytics.currentTraceId for the call's lifetime.
  String _traceId = '';
  bool _gotWelcome = false;
  // CALL-GEN-1: our OWN current generation, handed to us by the CallRoom DO in every
  // 'welcome'. We stamp it on every OUTBOUND signaling frame (see _send); the DO
  // drops frames stamped with a gen below our current one (stale zombie sockets).
  // Null until the first welcome / when talking to an old server that never sends
  // gen — in that case we omit it and behave exactly as before (backward compatible).
  int? _gen;
  // CALL-GEN-2: per-SENDER generations for INBOUND frames, keyed by the frame's
  // `from` id. The DO re-stamps every relayed frame with the SENDER's authoritative
  // gen, so we drop an inbound frame ONLY if its gen is lower than the last gen we
  // saw FOR THAT SENDER — never against our own `_gen`. Comparing the peer's frames
  // against our own gen was the CALL-GEN-1 bug: after OUR reconnect bumped `_gen`,
  // the peer's (correct, older-numbered) frames were dropped forever, going deaf on
  // signaling. Senders/frames without a gen are processed as before (backward compat).
  final Map<String, int> _peerGens = {};
  bool _onCellularHold = false;
  StreamSubscription? _telephonySub;
  // CALL-FOCUS-1: audio-focus hold. When another app (WhatsApp, a cellular call,
  // a video) takes audio focus, the OS reassigns our route and our capture goes
  // nowhere — the peer heard silence / the call appeared cut off. We now HOLD the
  // call on focus loss (mute capture + "on hold" banner, RTC kept alive) and
  // RESUME on regain. Distinct from _onCellularHold so a focus blip doesn't
  // clobber a concurrent cellular-hold's mute state.
  bool _onFocusHold = false;
  int? _focusLostMs;

  // ── CALL-RC-D2: post-connect reconnect state machine ────────────────────
  // Distinct from the pre-connect `_wsReconnects`/`_reconnectSignaling` path
  // above (kept untouched for ringing/connecting drops). This machine only
  // engages once the call was `connected` and the signaling WS drops: phase
  // goes to `reconnecting`, retries back off 0.5/1/2/4/8/8… s, capped at 30s
  // total elapsed, then gives up via hangup('reconnect_failed'). Reuses the
  // SAME `_myId` WS tag so the DO (CallRoom, CALL-RC-D1) recognizes the
  // rejoin and replays buffered signaling.
  static const List<double> _kReconnectBackoffSec = [0.5, 1, 2, 4, 8, 8, 8];
  static const Duration _kReconnectGiveUp = Duration(seconds: 30);
  bool _reconnecting = false;
  int _reconnectAttempt = 0;
  int? _reconnectStartMs;
  Timer? _reconnectRetryTimer;
  Timer? _reconnectGiveUpTimer;
  Timer? _pingTimer;

  // ── [CALL-MEDIA-WATCH-1] mid-call media-flow watchdog ───────────────────
  // Detects the "connected but silent" failure mode: ICE stays Connected and
  // the timer keeps ticking, yet inbound audio bytes stop growing (a dead RTP
  // path the ICE state machine never notices). Polls getStats() every 5s
  // while _connected and not ended; two consecutive stale polls (~10s) kicks
  // an ICE restart via the EXISTING _tryIceRestart ladder (same cap/guards as
  // net-change/transport-state triggers); four stale polls (~20s) ends the
  // call cleanly via the existing _endWith path, instead of leaving a zombie
  // call with dead audio. Never throws; every await is try/catch-guarded.
  Timer? _mediaWatchTimer;
  int _mediaStaleCount = 0;
  int? _lastInboundAudioBytes;
  bool _mediaStalledFlagged = false;
  int? _mediaStallStartMs;
  // [CALL-RELSCORE-1] Cumulative count of distinct media-stall episodes over the
  // whole call — a reliability_score input on call_ended.
  int _mediaStalls = 0;

  // [CALL-NETHUD-1] Rolling state for the network HUD, derived from the SAME
  // getStats() poll the watchdog already runs. `_lastNetTotalBytes`/`_lastNetTs`
  // let us turn cumulative byte counters into an instantaneous kbps rate.
  int? _lastNetSentBytes;
  int? _lastNetRecvBytes;
  int? _lastNetTs;
  // Running EMA of the last observed up/down kbps for a smoother call_ended
  // summary + the reliability payload.
  double _emaUpKbps = 0;
  double _emaDownKbps = 0;

  void _startMediaWatchdog() {
    _mediaWatchTimer?.cancel();
    _mediaStaleCount = 0;
    _lastInboundAudioBytes = null;
    _mediaStalledFlagged = false;
    _mediaStallStartMs = null;
    _mediaWatchTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollMediaWatchdog());
  }

  void _stopMediaWatchdog() {
    _mediaWatchTimer?.cancel();
    _mediaWatchTimer = null;
    _mediaStaleCount = 0;
    _lastInboundAudioBytes = null;
    _mediaStalledFlagged = false;
    _mediaStallStartMs = null;
  }

  Future<void> _pollMediaWatchdog() async {
    try {
      if (_ended || !_connected) return;
      // Media is intentionally paused/replaced during these phases — never
      // false-trigger the watchdog there.
      if (isReceptDuo || _onCellularHold) return;
      // A post-connect signaling reconnect is already handling recovery via
      // its own ladder; don't double-trigger an ICE restart or end the call
      // out from under it.
      if (_reconnecting) return;
      final pc = _pc;
      if (pc == null) return;
      int inboundAudioBytes = 0;
      bool sawInboundAudio = false;
      // [CALL-NETHUD-1] accumulate net-HUD signals from the same report.
      int totalRecvBytes = 0, totalSentBytes = 0;
      int inboundPacketsRecv = 0, inboundPacketsLost = 0;
      int rttMs = -1;
      final stats = await pc.getStats();
      for (final s in stats) {
        final v = s.values;
        if (s.type == 'inbound-rtp') {
          final kind = (v['kind'] ?? v['mediaType'])?.toString();
          final b = v['bytesReceived'];
          if (b is num) totalRecvBytes += b.toInt();
          final pr = v['packetsReceived'];
          if (pr is num) inboundPacketsRecv += pr.toInt();
          final pl = v['packetsLost'];
          if (pl is num) inboundPacketsLost += pl.toInt();
          if (kind == 'audio') {
            sawInboundAudio = true;
            if (b is num) inboundAudioBytes += b.toInt();
          }
        } else if (s.type == 'outbound-rtp') {
          final b = v['bytesSent'];
          if (b is num) totalSentBytes += b.toInt();
        } else if (s.type == 'candidate-pair') {
          // Prefer the nominated/selected pair's RTT (seconds → ms).
          final selected = v['selected'] == true || v['nominated'] == true;
          final rtt = v['currentRoundTripTime'];
          if (selected && rtt is num) rttMs = (rtt.toDouble() * 1000).round();
          else if (rttMs < 0 && rtt is num) rttMs = (rtt.toDouble() * 1000).round();
        }
      }
      _publishNetStats(
        totalRecvBytes: totalRecvBytes,
        totalSentBytes: totalSentBytes,
        packetsRecv: inboundPacketsRecv,
        packetsLost: inboundPacketsLost,
        rttMs: rttMs,
      );
      if (!sawInboundAudio) return; // no inbound audio stat yet — don't judge
      final prev = _lastInboundAudioBytes;
      _lastInboundAudioBytes = inboundAudioBytes;
      if (prev != null && inboundAudioBytes <= prev) {
        _mediaStaleCount++;
      } else {
        if (_mediaStaleCount > 0) {
          // Recovered.
          final stalledForS = _mediaStallStartMs == null
              ? 0
              : ((DateTime.now().millisecondsSinceEpoch - _mediaStallStartMs!) / 1000).round();
          Analytics.capture('call_media_recovered', {
            'call_id': config.room,
            'stalled_for_s': stalledForS,
          });
          if (_mediaStalledFlagged && !_ended && _connected) {
            _setPhase('connected');
          }
        }
        _mediaStaleCount = 0;
        _mediaStalledFlagged = false;
        _mediaStallStartMs = null;
        return;
      }
      if (_mediaStaleCount == 1) {
        _mediaStallStartMs = DateTime.now().millisecondsSinceEpoch;
      }
      if (_mediaStaleCount == 2 && !_mediaStalledFlagged) {
        _mediaStalledFlagged = true;
        _mediaStalls++; // [CALL-RELSCORE-1] count distinct stall episodes
        Analytics.capture('call_media_stalled', {
          'call_id': config.room,
          'stale_s': 10,
          'video': config.video,
        });
        _setPhase('reconnecting');
        // ignore: unawaited_futures
        _tryIceRestart('media-stalled');
      } else if (_mediaStaleCount >= 4) {
        Analytics.capture('call_media_stalled', {
          'call_id': config.room,
          'stale_s': 20,
          'video': config.video,
        });
        if (!_reconnecting) {
          _endWith('ended', reason: 'media-stalled');
        }
      }
    } catch (_) {
      // Never let watchdog polling throw or keep a call alive.
    }
  }

  /// [CALL-NETHUD-1] Turn cumulative byte/packet counters into an instantaneous
  /// up/down kbps + loss %, bucket a 0–4 quality, and publish to [netStats].
  /// Runs off the media-watchdog poll — never adds its own timer.
  void _publishNetStats({
    required int totalRecvBytes,
    required int totalSentBytes,
    required int packetsRecv,
    required int packetsLost,
    required int rttMs,
  }) {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    int upKbps = 0, downKbps = 0;
    final prevTs = _lastNetTs;
    if (prevTs != null && _lastNetSentBytes != null && _lastNetRecvBytes != null) {
      final dtSec = (nowMs - prevTs) / 1000.0;
      if (dtSec > 0.1) {
        final dSent = (totalSentBytes - _lastNetSentBytes!).clamp(0, 1 << 62);
        final dRecv = (totalRecvBytes - _lastNetRecvBytes!).clamp(0, 1 << 62);
        upKbps = ((dSent * 8) / dtSec / 1000).round();
        downKbps = ((dRecv * 8) / dtSec / 1000).round();
        // Light EMA smoothing so the HUD doesn't jitter between polls.
        _emaUpKbps = _emaUpKbps == 0 ? upKbps.toDouble() : (_emaUpKbps * 0.5 + upKbps * 0.5);
        _emaDownKbps = _emaDownKbps == 0 ? downKbps.toDouble() : (_emaDownKbps * 0.5 + downKbps * 0.5);
      }
    }
    _lastNetSentBytes = totalSentBytes;
    _lastNetRecvBytes = totalRecvBytes;
    _lastNetTs = nowMs;

    double lossPct = -1;
    final totalPkts = packetsRecv + packetsLost;
    if (totalPkts > 0) lossPct = (packetsLost / totalPkts) * 100.0;

    // Quality bucket 0–4 from rtt + loss (worst of the two dominates).
    int q = 4;
    if (rttMs >= 0) {
      if (rttMs > 500) q = 0;
      else if (rttMs > 300) q = 1;
      else if (rttMs > 180) q = 2;
      else if (rttMs > 90) q = 3;
    }
    if (lossPct >= 0) {
      int lq = 4;
      if (lossPct > 8) lq = 0;
      else if (lossPct > 4) lq = 1;
      else if (lossPct > 2) lq = 2;
      else if (lossPct > 0.5) lq = 3;
      if (lq < q) q = lq;
    }
    // If we have no signal at all yet, hold mid so the HUD isn't alarming.
    if (rttMs < 0 && lossPct < 0) q = 3;

    netStats.value = CallNetStats(
      rttMs: rttMs,
      upKbps: _emaUpKbps.round(),
      downKbps: _emaDownKbps.round(),
      bytesTotal: totalSentBytes + totalRecvBytes,
      lossPct: lossPct,
      quality: q,
    );
  }

  int get avaCount => _avaCount; // for the countdown ring in the view
  bool get isEnded => _ended;
  bool get isConnected => _connected;
  int get secs => _secs;

  // ─────────────────────────────────────────────────────────────────────────
  //  START
  // ─────────────────────────────────────────────────────────────────────────

  /// Acquire media, open signaling, arm timers/ringback, publish busy/glare
  /// globals and start the foreground service at call SETUP. Idempotent so a
  /// re-attaching view can't re-run it.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    gLiveCallScreens++;
    gInCall = true;
    gActiveCallId = config.room;
    gInCallSince = DateTime.now().millisecondsSinceEpoch;
    // [TRACE-ID-1] Adopt the trace id handed to us (dial boundary on the caller,
    // incoming push on the callee) or mint one so a trace always exists. Publish
    // it globally so EVERY Analytics.capture for the life of this call — here AND
    // in CallTelemetry (call_started/call_connected/call_ended) — carries it,
    // stitching both devices + the server under one trace_id. Cleared in teardown.
    _traceId = config.traceId.isNotEmpty ? config.traceId : TraceContext.mint();
    Analytics.currentTraceId = _traceId;
    Analytics.capture('call_session_extracted', {
      'call_id': config.room,
      'video': config.video,
      'outgoing': config.outgoing,
    });
    // Keep the device awake for the whole call (released in _teardown).
    try { WakelockPlus.enable(); } catch (_) {}
    _takeoverGuard = RemoteConfig.receptTakeoverGuard;
    _telemetry = CallTelemetry(callId: config.room, video: config.video, outgoing: config.outgoing);
    _telemetry.started();
    // My own profile (best-effort) for the receptionist duo's "You" icon.
    ProfileStore().load().then((p) {
      if (_ended) return;
      _myAvatar = p.avatarUrl;
      if (p.displayName.trim().isNotEmpty) _myName = p.displayName.trim();
      _mySeed = p.handle.isNotEmpty ? p.handle : (p.displayName.isNotEmpty ? p.displayName : 'me');
      _bump();
    }).catchError((_) {});
    // Wi-Fi ⇆ cellular handoff → proactive ICE restart.
    _netSub = Connectivity().onConnectivityChanged.listen((_) {
      if (_connected && !_ended) {
        _telemetry.onNetChange();
        _tryIceRestart('net-change');
      }
    });
    _video = config.video;
    _camOn = config.video;
    _speaker = config.video;
    videoActive.value = _video;
    cameraOn.value = _camOn;
    speakerOn.value = _speaker;
    _setPhase((config.outgoing && !_takeoverGuard) ? 'ringing' : 'connecting');
    if (config.outgoing) {
      // CALL-GLARE-1: publish our pending outgoing dial for the incoming-push
      // handler's glare detection. Cleared on connect + on teardown.
      gOutgoingCallTo = config.seed;
      gOutgoingCallId = config.room;
      gOutgoingSince = DateTime.now().millisecondsSinceEpoch;

      if (_takeoverGuard) {
        // [DIAL-NARRATION-1] Progressive, signal-tied status lines while beeping.
        _setDialStage('Finding $_peerFirst on our network…');
        _stageAt(const Duration(seconds: 3), () => "Checking if $_peerFirst's phone is on…");
        _stageAt(const Duration(seconds: 7), () => "Trying to wake $_peerFirst's phone up…");
        // [RING-WINDOW-12S-1] (2026-07-09): wait up to 12s for the ring-ack /
        // device-ringing. Was 6s — but PostHog (avatok-65f9100f) shows the push
        // FAN-OUT alone can take 6s server-side, so the ack physically cannot
        // beat a 6s deadline and every call fell to Ava "unreachable". The
        // searching beeps (CALL-SEARCH-TONE-1) give honest feedback meanwhile,
        // so the longer wait no longer feels like a hang.
        _deviceRingingTimer = Timer(const Duration(seconds: 12), () {
          if (!_ended && !_connected && !_deviceRinging) {
            AvaLog.I.log('call', 'Device ringing timeout: callee unreachable.');
            _ringback.stop();
            _callUnreachable = true;
            _unreachableNotice?.call();
            _onNoAnswer();
          }
        });
      } else {
        _ringTimeout = Timer(const Duration(seconds: 35), () {
          if (!_ended && !_connected) _onNoAnswer();
        });
      }

      if (!config.video) {
        // ignore: unawaited_futures
        _probeReceptionist();
      }

      if (RemoteConfig.ringbackEnabled && !_takeoverGuard) {
        // ignore: unawaited_futures
        _ringback.playRingback(config.ringbackUrl);
        Analytics.capture('ringback_played', {
          'source': config.ringbackUrl.isEmpty ? 'default' : 'custom',
          'video': config.video,
        });
      } else if (RemoteConfig.ringbackEnabled && _takeoverGuard) {
        // [CALL-SEARCH-TONE-1] Guard mode is honest: no fake ringback before the
        // callee's device confirms it's ringing. But dead silence reads as a hung
        // app, so — like PSTN — play soft progress beeps while the network locates
        // the callee. _onDeviceRinging swaps in the real ringback; every existing
        // stop() path (connect / unreachable / busy / no-answer) kills it too.
        // ignore: unawaited_futures
        _ringback.playSearchingTone();
        Analytics.capture('searching_tone_played', {
          'call_id': config.room,
          'video': config.video,
        });
      }
    }
    // Server-relayed call status (declined / busy / decline-to-Ava) for this call.
    _statusSub = callStatusBus.stream.listen((e) {
      if (_receptionistActive) {
        if (e.callId == config.room) {
          Analytics.capture('ava_recept_signal_suppressed',
              {'channel': 'call_status', 'status': e.status, 'call_id': config.room});
        }
        return;
      }
      if (e.callId == config.room && !_ended && e.status == 'glare-yield') {
        Analytics.capture('call_glare_yielded', {'call_id': config.room});
        _endWith('ended', reason: 'glare-yield');
        return;
      }
      if (e.callId == config.room && !_ended &&
          (e.status == 'ended' || e.status == 'cancel' || e.status == 'bye')) {
        _endWith('ended', reason: 'remote-ended-push');
        return;
      }
      if (e.callId == config.room && !_connected) {
        if (e.status == 'decline_ava' && !config.video && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
          return;
        }
        if (e.status == 'busy') {
          // [BUSY-CARD-1] Capture the server's busy metadata (why + whether the
          // callee's receptionist can take a message + pronoun) BEFORE handling
          // busy, so _onBusy can decide whether to render the personalized card.
          _busyReason = e.busyReason;
          _busyReceptionistEnabled = e.receptionistEnabled;
          if (e.pronoun != null && e.pronoun!.isNotEmpty) _busyPronoun = e.pronoun!;
          // ignore: unawaited_futures
          _onBusy();
          return;
        }
        if (e.status == 'decline' && !config.video && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
          return;
        }
        _endWith(e.status == 'decline' ? 'declined' : e.status);
      }
    });
    // Log to call history.
    CallLogStore().add(CallEntry(
      name: config.title, seed: config.seed, video: config.video,
      dir: config.outgoing ? CallDir.outgoing : CallDir.incoming,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    ));
    await _bootMedia();
  }

  /// Sync the coarse enum + fine label + view tick from a fine phase string.
  void _setPhase(String p) {
    _phase = p;
    uiPhase.value = p;
    phase.value = _coarse(p);
    _bump();
  }

  static CallPhase _coarse(String p) {
    switch (p) {
      case 'ringing':
        return CallPhase.ringing;
      case 'connected':
      case 'receptionist':
      case 'receptionist-connecting':
      case 'receptionist-wrapup':
      case 'ava-countdown':
        return CallPhase.connected;
      case 'ended':
      case 'declined':
      case 'busy':
      case 'no-answer':
      case 'network-error':
      // [AVA-CLIENT-1] terminal honest fallback — Ava never went live.
      case 'receptionist-unavailable':
        return CallPhase.ended;
      case 'reconnecting':
        return CallPhase.reconnecting;
      default:
        return CallPhase.connecting;
    }
  }

  /// [phase] drives the UI label; [reason] is the exhaustive telemetry taxonomy.
  void _endWith(String phase, {String? reason}) {
    _telemetry.ended(reason ?? phase);
    _ringback.stop();
    final busy = phase == 'busy' && config.outgoing && RemoteConfig.ringbackEnabled;
    if (busy) {
      // ignore: unawaited_futures
      _ringback.playBusyTone();
      Analytics.capture('busy_tone_played', const {});
    }
    // Release mic/cam IMMEDIATELY on every end path — this is the ONE teardown.
    // Fire-and-forget: _teardown is idempotent and async, but the UI label +
    // pop scheduling below must happen synchronously (as the old _endWith did).
    // ignore: unawaited_futures
    _teardown(reason: reason ?? phase);
    _setPhase(phase);
    // Give the busy tone time to be heard before the view pops; other states 1.4s.
    Future.delayed(Duration(milliseconds: busy ? 2600 : 1400), () {
      onRequestPop?.call();
    });
  }

  String get _room => config.room;

  Future<void> _fetchIce() async {
    _ice = await IceCache.get();
  }

  /// FREE LAUNCH §2: tune the Opus encoder on the LOCAL SDP for voice.
  static String _tuneOpusSdp(String? sdp) {
    if (sdp == null || sdp.isEmpty) return sdp ?? '';
    final pts = RegExp(r'a=rtpmap:(\d+) opus/', caseSensitive: false)
        .allMatches(sdp)
        .map((m) => m.group(1)!)
        .toSet();
    if (pts.isEmpty) return sdp;
    const want = <String, String>{
      'useinbandfec': '1',
      'usedtx': '1',
      'maxaveragebitrate': '40000',
      'stereo': '0',
    };
    final lines = sdp.split(RegExp(r'\r\n|\n'));
    for (var i = 0; i < lines.length; i++) {
      for (final pt in pts) {
        final prefix = 'a=fmtp:$pt ';
        if (!lines[i].startsWith(prefix)) continue;
        final params = <String, String>{};
        for (final kv in lines[i].substring(prefix.length).split(';')) {
          final t = kv.trim();
          if (t.isEmpty) continue;
          final eq = t.indexOf('=');
          if (eq < 0) {
            params[t] = '';
          } else {
            params[t.substring(0, eq)] = t.substring(eq + 1);
          }
        }
        params.addAll(want);
        lines[i] = prefix +
            params.entries
                .map((e) => e.value.isEmpty ? e.key : '${e.key}=${e.value}')
                .join(';');
      }
    }
    return lines.join('\r\n');
  }

  RTCSessionDescription _tuned(RTCSessionDescription d) =>
      RTCSessionDescription(_tuneOpusSdp(d.sdp), d.type);

  Future<void> _bootMedia() async {
    await localRenderer.initialize();
    await remoteRenderer.initialize();
    await _fetchIce();
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        'audio': {
          'echoCancellation': true,
          'noiseSuppression': true,
          'autoGainControl': true,
          'mandatory': {
            'googEchoCancellation': true,
            'googNoiseSuppression': true,
            'googAutoGainControl': true,
            'googHighpassFilter': true,
          },
          'optional': [],
        },
        'video': config.video ? {'facingMode': 'user'} : false,
      });
    } catch (e) {
      Analytics.error(
        domain: 'call_setup',
        code: 'media_denied',
        message: e.toString(),
        action: config.video ? 'getUserMedia_av' : 'getUserMedia_audio',
        extra: {'call_id': config.room, 'video': config.video},
      );
      _mediaDeniedNotice?.call();
      _endWith('ended', reason: 'media-denied');
      return;
    }
    localRenderer.srcObject = _stream;
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    try { await NativeVoiceAudio().startP2pAudioMode(); } catch (_) {}
    try { await NativeVoiceAudio().startBluetoothSco(); } catch (_) {}
    if (NativeVoiceAudio.isSupported) {
      final route = (await NativeVoiceAudio().getAudioRoute()) ?? 'unknown';
      if (route == 'earpiece') {
        Analytics.capture('call_audio_route', {'route': 'earpiece', 'auto': true});
        try { await NativeVoiceAudio().startProximitySensor(); } catch (_) {}
      } else {
        Analytics.capture('call_audio_route', {'route': route, 'auto': true});
      }
    }
    // WS-B: start the foreground service at call SETUP (not on connect) so a call
    // backgrounded while ringing/connecting keeps its FGS and survives.
    if (NativeVoiceAudio.isSupported) {
      try {
        await NativeVoiceAudio.instance.startCallForegroundService(
          callId: config.room,
          peerName: config.title,
          isVideo: config.video,
          at: config.outgoing ? 'dial' : 'accept',
        );
      } catch (_) {}
    }
    // CALL-FOCUS-1: hold the call while another app owns audio focus. Wired on
    // NativeVoiceAudio.instance — the same singleton that started the FGS and
    // therefore owns the method-channel handler that carries these callbacks.
    if (NativeVoiceAudio.isSupported) {
      NativeVoiceAudio.instance.onAudioFocusLost = () {
        if (_ended || _onFocusHold) return;
        _onFocusHold = true;
        _focusLostMs = DateTime.now().millisecondsSinceEpoch;
        onCellularHold.value = true; // reuse the "on hold" UI signal
        if (!_muted) {
          _muted = true;
          muted.value = true;
          _send({'type': 'mute', 'muted': true});
        }
        Analytics.capture('call_audio_focus_lost', {'call_id': config.room});
      };
      NativeVoiceAudio.instance.onAudioFocusRegained = () {
        if (!_onFocusHold) return;
        _onFocusHold = false;
        final heldMs = _focusLostMs == null
            ? 0
            : DateTime.now().millisecondsSinceEpoch - _focusLostMs!;
        _focusLostMs = null;
        // Only clear the hold banner if a cellular hold isn't also active.
        if (!_onCellularHold) onCellularHold.value = false;
        if (_muted && !_onCellularHold) {
          _muted = false;
          muted.value = false;
          _send({'type': 'mute', 'muted': false});
        }
        Analytics.capture('call_audio_focus_regained', {
          'call_id': config.room,
          'held_ms': heldMs,
        });
      };
    }
    if (NativeVoiceAudio.isSupported) {
      try {
        await NativeVoiceAudio().startTelephonyMonitoring();
        _telephonySub = NativeVoiceAudio().telephonyEventStream.listen((event) {
          final state = (event['state'] ?? '').toString();
          if (state == 'held' && !_onCellularHold) {
            _onCellularHold = true;
            onCellularHold.value = true;
            if (!_muted) {
              _muted = true;
              muted.value = true;
              _send({'type': 'mute', 'muted': true});
            }
            Analytics.capture('call_cellular_held', {'call_id': config.room});
          } else if (state == 'resumed' && _onCellularHold) {
            _onCellularHold = false;
            onCellularHold.value = false;
            if (_muted) {
              _muted = false;
              muted.value = false;
              _send({'type': 'mute', 'muted': false});
            }
            Analytics.capture('call_cellular_resumed', {'call_id': config.room});
          }
        });
      } catch (_) {}
    }
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_ended) return;
      _secs++;
      elapsedSeconds.value = _secs;
    });
    final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    _ws = WebSocketChannel.connect(Uri.parse(url));
    _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
    _startPingTimer();
    if (config.outgoing) {
      _placeCallTimeout = Timer(const Duration(seconds: 8), () {
        if (!_gotWelcome && !_ended && _phase == 'ringing') {
          if (_wsReconnects > 0) {
            if (_placeCallTimeout == null) {
              _placeCallTimeout = Timer(const Duration(seconds: 4), () {});
            }
            return;
          }
          _ringback.stop();
          // [CALL-DIAL-FAIL-1] The /api/call POST returned OK but the signaling
          // WS never got a 'welcome' within 8s (dead/flaky connection after the
          // dial). Distinct terminal phase (not generic 'ended') so the caller
          // sees a clear network sticker/snackbar instead of silently dying —
          // and we skip straight to it instead of waiting out the full ring
          // window + a pointless receptionist attempt.
          Analytics.capture('call_place_failed', {
            'call_id': config.room,
            'stage': 'no_server_confirm',
            'kind': config.video ? 'video' : 'audio',
          });
          _placeCallFailedNotice?.call();
          _endWith('network-error', reason: 'place-call-timeout');
        }
      });
    }
    _relayFallbackTimer = Timer(const Duration(seconds: 4), () {
      if (!_connected && !_ended) _forceRelayRestart();
    });
  }

  // ── View notice hooks (snackbars) — set by the attached view. ───────────────
  void Function()? _mediaDeniedNotice;
  void Function()? _placeCallFailedNotice;
  void Function()? _unreachableNotice;
  /// The view registers user-facing snackbar callbacks. Cleared on detach.
  void setNoticeHooks({
    void Function()? mediaDenied,
    void Function()? placeCallFailed,
    void Function()? unreachable,
  }) {
    _mediaDeniedNotice = mediaDenied;
    _placeCallFailedNotice = placeCallFailed;
    _unreachableNotice = unreachable;
  }

  Future<void> _forceRelayRestart() async {
    if (_ended || _connected || _relayForced) return;
    if (!_weOffered || _remoteId == null) return;
    _relayForced = true;
    _telemetry.onIceRestart();
    Analytics.capture('call_relay_fallback', {'call_id': config.room, 'video': config.video});
    try {
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      _remoteSet = false;
      _pendingCandidates.clear();
      final pc = await _newPC(forceRelay: true);
      final offer = _tuned(await pc.createOffer());
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
    } catch (_) {}
  }

  void _onSocketLost() {
    if (_ended) return;
    if (_receptionistActive) {
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'socket_lost', 'call_id': config.room});
      return;
    }
    if (_connected) {
      // CALL-RC-D2: post-connect drop → the exponential-backoff reconnect
      // state machine (phase=reconnecting), not the legacy pre-connect path.
      _beginReconnect();
      return;
    }
    if ((_phase == 'ringing' || _phase == 'connecting') && _wsReconnects < 3) {
      Analytics.capture('call_ws_reconnect_preconnect',
          {'call_id': config.room, 'phase': _phase, 'attempt': _wsReconnects + 1});
      _reconnectSignaling(isConnected: false);
      return;
    }
    _endWith('ended', reason: 'socket-lost');
  }

  void _reconnectSignaling({required bool isConnected}) {
    if (_ended) return;
    if (isConnected && !_connected) return;
    if (!isConnected && (_phase != 'ringing' && _phase != 'connecting')) return;
    if (_wsReconnects >= (isConnected ? 5 : 3)) return;
    _wsReconnects++;
    _wsReconnectTimer?.cancel();
    final delayMs = isConnected
        ? 600 * _wsReconnects
        : [1000, 2000, 4000][_wsReconnects - 1];
    _wsReconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      if (_ended) return;
      if (isConnected && !_connected) return;
      if (!isConnected && (_phase != 'ringing' && _phase != 'connecting')) return;
      try { _ws?.sink.close(); } catch (_) {}
      final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
      try {
        _ws = WebSocketChannel.connect(Uri.parse(url));
        _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
      } catch (_) {
        _onSocketLost();
      }
    });
  }

  // ── CALL-RC-D2: post-connect reconnect state machine ────────────────────

  /// Signaling WS dropped while `connected`. Enter `reconnecting`, arm the
  /// 30s give-up timer, and kick off the first retry attempt.
  void _beginReconnect() {
    if (_ended) return;
    _stopPingTimer();
    // [CALL-MEDIA-WATCH-1] the signaling reconnect ladder owns recovery now;
    // stop polling stats so the watchdog can't race it with its own ICE
    // restart / end-call decision. Re-armed in _completeReconnect.
    _stopMediaWatchdog();
    if (!_reconnecting) {
      _reconnecting = true;
      _reconnectAttempt = 0;
      _reconnectStartMs = DateTime.now().millisecondsSinceEpoch;
      _setPhase('reconnecting');
      // peerAway is a separate signal (the OTHER peer's socket state, driven
      // by peer-away/peer-rejoined below); our own drop doesn't imply theirs.
      Analytics.capture('call_reconnect_start', {'call_id': config.room, 'video': config.video});
      _reconnectGiveUpTimer?.cancel();
      _reconnectGiveUpTimer = Timer(_kReconnectGiveUp, () {
        if (_ended || !_reconnecting) return;
        Analytics.capture('call_reconnect_fail', {
          'call_id': config.room,
          'elapsed_ms': DateTime.now().millisecondsSinceEpoch - (_reconnectStartMs ?? 0),
          'attempts': _reconnectAttempt,
        });
        _endWith('ended', reason: 'reconnect_failed');
      });
    }
    _scheduleReconnectAttempt();
  }

  void _scheduleReconnectAttempt() {
    if (_ended || !_reconnecting) return;
    _reconnectRetryTimer?.cancel();
    final idx = _reconnectAttempt.clamp(0, _kReconnectBackoffSec.length - 1);
    final delay = Duration(milliseconds: (_kReconnectBackoffSec[idx] * 1000).round());
    _reconnectAttempt++;
    _reconnectRetryTimer = Timer(delay, _attemptReconnect);
  }

  void _attemptReconnect() {
    if (_ended || !_reconnecting) return;
    // Give-up timer is the source of truth for the 30s cap; just try again.
    try { _ws?.sink.close(); } catch (_) {}
    final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    try {
      _ws = WebSocketChannel.connect(Uri.parse(url));
      _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
    } catch (_) {
      // Connection attempt itself threw synchronously — schedule the next retry.
      _scheduleReconnectAttempt();
      return;
    }
    // If this attempt doesn't yield a 'welcome' before the next backoff tick,
    // schedule the following retry; a successful 'welcome' calls
    // _completeReconnect() (which flips _reconnecting off) before it fires,
    // so the guard at the top of _scheduleReconnectAttempt no-ops it.
    _scheduleReconnectAttempt();
  }

  /// Called from the `welcome` signal handler when we reconnect mid-call
  /// (i.e. we were the one who dropped and re-attached with the same `id`).
  void _completeReconnect() {
    if (!_reconnecting) return;
    _reconnecting = false;
    _reconnectRetryTimer?.cancel();
    _reconnectGiveUpTimer?.cancel();
    final ms = DateTime.now().millisecondsSinceEpoch - (_reconnectStartMs ?? DateTime.now().millisecondsSinceEpoch);
    Analytics.capture('call_reconnect_ok', {
      'call_id': config.room,
      'ms': ms,
      'attempts': _reconnectAttempt,
    });
    _reconnectStartMs = null;
    _reconnectAttempt = 0;
    if (!_ended) {
      _setPhase('connected');
      _startPingTimer();
      // [CALL-MEDIA-WATCH-1] re-arm now that the reconnect ladder has handed
      // control back; fresh baseline avoids judging staleness across the gap.
      _startMediaWatchdog();
    }
  }

  /// 15s client ping over the signaling WS, matching the DO's
  /// `setWebSocketAutoResponse({type:"ping"}->{type:"pong"})` (CALL-RC-D1).
  /// No manual pong handling needed client-side — the DO answers without
  /// waking, and stray {"type":"pong"} frames are ignored by `_onSignal`'s
  /// switch (no matching case).
  void _startPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (_ended) return;
      _send({'type': 'ping'});
    });
  }

  void _stopPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = null;
  }

  void _send(Map<String, dynamic> o) {
    // CALL-GEN-1: stamp our current generation on every frame so the DO can drop
    // frames from a superseded transport. Omitted until we've received a 'welcome'
    // with a gen (old server / pre-connect) — an old server ignores the field and
    // an old client never sees it, so this is fully backward compatible.
    if (_gen != null && !o.containsKey('gen')) o['gen'] = _gen;
    try { _ws?.sink.add(jsonEncode(o)); } catch (_) {/* socket closed / gone */}
  }

  Future<void> _preferResolutionOnVideo(RTCPeerConnection pc) async {
    try {
      final senders = await pc.getSenders();
      for (final s in senders) {
        if (s.track?.kind != 'video') continue;
        final params = s.parameters;
        params.degradationPreference = RTCDegradationPreference.MAINTAIN_RESOLUTION;
        await s.setParameters(params);
      }
    } catch (_) {}
  }

  static String _candTypeOf(String? cand) {
    if (cand == null) return '';
    final m = RegExp(r'typ (\w+)').firstMatch(cand);
    return m?.group(1) ?? '';
  }

  Future<RTCPeerConnection> _newPC({bool forceRelay = false}) async {
    final pc = await createPeerConnection({
      'iceServers': _ice,
      'iceCandidatePoolSize': 2,
      if (CallDiag.turnOnly || forceRelay) 'iceTransportPolicy': 'relay',
    });
    _stream!.getTracks().forEach((t) => pc.addTrack(t, _stream!));
    if (config.video) await _preferResolutionOnVideo(pc);
    _telemetry.onIceGatheringStart();
    pc.onIceCandidate = (c) {
      _telemetry.onLocalCandidate(_candTypeOf(c.candidate));
      if (_remoteId != null) _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
    };
    pc.onIceGatheringState = (s) {
      if (s == RTCIceGatheringState.RTCIceGatheringStateComplete) {
        _telemetry.onIceGatheringDone();
      }
    };
    pc.onTrack = (e) async {
      if (e.streams.isNotEmpty) {
        remoteRenderer.srcObject = e.streams[0];
        _ringTimeout?.cancel();
        _failTimer?.cancel();
        _relayFallbackTimer?.cancel();
        _ringback.stop();
        _telemetry.connected(pc);
        HapticFeedback.mediumImpact();
        if (gOutgoingCallId == config.room) {
          gOutgoingCallTo = null; gOutgoingCallId = null; gOutgoingSince = 0;
        }
        _connected = true;
        peerAway.value = false;
        _setPhase('connected');
        // [CALL-MEDIA-WATCH-1] arm the media-flow watchdog now that we're live.
        _startMediaWatchdog();
      }
    };
    pc.onConnectionState = (s) {
      if (_ended || !_connected) return;
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _endWith('ended');
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
                 s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        final isFailed = s == RTCPeerConnectionState.RTCPeerConnectionStateFailed;
        final canRestart = _weOffered && _iceRestarts < 3 && _remoteId != null;
        if (isFailed && !canRestart) {
          _endWith('ended', reason: 'rtc-failed');
          return;
        }
        _tryIceRestart('transport-$s');
        _failTimer?.cancel();
        _failTimer = Timer(const Duration(seconds: 10), () {
          final st = _pc?.connectionState;
          if (!_ended && _connected &&
              st != RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
            _endWith('ended', reason: isFailed ? 'rtc-failed' : 'rtc-disconnected');
          }
        });
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _failTimer?.cancel();
      }
    };
    _pc = pc;
    return pc;
  }

  Future<void> _tryIceRestart(String why) async {
    final pc = _pc;
    if (pc == null || _ended || !_weOffered || _remoteId == null) return;
    if (_iceRestarts >= 3) return;
    _iceRestarts++;
    _telemetry.onIceRestart();
    try {
      _ice = await IceCache.get();
      final offer = _tuned(await pc.createOffer({'iceRestart': true}));
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
    } catch (_) {}
  }

  Future<void> _flushCandidates() async {
    _remoteSet = true;
    final pc = _pc;
    if (pc == null) return;
    final pending = List<RTCIceCandidate>.of(_pendingCandidates);
    _pendingCandidates.clear();
    for (final c in pending) {
      try { await pc.addCandidate(c); } catch (_) {}
    }
  }

  Future<void> _onSignal(dynamic raw) async {
    if (_receptionistActive) {
      String? t;
      try { t = (jsonDecode(raw as String) as Map)['type']?.toString(); } catch (_) {}
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'signaling', if (t != null) 'type': t, 'call_id': config.room});
      return;
    }
    if (_ended) return;
    final d = jsonDecode(raw as String) as Map<String, dynamic>;
    // CALL-GEN-2: drop stale-generation inbound frames PER SENDER. The DO re-stamps
    // every relayed frame with the sender's authoritative gen, and stamps `from` with
    // the sender's id. A frame is stale ONLY if its gen is lower than the last gen we
    // saw FROM THAT SENDER — compared against `_peerGens[from]`, never our own `_gen`.
    // (CALL-GEN-1 wrongly judged the peer's frames against OUR `_gen`; after our own
    // reconnect bumped `_gen`, the peer's correct older-numbered frames were dropped
    // forever and signaling went deaf.) 'welcome' is server-originated (carries OUR
    // gen, no sender `from`) → exempt, handled below. Frames without a gen or without
    // a `from` (old server / old peer) are processed as today (backward compatible).
    final dynamic gv = d['gen'];
    final String frameFrom = (d['from'] is String) ? d['from'] as String : '';
    if (gv is num && frameFrom.isNotEmpty && d['type'] != 'welcome') {
      final known = _peerGens[frameFrom];
      final int fg = gv.toInt();
      if (known != null && fg < known) {
        Analytics.capture('invariant_protected', {
          'kind': 'stale_generation_rejected',
          'side': 'client',
          'sender': frameFrom,
          'frame_gen': fg,
          'current_gen': known,
          'frame_type': d['type']?.toString() ?? 'unknown',
          'call_id': config.room,
        });
        return;
      }
      // Not stale → record this sender's newest gen so subsequent lower-gen zombie
      // frames from the SAME sender are rejected (monotonic per sender).
      if (known == null || fg > known) _peerGens[frameFrom] = fg;
    }
    if (frameFrom.isNotEmpty) {
      _onDeviceRinging();
    }
    if (d['country'] is String) _telemetry.setPeerCountry(d['country'] as String);
    switch (d['type']) {
      case 'welcome':
        _gotWelcome = true;
        // CALL-GEN-1: adopt the generation the DO assigned us. On a reconnect the
        // DO bumps our gen, so this raises _gen and our subsequent frames outrank
        // any lingering old-socket frames. Absent on old servers → stays null.
        if (d['gen'] is num) _gen = (d['gen'] as num).toInt();
        _placeCallTimeout?.cancel();
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          _weOffered = true;
          if (_connected && _pc != null) {
            _wsReconnects = 0;
            peerAway.value = false;
            Analytics.capture('call_ws_reconnected', {'call_id': config.room});
            // CALL-RC-D2: this `welcome` is the CallRoom DO recognizing OUR
            // rejoin (same `id` tag) after a signaling drop — complete the
            // reconnect state machine (phase back to connected, cancel the
            // give-up timer) before the ICE restart so the UI clears
            // "Reconnecting…" promptly.
            _completeReconnect();
            await _tryIceRestart('ws-reconnect');
          } else {
            final pc = await _newPC();
            final offer = _tuned(await pc.createOffer());
            await pc.setLocalDescription(offer);
            _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
          }
        }
        break;
      case 'offer':
        try {
          _remoteId = d['from'] as String;
          final pc = _pc ?? await _newPC();
          await pc.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
          await _flushCandidates();
          final ans = _tuned(await pc.createAnswer());
          await pc.setLocalDescription(ans);
          _send({'type': 'answer', 'to': _remoteId, 'sdp': ans.toMap()});
        } catch (_) {}
        break;
      case 'answer':
        try {
          await _pc?.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
          await _flushCandidates();
        } catch (_) {}
        break;
      case 'candidate':
        final c = d['candidate'];
        final cand = RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']);
        if (_pc == null || !_remoteSet) {
          _pendingCandidates.add(cand);
        } else {
          try { await _pc!.addCandidate(cand); } catch (_) {}
        }
        break;
      case 'device-ringing':
        _onDeviceRinging();
        break;
      case 'ring-ack':
        _onRingAck(d['ok'] == true);
        break;
      case 'decline':
        if (_receptionistActive) break;
        if (!config.video && !_connected && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
        } else {
          _endWith('declined', reason: 'decline');
        }
        break;
      case 'busy':
        // [BUSY-CARD-1] Capture busy metadata off the FAST WS path too (not just the
        // durable callStatusBus) so the personalized card can render immediately and
        // beat the plain-'busy' race. Absent fields ⇒ legacy "User is busy".
        final busyReasonWs = (d['busy_reason'] ?? '').toString();
        if (busyReasonWs.isNotEmpty) {
          _busyReason = busyReasonWs;
          final re = d['receptionist_enabled'];
          _busyReceptionistEnabled = re == true || re == '1' || re == 1;
          final pr = (d['pronoun'] ?? '').toString();
          if (pr.isNotEmpty) _busyPronoun = pr;
        }
        // ignore: unawaited_futures
        _onBusy();
        break;
      // CALL-RC-D1/D2: the CallRoom DO now grades a dropped peer's socket
      // through a 30s away/rejoin window instead of ending the call instantly.
      // 'peer-away' = the peer's signaling socket dropped; media may still be
      // flowing. 'peer-rejoined' = they re-attached within the window (their
      // OWN reconnect, distinct from a 'welcome' answering OUR reconnect).
      // 'peer-left' now ONLY arrives after the 30s alarm expires with no
      // rejoin — i.e. a real end, not a grace signal.
      case 'peer-away':
        if (_connected) {
          peerAway.value = true;
          Analytics.capture('call_peer_away', {'call_id': config.room});
        }
        break;
      case 'peer-rejoined':
        if (_connected) {
          peerAway.value = false;
          Analytics.capture('call_peer_rejoined', {'call_id': config.room});
          // The peer's transport blipped and recovered; proactively re-offer
          // an ICE restart from our side too (harmless if already healthy —
          // _tryIceRestart no-ops unless we're the offerer with a live pc).
          // ignore: unawaited_futures
          _tryIceRestart('peer-rejoined');
        }
        break;
      case 'peer-left':
        // Alarm expired with no rejoin — the call is over for real.
        peerAway.value = false;
        if (_connected) {
          _endWith('ended', reason: 'peer-left');
        } else {
          _connected = false;
          _bump();
        }
        break;
      case 'bye':
        remoteRenderer.srcObject = null;
        _endWith('ended', reason: 'remote-bye');
        break;
      case 'ping':
      case 'pong':
        // WS-layer keepalive frames (server auto-response / our own 15s
        // ping). Nothing to do client-side.
        break;
    }
  }

  String get clock {
    final m = (_secs ~/ 60).toString().padLeft(2, '0');
    final s = (_secs % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  View-facing controls
  // ─────────────────────────────────────────────────────────────────────────

  void toggleMute() {
    _muted = !_muted;
    _stream?.getAudioTracks().forEach((t) => t.enabled = !_muted);
    muted.value = _muted;
  }

  void toggleSpeaker() {
    _speaker = !_speaker;
    speakerOn.value = _speaker;
    Helper.setSpeakerphoneOn(_speaker);
    // ignore: unawaited_futures
    _receptionist?.setSpeaker(_speaker);
  }

  void _notifyCalleeCanceled() {
    if (config.seed.isEmpty) return;
    // [CALL-DUP-SESSION-1] Never fan out a 'cancel' for a room that ANOTHER live
    // session owns. This is the teardown of a duplicate/non-primary leg (e.g. a
    // busy-rejected 3rd peer, or a redundant restore session losing the `_active`
    // slot). Sending 'cancel' here pushed a terminal status the real session
    // acted on and ended the genuine call for both parties.
    if (_anotherOwns) {
      Analytics.capture('call_cancel_suppressed_dup', {'call_id': config.room});
      return;
    }
    ApiAuth.postJson(kCallStatusUrl, {
      'to': config.seed, 'callId': config.room, 'status': 'cancel',
    }).ignore();
    Analytics.capture('call_cancel_sent', {'call_id': config.room});
  }

  void toggleCamera() {
    if (!_video) {
      _video = true; _camOn = true; _speaker = true;
      videoActive.value = true; cameraOn.value = true; speakerOn.value = true;
      _restartWithVideo();
      return;
    }
    _camOn = !_camOn;
    _stream?.getVideoTracks().forEach((t) => t.enabled = _camOn);
    cameraOn.value = _camOn;
  }

  Future<void> _restartWithVideo() async {
    if (_ended) return;
    try {
      final v = await navigator.mediaDevices
          .getUserMedia({'video': {'facingMode': 'user'}, 'audio': false});
      final track = v.getVideoTracks().first;
      await _stream?.addTrack(track);
      localRenderer.srcObject = _stream;
      if (_stream != null) await _pc?.addTrack(track, _stream!);
      if (_pc != null) await _preferResolutionOnVideo(_pc!);
      if (!_ended && _pc != null && _remoteId != null) {
        final offer = _tuned(await _pc!.createOffer());
        await _pc!.setLocalDescription(offer);
        _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
        Analytics.capture('call_video_upgraded', {'call_id': config.room});
      }
    } catch (_) {}
    _bump();
  }

  /// Red button / notification "Hang up".
  /// CALL-UI-DEAD-1: pop the UI IMMEDIATELY, then run the durable teardown in
  /// the background. The old order (`await hangup()` THEN pop) meant a
  /// half-dead WS/PC or wedged native channel hung the await forever and the
  /// red button appeared to do nothing, forcing users to kill the app.
  Future<void> endByUser() async {
    Analytics.capture('call_end_pressed', {
      'call_id': config.room,
      'phase': _phase,
      'connected': _connected,
    });
    final pop = onRequestPop;
    onRequestPop = null; // consumed here — teardown must not double-fire it
    pop?.call();
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
    if (config.seed.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {
        'to': config.seed, 'callId': config.room, 'status': 'ended',
      }).ignore();
    }
    _telemetry.ended('local-hangup');
    await hangup('local-hangup');
  }

  /// [CALL-EXCL-1] Is this session currently talking to the receptionist (Ava)?
  bool get hasLiveReceptionist => _receptionist != null && !_ended;

  /// [CALL-EXCL-1] Single-audio-authority yield: the device owner just accepted a
  /// real incoming call. If THIS session is a live receptionist leg, end it via
  /// the DO `owner_answered` path (no voicemail, no caller ack) and tear down.
  /// Returns true if it actually yielded a receptionist session.
  Future<bool> yieldReceptionistToOwner() async {
    final r = _receptionist;
    if (r == null || _ended) return false;
    try { await r.yieldToOwner(); } catch (_) {}
    // The receptionist's done future normally ends the session; end it directly
    // here too so the accept path can proceed deterministically without waiting.
    if (!_ended) await hangup('owner-answered-yield');
    return true;
  }

  /// [CALL-EXCL-1] End this call leg QUIETLY before the device accepts another
  /// call: send a proper `bye` to the peer (NOT a busy) and tear down, without
  /// touching navigation (the accept path drives the UI). Distinct from the busy
  /// path — the peer sees a clean hangup, not a busy dead-end.
  Future<void> endQuiet(String reason) async {
    if (_ended) return;
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
    if (config.seed.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {
        'to': config.seed, 'callId': config.room, 'status': 'ended',
      }).ignore();
    }
    Analytics.capture('call_ended_for_accept', {
      'call_id': config.room,
      'reason': reason,
    });
    await hangup(reason);
  }

  Future<void> _onNoAnswer() async {
    // [AVA-RING-BLEED-1] A stale no-answer timer firing while Ava is live must
    // not end the call under her ("no-answer"/timeout-ringing mid-voicemail).
    if (_receptionistActive || _receptionist != null || _avaCountingDown) return;
    _ringback.stop();
    if (!config.video && !_ended) {
      // UNREACHABLE-AVA-1 (owner decision 2026-07-07): when the callee's phone is
      // off / has no data (_callUnreachable), Ava still takes the message — with
      // the honest "phone is off or unreachable, can I take a message?" script.
      final started = await _tryReceptionist(
          activationMode: _callUnreachable
              ? 'unreachable'
              : (_receptMode == 'first_ring' ? 'first_ring' : 'rings'));
      if (started) return;
    }
    if (!_ended && !_connected) _endWith('no-answer', reason: 'timeout-ringing');
  }

  Future<void> _onBusy() async {
    if (_ended || _connected) return;
    // [CALL-DUP-SESSION-1] Self-inflicted-busy immunity. A 'busy' that lands on a
    // DUPLICATE/non-primary leg (this session is NOT the one connected, but
    // another live session for the same room IS connected/answered on this
    // device) is the room's 2-peer cap rejecting OUR OWN extra leg — NOT the
    // remote callee being busy. Honouring it here used to trigger the
    // receptionist + a cancel/ended fan-out that destroyed the genuine live call
    // (PostHog avatok-cdcc815d / avatok-23692246). Ignore it and let this
    // duplicate leg wither without side effects.
    if (_anotherOwns) {
      Analytics.capture('call_self_busy_ignored', {
        'call_id': config.room,
        'reason': 'another_live_session_owns_room',
      });
      return;
    }
    _ringTimeout?.cancel();
    _ringback.stop();
    Analytics.capture('call_busy_received', {
      'call_id': config.room,
      'recept_mode': _receptMode,
      'video': config.video,
    });
    // [BUSY-CARD-1] Personalized busy card. When the server told us WHY the callee
    // is busy (busy_reason present) AND the client kill switch is on, show the
    // warm card (§3.1) and let the caller CHOOSE — Ava never auto-engages on a
    // busy call (§3.0: busy ≠ no-answer). We do NOT auto-start the receptionist
    // here in that case; that only happens if they tap "Leave a message for Ava".
    // When there is no busy_reason (old server / kill switch off) we fall through
    // to the UNCHANGED legacy behaviour below.
    if (_showBusyCard) {
      // Terminal 'busy' phase renders the card in the view; keep the session
      // alive (no teardown / auto-pop) so the user can act on the buttons.
      _setPhase('busy');
      _logBusyCardShown();
      // Safety: an abandoned busy card must not hold the mic/session forever.
      // If the user neither acts nor navigates within 60s, end cleanly. (Any
      // button tap that hands off/ends cancels this via _teardown / _endWith.)
      _busyCardTimeout?.cancel();
      _busyCardTimeout = Timer(const Duration(seconds: 60), () {
        if (!_ended && _phase == 'busy' && !_receptionistActive) {
          Analytics.capture('busy_card_cancelled', {
            'call_id': config.room,
            'busy_reason': _busyReason ?? '',
            'reason': 'timeout',
          });
          _endWith('ended', reason: 'busy-card-timeout');
        }
      });
      return;
    }
    if (!config.video) {
      final started = await _tryReceptionist(
          activationMode: _receptMode == 'first_ring' ? 'first_ring' : 'rings');
      if (started) return;
    }
    if (!_connected && !_ended) _endWith('busy', reason: 'busy');
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  [BUSY-CARD-1] Personalized busy card — state + actions (Specs §3.1)
  // ─────────────────────────────────────────────────────────────────────────

  /// True only when the server gave us a busy_reason AND the client kill switch
  /// is on. This is the FIELD gate that keeps the card off for old servers. The
  /// card renders on the audio call screen (§3.1); video busy calls keep the
  /// legacy busy line (no card surface in the video layout).
  bool get _showBusyCard =>
      !config.video &&
      (_busyReason != null && _busyReason!.isNotEmpty) &&
      RemoteConfig.busyCardEnabled;

  /// View-facing accessors (read by CallScreen when uiPhase == 'busy').
  bool get showBusyCard => _showBusyCard && _phase == 'busy';
  String? get busyReason => _busyReason;
  bool get busyReceptionistEnabled => _busyReceptionistEnabled;
  String get busyPronoun => _busyPronoun;
  bool get busyNotifyInFlight => _busyNotifyInFlight;
  bool get busyNotifyRegistered => _busyNotifyRegistered;

  void _logBusyCardShown() {
    if (_busyCardShownLogged) return;
    _busyCardShownLogged = true;
    Analytics.capture('busy_card_shown', {
      'call_id': config.room,
      'busy_reason': _busyReason ?? '',
      'receptionist_enabled': _busyReceptionistEnabled,
    });
    Analytics.capture('busy_receptionist_offered', {
      'call_id': config.room,
      'busy_reason': _busyReason ?? '',
    });
  }

  void _logBusyButtonTapped(String button) {
    Analytics.capture('busy_card_button_tapped', {
      'call_id': config.room,
      'button': button,
      'busy_reason': _busyReason ?? '',
    });
  }

  /// Cancel → dismiss/end the busy card (no ring, no second leg). §3.1 (1).
  void busyCancel() {
    _logBusyButtonTapped('cancel');
    Analytics.capture('busy_card_cancelled', {
      'call_id': config.room,
      'busy_reason': _busyReason ?? '',
    });
    Analytics.capture('busy_receptionist_declined', {
      'call_id': config.room,
      'button': 'cancel',
    });
    if (!_ended) _endWith('ended', reason: 'busy-card-cancel');
  }

  /// Notify me → register the caller in the callee's authority waiter list so a
  /// "now free" FCM fires when the callee returns to idle. §3.1 (2). Degrades
  /// gracefully: a 404 (endpoint not deployed yet) still shows the confirmed
  /// state locally so the button never dead-ends.
  Future<void> busyNotifyMe() async {
    if (_busyNotifyInFlight || _busyNotifyRegistered) return;
    _logBusyButtonTapped('notify_me');
    _busyNotifyInFlight = true;
    _bump();
    final ok = await _registerNowFreeWaiter();
    _busyNotifyInFlight = false;
    _busyNotifyRegistered = true; // confirmed locally regardless of server state
    _bump();
    Analytics.capture('busy_notify_registered', {
      'call_id': config.room,
      'busy_reason': _busyReason ?? '',
      'server_ok': ok,
    });
    Analytics.capture('busy_receptionist_declined', {
      'call_id': config.room,
      'button': 'notify',
    });
  }

  /// POST the notify-register request to the server. ASSUMED shape (reconcile
  /// with the server agent): POST /api/call/notify-register
  /// {callee_uid, caller_uid, call_id}. Any non-2xx / throw → false (degrade).
  Future<bool> _registerNowFreeWaiter() async {
    try {
      final r = await ApiAuth.postJson(
        'https://$kSignalingHost/api/call/notify-register',
        {
          'callee_uid': config.seed,
          'caller_uid': _mySeed,
          'call_id': config.room,
        },
      );
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false; // endpoint missing / offline → still confirm locally
    }
  }

  /// Leave a message for Ava → start a receptionist voicemail session to the
  /// callee with activation_mode='busy'. Reuses the exact no-answer receptionist
  /// path, just tagged 'busy' so Ava's script is the busy variant. §3.1 (3).
  Future<void> busyLeaveMessage() async {
    _logBusyButtonTapped('leave_message');
    Analytics.capture('busy_leave_message_selected', {
      'call_id': config.room,
      'busy_reason': _busyReason ?? '',
      'language': '',
    });
    Analytics.capture('busy_receptionist_started', {
      'call_id': config.room,
      'trigger': 'leave_message_button',
    });
    if (_ended || config.video) {
      // Video calls never route to voicemail — just end cleanly.
      if (!_ended) _endWith('ended', reason: 'busy-card-leave-video');
      return;
    }
    final started = await _tryReceptionist(activationMode: 'busy');
    if (!started && !_connected && !_ended) {
      _endWith('receptionist-unavailable', reason: 'busy-receptionist-unavailable');
    }
  }

  Future<void> _probeReceptionist() async {
    try {
      final cfg = await ReceptionistApi.configFor(config.seed);
      if (_connected || _ended || cfg == null) return;
      _receptMode = (cfg['mode'] ?? 'rings').toString();
      _receptRings = (cfg['rings'] as num?)?.toInt() ?? 5;
      final Duration window = _receptMode == 'first_ring'
          ? const Duration(seconds: 6)
          : Duration(seconds: (_receptRings * 5).clamp(20, 45));
      _armNoAnswerWindow(window);
    } catch (_) {}
  }

  void _armNoAnswerWindow(Duration window) {
    if (!_takeoverGuard) { _startRingWindow(window); return; }
    _pendingRingWindow = window;
    if (_deviceRinging) {
      _startRingWindow(window);
      return;
    }
    // [CALL-RINGACK-EXTEND-1] Apply a stored ack of EITHER polarity. Previously an
    // ok=true ack that arrived before the receptionist probe resolved was silently
    // dropped here, so the 6s _deviceRingingTimer stayed armed and declared the
    // callee unreachable even though the push had verifiably left the building.
    if (_pendingAckResult != null) {
      _applyRingAck(_pendingAckResult!);
      return;
    }
    _ringAckHandled = false;
    _ringAckFallback?.cancel();
    _ringAckFallback = Timer(const Duration(seconds: 5), () {
      if (_ringAckHandled || _connected || _ended || _deviceRinging) return;
      _ringAckHandled = true;
      Analytics.capture('call_ring_ack', {'call_id': config.room, 'source': 'fallback'});
      _onDeviceRinging();
    });
  }

  void _startRingWindow(Duration window) {
    // [AVA-RING-BLEED-1] Never (re)arm a no-answer window once Ava owns the call —
    // its _onNoAnswer would tear down the live receptionist session.
    if (_receptionistActive || _receptionist != null || _avaCountingDown) return;
    _ringTimeout?.cancel();
    _ringTimeout = Timer(window, () { if (!_ended && !_connected) _onNoAnswer(); });
  }

  void _onRingAck(bool ok) {
    if (!_takeoverGuard || _connected || _ended) return;
    if (_pendingRingWindow == null) { _pendingAckResult = ok; return; }
    _applyRingAck(ok);
  }

  void _applyRingAck(bool ok) {
    if (_ringAckHandled) return;
    if (ok) {
      // [CALL-RINGACK-EXTEND-1] (2026-07-08 "everyone gets Ava" incident) Push sent
      // successfully — the ring push verifiably left the building, so the callee
      // must get the FULL ring window (config.ts receptTakeoverGuard contract:
      // "ok:true → give the callee the full ring window"). Previously we only
      // cancelled the fallback and left the 6s _deviceRingingTimer armed; FCM
      // delivery routinely takes 8-15s, so callers were handed to the Ava
      // receptionist BEFORE the callee's phone ever rang, even with both users
      // online (PostHog: ring_ack ok=true at ~4s, call_cancel_sent at ~6s,
      // callee's call_incoming_* only at ~12s). The device-ringing receipt still
      // refines phase/ringback when it arrives; only ok=false fast-fails to Ava.
      _ringAckFallback?.cancel();
      _deviceRingingTimer?.cancel();
      if (!_deviceRinging) {
        _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 25));
        // [DIAL-NARRATION-1] The push verifiably reached the network — narrate it.
        _setDialStage("Found $_peerFirst! Waking the phone up…");
      }
      Analytics.capture('call_ring_ack',
          {'call_id': config.room, 'ok': ok, 'source': 'server', 'window_extended': true});
      return;
    }
    _ringAckHandled = true;
    _ringAckFallback?.cancel();
    _deviceRingingTimer?.cancel();
    Analytics.capture('call_ring_ack', {'call_id': config.room, 'ok': ok, 'source': 'server'});
    if (!_connected) {
      _ringback.stop();
      _callUnreachable = true;
      _unreachableNotice?.call();
      _onNoAnswer();
    }
  }

  void _onDeviceRinging() {
    if (_connected || _ended) return;
    if (_deviceRinging) return;
    // [AVA-RING-BLEED-1] (2026-07-08): the device-ringing receipt can straggle in
    // over FCM 10-30s late — AFTER the Ava handoff. Without this guard it
    // restarted ringback OVER Ava's voice ("I could hear the ring in the
    // background while Ava took my message"), reset phase to 'ringing', and
    // re-armed a ring window whose _onNoAnswer would then kill the live Ava
    // session. Once Ava owns the call, late ring signals are noise.
    if (_receptionistActive || _receptionist != null || _avaCountingDown) {
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'device_ringing', 'call_id': config.room});
      return;
    }
    _deviceRinging = true;
    _deviceRingingTimer?.cancel();
    _ringAckFallback?.cancel();

    AvaLog.I.log('call', 'Device ringing receipted.');

    // [DIAL-NARRATION-1] The phone is genuinely ringing — say so with delight,
    // then settle into the classic 'Ringing…' after a few seconds.
    _dialStage = "Ah — it's ringing!";
    for (final t in _dialStageTimers) { t.cancel(); }
    _dialStageTimers.clear();
    _dialStageTimers.add(Timer(const Duration(seconds: 4), () {
      if (_ended || _connected) return;
      _dialStage = null;
      _bump();
    }));
    _setPhase('ringing');

    if (RemoteConfig.ringbackEnabled) {
      // ignore: unawaited_futures
      _ringback.playRingback(config.ringbackUrl);
      Analytics.capture('ringback_played_on_receipt', {
        'source': config.ringbackUrl.isEmpty ? 'default' : 'custom',
        'video': config.video,
        'call_id': config.room,
      });
    }

    _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 25));
  }

  Future<void> _handoffToAva(String activationMode) async {
    _ringback.stop();
    final started = await _tryReceptionist(activationMode: activationMode);
    if (!started && !_connected) {
      // [RECEPT-START-409-1] A 409 reattach_blocked means Ava is ALREADY live on
      // another leg of this exact call — ending with "Couldn't reach Ava" here was
      // a lie (the message IS being taken). End this duplicate leg quietly.
      if (_receptFailReason == 'reattach_blocked') {
        _endWith('ended', reason: 'recept-reattach-noop');
      } else {
        _endWith('declined', reason: 'receptionist-unavailable');
      }
    }
  }

  Future<bool> _tryReceptionist({String activationMode = 'rings'}) async {
    if (_connected) {
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'connected_race', 'call_id': config.room});
      return false;
    }
    // [CALL-DUP-SESSION-1] A duplicate/non-primary leg for a room another live
    // session owns must NEVER start the receptionist — doing so would send a
    // 'bye'/cancel over the shared room and hand the caller to Ava mid-call,
    // killing the genuine connected call. Refuse without side effects.
    if (_anotherOwns) {
      Analytics.capture('ava_recept_suppressed_dup_session', {'call_id': config.room});
      return false;
    }
    if (_receptionistActive || _receptionist != null || _avaCountingDown) {
      Analytics.capture('ava_recept_reattach_blocked', {
        'call_id': config.room,
        'activation_mode': activationMode,
        'stage': 'client',
        'reason': _receptionist != null
            ? 'session_live'
            : (_avaCountingDown ? 'countdown' : 'already_committed'),
      });
      return true;
    }
    _receptionistActive = true;
    try {
      _send({'type': 'bye'});
      try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      _notifyCalleeCanceled();

      final call = ReceptionistCall(
          calleeUid: config.seed, callId: config.room, activationMode: activationMode,
          speaker: _speaker, teamId: config.teamId, teamSlot: config.teamSlot);
      call.onStatus = (s) {
        if (_ended || _avaCountingDown) return;
        switch (s) {
          case 'connecting':
            // [AVA-CLIENT-1] WS is dialing — honest "Connecting you to Ava…".
            // Do NOT jump to the confident line yet; the ava-live gate does that.
            _setPhase('receptionist-connecting');
            break;
          case 'connected':
            // [AVA-CLIENT-1] The socket connected + mic opened, but the ENGINE
            // may still fail to start / never speak. This is exactly the
            // start_failed/unavailable window. Stay 'receptionist-connecting'
            // and arm the ava-live watchdog; only a real ava-live ack (first
            // audio via avaLevel, or a wrapup) opens the gate to 'receptionist'.
            if (!_avaLiveGateOpen) {
              _setPhase('receptionist-connecting');
              _armAvaLiveWatchdog(call);
            }
            break;
          case 'live':
            // [AVA-CLIENT-1] Explicit first-audio ack from ReceptionistCall (its
            // first inbound Ava audio frame). Deterministic proof Ava is speaking —
            // open the gate immediately instead of waiting for the avaLevel meter to
            // cross its threshold before the watchdog fires. This is what fixes the
            // unreachable-mode race where a genuinely-live Ava got dropped as
            // 'ava_live_timeout' (AVA-RECEPT-UNREACHABLE-WATCHDOG-RACE).
            _openAvaLiveGate();
            break;
          case 'wrapup':
            // Ava reached her soft-cap → she is unambiguously live: open the
            // gate (if not already) then show the wrap-up line.
            _openAvaLiveGate();
            _setPhase('receptionist-wrapup');
            break;
          default:
            break;
        }
      };
      _avaCountingDown = true;
      call.beginHold();
      final startFut = call.start();
      await _runAvaCountdown();
      final ok = await startFut;
      _avaCountingDown = false;
      if (!ok) {
        // [RECEPT-START-409-1] Keep the server's refusal reason so the caller
        // surface can distinguish "another leg already owns Ava for this call"
        // (benign 409 reattach) from a genuine receptionist outage.
        _receptFailReason = call.failReason;
        return false;
      }
      _receptionist = call;
      // [RECEPT-CALLBACK-PREEMPT-1] Publish the receptionist's target (the
      // callee whose Ava we're now talking to) so an incoming callback FROM
      // that exact person can be recognized and let through to ring instead
      // of being auto-busied. Cleared in _teardown.
      if (config.seed.isNotEmpty) gReceptionistTargetPub = config.seed;
      // [AVA-CLIENT-1] The engine reports "connected" (WS + mic up), but we do
      // NOT yet claim "Ava is taking your call". Hold at 'receptionist-connecting'
      // and let the ava-live gate flip us to 'receptionist' when Ava is truly
      // live (first audio / ready ack). If the gate already opened during the
      // countdown, honour it; otherwise arm the watchdog now.
      if (_avaLiveGateOpen) {
        _setPhase('receptionist');
      } else {
        _setPhase('receptionist-connecting');
        _armAvaLiveWatchdog(call);
      }
      call.release();
      call.done.then((_) {
        if (!_ended) _endWith('ended', reason: 'receptionist-done');
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  [AVA-CLIENT-1] ava-live ack gate + watchdog
  // ─────────────────────────────────────────────────────────────────────────

  /// Arm the ava-live watchdog for [call]. We treat the FIRST real Ava audio
  /// frame as the "ava_live" ack — observed here without touching
  /// ReceptionistCall by watching its [avaLevel] ValueNotifier (which is driven
  /// only by inbound Ava audio frames; it never rises unless Ava actually spoke).
  /// If the server later sends an explicit {type:"ready"}/{type:"ava_live"}
  /// control frame that ReceptionistCall surfaces (e.g. via a future onStatus
  /// 'live'/'ready'), [_openAvaLiveGate] can be called from there too — this
  /// path degrades gracefully and stays backward-compatible if no such frame
  /// exists yet.
  ///
  /// Timeline: on entering 'receptionist-connecting' we wait [_avaLiveTimeoutMs]
  /// (~4s). No ack → retry ONCE (a second window). Still nothing → surface the
  /// honest 'receptionist-unavailable' end state instead of a frozen countdown.
  void _armAvaLiveWatchdog(ReceptionistCall call) {
    if (_ended || _avaLiveGateOpen) return;
    // Already waiting on this attempt — don't re-arm / double-count.
    if (_avaLiveConnecting && _avaLiveWatchdog != null) return;
    _avaLiveConnecting = true;
    if (_avaLiveAttempt == 0) {
      _avaLiveAttempt = 1;
      _avaLiveConnectAtMs = DateTime.now().millisecondsSinceEpoch;
    }
    // Attach the avaLevel listener once — first non-trivial level = first audio.
    if (_avaLevelListener == null) {
      _avaLevelListener = () {
        if (_ended || _avaLiveGateOpen) return;
        if (call.avaLevel.value > 0.02) _openAvaLiveGate();
      };
      call.avaLevel.addListener(_avaLevelListener!);
      _avaLevelSource = call;
      // Guard the race where audio already arrived before we attached.
      if (call.avaLevel.value > 0.02) { _openAvaLiveGate(); return; }
    }
    _avaLiveWatchdog?.cancel();
    _avaLiveWatchdog = Timer(
        const Duration(milliseconds: _avaLiveTimeoutMs), () => _onAvaLiveTimeout(call));
  }

  /// The ava-live ack arrived (first Ava audio / ready frame). Open the gate:
  /// flip the confident "Ava is taking your call" status and stop the watchdog.
  void _openAvaLiveGate() {
    if (_avaLiveGateOpen || _ended) return;
    _avaLiveGateOpen = true;
    _avaLiveConnecting = false;
    _avaLiveWatchdog?.cancel();
    _avaLiveWatchdog = null;
    final delay = _avaLiveConnectAtMs > 0
        ? DateTime.now().millisecondsSinceEpoch - _avaLiveConnectAtMs
        : 0;
    Analytics.capture('ava_ready_gate_opened', {
      'call_id': config.room,
      'announcement_delay_ms': delay,
      'attempt': _avaLiveAttempt,
    });
    // Only advance the label if we're still in a receptionist-connecting state
    // (don't stomp a wrapup/ended phase that may have raced in).
    if (_phase == 'receptionist-connecting') _setPhase('receptionist');
  }

  /// No ava-live ack within the window. Retry once; on the second miss surface
  /// an honest fallback instead of a frozen "taking your call" with dead air.
  void _onAvaLiveTimeout(ReceptionistCall call) {
    if (_ended || _avaLiveGateOpen) return;
    Analytics.capture('ava_live_timeout', {
      'call_id': config.room,
      'timeout_ms': _avaLiveTimeoutMs,
      'attempt': _avaLiveAttempt,
      'reason': 'no_ava_live_ack',
    });
    if (_avaLiveAttempt < 2) {
      // Single retry: give Ava one more ~4s window. (We cannot restart the
      // inner engine from here without touching receptionist_call.dart; the
      // retry re-arms the same session's ack wait — Ava may simply have been
      // slow to produce first audio.)
      _avaLiveAttempt = 2;
      Analytics.capture('ava_live_retry', {
        'call_id': config.room,
        'attempt': _avaLiveAttempt,
        'reason': 'no_ava_live_ack',
      });
      _avaLiveWatchdog?.cancel();
      _avaLiveWatchdog = Timer(
          const Duration(milliseconds: _avaLiveTimeoutMs), () => _onAvaLiveTimeout(call));
      return;
    }
    // Second miss → honest failure. Do not sit on a fake countdown/dead air.
    Analytics.capture('ava_recept_skipped', {
      'call_id': config.room,
      'reason': 'ava_live_timeout',
      'activation_mode': call.activationMode,
    });
    _clearAvaLiveGate();
    if (!_ended && !_connected) {
      _endWith('receptionist-unavailable', reason: 'ava-live-timeout');
    }
  }

  /// Detach the avaLevel listener + cancel the watchdog. Safe to call repeatedly.
  void _clearAvaLiveGate() {
    _avaLiveWatchdog?.cancel();
    _avaLiveWatchdog = null;
    _avaLiveConnecting = false;
    final l = _avaLevelListener;
    if (l != null) {
      try { _avaLevelSource?.avaLevel.removeListener(l); } catch (_) {}
      _avaLevelListener = null;
      _avaLevelSource = null;
    }
  }

  Future<void> _runAvaCountdown() async {
    for (var n = 3; n >= 1; n--) {
      if (_ended) return;
      _avaCount = n;
      _setPhase('ava-countdown');
      await Future<void>.delayed(const Duration(seconds: 1));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  TEARDOWN — the single destroy path
  // ─────────────────────────────────────────────────────────────────────────

  /// The ONLY method that destroys resources. Idempotent. Every end path routes
  /// here. [reason] feeds the telemetry taxonomy. Sets phase to ended.
  Future<void> hangup(String reason) async {
    if (_ended) {
      // Ensure terminal phase even on a repeat call.
      phase.value = CallPhase.ended;
      return;
    }
    await _teardown(reason: reason);
  }

  // CALL-UI-DEAD-1: every teardown await is time-boxed so a wedged native
  // method channel, half-dead RTCPeerConnection or dead WebSocket can never
  // hang the hangup path indefinitely. Failures/timeouts are swallowed — the
  // resources are being destroyed anyway.
  Future<void> _safeAwait(Future<void>? Function() f, {int ms = 2000}) async {
    try {
      final fut = f();
      if (fut != null) await fut.timeout(Duration(milliseconds: ms));
    } catch (_) {}
  }

  Future<void> _teardown({String? reason}) async {
    if (_ended) return;
    final sw = Stopwatch()..start();
    // [AVA-CLIENT-1] cancel the ava-live watchdog + detach the avaLevel listener
    // so nothing keeps firing after teardown (no leaked timers/listeners).
    _clearAvaLiveGate();
    // [BUSY-CARD-1] cancel the abandoned-busy-card safety timer.
    _busyCardTimeout?.cancel();
    _busyCardTimeout = null;
    try { _receptionist?.hangup(); } catch (_) {}
    try { WakelockPlus.disable(); } catch (_) {}
    await _safeAwait(() => NativeVoiceAudio().stopP2pAudioMode());
    await _safeAwait(() => NativeVoiceAudio().stopBluetoothSco());
    await _safeAwait(() => NativeVoiceAudio().stopProximitySensor());
    await _safeAwait(() => NativeVoiceAudio.instance
        .stopCallForegroundService(reason: reason ?? 'hangup'));
    await _safeAwait(() => NativeVoiceAudio().stopTelephonyMonitoring());
    _telephonySub?.cancel();
    // CALL-FOCUS-1: detach our focus callbacks so a torn-down session can't keep
    // holding/resuming after the singleton is reused by the next call.
    if (NativeVoiceAudio.instance.onAudioFocusLost != null ||
        NativeVoiceAudio.instance.onAudioFocusRegained != null) {
      NativeVoiceAudio.instance.onAudioFocusLost = null;
      NativeVoiceAudio.instance.onAudioFocusRegained = null;
    }
    _ended = true;
    if (gLiveCallScreens > 0) gLiveCallScreens--;
    gInCall = gLiveCallScreens > 0;
    if (gActiveCallId == config.room) {
      gActiveCallId = null;
      gInCallSince = 0;
    }
    if (gOutgoingCallId == config.room) {
      gOutgoingCallTo = null; gOutgoingCallId = null; gOutgoingSince = 0;
    }
    // [RECEPT-CALLBACK-PREEMPT-1] Clear the receptionist target when THIS
    // session's own receptionist leg is the one that set it (guards against
    // clobbering a different session's still-live target).
    if (config.seed.isNotEmpty && gReceptionistTargetPub == config.seed) {
      gReceptionistTargetPub = null;
    }
    // [CALL-RELSCORE-1] Hand the telemetry the session-level resilience signals it
    // can't see (mid-call reconnect attempts, forced TURN relay, callee-unreachable
    // push failure) so call_ended carries a single reliability_score + its
    // components. media_stalls + packet-loss are already tracked telemetry-side.
    final ns = netStats.value;
    _telemetry.setReliabilityInputs(
      reconnectAttempts: _reconnectAttempt,
      mediaStalls: _mediaStalls,
      relayForced: _relayForced,
      unreachable: _callUnreachable,
      // [CALL-NETHUD-1] carry the last HUD snapshot onto call_ended.
      hudUpKbps: ns.upKbps,
      hudDownKbps: ns.downKbps,
      hudRttMs: ns.rttMs,
      hudLossPct: ns.lossPct,
    );
    _telemetry.ended(reason ?? (_connected ? 'ended' : _phase));
    if (config.outgoing && !_connected) _notifyCalleeCanceled();
    _timer?.cancel();
    _ringTimeout?.cancel();
    _ringAckFallback?.cancel();
    _deviceRingingTimer?.cancel();
    for (final t in _dialStageTimers) { t.cancel(); } // [DIAL-NARRATION-1]
    _dialStageTimers.clear();
    _failTimer?.cancel();
    _wsReconnectTimer?.cancel();
    _relayFallbackTimer?.cancel();
    _placeCallTimeout?.cancel();
    _netSub?.cancel();
    _statusSub?.cancel();
    // CALL-RC-D2: cancel every reconnect/ping timer so nothing keeps firing
    // after teardown (acceptance criterion — no leaked timers post-hangup).
    _reconnecting = false;
    _reconnectRetryTimer?.cancel();
    _reconnectGiveUpTimer?.cancel();
    _stopPingTimer();
    // [CALL-MEDIA-WATCH-1]
    _stopMediaWatchdog();
    await _safeAwait(() => FlutterCallkitIncoming.endCall(config.room));
    try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    await _safeAwait(() => _pc?.close(), ms: 3000);
    await _safeAwait(() => _ws?.sink.close());
    try { localRenderer.srcObject = null; } catch (_) {}
    try { remoteRenderer.srcObject = null; } catch (_) {}
    await _safeAwait(() => _stream?.dispose());
    _stream = null;
    _pc = null;
    _ringback.dispose();
    phase.value = CallPhase.ended;
    // Dispose the renderers (they are owned by the session, not any view).
    await _safeAwait(() => localRenderer.dispose());
    await _safeAwait(() => remoteRenderer.dispose());
    if (sw.elapsedMilliseconds > 5000) {
      Analytics.capture('call_teardown_slow', {
        'call_id': config.room,
        'ms': sw.elapsedMilliseconds,
        'reason': reason ?? 'hangup',
      });
    }
    // [TRACE-ID-1] Stop stamping this call's trace on subsequent (non-call) events
    // once the call is fully torn down — but only if it's still ours (a newer
    // action may already have taken the global).
    if (Analytics.currentTraceId == _traceId) Analytics.currentTraceId = null;
    _bump();
  }

  bool get isReceptDuo =>
      _phase == 'receptionist' ||
      _phase == 'receptionist-connecting' ||
      _phase == 'receptionist-wrapup';

  String get statusText => switch (_phase) {
        // [DIAL-NARRATION-1] Fresh device-ringing shows the delighted line once,
        // then settles into the classic 'Ringing…'.
        'ringing' => _dialStage ?? 'Ringing…',
        'connected' => _onCellularHold ? 'On hold — cellular call' : 'Connected · end-to-end encrypted',
        'declined' => 'Call declined',
        'busy' => 'User is busy',
        'no-answer' => 'No answer',
        // [CALL-DIAL-FAIL-1]
        'network-error' => "Can't reach the network — check your connection",
        'ava-countdown' => "$_peerFirst isn't picking up — Ava is taking your call…",
        'receptionist-connecting' => 'Connecting you to Ava…',
        'receptionist' => 'Ava is taking a message',
        'receptionist-wrapup' => 'Ava is wrapping up…',
        // [AVA-CLIENT-1] honest fallback when Ava never went live (ack timeout /
        // engine start_failed) — never a frozen countdown with dead air.
        'receptionist-unavailable' => "Couldn't reach Ava — try again",
        'reconnecting' => 'Reconnecting…',
        'ended' => 'Call ended',
        // [DIAL-NARRATION-1] connecting: the live narration line when we have one.
        _ => _dialStage ?? 'Connecting…',
      };
}
