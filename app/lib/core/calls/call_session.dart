import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:crypto/crypto.dart' show sha1; // [CALL-RESTORE-1] stable peer id
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
  /// [DIALPAD-BIZ-CALLS Phase C] true = this call was placed through the
  /// business (dialpad) channel (place_1to1_call.dart, via:'dialpad'). While
  /// RemoteConfig.businessCallUx is on, business OUTGOING AUDIO calls use the
  /// plan-§3 after-ring flow (NoAnswerCard → voicemail / Ava AI agent) INSTEAD
  /// of the generic call-outcome menu — otherwise the menu pre-empts the
  /// 'no-answer' phase and the WP3 routing probe never runs.
  final bool business;
  /// [INSTANT-CALL-MOUNT-1] true = the launch site mounted the call screen
  /// OPTIMISTICALLY (the instant the user tapped), BEFORE the POST /api/call
  /// round-trip resolved, so tapping the call icon feels instant. In this mode
  /// the session MUST behave honestly like ring-ack guard mode: start in
  /// 'connecting' with a searching tone (NEVER a fake ringback), and gate the
  /// ring window on the placement result the launch site feeds back via
  /// [CallSession.notePlaceResult] / [CallSession.notePlaceFailed]. This reuses
  /// the exact `_takeoverGuard` machinery so an unreachable/failed callee never
  /// hears ringback into the void ([MULTIACCT-4] guarantee is preserved even
  /// when RemoteConfig.receptTakeoverGuard is off).
  final bool deferRing;
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
    this.business = false,
    this.deferRing = false,
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
  /// Our peer id in the CallRoom DO (the `?id=` on the signalling socket, which
  /// the DO stores as the hibernation tag).
  ///
  /// [CALL-RESTORE-1 2026-07-14] Seeded random, then UPGRADED to a value that is
  /// STABLE for (this device, this room) by [_adoptStablePeerId] before the first
  /// connect. Why that matters:
  ///
  /// `call_room.ts` already knows how to survive an app relaunch. On join it
  /// looks for existing sockets carrying the SAME peer id, closes them, and
  /// adopts the new one ("server_adopt_same_peer") — explicitly so a reconnect
  /// never counts against the strict 2-peer cap. That machinery was dead code
  /// across a restart: this id was a fresh uuid every session, so the relaunched
  /// app looked like a THIRD, unrelated peer. Its own zombie socket kept a cap
  /// slot, the peer kept signalling at the dead id, no SDP answer could arrive,
  /// and the call sat on "Connecting…" forever (2026-07-14, call avatok-622e0df2:
  /// got_sdp_answer:false, host/srflx/relay candidates all 0).
  ///
  /// Making the id reproducible turns a relaunch into an ordinary reconnect and
  /// costs no new server code.
  ///
  /// The random seed is kept as the FALLBACK rather than being removed: if the
  /// device id can't be read, a random id is merely the old behaviour, whereas a
  /// collision would be a live call hijacking another. Fail towards the old bug,
  /// never towards a worse one.
  String _myId = 'app-${const Uuid().v4().substring(0, 6)}';

  /// [CALL-RESTORE-1] Derive a per-(device, room) peer id. Must be called before
  /// the first `_connect()`; safe to call repeatedly (idempotent).
  ///
  /// Inputs deliberately chosen:
  ///  · `DeviceId` — makes the id UNIQUE PER DEVICE. Without it, two devices
  ///    signed into the same account ringing for one call would derive the same
  ///    id and adopt-and-close each other's sockets.
  ///  · `config.room` — scopes the id to ONE call, so the id cannot leak between
  ///    concurrent or consecutive calls.
  ///  · `config.outgoing` — the two ends of a call are on the same room but
  ///    opposite directions; including it guarantees caller and callee differ
  ///    even in the impossible case of one device calling itself.
  Future<void> _adoptStablePeerId() async {
    if (_stablePeerIdAdopted) return;
    _stablePeerIdAdopted = true;
    try {
      final deviceId = await DeviceId.get();
      if (deviceId.isEmpty) return; // keep the random fallback
      final seed = '$deviceId|${config.room}|${config.outgoing ? 'c' : 'r'}';
      // Truncated SHA-1 → 10 hex chars. Not security-sensitive (the DO trusts the
      // room id, not this tag); it only needs to be stable and collision-free
      // within a room.
      final digest = sha1.convert(utf8.encode(seed)).toString().substring(0, 10);
      _myId = 'app-$digest';
    } catch (_) {/* keep the random fallback — see the doc above */}
  }

  bool _stablePeerIdAdopted = false;

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
  String? _lastAudioRouteRequestId;
  bool _connected = false;
  String _phase = 'connecting';
  Timer? _ringTimeout;
  /// [CALL-CONNECT-WATCHDOG-1] Direction-agnostic backstop against an infinite
  /// "Connecting…". Armed in [start], cancelled on connect and in [_teardown].
  Timer? _connectWatchdog;
  /// [AVACALL-WATCHDOG-2] FAST connect-timeout for the accepted (callee) side.
  /// The 45s [_connectWatchdog] above is the last-resort backstop, but a callee
  /// who accepted a call whose caller had ALREADY cancelled (2026-07-20 incident)
  /// has no peer to ever answer — making them wait the full 45s on "connecting"
  /// is dishonest. This shorter timer ends such a call at ~10s when we are
  /// incoming/accepted and have seen NO peer AND no SDP answer. Same skip-guards
  /// as the 45s timer (Ava/menu/agent own long-lived non-connected states).
  Timer? _connectWatchdogFast;
  final RingbackPlayer _ringback = RingbackPlayer();
  ReceptionistCall? _receptionist;
  bool _receptionistActive = false;
  // [RECEPT-SETTINGS-1] The free AvaTOK↔AvaTOK auto-voicemail leg was removed with
  // the voicemail feature. A no-answer AvaTOK audio call with no active AI
  // receptionist now ends as an honest no-answer instead of recording a voicemail.
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
  // [AVACALL-SET-2] WS3 caller-authoritative call-handling prefs, read from the
  // callee's dial-time /config probe (_probeReceptionist). Owner decision (WS3):
  //  - _calleeAiReceptionist: the callee turned the AI Receptionist ON, so Ava
  //    should take over an unanswered call (AvaTOK + PSTN).
  //  - _calleePstnVoicemail: the callee turned PSTN Voicemail ON (cell calls only;
  //    the free AvaTOK↔AvaTOK voicemail is separate + always available).
  // Both DEFAULT TRUE here as a *legacy-compat fallback only*: they stay true when
  // the probe never ran or an older worker omits the keys, preserving the prior
  // always-on behavior; an explicit `false` from a newer worker is authoritative
  // and routes the no-answer flow to voicemail (or an honest end) instead of Ava.
  bool _calleeAiReceptionist = true;
  bool _calleePstnVoicemail = true;
  // True once the probe actually delivered the WS3 keys, so we only *enforce* the
  // pref (skip the receptionist) when the callee's real setting is known.
  bool _calleePrefsKnown = false;
  // [AVARECEPT-LANES-1] (owner 2026-07-21) per-LANE + per-SCENARIO receptionist
  // prefs from the callee's /config probe. Voicemail is retired; the AI
  // receptionist auto-activates only when the callee's AvaTOK lane is ON AND the
  // matching scenario (missed/rejected/unreachable) is ON. ALL DEFAULT OFF
  // (opt-in). `_calleeLanesKnown` is true once the probe delivered the new keys;
  // until then the code falls back to the legacy `_calleeAiReceptionist` path so
  // an older worker never regresses. The PSTN lane is intentionally NOT read here
  // — the PSTN no-answer route is decided server-side in pstn.ts.
  bool _calleeLanesKnown = false;
  bool _calleeReceptAvatok = false;
  bool _calleeReceptMissed = false;
  bool _calleeReceptRejected = false;
  bool _calleeReceptUnreachable = false;
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
  // [CALL-TELEMETRY-1 2026-07-14] Setup-stage markers threaded onto call_ended /
  // never_connected so a failed setup names the stage it died at without logs:
  // ring ack outcome (null = never arrived), and whether an SDP answer landed.
  bool? _ringAckOk;
  bool _gotSdpAnswer = false;
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
        _telemetry.mediaFlowState(
          state: 'rtp_stalled',
          inboundAudioBytesDelta: inboundAudioBytes - prev,
        );
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
        _telemetry.mediaFlowState(
          state: prev == null ? 'rtp_observed' : 'rtp_flowing',
          inboundAudioBytesDelta: prev == null ? null : inboundAudioBytes - prev,
        );
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
    } catch (e, st) {
      // Never let watchdog polling throw or keep a call alive, but make the
      // failure a grouped handled PostHog issue so broken stats providers are
      // distinguishable from a genuinely bad media path.
      _telemetry.runtimeError(
        stage: 'media_stats_poll_failed',
        error: e,
        stack: st,
      );
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
    // [CALL-RESTORE-1] Derive the stable per-(device, room) peer id BEFORE any
    // code path can open the signalling socket — the id is baked into the `?id=`
    // query and becomes the DO's hibernation tag, so upgrading it afterwards
    // would just create the extra zombie peer we're trying to eliminate.
    // `_bootMedia()` (which connects) is awaited at the END of this method, so
    // doing it first here is sufficient and race-free.
    await _adoptStablePeerId();
    // [AVATOK-DIAL-GUARD-1] Stamp the staleness anchor the instant the counter
    // goes 0 -> >0 (not on every start(), since re-entry into an already-live
    // session must not push the anchor forward and mask real staleness).
    if (gLiveCallScreens == 0) {
      gLiveCallScreensSince = DateTime.now().millisecondsSinceEpoch;
    }
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
    // [INSTANT-CALL-MOUNT-1] An optimistically-mounted call (screen shown before
    // the place-call POST resolved) MUST run the honest guard flow regardless of
    // the server flag: 'connecting' + searching tone, no fake ringback, ring
    // window gated on the placement result. Otherwise a guard-off prod would play
    // ringback into a callee we haven't even confirmed is reachable yet.
    _takeoverGuard = RemoteConfig.receptTakeoverGuard || config.deferRing;
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
    // [AVACALL-CANCEL-1] Honor a durable/late cancel on the ACCEPTED side BEFORE
    // painting "connecting". The 2026-07-20 incident: the caller (Tiger) pressed
    // end ~3s after dialing; the callee's ring push arrived 2s AFTER the cancel,
    // the callee accepted, and the session sat on "connecting" (connected=false,
    // got_sdp_answer=false) for 18s because the peer was already gone. The cancel
    // call-status can arrive on the broadcast `callStatusBus` BEFORE this session
    // subscribes (no replay) — so we consult the last-terminal-status cache the
    // push handler maintains, synchronously, right here.
    if (!config.outgoing && PushService.wasCallTerminated(config.room)) {
      _endPreAcceptCancelled('cache-preaccept');
      return;
    }
    // Belt-and-suspenders: also read the DURABLE (strongly-consistent) call state
    // from the server in the background — catches a cancel that was persisted but
    // not yet delivered to this device as an FCM. Fail-open; never blocks setup.
    if (!config.outgoing) {
      unawaited(_checkDurablePreAcceptCancel());
    }
    _setPhase((config.outgoing && !_takeoverGuard) ? 'ringing' : 'connecting');
    // [CALL-CONNECT-WATCHDOG-1 2026-07-14] Never sit on "Connecting…" forever.
    //
    // Every existing timeout — `_deviceRingingTimer` (12s), `_ringTimeout` (35s),
    // `_placeCallTimeout` (8s) — lives inside the `if (config.outgoing)` branch
    // below. An INCOMING call that was accepted but never established media had
    // NO deadline whatsoever: it painted 'connecting' and stayed there until the
    // user gave up and hung up by hand. That is precisely what the owner hit on
    // 2026-07-14 ("when I found it, it said connecting but took too long — I
    // disconnected it"), and the `call_ended` row proves the session was still
    // in setup: connected:false, got_sdp_answer:false, all ICE candidate counts 0.
    //
    // The trigger there was a mid-call app relaunch (see [CALL-RESTORE-1] in
    // `call_session_manager.dart`): the new process built a fresh peer connection
    // into a room whose peer was still talking to the DEAD session's `_myId`, so
    // no answer could ever arrive. But the hang is not specific to that cause —
    // ANY setup that stalls (dropped WS, peer gone, glare) produced the same
    // infinite spinner. So the watchdog is unconditional and direction-agnostic:
    // if we are not connected 45s after start, the call is not happening, and
    // saying so is strictly better than lying.
    //
    // 45s is deliberately > the 35s outgoing `_ringTimeout`, so this never
    // pre-empts the richer outgoing no-answer flow (which has its own outcome
    // menu, receptionist hand-off, etc.). It is the backstop of last resort.
    _connectWatchdog = Timer(const Duration(seconds: 45), () {
      if (_ended || _connected) return;
      // A call can legitimately live for a long time WITHOUT being connected —
      // these are outcomes, not hangs, and killing them would be a regression.
      // Mirrors `_onNoAnswer`'s guards (see [AVA-RING-BLEED-1]) plus the outcome
      // menu, which runs its own 180s timeout:
      //  · Ava receptionist is taking a message
      //  · the caller is looking at the declined/no-answer/busy outcome menu
      //  · a live agent hand-off is in progress
      final avaOwnsIt =
          _receptionistActive || _receptionist != null || _avaCountingDown;
      // `_showOutcomeMenu` parks the session in phase 'outcome-menu' with its own
      // 180s `_menuTimeout`; 'agent-handoff' is the live business hand-off.
      final menuOwnsIt = _phase == 'outcome-menu';
      if (avaOwnsIt || menuOwnsIt || _phase == 'agent-handoff') {
        Analytics.capture('call_connect_watchdog_skipped', {
          'call_id': config.room,
          'reason': avaOwnsIt
              ? 'ava_active'
              : (menuOwnsIt ? 'outcome_menu' : 'agent_handoff'),
          'phase': _phase,
        });
        return;
      }
      Analytics.capture('call_connect_watchdog_fired', {
        'call_id': config.room,
        'outgoing': config.outgoing,
        'phase': _phase,
        'device_ringing': _deviceRinging,
        'got_welcome': _gotWelcome,
        // The 2026-07-14 signature: a session that never saw its peer at all.
        'peer_seen': _peerGens.isNotEmpty,
      });
      _endWith('network-error', reason: 'connect-timeout');
    });
    // [AVACALL-WATCHDOG-2 2026-07-20] FAST connect-timeout for the accepted-but-
    // no-peer case. An incoming/accepted leg that has seen NO peer (_peerGens
    // empty) AND no SDP answer within ~10s is almost certainly answering a call
    // whose caller already cancelled (the ring push out-raced the cancel push in
    // the incident) — there is nobody on the other end to ever connect. End it
    // honestly at 10s instead of the 45s backstop. This does NOT touch the
    // outgoing / rich no-answer flow (guarded on !config.outgoing) and reuses the
    // exact same skip-guards as the 45s timer so it never pre-empts Ava / the
    // outcome menu / a live agent hand-off.
    if (!config.outgoing) {
      _connectWatchdogFast = Timer(const Duration(seconds: 10), () {
        if (_ended || _connected) return;
        // Only fire for the genuine "never saw a peer, never got an answer" case.
        if (_peerGens.isNotEmpty || _gotSdpAnswer) return;
        final avaOwnsIt =
            _receptionistActive || _receptionist != null || _avaCountingDown;
        final menuOwnsIt = _phase == 'outcome-menu';
        if (avaOwnsIt || menuOwnsIt || _phase == 'agent-handoff') {
          Analytics.capture('call_connect_watchdog_skipped', {
            'call_id': config.room,
            'reason': avaOwnsIt
                ? 'ava_active'
                : (menuOwnsIt ? 'outcome_menu' : 'agent_handoff'),
            'phase': _phase,
            'variant': 'fast-accept',
          });
          return;
        }
        Analytics.capture('call_connect_watchdog_fired', {
          'call_id': config.room,
          'outgoing': config.outgoing,
          'phase': _phase,
          'got_welcome': _gotWelcome,
          'peer_seen': _peerGens.isNotEmpty,
          'got_sdp_answer': _gotSdpAnswer,
          // Distinguishes this 10s accepted-side timeout from the 45s backstop.
          'variant': 'fast-accept',
        });
        _endWith('network-error', reason: 'connect-timeout-fast');
      });
    }
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
        // [CALL-ECHO-FIX-1] Pass the live route — RingbackPlayer applies
        // isSpeakerphoneOn to the DEVICE, so a hardcoded false would force a
        // speakerphone call back to the earpiece.
        _ringback.playRingback(config.ringbackUrl, speakerOn: _speaker);
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
        _ringback.playSearchingTone(speakerOn: _speaker);
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
        // [DIALPAD-BIZ-CALLS Phase C] Callee tapped "Send to Ava AI Agent" on
        // the incoming-business-call screen — hand this ringing leg to the
        // agent flow (routing_decision reason MANUAL_SEND_TO_AGENT, plan §13).
        if (e.status == 'decline_agent' && !_ended) {
          businessAgentHandoff('manual_send_to_agent');
          return;
        }
        // [CALL-OUTCOME-MENU-1] Declines land on the unified menu (all call
        // kinds — video simply hides Talk to Ava) instead of auto-Ava/plain end.
        if (_menuEnabled && !_ended &&
            (e.status == 'decline' || e.status == 'decline_ava')) {
          _ringTimeout?.cancel();
          _showOutcomeMenu('declined');
          return;
        }
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
          // [AVARECEPT-LANES-1] a plain reject only hands off to Ava when the callee
          // enabled the AvaTOK lane AND the 'rejected' scenario (both default OFF).
          // Otherwise it ends as an honest declined call (voicemail is retired).
          if (_receptionistAllowedFor('rejected')) {
            // ignore: unawaited_futures
            _handoffToAva('decline');
          } else {
            _endWith('declined', reason: 'decline-recept-off');
          }
          return;
        }
        _endWith(e.status == 'decline' ? 'declined' : e.status);
      }
    });
    // [AVACALL-CANCEL-1] Drain a pre-subscription cancel: the broadcast bus has no
    // replay, so a terminal status delivered between accept and the listen() above
    // would be lost. Re-check the last-terminal cache the instant we're subscribed.
    if (!config.outgoing && !_ended && PushService.wasCallTerminated(config.room)) {
      _endPreAcceptCancelled('drain-on-subscribe');
      return;
    }
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
      // [CALL-OUTCOME-MENU-1] terminal like 'busy': the view renders the menu
      // and the session stays alive for the buttons (no teardown/auto-pop).
      case 'outcome-menu':
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
      _ringback.playBusyTone(speakerOn: _speaker);
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
    } catch (e, st) {
      Analytics.error(
        domain: 'call_setup',
        code: 'media_denied',
        message: e.toString(),
        action: config.video ? 'getUserMedia_av' : 'getUserMedia_audio',
        extra: {'call_id': config.room, 'video': config.video},
      );
      _telemetry.runtimeError(
        stage: 'get_user_media_failed',
        error: e,
        stack: st,
        extra: {'video_requested': config.video},
      );
      _mediaDeniedNotice?.call();
      _endWith('ended', reason: 'media-denied');
      return;
    }
    localRenderer.srcObject = _stream;
    // [CALL-SPEAKER-RAMP 2026-07-12] Establish the communication audio session
    // (MODE_IN_COMMUNICATION + audio focus) BEFORE selecting the speaker route,
    // so the route is applied once inside an established session instead of
    // triggering a cold re-route + volume ramp at the very start of the call.
    try { await NativeVoiceAudio().startP2pAudioMode(); } catch (_) {}
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
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
    // Native audio failures used to be visible only in logcat. Keep this
    // listener on the shared singleton (the platform MethodChannel has one
    // global handler) and forward only structured, scrub-safe diagnostics.
    if (NativeVoiceAudio.isSupported) {
      NativeVoiceAudio.instance.onEvent = (event) {
        final name = (event['name'] ?? event['kind'] ?? 'unknown').toString();
        final context = <String, Object>{
          'call_id': config.room,
          'native_event': name,
          if (event['route'] != null) 'route': event['route'].toString(),
          if (event['change'] != null) 'focus_change': event['change'].toString(),
        };
        Analytics.capture('call_native_audio_event', context);
        if (name == 'audio_route_changed' && event['route'] != null) {
          Analytics.capture('call_audio_route_result', {
            ...context,
            if (_lastAudioRouteRequestId != null)
              'request_id': _lastAudioRouteRequestId!,
            'source': 'native_confirmed',
            'requested_route': _speaker ? 'speaker' : 'earpiece',
            'active_route': event['route'].toString(),
            'phase': _phase,
            'connected': _connected,
          });
        }
        final rawError = event['error'];
        if (rawError != null && rawError.toString().isNotEmpty) {
          _telemetry.runtimeError(
            stage: 'native_audio_$name',
            error: StateError(rawError.toString()),
            extra: context,
          );
        }
      };
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
  // [RECEPT-SETTINGS-1] the free-voicemail status snackbars were removed with the
  // voicemail feature.
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
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'relay_fallback_failed',
        error: e,
        stack: st,
        extra: {'remote_present': _remoteId != null},
      );
    }
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
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'video_sender_parameters_failed',
        error: e,
        stack: st,
        extra: const {'operation': 'maintain_resolution'},
      );
    }
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
        // [CALL-CONNECT-WATCHDOG-1] Media is flowing — disarm the backstop. This
        // runs BEFORE `_telemetry.connected()` sets `_connected`, hence cancel
        // rather than relying on the timer's own `_connected` guard.
        _connectWatchdog?.cancel();
        _connectWatchdogFast?.cancel(); // [AVACALL-WATCHDOG-2]
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
      _telemetry.mediaFlowState(
        state: 'transport_${s.toString().split('.').last.toLowerCase()}',
        transportState: s.toString(),
      );
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _telemetry.runtimeError(
          stage: 'pc_closed',
          error: StateError('Peer connection closed during an active call'),
          extra: {'transport_state': s.toString()},
        );
        _endWith('ended');
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
                 s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        final isFailed = s == RTCPeerConnectionState.RTCPeerConnectionStateFailed;
        final canRestart = _weOffered && _iceRestarts < 3 && _remoteId != null;
        if (isFailed && !canRestart) {
          _telemetry.runtimeError(
            stage: 'pc_failed_no_restart',
            error: StateError('Peer connection failed and no ICE restart was available'),
            extra: {
              'transport_state': s.toString(),
              'ice_restarts': _iceRestarts,
              'remote_present': _remoteId != null,
            },
          );
          _endWith('ended', reason: 'rtc-failed');
          return;
        }
        _tryIceRestart('transport-$s');
        _failTimer?.cancel();
        _failTimer = Timer(const Duration(seconds: 10), () {
          final st = _pc?.connectionState;
          if (!_ended && _connected &&
              st != RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
            _telemetry.runtimeError(
              stage: 'pc_reconnect_timeout',
              error: StateError('Peer connection did not recover within 10 seconds'),
              extra: {
                'transport_state': st.toString(),
                'restart_attempted': true,
              },
            );
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
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'ice_restart_failed',
        error: e,
        stack: st,
        extra: {'reason': why, 'restart_number': _iceRestarts},
      );
    }
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
    // [CALL-ECHO-FIX-2 2026-07-14] `config.outgoing` guard — do NOT remove.
    //
    // `_onDeviceRinging()` means "the CALLEE's phone is ringing, start playing
    // the ringback to the CALLER". It is meaningless on the answering side.
    // This used to fire for ANY frame carrying a `from` — offer, answer,
    // candidate, welcome — with no direction check. On the callee, the caller's
    // `offer` lands ~200ms before the first remote track flips `_connected`, so
    // `_connected || _ended` did not guard it either: the ANSWERING device
    // started playing a ringback at itself.
    //
    // That was not merely a cosmetic wrong-sound bug. RingbackPlayer's audio
    // context is applied device-wide (see ringback_player.dart
    // [CALL-ECHO-FIX-1]), so firing it here dragged the MODE_NORMAL / AEC-off
    // regression onto the callee too. Proof in prod telemetry 2026-07-14:
    // `ringback_played_on_receipt` at 15:14:52.543 on an INCOMING call
    // (direction:"incoming"), 200ms before `call_connected` at 15:14:52.746.
    // [FAKE-RING-HONEST-1] (2026-07-22 incident) Only a GENUINE peer signaling
    // frame proves the callee's device is actually alive on the wire. This block
    // used to fire _onDeviceRinging() (real ring narration + ringback) for ANY
    // inbound frame carrying a `from` — but server-originated frames can carry a
    // `from` too, so that manufactured a full fake ring with zero evidence the
    // callee's phone was up. On 2026-07-22 a caller heard "Ah — it's ringing!" +
    // ringback while the callee was unreachable (delivered_semantics=
    // fcm_accepted_not_device_receipt). FCM-accepted is NOT device-reached. Only
    // offer/answer/candidate come from the peer's live device; restrict to those.
    // (The explicit `case 'device-ringing':` below stays the real receipt path.)
    final String frameType = d['type']?.toString() ?? '';
    final bool isPeerSignal =
        frameType == 'offer' || frameType == 'answer' || frameType == 'candidate';
    if (config.outgoing && frameFrom.isNotEmpty && isPeerSignal) {
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
        // [CALL-TELEMETRY-1] Mark that SDP answer arrived — never_connected
        // failures split into "ring never landed" vs "answered but ICE failed".
        _gotSdpAnswer = true;
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
      case 'decline_agent':
        // [DIALPAD-BIZ-CALLS Phase C] Fast-WS "Send to Ava AI Agent" signal.
        if (_receptionistActive) break;
        if (!_connected && !_ended) businessAgentHandoff('manual_send_to_agent');
        break;
      case 'decline':
        if (_receptionistActive) break;
        // [CALL-OUTCOME-MENU-1] Fast-WS decline → unified menu (all call kinds).
        if (_menuEnabled && !_connected && !_ended) {
          _ringTimeout?.cancel();
          _showOutcomeMenu('declined');
          break;
        }
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
    final prior = _speaker;
    _speaker = !_speaker;
    final requestId = const Uuid().v4();
    _lastAudioRouteRequestId = requestId;
    speakerOn.value = _speaker;
    Analytics.capture('call_audio_route_requested', {
      'call_id': config.room,
      'request_id': requestId,
      'source': 'user_toggle',
      'requested_route': _speaker ? 'speaker' : 'earpiece',
      'prior_requested_route': prior ? 'speaker' : 'earpiece',
      'phase': _phase,
      'connected': _connected,
      'receptionist_active': _receptionistActive,
    });
    // [CALL-SPEAKER-RAMP 2026-07-12] Drive BOTH the WebRTC helper AND the native
    // engine. Helper.setSpeakerphoneOn alone flips isSpeakerphoneOn "cold", so
    // Android ramps the volume up from quiet on the communication-device switch
    // (the reported "quiet then suddenly loud" speaker/beeps bug). The native
    // setSpeaker re-asserts MODE_IN_COMMUNICATION together with the route, so the
    // switch happens inside the already-established comm session and audio comes
    // in at full call volume immediately.
    Helper.setSpeakerphoneOn(_speaker);
    if (NativeVoiceAudio.isSupported) {
      // ignore: unawaited_futures
      NativeVoiceAudio.instance.setSpeaker(_speaker);
    }
    // ignore: unawaited_futures
    _receptionist?.setSpeaker(_speaker);
  }

  /// [AVACALL-CANCEL-1] End an accepted-but-dead call cleanly: the caller had
  /// already cancelled/ended before this callee leg could establish. Reported as
  /// `call_accepted_dead` so recurrence is measurable, then ended honestly (no
  /// ghost "connecting"). [via] distinguishes the detection path.
  void _endPreAcceptCancelled(String via) {
    if (_ended) return;
    Analytics.capture('call_accepted_dead', {
      'call_id': config.room,
      'from': config.seed,
      'to': _mySeed,
      'via': via,
    });
    _endWith('ended', reason: 'remote-cancelled-preaccept');
  }

  /// [AVACALL-CANCEL-1] Background durable-state probe for the accept path. Reads
  /// the CallRoom DO's strongly-consistent status; if the call is already
  /// terminal (caller cancelled) and we haven't connected, end it. Fail-open.
  Future<void> _checkDurablePreAcceptCancel() async {
    try {
      if (_ended || _connected || config.outgoing) return;
      final status = await PushService.fetchDurableCallStatus(config.room);
      if (status != null && !_ended && !_connected && !config.outgoing) {
        _endPreAcceptCancelled('durable');
      }
    } catch (_) {/* fail-open — never block call setup on a probe */}
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
    // not end the call under her ("no-answer"/timeout-ringing).
    if (_receptionistActive || _receptionist != null || _avaCountingDown) return;
    // [DIALPAD-BIZ-CALLS Phase C] Same protection for a live agent hand-off.
    if (_phase == 'agent-handoff') return;
    // [NOANSWER-LEAVE-NOTE-1] The persistent leave-a-note card is already up
    // (this method is now its entry point) — a second stale ring/timeout firing
    // must not re-attempt the receptionist under it.
    if (_phase == 'outcome-menu') return;
    _ringback.stop();
    // [AVACALL-MENU-1 / WS4] The outcome MENU is reserved for the caller's
    // ACTIVE-refusal scenarios — an explicit decline (callStatusBus / fast-WS
    // 'decline'|'decline_ava') and busy (_onBusy) — where the callee is present
    // and chose not to pick up, so offering Call again / Message / Talk to Ava
    // makes sense. NO-ANSWER and phone-off/UNREACHABLE do NOT show the menu: they
    // fall through to the receptionist attempt and then end as an honest missed
    // call ([RECEPT-SETTINGS-1] the free auto-voicemail that used to own that
    // terminal outcome was removed with the voicemail feature).
    // [AVACALL-SET-2] WS3 precedence: only hand off to the AI receptionist when the
    // callee actually enabled it. When their prefs are UNKNOWN (probe never ran /
    // older worker) we keep the legacy always-on behavior so nothing regresses; an
    // explicit OFF from a newer worker routes straight to voicemail below. Ava
    // applies to BOTH AvaTOK and PSTN when ON.
    // [AVARECEPT-LANES-1] Per-lane + per-scenario gating (both default OFF): the
    // receptionist auto-activates only when the callee turned ON their AvaTOK lane
    // AND the matching scenario — 'unreachable' (phone off/no data) vs 'missed'
    // (rang, no answer). Legacy workers fall back to the old always-on pref.
    final receptionistAllowed = !config.video &&
        _receptionistAllowedFor(_callUnreachable ? 'unreachable' : 'missed');
    if (receptionistAllowed && !config.video && !_ended) {
      // UNREACHABLE-AVA-1 (owner decision 2026-07-07): when the callee's phone is
      // off / has no data (_callUnreachable), Ava still takes the message — with
      // the honest "phone is off or unreachable, can I take a message?" script.
      final started = await _tryReceptionist(
          activationMode: _callUnreachable
              ? 'unreachable'
              : (_receptMode == 'first_ring' ? 'first_ring' : 'rings'));
      if (started) return;
    } else if (_calleePrefsKnown && !_calleeAiReceptionist) {
      Analytics.capture('ava_recept_skipped', {
        'call_id': config.room,
        'reason': 'callee_receptionist_off',
        'business': config.business,
        // For a PSTN/business call the pre-recorded PSTN voicemail lane owns the
        // fallback when this is on; AvaTOK calls always drop to the WS2 free VM.
        'pstn_voicemail_enabled': _calleePstnVoicemail,
      });
    }
    // [NOANSWER-LEAVE-NOTE-1] No answer AND no receptionist handoff (receptionist
    // off / scenario off / start failed / unreachable / tokens exhausted) →
    // instead of ending the call as a transient "No answer" that pops after
    // ~1.4s, park in the PERSISTENT outcome card so the caller can leave a VOICE
    // or TEXT note (delivered as a normal DM), call again, save the contact, or
    // close back to the dialer. This is the ONLY terminal that reaches here — the
    // receptionist attempt above returned early when it took over. Business
    // (dialpad) calls keep their own no-answer card (businessCallUx), so they are
    // excluded here. `_showOutcomeMenu` tears down the dial leg (bye + mic
    // release) and keeps the session alive with the card; it never auto-pops.
    if (!_ended && !_connected) {
      if (!_businessFlow) {
        _showOutcomeMenu(_callUnreachable ? 'unreachable' : 'no-answer');
      } else {
        _endWith('no-answer', reason: 'timeout-ringing');
      }
    }
  }

  Future<void> _onBusy() async {
    if (_ended || _connected) return;
    // [DIALPAD-BIZ-CALLS Phase C] A racing busy must not stomp a live hand-off.
    if (_phase == 'agent-handoff') return;
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
    // [CALL-OUTCOME-MENU-1] Busy = scenario 6 of the unified menu (red "busy"
    // banner above the buttons — owner 2026-07-09). Replaces the busy card
    // while the flag is on; legacy card/behaviour untouched otherwise.
    if (_menuEnabled) {
      _showOutcomeMenu('busy');
      return;
    }
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
  //  [CALL-OUTCOME-MENU-1] Unified call outcome menu (Specs/CALL-OUTCOME-MENU-
  //  SPEC-2026-07-09.md). ONE caller-facing menu for every non-answered call —
  //  declined / no-answer / unreachable / busy — with Talk to Ava, voice note,
  //  text note (and later See Listings). Gated on RemoteConfig.callMenuEnabled:
  //  with the flag off, every legacy path is byte-for-byte unchanged (busy card,
  //  auto-Ava handoff, plain end states).
  // ─────────────────────────────────────────────────────────────────────────

  String? _menuScenario;
  Timer? _menuTimeout;

  // [DIALPAD-BIZ-CALLS Phase C] Business (dialpad) outgoing audio calls use the
  // plan-§3 after-ring flow, not the generic outcome menu (see
  // CallSessionConfig.business).
  bool get _businessFlow =>
      config.business && config.outgoing && !config.video && RemoteConfig.businessCallUx;

  bool get _menuEnabled => RemoteConfig.callMenuEnabled && !_businessFlow;

  /// View-facing: 'declined' | 'no-answer' | 'unreachable' | 'busy'.
  String? get menuScenario => _menuScenario;
  bool get showOutcomeMenu => _phase == 'outcome-menu';

  // ─────────────────────────────────────────────────────────────────────────
  //  [DIALPAD-BIZ-CALLS Phase C] Ava AI Voice Agent hand-off (plan §3 step 4,
  //  §4/§8). The session only tears down the ringing dial leg and parks in the
  //  'agent-handoff' phase — the SCREEN (call_screen.dart) owns the actual
  //  /api/call/no-answer probe + /api/agent/call/start + AgentVoiceCall bridge,
  //  mirroring how the voicemail flow already lives in the view.
  // ─────────────────────────────────────────────────────────────────────────

  /// Why the hand-off happened — the screen threads this into the
  /// /api/call/no-answer probe ('manual_send_to_agent' | 'no_answer').
  String? agentHandoffOutcome;

  /// Cancels the ring and parks this session in 'agent-handoff' so the view
  /// can bridge the caller to the callee's Ava AI agent. Falls back to the
  /// plain decline path when the business flow / voiceAgent isn't available
  /// (old-flag clients, video calls, menu-only setups).
  void businessAgentHandoff(String outcome) {
    if (_ended || _connected || _receptionistActive) return;
    if (_phase == 'agent-handoff') return;
    if (!_businessFlow || !RemoteConfig.voiceAgent) {
      // Not eligible — behave exactly like a plain decline did before.
      if (_menuEnabled) { _showOutcomeMenu('declined'); return; }
      _endWith('declined', reason: 'decline');
      return;
    }
    _ringTimeout?.cancel();
    _ringback.stop();
    // Tear down the dialing leg (stops any other callee device ringing, frees
    // the mic for the agent bridge) — same teardown _showOutcomeMenu performs.
    try { _send({'type': 'bye'}); } catch (_) {}
    try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { _pc?.close(); } catch (_) {}
    _pc = null;
    _notifyCalleeCanceled();
    agentHandoffOutcome = outcome;
    _setPhase('agent-handoff');
    Analytics.capture('agent_handoff_started', {
      'call_id': config.room, 'outcome': outcome,
    });
  }

  void _showOutcomeMenu(String scenario) {
    if (_ended || _connected || _receptionistActive) return;
    // A stale timer/status racing in must not overwrite an already-shown menu
    // (e.g. the device-ringing timer firing after a decline already landed).
    if (_phase == 'outcome-menu' || _phase == 'agent-handoff') return;
    _ringTimeout?.cancel();
    _ringback.stop();
    // Tear down the dialing leg (stops the callee's phone ringing, frees the
    // mic) — same teardown _tryReceptionist performs before handing off. The
    // menu is the caller's follow-up surface; Talk to Ava re-uses the session.
    try { _send({'type': 'bye'}); } catch (_) {}
    try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    // ignore: unawaited_futures
    try { _pc?.close(); } catch (_) {}
    _pc = null;
    _notifyCalleeCanceled();
    _menuScenario = scenario;
    _setPhase('outcome-menu');
    Analytics.capture('call_menu_shown', {
      'call_id': config.room, 'scenario': scenario, 'video': config.video,
    });
    // An abandoned menu must not hold the session forever (mirror of the busy
    // card's 60s guard, longer here because notes take time to record/type).
    _menuTimeout?.cancel();
    _menuTimeout = Timer(const Duration(seconds: 180), () {
      if (!_ended && _phase == 'outcome-menu' && !_receptionistActive) {
        Analytics.capture('call_menu_abandoned',
            {'call_id': config.room, 'scenario': scenario});
        _endWith('ended', reason: 'menu-timeout');
      }
    });
  }

  /// Menu → "Talk to Ava" (audio only; the widget hides it on video calls).
  Future<void> menuTalkToAva() async {
    if (_ended || _receptionistActive) return;
    Analytics.capture('call_menu_option_selected', {
      'call_id': config.room, 'option': 'talk_to_ava', 'scenario': _menuScenario ?? '',
    });
    _menuTimeout?.cancel();
    await _handoffToAva('menu');
  }

  /// Menu closed — by the caller, or after a note was sent successfully.
  void menuDismiss({String reason = 'menu-dismissed'}) {
    if (_ended) return;
    _menuTimeout?.cancel();
    _endWith('ended', reason: reason);
  }

  /// The widget logs option taps that it handles itself (notes).
  void menuLogOption(String option) {
    Analytics.capture('call_menu_option_selected', {
      'call_id': config.room, 'option': option, 'scenario': _menuScenario ?? '',
    });
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
      // [AVACALL-SET-2] WS3 caller-authoritative prefs. Only enforce them when the
      // worker actually sent the keys (older workers omit them → legacy always-on).
      if (cfg.containsKey('aiReceptionistEnabled')) {
        _calleePrefsKnown = true;
        _calleeAiReceptionist = cfg['aiReceptionistEnabled'] == true;
        _calleePstnVoicemail = cfg['pstnVoicemailEnabled'] == true;
      }
      // [AVARECEPT-LANES-1] per-lane + per-scenario prefs (default OFF). Present
      // only on a newer worker; older workers omit them → legacy fallback stays.
      if (cfg.containsKey('receptAvatokEnabled')) {
        _calleeLanesKnown = true;
        _calleeReceptAvatok = cfg['receptAvatokEnabled'] == true;
        _calleeReceptMissed = cfg['receptOnMissed'] == true;
        _calleeReceptRejected = cfg['receptOnRejected'] == true;
        _calleeReceptUnreachable = cfg['receptOnUnreachable'] == true;
      }
      final Duration window = _receptMode == 'first_ring'
          ? const Duration(seconds: 6)
          : Duration(seconds: (_receptRings * 5).clamp(20, 45));
      _armNoAnswerWindow(window);
    } catch (_) {}
  }

  /// [AVARECEPT-LANES-1] Should the AvaTOK receptionist AUTO-activate for this
  /// unanswered-call [scenario] ('missed' | 'rejected' | 'unreachable')? Requires
  /// the callee's AvaTOK lane ON **and** the matching scenario ON — both default
  /// OFF (opt-in). Falls back to the legacy always-on pref only when the worker
  /// didn't send the new per-lane keys, so an older backend never regresses. An
  /// EXPLICIT user action ("Talk to Ava" in the outcome menu) bypasses this and
  /// calls _tryReceptionist directly.
  bool _receptionistAllowedFor(String scenario) {
    if (!_calleeLanesKnown) {
      return !_calleePrefsKnown || _calleeAiReceptionist;
    }
    if (!_calleeReceptAvatok) return false;
    switch (scenario) {
      case 'unreachable':
        return _calleeReceptUnreachable;
      case 'rejected':
        return _calleeReceptRejected;
      case 'missed':
      default:
        return _calleeReceptMissed;
    }
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
      // [FAKE-RING-HONEST-1] (2026-07-22 incident) A ring sound/status may ONLY
      // ever be driven by a real device-ringing receipt or a genuine peer
      // signaling frame (offer/answer/candidate). This 5s fallback fires when the
      // SERVER never sent a ring-ack — that means we have NO evidence the callee's
      // device is up, so we must NOT call _onDeviceRinging() (which would narrate
      // "Ah — it's ringing!", set phase 'ringing', and play a full ringback). On
      // 2026-07-22 15:10:26 a caller heard a complete fake ring while the callee's
      // phone was unreachable (4 stale tokenless devices, delivered_semantics=
      // fcm_accepted_not_device_receipt) — this fallback manufactured it. Instead
      // keep the honest searching state: leave the searching tone playing, do NOT
      // start a ringback, and simply arm the no-answer window so the Ava handoff
      // still fires at timeout. The genuine device-ringing receipt, if it ever
      // arrives, upgrades us to a real ring via _onDeviceRinging.
      Analytics.capture('call_ring_ack',
          {'call_id': config.room, 'source': 'fallback', 'honest': true});
      _setDialStage('Still trying to reach $_peerFirst…');
      _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 25));
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
    // [ISSUE-VIDEO-RINGACK-1] (2026-07-14) VIDEO never runs _probeReceptionist
    // (there is no receptionist on video), so _armNoAnswerWindow is never
    // reached and _pendingRingWindow stays null FOREVER on a video call. The
    // ack therefore parked in _pendingAckResult and was never applied by
    // anyone: video ignored the server's verdict entirely and just waited out
    // the 12s _deviceRingingTimer. Two consequences, both fixed by applying it
    // directly (_applyRingAck already defaults the window to 25s):
    //   ok=false → the server KNOWS there's no reachable device; say so now
    //              instead of stalling the caller for 12s.
    //   ok=true  → the wake push verifiably left the building, so cancel the
    //              12s timer and give the callee the full window. Without this,
    //              a reachable-but-slow-to-ring phone (FCM routinely takes
    //              8-15s — see [CALL-RINGACK-EXTEND-1]) was declared
    //              "unreachable" on video at 12s. That's the audio bug from the
    //              2026-07-08 "everyone gets Ava" incident, still live on video.
    // AUDIO is deliberately untouched: it must keep parking the ack until
    // _probeReceptionist resolves the receptionist-derived window, otherwise
    // _armNoAnswerWindow would double-arm against _startRingWindow here.
    //
    // KNOWN, INTENDED BEHAVIOUR CHANGE: on video where the server accepts the
    // push (ok=true) but the phone never actually rings, the caller now waits
    // the 25s window and sees "no answer" instead of bailing at 12s with
    // "unreachable" (_callUnreachable is never set on the ok=true path). That
    // is the honest label — the push WAS accepted, so we don't know the device
    // is off — and it matches what audio already does.
    if (_pendingRingWindow == null && config.video) { _applyRingAck(ok); return; }
    if (_pendingRingWindow == null) { _pendingAckResult = ok; return; }
    _applyRingAck(ok);
  }

  void _applyRingAck(bool ok) {
    _ringAckOk = ok; // [CALL-TELEMETRY-1] recorded even if already handled
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
        // [FAKE-RING-HONEST-1] But an accepted push is NOT proof the device rang
        // (FCM-accepted != device-reached; delivered_semantics=
        // fcm_accepted_not_device_receipt). Keep the wording to "reaching the
        // phone" so it never implies the callee's phone is actually ringing — the
        // real ring narration/tone comes only from a device-ringing receipt.
        _setDialStage("Reaching $_peerFirst's phone…");
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

  // ── [INSTANT-CALL-MOUNT-1] Placement-result feedback ──────────────────────
  //
  // When a call screen is mounted OPTIMISTICALLY (config.deferRing — the screen
  // is shown the instant the user taps, before POST /api/call resolves), the
  // launch site runs that POST in the BACKGROUND and feeds the outcome back
  // here. This maps 1:1 onto the ring-ack machinery the guard flow already uses:
  //   reachable == true  → the wake push verifiably left the building → give the
  //                        callee the full ring window (the device-ringing
  //                        receipt still refines phase/ringback when it lands).
  //   reachable == false → no reachable device → honest unreachable → Ava, with
  //                        NO fake ringback ever having played.
  // Safe to call at most once; extra/late calls are absorbed by the ring-ack
  // guards (_ringAckHandled / _pendingAckResult). A no-op unless this session is
  // in guard/deferRing mode (_onRingAck early-returns when !_takeoverGuard).
  void notePlaceResult(bool reachable) {
    if (_ended || _connected) return;
    _onRingAck(reachable);
  }

  /// [INSTANT-CALL-MOUNT-1] The place-call POST itself failed hard (network/DNS
  /// error) — drive the honest 'network-error' terminal (carrying the launch
  /// site's Retry affordance) instead of a silent hang or a fake ring. Mirrors
  /// the pre-mount abort the old awaited path performed before it ever mounted.
  void notePlaceFailed() {
    if (_ended || _connected) return;
    _endWith('network-error', reason: 'place-call-failed');
  }

  void _onDeviceRinging() {
    // [CALL-ECHO-FIX-2] Belt-and-braces. The `_onSignal` caller is now guarded
    // on `config.outgoing`, but this method has several call sites (the ring-ack
    // handler, the 5s fallback timer) and "the callee's phone is ringing" is
    // never a meaningful event on the callee's OWN device. Enforce the invariant
    // where it belongs rather than trusting every caller to remember it.
    if (!config.outgoing) {
      Analytics.capture('invariant_protected', {
        'kind': 'device_ringing_on_incoming',
        'side': 'client',
        'call_id': config.room,
      });
      return;
    }
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
      _ringback.playRingback(config.ringbackUrl, speakerOn: _speaker);
      Analytics.capture('ringback_played_on_receipt', {
        'source': config.ringbackUrl.isEmpty ? 'default' : 'custom',
        'video': config.video,
        'call_id': config.room,
        // [CALL-ECHO-FIX-2] Always true now. Kept on the event so the fix is
        // verifiable in prod: any 'outgoing': false row means the guard leaked.
        'outgoing': config.outgoing,
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
  Future<void> _onAvaLiveTimeout(ReceptionistCall call) async {
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
    // Second miss → the receptionist connected but never produced audio
    // (`ava_recept_skipped=unavailable`). This is the incident dead-end: the
    // caller used to be dropped into a SILENT 'receptionist-unavailable' end.
    Analytics.capture('ava_recept_skipped', {
      'call_id': config.room,
      'reason': 'ava_live_timeout',
      'activation_mode': call.activationMode,
    });
    _clearAvaLiveGate();
    // Tear down the dead receptionist leg so it can't linger under the fallback.
    try { call.hangup(); } catch (_) {}
    _receptionist = null;
    _receptionistActive = false;
    // [RECEPT-SETTINGS-1] voicemail removed — when the receptionist can't go live
    // there is no free-voicemail fallback; surface an HONEST end state rather than
    // dead air.
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
    // [AVA-VM-NOCOUNTDOWN-1, owner 2026-07-19] The 3-2-1 countdown existed to mask
    // the AI receptionist's warm-up. Zero-cost VM mode plays a CACHED greeting
    // near-instantly, so the countdown is skipped (flag-gated: flip
    // avaCountdownEnabled back on in KV if real networks ever feel slow — no
    // app release needed). call.start() runs in parallel either way.
    if (!RemoteConfig.avaCountdownEnabled) return;
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
    // [CALL-CONNECT-WATCHDOG-1] The backstop must die with the call. `_endWith`
    // → `_teardown` runs on every terminal path, and `_ended` is set below, but
    // an un-cancelled 45s timer would still hold a reference to this session.
    _connectWatchdog?.cancel();
    _connectWatchdog = null;
    _connectWatchdogFast?.cancel(); // [AVACALL-WATCHDOG-2]
    _connectWatchdogFast = null;
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
    NativeVoiceAudio.instance.onEvent = null;
    _ended = true;
    if (gLiveCallScreens > 0) gLiveCallScreens--;
    // [AVATOK-DIAL-GUARD-1] Clear the staleness anchor the instant the counter
    // returns to 0, mirroring gInCallSince's own clear just below.
    if (gLiveCallScreens == 0) gLiveCallScreensSince = 0;
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
      // [CALL-TELEMETRY-1] setup-stage markers → call_ended + never_connected.
      deviceRinging: _deviceRinging,
      ringAckOk: _ringAckOk,
      gotSdpAnswer: _gotSdpAnswer,
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
        // [DIALPAD-BIZ-CALLS Phase C] the view swaps in the live agent panel;
        // this line only shows for the brief connect window.
        'agent-handoff' => "Connecting you to $_peerFirst's Ava AI agent…",
        // [CALL-OUTCOME-MENU-1] honest per-scenario status header (spec §1).
        'outcome-menu' => switch (_menuScenario) {
          'busy' => '$_peerFirst is busy on another call',
          'unreachable' => "$_peerFirst's phone appears to be off or unreachable",
          'declined' => "$_peerFirst can't take your call right now",
          _ => "$_peerFirst isn't answering",
        },
        // [CALL-DIAL-FAIL-1]
        'network-error' => "Can't reach the network — check your connection",
        // [AVA-COUNTDOWN-COPY-1] Warm, honest connecting lines while the 3-2-1
        // ring settles — no cold "isn't picking up" framing, and no premature
        // "taking your call" claim (that stays gated to the confirmed phase).
        'ava-countdown' => switch (_avaCount) {
          3 => 'Getting hold of Ava…',
          2 => 'She’ll be online any second…',
          _ => 'Almost there — connecting you…',
        },
        'receptionist-connecting' => 'Ava is picking up…',
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
