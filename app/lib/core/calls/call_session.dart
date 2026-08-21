import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:crypto/crypto.dart'
    show sha1; // [CALL-RESTORE-1] stable peer id
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:stream_webrtc_flutter/stream_webrtc_flutter.dart';
import 'package:uuid/uuid.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../analytics.dart';
import '../account_storage.dart';
import '../api_auth.dart';
import '../audio_tuning.dart'
    as audio_tuning; // [CALL-SURVIVE-1] shared Opus tuner
import '../ava_log.dart';
import '../call_log_store.dart';
import '../call_recording/call_recording_model.dart';
import '../call_recording/call_recording_store.dart';
import '../call_telemetry.dart';
import '../config.dart';
import '../ice_cache.dart';
import '../profile_store.dart';
import '../receptionist_api.dart';
import '../receptionist_call.dart';
import '../remote_config.dart';
import 'call_audio_controller.dart';
import 'call_media_permissions.dart'; // [STREAM-PERM-1] preflight + classifier
import 'call_prewarm.dart'; // [CALL-PREWARM-1]
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
import 'call_sfu_transport.dart';
// [CALL-RTK-3] The provider-agnostic RTC seam + its RealtimeKit implementation.
// Only `RtcSession`/`RtcMode` and the provider's own entry points cross this
// import — no realtimekit_core type reaches call_session.dart.
import 'rtc/realtimekit_provider.dart';
import 'rtc/rtc_provider.dart';
import 'rtc/stream_call_api.dart';
import 'rtc/stream_call_provider.dart';

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

  /// Silent transport prewarm identity carried from the incoming ring. Empty /
  /// null means the normal cold path and preserves older callers.
  final String prewarmNonce;
  final int? prewarmGeneration;
  final String prewarmNetworkIdentity;

  /// Provider chosen by the server before ringing. Existing call sites default
  /// to Cloudflare/P2P; Stream is only meaningful when the staging pilot gate
  /// and a typed Stream ticket are both present. The value is immutable so a
  /// live call cannot silently migrate providers halfway through setup.
  final CallMediaProvider mediaProvider;
  final StreamCallJoinTicket? streamTicket;
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
    this.prewarmNonce = '',
    this.prewarmGeneration,
    this.prewarmNetworkIdentity = '',
    this.mediaProvider = CallMediaProvider.cloudflare,
    this.streamTicket,
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

// ── [CALL-WS-AUTH-1 2026-08-03] CallRoom join credentials (audit A1) ─────────
//
// The signalling relay (`/room/<id>`) is routed in the Worker BEFORE any auth
// and, until this change, took the joiner's peer id straight from a query string
// with no identity check. A call id — 8 hex characters, present in pushes, logs
// and telemetry — was therefore sufficient to join a stranger's call, take a
// seat under the 2-peer cap, and read or inject SDP.
//
// The server now mints one token PER SIDE at dial time. This registry is the
// device-side holding pen for whichever side this device is on:
//   * CALLER — from the `roomToken` field of the /api/call response.
//   * CALLEE — from the `roomToken` field of the ring push (FCM data + the WS
//     ring), because accepting a call goes straight to the socket with no
//     authenticated round-trip in between.
//
// A REGISTRY rather than a CallSessionConfig field on purpose. The optimistic
// mount ([INSTANT-CALL-MOUNT-1]) creates the session the instant the user taps,
// BEFORE the POST that mints the token has returned, so the value simply does
// not exist when the config is constructed. Keying by call id lets whichever
// code path learns it first deposit it, and lets a reconnect pick it up later.
final Map<String, String> _kRoomTokens = <String, String>{};
final Map<String, Completer<String>> _kRoomTokenWaiters =
    <String, Completer<String>>{};
const FlutterSecureStorage _kRoomTokenStore = FlutterSecureStorage(
  mOptions: MacOsOptions(useDataProtectionKeyChain: false),
);

String _roomTokenStorageKey(String callId) =>
    scopedKey('call_room_token_v1_$callId');

Future<void> _persistRoomToken(String callId, String token) async {
  try {
    await _kRoomTokenStore.write(
        key: _roomTokenStorageKey(callId), value: token);
  } catch (_) {/* in-memory credential still supports this process */}
}

Future<String> _restoreRoomToken(String callId) async {
  final have = _kRoomTokens[callId];
  if (have != null && have.isNotEmpty) return have;
  try {
    final stored =
        await _kRoomTokenStore.read(key: _roomTokenStorageKey(callId));
    if (stored != null && stored.isNotEmpty) {
      _kRoomTokens[callId] = stored;
      return stored;
    }
  } catch (_) {/* caller can still receive a fresh token */}
  return '';
}

/// Deposit the CallRoom join credential for [callId]. Safe to call more than
/// once and from either the caller or callee path; first non-empty value wins.
///
/// Fire-and-forget persistence. Correct for the CALLER, whose process is alive
/// and in the foreground by construction. The CALLEE ring path must use
/// [rememberCallRoomTokenDurable] instead — see the note there.
void rememberCallRoomToken(String callId, String token) {
  if (!_depositRoomToken(callId, token)) return;
  unawaited(_persistRoomToken(callId, token));
}

/// [CALL-REL-R4-3 2026-08-03] Deposit the credential and WAIT for it to reach
/// secure storage.
///
/// The callee learns its token from the ring payload, which on Android is very
/// often handled in the short-lived FCM background isolate. That isolate can be
/// torn down the moment its handler returns — so an unawaited write races
/// process death, and the token that a cold-start Accept later needs may never
/// have been committed. The in-memory map does not survive either: the accept
/// runs in the MAIN isolate, which has a different heap.
///
/// This is a rollout blocker rather than a live bug: `callRoomAuthEnforced` is
/// false in production, so an un-credentialed join is currently admitted. Turn
/// enforcement on with a lossy write here and locked-screen / killed-app accepts
/// start failing at the socket.
Future<void> rememberCallRoomTokenDurable(String callId, String token) async {
  if (!_depositRoomToken(callId, token)) return;
  await _persistRoomToken(callId, token);
}

/// In-memory half of the two deposit paths. Returns false when there is nothing
/// to persist (empty input, or an earlier non-empty value already won).
bool _depositRoomToken(String callId, String token) {
  if (callId.isEmpty || token.isEmpty) return false;
  if (_kRoomTokens.containsKey(callId)) return false;
  _kRoomTokens[callId] = token;
  final w = _kRoomTokenWaiters.remove(callId);
  if (w != null && !w.isCompleted) w.complete(token);
  // Calls are short-lived and this map is tiny, but a long-running app process
  // places a lot of them. Bound it rather than leak one entry per call forever.
  if (_kRoomTokens.length > 64) {
    _kRoomTokens.remove(_kRoomTokens.keys.first);
  }
  return true;
}

/// Drop a finished call's credential. Called from teardown.
void forgetCallRoomToken(String callId) {
  _kRoomTokens.remove(callId);
  unawaited(_kRoomTokenStore
      .delete(key: _roomTokenStorageKey(callId))
      .catchError((_) {}));
  final w = _kRoomTokenWaiters.remove(callId);
  if (w != null && !w.isCompleted) w.complete('');
}

/// The credential for [callId], or '' if this device never received one (an
/// inbound call from a server that predates this change, for instance).
String roomTokenFor(String callId) => _kRoomTokens[callId] ?? '';

/// Wait briefly for a credential that is expected but has not landed yet.
///
/// Only the OUTGOING first connect needs this, and only because of the
/// optimistic mount: the socket is opened before POST /api/call has returned the
/// caller's token. Bounded and fail-open — if it does not arrive we connect
/// anyway, which is exactly the pre-change behaviour and is what keeps this from
/// being able to delay a call. The wait costs nothing in practice because an
/// outgoing socket has nothing to do until the callee joins.
Future<String> _awaitRoomToken(String callId, Duration timeout) {
  final have = _kRoomTokens[callId];
  if (have != null && have.isNotEmpty) return Future<String>.value(have);
  final w = _kRoomTokenWaiters.putIfAbsent(callId, () => Completer<String>());
  return w.future.timeout(timeout, onTimeout: () => '');
}

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
  final double? estMos;
  const CallNetStats({
    this.rttMs = -1,
    this.downKbps = 0,
    this.upKbps = 0,
    this.bytesTotal = 0,
    this.lossPct = -1,
    this.quality = 0,
    this.estMos,
  });

  static const CallNetStats empty = CallNetStats();

  /// Total data used this call, in MB.
  double get dataMb => bytesTotal / (1024 * 1024);
}

/// [CALL-REL-5] Why a recovery attempt was requested (plan §4.1). Gated
/// entirely behind RemoteConfig.callIceRecoveryV2 — with the flag off, none of
/// this is reachable and behavior is identical to the pre-existing watchdog.
enum RecoveryReason {
  noPlayout,
  highConcealment,
  transportDisconnected,
  networkChanged,
  peerRejoined,
  routeMismatch,
}

extension RecoveryReasonWire on RecoveryReason {
  String get wire => switch (this) {
        RecoveryReason.noPlayout => 'no_playout',
        RecoveryReason.highConcealment => 'high_concealment',
        RecoveryReason.transportDisconnected => 'transport_disconnected',
        RecoveryReason.networkChanged => 'network_changed',
        RecoveryReason.peerRejoined => 'peer_rejoined',
        RecoveryReason.routeMismatch => 'route_mismatch',
      };
}

/// [CALL-REL-5] The single active recovery attempt (plan §4.1: "owns exactly
/// one attempt token and one deadline"). Never more than one instance is live
/// on a [CallSession] at a time — see [CallSession._activeRecovery].
class RecoveryAttempt {
  final String id; // UUID, sent in signaling — NO SDP, NO PII (plan §7.3.2)
  final RecoveryReason reason;
  final String targetPath; // 'direct' | 'relay' — path this attempt targets
  final int startedAtMs;
  final int attempt; // 1-based ordinal within this call
  bool completed = false;

  /// True once THIS endpoint was chosen (by the DO) as the ICE-restart offerer
  /// for this attempt. Either side may have REQUESTED recovery (REL-3 fix);
  /// only the chosen offerer restarts.
  bool isOfferer = false;

  /// Consecutive healthy playout samples observed by the OFFERER since this
  /// attempt's ICE restart went out. Completion requires >= 2 (plan §7.3.5).
  int healthySamplesSinceStart = 0;

  /// True once the peer sent `recovery-ready` for this attempt id.
  bool peerReady = false;

  /// True once THIS (non-offerer) endpoint has sent its own `recovery-ready`
  /// for this attempt — guards against sending it more than once.
  bool selfReadySent = false;

  RecoveryAttempt({
    required this.id,
    required this.reason,
    required this.targetPath,
    required this.startedAtMs,
    required this.attempt,
  });
}

/// [CALL-REL-6] One dual-PC mid-call relay-migration attempt (plan §7.4).
/// Distinct from [RecoveryAttempt] because it owns a SECOND, separate
/// `RTCPeerConnection` that must coexist with the live `_pc` until cutover.
class RelayMigrationAttempt {
  final String
      id; // UUID, sent in signaling — NO SDP secrets beyond the SDP itself
  final int startedAtMs;
  RTCPeerConnection? newPc;
  bool remoteTrackSeen = false;

  /// [CALL-REL-6 SHOULD-FIX-4] The new PC's remote stream, captured the
  /// moment its `onTrack` first fires. Cutover repoints `remoteRenderer` to
  /// THIS stream directly instead of relying on a fresh `onTrack` firing
  /// again after promotion — the track event that proved this attempt
  /// healthy already happened once, on the migration PC's own `onTrack`
  /// handler (not the one installed later by `_promoteMigratedPc`), so
  /// waiting for a second one would leave the renderer bound to the old
  /// (closed) PC's stream indefinitely.
  MediaStream? remoteStream;
  int healthySamplesOnNewPc = 0;
  bool readySent = false;
  bool peerReady = false;
  bool completed = false;

  RelayMigrationAttempt({required this.id, required this.startedAtMs});
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
      final digest =
          sha1.convert(utf8.encode(seed)).toString().substring(0, 10);
      _myId = 'app-$digest';
    } catch (_) {/* keep the random fallback — see the doc above */}
  }

  bool _stablePeerIdAdopted = false;

  // ── Public notifiers (listen; never dispose from a view) ────────────────────
  final ValueNotifier<CallPhase> phase =
      ValueNotifier<CallPhase>(CallPhase.connecting);

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

  /// [CALL-VIDEO-FIX-1 2026-08-17] True while a mid-call camera-on is
  /// actually in flight on the SFU path (getUserMedia through a confirmed
  /// publish), false the rest of the time. Exists so the UI has an honest
  /// "Adding video…" state to show instead of the old behaviour of flipping
  /// [videoActive]/[cameraOn]/[speakerOn] to true the INSTANT the button was
  /// tapped, before anything had actually happened — which is what let the
  /// UI claim video was live while the upgrade was still negotiating, or had
  /// already failed. Only the SFU path uses this; the P2P upgrade
  /// (`_restartWithVideo`'s non-SFU branch) is unchanged and still sets the
  /// flags optimistically, per this fix's scope.
  final ValueNotifier<bool> videoUpgrading = ValueNotifier<bool>(false);

  /// Remote video is separate from [videoActive], which represents OUR camera.
  /// A call can have local video enabled while the peer's video negotiation or
  /// renderer is unavailable.
  final ValueNotifier<bool> remoteVideoActive = ValueNotifier<bool>(false);

  /// `waiting` means negotiation is still in progress, `active` means a remote
  /// video track arrived, and `unavailable` means the call is audio-connected
  /// but remote video could not be established.
  final ValueNotifier<String> remoteVideoStatus = ValueNotifier<String>('idle');

  /// [CALL-VIDEO-FIX-1 2026-08-17] Wall-clock ms when the remote VIDEO track
  /// last attached, so `remoteRenderer.onFirstFrameRendered` can report
  /// `ms_from_attach` on `remote_video_first_frame`. Set in
  /// `_handleRemoteTrack`; not reset on disconnect, so a stray first-frame
  /// callback after the call ended (if the renderer fires one late) reports
  /// a stale-but-harmless gap rather than crashing on a null.
  int? _remoteVideoAttachedAtMs;
  final ValueNotifier<bool> onCellularHold = ValueNotifier<bool>(false);

  /// SEAM for WS-D/C: true while the peer's signaling socket is gone but media
  /// may still be flowing (today: set on 'peer-left', cleared on reconnect /
  /// 'welcome'). WS-D wires the grace-period semantics onto it.
  final ValueNotifier<bool> peerAway = ValueNotifier<bool>(false);

  /// [CALLREC-PEER-1] True while the OTHER party has told us their device is
  /// recording this call. Consent surface, spec §4 — the peer gets no other
  /// warning, and twelve US states are all-party consent, so this is the thing
  /// that makes the on-screen indicator honest instead of local-only decoration.
  ///
  /// Deliberately NOT gated on any flag. `callRecordingIndicatorEnabled` gates
  /// the DISPLAY (call_screen.dart); the frame is always sent and always
  /// recorded here so the flag can be flipped on without needing a new client
  /// build on the SENDER's side, and so a client with `callRecordingEnabled`
  /// off — which can never record — can still show that it is BEING recorded.
  final ValueNotifier<bool> peerRecording = ValueNotifier<bool>(false);

  /// [CALLREC-PEER-1] The last value we announced to the peer, so an unchanged
  /// store notification does not put a frame on the wire.
  bool _lastRecordingAnnounced = false;

  /// [CALLHOLD-1] WE have put the call on hold. See [toggleHold].
  final ValueNotifier<bool> holdActive = ValueNotifier<bool>(false);

  /// [CALLHOLD-1] THEY have put the call on hold — set from the peer's `hold`
  /// frame. Purely informational: we do not mute ourselves when the peer holds,
  /// because their side has already stopped sending and stopped listening, and
  /// silently muting a user who can still be heard nowhere is worse than
  /// letting them talk into a hold they can SEE on screen.
  final ValueNotifier<bool> peerHold = ValueNotifier<bool>(false);

  /// [CALLHOLD-1] The peer's mute state.
  ///
  /// The client has been SENDING `{'type':'mute','muted':…}` since long before
  /// this change and there was no `case 'mute':` in the receive switch, so every
  /// one of those frames was transmitted and dropped on the floor. The receive
  /// case costs two lines; wiring it here means the UI can finally distinguish
  /// "they muted" from "they're on hold" from "they went quiet", which is the
  /// difference between an explained silence and a support ticket.
  ///
  /// NOTE the automatic holds below (GSM call, audio-focus loss) also send mute
  /// frames, so this notifier can move without the peer touching their mute
  /// button. That is honest — their microphone really is off.
  final ValueNotifier<bool> peerMuted = ValueNotifier<bool>(false);

  /// [CALLHOLD-1] User hold, kept DISTINCT from `_onCellularHold`/`_onFocusHold`
  /// — see [toggleHold] for why they must not share state.
  bool _userHold = false;

  /// The last hold value we put on the wire, so an unchanged toggle does not
  /// re-send. Bypassed by `force` on connect/rejoin.
  bool _lastHoldAnnounced = false;

  /// [CALLHOLD-1] Latch mirroring what the RECORDER has been told, so overlapping
  /// holds (user hold started during a GSM call, say) produce exactly one pause
  /// and exactly one resume — and the resume only happens once EVERY hold is
  /// gone. See [_syncRecorderHold].
  bool _recorderHeld = false;

  /// [CALLREC-PEER-1] Our listener on the recording store, held so it can be
  /// removed in teardown — the store is a process-wide singleton, so a session
  /// that forgot to detach would keep announcing after its call had ended.
  VoidCallback? _recordingListener;

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
    try {
      return anotherLiveSessionOwnsRoom?.call() ?? false;
    } catch (_) {
      return false;
    }
  }

  // ── Internal call state (ex-_CallScreenState fields, verbatim) ──────────────
  WebSocketChannel? _ws;
  RTCPeerConnection? _pc;
  MediaStream? _stream;

  /// [ADDCALL-0] The live local capture stream, **borrowed, never owned**.
  ///
  /// Exposed for make-before-break escalation (Specs/SPEC-ADD-TO-CALL-2026-08-06.md
  /// §4.3 gap #1): the migration coordinator hands this same stream to the
  /// conference `RTCPeerConnection` so the SFU leg comes up on the mic that is
  /// already open, with no re-`getUserMedia` and no audible gap.
  ///
  /// **The caller MUST NOT dispose it, stop its tracks, or retain it past the
  /// call.** [CallSession] created this stream and [CallSession] disposes it in
  /// teardown; a borrower that disposes it kills the audio of the call that is
  /// still running. `CloudflareConferenceController` gets this contract right
  /// already — it sets `_ownsLocalStream = false` whenever a `sharedLocalStream`
  /// is passed in (`cloudflare_conference_controller.dart:568-579`, `:1547`) and
  /// therefore leaves disposal to us. Any new borrower must do the same.
  ///
  /// Mutating the stream (e.g. toggling track `enabled`) is also off-limits —
  /// mute and camera state are owned by this session's own controls.
  ///
  /// Null before capture starts and after teardown. Read-only by design: there
  /// is deliberately no setter, because nothing outside this class may swap the
  /// stream a live [RTCPeerConnection]'s senders are bound to.
  MediaStream? get borrowedLocalCaptureStream => _stream;

  /// [ADDCALL-2-UI] Ownership handoff for make-before-break escalation.
  ///
  /// THE PROBLEM THIS SOLVES. [_teardownImpl] stops every track on [_stream] and
  /// then disposes it. That is correct for an ordinary call and it is fatal for
  /// an escalation: the conference `RTCPeerConnection` is publishing those exact
  /// track objects, so ending the 1:1 leg would silence the group call two
  /// seconds after it came up — the precise failure make-before-break exists to
  /// prevent, arriving from the one direction nobody watches.
  ///
  /// So there is exactly ONE owner of the capture stream at any instant, and
  /// this is how it changes hands. The borrower ([CloudflareConferenceController])
  /// flips its own `_ownsLocalStream` to true and hands us a predicate that
  /// reports whether it STILL owns it; teardown skips stop+dispose only while
  /// that predicate says yes.
  ///
  /// Why a predicate and not a bool: a flag would have to be un-set on every
  /// rollback path, and a missed un-set means the 1:1 leaves the microphone hot
  /// forever. Asking the borrower means the two can never disagree — if the
  /// conference died, failed, or was rolled back, it no longer claims ownership
  /// and this session disposes the stream exactly as it always has.
  bool Function()? _captureLoanCheck;

  /// True only while another object has taken responsibility for disposing
  /// [_stream]. Any throw from the predicate is read as "no loan", so a broken
  /// borrower can never make us leak a live microphone.
  bool get _captureStreamLoaned {
    try {
      return _captureLoanCheck?.call() ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Hand disposal responsibility to a borrower. [borrowerStillOwns] must be a
  /// live read of the borrower's own ownership flag, never a captured constant.
  void loanCaptureStream(bool Function() borrowerStillOwns) {
    _captureLoanCheck = borrowerStillOwns;
    Analytics.capture(
        'addcall_capture_stream_loaned', {'call_id': config.room});
  }

  /// Take disposal responsibility back (escalation rolled back). The borrower
  /// MUST have already dropped its own claim before this is called.
  void endCaptureStreamLoan() {
    if (_captureLoanCheck == null) return;
    _captureLoanCheck = null;
    Analytics.capture(
        'addcall_capture_stream_returned', {'call_id': config.room});
  }

  /// [ADDCALL-2-UI] Re-establish this call's native audio session after an
  /// escalation rolled back.
  ///
  /// `NativeVoiceAudio` holds ONE communication session for the whole device.
  /// A conference that comes up during the overlap takes it over, and that
  /// conference's `leave()` then ends it — so a rolled-back escalation leaves
  /// this still-live 1:1 with no communication mode, no audio focus and no
  /// route. Re-assert rather than assume: this is the same two calls
  /// `_startMedia` makes, with the route the user currently has.
  Future<void> reassertAudioSession() async {
    if (_ended) return;
    // [CALL-AUDIO-OWNER-1] Route through the controller when it owns this
    // call's audio, so the escalation-rollback re-assert uses the same
    // serialized intent-driven apply as every other route change instead of
    // racing it with a second direct `selectRoute` call.
    if (RemoteConfig.callAudioOwnerV1) {
      try {
        await NativeVoiceAudio.instance
            .beginP2pSession(callId: config.room, video: config.video);
        await CallAudioController.instance.reassert('escalation-rollback');
      } catch (_) {/* best effort — never let this end a live call */}
      return;
    }
    if (!RemoteConfig.callAudioControllerV2) return;
    try {
      await NativeVoiceAudio.instance
          .beginP2pSession(callId: config.room, video: config.video);
      final r = await NativeVoiceAudio.instance.selectRoute(
        _speaker ? CallAudioRoute.speaker : CallAudioRoute.earpiece,
        source: 'escalation-rollback',
      );
      _speaker = r.active == CallAudioRoute.speaker;
      speakerOn.value = _speaker;
    } catch (_) {/* best effort — never let this end a live call */}
  }

  // ── [ADDCALL-2-UI] Add-to-call signalling over the live 1:1 socket ──────────
  //
  // Spec §4.2: the other original party is already on a signalling socket, so
  // the new conference id goes to them over it rather than by ringing someone
  // we are mid-conversation with.
  //
  // Modelled EXACTLY on `callrec` ([CALLREC-PEER-1]) and `hold` ([CALLHOLD-1]):
  // CallRoom relays any frame carrying a `to` verbatim and BROADCASTS one
  // without, with no allow-list of frame types, so this needs zero worker
  // changes. `to` is omitted when `_remoteId` is still null — on the SFU path no
  // peer `offer` is ever exchanged, so the first joiner's `_remoteId` can
  // legitimately be null on a live call and the broadcast fallback is the only
  // thing that reaches them.
  //
  // Four frame types, all handled by the SAME dispatcher so the switch below
  // stays four one-line cases:
  //   `addcall`        adder -> peer   "here is the gid, start building"
  //   `addcall-ack`    peer  -> adder  "I am in the conference and hearing it"
  //   `addcall-go`     adder -> peer   "committed; release your 1:1 leg"
  //   `addcall-abort`  either          "it failed; stay on the call you have"
  //
  // An older client has no case for any of them and this switch has no
  // `default:` — they are a no-op there, never an exception.

  /// Installed once at boot by `features/conference/call_escalation_service.dart`.
  /// Static because the frame can arrive while the call is minimized and no
  /// widget is listening; the service owns the response either way.
  ///
  /// Lives here rather than in the conference layer so `core/` keeps no import
  /// of `features/` — the service registers itself downward.
  static void Function(CallSession session, Map<String, dynamic> frame)?
      escalationFrameHandler;

  /// Send one escalation frame to the peer. Public because the coordinator that
  /// drives the migration lives outside this class by design — this file is
  /// already 7k lines and the migration is not call-setup logic.
  void sendEscalationFrame(Map<String, dynamic> frame) {
    try {
      if (_ended) return;
      _send(<String, dynamic>{
        ...frame,
        if (_remoteId != null) 'to': _remoteId,
      });
    } catch (_) {/* never let an escalation frame disturb the call */}
  }

  void _dispatchEscalationFrame(Map<String, dynamic> d) {
    try {
      final h = escalationFrameHandler;
      if (h == null) return;
      h(this, d);
    } catch (_) {/* a broken handler must never break the call */}
  }

  // [CF-CALL-P2P-1] Monotonic generation stamped on every PC created by
  // [_newPC] / promoted by [_promoteMigratedPc]. Event closures (onTrack in
  // particular) capture the generation they were installed under and bail if
  // it's since been superseded — the same "don't bind a stale PC's stream"
  // problem the relay-migration cutover already solves for itself via
  // `identical(_activeMigration, attempt)`, generalized to the ordinary
  // connect/reconnect paths where `_newPC()` can legitimately run more than
  // once per call (fresh 'welcome', relay fallback, offer/answer races).
  int _pcGeneration = 0;
  bool _ended = false; // guard: teardown runs exactly once
  bool _teardownStarted = false; // [CALL-MENU-TEARDOWN-1] closes the async race
  Future<void>? _teardownFuture;
  bool _started = false; // guard: start() runs exactly once (re-attach safe)
  // [STREAM-CALL-PILOT-2] Optimistic mounts must not open a Cloudflare
  // RTCPeerConnection before the placement response identifies the provider.
  // The decision is immutable for this session; a Stream decision never falls
  // back to Cloudflare after the server has selected/rung Stream.
  CallProviderDecision? _providerDecision;
  // Optimistic call screens exist before POST /api/call completes. Nothing may
  // poll or start a no-answer/receptionist clock until the server has recorded
  // both participants; otherwise a failed placement looks like a live call and
  // produces a storm of `not_a_call_participant` 403s.
  bool _placementResolved = false;
  bool _placementFeedbackReady = false;
  bool? _pendingPlacementReachable;
  bool _pendingPlacementPrewarming = false;
  int? _pendingPlacementPrewarmDeadlineMs;
  bool _pendingPlacementFailure = false;
  bool _mediaBooted = false;
  bool _mediaBootStarting = false;
  bool _setupReadyForMedia = false;
  bool _mediaStartRequested = false;
  bool _prejoinRequestedBeforeMedia = false;
  String? _remoteId;
  List<Map<String, dynamic>> _ice = kIceServers;
  Timer? _timer;
  int _secs = 0;
  bool _video = true;
  bool _camOn = true;
  // User intent only. System/focus/cellular holds are separate gates in
  // `_applyLocalAudioEnabled`; they must never overwrite the user's mute.
  bool _muted = false;
  // [CF-CALL-P2P-1] Serializes mid-call video renegotiation (enabling video on
  // an audio call) so it never races a concurrent offer from another path.
  // Checked BY the ICE-recovery/relay-migration triggers below so they defer
  // to an in-flight video upgrade instead of sending a competing offer.
  bool _videoRenegoInFlight = false;
  // [CF-CALL-P2P-1] Serializes camera-flip requests (front/back) so a rapid
  // double-tap can't issue two concurrent `Helper.switchCamera` calls.
  bool _flippingCamera = false;
  bool _speaker = true;
  String? _lastAudioRouteRequestId;
  bool _connected = false;
  // [CALL-SFU-1] SFU is selected per call, while the P2P implementation remains
  // intact as a rollback. `_sfuAborted` is sticky so one side can never return
  // to SFU after the other side has fallen back to P2P.
  // ── [CALL-DEADAIR-1 2026-08-08] setup-stage stopwatch ─────────────────────
  //
  // Prod call avatok-17f145b5 (2026-08-07, build 10523) spent ~14s between
  // `call_started` and the first `call_media_health` sample carrying real audio
  // bytes, on a link measuring 5-6ms jitter and ~0% loss on BOTH sides. The
  // network was excellent; the latency is ours. Nothing in the existing
  // telemetry says WHICH rung of the setup ladder ate it — `call_connected`,
  // `call_transport_connected` and `call_sfu_active` all fire, and the health
  // sampler's first sample can be up to 5s late (it is a 5s periodic started AT
  // connect), so even the 14s figure is an upper bound on the real dead air.
  //
  // These are wall-clock ms from `start()` (i.e. from `call_started`) at the
  // moment each named step COMPLETED. Emitted once, flattened, on
  // `call_first_audio_ms`. Insertion-ordered by construction, so the map also
  // records the order the ladder actually ran in.
  final Map<String, int> _setupStages = <String, int>{};
  int _setupT0 = 0;
  int? _answerAtMs;
  int _lastSetupStageAtMs = 0;
  bool _setupSummaryReported = false;

  String get _performanceProvider => config.mediaProvider.wire;
  String get _performanceRole => config.outgoing ? 'caller' : 'callee';

  void _noteAnswerBoundary(String source) {
    if (_answerAtMs != null) return;
    _answerAtMs = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('call_answer_observed', {
      'call_id': config.room,
      'call_trace_id': _traceId,
      'provider': _performanceProvider,
      'role': _performanceRole,
      'source': source,
      'ms_from_session_start': _setupT0 == 0 ? -1 : _answerAtMs! - _setupT0,
    });
  }

  /// Record that setup stage [name] just completed. First writer wins: a stage
  /// that legitimately repeats (an SFU reconnect re-runs the whole ladder) must
  /// not overwrite the number that describes the ORIGINAL connect, which is the
  /// one this issue is about.
  void _stage(String name) {
    if (_setupT0 == 0) return;
    if (_setupStages.containsKey(name)) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final elapsed = now - _setupT0;
    _setupStages[name] = elapsed;
    final delta =
        _lastSetupStageAtMs == 0 ? elapsed : now - _lastSetupStageAtMs;
    _lastSetupStageAtMs = now;
    Analytics.capture('call_setup_stage', {
      'call_id': config.room,
      'call_trace_id': _traceId,
      'provider': _performanceProvider,
      'media_mode': config.video ? 'video' : 'audio',
      'role': _performanceRole,
      'stage': name,
      'elapsed_from_start_ms': elapsed,
      'stage_delta_ms': delta,
      if (_answerAtMs != null) 'elapsed_from_answer_ms': now - _answerAtMs!,
    });
  }

  void _emitSetupSummary(String outcome) {
    if (_setupSummaryReported || _setupT0 == 0) return;
    _setupSummaryReported = true;
    final now = DateTime.now().millisecondsSinceEpoch;
    final props = <String, Object>{
      'call_id': config.room,
      'call_trace_id': _traceId,
      'provider': _performanceProvider,
      'media_mode': config.video ? 'video' : 'audio',
      'role': _performanceRole,
      'outcome': outcome,
      'elapsed_from_start_ms': now - _setupT0,
      if (_answerAtMs != null) 'elapsed_from_answer_ms': now - _answerAtMs!,
      'connected': _connected,
      'first_audio_received': _firstAudioReported && audioFlowing.value,
      'audible_ready': audibleReady.value,
      'stages_seen': _setupStages.keys.join(','),
    };
    _setupStages.forEach((stage, ms) => props['stage_$stage'] = ms);
    Analytics.capture('call_setup_summary', props);
  }

  CallSfuTransport? _sfu;
  bool _sfuActive = false;
  bool _sfuStarting = false;
  bool _sfuAborted = false;
  bool _sfuDecider = false;
  bool _sfuReconnectInFlight = false;

  /// True while `_stream` is the empty protocol-silence stream used by an
  /// incoming prewarmed SFU call. Cleared only after the real mic replaces the
  /// retained SFU sender or the call falls back to a cold transport.
  bool _prewarmAudioPending = false;
  // [CALL-PREJOIN-1 2026-08-16] P2 of Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md.
  // The CALLER'S pre-joined-and-publishing SFU transport, started while the
  // callee's phone is still ringing (`_maybeStartCallerPrejoin`). Non-null
  // only between the moment the publish is kicked off and the moment it is
  // either adopted by `_startSfuMedia` (transferred to `_sfu`, cleared here)
  // or discarded (`_discardPrejoinedSfu`, on RTK/P2P election, `sfu-abort`,
  // or the call ending while still ringing). Never touched by the callee path
  // or by `reconnect()`.
  CallSfuTransport? _prejoinedSfu;

  /// The in-flight (or already-completed) `connectPublish()` call on
  /// [_prejoinedSfu] — `null` on success, a failed [CallSfuResult] otherwise.
  /// `_startSfuMedia` awaits this before adopting, in case accept happens
  /// before the ring-time publish has actually finished.
  Future<CallSfuResult?>? _prejoinPublishFuture;

  /// Guards [_maybeStartCallerPrejoin] to at most one attempt per call —
  /// idempotent against being reachable from more than one signalling frame.
  bool _prejoinStarted = false;

  /// [CALL-PREJOIN-ISOLATE-1 2026-08-17] The pre-join's OWN peer connection,
  /// captured at construction so it can be promoted (adoption) or retired
  /// (discard) by identity. Never the same object as [_pc] until promotion.
  RTCPeerConnection? _prejoinPc;

  /// [CALL-PREJOIN-ISOLATE-1] False until the pre-join's PC is promoted to be
  /// the session's live connection in [_startSfuMedia]. While false, that PC's
  /// `onTrack` caches instead of acting — see [_newPC]'s `isolated` parameter.
  bool _prejoinPromoted = false;

  /// [CALL-PREJOIN-ISOLATE-1] Remote-track events that arrived on the pre-join
  /// PC BEFORE promotion. Replayed, in order, the instant it is promoted, so a
  /// track delivered while the callee was still ringing is DELAYED, never lost.
  final List<RTCTrackEvent> _prejoinEarlyTracks = <RTCTrackEvent>[];
  // [CALL-RTK-3] Cloudflare RealtimeKit media leg. Deliberately a SEPARATE set
  // of flags from the `_sfu*` ones above rather than a reinterpretation of
  // them: the two transports must be able to abort independently, and reusing
  // `_sfuAborted` would mean an RTK failure silently disqualified the raw-SFU
  // path too. `_rtkAborted` is sticky for the same reason `_sfuAborted` is —
  // once either phone has fallen back, neither may climb back to RTK.
  //
  // Nothing in the recovery / relay-migration / RED ladder reads these: on the
  // RTK path reconnection is the SDK's job, which is the entire point of the
  // migration (Specs/CALL-REALTIMEKIT-MIGRATION.md §2).
  RtcSession? _rtk;
  bool _rtkActive = false;
  bool _rtkStarting = false;
  bool _rtkAborted = false;
  bool _rtkDecider = false;
  // [CALL-RTK-4] Live subscription to [_rtk]'s normalized event stream.
  //
  // Without this the RTK leg joined a meeting and then told the call system
  // NOTHING: `_connected` stayed false, so the 45s connect watchdog ended a
  // live call with 'network-error', the 22s ring timeout handed a conversation
  // in progress to the receptionist, the ringback never stopped and every RTK
  // call logged a zero duration (`_connectedAtMs` is what CALL-LOG-TIME-1
  // keys on). See [_onRtkEvent].
  //
  // One subscription, on `events`, is enough: `RealtimeKitRtcSession._emitTrack`
  // forwards every remote-track event onto `events` as well as onto
  // `remoteTrackEvents`, so subscribing to both would deliver `trackAdded`
  // twice.
  StreamSubscription<RtcSessionEvent>? _rtkEvents;
  // [STREAM-CALL-PILOT-3] Stream's 1:1 audio leg is intentionally separate
  // from RealtimeKit and the legacy PeerConnection. Provider selection is
  // sticky for the whole call, so there is no hidden mid-call fallback.
  RtcSession? _streamRtc;
  StreamSubscription<RtcSessionEvent>? _streamRtcEvents;
  bool _streamRtcActive = false;
  bool _streamRtcStarting = false;
  // [CALL-SURVIVE-3] Best-effort local/remote network-class flags used to
  // gate the conservative cellular resolution/bitrate preset. Refreshed by
  // [_refreshAndAnnounceNetClass] / [_isLikelyCellular]; remote value arrives
  // via the peer's 'net-class' message. Default false (non-cellular) so an
  // unknown state never makes behavior more conservative than before this
  // feature existed.
  bool _localCellular = false;
  bool _peerCellular = false;
  int _qosAudioBitrateBps = 40000;
  int _qosStableSamples = 0;
  double? _qosLastAvailableOutKbps;
  int _videoDegradeLevel = 0;
  int _videoStableSamples = 0;
  String _phase = 'connecting';
  Timer? _ringTimeout;
  // A room WebSocket send is not a delivery acknowledgement: Android can leave
  // a ghost socket registered after the process/network path has stopped
  // consuming frames. While an outgoing call is ringing, this small durable
  // poll recovers a callee-requested Ava handoff from the authoritative DO
  // instead of waiting for a delayed FCM backstop or the full ring timeout.
  Timer? _handoffAuthorityPoll;
  bool _handoffAuthorityPollInFlight = false;

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
  bool _avaLiveGateOpen = false; // true once the ava-live ack has been seen
  bool _avaLiveConnecting = false; // true while we're waiting for the ack
  int _avaLiveConnectAtMs = 0; // when we entered receptionist-connecting
  int _avaLiveAttempt = 0; // 1 on first wait, 2 after the single retry
  Timer? _avaLiveWatchdog; // fires if no ack within the timeout window
  VoidCallback? _avaLevelListener; // listens to ReceptionistCall.avaLevel
  ReceptionistCall?
      _avaLevelSource; // the call we attached _avaLevelListener to
  // Fallback window only — the primary gate is now the explicit 'live' status
  // (ReceptionistCall's first inbound audio frame). Widened from 4000ms because
  // the unreachable path's dial + Gemini-connect + first-audio latency routinely
  // reached ~3.8s, landing right on the old deadline and dropping live calls
  // (AVA-RECEPT-UNREACHABLE-WATCHDOG-RACE). 8s gives the fallback real headroom.
  static const int _avaLiveTimeoutMs = 8000;

  // [AVA-PREWARM-1] Pre-warm the receptionist during the final rings so its
  // HTTP/WS/mic/engine spin-up overlaps the ring instead of happening in dead
  // air after it stops (the 10-11.5s gap: prod ava_recept_first_audio
  // ms=9801/11461). The prewarmed session is held (buffered, silent) and is
  // NEVER assigned to [_receptionist]/[_receptionistActive] until real
  // takeover adopts it in [_tryReceptionist] — those flags mean "Ava owns this
  // call" throughout the file (they gate the no-answer window, device-ringing
  // signal, etc.), and a prewarm must not trip any of that while the caller is
  // still just hearing the ring.
  ReceptionistCall? _prewarmCall;
  Future<bool>? _prewarmStartFuture;
  Timer? _prewarmTimer;
  bool _prewarmScheduleAttempted = false;
  int? _prewarmStartedAtMs;
  bool _handoffWasWarm = false; // was the just-adopted session pre-warmed?
  static const int _prewarmLeadMs = 8000; // start ~8s before the ring deadline

  String _myAvatar = '';
  String _myName = 'You';
  String _mySeed = 'me';
  String _receptMode = 'rings';
  int _receptRings = 4;
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
  String? _busyReason; // active_call | receptionist | do_not_disturb
  bool _busyReceptionistEnabled =
      false; // gates the "Leave a message for Ava" button
  String _busyPronoun =
      'they'; // he | she | they (best-effort, defaults neutral)
  bool _busyNotifyInFlight = false; // "Notify me" register POST in flight
  bool _busyNotifyRegistered = false; // "Notify me" succeeded (button flips)
  bool _busyCardShownLogged = false; // one-shot busy_card_shown telemetry guard
  Timer? _busyCardTimeout; // abandons an untouched busy card after 60s
  StreamSubscription? _statusSub;
  bool _takeoverGuard = false;
  bool _silentTransportPrewarming = false;
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

  /// [CALL-ONE-DEADLINE-1 2026-08-03] The absolute ms at which the CallRoom
  /// alarm will time this ring out, as told to us by the server. `null` until
  /// the place-call response (caller) or the ring payload (callee) supplies it,
  /// and on older builds/pushes that never will — hence every read falls back.
  int? _serverRingDeadlineMs;

  /// Keep the client's no-answer window deliberately BEHIND the server's, so the
  /// server always reaches `ring_timeout` first and the client reacts to an
  /// authoritative transition instead of inventing its own. The previous
  /// hand-tuned pair (server 20 s, client 22 s) encoded the same 2 s of slack;
  /// this makes the relationship explicit rather than a coincidence of two
  /// constants in different files.
  static const int _kRingWindowSlackMs = 2000;

  /// Adopt the server's ring deadline. First writer wins: the WS ring and the
  /// FCM ring are the same fact arriving twice, and a later copy must not push
  /// the deadline out.
  void noteServerRingDeadline(int? deadlineMs) {
    if (deadlineMs == null || deadlineMs <= 0) return;
    final firstTime = _serverRingDeadlineMs == null;
    _serverRingDeadlineMs ??= deadlineMs;
    // [AVA-PREWARM-1] Now that the deadline is known, schedule the pre-warm
    // relative to it. Only the first writer's deadline matters (see above), so
    // only schedule once too.
    if (firstTime) _schedulePrewarm();
  }

  /// The /api/call response says the callee is still in the silent transport
  /// window. Keep the caller in finding/waking state: no ringback, no
  /// no-answer/Ava timer, and no local deadline until CallRoom emits its
  /// authoritative `call-ringing` frame.
  void notePrewarming({int? deadlineMs}) {
    if (_ended || _connected || !config.outgoing) return;
    _silentTransportPrewarming = true;
    _deviceRingingTimer?.cancel();
    _deviceRingingTimer = null;
    _ringAckFallback?.cancel();
    _ringAckFallback = null;
    _ringTimeout?.cancel();
    _ringTimeout = null;
    _pendingAckResult = null;
    _ringAckHandled = false;
    _ringback.stop();
    _setDialStage("Waking $_peerFirst's phone…");
    _maybeStartCallerPrejoin();
    Analytics.capture('caller_waiting_room', {
      'call_id': config.room,
      'phase': 'waking',
      'prewarm_deadline_ms': deadlineMs ?? -1,
    });
  }

  /// [CALL-ROUTED-OPTIMISTIC-1 2026-08-03] The server answered the place-call
  /// with a terminal routing verdict — `busy` or `unavailable` — and sent NO
  /// ring. Nothing will ever arrive on this leg, so the session must reach its
  /// outcome now rather than waiting out a device-wake window for a ring that
  /// was never placed.
  ///
  /// `busy` reuses the existing busy handling (card / tone / outcome menu, per
  /// `busyCardEnabled`). `unavailable` is the admission layer's deliberately
  /// uniform denial and must NOT be dressed up as anything more specific — it
  /// tells the caller nothing about why, by design.
  void noteServerRoutedTerminal(String routed) {
    if (_ended || _connected) return;
    if (routed == 'busy') {
      // ignore: unawaited_futures
      _onBusy();
      return;
    }
    _endWith('ended', reason: 'server-unavailable');
  }

  /// [CALL-OBS-1 2026-08-03] One `call_transport_connected` per call, across
  /// both the original and any post-migration PeerConnection.
  bool _transportConnectedLogged = false;
  final int _startedAtMs = DateTime.now().millisecondsSinceEpoch;

  /// Emit the transport rung of the accept → transport → media funnel exactly
  /// once. Deliberately NOT guarded on `_connected` or `_ended`: the whole point
  /// is to observe calls that never reach either.
  void _noteTransportConnected(RTCPeerConnectionState s,
      {bool postMigration = false}) {
    if (_transportConnectedLogged) return;
    if (s != RTCPeerConnectionState.RTCPeerConnectionStateConnected) return;
    _transportConnectedLogged = true;
    try {
      Analytics.capture('call_transport_connected', {
        'call_id': config.room,
        'direction': config.outgoing ? 'outgoing' : 'incoming',
        'ms_since_start': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
        // Did media follow? Join against `call_connected` on the same call_id:
        // transport WITHOUT media is the interesting failure, and until now it
        // was indistinguishable from a call that never got off the ground.
        'had_media_yet': _connected,
        'post_migration': postMigration,
      });
    } catch (_) {/* telemetry must never affect a call */}
  }

  bool _weOffered = false;
  int _iceRestarts = 0;
  Timer? _failTimer;
  // ── [CALL-REL-5] serialized ICE recovery coordinator ─────────────────────
  // Entirely inert unless RemoteConfig.callIceRecoveryV2 is on. Replaces the
  // old watchdog's own restart/hard-end decisions (REL-2 fix: the watchdog no
  // longer hard-ends a call at ~20s while a restart may still be in flight —
  // termination is owned by [_recoveryDeadlineTimer], 30s from recovery start,
  // with the exact failed invariant per plan §7.3.7).
  RecoveryAttempt? _activeRecovery;
  int _recoveryAttemptCount = 0;
  Timer? _recoveryDeadlineTimer;
  // ── [CALL-REL-6] mid-call relay migration ─────────────────────────────────
  // Entirely inert unless RemoteConfig.callRelayMigrationV1 is on. Escalation
  // target when direct ICE recovery fails, or when §7.2 relay thresholds are
  // hit directly (loss >= 8% for 3 samples). MAX one migration per call.
  bool _migrationAttempted = false;
  RelayMigrationAttempt? _activeMigration;
  Timer? _migrationDeadlineTimer;
  int _relayThresholdStreak = 0;
  // ── [CALL-SURVIVE-1 2026-08-04] handover-survival retry ladder ────────────
  // Replaces "recovery failed → end the call". A failed recovery/migration no
  // longer terminates: it schedules the NEXT attempt with exponential backoff
  // (2/4/8/16/30s). Terminal call end is owned ONLY by (a) explicit hangup,
  // (b) the signaling-WS reconnect ladder giving up (`reconnect_failed` —
  // peer's app is genuinely gone), or (c) the DO's dead-peer/away expiry. A
  // network-interface change resets the ladder: a fresh interface deserves an
  // immediate attempt (see the connectivity listener). Prod incident
  // avatok-999a650b / avatok-10d4696b (2026-08-04): WiFi↔cell flaps killed
  // live calls with `relay_migration_timeout` after ~50s of dead air.
  int _survivalRetries = 0;
  // [CALL-SFU-SURVIVE-1 2026-08-06] The SFU ladder gets its OWN counter and
  // timer rather than sharing `_survivalRetries`/`_survivalRetryTimer` with the
  // P2P ladder.
  //
  // Sharing looked tidy and was wrong. The two ladders are kept apart only by
  // the `_sfuActive || _sfuStarting || _sfuReconnectInFlight` guard on
  // [_scheduleSurvivalRetry] / [_requestRecovery] / [_tryIceRestart] — and
  // during the SFU BACKOFF WINDOW all three of those are false, because
  // [_reconnectSfu]'s `finally` has already cleared them. Media is stalled by
  // definition during that window, which is exactly what drives
  // `_pollPlayoutHealth` into `_requestRecovery`. So a shared timer would be
  // cancelled by the P2P ladder mid-backoff (killing the pending SFU retry
  // outright), and a shared counter would be zeroed by any P2P success
  // (uncapping the SFU ladder). Separate state, and [_sfuRetryPending] closes
  // the guard so the P2P ladder does not run on an SFU call at all.
  int _sfuRetries = 0;
  Timer? _sfuRetryTimer;
  bool _sfuRetryPending = false;

  /// [CALL-SFU-REPULL-1 2026-08-06] A peer `sfu-rejoined` that arrived while we
  /// were mid-rejoin ourselves, to be drained once our own session is up.
  bool _sfuPeerRepullPending = false;
  Timer? _survivalRetryTimer;
  static const List<int> _kSurvivalBackoffSec = [2, 4, 8, 16, 30];
  // Interface class ('wifi'/'cell'/'none'/'other') we last ACTED on — lets
  // the handover telemetry report from→to and lets the listener distinguish
  // a real interface change from metadata churn. Updated only when a change
  // survives the debounce, so bursts net out.
  String _lastNetClass = 'unknown';
  // [CALL-SURVIVE-2] 2s settle window before acting on an interface change.
  Timer? _netDebounceTimer;
  StreamSubscription? _netSub;

  static String _classifyNet(List<ConnectivityResult> results) =>
      results.contains(ConnectivityResult.wifi) ||
              results.contains(ConnectivityResult.ethernet)
          ? 'wifi'
          : results.contains(ConnectivityResult.mobile)
              ? 'cell'
              : results.contains(ConnectivityResult.none)
                  ? 'none'
                  : 'other';
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
  // [CALL-FOCUS-DEADLOCK-1] Android only re-grants AUDIOFOCUS_GAIN to a holder
  // that suffered a *transient* loss. A permanent AUDIOFOCUS_LOSS — which is
  // what the platform delivers when anything (including another player inside
  // THIS app) requests a plain AUDIOFOCUS_GAIN — is never followed by a regain
  // callback. `onAudioFocusRegained` therefore never fires, `_onFocusHold`
  // latches true, and the mic stays muted for the REST OF THE CALL while RTP
  // keeps flowing perfectly. Verified in prod 2026-08-04 (call avatok-e9226773,
  // hdavy2026@gmail.com → hdavy2002@gmail.com): 36 `call_audio_focus_lost`
  // events over 7 days against ZERO `call_audio_focus_regained`, peer inbound
  // audio_level pinned at 9.16e-05 (digital silence) while inbound RTP ran at
  // 18.5 kB / 245 packets per 5 s interval. A hold that can never be released
  // is worse than no hold at all, so this watchdog releases it.
  Timer? _focusHoldWatchdog;
  Timer? _focusRouteRecoveryTimer;
  static const Duration _kFocusHoldMaxDuration = Duration(seconds: 6);

  /// Re-acquire Android's communication mode/focus and confirm the route after
  /// a focus hold is released. A route request by itself is not recovery: the
  /// production failure kept reporting `route_confirmed=false` after the old
  /// watchdog unmuted. This performs one bounded retry and emits the confirmed
  /// native result (or an explicit terminal unconfirmed event).
  Future<void> _recoverAudioAfterFocusRelease({
    required String reason,
    required int heldMs,
    int attempt = 1,
  }) async {
    if (_ended) return;
    _focusRouteRecoveryTimer?.cancel();
    _focusRouteRecoveryTimer = null;
    final requested = RemoteConfig.callAudioOwnerV1
        ? CallAudioController.instance.intent
        : (_speaker ? CallAudioRoute.speaker : CallAudioRoute.earpiece);
    var activeRoute = 'unknown';
    var routeConfirmed = false;
    String? recoveryError;
    final startedMs = DateTime.now().millisecondsSinceEpoch;
    try {
      // `beginP2pSession` is idempotent for the current call and therefore does
      // not request focus again. Re-running audio mode is the native operation
      // that actually re-acquires focus before the route is applied.
      if (NativeVoiceAudio.isSupported) {
        await NativeVoiceAudio.instance.startP2pAudioMode();
      }
      if (RemoteConfig.callAudioOwnerV1) {
        final result = await CallAudioController.instance.apply(
          source: attempt == 1 ? 'focus_$reason' : 'focus_${reason}_retry',
        );
        if (result != null) {
          activeRoute = result.active.name;
          routeConfirmed =
              result.exact && result.fallbackReason != 'invoke_failed';
        }
      } else if (RemoteConfig.callAudioControllerV2) {
        final result = await NativeVoiceAudio.instance.selectRoute(
          requested,
          source: attempt == 1 ? 'focus_$reason' : 'focus_${reason}_retry',
        );
        activeRoute = result.active.name;
        routeConfirmed =
            result.exact && result.fallbackReason != 'invoke_failed';
      } else {
        await Helper.setSpeakerphoneOn(_speaker);
        if (NativeVoiceAudio.isSupported) {
          await NativeVoiceAudio.instance.setSpeaker(_speaker);
          activeRoute =
              (await NativeVoiceAudio.instance.getAudioRoute()) ?? 'unknown';
          routeConfirmed = activeRoute == requested.name;
        }
      }
    } catch (e) {
      recoveryError = e.toString();
    }
    Analytics.capture('call_audio_focus_recovery_result', {
      'call_id': config.room,
      'reason': reason,
      'held_ms': heldMs,
      'attempt': attempt,
      'requested_route': requested.name,
      'active_route': activeRoute,
      'route_confirmed': routeConfirmed,
      'focus_reacquire_requested': NativeVoiceAudio.isSupported,
      'elapsed_ms': DateTime.now().millisecondsSinceEpoch - startedMs,
      if (recoveryError != null) 'error': recoveryError,
    });
    if (_ended || routeConfirmed) return;
    if (attempt == 1) {
      _focusRouteRecoveryTimer = Timer(const Duration(milliseconds: 1200), () {
        _focusRouteRecoveryTimer = null;
        unawaited(_recoverAudioAfterFocusRelease(
          reason: reason,
          heldMs: heldMs,
          attempt: 2,
        ));
      });
      return;
    }
    Analytics.capture('call_audio_focus_recovery_unconfirmed', {
      'call_id': config.room,
      'reason': reason,
      'held_ms': heldMs,
      'requested_route': requested.name,
      'active_route': activeRoute,
      'attempts': attempt,
    });
  }

  /// [CALL-FOCUS-DEADLOCK-1] Release a focus hold the platform is never going
  /// to lift on its own.
  ///
  /// Fires [_kFocusHoldMaxDuration] after `onAudioFocusLost` when no regain
  /// arrived. At that point the choice is between a permanently dead mic and
  /// resuming capture into a route the OS may have reassigned. Resuming wins:
  /// at worst the peer hears what they already hear (silence), and in the
  /// common case — the loss came from another player inside THIS app, which
  /// requests a plain AUDIOFOCUS_GAIN and so triggers a *permanent* loss on
  /// our own AUDIOFOCUS_GAIN_TRANSIENT holder — the route was never reassigned
  /// at all and audio simply comes back.
  ///
  /// Deliberately does NOT fire while a cellular call holds us
  /// ([_onCellularHold]): that hold belongs to the telephony monitor, which
  /// has its own resume signal, and un-muting into a live GSM call is the one
  /// case where staying muted is correct.
  void _releaseStuckFocusHold() {
    _focusHoldWatchdog = null;
    if (_ended || !_onFocusHold) return;
    if (_onCellularHold) return; // telephony owns this hold; it will resume us
    final heldMs = _focusLostMs == null
        ? 0
        : DateTime.now().millisecondsSinceEpoch - _focusLostMs!;
    _onFocusHold = false;
    _focusLostMs = null;
    onCellularHold.value = false;
    _applyLocalAudioEnabled();
    _send({'type': 'mute', 'muted': _muted});
    // [CALLHOLD-1] The watchdog is the ONLY release for a permanent
    // AUDIOFOCUS_LOSS (see the field doc above), so it is also the only thing
    // that can un-pause a recorder held by that focus hold. Without this line a
    // recording could stay paused for the rest of the call — the same
    // never-released latch this watchdog exists to break.
    _syncRecorderHold();
    // [CALL-FOCUS-REASSERT-1 2026-08-06] Un-muting is not enough — re-acquire
    // communication focus/mode and confirm the route too.
    //
    // The field doc above reasons that after a permanent AUDIOFOCUS_LOSS "the
    // route was never reassigned at all and audio simply comes back". That holds
    // when the loss came from another player inside this app. It does NOT hold
    // when another app took focus for real: Android reassigns the communication
    // device and drops us out of MODE_IN_COMMUNICATION, and nothing here ever
    // put us back — so capture resumed into a route that goes nowhere and the
    // call stayed silent while RTP kept flowing perfectly. Prod 2026-08-06
    // (avatok-c7cdc3ea, s.rgoavilla): `call_audio_focus_lost` 12:03:04.707 →
    // `watchdog_no_regain` 12:03:10.707, media_flow_state `rtp_flowing`
    // throughout, and roughly 30 s of one-way silence with no transport fault of
    // any kind. That is invisible to every recovery ladder we have, because
    // nothing is broken at the transport layer.
    //
    // The recovery helper reads the native result, retries once when it is not
    // confirmed, and emits an explicit terminal failure rather than leaving
    // subsequent `route_confirmed=false` health samples unexplained.
    unawaited(_recoverAudioAfterFocusRelease(
      reason: 'watchdog_no_regain',
      heldMs: heldMs,
    ));
    Analytics.capture('call_audio_focus_hold_released', {
      'call_id': config.room,
      'held_ms': heldMs,
      'reason': 'watchdog_no_regain',
      'route_reasserted': true,
      'route_recovery_started': true,
      'requested_route': _speaker ? 'speaker' : 'earpiece',
    });
    AvaLog.I.log('call',
        'focus hold released by watchdog after ${heldMs}ms — no AUDIOFOCUS_GAIN arrived');
  }

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

  /// [CALL-DEADPEER-1 2026-08-03] (audit H3) Keepalive pings sent with no
  /// inbound traffic seen since. Reset by ANY frame from the server, not only by
  /// a pong — any traffic at all proves the socket is alive, and counting a busy
  /// signalling channel as "missed pongs" would be a false positive.
  ///
  /// Resetting on any frame is a COMPLEMENT to the pong, not a substitute for
  /// it: mid-call the signalling WS is otherwise silent, because media flows over
  /// the WebRTC transport and not through here. Pongs are the only regular
  /// inbound traffic on an established call, which is precisely why their absence
  /// is diagnostic.
  int _missedPongs = 0;

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
    _mediaWatchTimer =
        Timer.periodic(const Duration(seconds: 5), (_) => _pollMediaWatchdog());
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
      double? availableOutgoingKbps;
      // [CALL-VIDEO-LOSS-1] Send-side video counters, cumulative from the
      // report; converted to a per-interval rate below.
      int? outVideoPacketsSent, outVideoPacketsLost;
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
          // [CALL-VIDEO-LOSS-1] SEND-side VIDEO loss, for the video degrader.
          // `packetsSent` is ours; the loss figure lives on the peer's RTCP
          // report, surfaced as `remote-inbound-rtp` below.
          if ((v['kind'] ?? v['mediaType'])?.toString() == 'video') {
            final ps = v['packetsSent'];
            if (ps is num) outVideoPacketsSent = ps.toInt();
          }
        } else if (s.type == 'remote-inbound-rtp') {
          // [CALL-VIDEO-LOSS-1] What the PEER reports losing on what WE sent.
          // This is the only loss signal that describes the direction the video
          // degrader actually controls.
          if ((v['kind'] ?? v['mediaType'])?.toString() == 'video') {
            final pl = v['packetsLost'];
            if (pl is num) outVideoPacketsLost = pl.toInt();
          }
        } else if (s.type == 'candidate-pair') {
          // Prefer the nominated/selected pair's RTT (seconds → ms).
          final selected = v['selected'] == true || v['nominated'] == true;
          final rtt = v['currentRoundTripTime'];
          if (selected && rtt is num)
            rttMs = (rtt.toDouble() * 1000).round();
          else if (rttMs < 0 && rtt is num)
            rttMs = (rtt.toDouble() * 1000).round();
          // [CALL-VIDEO-LOSS-1] Only the SELECTED pair's bandwidth estimate is
          // meaningful. This used to be last-one-wins across every pair, so on a
          // multi-pair connection the BWE could come from a pair carrying no
          // media at all — while the RTT read two lines above already filtered
          // correctly. Fall back to any pair only if nothing was nominated.
          final ao = v['availableOutgoingBitrate'];
          if (ao is num && ao > 0) {
            if (selected) {
              availableOutgoingKbps = ao.toDouble() / 1000.0;
            } else {
              availableOutgoingKbps ??= ao.toDouble() / 1000.0;
            }
          }
        }
      }
      _publishNetStats(
        totalRecvBytes: totalRecvBytes,
        totalSentBytes: totalSentBytes,
        packetsRecv: inboundPacketsRecv,
        packetsLost: inboundPacketsLost,
        rttMs: rttMs,
        availableOutgoingKbps: availableOutgoingKbps,
      );
      _qosLastAvailableOutKbps = availableOutgoingKbps;
      if (RemoteConfig.callQosAdaptV1) {
        unawaited(_adaptAudioSender(
          availableOutgoingKbps: availableOutgoingKbps,
          lossPct: inboundPacketsRecv + inboundPacketsLost == 0
              ? null
              : inboundPacketsLost *
                  100.0 /
                  (inboundPacketsRecv + inboundPacketsLost),
          rttMs: rttMs,
        ));
      }
      if (config.video && RemoteConfig.callVideoDegradeV1) {
        // [CALL-VIDEO-LOSS-1 2026-08-05] The degrader used to be fed a loss
        // ratio that was wrong in three independent ways, all of them biasing
        // it toward needlessly killing the camera:
        //
        //   1. CUMULATIVE since call start, so a burst in the first seconds
        //      permanently poisoned the ratio and could never decay enough to
        //      allow recovery (recovery needs loss < 1%).
        //   2. AUDIO-CONTAMINATED — `inboundPacketsLost/Recv` summed every
        //      inbound-rtp report regardless of kind, so audio loss throttled
        //      video and, because audio carries far more packets, it also
        //      diluted real video loss into invisibility.
        //   3. RECEIVE-side, used to throttle the SEND direction. Congestion is
        //      routinely asymmetric; what we receive says little about what our
        //      uplink can push.
        //
        // Now: per-interval, video-only, send-side — derived from the peer's
        // RTCP report (`remote-inbound-rtp`) against our own `packetsSent`.
        // Falls back to null (degrader holds its level) until two samples exist
        // or if the peer hasn't reported yet, rather than inventing a number.
        double? sendVideoLossPct;
        if (outVideoPacketsSent != null && outVideoPacketsLost != null) {
          final sentPrev = _lastOutVideoPacketsSent;
          final lostPrev = _lastOutVideoPacketsLost;
          if (sentPrev != null && lostPrev != null) {
            final dSent = outVideoPacketsSent - sentPrev;
            final dLost = outVideoPacketsLost - lostPrev;
            // Loss counters can go DOWN across an SSRC change (ICE restart,
            // relay migration, track replace). Treat a negative delta as a
            // baseline reset, never as negative loss.
            if (dSent > 0 && dLost >= 0) {
              sendVideoLossPct = (dLost * 100.0 / dSent).clamp(0.0, 100.0);
            }
          }
          _lastOutVideoPacketsSent = outVideoPacketsSent;
          _lastOutVideoPacketsLost = outVideoPacketsLost;
        }
        unawaited(
            _adaptVideoForNetwork(lossPct: sendVideoLossPct, rttMs: rttMs));
      }
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
              : ((DateTime.now().millisecondsSinceEpoch - _mediaStallStartMs!) /
                      1000)
                  .round();
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
          inboundAudioBytesDelta:
              prev == null ? null : inboundAudioBytes - prev,
        );
        _mediaStaleCount = 0;
        _mediaStalledFlagged = false;
        _mediaStallStartMs = null;
        return;
      }
      if (_mediaStaleCount == 1) {
        _mediaStallStartMs = DateTime.now().millisecondsSinceEpoch;
      }
      // [CALL-SURVIVE-1 2026-08-04] Trigger on the FIRST stale 5s interval,
      // not the second: with DTX off (CALL-AUDIT-DTX-1) a healthy inbound leg
      // ALWAYS advances bytes every interval, so one flat interval is already
      // a real stall — waiting 10s just added dead air to every handover.
      if (_mediaStaleCount == 1 && !_mediaStalledFlagged) {
        _mediaStalledFlagged = true;
        _mediaStalls++; // [CALL-RELSCORE-1] count distinct stall episodes
        Analytics.capture('call_media_stalled', {
          'call_id': config.room,
          'stale_s': 5,
          'video': config.video,
        });
        if (RemoteConfig.callIceRecoveryV2) {
          // [CALL-REL-5] The recovery coordinator owns phase + timers from
          // here (30s deadline from recovery START, not the watchdog's own
          // 20s stale-count clock — the REL-2 fix).
          // ignore: unawaited_futures
          _requestRecovery(RecoveryReason.transportDisconnected);
        } else {
          _setPhase('reconnecting');
          // ignore: unawaited_futures
          _tryIceRestart('media-stalled');
        }
      } else if (_mediaStaleCount >= 4) {
        Analytics.capture('call_media_stalled', {
          'call_id': config.room,
          'stale_s': 20,
          'video': config.video,
        });
        // [CALL-REL-5] Flag on: do nothing here. This 20s watchdog clock is
        // exactly the "hard-kill a call while an ICE restart is still in
        // flight" bug (REL-2) — termination is now owned solely by
        // [_recoveryDeadlineTimer] (30s from recovery START). Flag off:
        // unchanged prior behavior.
        if (!RemoteConfig.callIceRecoveryV2 && !_reconnecting) {
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

  // ── [CALL-REL-4] playout-aware media health, OBSERVE-ONLY ──────────────────
  // A SECOND, independent 5s sampler gated behind RemoteConfig.callPlayoutHealthV2.
  // It does NOT replace, read from, or influence [_pollMediaWatchdog] above —
  // that watchdog (and its recovery/end decisions) stays fully active and
  // unchanged in this commit. This sampler only classifies + reports (plan
  // §7.1/§7.2); nothing here can end a call or trigger a restart. CALL-REL-5
  // later reads [_lastPlayoutHealthClass] to decide when to act, behind its OWN
  // separate flag (callIceRecoveryV2).
  Timer? _playoutHealthTimer;
  MediaHealthClass _lastPlayoutHealthClass = MediaHealthClass.unknown;
  int? _phBytes, _phPackets, _phLost;
  int? _phJbufEmitted;
  double? _phJbufDelaySec;
  double? _phConcealed, _phSilentConcealed, _phTotalSamples;
  double? _phTotalAudioEnergy;
  // [CALL-MIC-OBS-1] Outbound (microphone) baselines — see the capture site.
  int? _phBytesSent, _phPacketsSent;
  double? _phOutboundAudioEnergy;
  // [CALL-VIDEO-LOSS-1] Send-side VIDEO packet baselines, so the degrader gets
  // a per-interval rate instead of a cumulative-since-call-start ratio.
  int? _lastOutVideoPacketsSent, _lastOutVideoPacketsLost;
  int _noRtpStreak = 0;
  int _noPlayoutStreak = 0;
  // [CF-CALL-P2P-1] Extends this sampler with inbound-VIDEO decode/render
  // confirmation for 1:1 video calls (proposal Phase 5: "video decode/render
  // confirmation telemetry" — same 5s sampler, same flag gate, additive).
  int? _phVideoBytes, _phVideoFramesDecoded, _phVideoFramesDropped;
  bool _firstRemoteVideoFrameReported = false;
  bool _firstRemoteVideoTrackReported = false;
  bool _firstRemoteVoiceEnergyReported = false;

  // [CALL-REL-5] Recovery evidence (two consecutive healthy playout samples)
  // depends on this sampler, so callIceRecoveryV2 also starts it even if the
  // observe-only flag is off. callPlayoutHealthV2 alone still runs the exact
  // same observe-only sampler as CALL-REL-4 introduced.
  // [CALL-REL-6 SHOULD-FIX-3] callRelayMigrationV1 also needs it running: an
  // INBOUND migration (we're the receiver, answering a peer's
  // relay-migrate-offer) can start with callRelayMigrationV1 on but
  // callIceRecoveryV2/callPlayoutHealthV2 off, and [_onPlayoutHealthForMigration]
  // has nothing to validate the new PC's playout against without this sampler.
  bool get _playoutSamplerWanted =>
      RemoteConfig.callPlayoutHealthV2 ||
      RemoteConfig.callIceRecoveryV2 ||
      RemoteConfig.callRelayMigrationV1;

  /// Drop every cumulative stat and recovery streak whenever the active peer
  /// connection changes. Stats counters belong to a PC generation; carrying
  /// them across an SFU reconnect (or any migration) makes the first sample
  /// look unhealthy because it is compared with the old connection's totals.
  void _resetPlayoutHealthBaselines() {
    _phBytes = _phPackets = _phLost = null;
    _phJbufEmitted = null;
    _phJbufDelaySec = null;
    _phConcealed = _phSilentConcealed = _phTotalSamples = null;
    _phTotalAudioEnergy = null;
    _phBytesSent = _phPacketsSent = null;
    _phOutboundAudioEnergy = null;
    _lastOutVideoPacketsSent = _lastOutVideoPacketsLost = null;
    _phVideoBytes = _phVideoFramesDecoded = _phVideoFramesDropped = null;
    _firstRemoteVideoFrameReported = false;
    _firstRemoteVideoTrackReported = false;
    _noRtpStreak = 0;
    _noPlayoutStreak = 0;
    _relayThresholdStreak = 0;
    _lastPlayoutHealthClass = MediaHealthClass.unknown;
  }

  void _startPlayoutHealthSampler() {
    if (!_playoutSamplerWanted) return;
    _playoutHealthTimer?.cancel();
    _resetPlayoutHealthBaselines();
    _playoutHealthTimer =
        Timer.periodic(const Duration(seconds: 5), (_) => _pollPlayoutHealth());
  }

  void _stopPlayoutHealthSampler() {
    _playoutHealthTimer?.cancel();
    _playoutHealthTimer = null;
  }

  /// [CALL-VOL-AUDIBLE-1] At or below this fraction of the device maximum, the
  /// in-call stream is quiet enough that "I can't hear them" is expected. 0.2
  /// is the Android emulator's own default (3 of 15).
  static const double _lowCallVolumeRatio = 0.2;

  /// [CALL-VOL-AUDIBLE-1] One report per call. The diagnostics that feed it
  /// fire every 5s, and a user who never touches the rocker would otherwise
  /// emit this on every sample for the whole call.
  bool _lowCallVolumeReported = false;

  void _emitAudioDiagnostics(
    Map<String, dynamic>? native, {
    double? micAudioLevel,
    double? micEnergyDelta,
    int? audioBytesSentDelta,
    int? jitterBufferEmittedDelta,
  }) {
    final props = <String, Object>{
      'call_id': config.room,
      'provider': _performanceProvider,
      'role': _performanceRole,
      'media_mode': config.video ? 'video' : 'audio',
      'user_muted': _muted,
      'focus_held': _onFocusHold,
      'cellular_held': _onCellularHold,
      'user_hold': _userHold,
      'effective_mic_enabled':
          !_muted && !_userHold && !_onFocusHold && !_onCellularHold,
      'route_usable': _streamRtcActive ||
          _rtkActive ||
          !RemoteConfig.callAudioOwnerV1 ||
          CallAudioController.instance.hasUsableConfirmedRoute,
      'confirmed_route': _streamRtcActive
          ? 'stream_sdk'
          : (_rtkActive
              ? 'realtimekit_sdk'
              : CallAudioController.instance.confirmedRouteName),
      'playout_underrun_observable': false,
      if (micAudioLevel != null) 'mic_audio_level': micAudioLevel,
      if (micEnergyDelta != null) 'mic_energy_delta': micEnergyDelta,
      if (audioBytesSentDelta != null)
        'audio_bytes_sent_delta': audioBytesSentDelta,
      if (jitterBufferEmittedDelta != null)
        'jitter_buffer_emitted_delta': jitterBufferEmittedDelta,
      if (jitterBufferEmittedDelta != null)
        'playout_stall_observed': jitterBufferEmittedDelta <= 0,
    };
    const allowedNative = <String>{
      'available',
      'audio_mode',
      'audio_mode_value',
      'active_route',
      'communication_device_type',
      'output_device_types',
      'input_device_types',
      'mic_muted',
      'speakerphone_on',
      'voice_volume',
      'voice_volume_max',
      'music_volume',
      'music_volume_max',
      'native_output_sample_rate',
      'native_frames_per_buffer',
      'native_focus_owner_inferred',
      'native_focus_requested_by_avatok',
    };
    for (final key in allowedNative) {
      final value = native?[key];
      if (value != null) props[key] = value as Object;
    }
    Analytics.capture('call_audio_diagnostics', props);
    _reportLowCallVolume(props);
  }

  /// [CALL-VOL-AUDIBLE-1 2026-08-21] "I could not hear them" has one cause the
  /// app already had the number for and never looked at: the Android
  /// STREAM_VOICE_CALL index. `push_service` does exactly this check for the
  /// RINGER (`ring_volume == 0` feeds a "could not have rung audibly"
  /// determination) but nothing did it for the call itself, so a call played
  /// out at 3/15 looked identical in telemetry to one at 15/15 — healthy
  /// transport, RTP flowing, jitter buffer emitting, and a user who hears
  /// nothing. On 2026-08-20 that cost a debugging session.
  ///
  /// The app never WRITES this stream (there is no `setStreamVolume` anywhere
  /// in the repo, deliberately — silently overriding someone's call volume can
  /// deafen them). So this only observes, once per call, and leaves the fix to
  /// the person holding the volume rocker.
  void _reportLowCallVolume(Map<String, Object> props) {
    if (_lowCallVolumeReported) return;
    final level = props['voice_volume'];
    final max = props['voice_volume_max'];
    if (level is! num || max is! num || max <= 0) return;
    final ratio = level / max;
    if (ratio > _lowCallVolumeRatio) return;
    _lowCallVolumeReported = true;
    Analytics.capture('call_volume_low', {
      'call_id': config.room,
      'role': _performanceRole,
      'voice_volume': level,
      'voice_volume_max': max,
      'ratio': double.parse(ratio.toStringAsFixed(3)),
      'silent': level == 0,
      'confirmed_route': props['confirmed_route'] ?? 'unknown',
      'speakerphone_on': props['speakerphone_on'] ?? false,
      // An emulator ships at 3/15 with no earpiece; a real phone at 3/15 is a
      // user who turned it down. Keep them apart or this event becomes noise.
      'output_device_types': props['output_device_types'] ?? 'unknown',
    });
  }

  // ── [CALL-DEADAIR-1 2026-08-08] first-audio probe ──────────────────────────
  //
  // WHY A SECOND SAMPLER EXISTS AT ALL. The playout health sampler above is a 5s
  // PERIODIC armed at connect, so the earliest it can report inbound bytes is
  // connect+5s and the latest is connect+10s. Every existing statement about how
  // long a call is silent — including the 14s on avatok-17f145b5 — is therefore
  // quantised to 5s and biased upward by up to a full period. You cannot fix a
  // latency you can only measure to ±5s, and you certainly cannot assert a
  // sub-1000ms success value against it.
  //
  // This probe runs at 200ms until it sees the FIRST inbound audio byte, then
  // stops. Its whole life is a few seconds at the very start of a call, so it
  // costs nothing for the other 99% of the call — unlike widening the 5s
  // sampler, which would pay that cost forever.
  Timer? _firstAudioProbe;
  bool _firstAudioReported = false;
  bool _firstOutboundAudioReported = false;
  int _firstAudioProbeStartMs = 0;
  static const Duration _kFirstAudioProbeInterval = Duration(milliseconds: 200);

  /// Give up and report `got_audio:false` after this long. A call that never
  /// produces audio MUST still emit the event — "no event" and "no audio" would
  /// otherwise be indistinguishable, which is precisely the failure the ship
  /// gate's rule 3 exists to stop.
  static const Duration _kFirstAudioProbeMax = Duration(seconds: 25);

  /// [CALL-DEADAIR-1 (c)] Honest media state for the UI: `_connected` (and the
  /// 'connected' phase) means "a remote track object arrived", which on the SFU
  /// path can be true while not one byte of audio has been decoded. This is the
  /// state a screen should render "Connecting audio…" from rather than showing a
  /// live call with silence. NOT wired to any widget here on purpose — the call
  /// screen is owned elsewhere; this exposes the signal for it.
  final ValueNotifier<bool> audioFlowing = ValueNotifier<bool>(false);

  void _startFirstAudioProbe() {
    if (!RemoteConfig.callFirstAudioProbeV1) return;
    if (_firstAudioReported || _firstAudioProbe != null) return;
    _firstAudioProbeStartMs = DateTime.now().millisecondsSinceEpoch;
    _firstAudioProbe =
        Timer.periodic(_kFirstAudioProbeInterval, (_) => _pollFirstAudio());
    // Probe immediately too — on a healthy SFU pull the bytes can already be
    // there by the time `onTrack` fires, and waiting 200ms to find that out
    // would bake an error into the very number we are trying to minimise.
    unawaited(_pollFirstAudio());
  }

  void _stopFirstAudioProbe() {
    _firstAudioProbe?.cancel();
    _firstAudioProbe = null;
  }

  Future<void> _pollFirstAudio() async {
    if (_firstAudioReported) {
      _stopFirstAudioProbe();
      return;
    }
    final pc = _pc;
    if (pc == null) return;
    var bytes = 0;
    var found = false;
    try {
      final stats = await pc.getStats();
      for (final s in stats) {
        final v = s.values;
        final kind = (v['kind'] ?? v['mediaType'])?.toString();
        if (kind != 'audio') continue;
        if (s.type == 'outbound-rtp' && !_firstOutboundAudioReported) {
          final sent = v['bytesSent'];
          if (sent is num && sent > 0) {
            _firstOutboundAudioReported = true;
            final now = DateTime.now().millisecondsSinceEpoch;
            Analytics.capture('call_local_first_audio_published', {
              'call_id': config.room,
              'call_trace_id': _traceId,
              'provider': _performanceProvider,
              'role': _performanceRole,
              'media_mode': config.video ? 'video' : 'audio',
              'bytes_sent': sent.toInt(),
              'ms_from_start': _setupT0 == 0 ? -1 : now - _setupT0,
              if (_answerAtMs != null) 'ms_from_answer': now - _answerAtMs!,
            });
          }
          continue;
        }
        if (s.type != 'inbound-rtp') continue;
        found = true;
        final b = v['bytesReceived'];
        if (b is num && b.toInt() > bytes) bytes = b.toInt();
      }
    } catch (_) {
      return; // a stats read can fail mid-renegotiation; the next tick retries
    }
    if (found && bytes > 0) {
      _reportFirstAudio(bytes: bytes, outcome: 'audio');
      return;
    }
    if (DateTime.now().millisecondsSinceEpoch - _firstAudioProbeStartMs >=
        _kFirstAudioProbeMax.inMilliseconds) {
      _reportFirstAudio(bytes: bytes, outcome: 'timeout');
    }
  }

  /// Emit `call_first_audio_ms` exactly once per call.
  ///
  /// `ms_from_connected` is THE number this issue is judged on (target < 1000).
  /// `ms_from_start` is the user-perceived figure — it includes ring time on an
  /// outgoing call, so the two are not interchangeable and both are carried.
  void _reportFirstAudio({required int bytes, required String outcome}) {
    if (_firstAudioReported) return;
    _firstAudioReported = true;
    _stopFirstAudioProbe();
    final now = DateTime.now().millisecondsSinceEpoch;
    if (outcome == 'audio') {
      _stage('first_audio_bytes');
      audioFlowing.value = true;
    }
    final props = <String, Object>{
      'call_id': config.room,
      'call_trace_id': _traceId,
      'provider': _performanceProvider,
      'role': _performanceRole,
      'media_mode': config.video ? 'video' : 'audio',
      'outcome': outcome, // 'audio' | 'timeout' | 'ended'
      'got_audio': outcome == 'audio',
      'bytes_received': bytes,
      'ms_from_start': _setupT0 == 0 ? -1 : now - _setupT0,
      'ms_from_connected': _connectedAtMs == 0 ? -1 : now - _connectedAtMs,
      if (_answerAtMs != null) 'ms_from_answer': now - _answerAtMs!,
      // [CALL-RTK-4] 'rtk' is checked FIRST: an RTK call has no `_pc` at all, so
      // without this arm it would report as 'none'/'direct' — a media path that
      // is not the one carrying the audio.
      'media_path': _streamRtcActive
          ? 'stream'
          : (_rtkActive
              ? 'rtk'
              : (_sfuActive
                  ? 'sfu'
                  : (_relayForced
                      ? 'relay'
                      : (_connected ? 'direct' : 'none')))),
      'outgoing': config.outgoing,
      'video': config.video,
      if (config.seed.isNotEmpty) 'peer_uid': config.seed,
    };
    // Flatten the ladder. One property per rung keeps every stage independently
    // filterable/averagable in PostHog — a single JSON blob property would need
    // to be unpacked by hand in every query.
    _setupStages.forEach((k, v) => props['stage_$k'] = v);
    props['stages_seen'] = _setupStages.keys.join(',');
    Analytics.capture('call_first_audio_ms', props);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  [CALL-AUDIBLE-1 2026-08-17] Honest user-visible "connected" state.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // `_connected` above keeps its exact, unchanged meaning — "a remote track
  // object arrived" — and every timer/watchdog/teardown side effect it drives
  // is untouched. This section adds a NEW, LATER, purely-presentational
  // milestone that the UI reads instead: [audibleReady]. It only flips once
  // real inbound audio is confirmed, reusing the first-audio probe above
  // (`audioFlowing` / `_reportFirstAudio`) rather than a second stats poller.
  // Never gated on `audioLevel` — a silent caller must still reach it.
  //
  // Route readiness (the PLAN doc's second half of the "connected" formula —
  // audio route/session confirmed) is deliberately NOT separately gated here.
  // `CallAudioController.apply(source: 'boot_media')` runs during `_bootMedia`
  // — before ICE, before the peer connection, and therefore always before
  // `onTrack`/RTK-connect can fire — and its only completion signal is the
  // single-slot `onRouteConfirmed` callback `_bootMedia` already installs
  // (see [CALL-AUDIO-OWNER-1] above). Claiming that slot a second time here
  // would race the existing wiring for no observable benefit, since by the
  // time [audibleReady] can even be evaluated the route has already settled.
  // So route-readiness is treated as satisfied by construction.

  /// User-visible "the call is actually audible" truth. UI (call_screen.dart,
  /// the minimized [CallAudioPill]) shows "Connecting audio…" and withholds
  /// the running call timer while `_connected` is true but this is false.
  ///
  /// Flag OFF ([RemoteConfig.callAudibleStateV1]): mirrors `_connected`
  /// immediately — no UI change from today.
  final ValueNotifier<bool> audibleReady = ValueNotifier<bool>(false);

  /// Safety backstop for paths with no `getStats()` evidence — RealtimeKit
  /// (`_rtkActive`, no `_pc` at all) and, defensively, any future path that
  /// reaches `_connected` without a `_pc`. RTK's own `remoteJoin` backstop
  /// (`_onRtkConnected` via that event) never calls `_reportFirstAudio`, so
  /// without this timer a call that only ever fires `remoteJoin` — the peer
  /// was already publishing before we joined — would never flip
  /// [audibleReady] and would show "Connecting audio…" forever.
  ///
  /// Deliberately NOT applied to the SFU/P2P (`_pc`) path: there the real
  /// first-audio probe (`_pollFirstAudio`, up to 25s) is the ground truth,
  /// and a 4s override would mask exactly the 12-16s gap this issue exists to
  /// surface.
  static const Duration _kAudibleSafetyTimeout = Duration(seconds: 4);
  Timer? _audibleSafetyTimer;

  /// Guards the `audioFlowing.addListener` below from being installed twice.
  /// `_armAudibleGate` is called from `_handleRemoteTrack`, which can run
  /// again for a second track (e.g. video arriving after audio) on the same
  /// connect — without this, a second call would register the SAME listener
  /// function a second time, and `ChangeNotifier` does not de-dupe, so
  /// `_markAudibleReady` would fire (harmlessly, thanks to its own
  /// `audibleReady.value` guard) but leave the listener double-registered
  /// until removal, which only removes one instance.
  bool _audibleGateArmed = false;
  bool _audibleRouteRecoveryInFlight = false;
  int _audibleRouteRecoveryAttempts = 0;

  // ─────────────────────────────────────────────────────────────────────────
  //  [CALL-AUDIBLE-2 2026-08-18] Real PLAYOUT evidence for the `_pc` path.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // `audioFlowing` (fed by `_pollFirstAudio`'s `bytesReceived` check) proves
  // packets ARRIVED at the peer connection — not that the decoder emitted a
  // single sample or that anything left the speaker; decoder + jitter-buffer
  // delay come after bytes land. This probe polls the SAME `pc.getStats()`
  // inbound-rtp AUDIO row for `totalSamplesReceived` (falling back to
  // `jitterBufferEmittedCount` when the former is absent) — a counter that
  // only increases once the jitter buffer has actually handed samples to the
  // decoder/output path, which is the closest signal WebRTC exposes to "sound
  // left the speaker". Two consecutive increasing samples (not one) is the
  // bar, matching the review requirement — a single non-zero read can be a
  // stale/cached stats snapshot.
  //
  // NEVER gated on `audioLevel`/any voice-activity measure — a silent caller
  // must still reach [audibleReady]; a flat-zero level is legitimate silence,
  // not "not audible".
  Timer? _audiblePlayoutProbe;
  static const Duration _kAudiblePlayoutProbeInterval =
      Duration(milliseconds: 200);
  int? _lastPlayoutSamples;
  int _audiblePlayoutAttempts = 0;

  /// Tri-state: `null` = not yet determined (no inbound-rtp audio row seen
  /// yet, or seen but no numeric counter read so far), `true` = this
  /// platform/browser reports the counter, `false` = confirmed absent (an
  /// audio row was read and neither `totalSamplesReceived` nor
  /// `jitterBufferEmittedCount` was a number) — the only state that permits
  /// [_onAudioFlowingForGate] to fall back to bytes evidence.
  bool? _playoutCountersSupported;

  /// Bound on how long the pc-path playout probe waits to even determine
  /// [_playoutCountersSupported] before giving up and allowing the bytes
  /// fallback anyway (`~3s` at the 200ms interval) — protects against a
  /// `getStats()` shape this probe doesn't recognise at all (no inbound-rtp
  /// audio row ever appears) leaving [audibleReady] stuck forever despite
  /// bytes genuinely flowing.
  static const int _kAudiblePlayoutMaxAttemptsBeforeFallback = 15;

  void _startAudiblePlayoutProbe() {
    if (_audiblePlayoutProbe != null) return;
    _audiblePlayoutAttempts = 0;
    _audiblePlayoutProbe = Timer.periodic(
        _kAudiblePlayoutProbeInterval, (_) => _pollAudiblePlayout());
    unawaited(_pollAudiblePlayout());
  }

  void _stopAudiblePlayoutProbe() {
    _audiblePlayoutProbe?.cancel();
    _audiblePlayoutProbe = null;
  }

  Future<void> _pollAudiblePlayout() async {
    if (_ended || audibleReady.value) {
      _stopAudiblePlayoutProbe();
      return;
    }
    final pc = _pc;
    if (pc == null) {
      _stopAudiblePlayoutProbe();
      return;
    }
    _audiblePlayoutAttempts++;
    var sawAudioRow = false;
    try {
      final stats = await pc.getStats();
      for (final s in stats) {
        if (s.type != 'inbound-rtp') continue;
        final v = s.values;
        final kind = (v['kind'] ?? v['mediaType'])?.toString();
        if (kind != 'audio') continue;
        sawAudioRow = true;
        final samplesRaw =
            v['totalSamplesReceived'] ?? v['jitterBufferEmittedCount'];
        if (samplesRaw is num) {
          _playoutCountersSupported = true;
          final samples = samplesRaw.toInt();
          final prev = _lastPlayoutSamples;
          _lastPlayoutSamples = samples;
          if (prev != null && samples > prev) {
            _markAudibleReady(
                viaTimeout: false, flagOff: false, evidence: 'playout');
            return;
          }
        } else {
          // An audio row exists but neither counter is present — this
          // platform genuinely does not report playout counters.
          _playoutCountersSupported ??= false;
        }
        break;
      }
    } catch (_) {
      return; // a stats read can fail mid-renegotiation; the next tick retries
    }
    // Bytes are already flowing and this probe has confirmed (or, after a
    // bound, given up trying to confirm) it cannot supply playout evidence —
    // let the bytes-fallback path in `_onAudioFlowingForGate` proceed rather
    // than leaving `audibleReady` stuck forever on a platform this probe
    // doesn't understand.
    if (audioFlowing.value &&
        _playoutCountersSupported == null &&
        (!sawAudioRow) &&
        _audiblePlayoutAttempts >= _kAudiblePlayoutMaxAttemptsBeforeFallback) {
      _playoutCountersSupported = false;
      _markAudibleReady(
          viaTimeout: false, flagOff: false, evidence: 'bytes_fallback');
    }
  }

  /// Call once, right after `_connected = true` (both sites: `onTrack`'s
  /// connected block and `_onRtkConnected`). Idempotent and inert once
  /// [audibleReady] has already flipped or the call has ended.
  void _armAudibleGate() {
    if (_ended) return;
    if (!RemoteConfig.callAudibleStateV1) {
      // Flag off: mirror `_connected` immediately. No new UI behaviour.
      _markAudibleReady(viaTimeout: false, flagOff: true, evidence: 'flag_off');
      return;
    }
    if (audibleReady.value || _audibleGateArmed) return;
    _audibleGateArmed = true;
    audioFlowing.addListener(_onAudioFlowingForGate);
    final noStatsPath = _streamRtcActive || _rtkActive || _pc == null;
    if (noStatsPath) {
      // RealtimeKit (and any future no-`_pc` path): there is no `getStats()`
      // to poll for playout, so a real remote AUDIO track event
      // (`audioTrackAdded` → `audioFlowing`, see [_onRtkEvent]) is the
      // strongest evidence available, with a bounded timeout backstop.
      if (audioFlowing.value) {
        _markAudibleReady(
            viaTimeout: false, flagOff: false, evidence: 'rtk_track');
        return;
      }
      // Stream emits `first_audio_playout` only after decoded/jitter-buffer
      // samples exist AND Android confirms an output route. Do not let a timer
      // turn a remote-join or RTP-only event into a false healthy call.
      if (_streamRtcActive) return;
      _audibleSafetyTimer?.cancel();
      _audibleSafetyTimer = Timer(_kAudibleSafetyTimeout, () {
        if (_ended || audibleReady.value) return;
        _markAudibleReady(
            viaTimeout: true, flagOff: false, evidence: 'timeout');
      });
    } else {
      // [CALL-AUDIBLE-2] SFU/P2P `_pc` path: playout evidence is the ground
      // truth. Bytes (`audioFlowing`) is used only once the playout probe
      // has confirmed its counters are absent on this platform — see
      // `_onAudioFlowingForGate` and `_pollAudiblePlayout`.
      _startAudiblePlayoutProbe();
      if (audioFlowing.value && _playoutCountersSupported == false) {
        _markAudibleReady(
            viaTimeout: false, flagOff: false, evidence: 'bytes_fallback');
      }
    }
  }

  void _onAudioFlowingForGate() {
    if (!audioFlowing.value) return;
    final noStatsPath = _streamRtcActive || _rtkActive || _pc == null;
    if (noStatsPath) {
      _markAudibleReady(
          viaTimeout: false, flagOff: false, evidence: 'rtk_track');
      return;
    }
    // pc path: only accept bytes evidence once the playout probe has
    // confirmed it cannot supply real playout counters — never as a
    // shortcut past real evidence that is still in flight.
    if (_playoutCountersSupported == false) {
      _markAudibleReady(
          viaTimeout: false, flagOff: false, evidence: 'bytes_fallback');
    }
  }

  void _markAudibleReady({
    required bool viaTimeout,
    required bool flagOff,
    required String
        evidence, // 'playout' | 'bytes_fallback' | 'rtk_track' | 'timeout' | 'flag_off'
  }) {
    if (audibleReady.value) return;
    // RTP/jitter-buffer progress is necessary but not sufficient. The native
    // platform must also have confirmed a usable output route; otherwise a
    // perfectly healthy packet stream can still be silent to the person.
    if (!flagOff &&
        !_streamRtcActive &&
        !_rtkActive &&
        RemoteConfig.callAudioOwnerV1 &&
        !CallAudioController.instance.hasUsableConfirmedRoute) {
      if (!_audibleRouteRecoveryInFlight && _audibleRouteRecoveryAttempts < 2) {
        _audibleRouteRecoveryInFlight = true;
        _audibleRouteRecoveryAttempts++;
        final attempt = _audibleRouteRecoveryAttempts;
        Analytics.capture('call_audible_route_recovery_started', {
          'call_id': config.room,
          'attempt': attempt,
          'playout_evidence': evidence,
          'confirmed_route': CallAudioController.instance.confirmedRouteName,
        });
        unawaited(() async {
          try {
            await CallAudioController.instance.apply(
              source: 'audible_gate_recovery_$attempt',
            );
          } finally {
            _audibleRouteRecoveryInFlight = false;
          }
          if (_ended || audibleReady.value) return;
          if (CallAudioController.instance.hasUsableConfirmedRoute) {
            _markAudibleReady(
              viaTimeout: viaTimeout,
              flagOff: flagOff,
              evidence: '${evidence}_route_recovered',
            );
          } else if (attempt >= 2) {
            Analytics.capture('call_audible_route_unconfirmed', {
              'call_id': config.room,
              'attempts': attempt,
              'playout_evidence': evidence,
              'confirmed_route':
                  CallAudioController.instance.confirmedRouteName,
            });
          }
        }());
      }
      return;
    }
    audibleReady.value = true;
    _audibleSafetyTimer?.cancel();
    _audibleSafetyTimer = null;
    _stopAudiblePlayoutProbe();
    if (_audibleGateArmed) {
      audioFlowing.removeListener(_onAudioFlowingForGate);
      _audibleGateArmed = false;
    }
    if (!flagOff) {
      final now = DateTime.now().millisecondsSinceEpoch;
      final props = <String, Object>{
        'call_id': config.room,
        'call_trace_id': _traceId,
        'provider': _performanceProvider,
        'role': _performanceRole,
        'media_mode': config.video ? 'video' : 'audio',
        'ms_from_connected': _connectedAtMs == 0 ? -1 : now - _connectedAtMs,
        'ms_from_start': _setupT0 == 0 ? -1 : now - _setupT0,
        if (_answerAtMs != null) 'ms_from_answer': now - _answerAtMs!,
        'media_path': _streamRtcActive
            ? 'stream'
            : (_rtkActive
                ? 'rtk'
                : (_sfuActive
                    ? 'sfu'
                    : (_relayForced
                        ? 'relay'
                        : (_connected ? 'direct' : 'none')))),
        'outgoing': config.outgoing,
        'video': config.video,
        // [CALL-AUDIBLE-2] Which signal actually fired, so PostHog can prove
        // the milestone is playout-backed rather than merely "an event
        // arrived" (ship-gate rule 3).
        'evidence': evidence,
        'route_usable': _streamRtcActive ||
            _rtkActive ||
            !RemoteConfig.callAudioOwnerV1 ||
            CallAudioController.instance.hasUsableConfirmedRoute,
        'confirmed_route': _streamRtcActive
            ? 'stream_sdk'
            : (_rtkActive
                ? 'realtimekit_sdk'
                : CallAudioController.instance.confirmedRouteName),
      };
      Analytics.capture(
          viaTimeout ? 'call_audible_timeout' : 'call_audible_ready', props);
      _emitSetupSummary(viaTimeout ? 'audible_timeout' : 'audible_ready');
    }
    // [CALL-AUDIBLE-1] The connection haptic moves here from the `_connected`
    // block(s) — it is UI feedback, not one of the load-bearing side effects
    // (timers/watchdogs/teardown) that block must keep doing unchanged. With
    // the flag off this fires synchronously (mirroring `_connected`), so the
    // haptic's timing is byte-for-byte what it was before this issue. With
    // the flag on it lands when the call is actually audible, not 12-16s
    // early — no telemetry for the flag-off shim, since it measures nothing.
    HapticFeedback.mediumImpact();
  }

  Future<void> _pollPlayoutHealth() async {
    if (!_playoutSamplerWanted) return;
    try {
      if (_ended || !_connected) return;
      if (isReceptDuo || _onCellularHold) return;
      // [CALL-REL-6] Once a migration's new PC has produced a remote track,
      // sample IT (not the old `_pc`) — completion is judged on the new PC's
      // own playout, per plan §7.4.5.
      final migratingPc = _activeMigration?.newPc;
      final sampleMigration = migratingPc != null &&
          !(_activeMigration?.completed ?? true) &&
          (_activeMigration?.remoteTrackSeen ?? false);
      final pc = sampleMigration ? migratingPc : _pc;
      if (pc == null) return;
      final nowMs = DateTime.now().millisecondsSinceEpoch;

      int? bytesReceived, packetsReceived, packetsLost;
      double? jitterSec, audioLevel, totalAudioEnergy;
      // [CALL-MIC-OBS-1] OUTBOUND audio — "is my own mic alive?".
      //
      // Every other number in this sampler describes the INBOUND stream, so the
      // telemetry could say "I can't hear them" but never "they can't hear me".
      // On 2026-08-04 that gap cost an entire investigation: the emulator sent a
      // flawless RTP stream (250 packets / 5 s, 0% concealment) carrying nothing
      // but silence, and proving the microphone was the source required reading
      // logcat on the device by hand. `outbound-rtp` + the local media-source
      // stat answer it directly, so a dead mic is now a PostHog query.
      int? audioBytesSent, audioPacketsSent;
      double? outboundAudioLevel, outboundTotalAudioEnergy;
      bool foundOutboundAudio = false;
      int? jbufEmitted;
      double? jbufDelaySec;
      double? concealedSamples, silentConcealedSamples, totalSamplesReceived;
      int? lastPacketReceivedTsMs;
      String? candidatePairId, localCandType, remoteCandType, relayProtocol;
      bool foundInboundAudio = false;
      // [CF-CALL-P2P-1] Inbound-VIDEO decode counters, video calls only.
      bool foundInboundVideo = false;
      int? videoBytesReceived, videoFramesDecoded, videoFramesDropped;
      // [CALL-VIDEO-RENDER-WATCH-1] Which TRACK the decoding stats belong to —
      // the discriminator between "video is broken" and "video is fine but the
      // renderer is showing a stale track" (prod 2026-08-08, avatok-b403ba59:
      // 30fps decoded for 9 minutes while the screen held one frozen frame).
      String? videoTrackIdentifier;

      final stats = await pc.getStats();
      final pairs = <String, Map<dynamic, dynamic>>{};
      final locals = <String, Map<dynamic, dynamic>>{};
      final remotes = <String, Map<dynamic, dynamic>>{};
      String? selectedPairId;
      for (final s in stats) {
        final v = s.values;
        if (s.type == 'inbound-rtp') {
          final kind = (v['kind'] ?? v['mediaType'])?.toString();
          if (kind == 'video') {
            // [CF-CALL-P2P-1] video decode/render confirmation — only sampled
            // for video calls; harmless no-op (never observed) on audio calls.
            if (config.video) {
              foundInboundVideo = true;
              final vb = v['bytesReceived'];
              if (vb is num) videoBytesReceived = vb.toInt();
              final fd = v['framesDecoded'];
              if (fd is num) videoFramesDecoded = fd.toInt();
              final fdr = v['framesDropped'];
              if (fdr is num) videoFramesDropped = fdr.toInt();
              // [CALL-VIDEO-RENDER-WATCH-1] Prefer the ACTIVE inbound stream's
              // track id when several exist: keep the one whose framesDecoded
              // moved (this loop may see a dead m-section first).
              final ti = (v['trackIdentifier'] ?? v['trackId'])?.toString();
              if (ti != null &&
                  ti.isNotEmpty &&
                  (videoTrackIdentifier == null ||
                      (fd is num && fd.toInt() > 0))) {
                videoTrackIdentifier = ti;
              }
            }
            continue;
          }
          if (kind != 'audio') continue;
          foundInboundAudio = true;
          final b = v['bytesReceived'];
          if (b is num) bytesReceived = b.toInt();
          final pr = v['packetsReceived'];
          if (pr is num) packetsReceived = pr.toInt();
          final pl = v['packetsLost'];
          if (pl is num) packetsLost = pl.toInt();
          final j = v['jitter'];
          if (j is num) jitterSec = j.toDouble();
          final al = v['audioLevel'];
          if (al is num) audioLevel = al.toDouble();
          final tae = v['totalAudioEnergy'];
          if (tae is num) totalAudioEnergy = tae.toDouble();
          final jbe = v['jitterBufferEmittedCount'];
          if (jbe is num) jbufEmitted = jbe.toInt();
          final jbd = v['jitterBufferDelay'];
          if (jbd is num) jbufDelaySec = jbd.toDouble();
          final cs = v['concealedSamples'];
          if (cs is num) concealedSamples = cs.toDouble();
          final scs = v['silentConcealedSamples'];
          if (scs is num) silentConcealedSamples = scs.toDouble();
          final tsr = v['totalSamplesReceived'];
          if (tsr is num) totalSamplesReceived = tsr.toDouble();
          final lprt = v['lastPacketReceivedTimestamp'];
          if (lprt is num) lastPacketReceivedTsMs = lprt.toInt();
        } else if (s.type == 'outbound-rtp') {
          // [CALL-MIC-OBS-1] Bytes/packets we are PUTTING ON THE WIRE.
          final kind = (v['kind'] ?? v['mediaType'])?.toString();
          if (kind != 'audio') continue;
          foundOutboundAudio = true;
          final b = v['bytesSent'];
          if (b is num) audioBytesSent = b.toInt();
          final ps = v['packetsSent'];
          if (ps is num) audioPacketsSent = ps.toInt();
        } else if (s.type == 'media-source') {
          // [CALL-MIC-OBS-1] THE mic-alive signal. `media-source` is the local
          // capture BEFORE encoding, so its audioLevel is what the microphone
          // is actually picking up — independent of the network, the codec, RED
          // and DTX. A live mic in a quiet room reads ~1e-3..1e-2 and jumps to
          // ~0.1-0.8 on speech; a mic handed silence by the OS pins at ~3e-05,
          // the same floor the far end reported for all eight emulator calls on
          // 2026-08-03/04. `totalAudioEnergy` is cumulative, so its delta
          // distinguishes "quiet room" from "no signal at all" over an interval.
          final kind = (v['kind'] ?? v['mediaType'])?.toString();
          if (kind != null && kind != 'audio') continue;
          final al = v['audioLevel'];
          if (al is num) outboundAudioLevel = al.toDouble();
          final tae = v['totalAudioEnergy'];
          if (tae is num) outboundTotalAudioEnergy = tae.toDouble();
        } else if (s.type == 'transport') {
          final id = v['selectedCandidatePairId'];
          if (id is String && id.isNotEmpty) selectedPairId = id;
        } else if (s.type == 'candidate-pair') {
          pairs[s.id] = v;
          if (v['selected'] == true) selectedPairId ??= s.id;
        } else if (s.type == 'local-candidate') {
          locals[s.id] = v;
        } else if (s.type == 'remote-candidate') {
          remotes[s.id] = v;
        }
      }
      if (selectedPairId != null) {
        candidatePairId = selectedPairId;
        final pair = pairs[selectedPairId];
        final localId = pair?['localCandidateId'];
        final cand = localId is String ? locals[localId] : null;
        final t = cand?['candidateType'];
        if (t is String) localCandType = t;
        final rp = cand?['relayProtocol'] ?? cand?['protocol'];
        if (rp is String) relayProtocol = rp.toString().toLowerCase();
        final remoteId = pair?['remoteCandidateId'];
        final rcand = remoteId is String ? remotes[remoteId] : null;
        final rt = rcand?['candidateType'];
        if (rt is String) remoteCandType = rt;
      }

      // Native active route + confirmation — 'unknown' when the controller is
      // off. Best-effort mapping of CallSession's binary speaker/earpiece
      // intent onto the richer native route; a mismatch (e.g. user is on
      // Bluetooth, which this session doesn't separately track) reads as
      // "not confirmed" rather than a false "healthy".
      String activeAudioRoute = 'unknown';
      bool routeConfirmed = false;
      bool? nativeFocusHeld;
      Map<String, dynamic>? nativeAudioDiagnostics;
      if (RemoteConfig.callAudioControllerV2) {
        try {
          final r = await NativeVoiceAudio.instance.getActiveRoute();
          activeAudioRoute = r.toString().split('.').last;
          final requested = _speaker ? 'speaker' : 'earpiece';
          routeConfirmed = activeAudioRoute == requested;
        } catch (_) {}
        nativeFocusHeld = !_onFocusHold;
      }
      try {
        nativeAudioDiagnostics =
            await NativeVoiceAudio.instance.getAudioDiagnostics();
      } catch (_) {}

      // [CF-CALL-P2P-1] video decode/render confirmation — computed once so
      // both the early-return "no inbound audio" snapshot below and the main
      // one further down carry the same values. Stays null/'unknown' for
      // audio-only calls (config.video == false) and for the first sample of
      // a video call (no prior baseline for the delta yet).
      int? videoFramesDecodedDelta, videoFramesDroppedDelta;
      bool? videoDecodeProgressing, rendererBound;
      if (config.video) {
        if (foundInboundVideo) {
          if (_phVideoFramesDecoded != null && videoFramesDecoded != null) {
            videoFramesDecodedDelta =
                videoFramesDecoded - _phVideoFramesDecoded!;
          }
          if (_phVideoFramesDropped != null && videoFramesDropped != null) {
            videoFramesDroppedDelta =
                videoFramesDropped - _phVideoFramesDropped!;
          }
          if (videoFramesDecodedDelta != null) {
            videoDecodeProgressing = videoFramesDecodedDelta > 0;
            if (videoFramesDecodedDelta > 0 &&
                !_firstRemoteVideoFrameReported) {
              _firstRemoteVideoFrameReported = true;
              Analytics.capture('call_first_remote_video_frame', {
                'call_id': config.room,
                'path': _sfuActive || _sfuStarting
                    ? 'sfu'
                    : (_relayForced ? 'relay' : 'direct'),
                'ms_since_connected': _connectedAtMs > 0
                    ? DateTime.now().millisecondsSinceEpoch - _connectedAtMs
                    : -1,
              });
            }
          }
          _phVideoBytes = videoBytesReceived;
          _phVideoFramesDecoded = videoFramesDecoded;
          _phVideoFramesDropped = videoFramesDropped;
        }
        try {
          final remoteStream = remoteRenderer.srcObject;
          rendererBound =
              remoteStream != null && remoteStream.getVideoTracks().isNotEmpty;
          // ── [CALL-VIDEO-RENDER-WATCH-1] frozen-picture self-heal ──────────
          //
          // Prod 2026-08-08 (avatok-b403ba59): the receiver decoded the peer's
          // video at 30fps for 9 straight minutes while the screen showed one
          // frozen frame — decode healthy, renderer bound, picture dead. That
          // state is detectable: the track the STATS say is decoding is not
          // the track the RENDERER is bound to (an SFU re-pull / renegotiation
          // left the renderer on a superseded track object). Two consecutive
          // samples (~10s) are required so a rebind can never race a
          // renegotiation that is mid-flight on the first sample.
          if (videoDecodeProgressing == true &&
              rendererBound == true &&
              videoTrackIdentifier != null) {
            String? boundId;
            final vts = remoteStream!.getVideoTracks();
            if (vts.isNotEmpty) boundId = vts.first.id;
            if (boundId != null && boundId != videoTrackIdentifier) {
              _renderStallStreak++;
              if (_renderStallStreak >= 2) {
                _renderStallStreak = 0;
                unawaited(
                    _healFrozenRemoteVideo(pc, videoTrackIdentifier!, boundId));
              }
            } else {
              _renderStallStreak = 0;
            }
          } else {
            _renderStallStreak = 0;
          }
        } catch (_) {/* renderer disposed mid-poll — stays unknown */}
      }

      // [CALL-MIC-OBS-1] Outbound deltas are computed BEFORE the no-inbound
      // early return below, deliberately: "I hear nothing from them" is exactly
      // the sample where you most want to know whether YOUR mic is alive, and
      // burying it after the return would reproduce the blind spot this change
      // exists to remove.
      int? audioBytesSentDelta, audioPacketsSentDelta;
      double? outboundEnergyDelta;
      if (foundOutboundAudio) {
        if (_phBytesSent != null && audioBytesSent != null) {
          audioBytesSentDelta = audioBytesSent - _phBytesSent!;
        }
        if (_phPacketsSent != null && audioPacketsSent != null) {
          audioPacketsSentDelta = audioPacketsSent - _phPacketsSent!;
        }
        _phBytesSent = audioBytesSent;
        _phPacketsSent = audioPacketsSent;
      }
      if (_phOutboundAudioEnergy != null && outboundTotalAudioEnergy != null) {
        outboundEnergyDelta =
            outboundTotalAudioEnergy - _phOutboundAudioEnergy!;
      }
      _phOutboundAudioEnergy = outboundTotalAudioEnergy;

      if (!foundInboundAudio) {
        _emitAudioDiagnostics(
          nativeAudioDiagnostics,
          micAudioLevel: outboundAudioLevel,
          micEnergyDelta: outboundEnergyDelta,
          audioBytesSentDelta: audioBytesSentDelta,
        );
        // No inbound-audio stat exists yet at all — unknown, never inferred.
        _telemetry.mediaHealth(MediaHealthSnapshot(
          cls: MediaHealthClass.unknown,
          atMs: nowMs,
          activeAudioRoute: activeAudioRoute,
          routeConfirmed: routeConfirmed,
          nativeFocusHeld: nativeFocusHeld,
          videoFramesDecodedDelta: videoFramesDecodedDelta,
          videoFramesDroppedDelta: videoFramesDroppedDelta,
          videoDecodeProgressing: videoDecodeProgressing,
          rendererBound: rendererBound,
          outboundAudioLevel: outboundAudioLevel,
          outboundTotalAudioEnergyDelta: outboundEnergyDelta,
          audioBytesSentDelta: audioBytesSentDelta,
          audioPacketsSentDelta: audioPacketsSentDelta,
        ));
        return;
      }

      int? bytesDelta, packetsDelta, lostDelta, jbufEmittedDelta;
      double? concealedDelta,
          silentConcealedDelta,
          totalSamplesDelta,
          energyDelta;
      double? jbufDelayMsAvg, lossPctInterval, concealmentPctInterval;
      if (_phBytes != null && bytesReceived != null)
        bytesDelta = bytesReceived - _phBytes!;
      if (_phPackets != null && packetsReceived != null) {
        packetsDelta = packetsReceived - _phPackets!;
      }
      if (_phLost != null && packetsLost != null)
        lostDelta = packetsLost - _phLost!;
      if (_phJbufEmitted != null && jbufEmitted != null) {
        jbufEmittedDelta = jbufEmitted - _phJbufEmitted!;
      }
      if (_phConcealed != null && concealedSamples != null) {
        concealedDelta = concealedSamples - _phConcealed!;
      }
      if (_phSilentConcealed != null && silentConcealedSamples != null) {
        silentConcealedDelta = silentConcealedSamples - _phSilentConcealed!;
      }
      if (_phTotalSamples != null && totalSamplesReceived != null) {
        totalSamplesDelta = totalSamplesReceived - _phTotalSamples!;
      }
      if (_phTotalAudioEnergy != null && totalAudioEnergy != null) {
        energyDelta = totalAudioEnergy - _phTotalAudioEnergy!;
      }

      // The audible milestone deliberately accepts decoded silence, because a
      // quiet person is still connected. This separate call-level event answers
      // when non-silent remote energy first arrived. It reuses this sampler and
      // records no audio or content.
      if (!_firstRemoteVoiceEnergyReported &&
          audioLevel != null &&
          audioLevel >= 0.01 &&
          (energyDelta == null || energyDelta > 0)) {
        _firstRemoteVoiceEnergyReported = true;
        Analytics.capture('call_first_remote_voice_energy', {
          'call_id': config.room,
          'ms_from_connected':
              _connectedAtMs == 0 ? -1 : nowMs - _connectedAtMs,
          'ms_from_start': _setupT0 == 0 ? -1 : nowMs - _setupT0,
          'audio_level': audioLevel,
          if (energyDelta != null) 'total_audio_energy_delta': energyDelta,
          'media_path': _sfuActive
              ? 'sfu'
              : (_relayForced ? 'relay' : (_connected ? 'direct' : 'none')),
          'active_audio_route': activeAudioRoute,
          'route_confirmed': routeConfirmed,
          if (nativeFocusHeld != null) 'native_focus_held': nativeFocusHeld,
          'outgoing': config.outgoing,
          'video': config.video,
        });
      }

      if (_phJbufDelaySec != null &&
          jbufDelaySec != null &&
          jbufEmittedDelta != null &&
          jbufEmittedDelta > 0) {
        jbufDelayMsAvg =
            1000.0 * (jbufDelaySec - _phJbufDelaySec!) / jbufEmittedDelta;
      }
      if (lostDelta != null &&
          packetsDelta != null &&
          (lostDelta + packetsDelta) > 0) {
        lossPctInterval = 100.0 * lostDelta / (lostDelta + packetsDelta);
      }
      if (concealedDelta != null &&
          totalSamplesDelta != null &&
          totalSamplesDelta > 0) {
        concealmentPctInterval = 100.0 * concealedDelta / totalSamplesDelta;
      }

      _phBytes = bytesReceived;
      _phPackets = packetsReceived;
      _phLost = packetsLost;
      _phJbufEmitted = jbufEmitted;
      _phJbufDelaySec = jbufDelaySec;
      _phConcealed = concealedSamples;
      _phSilentConcealed = silentConcealedSamples;
      _phTotalSamples = totalSamplesReceived;
      _phTotalAudioEnergy = totalAudioEnergy;

      // ── Classification (plan §7.2, thresholds hardcoded) ────────────────────
      const lossWarn = 3.0, concealWarn = 2.0, jitterWarnMs = 80.0;
      final jitterMs = jitterSec != null ? jitterSec * 1000.0 : null;
      final noRtp = bytesDelta != null && bytesDelta <= 0;
      // "No playout": RTP advances but the jitter-buffer emitted-count AND
      // audio energy both fail to advance, or route is broken (checked below).
      final playoutStalled = !noRtp &&
          jbufEmittedDelta != null &&
          jbufEmittedDelta <= 0 &&
          (energyDelta == null || energyDelta <= 0);
      final routeBroken = RemoteConfig.callAudioControllerV2 &&
          activeAudioRoute != 'unknown' &&
          (!routeConfirmed || nativeFocusHeld == false);

      MediaHealthClass cls;
      if (noRtp) {
        _noRtpStreak++;
        _noPlayoutStreak = 0;
        cls = MediaHealthClass.noRtp;
      } else if (routeBroken) {
        _noRtpStreak = 0;
        _noPlayoutStreak = 0;
        cls = MediaHealthClass.routeBroken;
      } else if (playoutStalled) {
        _noRtpStreak = 0;
        _noPlayoutStreak++;
        cls = MediaHealthClass.noPlayout;
      } else {
        _noRtpStreak = 0;
        _noPlayoutStreak = 0;
        final degraded =
            (lossPctInterval != null && lossPctInterval >= lossWarn) ||
                (concealmentPctInterval != null &&
                    concealmentPctInterval >= concealWarn) ||
                (jitterMs != null && jitterMs >= jitterWarnMs);
        if (degraded) {
          cls = MediaHealthClass.networkDegraded;
        } else if (audioLevel != null && audioLevel < 0.01) {
          cls = MediaHealthClass.remoteQuiet;
        } else {
          cls = MediaHealthClass.healthy;
        }
      }
      _lastPlayoutHealthClass = cls;

      _emitAudioDiagnostics(
        nativeAudioDiagnostics,
        micAudioLevel: outboundAudioLevel,
        micEnergyDelta: outboundEnergyDelta,
        audioBytesSentDelta: audioBytesSentDelta,
        jitterBufferEmittedDelta: jbufEmittedDelta,
      );

      _telemetry.mediaHealth(MediaHealthSnapshot(
        cls: cls,
        atMs: nowMs,
        bytesDelta: bytesDelta,
        packetsDelta: packetsDelta,
        lostDelta: lostDelta,
        jitterMs: jitterMs,
        audioLevel: audioLevel,
        totalAudioEnergyDelta: energyDelta,
        jitterBufferEmittedDelta: jbufEmittedDelta,
        jitterBufferDelayMsAvg: jbufDelayMsAvg,
        concealedSamplesDelta: concealedDelta?.round(),
        silentConcealedSamplesDelta: silentConcealedDelta?.round(),
        totalSamplesReceivedDelta: totalSamplesDelta?.round(),
        concealmentPctInterval: concealmentPctInterval,
        lossPctInterval: lossPctInterval,
        lastPacketReceivedTimestampMs: lastPacketReceivedTsMs,
        selectedCandidatePairId: candidatePairId,
        localCandidateType: localCandType,
        remoteCandidateType: remoteCandType,
        relayProtocol: relayProtocol,
        activeAudioRoute: activeAudioRoute,
        routeConfirmed: routeConfirmed,
        nativeFocusHeld: nativeFocusHeld,
        videoFramesDecodedDelta: videoFramesDecodedDelta,
        videoFramesDroppedDelta: videoFramesDroppedDelta,
        videoDecodeProgressing: videoDecodeProgressing,
        rendererBound: rendererBound,
        outboundAudioLevel: outboundAudioLevel,
        outboundTotalAudioEnergyDelta: outboundEnergyDelta,
        audioBytesSentDelta: audioBytesSentDelta,
        audioPacketsSentDelta: audioPacketsSentDelta,
      ));
      if (sampleMigration) {
        // [CALL-REL-6] This sample is for the migration's NEW pc — feed the
        // migration coordinator only (never the direct-path recovery one,
        // which reasons about the OLD `_pc`).
        if (RemoteConfig.callRelayMigrationV1)
          _onPlayoutHealthForMigration(cls);
      } else {
        // [CALL-REL-5] Feed the recovery coordinator with this classification.
        // No-op (and no recovery side effects) unless callIceRecoveryV2 is on
        // AND a recovery is actually in flight.
        if (RemoteConfig.callIceRecoveryV2) _onPlayoutHealthForRecovery(cls);
        // [CALL-REL-6 §7.2 relay thresholds] "loss >= 8% for 3 samples" can
        // escalate straight to relay migration without waiting for a direct
        // ICE recovery attempt to fail first (plan §7.4: "escalation target
        // when direct recovery fails OR §7.2 relay thresholds hit").
        if (lossPctInterval != null && lossPctInterval >= 8.0) {
          _relayThresholdStreak++;
        } else {
          _relayThresholdStreak = 0;
        }
        if (RemoteConfig.callRelayMigrationV1 &&
            _relayThresholdStreak >= 3 &&
            !_relayForced &&
            !_migrationAttempted &&
            _activeMigration == null &&
            _activeRecovery == null &&
            // [CF-CALL-P2P-1] Don't start a migration offer while a
            // video-enable renegotiation is in flight — the next sample 5s
            // later re-evaluates the streak.
            !_videoRenegoInFlight &&
            _connected &&
            !_ended) {
          _relayThresholdStreak = 0;
          // [BLOCKER-2 fix] Both peers sample loss independently and can hit
          // this threshold at the same time — only the deterministic
          // initiator starts the migration; the other side requests it.
          if (_isMigrationInitiator) {
            // ignore: unawaited_futures
            _migrateToRelay(RecoveryReason.highConcealment);
          } else {
            _requestRelayMigration(RecoveryReason.highConcealment);
          }
        }
      }
    } catch (e, st) {
      // OBSERVE-ONLY: never throw, never touch call state. Reported the same
      // deduplicated way the existing watchdog reports its own failures.
      _telemetry.runtimeError(
        stage: 'playout_health_poll_failed',
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
    double? availableOutgoingKbps,
  }) {
    _qosLastAvailableOutKbps = availableOutgoingKbps;
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    int upKbps = 0, downKbps = 0;
    final prevTs = _lastNetTs;
    if (prevTs != null &&
        _lastNetSentBytes != null &&
        _lastNetRecvBytes != null) {
      final dtSec = (nowMs - prevTs) / 1000.0;
      if (dtSec > 0.1) {
        final dSent = (totalSentBytes - _lastNetSentBytes!).clamp(0, 1 << 62);
        final dRecv = (totalRecvBytes - _lastNetRecvBytes!).clamp(0, 1 << 62);
        upKbps = ((dSent * 8) / dtSec / 1000).round();
        downKbps = ((dRecv * 8) / dtSec / 1000).round();
        // Light EMA smoothing so the HUD doesn't jitter between polls.
        _emaUpKbps = _emaUpKbps == 0
            ? upKbps.toDouble()
            : (_emaUpKbps * 0.5 + upKbps * 0.5);
        _emaDownKbps = _emaDownKbps == 0
            ? downKbps.toDouble()
            : (_emaDownKbps * 0.5 + downKbps * 0.5);
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
      if (rttMs > 500)
        q = 0;
      else if (rttMs > 300)
        q = 1;
      else if (rttMs > 180)
        q = 2;
      else if (rttMs > 90) q = 3;
    }
    if (lossPct >= 0) {
      int lq = 4;
      if (lossPct > 8)
        lq = 0;
      else if (lossPct > 4)
        lq = 1;
      else if (lossPct > 2)
        lq = 2;
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
      estMos: _telemetry.latestEstimatedMos,
    );
  }

  Future<void> _adaptAudioSender({
    required double? availableOutgoingKbps,
    required double? lossPct,
    required int rttMs,
  }) async {
    if (_ended || !_connected) return;
    // [CALL-QOS-RED-1 2026-08-06] Compare the link's headroom against what we
    // actually put ON THE WIRE, not against the Opus target.
    //
    // `_qosAudioBitrateBps` is the ENCODER target. With RED at
    // [kOpusRedDistance] = 1 the sender is capped at twice that
    // (`avaAudioSenderCapBps`, applied in [_applyAudioBitrate]), so this test
    // was measuring congestion against half the demand it was creating: on a
    // link with ~70 kbps of headroom it read "not congested" while the sender
    // was asking for 80. Measured in prod on 2026-08-06 (avatok-597ba662): the
    // cellular leg averaged 55.6 kbps and peaked at 80.5 — exactly the RED wire
    // cap — against ~28 kbps on every WiFi leg in the same session, and it was
    // the only leg that moved the ladder at all.
    //
    // Reads the FLAG rather than a measured "RED actually engaged" signal
    // deliberately, to stay in lock-step with [_applyAudioBitrate], which pads
    // the sender cap off the same flag. If the two ever disagree the ladder
    // fights the cap; if RED is capability-absent in a build, both
    // over-estimate together and the ladder is merely conservative.
    final wireTargetKbps = audio_tuning.avaAudioSenderCapBps(
          _qosAudioBitrateBps,
          redActive: RemoteConfig.callAudioRedExperimentV1,
        ) /
        1000.0;
    final congested = (availableOutgoingKbps != null &&
            availableOutgoingKbps <
                wireTargetKbps * RemoteConfig.callQosHeadroomFactor) ||
        (lossPct != null && lossPct >= RemoteConfig.callQosLossDownshiftPct);
    if (congested) {
      _qosStableSamples = 0;
      // [CALL-MEDIA-540P-1] Ladder rungs 40 / 32 / 24 kbps. 40000 is the TOP,
      // not a middle rung: it is the same number as `maxaveragebitrate` in the
      // Opus fmtp line, and a sender cap above the negotiated encoder cap is a
      // ceiling that can never be reached — the ladder would report an upshift
      // that changes nothing on the wire.
      final next = _qosAudioBitrateBps > 32000
          ? 32000
          : (_qosAudioBitrateBps > 24000 ? 24000 : 24000);
      if (next != _qosAudioBitrateBps) {
        _qosAudioBitrateBps = next;
        await _applyAudioBitrate(next);
      }
      return;
    }
    final stable =
        (lossPct == null || lossPct < RemoteConfig.callQosStableLossPct) &&
            (rttMs < 0 || rttMs <= RemoteConfig.callQosStableRttMs);
    if (!stable) {
      _qosStableSamples = 0;
      return;
    }
    if (++_qosStableSamples < RemoteConfig.callQosStableSamples) return;
    _qosStableSamples = 0;
    final next = _qosAudioBitrateBps < 32000 ? 32000 : 40000;
    if (next != _qosAudioBitrateBps) {
      _qosAudioBitrateBps = next;
      await _applyAudioBitrate(next);
    }
  }

  Future<void> _applyAudioBitrate(int bitrateBps) async {
    final pc = _pc;
    if (pc == null) return;
    try {
      // [CALL-MEDIA-540P-1] `bitrateBps` is the OPUS target. When RED is on the
      // wire carries a redundant copy alongside it, and this cap bounds the wire
      // — so hand the sender the padded figure or RED eats half the primary
      // stream and the "packet-loss protection" makes the call sound worse.
      final wireCapBps = audio_tuning.avaAudioSenderCapBps(
        bitrateBps,
        redActive: RemoteConfig.callAudioRedExperimentV1,
      );
      final senders = await pc.getSenders();
      for (final sender in senders) {
        if (sender.track?.kind != 'audio') continue;
        final params = sender.parameters;
        final encodings = params.encodings;
        if (encodings == null || encodings.isEmpty) {
          params.encodings = [
            RTCRtpEncoding(active: true, maxBitrate: wireCapBps)
          ];
        } else {
          for (final encoding in encodings) encoding.maxBitrate = wireCapBps;
        }
        await sender.setParameters(params);
      }
      Analytics.capture('call_qos_bitrate_changed', {
        'call_id': config.room,
        'max_bitrate_kbps': bitrateBps ~/ 1000,
        // [CALL-MEDIA-540P-1] Both numbers, because they now differ. Reading
        // only the Opus target would hide a doubled wire rate; reading only the
        // wire cap would look like the ladder had drifted off its rungs.
        'wire_cap_kbps': wireCapBps ~/ 1000,
        'opus_red_active': RemoteConfig.callAudioRedExperimentV1,
        'available_out_kbps': _qosLastAvailableOutKbps ?? -1,
      });
    } catch (e, st) {
      _telemetry.runtimeError(
          stage: 'audio_qos_parameters_failed', error: e, stack: st);
    }
  }

  Future<void> _adaptVideoForNetwork(
      {required double? lossPct, required int rttMs}) async {
    if (_ended || !_connected || !config.video) return;
    final severe =
        lossPct != null && lossPct >= RemoteConfig.callVideoLossPausePct;
    final degraded = severe ||
        (lossPct != null && lossPct >= RemoteConfig.callVideoLossDegradePct);
    if (degraded || rttMs >= 500) {
      _videoStableSamples = 0;
      final next =
          severe ? 2 : (_videoDegradeLevel < 1 ? 1 : _videoDegradeLevel);
      if (next != _videoDegradeLevel) {
        _videoDegradeLevel = next;
        await _applyVideoDegradeLevel(next);
      }
      return;
    }
    if (lossPct != null && lossPct < 1 && (rttMs < 0 || rttMs < 180)) {
      if (++_videoStableSamples < RemoteConfig.callVideoStableSamples) return;
      _videoStableSamples = 0;
      if (_videoDegradeLevel > 0) {
        _videoDegradeLevel--;
        await _applyVideoDegradeLevel(_videoDegradeLevel);
      }
    } else {
      _videoStableSamples = 0;
    }
  }

  Future<void> _applyVideoDegradeLevel(int level) async {
    final pc = _pc;
    if (pc == null) return;
    try {
      final senders = await pc.getSenders();
      for (final sender in senders) {
        if (sender.track?.kind != 'video') continue;
        final params = sender.parameters;
        final encodings = params.encodings;
        // [CALL-MEDIA-540P-1] Was `level == 0 ? 1200000 : …` — a SECOND,
        // hard-coded copy of the sender ceiling that knew nothing about the
        // capture profile or the network class. It made the 540p cap survive
        // only until the first congestion-and-recovery cycle, after which this
        // recovery step handed the encoder 1.2 Mbps again for the rest of the
        // call. One source of truth now, and cellular is honoured on every rung.
        final maxBitrate = audio_tuning.avaVideoMaxBitrateBps(
          cellular: _localCellular,
          degradeLevel: level,
        );
        if (encodings == null || encodings.isEmpty) {
          params.encodings = [
            RTCRtpEncoding(active: true, maxBitrate: maxBitrate)
          ];
        } else {
          for (final encoding in encodings) encoding.maxBitrate = maxBitrate;
        }
        params.degradationPreference = RTCDegradationPreference.BALANCED;
        await sender.setParameters(params);
      }
      final track = _stream?.getVideoTracks().isNotEmpty == true
          ? _stream!.getVideoTracks().first
          : null;
      if (track != null) {
        track.enabled = level < 2 && _camOn;
        videoActive.value = track.enabled;
      }
      Analytics.capture('call_video_network_degraded', {
        'call_id': config.room,
        'level': level,
        'audio_preserved': true,
      });
    } catch (e, st) {
      _telemetry.runtimeError(
          stage: 'video_degrade_parameters_failed', error: e, stack: st);
    }
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
    if (_started || _ended || _teardownStarted) return;
    _started = true;
    // [CALL-RESTORE-1] Derive the stable per-(device, room) peer id BEFORE any
    // code path can open the signalling socket — the id is baked into the `?id=`
    // query and becomes the DO's hibernation tag, so upgrading it afterwards
    // would just create the extra zombie peer we're trying to eliminate.
    // `_bootMedia()` (which connects) is awaited at the END of this method, so
    // doing it first here is sufficient and race-free.
    await _adoptStablePeerId();
    if (_ended || _teardownStarted) return;
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
    try {
      WakelockPlus.enable();
    } catch (_) {}
    // [CALLREC-PEER-1] Watch the recording store so the peer is told, for the
    // life of this call, whenever we start or stop recording. Detached in
    // teardown. Purely additive — nothing below depends on it.
    _attachRecordingBridge();
    // [INSTANT-CALL-MOUNT-1] An optimistically-mounted call (screen shown before
    // the place-call POST resolved) MUST run the honest guard flow regardless of
    // the server flag: 'connecting' + searching tone, no fake ringback, ring
    // window gated on the placement result. Otherwise a guard-off prod would play
    // ringback into a callee we haven't even confirmed is reachable yet.
    _takeoverGuard = RemoteConfig.receptTakeoverGuard || config.deferRing;
    _telemetry = CallTelemetry(
      callId: config.room,
      callTraceId: _traceId,
      video: config.video,
      outgoing: config.outgoing,
      provider: config.mediaProvider.wire,
    );
    _telemetry.started();
    _placementFeedbackReady = true;
    if (_pendingPlacementFailure) {
      _pendingPlacementFailure = false;
      notePlaceFailed();
      return;
    } else if (_pendingPlacementReachable != null) {
      final reachable = _pendingPlacementReachable!;
      final prewarming = _pendingPlacementPrewarming;
      final deadline = _pendingPlacementPrewarmDeadlineMs;
      _pendingPlacementReachable = null;
      scheduleMicrotask(() => notePlaceResult(
            reachable,
            prewarming: prewarming,
            prewarmDeadlineMs: deadline,
          ));
    }
    // [CALL-DEADAIR-1] Anchor the stage stopwatch to the SAME instant as
    // `call_started`, so every number on `call_first_audio_ms` can be compared
    // directly against that event's timestamp in PostHog.
    _setupT0 = DateTime.now().millisecondsSinceEpoch;
    _lastSetupStageAtMs = _setupT0;
    if (!config.outgoing) {
      final acceptedAt = PushService.acceptedAtMsFor(config.room);
      if (acceptedAt != null && acceptedAt > 0) {
        _answerAtMs = acceptedAt;
        Analytics.capture('call_answer_observed', {
          'call_id': config.room,
          'call_trace_id': _traceId,
          'provider': _performanceProvider,
          'role': _performanceRole,
          'source': 'local_answer_tap',
          'session_start_after_answer_ms':
              (_setupT0 - acceptedAt).clamp(0, 300000),
        });
      }
    }
    // My own profile (best-effort) for the receptionist duo's "You" icon.
    ProfileStore().load().then((p) {
      if (_ended) return;
      _myAvatar = p.avatarUrl;
      if (p.displayName.trim().isNotEmpty) _myName = p.displayName.trim();
      _mySeed = p.handle.isNotEmpty
          ? p.handle
          : (p.displayName.isNotEmpty ? p.displayName : 'me');
      _bump();
    }).catchError((_) {});
    // Wi-Fi ⇆ cellular handoff → proactive ICE restart.
    _netSub = Connectivity().onConnectivityChanged.listen((results) {
      // [CALL-SURVIVE-1] Classify the interface so a REAL wifi↔cell handover
      // is distinguishable from metadata churn (bluetooth toggles etc.).
      final cls = _classifyNet(results);
      if (_lastNetClass == 'unknown') {
        _lastNetClass = cls; // first observation — baseline, never a handover
        return;
      }
      if (!_connected || _ended) {
        _lastNetClass = cls;
        return;
      }
      _telemetry.onNetChange();
      if (cls == _lastNetClass) {
        // Interface class unchanged (or a flap netted out back to the class
        // we last acted on) — cancel any pending debounce and keep the
        // health-sample gate: Connectivity() is a HINT; RTP flow is the
        // authority on whether anything actually broke.
        _netDebounceTimer?.cancel();
        if (RemoteConfig.callIceRecoveryV2) {
          // ignore: unawaited_futures
          _pollPlayoutHealth().then((_) {
            if (_ended || !_connected) return;
            final h = _lastPlayoutHealthClass;
            final unhealthy = h == MediaHealthClass.noRtp ||
                h == MediaHealthClass.noPlayout ||
                h == MediaHealthClass.routeBroken ||
                h == MediaHealthClass.networkDegraded;
            if (unhealthy) {
              // ignore: unawaited_futures
              _requestRecovery(RecoveryReason.networkChanged);
            }
          });
        }
        return;
      }
      // [CALL-SURVIVE-2 2026-08-04] Interface class CHANGED — debounce 2s
      // before acting. WiFi↔cell events arrive in bursts on a moving phone;
      // acting on each one thrashed abort/restart cycles. The new interface
      // must survive the settle window (re-confirmed via checkConnectivity)
      // before we abort in-flight work and start a fresh attempt. A real
      // outage in the meantime is caught by the 5s media watchdog anyway.
      _netDebounceTimer?.cancel();
      _netDebounceTimer = Timer(const Duration(seconds: 2), () async {
        if (_ended || !_connected) return;
        List<ConnectivityResult> nowResults;
        try {
          nowResults = await Connectivity().checkConnectivity();
        } catch (_) {
          return;
        }
        final confirmed = _classifyNet(nowResults);
        if (confirmed == _lastNetClass) return; // flap netted out — no action
        final from = _lastNetClass;
        _lastNetClass = confirmed;
        // Structured handover telemetry — correlates handovers to recovery
        // attempts in one query (audit item 11).
        Analytics.capture('call_network_handover', {
          'call_id': config.room,
          'from': from,
          'to': confirmed,
          'recovery_attempt_id':
              _activeRecovery?.id ?? _activeMigration?.id ?? 'none',
        });
        if (_ended || !_connected) return;
        if (RemoteConfig.callIceRecoveryV2) {
          if (confirmed != 'none') {
            // [CALL-SURVIVE-1] Any in-flight attempt is gathering on a dead
            // interface — abort it and start a fresh attempt NOW (backoff
            // reset). Waiting for a health sample here is what let attempts
            // burn 30s deadlines on stale candidates (prod 2026-08-04).
            _abortInFlightRecoveryForNetChange();
            // ignore: unawaited_futures
            _requestRecovery(RecoveryReason.networkChanged);
          }
          // confirmed == 'none': nothing to gather on — the media watchdog /
          // WS ladder handle it when an interface comes back.
        } else {
          // ignore: unawaited_futures
          _tryIceRestart('net-change');
        }
      });
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
    // Every outgoing timeout — `_deviceRingingTimer` (12s), `_ringTimeout` (22s),
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
    // 45s is deliberately > the 22s outgoing `_ringTimeout`, so this never
    // pre-empts the richer outgoing no-answer flow (which has its own outcome
    // menu, receptionist hand-off, etc.). It is the backstop of last resort.
    // SFU/RTK setup has several bounded network stages (join, publish, peer
    // discovery, pull and renegotiation). Give that selected transport enough
    // time to complete; the short accepted-side watchdog is also cancelled
    // when a media transport actually begins below.
    final setupWatchdogSeconds =
        (RemoteConfig.callRealtimeKitV1 || RemoteConfig.callSfuV1) ? 75 : 45;
    _connectWatchdog = Timer(Duration(seconds: setupWatchdogSeconds), () {
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
        'setup_watchdog_seconds': setupWatchdogSeconds,
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
      _placementResolved = _placementResolved || !config.deferRing;
      if (!config.deferRing) _startHandoffAuthorityPoll();
      // CALL-GLARE-1: publish our pending outgoing dial for the incoming-push
      // handler's glare detection. Cleared on connect + on teardown.
      gOutgoingCallTo = config.seed;
      gOutgoingCallId = config.room;
      gOutgoingSince = DateTime.now().millisecondsSinceEpoch;

      if (_takeoverGuard) {
        // [DIAL-NARRATION-2 2026-08-03] The 3s and 7s lines are GONE.
        //
        // They were described as "progressive, signal-tied status lines". They
        // were not tied to any signal: both were plain wall-clock timers, and
        // the app knew nothing at 7 seconds that it did not know at 0. They were
        // written in July to fill the 5-8 seconds it took the server to ring the
        // other phone — a progress bar dressed up as status, telling the user
        // their friend's phone was being "woken up" when in reality our own
        // backend was still doing paperwork.
        //
        // [CALL-RING-FIRST-1] removed that latency at the source: the ring now
        // goes out before the wallet check, the takeover probe and the token
        // count, and the fast WebSocket lane no longer queues behind FCM. With
        // the ring arriving in well under a second for an online callee, there
        // is nothing left to narrate — and narrating it anyway was the thing the
        // owner objected to.
        //
        // One honest line remains for the brief moment before we know anything.
        // It is replaced the instant real evidence arrives: `_onRingAck` (the
        // push was accepted) or `_onDeviceRinging` (their phone is genuinely
        // ringing — the only thing allowed to start a ringback, per
        // FAKE-RING-HONEST-1).
        _setDialStage('Calling $_peerFirst…');
        // [RING-WINDOW-12S-1] (2026-07-09): wait up to 12s for the ring-ack /
        // device-ringing. Was 6s — but PostHog (avatok-65f9100f) shows the push
        // FAN-OUT alone can take 6s server-side, so the ack physically cannot
        // beat a 6s deadline and every call fell to Ava "unreachable". The
        // searching beeps (CALL-SEARCH-TONE-1) give honest feedback meanwhile,
        // so the longer wait no longer feels like a hang.
        // An optimistically mounted call starts BEFORE POST /api/call. Its
        // backend latency is not evidence about the recipient's phone and must
        // not consume this device-wake allowance. The placement result will
        // drive `_onRingAck` once the ring has actually been enqueued. Legacy
        // awaited placement still needs the 12s backstop here.
        if (!config.deferRing) {
          _deviceRingingTimer = Timer(const Duration(seconds: 12), () {
            if (!_ended && !_connected && !_deviceRinging) {
              AvaLog.I
                  .log('call', 'Device ringing timeout: callee unreachable.');
              _goUnreachable('device_wake_timeout');
            }
          });
        }
      } else {
        // The server alarm owns the 20s/four-ring outcome. This is only a
        // delivery backstop if both the DO socket and its FCM status are lost.
        _ringTimeout = Timer(const Duration(seconds: 22), () {
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
      if (e.callId == config.room) {
        Analytics.capture('call_terminal_session_received', {
          'call_id': config.room,
          'call_trace_id': _traceId,
          'provider': _performanceProvider,
          'role': _performanceRole,
          'status': e.status,
          'connected': _connected,
          if (_answerAtMs != null)
            'elapsed_from_answer_ms':
                DateTime.now().millisecondsSinceEpoch - _answerAtMs!,
        });
      }
      if (_receptionistActive) {
        if (e.callId == config.room) {
          Analytics.capture('ava_recept_signal_suppressed', {
            'channel': 'call_status',
            'status': e.status,
            'call_id': config.room
          });
        }
        return;
      }
      if (e.callId == config.room && !_ended && e.status == 'glare-yield') {
        Analytics.capture('call_glare_yielded', {'call_id': config.room});
        _endWith('ended', reason: 'glare-yield');
        return;
      }
      if (e.callId == config.room &&
          !_ended &&
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
        // An explicit Receptionist tap is not a generic decline outcome. It
        // must bypass the outcome menu even when that feature is enabled and
        // connect the caller straight to Ava as the callee requested.
        if (e.status == 'decline_ava' && !config.video && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva(e.activationMode == 'rings' ? 'rings' : 'decline');
          return;
        }
        if (e.status == 'no-answer' && !_ended) {
          _ringTimeout?.cancel();
          _showOutcomeMenu('no-answer');
          return;
        }
        // [CALL-OUTCOME-MENU-1] Declines land on the unified menu (all call
        // kinds — video simply hides Talk to Ava) instead of auto-Ava/plain end.
        if (_menuEnabled && !_ended && e.status == 'decline') {
          _ringTimeout?.cancel();
          _showOutcomeMenu('declined');
          return;
        }
        // [CALL-VOICEMAIL-1 2026-08-01] The callee chose "Voice Mail": their ring
        // stops, but MY leg stays alive so I can record a message. This is a
        // HANDOFF, not a terminal status — see the frozen spec.
        //
        // _showOutcomeMenu already does exactly the right teardown (bye, stop
        // mic tracks, close the peer connection, notify the callee) and parks the
        // session in the 'outcome-menu' phase, whose existing recorder uploads to
        // R2 and delivers a normal audio message into the DM thread. Deliberately
        // NOT gated on _menuEnabled: the callee explicitly asked for voicemail,
        // so a flag defaulting to false must not swallow their choice.
        if (e.status == 'decline_vm' && !config.video && !_ended) {
          _ringTimeout?.cancel();
          _showOutcomeMenu('voicemail');
          return;
        }
        if (e.status == 'busy') {
          // [BUSY-CARD-1] Capture the server's busy metadata (why + whether the
          // callee's receptionist can take a message + pronoun) BEFORE handling
          // busy, so _onBusy can decide whether to render the personalized card.
          _busyReason = e.busyReason;
          _busyReceptionistEnabled = e.receptionistEnabled;
          if (e.pronoun != null && e.pronoun!.isNotEmpty)
            _busyPronoun = e.pronoun!;
          // ignore: unawaited_futures
          _onBusy();
          return;
        }
        // [CALL-DECLINE-IS-TERMINAL-1 2026-08-01] OWNER RULING A — a plain
        // Decline ENDS THE CALL IMMEDIATELY. It never starts Ava.
        //
        // The previous code handed off to Ava whenever the callee happened to
        // have the receptionist lane on, which made Decline mean two different
        // things depending on invisible per-user config. That ambiguity is the
        // reason this path kept re-breaking, and it also meant a caller who
        // pressed a red decline button on the other end still got dropped into
        // a paid AI call they never asked for.
        //
        // Decline and Receptionist are now DISTINCT actions:
        //   Decline      -> caller's leg ends now, disposition 'declined'
        //   Receptionist -> callee's ring ends, caller is handed to Ava
        // The callee signals `decline_ava` (handled above) when they explicitly
        // choose Receptionist. See Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md.
        //
        // INVARIANT: `declined` may NEVER transition to `receptionist_active`.
        if (e.status == 'decline' && !_ended) {
          _ringTimeout?.cancel();
          _endWith('declined', reason: 'decline-explicit');
          return;
        }
        // [CALL-ACCEPT-STATUS-KILL-1 2026-08-09] The catch-all below used to end
        // the session with WHATEVER status arrived. The worker's FCM backstop
        // (api.ts callCommand) pushed every changed command's wire status —
        // including `accept` after the callee accepted — so when that push beat
        // WebRTC connect, the status that meant "your call was answered" ended
        // the caller's session, which auto-cancelled and killed the call the
        // callee had just accepted (prod avatok-b3e2da5c, 2026-08-08: the
        // davy↔Tiger "ghost calling" cascade — kill → redial → busy → retries).
        // The worker no longer sends non-terminal statuses, but a client guard
        // is still required: old workers, replays, and any future status this
        // listener doesn't know must NEVER tear down a call that is in the
        // middle of connecting. Only statuses that terminate the caller's leg
        // may fall through to _endWith.
        const terminal = {
          'cancel',
          'bye',
          'hangup',
          'ended',
          'missed',
          'no-answer',
          'decline',
          'declined',
        };
        if (!terminal.contains(e.status)) {
          Analytics.capture('call_status_ignored_nonterminal', {
            'call_id': config.room,
            'status': e.status,
            'connected': _connected,
          });
          return;
        }
        _endWith(e.status == 'decline' ? 'declined' : e.status);
      }
    });
    // [AVACALL-CANCEL-1] Drain a pre-subscription cancel: the broadcast bus has no
    // replay, so a terminal status delivered between accept and the listen() above
    // would be lost. Re-check the last-terminal cache the instant we're subscribed.
    if (!config.outgoing &&
        !_ended &&
        PushService.wasCallTerminated(config.room)) {
      _endPreAcceptCancelled('drain-on-subscribe');
      return;
    }
    // Log to call history.
    //
    // [CALL-LOG-TIME-1] The entry is written HERE, at call start, so history
    // survives the app being killed mid-call — which means it is born with no
    // duration and no outcome. Keep the future: `_finishCallLog` awaits it and
    // patches in the real numbers when the call ends, and a call that ends
    // within milliseconds would otherwise race the secure-storage write and
    // find no id to patch.
    _callLogAdd = CallLogStore().add(CallEntry(
      name: config.title,
      seed: config.seed,
      video: config.video,
      dir: config.outgoing ? CallDir.outgoing : CallDir.incoming,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    ));
    // Nothing awaits this future on the happy path; swallow a storage failure so
    // it can't surface as an unhandled async error.
    unawaited(_callLogAdd!.then((_) {}).catchError((Object _) {}));
    // [STREAM-CALL-PILOT-2] `deferRing` is the optimistic CallScreen mount.
    // Only a build with the Stream pilot gate enabled waits for the placement
    // response. When the gate is off (the default), preserve the old startup
    // timing exactly: boot Cloudflare media immediately. Missing/old provider
    // data is explicitly treated as the legacy Cloudflare decision.
    _setupReadyForMedia = true;
    _providerDecision ??= config.mediaProvider == CallMediaProvider.stream &&
            config.streamTicket != null
        ? CallProviderDecision.stream(config.streamTicket!)
        : const CallProviderDecision.cloudflare(reason: 'legacy_call_session');
    if (config.deferRing && StreamCallPilot.enabled) {
      if (_mediaStartRequested && !_ended) {
        unawaited(_startSelectedMedia());
      }
      return;
    }
    if (!_ended) await _startSelectedMedia();
  }

  /// Feed the server's provider decision into an optimistically-mounted live
  /// session. Must be called before [notePlaceResult]. A duplicate/late
  /// decision is ignored once media has started, keeping provider selection
  /// sticky for the entire call.
  void noteProviderDecision(CallProviderDecision decision) {
    if (_ended || _mediaBooted || _mediaBootStarting) {
      Analytics.capture('call_provider_decision_ignored', {
        'call_id': config.room,
        'provider': decision.provider.wire,
        'media_started': _mediaBooted || _mediaBootStarting,
      });
      return;
    }
    _providerDecision = decision;
    Analytics.capture('call_provider_selected', {
      'call_id': config.room,
      'provider': decision.provider.wire,
      'reason': decision.reason,
      'optimistic_mount': config.deferRing,
    });
  }

  Future<void> _startSelectedMedia() async {
    if (!_setupReadyForMedia || _ended || _mediaBooted || _mediaBootStarting)
      return;
    _mediaBootStarting = true;
    _mediaStartRequested = false;
    final decision = _providerDecision ??=
        const CallProviderDecision.cloudflare(
            reason: 'missing_provider_defaults_cloudflare');
    if (decision.usesStream) {
      await _startStreamMedia(decision.streamTicket);
      _mediaBootStarting = false;
      return;
    }
    try {
      await _bootMedia();
      _mediaBooted = true;
    } finally {
      _mediaBootStarting = false;
    }
    if (_prejoinRequestedBeforeMedia && _mediaBooted && !_ended) {
      _prejoinRequestedBeforeMedia = false;
      _maybeStartCallerPrejoin();
    }
  }

  Future<void> _startStreamMedia(StreamCallJoinTicket? ticket) async {
    if (_ended || _streamRtcActive || _streamRtcStarting) return;
    if (ticket == null || config.video) {
      _endWith('network-error', reason: 'stream-ticket-invalid');
      return;
    }
    _streamRtcStarting = true;
    _stage('stream_join_begin');
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;
    try {
      final session = await StreamRtcProvider().joinStream(
        ticket,
        mode: RtcMode.audio,
        outgoing: config.outgoing,
      );
      if (_ended) {
        await session.leave();
        return;
      }
      _streamRtc = session;
      _streamRtcEvents = session.events.listen(_onStreamRtcEvent);
      _streamRtcActive = true;
      _mediaBooted = true;
      _telemetry.setMediaPath('stream');
      _stage('stream_join_armed');
      Analytics.capture('stream_call_media_armed', {
        'call_id': config.room,
        'role': config.outgoing ? 'caller' : 'callee',
        'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
      });
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'call_session',
        handled: true,
        extra: {'op': 'stream_join', 'call_id': config.room},
      );
      if (!_ended) {
        _endWith('network-error',
            reason: e is StreamCallUnavailable
                ? 'stream-${e.reason}'
                : 'stream-join-failed');
      }
    } finally {
      _streamRtcStarting = false;
    }
  }

  void _onStreamRtcEvent(RtcSessionEvent event) {
    if (_ended || !_streamRtcActive) return;
    switch (event) {
      case RtcSessionEvent.audioTrackAdded:
        _markStreamConnected('remote_audio');
        break;
      case RtcSessionEvent.firstAudioPlayout:
        _markStreamConnected('first_audio_playout');
        audioFlowing.value = true;
        _markAudibleReady(
          viaTimeout: false,
          flagOff: !RemoteConfig.callAudibleStateV1,
          evidence: 'stream_first_audio_playout',
        );
        if (RemoteConfig.callFirstAudioProbeV1 && !_firstAudioReported) {
          _reportFirstAudio(bytes: -1, outcome: 'audio');
        }
        break;
      case RtcSessionEvent.rejected:
        _endWith('declined', reason: 'stream-remote-declined');
        break;
      case RtcSessionEvent.remoteJoin:
        _markStreamConnected('remote_join');
        break;
      case RtcSessionEvent.reconnecting:
        Analytics.capture('call_network_handover', {
          'call_id': config.room,
          'provider': 'stream',
          'outcome': 'started',
        });
        break;
      case RtcSessionEvent.disconnected:
      case RtcSessionEvent.remoteLeave:
        _endWith('ended', reason: 'stream-remote-left');
        break;
      case RtcSessionEvent.error:
        if (!_connected) {
          _endWith('network-error', reason: 'stream-provider-error');
        }
        break;
      default:
        break;
    }
  }

  void _markStreamConnected(String via) {
    if (_ended || _connected || !_streamRtcActive) return;
    _ringTimeout?.cancel();
    _connectWatchdog?.cancel();
    _connectWatchdogFast?.cancel();
    _failTimer?.cancel();
    _ringback.stop();
    if (_prewarmCall != null) unawaited(_abortPrewarm('callee_answered'));
    _telemetry.connected(null);
    _telemetry.setMediaPath('stream');
    if (gOutgoingCallId == config.room) {
      gOutgoingCallTo = null;
      gOutgoingCallId = null;
      gOutgoingSince = 0;
    }
    _connected = true;
    if (_connectedAtMs == 0) {
      _connectedAtMs = DateTime.now().millisecondsSinceEpoch;
    }
    peerAway.value = false;
    _setPhase('connected');
    _stage('stream_connected');
    Analytics.capture('stream_call_connected', {
      'call_id': config.room,
      'via': via,
      'role': config.outgoing ? 'caller' : 'callee',
      'ms_from_start':
          _setupT0 == 0 ? -1 : DateTime.now().millisecondsSinceEpoch - _setupT0,
    });
    _armAudibleGate();
  }

  /// Sync the coarse enum + fine label + view tick from a fine phase string.
  // [CALL-MENU-FIX-2] When the CURRENT `_phase` was entered — feeds
  // `call_outcome_session_reaped`'s `age_ms` so a reap can be judged "the menu
  // sat abandoned for minutes" vs "reaped almost immediately".
  int _phaseEnteredMs = DateTime.now().millisecondsSinceEpoch;
  int get phaseAgeMs => DateTime.now().millisecondsSinceEpoch - _phaseEnteredMs;

  void _setPhase(String p) {
    _phase = p;
    _phaseEnteredMs = DateTime.now().millisecondsSinceEpoch;
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

  // ── [CALL-LOG-TIME-1] call-history duration + outcome ──────────────────────
  //
  // The call log used to record only "who / when it started", so both history
  // screens could say no more than "Outgoing · Yesterday". These three fields
  // are everything needed to close the row out at the end of the call.

  /// The in-flight `CallLogStore.add` for THIS call (null until the log line is
  /// written, e.g. on the pre-accept-cancel paths that return before it).
  Future<CallEntry>? _callLogAdd;

  /// Wall-clock ms at first remote media — the start of real talk time. 0 means
  /// the call never connected, and therefore has NO duration to show.
  int _connectedAtMs = 0;

  bool _callLogFinished = false;

  /// True once this call was ever handed to the receptionist. Sticky — see the
  /// assignment site for why `_receptionistActive` cannot be read here.
  bool _receptionistEverActive = false;

  /// Map the terminal phase onto a [CallOutcome] for a call that never connected.
  String _outcomeForPhase(String phase) {
    // The human never picked up — Ava did. "Cancelled" would be a lie and
    // "Missed" hides that the caller was actually served.
    if (_receptionistEverActive) return CallOutcome.noAnswer;
    switch (phase) {
      case 'declined':
        return CallOutcome.declined;
      case 'no-answer':
        return CallOutcome.noAnswer;
      case 'busy':
        return CallOutcome.busy;
      case 'network-error':
        return CallOutcome.failed;
      default:
        // We hung up first on an outgoing call; nobody picked up an incoming one.
        return config.outgoing ? CallOutcome.cancelled : CallOutcome.missed;
    }
  }

  /// Patch the history row with talk time + why it ended. Idempotent (`_endWith`
  /// can be reached more than once on tangled teardown paths) and best-effort —
  /// the call log must never be able to throw into a hang-up.
  void _finishCallLog(String phase) {
    if (_callLogFinished) return;
    _callLogFinished = true;
    final pending = _callLogAdd;
    if (pending == null) return;
    final talkedMs = _connectedAtMs == 0
        ? 0
        : DateTime.now().millisecondsSinceEpoch - _connectedAtMs;
    // Round, don't truncate: a 1.6s call is "2s", not "1s". Sub-second connects
    // floor to 1s so a genuinely-connected call never renders as an outcome.
    var durationSec = 0;
    if (talkedMs > 0) {
      durationSec = (talkedMs + 500) ~/ 1000;
      if (durationSec < 1) durationSec = 1;
    }
    final outcome =
        durationSec > 0 ? CallOutcome.connected : _outcomeForPhase(phase);
    unawaited(pending
        .then((e) => CallLogStore()
            .finish(e.id, durationSec: durationSec, outcome: outcome))
        .catchError((Object _) {/* history is best-effort */}));
  }

  /// [phase] drives the UI label; [reason] is the exhaustive telemetry taxonomy.
  void _endWith(String phase, {String? reason}) {
    _telemetry.ended(reason ?? phase);
    // [CALL-LOG-TIME-1] Record duration/outcome before any teardown runs.
    _finishCallLog(phase);
    _ringback.stop();
    final busy =
        phase == 'busy' && config.outgoing && RemoteConfig.ringbackEnabled;
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
    Analytics.capture('call_terminal_ui_applied', {
      'call_id': config.room,
      'call_trace_id': _traceId,
      'provider': _performanceProvider,
      'role': _performanceRole,
      'phase': phase,
      'reason': reason ?? phase,
      if (_answerAtMs != null)
        'elapsed_from_answer_ms':
            DateTime.now().millisecondsSinceEpoch - _answerAtMs!,
    });
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
  ///
  /// [CALL-SURVIVE-1 2026-08-04] Now DELEGATES to the shared tuner in
  /// core/audio_tuning.dart — this file used to carry its own copy with
  /// `maxaveragebitrate=40000`, silently regressing the CALLFIX-17 decision
  /// (40 kbps) on exactly the 1:1 path that needed the FEC headroom most.
  /// One tuner, one bitrate: 40000, `useinbandfec=1`, `usedtx=0` (DTX
  /// rationale lives with the shared tuner and in [CALL-AUDIO-DTX-1]),
  /// `stereo=0`.
  static String _tuneOpusSdp(String? sdp) => audio_tuning.tuneOpusSdp(
        sdp,
        enableRed: RemoteConfig.callAudioRedExperimentV1,
      );

  RTCSessionDescription _tuned(RTCSessionDescription d) {
    final sdp = _tuneOpusSdp(d.sdp);
    if (RemoteConfig.callAudioRedExperimentV1) {
      // [CALL-RED-1] Report whether RED is ACTUALLY ENGAGED, not merely listed.
      //
      // The old check fired on any `red/48000` rtpmap, which every modern
      // libwebrtc build advertises — so `call_audio_red_negotiated` read as
      // success for days while RED did nothing at all (the tuner's RED branch
      // was an empty `if` body). `applied` is the honest signal: red payload
      // first on the m=audio line AND carrying an fmtp block list. Alert on
      // `applied=false` while the flag is on — that means the local build has
      // no RFC-2198 support and we are running on in-band FEC alone.
      final applied = audio_tuning.sdpHasActiveRed(sdp);
      Analytics.capture('call_audio_red_negotiated', {
        'call_id': config.room,
        'applied': applied,
        'distance': audio_tuning.kOpusRedDistance,
        'sdp_type': d.type ?? 'unknown',
      });
    }
    return RTCSessionDescription(sdp, d.type);
  }

  /// [CF-CALL-P2P-1] Best-effort network-class check used ONLY to pick a
  /// conservative capture resolution / sender bitrate ceiling for 1:1 video
  /// (proposal Phase 5: "prefer 960x540 on cellular if network class known").
  /// Never blocks call setup; any failure (or an unknown/mixed result) falls
  /// back to treating the network as non-cellular — the higher, pre-existing
  /// bound — so this can only make behavior MORE conservative, never less.
  Future<bool> _isLikelyCellular() async {
    try {
      final results = await Connectivity().checkConnectivity();
      final hasWifiOrEthernet = results.contains(ConnectivityResult.wifi) ||
          results.contains(ConnectivityResult.ethernet);
      final hasMobile = results.contains(ConnectivityResult.mobile);
      return hasMobile && !hasWifiOrEthernet;
    } catch (_) {
      return false;
    }
  }

  void _announceNetClass() {
    if (!RemoteConfig.callCellPresetV1 || _remoteId == null) return;
    _send({'type': 'net-class', 'to': _remoteId, 'cellular': _localCellular});
  }

  Future<void> _refreshAndAnnounceNetClass() async {
    if (!RemoteConfig.callCellPresetV1) return;
    _localCellular = await _isLikelyCellular();
    _announceNetClass();
  }

  Future<void> _bootMedia() async {
    _stage('boot_start');
    // ── [CALL-DEADAIR-1 2026-08-08] PARALLEL PROLOGUE ────────────────────────
    //
    // These four things are mutually INDEPENDENT — two renderer initialisations,
    // the ICE credential fetch, and the network-class probe. They used to be
    // four sequential `await`s, so their latencies ADDED, and every one of them
    // sat AHEAD of `getUserMedia`, which in turn sits ahead of the signalling
    // socket that is the only thing that can start the SFU ladder. On an
    // outgoing call that is silence before the ring; on an INCOMING call it is
    // silence after the user pressed Accept, which is exactly the dead air
    // measured on avatok-17f145b5.
    //
    // `_fetchIce()` in particular is a network round trip whose result the SFU
    // path barely uses (`/callsfu/join` returns its own `ice_servers`; `_ice` is
    // only the fallback list) — it had no business blocking the microphone.
    //
    // `.catchError` is load-bearing, not defensive noise: the `getUserMedia`
    // catch below can `return` out of this method, and an un-awaited future that
    // throws after that would surface as an unhandled async error with no call
    // context. IceCache already falls back to `kIceServers` internally, so
    // swallowing here changes no behaviour.
    final bool parallelBoot = RemoteConfig.callSetupParallelBootV1;
    Future<void>? iceFuture;
    Future<bool>? cellFuture;
    if (parallelBoot) {
      iceFuture = _fetchIce().catchError((Object _) {});
      cellFuture = config.video
          ? _isLikelyCellular().catchError((Object _) => false)
          : null;
      await Future.wait(<Future<void>>[
        localRenderer.initialize(),
        remoteRenderer.initialize()
      ]);
    } else {
      await localRenderer.initialize();
      await remoteRenderer.initialize();
      await _fetchIce();
    }
    _stage('renderers_ready');
    // [CALL-VIDEO-FIX-1 2026-08-17] Truthful "video actually visible" signal.
    // Set once — `remoteRenderer` is a single field reused for the whole
    // call (P2P, SFU, migration all repoint its `srcObject`), so one
    // assignment here covers every later video attach, including a mid-call
    // SFU upgrade. `onFirstFrameRendered` exists on `RTCVideoRenderer` in
    // the pinned flutter_webrtc (^0.12.5) — confirmed against the package's
    // public API surface, not by a local build (no toolchain on this
    // machine to compile-check it).
    remoteRenderer.onFirstFrameRendered = () {
      final attachedAt = _remoteVideoAttachedAtMs;
      Analytics.capture('remote_video_first_frame', {
        'call_id': config.room,
        if (attachedAt != null)
          'ms_from_attach': DateTime.now().millisecondsSinceEpoch - attachedAt,
      });
    };
    // [CF-CALL-P2P-1] Decide the initial capture resolution before opening the
    // camera — cheaper than capturing high-res then downscaling, and the
    // sender-side bitrate cap in [_preferResolutionOnVideo] uses the same
    // network-class check so capture and encoding bounds agree.
    final cellularCapture =
        config.video ? await (cellFuture ?? _isLikelyCellular()) : false;
    // [CALL-PREROLL-1 2026-08-17] The callee may already have a fully
    // pre-rolled mic stream — acquired, SILENT, during the ring by
    // `CallPrewarm` (gated on `callPrewarmOnRingV1` + `callPrerollV1`).
    // `peek` is non-consuming: `CallPrewarm` still owns full teardown of the
    // seat/transport/stream until `_startSfuMedia`'s `adopt()` call later in
    // this same boot, so a call that never reaches that point (RTK/P2P
    // selected, or the call ends mid-boot) is still torn down correctly by
    // `CallPrewarm` itself, not leaked here. Scoped to AUDIO-ONLY calls on
    // purpose — the preroll never captures video, so a video call always
    // falls through to a fresh `getUserMedia` below exactly as before this
    // flag existed.
    // [CALL-SILENT-SLOT-1] For an incoming audio call whose foreground
    // prewarm has already published a null-track SENDONLY section, keep Accept
    // independent of microphone acquisition: the session starts with an empty
    // local stream, then replaces the retained sender after the SFU PC is
    // adopted. This is protocol silence, never a captured/muted mic.
    MediaStream? protocolSilenceStream;
    // [CALL-PREWARM-TRUTH-1 2026-08-21] `callSfuV1` is part of the condition on
    // purpose, belt and braces with the same gate inside CallPrewarm. Deferring
    // the microphone past Accept is only ever correct when there is a real
    // published SFU sender waiting for `replaceTrack`. Taking this branch
    // without one costs a full post-answer `getUserMedia` (~2.2s measured on
    // 2026-08-20) and shipped silence to the peer for the whole call.
    if (!config.outgoing &&
        !config.video &&
        RemoteConfig.callSilentTransportPrewarmV1 &&
        RemoteConfig.callSfuV1 &&
        CallPrewarm.instance.hasPrepublishedAudio(config.room)) {
      try {
        protocolSilenceStream =
            await createLocalMediaStream('prewarm-${config.room}');
        _prewarmAudioPending = true;
        Analytics.capture('call_preaccept_audio_slot', {
          'call_id': config.room,
          'privacy': 'null_track_protocol_silence',
        });
      } catch (e) {
        Analytics.capture('call_preaccept_audio_slot_failed', {
          'call_id': config.room,
          'failure': e.toString(),
        });
      }
    }
    final prerolledStream = protocolSilenceStream ??
        (config.video ? null : CallPrewarm.instance.peek(config.room));
    if (protocolSilenceStream != null) {
      _stream = protocolSilenceStream;
    } else if (prerolledStream != null) {
      _stream = prerolledStream;
      // [CALL-PREROLL-1] CRITICAL: this track was published SILENT during
      // the ring (privacy rule: nothing is captured-and-sent pre-accept) —
      // this is the ONE place it is unmuted, at the moment this call is
      // genuinely being answered. See `_startSfuMedia`'s `hasFullPreroll`
      // branch for the matching remote-track unmute.
      for (final t in prerolledStream.getAudioTracks()) {
        try {
          t.enabled = true;
        } catch (_) {/* one bad track must not abort accept */}
      }
    } else {
      // ── [STREAM-PERM-1 2026-08-21] Preflight, before any media is touched ──
      //
      // Asking the OS FIRST means a genuine refusal is named as one here, by
      // itself, and everything that reaches the `catch` below is therefore NOT
      // a permission problem. `ensure` only prompts when the permission is
      // merely `denied`; a granted permission costs one cheap status read, and
      // an unsupported platform returns `unknown` and proceeds (never block a
      // call on the checker).
      final perms = await CallMediaPermissions.ensure(
        video: config.video,
        surface: 'legacy_lane',
        callId: config.room,
      );
      if (!perms.canProceed) {
        final failure = CallMediaFailure(
          kind: MediaFailureKind.permissionDenied,
          video: config.video,
          canOpenSettings: perms.needsSettings,
        );
        Analytics.error(
          domain: 'call_setup',
          code: failure.code,
          message: 'preflight ${perms.code} (${perms.blockedBy})',
          action: 'media_preflight',
          extra: {
            'call_id': config.room,
            'video': config.video,
            'blocked_by': perms.blockedBy,
            'can_open_settings': failure.canOpenSettings,
          },
        );
        _mediaFailureNotice?.call(failure);
        _endWith('ended', reason: failure.endReason);
        return;
      }
      try {
        var mediaTimedOut = false;
        final mediaFuture = navigator.mediaDevices.getUserMedia({
          // [CALL-SURVIVE-1] de-dup: the shared capture-DSP constraints
          // (AEC/NS/AGC/high-pass) are defined ONCE in core/audio_tuning.dart.
          'audio': audio_tuning.avaMicConstraints(),
          // [CF-CALL-P2P-1] Explicit, bounded capture constraints (proposal
          // Phase 5 "camera constraints"): 960x540@30 max on wifi/unknown,
          // 640x360@24 on a detected cellular network. `ideal` lets the camera
          // pick a supported mode near this; `max` is the hard ceiling so a
          // high-end camera never captures (and encodes) far above what a 1:1
          // call needs.
          'video': config.video
              ? audio_tuning.avaVideoConstraints(cellular: cellularCapture)
              : false,
        });
        // Future.timeout cannot cancel the platform acquisition. If Android
        // returns a stream after our deadline, stop and dispose it immediately so
        // an ended call cannot leave the microphone/camera active invisibly.
        unawaited(mediaFuture.then((lateStream) async {
          if (!mediaTimedOut) return;
          for (final track in lateStream.getTracks()) {
            try {
              await track.stop();
            } catch (_) {}
          }
          try {
            await lateStream.dispose();
          } catch (_) {}
          Analytics.capture('call_media_late_stream_disposed', {
            'call_id': config.room,
            'video': config.video,
          });
        }).catchError((_) {}));
        _stream = await mediaFuture
            // ── [CALL-MEDIA-TIMEOUT-1 2026-08-03] (audit M3) ──────────────────
            //
            // `getUserMedia` had no timeout. A REFUSAL was already handled well by
            // the catch below — but a HANG was not handled at all. On Android 12+
            // a mic acquisition made while the app is in the background can simply
            // never return: no permission dialog, no error, no completion. The
            // Future stayed pending and the only thing that eventually ended the
            // call was a generic 10–45 s connect watchdog, which reports "could
            // not connect" — the wrong diagnosis, and one that sends the user
            // looking at their network instead of at a microphone the OS refused
            // to open.
            //
            // 8 s is comfortably longer than a real capture (tens of ms) or a
            // human tapping through a permission prompt, and well inside the
            // connect watchdogs so this surfaces FIRST and names the actual cause.
            // The throw lands in the existing catch, so failure handling and
            // teardown are unchanged — only the diagnosis improves.
            .timeout(const Duration(seconds: 8), onTimeout: () {
          mediaTimedOut = true;
          throw TimeoutException(
              'getUserMedia did not return within 8s (mic/camera acquisition hung)');
        });
      } catch (e, st) {
        // ── [STREAM-PERM-1 2026-08-21] Four outcomes, not two ────────────────
        //
        // This catch used to label EVERY non-timeout throw `media_denied` and
        // show "Microphone permission is needed to make a call". On build 10612
        // the real error was `getUserMedia(): unknown factoryId null` — a WebRTC
        // ENGINE fault from the `stream_webrtc_flutter` swap — while
        // `RECORD_AUDIO` was granted on both test devices the entire time. The
        // copy sent the incident three rounds deep into OS permissions and
        // emulator audio that were never the problem.
        //
        // `classifyMediaFailureWithPermissions` reads the ACTUAL permission
        // state (cheap, no prompt) and lets it outrank the exception string, so
        // only a genuine refusal is ever called a denial.
        final failure = await classifyMediaFailureWithPermissions(
          e,
          video: config.video,
        );
        Analytics.error(
          domain: 'call_setup',
          code: failure.code,
          message: e.toString(),
          action: config.video ? 'getUserMedia_av' : 'getUserMedia_audio',
          extra: {
            'call_id': config.room,
            'video': config.video,
            'media_failure_kind': failure.kind.name,
            'can_open_settings': failure.canOpenSettings,
          },
        );
        _telemetry.runtimeError(
          stage: 'get_user_media_failed',
          error: e,
          stack: st,
          extra: {
            'video_requested': config.video,
            'media_failure_kind': failure.kind.name,
          },
        );
        _mediaFailureNotice?.call(failure);
        _endWith('ended', reason: failure.endReason);
        return;
      }
    } // [CALL-PREROLL-1] end of the `prerolledStream == null` cold-getUserMedia branch
    _stage(_prewarmAudioPending ? 'protocol_silence_ready' : 'mic_ready');
    // [CALL-DEADAIR-1] Join the ICE fetch back in. By here it has almost always
    // already resolved (it ran alongside the mic acquisition), so this is a
    // no-cost join rather than a serial wait — but `_ice` MUST be settled before
    // any peer connection is built, including the P2P fallback path.
    if (iceFuture != null) await iceFuture;
    _stage('ice_ready');
    localRenderer.srcObject = _stream;
    // [CALL-SPEAKER-RAMP 2026-07-12] Establish the communication audio session
    // (MODE_IN_COMMUNICATION + audio focus) BEFORE selecting the speaker route,
    // so the route is applied once inside an established session instead of
    // triggering a cold re-route + volume ramp at the very start of the call.
    //
    // [CALL-AUDIO-OWNER-1 2026-08-07] `CallAudioController` is now THE single
    // owner of route/mode/speaker for the whole call, superseding
    // `callAudioControllerV2` below. It replaces this hardcoded
    // `selectRoute(config.video ? speaker : earpiece, source: 'initial')` —
    // which ran AFTER `_fetchIce()` + `getUserMedia` (4-8s into the call) and
    // landed behind the user's own Speaker press in the same serialized
    // native queue, silently overriding it (prod: `call_audio_route_requested
    // source=user_toggle` at +5.2s with no matching `_result`). `apply` below
    // asks native for whatever `intent` is AT THAT MOMENT, so a user press
    // that races this boot-media call always wins — `setIntent` (in
    // `toggleSpeaker`) updates `intent` before its own `apply` is queued.
    if (RemoteConfig.callAudioOwnerV1) {
      await NativeVoiceAudio.instance
          .beginP2pSession(callId: config.room, video: config.video);
      CallAudioController.instance.seed(
        callId: config.room,
        route: config.video ? CallAudioRoute.speaker : CallAudioRoute.earpiece,
      );
      CallAudioController.instance.onRouteConfirmed = (confirmedSpeaker) {
        _speaker = confirmedSpeaker;
        speakerOn.value = confirmedSpeaker;
        // ignore: unawaited_futures
        _ringback.setSpeaker(confirmedSpeaker);
        // ignore: unawaited_futures
        _receptionist?.setSpeaker(confirmedSpeaker);
      };
      final result =
          await CallAudioController.instance.apply(source: 'boot_media');
      if (result != null) {
        Analytics.capture('call_audio_route', {
          'route': result.active.name,
          'auto': true,
        });
      }
      // CALL-REL-1: when callAudioControllerV2 is on, NativeVoiceAudio.instance
      // is the ONLY thing that starts the P2P audio session / picks the route —
      // CallSession no longer calls Helper.setSpeakerphoneOn, startBluetoothSco,
      // or the proximity sensor directly. Flag off preserves the exact prior
      // behavior below.
    } else if (RemoteConfig.callAudioControllerV2) {
      await NativeVoiceAudio.instance
          .beginP2pSession(callId: config.room, video: config.video);
      final result = await NativeVoiceAudio.instance.selectRoute(
        config.video ? CallAudioRoute.speaker : CallAudioRoute.earpiece,
        source: 'initial',
      );
      _speaker = result.active == CallAudioRoute.speaker;
      speakerOn.value = _speaker;
      Analytics.capture('call_audio_route', {
        'route': result.active.name,
        'auto': true,
      });
    } else {
      try {
        await NativeVoiceAudio().startP2pAudioMode();
      } catch (_) {}
      try {
        await Helper.setSpeakerphoneOn(_speaker);
      } catch (_) {}
      try {
        await NativeVoiceAudio().startBluetoothSco();
      } catch (_) {}
      if (NativeVoiceAudio.isSupported) {
        final route = (await NativeVoiceAudio().getAudioRoute()) ?? 'unknown';
        if (route == 'earpiece') {
          Analytics.capture(
              'call_audio_route', {'route': 'earpiece', 'auto': true});
          try {
            await NativeVoiceAudio().startProximitySensor();
          } catch (_) {}
        } else {
          Analytics.capture('call_audio_route', {'route': route, 'auto': true});
        }
      }
    }
    _stage('audio_session_ready');
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
          if (event['change'] != null)
            'focus_change': event['change'].toString(),
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
        _focusRouteRecoveryTimer?.cancel();
        _focusRouteRecoveryTimer = null;
        _onFocusHold = true;
        _focusLostMs = DateTime.now().millisecondsSinceEpoch;
        onCellularHold.value = true; // reuse the "on hold" UI signal
        _applyLocalAudioEnabled();
        _send({'type': 'mute', 'muted': true});
        _syncRecorderHold(); // [CALLHOLD-1] our capture is gone — hold the recorder
        Analytics.capture('call_audio_focus_lost', {'call_id': config.room});
        // [CALL-FOCUS-DEADLOCK-1] Arm the release watchdog — see the field doc.
        // A permanent AUDIOFOCUS_LOSS never produces a regain callback, so
        // without this the mute below is forever.
        _focusHoldWatchdog?.cancel();
        _focusHoldWatchdog =
            Timer(_kFocusHoldMaxDuration, _releaseStuckFocusHold);
      };
      NativeVoiceAudio.instance.onAudioFocusRegained = () {
        _focusHoldWatchdog?.cancel();
        _focusHoldWatchdog = null;
        if (!_onFocusHold) return;
        _onFocusHold = false;
        final heldMs = _focusLostMs == null
            ? 0
            : DateTime.now().millisecondsSinceEpoch - _focusLostMs!;
        _focusLostMs = null;
        // Only clear the hold banner if a cellular hold isn't also active.
        if (!_onCellularHold) onCellularHold.value = false;
        _applyLocalAudioEnabled();
        _send({'type': 'mute', 'muted': _muted});
        _syncRecorderHold(); // [CALLHOLD-1] capture is back — resume the recorder
        Analytics.capture('call_audio_focus_regained', {
          'call_id': config.room,
          'held_ms': heldMs,
        });
        unawaited(_recoverAudioAfterFocusRelease(
          reason: 'platform_regained',
          heldMs: heldMs,
        ));
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
            _applyLocalAudioEnabled();
            _send({'type': 'mute', 'muted': true});
            _syncRecorderHold(); // [CALLHOLD-1]
            Analytics.capture('call_cellular_held', {'call_id': config.room});
          } else if (state == 'resumed' && _onCellularHold) {
            _onCellularHold = false;
            onCellularHold.value = false;
            _applyLocalAudioEnabled();
            _send({'type': 'mute', 'muted': _muted});
            _syncRecorderHold(); // [CALLHOLD-1]
            Analytics.capture(
                'call_cellular_resumed', {'call_id': config.room});
          }
        });
      } catch (_) {}
    }
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_ended) return;
      _secs++;
      elapsedSeconds.value = _secs;
    });
    // [CALL-WS-AUTH-1] For an OUTGOING call the join credential arrives on the
    // /api/call response, which the optimistic mount has not necessarily
    // received yet. Wait briefly rather than connect un-credentialed and have to
    // rebuild the socket. Bounded and fail-open: on timeout we connect exactly
    // as before, so this can never be the reason a call fails to start. The
    // callee already holds its token (it came with the ring) so it never waits.
    // Process death clears the in-memory holding pen. Restore the account-scoped
    // secure credential before any first/reconnect socket is constructed.
    if (roomTokenFor(_room).isEmpty) {
      await _restoreRoomToken(_room);
      if (_ended) return;
    }
    if (config.outgoing && roomTokenFor(_room).isEmpty) {
      await _awaitRoomToken(_room, const Duration(milliseconds: 2500));
      if (_ended) return;
    }
    final url = _signalingUrl();
    _ws = WebSocketChannel.connect(Uri.parse(url));
    // [CALL-DEADAIR-1] The socket is the gate on EVERYTHING downstream: the SFU
    // ladder cannot begin until `welcome`/`sfu-start` arrives on it. Timing it
    // separates "we were slow to get to the wire" from "the wire was slow".
    _stage('ws_open');
    _ws!.stream.listen(_onSignal,
        onError: (_) => _onSocketLost(), onDone: _onSocketLost);
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
    _armRelayFallbackTimer(const Duration(seconds: 4));
  }

  /// [CALL-VIDEO-SFUGUARD-1 2026-08-14] The P2P relay-escalation ladder, now
  /// SFU-aware. The 4s timer used to check only `_connected || _ended` — but
  /// `CallSfuTransport.connect()` builds its PeerConnection through `_newPC`,
  /// which assigns `_pc` as a side effect, and `_forceRelayRestart` closes
  /// `_pc` unconditionally. On a VIDEO call the camera warm-up pushes the SFU
  /// join past 4s every time, so the ladder fired mid-join, closed the SFU's
  /// own PC, and the SFU answer then died with "setRemoteDescription: wrong
  /// state: closed" (prod calls avatok-9f2fccad / -5fa7bef2 / -9f407abf,
  /// 2026-08-14 — 3 of 3 accepted video calls never connected; the audio call
  /// connected in ~4.5s and squeaked past the timer). Ten other paths in this
  /// file already guard on `_sfuActive || _sfuStarting ||
  /// _sfuReconnectInFlight`; this ladder was the one that didn't.
  ///
  /// While the SFU is STARTING/RECONNECTING the ladder DEFERS (re-arms, 2s) so
  /// it still runs if the SFU attempt aborts back to P2P. While the SFU is
  /// ACTIVE the ladder stops outright — media is flowing on a path the P2P
  /// relay escalation has no business restarting.
  void _armRelayFallbackTimer(Duration d) {
    _relayFallbackTimer?.cancel();
    _relayFallbackTimer = Timer(d, () {
      if (_connected || _ended) return;
      if (_sfuActive) return;
      if (_sfuStarting || _sfuReconnectInFlight) {
        Analytics.capture('call_relay_fallback_deferred_sfu', {
          'call_id': config.room,
          'video': config.video,
          'starting': _sfuStarting,
          'reconnecting': _sfuReconnectInFlight,
        });
        _armRelayFallbackTimer(const Duration(seconds: 2));
        return;
      }
      // ── [CALL-RELAY-ANSWERER-1 2026-08-03] (audit M1, answerer half) ───────
      //
      // `_forceRelayRestart` returns early unless `_weOffered`, so only the
      // OFFERER could ever escalate to a relay. On a symmetric-NAT pair that is
      // precisely half a fix: if the offerer's own escalation is what fails or
      // is delayed, the ANSWERER sits at 4 s, 10 s, 45 s with a perfectly good
      // TURN path available and no way to ask for it. It waits on a peer that
      // may not act.
      //
      // The answerer cannot simply escalate itself — a second unsolicited offer
      // is glare, which is the bug the offerer-only rule exists to avoid. So it
      // ASKS. That keeps ONE side authoritative for renegotiation (unchanged)
      // while letting either side start the clock, and it reuses the exact
      // request/initiator pattern already established for mid-call relay
      // migration ([BLOCKER-2 fix], `relay-migrate-request`).
      if (_weOffered) {
        _forceRelayRestart();
      } else if (_remoteId != null) {
        Analytics.capture('call_relay_fallback_requested', {
          'call_id': config.room,
          'video': config.video,
          'role': 'answerer',
        });
        _send({'type': 'relay-fallback-request', 'to': _remoteId});
      }
    });
  }

  // ── View notice hooks (snackbars) — set by the attached view. ───────────────
  // [STREAM-PERM-1] Carries the CLASSIFIED failure, so the view can print the
  // right sentence (and only offer "Open settings" for a real denial) instead
  // of the one hardcoded permission string it used to show for everything.
  void Function(CallMediaFailure failure)? _mediaFailureNotice;

  /// [STREAM-PERM-1] The last classified media failure, set by
  /// `_ensureAcceptedAudio` so its three callers can end the call with the RIGHT
  /// reason instead of the flat `media-denied` they all used to pass.
  CallMediaFailure? _lastMediaFailure;

  /// End the call on a post-Accept media failure, telling the user what actually
  /// went wrong. Falls back to the honest-but-vague `unknown` kind when the
  /// classifier never ran.
  void _endWithMediaFailure() {
    final failure = _lastMediaFailure ??
        CallMediaFailure(kind: MediaFailureKind.unknown, video: config.video);
    _lastMediaFailure = null;
    _mediaFailureNotice?.call(failure);
    _endWith('ended', reason: failure.endReason);
  }
  void Function()? _placeCallFailedNotice;
  void Function()? _unreachableNotice;
  // [RECEPT-SETTINGS-1] the free-voicemail status snackbars were removed with the
  // voicemail feature.
  /// The view registers user-facing snackbar callbacks. Cleared on detach.
  void setNoticeHooks({
    void Function(CallMediaFailure failure)? mediaFailure,
    void Function()? placeCallFailed,
    void Function()? unreachable,
  }) {
    _mediaFailureNotice = mediaFailure;
    _placeCallFailedNotice = placeCallFailed;
    _unreachableNotice = unreachable;
  }

  Future<void> _forceRelayRestart() async {
    if (_ended || _connected || _relayForced) return;
    if (!_weOffered || _remoteId == null) return;
    // [CALL-VIDEO-SFUGUARD-1] Belt-and-braces on the restart itself: this is
    // also reachable via the peer's `relay-fallback-request`, and the
    // `_pc?.close()` below would kill an in-flight/active SFU join exactly the
    // way the local timer used to (see _armRelayFallbackTimer).
    if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) {
      Analytics.capture('call_relay_fallback_deferred_sfu', {
        'call_id': config.room,
        'video': config.video,
        'starting': _sfuStarting,
        'reconnecting': _sfuReconnectInFlight,
        'via': 'force_relay_restart',
      });
      return;
    }
    _relayForced = true;
    _telemetry.onIceRestart();
    _telemetry.setMediaPath(
        'relay'); // [CALL-REL-4/5] amends call_progress/call_media_health
    Analytics.capture(
        'call_relay_fallback', {'call_id': config.room, 'video': config.video});
    try {
      try {
        await _pc?.close();
      } catch (_) {}
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
      Analytics.capture('call_ws_reconnect_preconnect', {
        'call_id': config.room,
        'phase': _phase,
        'attempt': _wsReconnects + 1
      });
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
      if (!isConnected && (_phase != 'ringing' && _phase != 'connecting'))
        return;
      try {
        _ws?.sink.close();
      } catch (_) {}
      final url = _signalingUrl(); // [CALL-WS-AUTH-1] carries ?t= on reconnect
      try {
        _ws = WebSocketChannel.connect(Uri.parse(url));
        _ws!.stream.listen(_onSignal,
            onError: (_) => _onSocketLost(), onDone: _onSocketLost);
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
    _stopPlayoutHealthSampler(); // [CALL-REL-4]
    if (!_reconnecting) {
      _reconnecting = true;
      _reconnectAttempt = 0;
      _reconnectStartMs = DateTime.now().millisecondsSinceEpoch;
      _setPhase('reconnecting');
      // peerAway is a separate signal (the OTHER peer's socket state, driven
      // by peer-away/peer-rejoined below); our own drop doesn't imply theirs.
      Analytics.capture('call_reconnect_start',
          {'call_id': config.room, 'video': config.video});
      _reconnectGiveUpTimer?.cancel();
      _reconnectGiveUpTimer = Timer(_kReconnectGiveUp, () {
        // ignore: unawaited_futures
        _onReconnectGiveUpDeadline();
      });
    }
    _scheduleReconnectAttempt();
  }

  /// [CALL-SURVIVE-2 2026-08-04] The WS give-up deadline is now MEDIA-AWARE.
  /// Signaling and media are independent transports: the WS can be down (edge
  /// blip, DO restart, captive re-auth) while P2P/relay RTP flows perfectly.
  /// Ending the call on a 30s signaling outage alone (`reconnect_failed`)
  /// hung up on two people who could still hear each other — and undercut the
  /// [CALL-SURVIVE-1] rule that only a genuinely-gone peer ends a call.
  /// On deadline: probe inbound audio directly (the samplers are stopped
  /// during the ladder, so cached health is stale). Media alive → keep
  /// retrying the WS and re-arm the deadline; media dead too → NOW it's a
  /// real `reconnect_failed`.
  Future<void> _onReconnectGiveUpDeadline() async {
    if (_ended || !_reconnecting) return;
    final mediaAlive = await _probeInboundAudioAlive();
    if (_ended || !_reconnecting) return;
    if (mediaAlive) {
      Analytics.capture('call_ws_down_media_alive', {
        'call_id': config.room,
        'elapsed_ms':
            DateTime.now().millisecondsSinceEpoch - (_reconnectStartMs ?? 0),
        'attempts': _reconnectAttempt,
      });
      _reconnectGiveUpTimer = Timer(_kReconnectGiveUp, () {
        // ignore: unawaited_futures
        _onReconnectGiveUpDeadline();
      });
      return;
    }
    Analytics.capture('call_reconnect_fail', {
      'call_id': config.room,
      'elapsed_ms':
          DateTime.now().millisecondsSinceEpoch - (_reconnectStartMs ?? 0),
      'attempts': _reconnectAttempt,
    });
    _endWith('ended', reason: 'reconnect_failed');
  }

  /// [CALL-SURVIVE-2] Direct liveness probe: inbound audio bytes advancing
  /// over a 2s window. Used only at the WS give-up deadline, where the
  /// watchdog/sampler caches are deliberately stopped and therefore stale.
  Future<bool> _probeInboundAudioAlive() async {
    try {
      final pc = _pc;
      if (pc == null) return false;
      Future<int> readBytes() async {
        var b = 0;
        for (final s in await pc.getStats()) {
          if (s.type != 'inbound-rtp') continue;
          final kind = (s.values['kind'] ?? s.values['mediaType'])?.toString();
          if (kind != 'audio') continue;
          final v = s.values['bytesReceived'];
          if (v is num) b += v.toInt();
        }
        return b;
      }

      final before = await readBytes();
      await Future.delayed(const Duration(seconds: 2));
      if (_ended) return false;
      return await readBytes() > before;
    } catch (_) {
      return false; // unprobeable = treat as dead (conservative)
    }
  }

  void _scheduleReconnectAttempt() {
    if (_ended || !_reconnecting) return;
    _reconnectRetryTimer?.cancel();
    final idx = _reconnectAttempt.clamp(0, _kReconnectBackoffSec.length - 1);
    final delay =
        Duration(milliseconds: (_kReconnectBackoffSec[idx] * 1000).round());
    _reconnectAttempt++;
    _reconnectRetryTimer = Timer(delay, _attemptReconnect);
  }

  void _attemptReconnect() {
    if (_ended || !_reconnecting) return;
    // Give-up timer is the source of truth for the 30s cap; just try again.
    try {
      _ws?.sink.close();
    } catch (_) {}
    final url = _signalingUrl(); // [CALL-WS-AUTH-1] carries ?t= on reconnect
    try {
      _ws = WebSocketChannel.connect(Uri.parse(url));
      _ws!.stream.listen(_onSignal,
          onError: (_) => _onSocketLost(), onDone: _onSocketLost);
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
    final ms = DateTime.now().millisecondsSinceEpoch -
        (_reconnectStartMs ?? DateTime.now().millisecondsSinceEpoch);
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
      _startPlayoutHealthSampler(); // [CALL-REL-4]
    }
  }

  /// [CALL-WS-AUTH-1] The signalling URL, carrying the CallRoom join credential
  /// as `?t=` when this device holds one.
  ///
  /// One builder for all three connect sites (first connect, pre-connect
  /// reconnect, post-connect reconnect) so a reconnect can never drop the
  /// credential and get refused at re-admission — which, once
  /// `callRoomAuthEnforced` is on, would turn every network blip into a dead
  /// call. Omitting `t` when we have none is deliberate: while the flag is off
  /// the server admits and merely tags the join, so old servers and this client
  /// interoperate unchanged in both directions.
  String _signalingUrl() {
    final t = roomTokenFor(_room);
    final base = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    return t.isEmpty ? base : '$base&t=${Uri.encodeQueryComponent(t)}';
  }

  /// 15s keepalive over the signalling WS, matching the DO's
  /// `setWebSocketAutoResponse({type:"ping"} -> {type:"pong"})` (CALL-RC-D1).
  ///
  /// ── [CALL-KEEPALIVE-1 2026-08-03] (audit H5) THE PING WAS BROKEN ──────────
  ///
  /// This used to call `_send({'type': 'ping'})`. `_send` stamps `gen` on EVERY
  /// frame once we have received `welcome` (CALL-GEN-1), so from the moment a
  /// call is actually up the wire carried `{"type":"ping","gen":N}` — and
  /// `setWebSocketAutoResponse` is an EXACT STRING match against
  /// `{"type":"ping"}`. It never matched. On every connected call, therefore:
  ///
  ///   * NO PONG WAS EVER RETURNED. The comment that used to sit here — "the DO
  ///     answers without waking" — described behaviour that had not actually
  ///     happened since CALL-GEN-1 shipped.
  ///   * Every ping WOKE THE DO, defeating the hibernation this was designed to
  ///     preserve; fell through to `webSocketMessage`; matched no case; carried
  ///     no `to` — and was therefore BROADCAST TO THE PEER as noise, which the
  ///     peer silently ignored.
  ///
  /// Two things follow. The fix is to send the keepalive RAW, bypassing `_send`'s
  /// gen stamping so it exact-matches the auto-response — which works against
  /// every already-deployed server and needs no worker change. And the
  /// missed-pong deadline below is only MEANINGFUL because of that fix: a
  /// counter layered on top of the broken ping would have seen zero pongs on
  /// every healthy call and forced a reconnect every 30 s, on every call.
  void _startPingTimer() {
    _pingTimer?.cancel();
    _missedPongs = 0;
    _pingTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (_ended) return;
      // ── [CALL-DEADPEER-1 2026-08-03] (audit H3) DEAD-BUT-OPEN DETECTION ────
      //
      // Neither side could see a socket that is open but dead. The server's only
      // death signal is webSocketClose/Error, and auto-response frames never wake
      // the DO to notice silence. The client sent pings and tracked nothing. A
      // silent TCP death — the classic WiFi→5G handover — was invisible to both
      // ends until the OS eventually surfaced it, which on Android can take
      // minutes. To the user that is a call still showing "connected" with
      // nobody there.
      //
      // Check the pings that were actually sent on earlier ticks. Incrementing
      // before this check counted the current, not-yet-sent ping as missed and
      // reconnected after only one unanswered request.
      if (_missedPongs >= 2) {
        _missedPongs = 0;
        Analytics.capture('call_ws_keepalive_timeout', {
          'call_id': config.room,
          'phase': _phase,
          'connected': _connected,
        });
        // PHASE-CORRECT RECOVERY. There are two reconnect machines and they are
        // not interchangeable: `_beginReconnect` is the POST-connect ladder
        // (phase → 'reconnecting', give-up timer, hangup on failure), while
        // `_reconnectSignaling` is the PRE-connect one for a call still ringing
        // or connecting. Calling the post-connect machine during ringing would
        // drive a call that has not started yet into a state machine built to
        // end it.
        if (_connected) {
          _beginReconnect();
        } else {
          _reconnectSignaling(isConnected: false);
        }
        return;
      }
      // RAW send — deliberately NOT `_send`. See above: adding a `gen` field
      // here is what silently disabled the server's auto-response.
      try {
        _ws?.sink.add(jsonEncode({'type': 'ping'}));
        _missedPongs++;
      } catch (_) {/* socket gone */}
    });
  }

  void _stopPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = null;
    _missedPongs = 0;
  }

  void _send(Map<String, dynamic> o) {
    // CALL-GEN-1: stamp our current generation on every frame so the DO can drop
    // frames from a superseded transport. Omitted until we've received a 'welcome'
    // with a gen (old server / pre-connect) — an old server ignores the field and
    // an old client never sees it, so this is fully backward compatible.
    if (_gen != null && !o.containsKey('gen')) o['gen'] = _gen;
    try {
      _ws?.sink.add(jsonEncode(o));
    } catch (_) {/* socket closed / gone */}
  }

  // ── [CALLREC-PEER-1] Peer-visible recording state ───────────────────────────
  //
  // The consent design (spec §4) rests on two surfaces: the ToS clause and a
  // "Recording" indicator on BOTH call screens. Until this landed, the pill was
  // bound to `CallRecordingStore.I.phase` — purely local state — so only the
  // person doing the recording ever saw it, while the consent dialog told them
  // the other party could. This is the wire that makes that true.
  //
  // It is modelled exactly on `sfu-video`: one typed frame through the CallRoom
  // relay, which forwards any frame with a `to` verbatim (call_room.ts:2373) and
  // BROADCASTS any frame without one (call_room.ts:2430) — so no worker change
  // was needed. `to` is included when we know the peer id and omitted when we do
  // not, because the broadcast fallback is the only thing that reaches a peer we
  // have not yet learned an id for (the SFU path never exchanges a peer `offer`,
  // so the first joiner's `_remoteId` can still be null on a live call).
  //
  // An unknown `callrec` frame on an older client falls through the receive
  // switch with no `default:` branch — a no-op, never an exception.

  /// Are WE recording THIS call right now? The recorder is process-wide and
  /// refuses a second call, so "recording" is not enough — it has to be this
  /// room, or we would tell a peer they are being recorded when they are not.
  bool get _localRecordingActive {
    try {
      return CallRecordingStore.I.activeCallId.value == config.room &&
          CallRecordingStore.I.phase.value == CallRecordingPhase.recording;
    } catch (_) {
      return false;
    }
  }

  /// Tell the peer whether we are recording.
  ///
  /// [force] re-sends even when nothing changed — used on connect/rejoin, where
  /// the peer may never have seen the original frame (armed before they joined,
  /// or they reconnected mid-call). A missed frame here means someone is being
  /// recorded with no indicator, which is the exact failure this prevents, so
  /// re-announcing costs one tiny frame and is always worth it.
  void _announceRecordingState({bool force = false}) {
    try {
      if (_ended) return;
      final on = _localRecordingActive;
      if (!force && on == _lastRecordingAnnounced) return;
      _lastRecordingAnnounced = on;
      _send(<String, dynamic>{
        'type': 'callrec',
        'on': on,
        if (_remoteId != null) 'to': _remoteId,
      });
      // [CALLREC-TELEM-1] The consent surface is the ONLY thing standing between
      // this feature and recording someone who does not know — and until now its
      // delivery was purely INFERRED. Nothing recorded that the frame was sent,
      // and nothing recorded that the peer received it, so "the other person saw
      // an indicator" was an assumption, not an observation.
      //
      // Both ends emit `callrec_peer_indicator`, tagged with each device's own
      // email. `dir=sent` here, `dir=received` in the receive switch. Matching
      // the two by `call_id` across the two testers' timelines is what turns the
      // consent claim into evidence — which is exactly the two-sided pull
      // CLAUDE.md's telemetry rule asks for.
      //
      // `addressed` distinguishes a directed frame (we know the peer id; the DO
      // forwards it verbatim) from a broadcast fallback (we do not yet, which is
      // normal on the SFU path where no peer `offer` is ever exchanged). A
      // missing `received` on the other side is a different bug in each case.
      Analytics.capture('callrec_peer_indicator', {
        'call_id': config.room,
        'rec_id': 'callrec:${config.room}',
        'dir': 'sent',
        'on': on,
        'forced': force,
        'addressed': _remoteId != null,
        'connected': _connected,
        // `seed` IS the peer uid on this config (there is no `peerUid` field) —
        // the same value `call_controls_toggled` reports as `peer_uid`.
        if (config.seed.isNotEmpty) 'peer_uid': config.seed,
      });
    } catch (_) {/* never let a consent frame disturb the call */}
  }

  /// Bind to the recording store. Bound to the notifiers rather than to
  /// `start`/`stop`, because native's degradation ladder can FINALIZE a
  /// recording with nobody calling stop (store invariant 3) — a hook on stop
  /// would leave the peer's indicator stuck on after capture had ended.
  void _attachRecordingBridge() {
    if (_recordingListener != null) return;
    void onChange() {
      _announceRecordingState();
      // [CALLHOLD-1] Closes the arm-while-held race: the user holds the call and
      // THEN taps Record (or a `start` that was already in flight completes), so
      // the recorder arms into a call that is already on hold and nothing would
      // otherwise have told it. `_recorderHeld` is already true in that case, so
      // [_syncRecorderHold] would short-circuit — re-assert directly. The store
      // ignores it unless this room is the active recording, and native's
      // `pause` is idempotent.
      if (_recorderHeld && _localRecordingActive) {
        try {
          // ignore: unawaited_futures
          CallRecordingStore.I.setHeld(config.room, true);
        } catch (_) {}
      }
    }

    _recordingListener = onChange;
    try {
      CallRecordingStore.I.phase.addListener(onChange);
      CallRecordingStore.I.activeCallId.addListener(onChange);
    } catch (_) {
      _recordingListener = null;
    }
  }

  void _detachRecordingBridge() {
    final l = _recordingListener;
    if (l == null) return;
    _recordingListener = null;
    try {
      CallRecordingStore.I.phase.removeListener(l);
      CallRecordingStore.I.activeCallId.removeListener(l);
    } catch (_) {/* already gone */}
  }

  // ── [CALLHOLD-1] User-initiated hold ────────────────────────────────────────
  //
  // ## WHY THIS IS NOT SDP RENEGOTIATION — READ BEFORE "UPGRADING" IT
  //
  // The textbook hold is `a=inactive` / `a=sendonly` in a re-offer. Do NOT do
  // that here. `[CALL-GLARE-OBS-1]` (see `case 'offer':` below) states plainly
  // that this app does NOT implement perfect negotiation: glare is prevented
  // STRUCTURALLY — the DO's newcomer-offers rule, the `_weOffered` guard on
  // every renegotiation, and a server-side pair-keyed glare DO — and a collision
  // is only DETECTED AND REPORTED, never recovered from. Hold is a control the
  // user can hit at any instant from EITHER side, so a hold-triggered re-offer
  // is a re-offer from an arbitrary side at an arbitrary time: precisely the
  // case those invariants do not cover. The failure mode is not "hold is
  // glitchy", it is `setRemoteDescription` throwing in the wrong signaling state
  // and the CALL hanging.
  //
  // So hold is: (a) disable outgoing audio tracks, (b) disable the incoming
  // audio tracks so nothing is rendered or played, (c) tell the peer with one
  // typed frame. The media session is never touched — no offer, no answer, no
  // ICE, no transceiver direction change. It survives ICE restarts and relay
  // migration for free, because there is nothing in the SDP to survive.
  //
  // The frame is modelled exactly on `callrec` ([CALLREC-PEER-1]): CallRoom
  // relays any frame carrying a `to` verbatim and BROADCASTS one without, so no
  // worker change is needed. `to` is omitted when `_remoteId` is still null —
  // on the SFU path no peer `offer` is ever exchanged, so the first joiner's
  // `_remoteId` can legitimately be null on a live call, and the broadcast
  // fallback is the only thing that reaches them. An unknown `hold` frame on an
  // older client falls through the receive switch, which has no `default:` — a
  // no-op, never an exception.
  //
  // ## USER HOLD AND AUTOMATIC HOLD ARE INDEPENDENT STATE. ON PURPOSE.
  //
  // `_onCellularHold` (a GSM call arrived) and `_onFocusHold` (another app took
  // audio focus) are pseudo-holds owned by OS callbacks, each with its own
  // resume signal, and they express themselves by driving `_muted`. If user hold
  // shared any of that, an audio-focus REGAIN arriving while the user is holding
  // would run `_muted = false` and un-hold a call the user deliberately held —
  // and, worse, `_releaseStuckFocusHold`'s watchdog would do the same six
  // seconds after a focus blip. Two authorities, two independent latches. They
  // meet in exactly two places, both of which take the union rather than
  // letting either clobber the other: [_applyLocalAudioEnabled] (the mic is off
  // if ANY of mute / user hold says so) and [_syncRecorderHold] (the recorder is
  // paused if ANY hold says so, and resumes only when they all clear).
  //
  // `onCellularHold` (the notifier) therefore keeps its exact current meaning —
  // automatic hold only. [holdActive] is the user's.
  //
  // ## THE RELEASE PROPERTY
  //
  // `[CALL-FOCUS-DEADLOCK-1]` cost a whole call's microphone because a hold
  // latched with no way out: "a hold that can never be released is worse than no
  // hold at all". This hold cannot latch:
  //  - [toggleHold] awaits nothing that can hang before it flips the latch and
  //    updates the notifier, so the next tap always reverses it;
  //  - the media work is best-effort inside try/catch — a failure there cannot
  //    leave the latch disagreeing with the UI;
  //  - `_send` already swallows a dead socket, so a hold taken while
  //    disconnected still releases locally, and the re-announce on
  //    welcome/peer-joined/peer-rejoined repairs the PEER's copy after any
  //    reconnect;
  //  - it is local-only state: nothing the peer, the DO or the OS sends can set
  //    it, so there is no remote party that can hold us hostage.
  // Deliberately NOT time-capped: unlike a focus hold, this one is a thing a
  // human chose, and auto-releasing it would put a user back on a live mic they
  // believed was off.

  /// Tell the peer whether WE are holding.
  ///
  /// [force] re-sends even when nothing changed — used on connect/rejoin. A
  /// missed frame here leaves the peer sitting in silence with no explanation,
  /// which is the whole failure this indicator exists to prevent.
  void _announceHoldState({bool force = false}) {
    try {
      if (_ended) return;
      final on = _userHold;
      // [force] also means "something about the transport just changed", which
      // is precisely when the media state can have been rebuilt underneath us:
      // an ICE restart, the relay-migration cutover and a fresh `_newPC()` all
      // produce NEW receivers, and a new receiver's track arrives enabled. Left
      // alone, a hold taken before a reconnect would quietly start playing the
      // peer again while the UI still said "on hold". Re-assert, don't assume.
      if (force && on) {
        _applyLocalAudioEnabled();
        // ignore: unawaited_futures
        _applyRemoteAudioEnabled(false);
      }
      if (!force && on == _lastHoldAnnounced) return;
      _lastHoldAnnounced = on;
      _send(<String, dynamic>{
        'type': 'hold',
        'on': on,
        if (_remoteId != null) 'to': _remoteId,
      });
    } catch (_) {/* never let a hold frame disturb the call */}
  }

  /// The ONE place outgoing mic tracks are enabled/disabled, so mute and hold
  /// can never overwrite each other. Off if EITHER says off.
  void _applyLocalAudioEnabled() {
    final on = !_muted && !_userHold && !_onFocusHold && !_onCellularHold;
    try {
      _stream?.getAudioTracks().forEach((t) => t.enabled = on);
    } catch (_) {/* stream torn down mid-toggle */}
    final streamRtc = _streamRtc;
    if (_streamRtcActive && streamRtc != null) {
      unawaited(() async {
        try {
          await streamRtc.publishMic(enabled: on);
        } catch (e) {
          Analytics.capture('stream_call_mic_apply_failed', {
            'call_id': config.room,
            'enabled': on,
            'error_class': e.runtimeType.toString(),
          });
        }
      }());
    }
  }

  /// Stop (or restore) rendering and playing the peer's audio.
  ///
  /// Done on the RECEIVERS rather than on `remoteRenderer.srcObject`, because
  /// the renderer is repointed at several places (P2P `onTrack`, the SFU
  /// transport, the relay-migration cutover) and a receiver-level disable holds
  /// across all of them. Awaited but never fatal: hold is already correct
  /// locally before this runs.
  Future<void> _applyRemoteAudioEnabled(bool on) async {
    final streamRtc = _streamRtc;
    if (_streamRtcActive && streamRtc is StreamCallSession) {
      try {
        await streamRtc.setSpeaker(enabled: on);
      } catch (e) {
        Analytics.capture('stream_call_speaker_apply_failed', {
          'call_id': config.room,
          'enabled': on,
          'error_class': e.runtimeType.toString(),
        });
      }
    }
    try {
      final receivers = await _pc?.getReceivers();
      for (final r in receivers ?? const <RTCRtpReceiver>[]) {
        final t = r.track;
        if (t != null && t.kind == 'audio') t.enabled = on;
      }
    } catch (_) {/* pc closed / plugin refused — hold is still local-correct */}
    try {
      final s = remoteRenderer.srcObject;
      s?.getAudioTracks().forEach((t) => t.enabled = on);
    } catch (_) {/* renderer disposed */}
  }

  /// Drive the recorder from the HOLD, not from the UI — so it follows whichever
  /// way the call got held, including a tap on a screen this session has never
  /// seen.
  ///
  /// **Automatic holds pause the recorder too, and that is the deliberate
  /// choice.** The argument against is that a GSM interruption is not something
  /// the user asked to cut out of their recording. The argument for wins on
  /// evidence: during either automatic hold our own capture is gone (the whole
  /// reason `[CALL-FOCUS-1]` holds the call is that "our capture goes nowhere —
  /// the peer heard silence"), so the near leg delivers nothing while the far
  /// leg keeps running clock-driven. That is exactly the one-sided shape
  /// `[CALLREC-NATIVE-3]`'s ladder escalates: 30 s of it and `near_leg_stalled`
  /// CLOSES the recording and adds the call to `disabledCalls`, so the user
  /// loses recording for the remainder of a call they never stopped recording.
  /// Pausing turns "silently lose the rest of the recording" into "a clean
  /// splice around the interruption". A one-minute GSM call costs a gap either
  /// way; only one of the two options also costs the next twenty minutes.
  void _syncRecorderHold() {
    final held = _userHold || _onCellularHold || _onFocusHold;
    if (held == _recorderHeld) return;
    _recorderHeld = held;
    try {
      // ignore: unawaited_futures
      CallRecordingStore.I.setHeld(config.room, held);
    } catch (_) {/* the recorder must never be able to break a hold */}
  }

  /// Put this call on hold, or take it off hold. THE public entry point.
  ///
  /// Ordering is the safety argument: latch and notifier first (so the control
  /// is always reversible and the UI never disagrees with reality), then the
  /// peer frame, then the media, then the recorder.
  Future<void> toggleHold() async {
    if (_ended) return;
    final next = !_userHold;
    _userHold = next;
    holdActive.value = next;

    // Outgoing mic: restores to the user's ACTUAL mute state on resume, never
    // unconditionally unmuted — un-muting someone who deliberately muted before
    // holding is the one unrecoverable mistake this control can make.
    _applyLocalAudioEnabled();

    _announceHoldState();
    _syncRecorderHold();
    _bump();

    Analytics.capture('call_hold_toggled', {
      'call_id': config.room,
      'on': next,
      'muted': _muted,
      'auto_hold': _onCellularHold || _onFocusHold,
      'elapsed_s': _secs,
      'recording': _localRecordingActive,
    });
    AvaLog.I.log('call', 'user hold ${next ? 'ON' : 'OFF'} (muted=$_muted)');

    // Incoming audio last: it is the only awaited step, and nothing above
    // depends on it.
    await _applyRemoteAudioEnabled(!next);
  }

  /// [CF-CALL-P2P-1] Bounded 1:1-video sender encoding (proposal Phase 5:
  /// "sender bitrate limits" + "use balanced degradation"). Two behavior
  /// changes from the pre-existing version, both UNGATED (deterministic
  /// quality fixes, no legacy-equivalence requirement per the proposal):
  ///  - `degradationPreference` MAINTAIN_RESOLUTION → BALANCED. The old
  ///    setting told the encoder to protect resolution at any framerate cost,
  ///    which on a thin link meant near-frozen high-res video instead of
  ///    smooth lower-res video. THIS IS THE ONE-LINE, EASILY REVERTABLE
  ///    CHANGE called out in the CF-CALL-P2P-1 report — revert by restoring
  ///    `RTCDegradationPreference.MAINTAIN_RESOLUTION` below.
  ///  - a `maxBitrate` cap per encoding: 850 kbps on wifi/unknown, 450 kbps on
  ///    a detected cellular network — previously unbounded, so a strong link
  ///    could push an outbound bitrate the callee's link (or ours, on the way
  ///    back down after a network change) couldn't sustain.
  Future<void> _preferResolutionOnVideo(RTCPeerConnection pc,
      {bool cellular = false}) async {
    try {
      final senders = await pc.getSenders();
      // [CALL-MEDIA-540P-1] Shared with the degrade ladder's level-0 rung so a
      // recovery cannot restore a different (higher) ceiling than the one the
      // healthy path applies. See [audio_tuning.avaVideoMaxBitrateBps].
      final maxBitrateBps =
          audio_tuning.avaVideoMaxBitrateBps(cellular: cellular);
      for (final s in senders) {
        if (s.track?.kind != 'video') continue;
        final params = s.parameters;
        params.degradationPreference = RTCDegradationPreference.BALANCED;
        final encodings = params.encodings;
        // [CALL-VIDEO-CODEC-1] Temporal SVC. `L1T3` = one spatial layer, three
        // TEMPORAL layers: the encoder emits a frame hierarchy where the top
        // layers can be dropped without breaking decode of the ones beneath.
        // Under congestion the picture drops to a lower framerate instead of
        // FREEZING until the next keyframe, which is the visible difference
        // between "degrades gracefully" and "hangs then jumps".
        //
        // L1T3 not L3T3 deliberately: spatial layers cost encode CPU and only
        // pay off when a server can forward different layers to different
        // subscribers. In 1:1 P2P there is exactly one receiver, so spatial SVC
        // is pure overhead. (The group SFU path could use L3T3 — it doesn't set
        // any encoding parameters at all today, which is a separate gap.)
        final svc = RemoteConfig.callVideoCodecPrefV1 ? 'L1T3' : null;
        if (encodings == null || encodings.isEmpty) {
          params.encodings = [
            RTCRtpEncoding(
                active: true, maxBitrate: maxBitrateBps, scalabilityMode: svc),
          ];
        } else {
          for (final e in encodings) {
            e.maxBitrate = maxBitrateBps;
            if (svc != null) e.scalabilityMode = svc;
          }
        }
        await s.setParameters(params);
      }
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'video_sender_parameters_failed',
        error: e,
        stack: st,
        extra: {'operation': 'bounded_encoding', 'cellular': cellular},
      );
    }
  }

  /// [CALL-VIDEO-CODEC-1 2026-08-05] Express a video codec preference.
  ///
  /// Previously the app made no codec choice at all — no `setCodecPreferences`
  /// anywhere — so the negotiated video codec was whatever order libwebrtc's
  /// `createOffer` happened to emit, which in practice puts VP8 first on most
  /// Android builds. VP8 is the weakest option here on exactly the links that
  /// matter: at 200-400 kbps AV1 and VP9 hold a usable picture where VP8
  /// smears, and VP8 has no SVC support worth the name, so the temporal-layer
  /// work above is inert unless a codec that implements it is negotiated.
  ///
  /// Order: AV1 > VP9 > VP8 > H264. H264 is ranked LAST rather than dropped —
  /// on some devices it is the only hardware-accelerated encoder, and removing
  /// it would force software encoding (battery, thermals) or fail negotiation
  /// outright against a peer that offers nothing else.
  ///
  /// Best-effort and non-fatal by construction: anything unexpected leaves the
  /// transceiver untouched and the call proceeds on libwebrtc's default order.
  Future<void> _applyVideoCodecPreference(RTCPeerConnection pc) async {
    // [CALL-MEDIA-540P-1] The `!config.video` half of this guard was dropped.
    // `config.video` is what the call STARTED as, so an audio call that later
    // turns the camera on skipped codec preference entirely and fell back to
    // libwebrtc's VP8-first order — on the upgrade path, where the link is
    // least likely to carry it. The transceiver loop below already filters to
    // video, so with no video transceivers this is a no-op regardless.
    if (!RemoteConfig.callVideoCodecPrefV1) return;
    try {
      final caps = await getRtpSenderCapabilities('video');
      final codecs = caps.codecs;
      if (codecs == null || codecs.isEmpty) return;
      int rank(String mime) {
        final m = mime.toLowerCase();
        if (m.endsWith('av1')) return 0;
        if (m.endsWith('vp9')) return 1;
        if (m.endsWith('vp8')) return 2;
        if (m.endsWith('h264')) return 3;
        return 4; // rtx / red / ulpfec / unknown — keep after the real codecs
      }

      final sorted = [...codecs]
        ..sort((a, b) => rank(a.mimeType).compareTo(rank(b.mimeType)));
      final transceivers = await pc.getTransceivers();
      var applied = 0;
      for (final t in transceivers) {
        if (t.sender.track?.kind != 'video' &&
            t.receiver.track?.kind != 'video') continue;
        await t.setCodecPreferences(sorted);
        applied++;
      }
      Analytics.capture('call_video_codec_preference', {
        'call_id': config.room,
        'transceivers': applied,
        'order': sorted.take(4).map((c) => c.mimeType).join(','),
        'svc': 'L1T3',
      });
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'video_codec_preference_failed',
        error: e,
        stack: st,
        extra: const {'operation': 'set_codec_preferences'},
      );
    }
  }

  /// [CF-CALL-P2P-1] Await every `addTrack` call and report a failure through
  /// call telemetry instead of the pre-existing fire-and-forget `forEach`,
  /// where a rejected `addTrack` Future was silently dropped — no signal
  /// anywhere that a sender never got installed.
  Future<void> _addStreamTracks(
    RTCPeerConnection pc,
    MediaStream stream, {
    required String stage,
  }) async {
    // [CALL-PREWARM-TRUTH-2 2026-08-21] A stream with no audio track makes this
    // loop a no-op: nothing throws, `stage` never fires, and the peer connection
    // is built with no audio sender. That silence is how the answerer bug hid —
    // the ONE observable difference between a working call and a call that will
    // be inaudible for its entire life was a for-loop that ran zero times.
    // Adding a track later is not possible on this path (there is no
    // renegotiation for audio here), so this is terminal and must be loud.
    if (!config.video && stream.getAudioTracks().isEmpty) {
      Analytics.capture('call_pc_built_without_audio', {
        'call_id': config.room,
        'role': _performanceRole,
        'stage': stage,
        'prewarm_audio_pending': _prewarmAudioPending,
        'total_tracks': stream.getTracks().length,
      });
    }
    for (final t in stream.getTracks()) {
      try {
        await pc.addTrack(t, stream);
      } catch (e, st) {
        _telemetry.runtimeError(
          stage: stage,
          error: e,
          stack: st,
          extra: {'track_kind': t.kind ?? 'unknown'},
        );
      }
    }
  }

  static String _candTypeOf(String? cand) {
    if (cand == null) return '';
    final m = RegExp(r'typ (\w+)').firstMatch(cand);
    return m?.group(1) ?? '';
  }

  /// [CALL-PCRETIRE-1 2026-08-06] Close a peer connection we are DELIBERATELY
  /// replacing or abandoning, without letting its own teardown end the call.
  ///
  /// ## The bug this exists to prevent
  ///
  /// Every PC built by [_newPC] installs an `onConnectionState` handler whose
  /// `Closed` rung calls `_endWith('ended')`. That rung is a legitimate backstop
  /// for a connection that dies under us — but it cannot tell "the transport
  /// collapsed" from "we closed this ourselves a moment ago because we are
  /// mid-rescue". Its only guard was `if (_ended || !_connected) return;`, and
  /// `_connected` is never cleared during a reconnect, so on the SFU recovery
  /// path [_reconnectSfu]'s own `oldPc.close()` re-entered `_endWith('ended')`
  /// and hung up the live call it was trying to save.
  ///
  /// Prod, 2026-08-06 (avatok-597ba662, hdavy2002 ↔ s.rgoavilla): the interface
  /// flipped, `call_network_handover` fired at 11:51:59.478, and `call_ended`
  /// with reason `ended` followed **133 ms later** — the innocuous
  /// normal-hangup reason string, which is why this read as a clean hangup in
  /// every dashboard. The peer sat in silence for 8.5 s before its own
  /// `call_media_stalled`.
  ///
  /// ## Why detaching first is the whole fix
  ///
  /// The `Closed` rung now guards on `identical(pc, _pc)` — "am I still the
  /// session's current connection?". Clearing `_pc` BEFORE closing is therefore
  /// load-bearing: close-then-detach inverts the ordering and the guard passes
  /// on the way out, which is exactly the bug. Any future teardown site must
  /// go through here rather than calling `close()` directly.
  ///
  /// Deliberately not generation-based: [_pcGeneration] is bumped by
  /// [_promoteMigratedPc] BEFORE the outgoing PC is closed, so a generation
  /// bump here would invalidate the freshly-promoted connection instead of the
  /// retired one. Identity is correct on every path; generation is not.
  Future<void> _retirePc(RTCPeerConnection? old) async {
    if (old == null) return;
    if (identical(_pc, old)) _pc = null;
    try {
      await old.close();
    } catch (_) {/* already gone — retiring it is still the right outcome */}
  }

  Future<RTCPeerConnection> _newPC({
    bool forceRelay = false,
    List<Map<String, dynamic>>? sfuIce,

    /// [CALL-PREJOIN-ISOLATE-1 2026-08-17] Build a peer connection that does
    /// NOT speak for the session until it is deliberately promoted.
    ///
    /// Default `false` keeps every existing caller byte-for-byte identical —
    /// nothing else passes this. `true` is used ONLY by the caller's ring-time
    /// SFU pre-join ([_maybeStartCallerPrejoin]).
    ///
    /// WHY THIS EXISTS. `_newPC` assigns [_pc] and installs `onTrack` as its
    /// last acts, so the pre-join's connection became the session's live
    /// connection the INSTANT it was built — at ring start, before anybody had
    /// accepted anything. When the SFU delivered a track on it, `onTrack` ran
    /// the whole connect ladder: ringback stopped, `_connected = true`, phase
    /// `connected`. Production call avatok-a0170dc6 (2026-08-17): the CALLER's
    /// screen said "connected" at 13.802 while the callee did not accept until
    /// 21.070 and real audio only arrived at ~27 — connected-looking silence
    /// for 13 seconds, worse than having no pre-join at all.
    ///
    /// Isolated therefore means exactly three suppressions, each undone at
    /// promotion in [_startSfuMedia]:
    ///   1. `_pc` is NOT assigned. This alone also neutralises
    ///      `onConnectionState`, whose body already returns unless
    ///      `identical(pc, _pc)` — so transport transitions on a pre-join can
    ///      neither end nor "connect" the call.
    ///   2. `onTrack` caches into [_prejoinEarlyTracks] and returns, instead of
    ///      touching the renderer, ringback, phase, watchdogs or notifiers.
    ///   3. The playout-health baselines are not reset — they belong to the
    ///      live call and are reset at promotion instead.
    /// Media behaviour is otherwise IDENTICAL: same ICE config, same jitter
    /// bounds, same codec/track setup, same generation stamp.
    bool isolated = false,
  }) async {
    if (RemoteConfig.callCellPresetV1) {
      _localCellular = await _isLikelyCellular();
      _announceNetClass();
    }
    final cellPair =
        RemoteConfig.callCellPresetV1 && _localCellular && _peerCellular;
    final pc = await createPeerConnection({
      'iceServers': sfuIce ?? _ice,
      'iceCandidatePoolSize': 2,
      // Cloudflare Realtime is the SFU. Do not force relay-only against its
      // ICE list: normal ICE may use Cloudflare STUN/TURN as appropriate.
      if (sfuIce == null && (CallDiag.turnOnly || forceRelay || cellPair))
        'iceTransportPolicy': 'relay',
      // [CALL-SURVIVE-1 2026-08-04] Bound the NetEq jitter buffer. Prod calls
      // showed inbound jitter-buffer delay sitting at 600-745ms on flappy
      // cellular ("distant/underwater" voice) because the buffer had no cap
      // and no fast-drain. 50 packets ≈ 1s hard ceiling; fastAccelerate
      // drains accumulated delay quickly once the network recovers. Both keys
      // verified as parsed by flutter_webrtc 0.12.12 Android
      // (MethodCallHandlerImpl.parseRTCConfiguration) — NOT decoys.
      'audioJitterBufferMaxPackets': 50,
      'audioJitterBufferFastAccelerate': true,
    });
    // [CF-CALL-P2P-1] Stamp this PC's generation BEFORE installing any
    // callback closure below, so every closure's guard check is meaningful
    // from the moment it can first fire.
    final myPcGen = ++_pcGeneration;
    if (sfuIce == null) {
      await _addStreamTracks(pc, _stream!, stage: 'add_track_failed');
    }
    if (config.video && sfuIce == null) {
      // [CALL-VIDEO-CODEC-1] Codec preference must be applied BEFORE the offer
      // is created — setCodecPreferences changes the m-line payload order, and
      // an offer already generated cannot be retro-fitted.
      await _applyVideoCodecPreference(pc);
      await _preferResolutionOnVideo(pc, cellular: await _isLikelyCellular());
    }
    _telemetry.onIceGatheringStart();
    pc.onIceCandidate = (c) {
      _telemetry.onLocalCandidate(_candTypeOf(c.candidate));
      if (sfuIce == null && _remoteId != null) {
        _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
      }
    };
    pc.onIceGatheringState = (s) {
      if (s == RTCIceGatheringState.RTCIceGatheringStateComplete) {
        _telemetry.onIceGatheringDone();
      }
    };
    pc.onTrack = (e) async {
      // [CALL-PREJOIN-ISOLATE-1 2026-08-17] An un-promoted pre-join may not
      // speak for the session — cache and return. Checked FIRST, before every
      // other guard, because this connection legitimately receives tracks
      // while the callee is still ringing and none of them mean "connected".
      // Promotion replays these through this same handler.
      if (isolated && !_prejoinPromoted) {
        _prejoinEarlyTracks.add(e);
        return;
      }
      _handleRemoteTrack(pc, myPcGen, e);
    };
    pc.onConnectionState = (s) => _handleConnectionState(pc, s);
    // [CALL-PREJOIN-ISOLATE-1] Both of these make `pc` the session's live
    // connection; a pre-join is not live until [_startSfuMedia] promotes it.
    if (!isolated) {
      _resetPlayoutHealthBaselines();
      _pc = pc;
    }
    if (cellPair) unawaited(_applyAudioBitrate(40000));
    return pc;
  }

  /// [CALL-PREROLL-1 2026-08-17] Extracted verbatim from `_newPC`'s
  /// `onTrack` closure (same body, same guards) so it can also be invoked
  /// once per already-received track when a fully pre-rolled CALLEE
  /// connection (`CallPrewarm`'s `callPrerollV1` extension) is promoted in
  /// `_startSfuMedia` — that connection was built with no session handlers
  /// at all while un-promoted, so nothing else will ever call this for the
  /// audio it already pulled during the ring; it must be driven manually,
  /// exactly once, at adoption.
  void _handleRemoteTrack(RTCPeerConnection pc, int myPcGen, RTCTrackEvent e) {
    // [CF-CALL-P2P-1] A superseded PC (e.g. a second `_newPC()` from a
    // relay-fallback or a racing offer/answer) can still have a pending
    // `onTrack` in flight; never let it clobber the renderer out from under
    // the CURRENT PC's own stream.
    if (myPcGen != _pcGeneration) return;
    // [CALL-PCRETIRE-1 2026-08-06] A call that is OVER must not come back to
    // life. Without this, a track event still in flight when the call ended
    // ran the whole connect ladder — `call_connected`, `_connected = true`,
    // phase `connected`, the media watchdog and the playout sampler all
    // restarted on a dead session. Prod 2026-08-06 (avatok-8ed2b95f):
    // `call_connected` landed 333 ms AFTER this client's own `call_ended`.
    // Any funnel keyed on `call_connected` counts that as a success.
    if (_ended) return;
    if (e.streams.isNotEmpty) {
      remoteRenderer.srcObject = e.streams[0];
      if (e.track.kind == 'video') {
        remoteVideoActive.value = true;
        remoteVideoStatus.value = 'active';
        // [CALL-VIDEO-FIX-1 2026-08-17] Truthful "the peer's video track
        // object arrived" signal — fires on EVERY video attach (initial
        // connect AND a later mid-call camera-on / repull), unlike
        // `call_first_remote_video_track` below which is guarded to once
        // per call. `remote_video_first_frame` (renderer callback wired in
        // `_bootMedia`) reports the gap from this timestamp to actual
        // decoded pixels.
        _remoteVideoAttachedAtMs = DateTime.now().millisecondsSinceEpoch;
        Analytics.capture(
            'remote_video_track_attached', {'call_id': config.room});
        if (!_firstRemoteVideoTrackReported) {
          _firstRemoteVideoTrackReported = true;
          Analytics.capture('call_first_remote_video_track', {
            'call_id': config.room,
            'path': _sfuActive || _sfuStarting
                ? 'sfu'
                : (_relayForced ? 'relay' : 'direct'),
          });
        }
      }
      _ringTimeout?.cancel();
      // [CALL-CONNECT-WATCHDOG-1] Media is flowing — disarm the backstop. This
      // runs BEFORE `_telemetry.connected()` sets `_connected`, hence cancel
      // rather than relying on the timer's own `_connected` guard.
      _connectWatchdog?.cancel();
      _connectWatchdogFast?.cancel(); // [AVACALL-WATCHDOG-2]
      _failTimer?.cancel();
      _relayFallbackTimer?.cancel();
      _ringback.stop();
      // [AVA-PREWARM-1] The callee answered for real — a pre-warmed
      // receptionist session (if any) was never heard and must never
      // surface (no message, no recording, no summary).
      if (_prewarmCall != null) {
        // ignore: unawaited_futures
        _abortPrewarm('callee_answered');
      }
      _telemetry.connected(pc);
      _telemetry.setMediaPath(
        _sfuActive || _sfuStarting
            ? 'sfu'
            : (_relayForced ? 'relay' : 'direct'),
      ); // [CALL-REL-4/5]
      // [CALL-AUDIBLE-1] Haptic moved to `_markAudibleReady` — see that
      // method's doc comment. Everything else in this block (ringback stop,
      // talk-time start, timers, watchdogs, receptionist abort, glare clear,
      // phase) is untouched.
      if (gOutgoingCallId == config.room) {
        gOutgoingCallTo = null;
        gOutgoingCallId = null;
        gOutgoingSince = 0;
      }
      _connected = true;
      // [CALL-LOG-TIME-1] Talk time starts at FIRST REMOTE MEDIA, not at dial:
      // the ringing seconds are not part of the call's duration. Set once —
      // this branch is already guarded so it only runs on the first track.
      if (_connectedAtMs == 0)
        _connectedAtMs = DateTime.now().millisecondsSinceEpoch;
      peerAway.value = false;
      _setPhase('connected');
      // [CALL-MEDIA-WATCH-1] arm the media-flow watchdog now that we're live.
      _startMediaWatchdog();
      // [CALL-REL-4] independent, flag-gated, observe-only playout sampler.
      _startPlayoutHealthSampler();
      // [CALL-DEADAIR-1] A remote TRACK is not remote AUDIO. Start measuring
      // the gap between the two right here, because this is the instant the
      // user is told the call is live.
      _stage('first_remote_track');
      _startFirstAudioProbe();
      _armAudibleGate(); // [CALL-AUDIBLE-1]
    }
  }

  /// [CALL-PREROLL-1 2026-08-17] Extracted verbatim from `_newPC`'s
  /// `onConnectionState` closure — see [_handleRemoteTrack]'s doc comment for
  /// why. `pc` is passed explicitly (rather than closing over `_pc`) so the
  /// SAME guard logic works whether this is the live `_newPC`-built
  /// connection or a preroll connection being promoted.
  void _handleConnectionState(RTCPeerConnection pc, RTCPeerConnectionState s) {
    // [CALL-OBS-1 2026-08-03] THE MISSING RUNG, emitted BEFORE the guard below.
    //
    // `call_connected` fires from `onTrack` — first remote media — and it has
    // not fired once in production since 2026-07-24. That event is not broken;
    // it is telling the truth, which is that media never establishes. The
    // problem was that nothing reported anything BETWEEN the accept and that
    // silence, so "the callee accepted and the call was killed" and "the
    // callee accepted and ICE never completed" produced identical telemetry:
    // none.
    //
    // The handler that should have covered the gap could not: it returns early
    // unless `_connected`, and `_connected` is only set in `onTrack` — after
    // the very thing we are trying to observe. Every transport transition
    // before first media was therefore dropped on the floor.
    //
    // This fires once, on the first transport connect, whatever the call state.
    // With it the funnel accept → transport → media is finally separable: no
    // transport event means signalling or ICE; transport but no
    // `call_connected` means media or tracks.
    // [CALL-PCRETIRE-1 2026-08-06] A RETIRED connection may not speak for the
    // session. See [_retirePc]: `_pc` is cleared before a deliberate close, so
    // `identical` is false for exactly the connections we replaced ourselves —
    // an SFU reconnect's old PC, a relay-migration cutover's outgoing PC, a
    // superseded relay-fallback PC. Without this, their `Closed` callback ends
    // the live call.
    //
    // `_ended` is checked HERE rather than below because a call that is over
    // must stop emitting transport telemetry: prod 2026-08-06 shows
    // `call_transport_connected` landing 1.16 s AFTER this client's own
    // `call_ended` (avatok-701e404b) and `call_connected` 333 ms after it
    // (avatok-8ed2b95f), which corrupts any funnel built on those events. The
    // `!_connected` half stays below, deliberately: per [CALL-OBS-1] the
    // transport rung must still fire BEFORE first media, and gating it on
    // `_connected` is what blinded the accept → transport → media funnel.
    if (_ended || !identical(pc, _pc)) return;
    _noteTransportConnected(s);
    if (!_connected) return;
    _telemetry.mediaFlowState(
      state: 'transport_${s.toString().split('.').last.toLowerCase()}',
      transportState: s.toString(),
    );
    if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
      // [CALL-PCRETIRE-1 2026-08-06] The identity guard above cannot see this
      // one. `CallSfuTransport.connect()` closes its OWN `_pc` on failure
      // (`_closePc()`), and that is the same object the session already
      // adopted as `_pc` — because the transport builds it through `_newPC`,
      // which assigns `_pc` as a side effect. So `identical` is true and the
      // guard passes, while the call is merely mid-rejoin. Ending here would
      // reintroduce the exact regression this change exists to remove, one
      // layer further down. The reconnect ladder owns the outcome instead.
      if (_sfuStarting || _sfuReconnectInFlight) {
        _telemetry.mediaFlowState(
          state: 'transport_closed_during_sfu_setup',
          transportState: s.toString(),
        );
        return;
      }
      _telemetry.runtimeError(
        stage: 'pc_closed',
        error: StateError('Peer connection closed during an active call'),
        extra: {'transport_state': s.toString()},
      );
      _endWith('ended');
    } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
        s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
      if (_sfuActive || _sfuStarting) {
        _telemetry.runtimeError(
          stage: 'sfu_pc_disconnected',
          error: StateError('Cloudflare Realtime peer connection disconnected'),
        );
        unawaited(_reconnectSfu());
        return;
      }
      final isFailed = s == RTCPeerConnectionState.RTCPeerConnectionStateFailed;
      if (RemoteConfig.callIceRecoveryV2) {
        // [CALL-REL-5 / REL-3 fix] Either endpoint may now request recovery
        // — no longer gated on `_weOffered`. The coordinator's own 30s
        // deadline (from recovery START, not this handler) owns
        // termination; the legacy 10s hard-end `_failTimer` below is not
        // armed on this path.
        // ignore: unawaited_futures
        _requestRecovery(RecoveryReason.transportDisconnected);
        return;
      }
      final canRestart = _weOffered && _iceRestarts < 3 && _remoteId != null;
      if (isFailed && !canRestart) {
        _telemetry.runtimeError(
          stage: 'pc_failed_no_restart',
          error: StateError(
              'Peer connection failed and no ICE restart was available'),
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
        if (!_ended &&
            _connected &&
            st != RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
          _telemetry.runtimeError(
            stage: 'pc_reconnect_timeout',
            error:
                StateError('Peer connection did not recover within 10 seconds'),
            extra: {
              'transport_state': st.toString(),
              'restart_attempted': true,
            },
          );
          _endWith('ended',
              reason: isFailed ? 'rtc-failed' : 'rtc-disconnected');
        }
      });
    } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
      _failTimer?.cancel();
    }
  }

  /// [CALL-PREROLL-1 2026-08-17] Promote a fully pre-rolled CALLEE connection
  /// (`CallPrewarm`'s `callPrerollV1` extension — mic acquired, isolated PC
  /// built, published and pulled, all during the ring) to be the session's
  /// live connection. Mirrors [_promotePrejoinPc] below for the CALLER's
  /// ring-time pre-join, but this PC was built entirely OUTSIDE any
  /// `CallSession` — by `CallPrewarm`, before this session even existed, from
  /// a push handler with no session to hand handlers to — so unlike the
  /// pre-join it never got `_newPC`'s `onTrack`/`onConnectionState` or a
  /// generation stamp. Both are installed here, for the first time, right
  /// before each cached remote-track event (already muted by `CallPrewarm`
  /// the instant it arrived, so nothing was audible during the ring) is
  /// unmuted and replayed through [_handleRemoteTrack] — the same connect
  /// ladder a live `onTrack` would have driven, just run manually because no
  /// `onTrack` ever fired on this connection to drive it. Called at most once
  /// per call, from `_startSfuMedia`'s `hasFullPreroll` branch.
  void _promotePrerollPc(
      RTCPeerConnection pc, List<RTCTrackEvent> earlyTracks) {
    final myPcGen = ++_pcGeneration;
    _resetPlayoutHealthBaselines();
    _pc = pc;
    pc.onIceCandidate = (c) {
      _telemetry.onLocalCandidate(_candTypeOf(c.candidate));
    };
    pc.onTrack = (e) async => _handleRemoteTrack(pc, myPcGen, e);
    pc.onConnectionState = (s) => _handleConnectionState(pc, s);
    Analytics.capture('call_preroll_adopted', {
      'call_id': config.room,
      'early_track_count': earlyTracks.length,
    });
    for (final e in earlyTracks) {
      // [CALL-PREROLL-1] Re-enable the remote track now, at the moment this
      // call is genuinely being answered — CRITICAL: without this the track
      // stays muted forever and the callee never hears the caller, since no
      // future `onTrack` will fire to do it for us.
      try {
        e.track.enabled = true;
      } catch (_) {/* one bad track must not abort the adoption */}
      try {
        _handleRemoteTrack(pc, myPcGen, e);
      } catch (_) {/* one bad replay must not abort the adoption */}
    }
  }

  /// [CALL-PREJOIN-ISOLATE-1 2026-08-17] Make the caller's ring-time pre-join
  /// connection the session's LIVE connection, at the moment the call is
  /// genuinely being answered ([_startSfuMedia]'s adoption branch).
  ///
  /// This is the exact inverse of the three suppressions documented on
  /// [_newPC]'s `isolated` parameter, in the same order, plus the replay of
  /// any track that arrived while the callee was still ringing. Idempotent.
  void _promotePrejoinPc() {
    final pc = _prejoinPc;
    if (pc == null || _prejoinPromoted) return;
    _prejoinPromoted = true;
    _resetPlayoutHealthBaselines();
    _pc = pc;
    final early = List<RTCTrackEvent>.of(_prejoinEarlyTracks);
    _prejoinEarlyTracks.clear();
    Analytics.capture('call_prejoin_promoted', {
      'call_id': config.room,
      'had_early_track': early.isNotEmpty,
      'early_track_count': early.length,
    });
    // Replayed AFTER `_prejoinPromoted` is true and `_pc` is assigned, so the
    // handler takes its normal path and the connect ladder runs exactly once,
    // now that it is legitimate.
    final handler = pc.onTrack;
    if (handler != null) {
      for (final e in early) {
        try {
          handler(e);
        } catch (_) {/* one bad replay must not abort the adoption */}
      }
    }
  }

  /// [CALL-ICE-CFG-1 2026-08-05] Push freshly-minted TURN credentials onto the
  /// LIVE PeerConnection before an ICE restart.
  ///
  /// Both restart paths already did `_ice = await IceCache.get()` — and then
  /// issued `createOffer({iceRestart: true})` on the EXISTING pc. The refreshed
  /// credentials only ever reached a connection built afterwards, so on the
  /// restart path they were fetched, stored, and ignored: the restart re-used
  /// whatever `iceServers` the pc was constructed with. Cloudflare mints TURN
  /// credentials with a 24h TTL and [IceCache] holds them for 2 minutes, so on
  /// a short call this is harmless — but a long call, or one that spans a
  /// credential rollover, restarts ICE with dead TURN creds and every relay
  /// candidate fails authentication. That is precisely the "restart silently
  /// fails" failure mode, and it is invisible: ICE just never nominates.
  ///
  /// `setConfiguration` is additive here — we re-assert the SAME transport
  /// policy and jitter-buffer bounds the pc was built with, changing only the
  /// credentials. Best-effort by design: a platform that rejects the call is no
  /// worse off than before this existed, so we log and continue to the restart.
  Future<void> _pushRefreshedIceToPc(RTCPeerConnection pc, String why) async {
    try {
      final cellPair =
          RemoteConfig.callCellPresetV1 && _localCellular && _peerCellular;
      await pc.setConfiguration({
        'iceServers': _ice,
        'iceCandidatePoolSize': 2,
        if (CallDiag.turnOnly || _relayForced || cellPair)
          'iceTransportPolicy': 'relay',
        'audioJitterBufferMaxPackets': 50,
        'audioJitterBufferFastAccelerate': true,
      });
      Analytics.capture('call_ice_config_refreshed', {
        'call_id': config.room,
        'why': why,
        'server_count': _ice.length,
        'ok': true,
      });
    } catch (e) {
      Analytics.capture('call_ice_config_refreshed', {
        'call_id': config.room,
        'why': why,
        'ok': false,
        'error': e.toString(),
      });
      AvaLog.I.log('call', 'setConfiguration before ICE restart failed: $e');
    }
  }

  Future<void> _tryIceRestart(String why) async {
    // SFU recovery is a server rejoin. Every legacy entry point now dispatches
    // to the SFU recovery owner instead of entering the phone-to-phone ladder.
    if (_sfuActive) {
      await _reconnectSfu();
      return;
    }
    if (_sfuStarting || _sfuReconnectInFlight) return;
    if (_sfuRetryPending) return; // [CALL-SFU-SURVIVE-1] see _requestRecovery
    final pc = _pc;
    if (pc == null || _ended || !_weOffered || _remoteId == null) return;
    // [CF-CALL-P2P-1] Defer to an in-flight video-enable renegotiation rather
    // than racing it with a competing offer — the caller's own watchdog/tick
    // will re-invoke this shortly after the upgrade (bounded to ~4s) finishes.
    if (_videoRenegoInFlight) return;
    if (_iceRestarts >= 3) return;
    _iceRestarts++;
    _telemetry.onIceRestart();
    try {
      _ice = await IceCache.get();
      await _pushRefreshedIceToPc(pc, why); // [CALL-ICE-CFG-1]
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

  // ── [CALL-REL-5] serialized ICE recovery coordinator ─────────────────────
  // Entirely inert unless RemoteConfig.callIceRecoveryV2 is on; every entry
  // point below is called ONLY from flag-gated call sites. See plan §7.3.

  /// Either endpoint may request recovery (REL-3 fix). Guards to exactly one
  /// active attempt at a time (plan §4.1: "no overlapping restarts").
  Future<void> _requestRecovery(RecoveryReason why) async {
    if (_sfuActive) {
      await _reconnectSfu();
      return;
    }
    if (_sfuStarting || _sfuReconnectInFlight) return;
    // [CALL-SFU-SURVIVE-1 2026-08-06] An SFU retry is armed and waiting out its
    // backoff. During that window `_sfuActive`/`_sfuStarting`/
    // `_sfuReconnectInFlight` are ALL false, so without this the P2P ICE ladder
    // starts up on an SFU call — and media is stalled by definition while we
    // wait, which is exactly what drives `_pollPlayoutHealth` in here.
    if (_sfuRetryPending) return;
    if (!RemoteConfig.callIceRecoveryV2) return;
    if (_ended || !_connected) return;
    // [CF-CALL-P2P-1] Defer to an in-flight video-enable renegotiation —
    // [_pollPlayoutHealth]'s next 5s tick will re-request recovery if it's
    // still needed once the (bounded, ~4s max) upgrade settles.
    if (_videoRenegoInFlight) return;
    if (_activeRecovery != null) return; // one attempt at a time
    final id = const Uuid().v4();
    _recoveryAttemptCount++;
    final attempt = RecoveryAttempt(
      id: id,
      reason: why,
      targetPath: _relayForced ? 'relay' : 'direct',
      startedAtMs: DateTime.now().millisecondsSinceEpoch,
      attempt: _recoveryAttemptCount,
    );
    _activeRecovery = attempt;
    _telemetry.setRecoveryState('recovering_ice',
        attemptCount: _recoveryAttemptCount);
    if (!_ended && _connected) _setPhase('reconnecting');
    Analytics.capture('call_recovery_started', {
      'call_id': config.room,
      'attempt_id': id,
      'reason': why.wire,
      'source_endpoint': _myId,
      'current_path': attempt.targetPath,
      // Health summary: last classified interval, no SDP/ICE credentials/PII.
      'last_health_class': _lastPlayoutHealthClass.wire,
    });
    // Ask the CallRoom DO to pick a deterministic offerer (plan §7.3.3). No
    // `to` — the DO special-cases this type and answers both peers directly
    // rather than relaying it. Contains NO SDP, NO PII.
    _send({
      'type': 'recovery-request',
      'attemptId': id,
      'reason': why.wire,
      'path': attempt.targetPath,
    });
    // Deadline — owned here, NOT by the old watchdog. [CALL-SURVIVE-1] was a
    // fixed 30s AND terminal; now remote-config (default 12s) and expiry
    // feeds the retry ladder instead of ending the call.
    _recoveryDeadlineTimer?.cancel();
    _recoveryDeadlineTimer =
        Timer(Duration(seconds: RemoteConfig.callRecoveryDeadlineSec), () {
      if (_activeRecovery?.id == id && !_activeRecovery!.completed) {
        _failRecovery('recovery_timeout_no_playout');
      }
    });
  }

  /// The CallRoom DO answered a `recovery-request` (from us or our peer) with
  /// the chosen offerer. Only the chosen offerer ICE-restarts; the other side
  /// waits and reports `recovery-ready` once its own playout resumes.
  void _onRecoveryOffer(Map<String, dynamic> d) {
    if (!RemoteConfig.callIceRecoveryV2 || _ended) return;
    final id = d['attemptId']?.toString();
    final offererId = d['offererId']?.toString();
    if (id == null || id.isEmpty || offererId == null) return;
    var attempt = _activeRecovery;
    if (attempt == null) {
      // Peer requested recovery; we didn't — adopt the DO's attempt so both
      // sides share one attempt id/deadline.
      final reason = _reasonFromWire(d['reason']?.toString());
      _recoveryAttemptCount++;
      attempt = RecoveryAttempt(
        id: id,
        reason: reason,
        targetPath: (d['path']?.toString() == 'relay')
            ? 'relay'
            : (_relayForced ? 'relay' : 'direct'),
        startedAtMs: DateTime.now().millisecondsSinceEpoch,
        attempt: _recoveryAttemptCount,
      );
      _activeRecovery = attempt;
      _telemetry.setRecoveryState('recovering_ice',
          attemptCount: _recoveryAttemptCount);
      if (!_ended && _connected) _setPhase('reconnecting');
      _recoveryDeadlineTimer?.cancel();
      // [CALL-SURVIVE-1] remote-config deadline (default 12s), non-terminal.
      _recoveryDeadlineTimer =
          Timer(Duration(seconds: RemoteConfig.callRecoveryDeadlineSec), () {
        if (_activeRecovery?.id == id && !_activeRecovery!.completed) {
          _failRecovery('recovery_timeout_no_playout');
        }
      });
    } else if (attempt.id != id) {
      return; // stale/foreign attempt id — ignore
    }
    attempt.isOfferer = offererId == _myId;
    Analytics.capture('call_recovery_offer', {
      'call_id': config.room,
      'attempt_id': id,
      'coordinator_peer': offererId,
      'kind': 'ice',
    });
    if (attempt.isOfferer) {
      // ignore: unawaited_futures
      _startIceRecovery(attempt);
    }
    // Non-offerer: nothing to do yet — waits for the inbound `offer` (handled
    // by the existing 'offer' case) and reports readiness once its own
    // playout resumes (see [_onPlayoutHealthForRecovery]).
  }

  static RecoveryReason _reasonFromWire(String? w) {
    switch (w) {
      case 'no_playout':
        return RecoveryReason.noPlayout;
      case 'high_concealment':
        return RecoveryReason.highConcealment;
      case 'network_changed':
        return RecoveryReason.networkChanged;
      case 'peer_rejoined':
        return RecoveryReason.peerRejoined;
      case 'route_mismatch':
        return RecoveryReason.routeMismatch;
      default:
        return RecoveryReason.transportDisconnected;
    }
  }

  /// The chosen offerer performs the actual ICE restart (plan §7.3.4). Does
  /// NOT check `_weOffered` — that is precisely the REL-3 bug this replaces:
  /// either endpoint may become the recovery offerer.
  Future<void> _startIceRecovery(RecoveryAttempt attempt) async {
    final pc = _pc;
    if (pc == null || _ended || _remoteId == null) {
      _failRecovery('recovery_no_peer_connection');
      return;
    }
    try {
      _ice = await IceCache.get();
      await _pushRefreshedIceToPc(pc, attempt.reason.wire); // [CALL-ICE-CFG-1]
      final offer = _tuned(await pc.createOffer({'iceRestart': true}));
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
      _iceRestarts++;
      _telemetry.onIceRestart();
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'ice_recovery_offer_failed',
        error: e,
        stack: st,
        extra: {'attempt_id': attempt.id, 'reason': attempt.reason.wire},
      );
      _failRecovery('recovery_offer_failed');
    }
  }

  /// Peer's `recovery-ready` for our active attempt (offerer side only —
  /// meaningless if we're not the offerer, so harmless either way).
  void _onRecoveryReady(Map<String, dynamic> d) {
    final a = _activeRecovery;
    if (a == null || a.completed) return;
    if (d['attemptId']?.toString() != a.id) return;
    a.peerReady = true;
    _maybeCompleteRecovery();
  }

  /// Fed by [_pollPlayoutHealth] on every classification while a recovery is
  /// active. Offerer: counts consecutive healthy samples toward completion,
  /// gated on the peer's `recovery-ready` ack (see [_maybeCompleteRecovery]).
  /// Non-offerer: sends its own `recovery-ready` once playout resumes, THEN
  /// completes locally on its own evidence — see [_completeRecoveryLocally]
  /// for why (BLOCKER-1, plan §7.3).
  void _onPlayoutHealthForRecovery(MediaHealthClass cls) {
    final a = _activeRecovery;
    if (a == null || a.completed) return;
    final playoutOk =
        cls == MediaHealthClass.healthy || cls == MediaHealthClass.remoteQuiet;
    if (a.isOfferer) {
      if (playoutOk) {
        a.healthySamplesSinceStart++;
        _maybeCompleteRecovery();
      } else {
        a.healthySamplesSinceStart = 0;
      }
      return;
    }
    // Non-offerer branch. `healthySamplesSinceStart` is reused here as "our
    // own consecutive healthy playout samples" — nothing offerer-specific
    // depends on it on this branch.
    if (playoutOk) {
      a.healthySamplesSinceStart++;
    } else {
      a.healthySamplesSinceStart = 0;
    }
    if (!a.selfReadySent && playoutOk && _remoteId != null) {
      a.selfReadySent = true;
      _send({'type': 'recovery-ready', 'to': _remoteId, 'attemptId': a.id});
    }
    if (a.selfReadySent && a.healthySamplesSinceStart >= 2) {
      _completeRecoveryLocally(a);
    }
  }

  /// Success = two consecutive healthy playout samples on the initiating
  /// endpoint AND one `recovery-ready` from the peer (plan §7.3.5).
  void _maybeCompleteRecovery() {
    final a = _activeRecovery;
    if (a == null || a.completed || !a.isOfferer) return;
    if (a.healthySamplesSinceStart >= 2 && a.peerReady) {
      _completeRecovery(a);
    }
  }

  void _completeRecovery(RecoveryAttempt attempt) {
    if (attempt.completed) return;
    attempt.completed = true;
    _recoveryDeadlineTimer?.cancel();
    final elapsedMs =
        DateTime.now().millisecondsSinceEpoch - attempt.startedAtMs;
    Analytics.capture('call_recovery_completed', {
      'call_id': config.room,
      'attempt_id': attempt.id,
      'path_before': attempt.targetPath,
      'path_after': _relayForced ? 'relay' : 'direct',
      'elapsed_ms': elapsedMs,
      'two_side_ack': true,
    });
    if (identical(_activeRecovery, attempt)) _activeRecovery = null;
    _telemetry.setRecoveryState('none', attemptCount: _recoveryAttemptCount);
    _survivalRetries = 0; // [CALL-SURVIVE-1] success resets the ladder
    _survivalRetryTimer?.cancel();
    if (!_ended && _connected) _setPhase('connected');
  }

  /// [BLOCKER-1 fix] The non-offerer's completion path. The protocol never
  /// sends the non-offerer an ack back FROM the offerer — `recovery-ready`
  /// only flows non-offerer -> offerer, and the offerer's own
  /// [_completeRecovery] never replies with anything. Before this fix, the
  /// non-offerer had NO way to clear its `_activeRecovery`/cancel its own
  /// [_recoveryDeadlineTimer], so 30s after every SUCCESSFUL recovery it hit
  /// its own deadline timer and called `_failRecovery('recovery_timeout_no_playout')`,
  /// dropping an otherwise-healthy call. The non-offerer instead completes on
  /// its own evidence: it already sent `recovery-ready`, and it has
  /// independently observed 2 consecutive healthy playout samples. Telemetry
  /// is marked `two_side_ack: false` / `local_complete: true` so this is
  /// distinguishable from the offerer's bilaterally-acknowledged completion.
  void _completeRecoveryLocally(RecoveryAttempt attempt) {
    if (attempt.completed) return;
    attempt.completed = true;
    _recoveryDeadlineTimer?.cancel();
    final elapsedMs =
        DateTime.now().millisecondsSinceEpoch - attempt.startedAtMs;
    Analytics.capture('call_recovery_completed', {
      'call_id': config.room,
      'attempt_id': attempt.id,
      'path_before': attempt.targetPath,
      'path_after': _relayForced ? 'relay' : 'direct',
      'elapsed_ms': elapsedMs,
      'two_side_ack': false,
      'local_complete': true,
    });
    if (identical(_activeRecovery, attempt)) _activeRecovery = null;
    _telemetry.setRecoveryState('none', attemptCount: _recoveryAttemptCount);
    _survivalRetries = 0; // [CALL-SURVIVE-1] success resets the ladder
    _survivalRetryTimer?.cancel();
    if (!_ended && _connected) _setPhase('connected');
  }

  /// Every terminal path here names the exact failed invariant (plan §7.3.7),
  /// never a generic 'error'/'socket-lost'. [CALL-REL-6] escalates to relay
  /// migration here when direct ICE recovery fails — "escalate to relay
  /// migration; do not loop direct ICE restarts indefinitely" (plan §7.3.6).
  void _failRecovery(String reason) {
    final a = _activeRecovery;
    if (a == null || a.completed) return;
    a.completed = true;
    _recoveryDeadlineTimer?.cancel();
    final elapsedMs = DateTime.now().millisecondsSinceEpoch - a.startedAtMs;
    Analytics.capture('call_recovery_failed', {
      'call_id': config.room,
      'attempt_id': a.id,
      'terminal_reason': reason,
      'elapsed_ms': elapsedMs,
      'last_health_class': _lastPlayoutHealthClass.wire,
    });
    if (identical(_activeRecovery, a)) _activeRecovery = null;
    _telemetry.setRecoveryState('failed', attemptCount: _recoveryAttemptCount);
    // [CALL-REL-6] Escalate to relay migration instead of ending the call, IF
    // migration is enabled, not already relay, and not already used (MAX one
    // per call — plan §7.4.8: "a second unrecovered failure ends cleanly
    // after the standard recovery deadline", i.e. falls through below).
    if (RemoteConfig.callRelayMigrationV1 &&
        !_relayForced &&
        !_migrationAttempted &&
        !_ended &&
        _connected) {
      // [BLOCKER-2 fix] Both peers can reach this same escalation
      // independently (each arms its own 30s recovery deadline — see
      // BLOCKER-1 above). Only the deterministic initiator actually starts
      // `_migrateToRelay`; the other side asks it to instead of racing it
      // into a second `relay-migrate-offer` the DO would reject anyway.
      if (_isMigrationInitiator) {
        // ignore: unawaited_futures
        _migrateToRelay(a.reason);
      } else {
        _requestRelayMigration(a.reason);
      }
      return;
    }
    // [CALL-SURVIVE-1 2026-08-04] A failed recovery is no longer terminal.
    // Stay in `reconnecting` and schedule the next attempt; explicit hangup /
    // the signaling-WS ladder (`reconnect_failed`) own actual termination.
    _scheduleSurvivalRetry(a.reason, from: reason);
  }

  /// [CALL-SURVIVE-1] Schedule the next recovery attempt after a failure,
  /// with exponential backoff so retries don't flood a network that is still
  /// recovering. NEVER ends the call: after the ladder is exhausted the call
  /// stays in `reconnecting` (the WS reconnect ladder ends it if the peer is
  /// genuinely gone; otherwise the users decide when to hang up). Prod
  /// incident avatok-999a650b / avatok-10d4696b (2026-08-04): WiFi↔cell flaps
  /// ended live calls with `relay_migration_timeout` after ~50s of dead air.
  void _scheduleSurvivalRetry(RecoveryReason why, {required String from}) {
    if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) return;
    if (_sfuRetryPending) return; // [CALL-SFU-SURVIVE-1] see _requestRecovery
    if (_ended || !_connected) return;
    _setPhase('reconnecting');
    final max = RemoteConfig.callRecoveryMaxAttempts;
    if (_survivalRetries >= max) {
      Analytics.capture('call_recovery_exhausted', {
        'call_id': config.room,
        'attempts': _survivalRetries,
        'last_failure': from,
      });
      return; // stay alive in `reconnecting`; no further automatic attempts
    }
    final idx = _survivalRetries.clamp(0, _kSurvivalBackoffSec.length - 1);
    _survivalRetries++;
    _survivalRetryTimer?.cancel();
    _survivalRetryTimer =
        Timer(Duration(seconds: _kSurvivalBackoffSec[idx]), () {
      if (_ended || !_connected) return;
      if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) return;
      if (_activeRecovery != null || _activeMigration != null) return;
      // ignore: unawaited_futures
      _requestRecovery(why);
    });
    Analytics.capture('call_recovery_retry_scheduled', {
      'call_id': config.room,
      'attempt': _survivalRetries,
      'delay_s': _kSurvivalBackoffSec[idx],
      'last_failure': from,
    });
  }

  /// [CALL-SURVIVE-1] Abort any in-flight recovery/migration because the local
  /// network interface just changed — their candidates were gathered on the
  /// OLD interface and can only burn their deadlines. Resets the backoff
  /// ladder: a fresh interface deserves an immediate fresh attempt.
  void _abortInFlightRecoveryForNetChange() {
    final r = _activeRecovery;
    if (r != null && !r.completed) {
      r.completed = true;
      _recoveryDeadlineTimer?.cancel();
      _activeRecovery = null;
      Analytics.capture('call_recovery_aborted', {
        'call_id': config.room,
        'attempt_id': r.id,
        'why': 'network_changed',
      });
    }
    final m = _activeMigration;
    if (m != null && !m.completed) {
      // Abandon WITHOUT burning any cap (glare-style cleanup) — the retry on
      // the new interface is the attempt that matters.
      _abandonOwnMigrationAttempt(m);
      Analytics.capture('call_recovery_aborted', {
        'call_id': config.room,
        'attempt_id': m.id,
        'why': 'network_changed_migration',
      });
    }
    _survivalRetries = 0;
    _survivalRetryTimer?.cancel();
  }

  Future<void> _flushCandidates() async {
    _remoteSet = true;
    final pc = _pc;
    if (pc == null) return;
    final pending = List<RTCIceCandidate>.of(_pendingCandidates);
    _pendingCandidates.clear();
    for (final c in pending) {
      try {
        await pc.addCandidate(c);
      } catch (_) {}
    }
  }

  // ── [CALL-REL-6] mid-call relay migration ─────────────────────────────────
  // Entirely inert unless RemoteConfig.callRelayMigrationV1 is on. See plan
  // §7.4: dual-PC cutover, one migration per call, 20s deadline, old PC stays
  // live/audible until the new PC proves itself.

  /// [BLOCKER-2 fix] True if THIS endpoint is the deterministic relay-migration
  /// initiator. Reuses the exact same election rule the plan specifies for
  /// ICE-recovery offerer selection (§7.3.3): the original call offerer
  /// initiates unless it is away, otherwise the lexicographically lower
  /// stable peer id initiates. Both `_migrateToRelay` call sites (the
  /// loss-threshold path and `_failRecovery`'s escalation) run on BOTH peers
  /// independently — without this gate both could call `_migrateToRelay`
  /// for the same degraded call at the same time. The DO already grants only
  /// one `relay-migrate-offer` and rejects the other (`migration_already_used`
  /// / `migration_in_progress`), but the LOSER had already set
  /// `_migrationAttempted`/`_activeMigration`, so it used to ignore the
  /// winner's real offer in [_onRelayMigrateOffer] and both sides just sat
  /// out their independent 20s deadlines. Electing a single initiator up
  /// front avoids the race instead of only cleaning up after it.
  bool get _isMigrationInitiator {
    if (_weOffered)
      return true; // we are the original offerer — not "away" from our own view.
    final remote = _remoteId;
    if (remote == null)
      return true; // no peer id known yet; safe local default.
    if (peerAway.value) {
      // The original offerer (the peer, since we didn't offer) is away —
      // fall back to the lexicographically-lower stable id, same as §7.3.3.
      return _myId.compareTo(remote) < 0;
    }
    return false; // original offerer is present and it isn't us — defer to it.
  }

  /// [BLOCKER-2 fix] Non-initiator half of the glare fix: instead of racing
  /// the peer into our own `_migrateToRelay` (which the DO would reject),
  /// ask the deterministic initiator to start one. One-shot signal, reusing
  /// the generic `to`-scoped relay `CallRoom` already applies to every other
  /// signaling message type — no server change needed.
  void _requestRelayMigration(RecoveryReason why) {
    if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) return;
    if (_migrationAttempted || _activeMigration != null) return;
    final remoteId = _remoteId;
    if (remoteId == null) return;
    _send(
        {'type': 'relay-migrate-request', 'to': remoteId, 'reason': why.wire});
  }

  /// [BLOCKER-2 fix] The deterministic initiator's side of
  /// [_requestRelayMigration]: the peer decided (via its own
  /// [_isMigrationInitiator]) that WE should start the migration. Starts one
  /// if we agree we're the initiator and are otherwise eligible; a silent
  /// no-op if not (e.g. a stale/duplicate request after migration already
  /// completed).
  void _onRelayMigrateRequest(Map<String, dynamic> d) {
    if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) return;
    if (!RemoteConfig.callRelayMigrationV1 || _ended || !_connected) return;
    if (!_isMigrationInitiator) return; // peer mis-elected us; don't race it.
    if (_migrationAttempted || _activeMigration != null || _relayForced) return;
    // ignore: unawaited_futures
    _migrateToRelay(_reasonFromWire(d['reason']?.toString()));
  }

  /// [BLOCKER-2 fix] Glare cleanup for the LOSING side: this endpoint started
  /// (or answered) its own migration attempt, but the deterministic winner
  /// turned out to be the peer instead (DO rejected our offer with
  /// `migration_already_used`/`migration_in_progress`, or we received a
  /// genuinely different attempt id from the peer). Tears down OUR half
  /// WITHOUT burning the one-migration-per-call cap and WITHOUT ending the
  /// call — the plan's cap (§7.4.8) means one COMPLETED/terminal migration,
  /// not one send attempt, so the surviving winner's attempt still gets its
  /// full shot at fixing the call.
  void _abandonOwnMigrationAttempt(RelayMigrationAttempt attempt) {
    if (attempt.completed) return;
    attempt.completed = true;
    if (identical(_activeMigration, attempt)) {
      _activeMigration = null;
      _migrationDeadlineTimer?.cancel();
    }
    try {
      attempt.newPc?.close();
    } catch (_) {}
  }

  /// Initiator side: fresh TURN creds, brand-new relay-only PC, existing
  /// tracks re-added, offer sent via `relay-migrate-offer`. The OLD `_pc`
  /// keeps running (still audible) until [_maybeCompleteMigration] cuts over.
  Future<void> _migrateToRelay(RecoveryReason why) async {
    if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) return;
    if (!RemoteConfig.callRelayMigrationV1) {
      // [CALL-SURVIVE-1] Flag off is not a reason to end a live call — fall
      // back to the plain ICE-recovery retry ladder.
      _scheduleSurvivalRetry(why, from: 'relay_migration_disabled');
      return;
    }
    if (_ended || !_connected) return;
    if (_activeMigration != null) return; // one in flight at a time
    if (_migrationAttempted) {
      // A migration already COMPLETED this call (we're on relay) — nothing to
      // upgrade to. Retry plain recovery instead of ending the call.
      _scheduleSurvivalRetry(why, from: 'relay_migration_unavailable');
      return;
    }
    final remoteId = _remoteId;
    if (remoteId == null || _stream == null) {
      // [CALL-SURVIVE-1] was a hard end (`relay_migration_no_peer`).
      _scheduleSurvivalRetry(why, from: 'relay_migration_no_peer');
      return;
    }
    // [BLOCKER-2 fix] `_migrationAttempted` (the one-per-call CAP) is now set
    // only at a TERMINAL outcome — see [_maybeCompleteMigration] and
    // [_failMigration] — not here at send time. `_activeMigration` (set
    // just below) is what guards against a second local call while this one
    // is in flight; burning the cap here would make [_abandonOwnMigrationAttempt]
    // unable to let the actual winner's attempt still run to completion.
    final id = const Uuid().v4();
    final attempt = RelayMigrationAttempt(
        id: id, startedAtMs: DateTime.now().millisecondsSinceEpoch);
    _activeMigration = attempt;
    _telemetry.setRecoveryState('migrating_relay',
        attemptCount: _recoveryAttemptCount);
    Analytics.capture('call_recovery_started', {
      'call_id': config.room,
      'attempt_id': id,
      'reason': why.wire,
      'kind': 'relay',
      'source_endpoint': _myId,
      'current_path': 'direct',
    });
    try {
      // plan §7.4.1: fresh ICE, credentials may be short-lived.
      _ice = await IceCache.get(forceRefresh: true);
      final newPc = await createPeerConnection({
        'iceServers': _ice,
        'iceCandidatePoolSize': 2,
        'iceTransportPolicy': 'relay',
        // [CALL-SURVIVE-1] same jitter-buffer bounds as _newPC.
        'audioJitterBufferMaxPackets': 50,
        'audioJitterBufferFastAccelerate': true,
      });
      attempt.newPc = newPc;
      // [CF-CALL-P2P-1] Await installation and apply the same bounded
      // encoding as the primary PC — a relay migration is already on the
      // constrained TURN-relay path, so an unbounded video sender here is
      // even more likely to starve the link than on the direct path.
      await _addStreamTracks(newPc, _stream!,
          stage: 'migration_add_track_failed');
      if (config.video) {
        // [CALL-VIDEO-LOSS-1 2026-08-05] Was hardcoded `cellular: true`, which
        // pinned every recovery/migration PC to the 800 kbps cap even for a user
        // sitting on wifi the whole time — a permanent quality downgrade bought
        // by one network blip. Ask the device instead; `_isLikelyCellular()`
        // already falls back to `false` (the higher cap) on any error, so this
        // can still only ever be as conservative as before, never less.
        await _preferResolutionOnVideo(newPc,
            cellular: await _isLikelyCellular());
      }
      newPc.onIceCandidate = (c) {
        if (!identical(_activeMigration, attempt) || attempt.completed) return;
        _send({
          'type': 'relay-migrate-candidate',
          'to': remoteId,
          'attemptId': id,
          'candidate': c.toMap(),
        });
      };
      newPc.onTrack = (e) {
        if (!identical(_activeMigration, attempt) || attempt.completed) return;
        if (e.streams.isNotEmpty) {
          attempt.remoteTrackSeen = true;
          // [CALL-REL-6 SHOULD-FIX-4] Capture the stream now — cutover in
          // _maybeCompleteMigration repoints remoteRenderer to it directly.
          attempt.remoteStream = e.streams[0];
        }
      };
      final offer = _tuned(await newPc.createOffer());
      await newPc.setLocalDescription(offer);
      _send({
        'type': 'relay-migrate-offer',
        'to': remoteId,
        'attemptId': id,
        'sdp': offer.toMap(),
      });
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'relay_migration_offer_failed',
        error: e,
        stack: st,
        extra: {'attempt_id': id},
      );
      _failMigration(attempt, 'relay_migration_offer_failed');
      return;
    }
    _migrationDeadlineTimer?.cancel();
    // [CALL-SURVIVE-1] remote-config deadline (default 8s), non-terminal.
    _migrationDeadlineTimer =
        Timer(Duration(seconds: RemoteConfig.callMigrationDeadlineSec), () {
      if (identical(_activeMigration, attempt) && !attempt.completed) {
        _failMigration(attempt, 'relay_migration_timeout');
      }
    });
  }

  /// Receiver side: gets `relay-migrate-offer`, builds its OWN new relay-only
  /// PC, and answers. Symmetric with [_migrateToRelay] above.
  Future<void> _onRelayMigrateOffer(Map<String, dynamic> d) async {
    if (_sfuActive || _sfuStarting || _sfuReconnectInFlight) return;
    if (!RemoteConfig.callRelayMigrationV1 || _ended || !_connected) return;
    final id = d['attemptId']?.toString();
    if (id == null || id.isEmpty) return;
    if (_migrationAttempted)
      return; // cap already used by a terminal migration this call.
    final existing = _activeMigration;
    if (existing != null && existing.id != id) {
      // [BLOCKER-2 fix] We already started (or answered) our OWN attempt,
      // but this offer is for a DIFFERENT attempt id — the deterministic
      // initiator election should normally prevent this, but if it still
      // happens (e.g. a stale client, or both sides raced before either
      // saw the other's election inputs), trust the peer's real offer:
      // abandon ours and answer theirs instead of the old behavior, which
      // silently dropped the winner's offer and stranded both sides at
      // their independent 20s deadlines.
      _abandonOwnMigrationAttempt(existing);
    }
    final remoteId = d['from']?.toString();
    if (remoteId == null || remoteId.isEmpty || _stream == null) return;
    _remoteId ??= remoteId;
    final attempt = RelayMigrationAttempt(
        id: id, startedAtMs: DateTime.now().millisecondsSinceEpoch);
    _activeMigration = attempt;
    _telemetry.setRecoveryState('migrating_relay',
        attemptCount: _recoveryAttemptCount);
    try {
      _ice = await IceCache.get(forceRefresh: true);
      final newPc = await createPeerConnection({
        'iceServers': _ice,
        'iceCandidatePoolSize': 2,
        'iceTransportPolicy': 'relay',
        // [CALL-SURVIVE-1] same jitter-buffer bounds as _newPC.
        'audioJitterBufferMaxPackets': 50,
        'audioJitterBufferFastAccelerate': true,
      });
      attempt.newPc = newPc;
      // [CF-CALL-P2P-1] Await installation and apply the same bounded
      // encoding as the primary PC — a relay migration is already on the
      // constrained TURN-relay path, so an unbounded video sender here is
      // even more likely to starve the link than on the direct path.
      await _addStreamTracks(newPc, _stream!,
          stage: 'migration_add_track_failed');
      if (config.video) {
        // [CALL-VIDEO-LOSS-1 2026-08-05] Was hardcoded `cellular: true`, which
        // pinned every recovery/migration PC to the 800 kbps cap even for a user
        // sitting on wifi the whole time — a permanent quality downgrade bought
        // by one network blip. Ask the device instead; `_isLikelyCellular()`
        // already falls back to `false` (the higher cap) on any error, so this
        // can still only ever be as conservative as before, never less.
        await _preferResolutionOnVideo(newPc,
            cellular: await _isLikelyCellular());
      }
      newPc.onIceCandidate = (c) {
        if (!identical(_activeMigration, attempt) || attempt.completed) return;
        _send({
          'type': 'relay-migrate-candidate',
          'to': remoteId,
          'attemptId': id,
          'candidate': c.toMap(),
        });
      };
      newPc.onTrack = (e) {
        if (!identical(_activeMigration, attempt) || attempt.completed) return;
        if (e.streams.isNotEmpty) {
          attempt.remoteTrackSeen = true;
          // [CALL-REL-6 SHOULD-FIX-4] Capture the stream now — cutover in
          // _maybeCompleteMigration repoints remoteRenderer to it directly.
          attempt.remoteStream = e.streams[0];
        }
      };
      await newPc.setRemoteDescription(
          RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
      final ans = _tuned(await newPc.createAnswer());
      await newPc.setLocalDescription(ans);
      _send({
        'type': 'relay-migrate-answer',
        'to': remoteId,
        'attemptId': id,
        'sdp': ans.toMap(),
      });
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'relay_migration_answer_failed',
        error: e,
        stack: st,
        extra: {'attempt_id': id},
      );
      _failMigration(attempt, 'relay_migration_answer_failed');
      return;
    }
    _migrationDeadlineTimer?.cancel();
    // [CALL-SURVIVE-1] remote-config deadline (default 8s), non-terminal.
    _migrationDeadlineTimer =
        Timer(Duration(seconds: RemoteConfig.callMigrationDeadlineSec), () {
      if (identical(_activeMigration, attempt) && !attempt.completed) {
        _failMigration(attempt, 'relay_migration_timeout');
      }
    });
  }

  Future<void> _onRelayMigrateAnswer(Map<String, dynamic> d) async {
    final a = _activeMigration;
    if (a == null || a.completed) return;
    if (d['attemptId']?.toString() != a.id) return;
    final pc = a.newPc;
    if (pc == null) return;
    try {
      await pc.setRemoteDescription(
          RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
    } catch (e, st) {
      _telemetry.runtimeError(
        stage: 'relay_migration_set_answer_failed',
        error: e,
        stack: st,
        extra: {'attempt_id': a.id},
      );
      _failMigration(a, 'relay_migration_set_answer_failed');
    }
  }

  Future<void> _onRelayMigrateCandidate(Map<String, dynamic> d) async {
    final a = _activeMigration;
    if (a == null || a.completed) return;
    if (d['attemptId']?.toString() != a.id) return;
    final pc = a.newPc;
    if (pc == null) return;
    try {
      final c = d['candidate'];
      await pc.addCandidate(
          RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']));
    } catch (_) {/* best-effort, matches the existing candidate-add pattern */}
  }

  void _onRelayMigrateReady(Map<String, dynamic> d) {
    final a = _activeMigration;
    if (a == null || a.completed) return;
    if (d['attemptId']?.toString() != a.id) return;
    a.peerReady = true;
    _maybeCompleteMigration(a);
  }

  void _onRelayMigrateReject(Map<String, dynamic> d) {
    final a = _activeMigration;
    if (a == null || a.completed) return;
    if (d['attemptId']?.toString() != a.id) return;
    final reason = d['reason']?.toString() ?? 'relay_migration_rejected';
    if (reason == 'migration_already_used' ||
        reason == 'migration_in_progress') {
      // [BLOCKER-2 fix] The DO already granted the OTHER peer's offer — this
      // is glare, not a real failure. The winner's migration may still
      // succeed, so abandon quietly (no cap burn, no call-ending) and wait
      // to adopt their offer/ready via [_onRelayMigrateOffer] instead of
      // calling [_failMigration], which could otherwise end a call whose
      // OTHER migration attempt is about to fix it.
      _abandonOwnMigrationAttempt(a);
      return;
    }
    _failMigration(a, reason);
  }

  /// Fed by [_pollPlayoutHealth] once a migration's new PC has a remote track
  /// — counts consecutive healthy samples ON THE NEW PC (plan §7.4.5: "must
  /// not close the old PC until the new one produces a remote track and two
  /// healthy playout samples").
  void _onPlayoutHealthForMigration(MediaHealthClass cls) {
    final a = _activeMigration;
    if (a == null || a.completed || !a.remoteTrackSeen) return;
    final ok =
        cls == MediaHealthClass.healthy || cls == MediaHealthClass.remoteQuiet;
    if (ok) {
      a.healthySamplesOnNewPc++;
      if (a.healthySamplesOnNewPc >= 2 && !a.readySent) {
        a.readySent = true;
        if (_remoteId != null) {
          _send({
            'type': 'relay-migrate-ready',
            'to': _remoteId,
            'attemptId': a.id
          });
        }
        _maybeCompleteMigration(a);
      }
    } else {
      a.healthySamplesOnNewPc = 0;
    }
  }

  /// plan §7.4.6: "Both peers exchange relay-migrate-ready. Only then close
  /// the old PC and promote the new PC to `_pc`."
  Future<void> _maybeCompleteMigration(RelayMigrationAttempt a) async {
    if (a.completed) return;
    if (!a.readySent || !a.peerReady) return;
    if (a.healthySamplesOnNewPc < 2 || !a.remoteTrackSeen) return;
    final newPc = a.newPc;
    if (newPc == null) return;
    a.completed = true;
    // [BLOCKER-2 fix] The one-migration-per-call CAP is burned HERE, at a
    // genuine terminal success — not at send/answer time (see _migrateToRelay
    // and _onRelayMigrateOffer for why).
    _migrationAttempted = true;
    _migrationDeadlineTimer?.cancel();
    final oldPc = _pc;
    // [CALL-PCRETIRE-1 2026-08-06] `_pc` FIRST, then install the handlers.
    // `_promoteMigratedPc` installs an `onConnectionState` that guards on
    // `identical(pc, _pc)`; with the old ordering the newly promoted — and
    // live — connection failed its own guard until the assignment two lines
    // later. That is safe today only because nothing between them awaits, which
    // is far too subtle an invariant to leave standing.
    _pc = newPc;
    _promoteMigratedPc(newPc);
    _resetPlayoutHealthBaselines();
    // [CALL-REL-6 SHOULD-FIX-4] Repoint the renderer to the NEW PC's remote
    // stream at cutover. `attempt.remoteTrackSeen` (required above) proves
    // `onTrack` already fired once on the migration PC — that already
    // happened on the pre-promotion handler installed in
    // `_migrateToRelay`/`_onRelayMigrateOffer`, not on `_promoteMigratedPc`'s
    // handler, so without this line the renderer would keep showing the OLD
    // (closed) PC's stream until/unless a brand-new track event happens to
    // fire post-promotion, which may never occur.
    if (a.remoteStream != null) {
      remoteRenderer.srcObject = a.remoteStream;
    }
    _relayForced = true;
    _telemetry.setMediaPath('relay');
    // [CALL-PCRETIRE-1] `_pc` is already the new PC (two lines above), so this
    // only closes — but it must go through the one retirement path so the
    // ordering invariant holds if this block is ever reordered.
    await _retirePc(oldPc);
    if (identical(_activeMigration, a)) _activeMigration = null;
    final elapsedMs = DateTime.now().millisecondsSinceEpoch - a.startedAtMs;
    Analytics.capture('call_recovery_completed', {
      'call_id': config.room,
      'attempt_id': a.id,
      'kind': 'relay',
      'path_before': 'direct',
      'path_after': 'relay',
      'elapsed_ms': elapsedMs,
      'two_side_ack': true,
    });
    _telemetry.setRecoveryState('none', attemptCount: _recoveryAttemptCount);
    _survivalRetries = 0; // [CALL-SURVIVE-1] success resets the ladder
    _survivalRetryTimer?.cancel();
    if (!_ended && _connected) _setPhase('connected');
  }

  /// Re-wires the standard candidate/track/connection-state handlers onto the
  /// PC being promoted after a migration cutover, so future ICE candidates,
  /// remote-track updates, and CALL-REL-5 recovery keep working exactly as
  /// they did on the original `_pc`. Deliberately a lighter ladder than
  /// [_newPC] (no legacy 10s `_failTimer` hard-end/`_tryIceRestart` path —
  /// this is a v1-relay-migration PC, and any further transport failure on it
  /// is owned by the CALL-REL-5 coordinator when that flag is also on).
  // ── [CALL-VIDEO-RENDER-WATCH-1] frozen remote video self-heal ─────────────

  /// Consecutive health samples where decode progressed on a track the
  /// renderer is NOT bound to. Reset by any healthy/indeterminate sample.
  int _renderStallStreak = 0;
  bool _renderHealInFlight = false;

  /// Rebind cap per call — a mismatch this logic cannot fix must not turn into
  /// a rebind every 10 seconds for the rest of the call.
  int _renderHealsThisCall = 0;

  /// Rebind [remoteRenderer] to the video track the stats say is actually
  /// decoding. Called by the media-health sampler after two consecutive
  /// mismatch samples; gated by `callVideoRenderHealV1` (detection telemetry
  /// is emitted either way, so prod shows how often this fires even when the
  /// heal itself is killed).
  Future<void> _healFrozenRemoteVideo(
      RTCPeerConnection pc, String liveTrackId, String staleTrackId) async {
    if (_renderHealInFlight || _ended) return;
    _renderHealInFlight = true;
    try {
      final enabled = RemoteConfig.callVideoRenderHealV1;
      var healed = false;
      if (enabled && _renderHealsThisCall < 3) {
        final receivers = await pc.getReceivers();
        for (final r in receivers) {
          final t = r.track;
          if (t == null || t.kind != 'video' || t.id != liveTrackId) continue;
          final s = remoteRenderer.srcObject;
          if (s == null) break;
          for (final old in List.of(s.getVideoTracks())) {
            try {
              await s.removeTrack(old);
            } catch (_) {/* stale native track may already be gone */}
          }
          await s.addTrack(t);
          // Re-assign so the native renderer re-attaches its sink — mutating
          // the stream's track list alone does not repoint an already-bound
          // texture on all platforms.
          remoteRenderer.srcObject = null;
          remoteRenderer.srcObject = s;
          _renderHealsThisCall++;
          healed = true;
          break;
        }
      }
      Analytics.capture('call_video_render_heal', {
        'call_id': config.room,
        'ok': healed,
        'enabled': enabled,
        'heals_this_call': _renderHealsThisCall,
        'live_track': liveTrackId,
        'stale_track': staleTrackId,
      });
    } catch (e, st) {
      _telemetry.runtimeError(stage: 'video_render_heal', error: e, stack: st);
    } finally {
      _renderHealInFlight = false;
    }
  }

  void _promoteMigratedPc(RTCPeerConnection pc) {
    // [CF-CALL-P2P-1] This PC is about to become `_pc` — give it its own
    // generation so any STILL-pending event from whatever `_pc` it's
    // replacing can no longer bind the renderer after this point.
    final myPcGen = ++_pcGeneration;
    pc.onIceCandidate = (c) {
      if (_remoteId != null)
        _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
    };
    pc.onTrack = (e) {
      if (myPcGen != _pcGeneration) return;
      if (e.streams.isNotEmpty) remoteRenderer.srcObject = e.streams[0];
    };
    pc.onConnectionState = (s) {
      // [CALL-PCRETIRE-1 2026-08-06] Same retirement guard as _newPC(). A
      // migration that is later superseded (a second cutover, or an SFU
      // reconnect after a relay migration) must not have its outgoing PC end
      // the call from its own `Closed` callback.
      if (_ended || !identical(pc, _pc)) return;
      // [CALL-OBS-1] Same missing rung on the post-migration PC — see _newPC().
      _noteTransportConnected(s, postMigration: true);
      if (!_connected) return;
      _telemetry.mediaFlowState(
        state: 'transport_${s.toString().split('.').last.toLowerCase()}',
        transportState: s.toString(),
      );
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _telemetry.runtimeError(
          stage: 'pc_closed',
          error: StateError('Peer connection closed during an active call'),
          extra: {'transport_state': s.toString(), 'post_migration': true},
        );
        _endWith('ended');
      } else if ((s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
              s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) &&
          RemoteConfig.callIceRecoveryV2) {
        // ignore: unawaited_futures
        _requestRecovery(RecoveryReason.transportDisconnected);
      }
    };
  }

  /// plan §7.4.7: "if it fails, keep the old direct PC if it still has
  /// playout. A failed upgrade must not create an outage." §7.4.8: "cap at
  /// one migration per call. A second unrecovered failure ends cleanly after
  /// the standard recovery deadline" — [_migrationAttempted] enforces the cap
  /// (never reset), so a later failure falls through [_failRecovery]'s own
  /// end path instead of retrying migration.
  void _failMigration(RelayMigrationAttempt a, String reason) {
    if (a.completed) return;
    a.completed = true;
    // [CALL-SURVIVE-1 2026-08-04] The one-migration-per-call cap is GONE for
    // failures. On a moving phone (train/lift) the first migration routinely
    // lands mid-flap and fails through no fault of the design; burning the cap
    // there guaranteed the next failure was terminal (`relay_migration_timeout`
    // ended live calls — prod 2026-08-04). `_migrationAttempted` is now set
    // only by a COMPLETED migration (already on relay → no repeat needed).
    _migrationDeadlineTimer?.cancel();
    final elapsedMs = DateTime.now().millisecondsSinceEpoch - a.startedAtMs;
    Analytics.capture('call_recovery_failed', {
      'call_id': config.room,
      'attempt_id': a.id,
      'kind': 'relay',
      'terminal_reason': reason,
      'elapsed_ms': elapsedMs,
    });
    try {
      a.newPc?.close();
    } catch (_) {}
    if (identical(_activeMigration, a)) _activeMigration = null;
    final oldPc = _pc;
    final oldPcAlive = oldPc != null &&
        oldPc.connectionState !=
            RTCPeerConnectionState.RTCPeerConnectionStateClosed &&
        oldPc.connectionState !=
            RTCPeerConnectionState.RTCPeerConnectionStateFailed;
    _telemetry.setRecoveryState(oldPcAlive ? 'none' : 'failed',
        attemptCount: _recoveryAttemptCount);
    if (!oldPcAlive) {
      // [CALL-SURVIVE-1] Old PC dead + migration failed used to END the call
      // here (`relay_migration_timeout`). Now: stay in `reconnecting` and
      // retry — termination belongs to hangup / the WS ladder only.
      _scheduleSurvivalRetry(RecoveryReason.transportDisconnected,
          from: reason);
    } else if (!_ended && _connected) {
      // Old PC still has playout — a failed upgrade must not create an outage.
      _setPhase('connected');
    }
  }

  /// Acquire the real microphone only after Accept. When [transport] is
  /// supplied, swap the track into the already-published prewarm sender before
  /// any pull negotiation; replaceTrack needs no re-offer.
  Future<bool> _ensureAcceptedAudio({CallSfuTransport? transport}) async {
    final current = _stream;
    if (!_prewarmAudioPending && current?.getAudioTracks().isNotEmpty == true) {
      return true;
    }
    // [CALL-PREWARM-TRUTH-1] Read before the swap: `current` is disposed below
    // and `_prewarmAudioPending` is cleared, so neither can be inspected by the
    // assertion event at the end.
    final fromProtocolSilence = _prewarmAudioPending;
    MediaStream? media;
    try {
      var mediaTimedOut = false;
      final mediaFuture = navigator.mediaDevices.getUserMedia({
        'audio': audio_tuning.avaMicConstraints(),
        'video': false,
      });
      // Future.timeout cannot cancel native capture. If Android/iOS returns a
      // stream after the bounded Accept window, stop and dispose it so a late
      // result cannot leave the microphone open after fallback or teardown.
      unawaited(mediaFuture.then((lateStream) async {
        if (!mediaTimedOut) return;
        for (final t in lateStream.getTracks()) {
          try {
            await t.stop();
          } catch (_) {}
        }
        try {
          await lateStream.dispose();
        } catch (_) {}
        Analytics.capture('call_media_late_stream_disposed', {
          'call_id': config.room,
          'video': false,
          'stage': 'accepted_audio',
        });
      }).catchError((_) {}));
      media =
          await mediaFuture.timeout(const Duration(seconds: 8), onTimeout: () {
        mediaTimedOut = true;
        throw TimeoutException(
          'accepted getUserMedia did not return within 8s',
        );
      });
      // The call may have ended while native capture was opening. Never attach
      // a newly returned microphone to a torn-down SFU sender.
      if (_ended) {
        for (final t in media.getTracks()) {
          try {
            await t.stop();
          } catch (_) {}
        }
        await media.dispose();
        return false;
      }
      final audioTracks = media.getAudioTracks();
      final track = audioTracks.isEmpty ? null : audioTracks.first;
      if (track == null) throw StateError('accepted_audio_track_missing');
      if (transport != null &&
          !await transport.replacePublishedAudioTrack(track)) {
        throw StateError('prewarm_audio_replace_failed');
      }
      if (_ended) {
        for (final t in media.getTracks()) {
          try {
            await t.stop();
          } catch (_) {}
        }
        await media.dispose();
        return false;
      }
      _stream = media;
      _prewarmAudioPending = false;
      localRenderer.srcObject = media;
      if (current != null && !identical(current, media)) {
        try {
          await current.dispose();
        } catch (_) {}
      }
      _stage(transport == null ? 'mic_ready_fallback' : 'mic_replaced');
      Analytics.capture('call_preaccept_audio_replaced', {
        'call_id': config.room,
        'path': transport == null ? 'fallback' : 'sfu_replace_track',
        'renegotiated': false,
      });
      // [CALL-PREWARM-TRUTH-1 2026-08-21] The success value for this fix, per
      // the ship gate. On 2026-08-20 `call_preaccept_audio_replaced` fired on
      // both broken calls, so its ARRIVAL proves nothing — what was missing was
      // a live, enabled mic track on the answering side. Assert that here so a
      // regression is one PostHog filter away instead of a phone call.
      Analytics.capture('call_accept_mic_attached', {
        'call_id': config.room,
        'role': config.outgoing ? 'caller' : 'callee',
        'path': transport == null ? 'fallback' : 'sfu_replace_track',
        'track_enabled': track.enabled,
        'track_kind': track.kind ?? '',
        'audio_track_count': media.getAudioTracks().length,
        'from_protocol_silence': fromProtocolSilence,
      });
      return true;
    } catch (e, st) {
      if (media != null) {
        for (final t in media.getTracks()) {
          try {
            await t.stop();
          } catch (_) {}
        }
        try {
          await media.dispose();
        } catch (_) {}
      }
      // [STREAM-PERM-1] Same four-way classification as the cold-boot path
      // above; `_lastMediaFailure` carries it out to the three callers, which
      // all used to end the call with a flat `media-denied`.
      final failure = await classifyMediaFailureWithPermissions(
        e,
        video: false,
      );
      _lastMediaFailure = failure;
      Analytics.error(
        domain: 'call_setup',
        code: failure.code,
        message: e.toString(),
        action: 'accepted_audio',
        extra: {
          'call_id': config.room,
          'prewarm': true,
          'media_failure_kind': failure.kind.name,
        },
      );
      _telemetry.runtimeError(
        stage: 'accepted_audio_failed',
        error: e,
        stack: st,
        extra: {
          'prewarm': true,
          'media_failure_kind': failure.kind.name,
        },
      );
      return false;
    }
  }

  Future<void> _startP2pOffer() async {
    // [CALL-PREJOIN-1 2026-08-16] A caller pre-join PC must never survive
    // into the P2P path — `_pc != null` below would otherwise silently no-op
    // this method forever, since `_newPC`'s side effect already set `_pc` to
    // the prejoin's (SFU) connection. See [_discardPrejoinedSfu].
    await _discardPrejoinedSfu('p2p_selected');
    if (!config.outgoing && RemoteConfig.callSilentTransportPrewarmV1) {
      await CallPrewarm.instance.discard(config.room, 'p2p_selected');
    }
    if (_prewarmAudioPending && !await _ensureAcceptedAudio()) {
      _endWithMediaFailure(); // [STREAM-PERM-1]
      return;
    }
    if (_ended || _connected || _pc != null || _remoteId == null) return;
    final pc = await _newPC();
    final offer = _tuned(await pc.createOffer());
    await pc.setLocalDescription(offer);
    _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
  }

  /// [CALL-RTK-3] Is RealtimeKit eligible for THIS call?
  ///
  /// Two gates, and the second one is a feature-interaction rule, not a flag:
  /// in-call translation taps flutter_webrtc's decoded-playback callback
  /// (`CallTranslationAudioPlugin.java`), and RealtimeKit bundles its own
  /// WebRTC — so on the RTK path that tap does not exist and translation would
  /// silently produce nothing. Spec §4: "if translation is armed for a call,
  /// that call uses the legacy path (client-side check, same fork point)."
  ///
  /// The check is deliberately AVAILABILITY, not "the user has already pressed
  /// Translate": arming happens later in the call, from the overlay, while the
  /// media transport is chosen once at connect. A call that could be translated
  /// must therefore never start on RTK. Both keys default false, so this costs
  /// nothing today.
  bool get _rtkEligible =>
      RemoteConfig.callRealtimeKitV1 &&
      !(RemoteConfig.translationEnabled && RemoteConfig.callTranslationEnabled);

  /// [CALL-RTK-3] Join the RealtimeKit meeting for this room.
  ///
  /// Shaped EXACTLY like [_startSfuMedia] on purpose — same guard, same sticky
  /// abort, same "tell the peer, then fall back to P2P" ending — so the two
  /// transports fail the same way and a reader only has to learn the pattern
  /// once. The join deadline is [RemoteConfig.callRtkJoinDeadlineSec] so a slow
  /// or wedged join self-aborts to P2P instead of stranding the call.
  Future<void> _startRtkMedia() async {
    if (_ended || _connected || _rtkStarting || _rtkActive || _rtkAborted)
      return;
    // [CALL-PREJOIN-1 2026-08-16] The election landed on RealtimeKit, not the
    // raw SFU — the caller's ring-time pre-join seat (if any) is now dead
    // weight. See [_discardPrejoinedSfu].
    await _discardPrejoinedSfu('rtk_selected');
    if (!config.outgoing && RemoteConfig.callSilentTransportPrewarmV1) {
      await CallPrewarm.instance.discard(config.room, 'rtk_selected');
    }
    if (_prewarmAudioPending && !await _ensureAcceptedAudio()) {
      _endWithMediaFailure(); // [STREAM-PERM-1]
      return;
    }
    _connectWatchdogFast?.cancel();
    _connectWatchdogFast = null;
    _rtkStarting = true;
    _stage('rtk_begin');
    final deadline = Duration(seconds: RemoteConfig.callRtkJoinDeadlineSec);
    try {
      final ticket = await RealtimeKitRtcProvider.fetchTicket(
        room,
        mode: config.video ? RtcMode.video : RtcMode.audio,
      );
      final session = await RealtimeKitRtcProvider().join(
        ticket,
        mode: config.video ? RtcMode.video : RtcMode.audio,
        timeout: deadline,
      );
      if (_ended) {
        await session.leave();
        _rtkStarting = false;
        return;
      }
      _rtk = session;
      _rtkStarting = false;
      _rtkActive = true;
      // [CALL-RTK-4] Wire the session's events into the call lifecycle BEFORE
      // anything else can await: joining a meeting is not the same thing as the
      // call being connected, and everything that disarms the ring timeout and
      // the connect watchdogs lives behind this listener.
      //
      // NOTE the ordering constraint: `RealtimeKitRtcProvider.join` emits
      // `RtcSessionEvent.connected` on the way OUT of `join()` (provider
      // ~L492), and `events` is a plain broadcast stream with no replay — so
      // that first `connected` is ALREADY GONE by the time we get here and must
      // never be what this path waits for. The signals we key on
      // (`trackAdded` / `remoteJoin`) are all emitted later, by the SDK's
      // participant callbacks.
      _rtkEvents = session.events.listen(_onRtkEvent);
      _stage('rtk_joined');
      _telemetry.setMediaPath('rtk');
      Analytics.capture('call_rtk_active', {
        'call_id': config.room,
        'video': config.video,
      });
      return;
    } catch (e, s) {
      _rtkStarting = false;
      _rtkAborted = true;
      await Analytics.captureException(e, s,
          screen: 'call_session',
          handled: true,
          extra: {'op': 'rtk_start', 'call_id': config.room});
      Analytics.capture('call_rtk_fallback', {
        'call_id': config.room,
        'failure': e.runtimeType.toString(),
      });
    }
    await _fallbackFromRtk();
  }

  /// [CALL-RTK-4] Tell the peer we are off RealtimeKit, then take the legacy
  /// path. Lifted verbatim out of the tail of [_startRtkMedia] so that a
  /// provider error arriving AFTER a successful join (but before the call ever
  /// connected) lands in exactly the same place a failed join does, instead of
  /// being left to the 45s connect watchdog — which would end a recoverable
  /// call with 'network-error'.
  ///
  /// Fallback is unconditional past the guard: tell the peer so it stops
  /// waiting on a meeting we are never joining. Only the decider re-offers,
  /// exactly as `sfu-abort` does, so the two phones cannot both offer.
  Future<void> _fallbackFromRtk() async {
    if (_ended || _connected) return;
    if (_remoteId != null) _send({'type': 'rtk-abort', 'to': _remoteId});
    if (_rtkDecider) {
      if (RemoteConfig.callSfuV1 && !_sfuAborted) {
        _sfuDecider = true;
        _send({'type': 'sfu-start', 'to': _remoteId});
        await _startSfuMedia();
      } else {
        await _startP2pOffer();
      }
    }
  }

  /// [CALL-RTK-4] Cancel the RTK event subscription. Called from every site
  /// that drops `_rtk`, so a dead session's stream can never call back into a
  /// call that has moved on.
  Future<void> _cancelRtkEvents() async {
    final sub = _rtkEvents;
    _rtkEvents = null;
    if (sub != null) await _safeAwait(() => sub.cancel());
  }

  /// [CALL-RTK-4] The RTK leg's equivalent of `pc.onTrack` / `pc.onConnectionState`.
  void _onRtkEvent(RtcSessionEvent e) {
    if (_ended || !_rtkActive) return;
    switch (e) {
      case RtcSessionEvent.audioTrackAdded:
        // Remote AUDIO media is flowing. This is the closest analogue
        // RealtimeKit has to `pc.onTrack`, and it is the signal we PREFER,
        // because it carries the same meaning: the other side is actually
        // publishing audio.
        _onRtkConnected('remote_track_audio');
        // [CALL-RTK-4] First audio, the cheapest honest way. The pc-stats probe
        // (`_startFirstAudioProbe`) cannot run here — it reads
        // `pc.getStats()` and there is no `_pc` on this path — and
        // realtimekit_core 0.1.6 exposes no byte counters, so `bytes_received`
        // stays at its -1 "unknown" sentinel rather than being invented. The
        // timestamp is real: it is the instant the SDK told us the remote's
        // audio went live. Gated by the same flag as the pc probe so the
        // event's population stays consistent across paths.
        if (RemoteConfig.callFirstAudioProbeV1 && !_firstAudioReported) {
          _reportFirstAudio(bytes: -1, outcome: 'audio');
        }
        break;
      case RtcSessionEvent.videoTrackAdded:
        // [CALL-AUDIBLE-2 2026-08-18] A remote VIDEO track proves the other
        // side is present/publishing (so `_onRtkConnected` still runs — that
        // is the same "connected" meaning `remoteJoin` below carries), but it
        // must NEVER satisfy the AUDIO milestone: no `_reportFirstAudio` call
        // here. Previously this arm was merged with audioTrackAdded above
        // (both fired the same generic `trackAdded`), so a video-only update
        // could flip `audioFlowing`/`audibleReady` on evidence that never
        // touched an audio decoder. RTK is disabled in production today, so
        // this was latent, not an observed incident.
        _onRtkConnected('remote_track_video');
        break;
      case RtcSessionEvent.remoteJoin:
        // Backstop for the case `trackAdded` cannot cover: RealtimeKit's
        // `onAudioUpdate` fires on a CHANGE, so a peer that was already
        // publishing before we joined may never produce one. Roster presence
        // is weaker evidence than media, hence second — but it is far better
        // than letting the ring timeout hand a live conversation to Ava.
        _onRtkConnected('remote_join');
        break;
      case RtcSessionEvent.error:
        // BEFORE connect: this is a failed join in slow motion; route it into
        // the same abort/fallback the join failure takes.
        // AFTER connect: leave it alone. Reconnection is the SDK's job on this
        // path (that is the whole point of the migration) and it reports the
        // outcome itself via `call_network_handover`.
        if (!_connected && !_rtkAborted) {
          // ignore: unawaited_futures
          _onRtkErrorBeforeConnect();
        }
        break;
      default:
        break;
    }
  }

  /// [CALL-RTK-4] Everything `pc.onTrack`'s connected block does, for the RTK
  /// leg. Idempotent (`_connected` is the latch) and inert once the call has
  /// ended or fallen back.
  void _onRtkConnected(String via) {
    if (_ended || _connected || _rtkAborted || !_rtkActive) return;
    _ringTimeout?.cancel();
    _connectWatchdog?.cancel(); // [CALL-CONNECT-WATCHDOG-1]
    _connectWatchdogFast?.cancel(); // [AVACALL-WATCHDOG-2]
    _failTimer?.cancel();
    _ringback.stop();
    // [AVA-PREWARM-1] The callee answered for real — a pre-warmed receptionist
    // session (if any) was never heard and must never surface.
    if (_prewarmCall != null) {
      // ignore: unawaited_futures
      _abortPrewarm('callee_answered');
    }
    // [CALL-RTK-4] `connected` takes a NULLABLE pc (`_probeIceType` returns
    // immediately on null), so this is safe with no peer connection — and it is
    // what sets `_tConnected`, i.e. what makes `call_ended` carry
    // `connected=true`, a real `duration_s` and a real `minutes_used` instead of
    // reporting every RTK call as a zero-length setup failure. It does emit a
    // second `call_connected` (the provider already emits one at join, carrying
    // `provider=realtimekit`); the two are separable by that property and the
    // CALL-RTK-3 assertion filters on it.
    _telemetry.connected(null);
    _telemetry.setMediaPath('rtk');
    // [CALL-AUDIBLE-1] Haptic moved to `_markAudibleReady` — see that
    // method's doc comment. Everything else in this block is untouched.
    if (gOutgoingCallId == config.room) {
      gOutgoingCallTo = null;
      gOutgoingCallId = null;
      gOutgoingSince = 0;
    }
    _connected = true;
    // [CALL-LOG-TIME-1] Talk time starts at first remote media, not at dial.
    if (_connectedAtMs == 0)
      _connectedAtMs = DateTime.now().millisecondsSinceEpoch;
    peerAway.value = false;
    _setPhase('connected');
    _stage('rtk_connected');
    // [CALL-RTK-4] DELIBERATELY NOT STARTED HERE: `_startMediaWatchdog` and
    // `_startPlayoutHealthSampler` both poll `_pc.getStats()`, and the RTK path
    // has no `_pc` — every tick would return at the `pc == null` guard, i.e. a
    // timer that can only ever produce silence. Rather than a fake watchdog,
    // RTK relies on the provider's own socket-state monitoring, which reports
    // its verdict as `call_network_handover` (outcome survived|failed) from
    // `realtimekit_provider.dart`, plus the `error` arm above. Do not "fix"
    // this by starting the watchdog; fix it by giving the provider a real
    // stats surface first.
    Analytics.capture('call_rtk_connected', {
      'call_id': config.room,
      'via': via, // 'remote_track' | 'remote_join'
      'outgoing': config.outgoing,
      'video': config.video,
      'ms_from_start':
          _setupT0 == 0 ? -1 : DateTime.now().millisecondsSinceEpoch - _setupT0,
    });
    _armAudibleGate(); // [CALL-AUDIBLE-1]
  }

  /// [CALL-RTK-4] A provider error before the call ever connected: leave the
  /// meeting and fall back, exactly as a failed join would.
  Future<void> _onRtkErrorBeforeConnect() async {
    if (_ended || _connected || _rtkAborted) return;
    _rtkAborted = true;
    _rtkActive = false;
    await _cancelRtkEvents();
    await _safeAwait(() => _rtk?.leave());
    _rtk = null;
    Analytics.capture('call_rtk_fallback', {
      'call_id': config.room,
      'failure': 'provider_error_before_connect',
    });
    await _fallbackFromRtk();
  }

  /// [CALL-PREJOIN-1 2026-08-16] Construct a fresh SFU transport wired to this
  /// session's `_newPC`, telemetry callbacks and RED/parallel-boot flags.
  /// Factored out of `_startSfuMedia` so the CALLER's ring-time pre-join
  /// (`_maybeStartCallerPrejoin`) and the normal cold-start path build the
  /// transport through the exact same construction and can never drift.
  CallSfuTransport _buildSfuTransport({bool isolatedPc = false}) {
    return CallSfuTransport(
      room: room,
      // [CALL-PREJOIN-ISOLATE-1] The ring-time pre-join builds an ISOLATED
      // connection and remembers it, so adoption can promote it and discard
      // can retire it — both by identity, never by touching `_pc` blindly.
      createPeerConnection: (iceServers) async {
        final pc = await _newPC(sfuIce: iceServers, isolated: isolatedPc);
        if (isolatedPc) _prejoinPc = pc;
        return pc;
      },
      configurePeerConnection: (pc) async {
        await _applyVideoCodecPreference(pc);
        await _preferResolutionOnVideo(pc, cellular: await _isLikelyCellular());
      },
      installAdoptedPeerConnection: _installAdoptedSfuPc,
      // [CALL-MEDIA-540P-1] Same flag the P2P tuner reads, so RED does not
      // switch itself off the moment a call lands on the SFU instead.
      enableRed: RemoteConfig.callAudioRedExperimentV1,
      // [CALL-RED-SFU-OBS-1 2026-08-06] Same event, same shape and same
      // `applied` semantics as the P2P emit in [_tuned], plus `path` so the two
      // are separable. Without this, RED engagement was invisible on the path
      // that carries every production 1:1 call.
      onRedNegotiated: (applied, sdpType) {
        Analytics.capture('call_audio_red_negotiated', {
          'call_id': config.room,
          'applied': applied,
          'distance': audio_tuning.kOpusRedDistance,
          'sdp_type': sdpType,
          'path': 'sfu',
        });
      },
      // [CALL-DEADAIR-1] Per-rung timings for `call_first_audio_ms`, and the
      // overlapped peer-seat poll. Both are inert when the flag is off.
      onStage: (name) {
        _stage(name);
        if (name == 'sfu_peer_wait_rearmed') {
          Analytics.capture('call_sfu_peer_wait_rearmed', {
            'call_id': config.room,
            'reason': 'early_poll_expired_before_accept',
          });
        }
      },
      // [CALL-SFU-DUPAUDIO-1 2026-08-09] A repull now mutes the audio sections
      // it supersedes (2026-08-08 double-voice "echo" on both phones after a
      // handover dual-rejoin). `count > 0` here IS the bug happening and being
      // contained: the peer's old track was still audible when the new one
      // arrived.
      onStaleAudioMuted: (count) {
        Analytics.capture('call_sfu_stale_audio_muted', {
          'call_id': config.room,
          'count': count,
        });
      },
      // [CALL-VIDEO-FIX-1 2026-08-17] One completed pass through the
      // transport's negotiation queue (`_serialize`) — `queued_ms` is time
      // spent waiting behind a previous negotiation, `ran_ms` is the op's
      // own duration, `ok` is false on any exception or the 15s per-op
      // timeout. This is the observable proof the queue exists and is doing
      // something, not just that the freeze fix compiled.
      onNegotiation: (op, queuedMs, ranMs, ok) {
        Analytics.capture('call_sfu_negotiation', {
          'call_id': config.room,
          'op': op,
          'queued_ms': queuedMs,
          'ran_ms': ranMs,
          'ok': ok,
        });
      },
      overlapPeerWait: RemoteConfig.callSetupParallelBootV1,
    );
  }

  /// Wire the one canonical PC that was negotiated by CallPrewarm while the
  /// app was foregrounded. No media has existed on it; this is the accept-time
  /// handoff that makes it the CallSession-owned connection.
  void _installAdoptedSfuPc(RTCPeerConnection pc) {
    final myPcGen = ++_pcGeneration;
    _resetPlayoutHealthBaselines();
    _pc = pc;
    pc.onTrack = (e) => _handleRemoteTrack(pc, myPcGen, e);
    pc.onConnectionState = (s) => _handleConnectionState(pc, s);
  }

  /// [CALL-PREJOIN-1 2026-08-16] P2 of Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md.
  /// The CALLER already consented (they placed the call) — join the SFU and
  /// PUBLISH audio while the callee's phone is still ringing, so the callee's
  /// first pull finds a live track immediately at accept instead of both
  /// sides waiting on each other (measured 2-4s on 2026-08-16). Pre-join
  /// runs for BOTH audio and video calls, but only the AUDIO track is
  /// published during the ring — a video call's camera track publishes AFTER
  /// accept, exactly like today's mid-call camera-on upgrade
  /// (`_enableSfuVideo` / `CallSfuTransport.publishVideo`).
  ///
  /// Fire-and-forget by design: a slow or failed pre-join must never delay or
  /// affect the ring UI or ringback. `_startSfuMedia` adopts the seat when the
  /// peer-join election actually lands on SFU; every other outcome (RTK, P2P,
  /// `sfu-abort`, hangup while ringing) discards it via
  /// [_discardPrejoinedSfu] — see that method for why disposal must run
  /// BEFORE the P2P/RTK path builds anything of its own.
  ///
  /// Hooked only from authoritative placement completion
  /// ([notePlaceResult]/[notePrewarming]) or a positive server ring ack
  /// ([_applyRingAck]). A CallRoom `welcome` proves only that our signalling
  /// socket opened; it does NOT prove `/api/call` has recorded the participants,
  /// so starting from `welcome` can race placement and receive
  /// `403 not_a_participant`. The placement trigger is intentionally earlier
  /// than the ring-ack backstop, and [_prejoinStarted] keeps both idempotent.
  void _maybeStartCallerPrejoin() {
    if (_prejoinStarted) return;
    if (_ended || _connected) return;
    if (!config.outgoing) return;
    if (!RemoteConfig.callSfuV1 || !RemoteConfig.callerPrejoinOnRingV1) return;
    final stream = _stream;
    if (stream == null) return;
    if (_prejoinedSfu != null || _sfu != null || _sfuStarting || _sfuActive)
      return;
    _prejoinStarted = true;
    final callId = config.room;
    final swStart = DateTime.now().millisecondsSinceEpoch;
    try {
      Analytics.capture('call_prejoin_started', {'call_id': callId});
    } catch (_) {/* telemetry must never affect the ring path */}
    final transport = _buildSfuTransport(isolatedPc: true);
    _prejoinedSfu = transport;
    final future = transport.connectPublish(
      localStream: stream,
      fallbackIceServers: _ice,
      // Audio only during the ring — see the doc comment above.
      video: false,
    );
    _prejoinPublishFuture = future;
    future.then((failure) {
      // Superseded by an adopt/discard while this was mid-flight — whichever
      // site did that already owns this transport's teardown; touching it
      // again here would be a double-dispose or a resurrected seat.
      if (!identical(_prejoinedSfu, transport)) return;
      if (failure != null) {
        try {
          Analytics.capture('call_prejoin_failed', {
            'call_id': callId,
            'detail': failure.detail ?? failure.failure?.name ?? 'unknown',
          });
        } catch (_) {/* telemetry must never affect the ring path */}
        return;
      }
      try {
        Analytics.capture('call_prejoin_published', {
          'call_id': callId,
          'ms': DateTime.now().millisecondsSinceEpoch - swStart,
        });
      } catch (_) {/* telemetry must never affect the ring path */}
    }).catchError((Object e) {
      try {
        Analytics.capture(
            'call_prejoin_failed', {'call_id': callId, 'detail': e.toString()});
      } catch (_) {/* telemetry must never affect the ring path */}
    });
  }

  /// [CALL-PREJOIN-1 2026-08-16] Tear down an un-adopted caller pre-join —
  /// decline/timeout is not this side's concern (that's `CallPrewarm`, the
  /// CALLEE's half); this fires when the election landed on something other
  /// than SFU, or the call ended while still ringing. Safe to call any number
  /// of times: the second and later calls see `_prejoinedSfu == null` and
  /// no-op.
  ///
  /// [CALL-PREJOIN-ISOLATE-1 2026-08-17] It is still called before
  /// `_startP2pOffer()` and `case 'offer':`, but for RESOURCE reasons now, not
  /// correctness: an un-promoted pre-join no longer assigns `_pc`, so it can no
  /// longer poison `_startP2pOffer`'s `_pc != null` guard or hand a P2P offer
  /// to the SFU connection. (That WAS the pre-isolation hazard, and it was
  /// real: prod avatok-a0170dc6.) What remains is that a dead pre-join holds an
  /// SFU seat and an open PeerConnection until this runs.
  ///
  /// `_retirePc` is the same detach-then-close primitive `_startSfuMedia`'s own
  /// cold-path failure branch uses; it clears `_pc` only when the retired
  /// connection IS `_pc`, i.e. only when this pre-join had been promoted.
  Future<void> _discardPrejoinedSfu(String reason) async {
    final t = _prejoinedSfu;
    if (t == null) return;
    _prejoinedSfu = null;
    _prejoinPublishFuture = null;
    try {
      Analytics.capture(
          'call_prejoin_discarded', {'call_id': config.room, 'reason': reason});
    } catch (_) {/* telemetry must never affect call setup */}
    // [CALL-PREJOIN-ISOLATE-1 2026-08-17] Retire the PRE-JOIN's connection, by
    // identity — never `_pc`. Before isolation `_pc` WAS the pre-join's PC (the
    // bug), so retiring `_pc` happened to work; now the two are different
    // objects until promotion and retiring `_pc` would close the LIVE call's
    // connection. `_retirePc` clears `_pc` only when it is the same object,
    // which is exactly right for the promoted case.
    final pc = _prejoinPc;
    _prejoinPc = null;
    _prejoinEarlyTracks.clear();
    _prejoinPromoted = false;
    await _retirePc(pc);
    await _safeAwait(() => t.dispose());
  }

  Future<void> _startSfuMedia() async {
    if (_ended || _connected || _sfuStarting || _sfuActive || _sfuAborted)
      return;
    final stream = _stream;
    if (stream == null) return;
    _connectWatchdogFast?.cancel();
    _connectWatchdogFast = null;
    _sfuStarting = true;
    if (config.video && !RemoteConfig.callSfuAudioOnly) {
      remoteVideoActive.value = false;
      remoteVideoStatus.value = 'waiting';
    }
    _stage('sfu_begin'); // [CALL-DEADAIR-1]
    // [CALL-PREJOIN-1 2026-08-16] Adopt OUR OWN ring-time pre-join, if one is
    // in flight/ready — awaits `_prejoinPublishFuture` in case accept beat the
    // publish to finish. A failed publish is discarded here and this falls
    // through to the normal cold path below, so a failed prejoin is never
    // visible to the callee.
    CallSfuTransport? adoptedPrejoin;
    if (_prejoinedSfu != null) {
      final pre = _prejoinedSfu!;
      CallSfuResult? publishFailure;
      try {
        publishFailure =
            await (_prejoinPublishFuture ?? Future<CallSfuResult?>.value(null));
      } catch (e) {
        publishFailure =
            CallSfuResult.failed(SfuFailure.unknown, detail: e.toString());
      }
      // Only claim ownership if nothing else raced us to it while awaiting.
      if (identical(_prejoinedSfu, pre)) {
        _prejoinedSfu = null;
        _prejoinPublishFuture = null;
        if (publishFailure == null) {
          adoptedPrejoin = pre;
          Analytics.capture('call_prejoin_adopted', {'call_id': config.room});
          // [CALL-PREJOIN-ISOLATE-1 2026-08-17] The call is genuinely being
          // answered now, so the pre-join's connection becomes the session's
          // live one — `_pc` assigned, playout baselines reset, and any track
          // that arrived during the ring replayed through the normal handler.
          // Must run BEFORE `connectPull` below: the pull's own track events
          // arrive on this PC and have to take the live path, not the cache.
          _promotePrejoinPc();
        } else {
          Analytics.capture('call_prejoin_discarded', {
            'call_id': config.room,
            'reason': 'publish_failed',
          });
          await _safeAwait(() => pre.dispose());
        }
      }
    }
    // [CALL-PREWARM-1 2026-08-16] Adopt a pre-warmed join (ICE fetch +
    // `/callsfu/join` seat), if one was started at ring time by
    // `CallPrewarm.start` (see push_service.dart's incoming-call handler).
    // `adopt` itself enforces the flag, the 60s freshness window and the
    // exactly-once contract, and NEVER throws — if it returns null this is
    // byte-for-byte today's cold-start behaviour. Deliberately not called
    // from `reconnect()` — a network-recovery join must always be current,
    // never a stale pre-ring seat. Mutually exclusive with the caller
    // pre-join above by construction: `CallPrewarm` is armed only from the
    // CALLEE's incoming-push handler, never on an outgoing call.
    CallPrewarmedData? prewarmed;
    if (adoptedPrejoin == null &&
        (RemoteConfig.callPrewarmOnRingV1 ||
            RemoteConfig.callSilentTransportPrewarmV1)) {
      try {
        // [CALL-PREROLL-1 2026-08-17] `currentStream` lets `adopt` compare it,
        // by identity, against whatever `CallPrewarm` itself pre-rolled — the
        // only way it can safely hand back a fully pre-rolled transport
        // (publish AND pull already done) without risking a mismatched local
        // stream. See `CallPrewarm.adopt`'s doc comment.
        prewarmed = await CallPrewarm.instance.adopt(
          config.room,
          nonce: config.prewarmNonce,
          generation: config.prewarmGeneration,
          networkIdentity: config.prewarmNetworkIdentity.isEmpty
              ? null
              : config.prewarmNetworkIdentity,
          currentStream: stream,
        );
      } catch (_) {/* prewarm must never affect call setup */}
    }
    final prewarmedIce =
        prewarmed?.iceServers ?? const <Map<String, dynamic>>[];
    // [CALL-PREROLL-1] True only when `CallPrewarm` pre-rolled THIS exact
    // stream all the way through publish+pull during the ring. A video call
    // never qualifies (the boot sequence never peeks a preroll stream for
    // one — see `_bootMedia`), and neither does a preroll that lost the race
    // with an unusually fast accept; both fall straight through to the
    // join-only or fully-cold paths below exactly as before this change.
    final hasFullPreroll = adoptedPrejoin == null &&
        RemoteConfig.callPrerollV1 &&
        (prewarmed?.hasFullPreroll ?? false);
    final hasPrepublishedAudio =
        adoptedPrejoin == null && (prewarmed?.hasPrepublishedAudio ?? false);
    final transport = adoptedPrejoin ??
        (hasFullPreroll ? prewarmed!.prerollTransport! : _buildSfuTransport());
    _sfu = transport;
    CallSfuResult result;
    try {
      if (adoptedPrejoin != null) {
        result = await transport.connectPull(
          video: config.video && !RemoteConfig.callSfuAudioOnly,
        );
      } else if (hasFullPreroll) {
        // [CALL-PREROLL-1] Publish AND pull already happened during the ring
        // — re-running either here would be a second, redundant negotiation
        // on an already-live SFU session. Promote the connection (installs
        // the handlers it never had while un-promoted, unmutes and replays
        // its cached remote track through the normal connect ladder — see
        // `_promotePrerollPc`) and synthesize the same success result
        // `connectPull` would have returned. The LOCAL mic track was already
        // unmuted in `_bootMedia` at the moment it adopted this same stream
        // via `CallPrewarm.instance.peek` — not repeated here, so there is
        // exactly one place that flips it, not two.
        final pc = prewarmed!.prerollPc!;
        _promotePrerollPc(pc, prewarmed.prerollEarlyTracks);
        result = CallSfuResult.ok(
          pc,
          sessionId: transport.sessionId ?? '',
          relayDegraded: false,
          videoRequested: false,
          peerVideoAvailable: false,
          videoConnected: false,
        );
      } else if (hasPrepublishedAudio) {
        final adopted = await transport.adoptPrewarmedPublish(
          join: prewarmed!.join!,
          pc: prewarmed.transportPc!,
          audioSender: prewarmed.transportAudioSender!,
          audioMid: prewarmed.transportAudioMid!,
          audioTrackName: prewarmed.transportAudioTrackName!,
        );
        if (!adopted) {
          result = CallSfuResult.failed(
            SfuFailure.publishFailed,
            detail: 'prewarm_adopt_failed',
          );
        } else if (!await _ensureAcceptedAudio(transport: transport)) {
          result = CallSfuResult.failed(
            SfuFailure.publishFailed,
            detail: 'prewarm_audio_replace_failed',
          );
        } else {
          // The null-track section was published before Accept. Pull only
          // after the sender has been replaced with the real microphone.
          result = await transport.connectPull(
            video: config.video && !RemoteConfig.callSfuAudioOnly,
          );
        }
      } else {
        result = await transport.connect(
          localStream: stream,
          // [CALL-PREWARM-1] Prefer the ICE servers the prewarm fetch already
          // brought back — they are at least as fresh as `_ice` and mean this
          // call never blocks on the ICE round trip that `_fetchIce()` would
          // otherwise still be doing. Falls back to `_ice` exactly as before
          // when there was nothing to adopt.
          fallbackIceServers: prewarmedIce.isNotEmpty ? prewarmedIce : _ice,
          video: config.video && !RemoteConfig.callSfuAudioOnly,
          prewarmedJoin: prewarmed?.join,
          prewarmedPc: prewarmed?.transportPc,
        );
      }
    } catch (e, st) {
      // The transport normally converts failures into CallSfuResult, but a
      // provider/plugin exception must not strand `_sfuStarting` forever and
      // suppress every later recovery attempt.
      _sfuStarting = false;
      _sfuAborted = true;
      await transport.dispose();
      _sfu = null;
      Analytics.capture('call_sfu_fallback', {
        'call_id': config.room,
        'failure': 'transport_exception',
        'detail': e.toString(),
      });
      _telemetry.runtimeError(
          stage: 'sfu_transport_exception', error: e, stack: st);
      if (_remoteId != null) _send({'type': 'sfu-abort', 'to': _remoteId});
      if (_sfuDecider) await _startP2pOffer();
      return;
    }
    if (_ended) {
      await transport.dispose();
      return;
    }
    if (result.connected) {
      _sfuStarting = false;
      _sfuActive = true;
      _resetPlayoutHealthBaselines();
      _pc = result.pc;
      await _preferResolutionOnVideo(_pc!, cellular: await _isLikelyCellular());
      _telemetry.setMediaPath('sfu');
      Analytics.capture('call_sfu_active', {
        'call_id': config.room,
        'video': config.video && !RemoteConfig.callSfuAudioOnly,
        'relay_degraded': result.relayDegraded,
        'video_requested': result.videoRequested,
        'video_negotiated': result.videoConnected,
      });
      if (result.videoRequested && !result.videoConnected) {
        remoteVideoStatus.value = 'unavailable';
        Analytics.capture('call_video_negotiation_failed', {
          'call_id': config.room,
          'stage': 'initial_pull',
          'reason': result.peerVideoAvailable
              ? 'video_pull_failed'
              : 'peer_video_unavailable',
          'path': 'sfu',
        });
      }
      // [CALL-PREJOIN-1 2026-08-16] The prejoin only ever published AUDIO
      // (see `_maybeStartCallerPrejoin`) — publish our own camera track now
      // for a video call, exactly like today's mid-call camera-on upgrade
      // (`_enableSfuVideo` → `CallSfuTransport.publishVideo`), just triggered
      // by adoption instead of a user tap. `_stream` already carries the
      // video track for an outgoing video call (acquired in `_bootMedia`).
      if (adoptedPrejoin != null &&
          config.video &&
          !RemoteConfig.callSfuAudioOnly) {
        final cam = stream.getVideoTracks();
        if (cam.isNotEmpty) {
          final ok = await transport.publishVideo(cam.first, stream);
          if (ok) {
            if (_remoteId != null)
              _send({'type': 'sfu-video', 'to': _remoteId});
            Analytics.capture('call_sfu_video_upgraded', {
              'call_id': config.room,
              'via': 'prejoin_adopt',
            });
          } else {
            Analytics.capture('call_sfu_video_publish_failed', {
              'call_id': config.room,
              'via': 'prejoin_adopt',
            });
          }
        }
      }
      // [CALL-SFU-REPULL-1] Drain a peer re-pull that arrived while we were
      // still setting up. `_sfuPeerRepullPending` is set whenever `sfu-rejoined`
      // lands with `_sfuActive` false, which includes this initial-join window
      // and any abort/re-start cycle — draining it only in [_reconnectSfu] would
      // leave those cases permanently one-way.
      if (_sfuPeerRepullPending) {
        _sfuPeerRepullPending = false;
        await _repullPeerMedia('deferred_initial_join');
      }
      return;
    }

    _sfuStarting = false;
    _sfuAborted = true;
    await transport.dispose();
    _sfu = null;
    // [CALL-PCRETIRE-1] Detach before closing — see [_retirePc]. The previous
    // close-then-null ordering let this PC's own `Closed` callback run while it
    // was still `_pc`.
    await _retirePc(_pc);
    Analytics.capture('call_sfu_fallback', {
      'call_id': config.room,
      'failure': result.failure?.name ?? 'unknown',
      'detail': result.detail ?? '',
    });
    if (_remoteId != null) _send({'type': 'sfu-abort', 'to': _remoteId});
    if (_sfuDecider) await _startP2pOffer();
  }

  /// Rejoin the Cloudflare SFU after this phone's network leg moved.
  ///
  /// [retry] is set only by [_scheduleSfuReconnectRetry]. A retry runs with
  /// `_sfuActive == false` (the previous attempt cleared it), so without this
  /// the guard below would swallow every scheduled attempt and the ladder added
  /// by [CALL-SFU-SURVIVE-1] would be inert — the same shape of bug as the
  /// [CALL-RED-1] empty `if` body.
  Future<void> _reconnectSfu({bool retry = false}) async {
    if (_ended || _sfuReconnectInFlight || _sfu == null || _stream == null)
      return;
    if (!_sfuActive && !retry) return;
    _sfuReconnectInFlight = true;
    _sfuStarting = true;
    _sfuActive = false;
    _resetPlayoutHealthBaselines();
    _setPhase('reconnecting');
    // [CALL-SFU-MBB-1 2026-08-06] Do NOT close the outgoing PC here.
    //
    // It used to be closed before the rejoin even started, which left `_pc` null
    // for the whole attempt — several seconds during which `_applyAudioBitrate`,
    // the stats poll, mute and the translate bridge all no-op'd against nothing,
    // and (before [CALL-PCRETIRE-1]) the close itself ended the call. Holding it
    // until the replacement exists also lets the jitter buffer keep playing out
    // whatever it still has instead of cutting to silence instantly.
    //
    // HONEST LIMIT: this narrows the dead-air window, it does not remove it.
    // `CallSfuTransport.reconnect()` still disposes the old Cloudflare SEAT
    // before minting the new one, so the old PC has nothing left to receive
    // shortly after this point. True make-before-break needs two concurrent
    // seats in the same room, which is a server-side contract change and needs
    // a two-device test — do not fake it by reordering these lines alone.
    final oldPc = _pc;
    try {
      final result = await _sfu!.reconnect(
        localStream: _stream!,
        fallbackIceServers: _ice,
        video: config.video && !RemoteConfig.callSfuAudioOnly,
      );
      if (_ended) {
        // Retire BOTH. `CallSfuTransport.connect()` builds its PC through
        // `_newPC`, which assigns `_pc` as a side effect — so by now `_pc` is
        // the NEW connection, and retiring only `oldPc` would leak a live
        // PeerConnection past hangup.
        //
        // Snapshot `_pc` BEFORE the first await: `_retirePc` awaits `close()`,
        // and an inbound `offer` handled in that gap can install a brand-new,
        // live `_pc` that the second call would then close.
        final failedPc = identical(_pc, oldPc) ? null : _pc;
        await _retirePc(oldPc);
        await _retirePc(failedPc);
        return;
      }
      if (result.connected) {
        _resetPlayoutHealthBaselines();
        // Retire the old PC only now that a replacement exists. Order matters:
        // `_pc` must already point at the new connection so [_retirePc]'s
        // identity check leaves it alone.
        _pc = result.pc;
        if (!identical(oldPc, result.pc)) await _retirePc(oldPc);
        _sfuActive = true;
        // Read the counter BEFORE resetting it — reporting it afterwards would
        // pin `attempt` at 0 and make the ladder look like it never ran.
        final attemptNo = _sfuRetries;
        _sfuRetries = 0; // success resets the ladder, as on the P2P path
        _sfuRetryTimer?.cancel();
        _sfuRetryPending = false;
        _setPhase('connected');
        Analytics.capture('call_sfu_reconnected', {
          'call_id': config.room,
          'relay_degraded': result.relayDegraded,
          'attempt': attemptNo,
        });
        // [CALL-SFU-REPULL-1 2026-08-06] Tell the peer we are back on a NEW
        // session so it re-pulls our audio.
        //
        // Track names are namespaced by session id — `audio-$sid` — and
        // `reconnect()` mints a new sid, so after a rejoin the peer is still
        // pulling a track name that no longer exists. Nothing signalled it to
        // do otherwise: the only re-pull trigger was `sfu-video`. The result is
        // a "successful" recovery in which we hear them and they hear silence,
        // permanently, with no error event anywhere — indistinguishable from a
        // quiet caller until someone hangs up. Same class of defect as the
        // group-call track-name trap found on 2026-08-03.
        // Addressed when we know the peer, broadcast otherwise: `_remoteId` is
        // null for the first joiner until `welcome`/`offer` populates it, and a
        // silent `if (_remoteId != null)` drop would make this fix work in only
        // one direction. In a 1:1 room a broadcast reaches exactly one peer.
        _send({'type': 'sfu-rejoined', if (_remoteId != null) 'to': _remoteId});
        // [CALL-SFU-REPULL-1] Drain a re-pull request that arrived while we
        // were ourselves mid-rejoin. A dual handover — both legs flapping,
        // which is the common case on a moving phone — otherwise loses the
        // peer's `sfu-rejoined` to the `_sfuActive` guard in the handler, and
        // that direction stays silent for the rest of the call.
        if (_sfuPeerRepullPending) {
          _sfuPeerRepullPending = false;
          await _repullPeerMedia('deferred_dual_rejoin');
        }
      } else {
        Analytics.capture('call_sfu_reconnect_failed', {
          'call_id': config.room,
          'failure': result.failure?.name ?? 'unknown',
          'attempt': _sfuRetries,
        });
        // Snapshot before awaiting — see the `_ended` branch above.
        final failedPc = identical(_pc, oldPc) ? null : _pc;
        await _retirePc(oldPc);
        await _retirePc(failedPc); // the failed replacement
        // [CALL-SFU-SURVIVE-1 2026-08-06] A failed rejoin is NOT terminal.
        //
        // This was `_endWith('ended', reason: 'sfu-reconnect-failed')` — one
        // attempt, then hang up. Because `callSfuV1` is true in production,
        // every 1:1 call takes this path, which meant the whole [CALL-SURVIVE-1]
        // apparatus (backoff ladder, `callRecoveryMaxAttempts`,
        // `callRecoveryDeadlineSec`, relay migration) was dead code on the only
        // path that carries real calls. The 2026-08-06 session shows it: two
        // network handovers, zero `call_recovery_*` events of any kind.
        _scheduleSfuReconnectRetry(result.failure?.name ?? 'unknown');
      }
    } catch (e, st) {
      // [CALL-SFU-SURVIVE-1] `reconnect()` awaits `dispose()` OUTSIDE the broad
      // try/catch inside `connect()`, so a failing `CallSfuApi.close` throws
      // straight through here. Before the ladder existed that only skipped a
      // hangup; now it would skip the RETRY too and strand the call in
      // `reconnecting` with a dead PC and nothing scheduled — a silent hang
      // rather than a recoverable failure. Treat a throw exactly as a failed
      // result.
      _telemetry.runtimeError(
          stage: 'sfu_reconnect_threw', error: e, stack: st);
      // Snapshot before awaiting — see the `_ended` branch above.
      final failedPc = identical(_pc, oldPc) ? null : _pc;
      await _retirePc(oldPc);
      await _retirePc(failedPc);
      if (!_ended) _scheduleSfuReconnectRetry('threw');
    } finally {
      _sfuStarting = false;
      _sfuReconnectInFlight = false;
    }
  }

  /// [CALL-SFU-REPULL-1 2026-08-06] Re-pull the peer's media because their SFU
  /// session id changed. See [CallSfuTransport.pullPeerAudio] for why nothing
  /// else can detect this: the old track name simply stops resolving, with no
  /// error on either side.
  Future<void> _repullPeerMedia(String why) async {
    final sfu = _sfu;
    if (_ended || !_sfuActive || sfu == null) return;
    final okAudio = await sfu.pullPeerAudio();
    Analytics.capture('call_sfu_peer_repulled', {
      'call_id': config.room,
      'why': why,
      'audio_ok': okAudio,
    });
    // Video is best-effort: the peer may simply not have a camera on, and a
    // failure here must never take audio down with it.
    if (_video || config.video) {
      final okVideo = await sfu.pullPeerVideo();
      Analytics.capture('call_sfu_peer_video_repulled', {
        'call_id': config.room,
        'why': why,
        'video_ok': okVideo,
      });
      // A rejoin signal and the SFU seat can become visible in either order.
      // One bounded retry closes that ordering gap without keeping a timer
      // alive for the rest of the call.
      if (!okVideo && !_ended) {
        unawaited(Future<void>.delayed(const Duration(seconds: 2), () async {
          if (_ended || !_sfuActive || !identical(_sfu, sfu)) return;
          final retried = await sfu.pullPeerVideo();
          Analytics.capture('call_sfu_peer_video_repull_retry', {
            'call_id': config.room,
            'why': why,
            'video_ok': retried,
          });
        }));
      }
    }
  }

  /// [CALL-SFU-SURVIVE-1 2026-08-06] The SFU half of the survival ladder.
  ///
  /// Mirrors [_scheduleSurvivalRetry] — same `_kSurvivalBackoffSec` rungs, same
  /// `callRecoveryMaxAttempts` cap, same never-terminal contract — but keeps its
  /// OWN `_sfuRetries` counter and `_sfuRetryTimer` (the field docs explain why
  /// sharing them is a bug) and drives [_reconnectSfu] instead of the P2P
  /// ICE-restart coordinator. It cannot reuse [_scheduleSurvivalRetry] directly:
  /// that method returns immediately when `_sfuActive || _sfuStarting ||
  /// _sfuReconnectInFlight`, which is precisely the state an SFU call is in.
  ///
  /// Exhaustion leaves the call alive in `reconnecting`, exactly as on the P2P
  /// path: the signalling-WS ladder ends a call whose peer is genuinely gone,
  /// and otherwise the users decide when to hang up.
  void _scheduleSfuReconnectRetry(String from) {
    if (_ended) return;
    // The peer has left the SFU; rejoining it can only fail. Falling back is
    // `sfu-abort`'s job, not the ladder's.
    if (_sfuAborted) return;
    if (!_connected) {
      // Narrow window: `_sfuActive` was true but `onTrack` never fired, so this
      // call never became a call. There is nothing to keep alive and nobody to
      // keep it alive FOR — ending cleanly is the honest outcome, and it is what
      // this path did before the ladder existed. Staying in `reconnecting`
      // forever would replace a clean end with a silent hang.
      _sfuRetryPending = false;
      _endWith('ended', reason: 'sfu-reconnect-failed');
      return;
    }
    _setPhase('reconnecting');
    final max = RemoteConfig.callRecoveryMaxAttempts;
    if (_sfuRetries >= max) {
      _sfuRetryPending = false;
      Analytics.capture('call_recovery_exhausted', {
        'call_id': config.room,
        'attempts': _sfuRetries,
        'last_failure': from,
        'kind': 'sfu',
      });
      return; // stay alive in `reconnecting`; no further automatic attempts
    }
    final idx = _sfuRetries.clamp(0, _kSurvivalBackoffSec.length - 1);
    _sfuRetries++;
    _sfuRetryPending = true;
    _sfuRetryTimer?.cancel();
    _sfuRetryTimer = Timer(Duration(seconds: _kSurvivalBackoffSec[idx]), () {
      _sfuRetryPending = false;
      if (_ended || !_connected) return;
      if (_sfuReconnectInFlight || _sfuStarting || _sfuActive) return;
      if (_sfu == null || _stream == null) {
        // [_reconnectSfu]'s own guard would return silently here, leaving the
        // call parked in `reconnecting` with nothing scheduled and no event.
        // Reachable via the `sfu-abort` handler (which nulls `_sfu` while we
        // were starting or active). Say so, then let the signalling-WS ladder
        // own termination as it does everywhere else.
        Analytics.capture('call_recovery_abandoned', {
          'call_id': config.room,
          'kind': 'sfu',
          'why': _sfu == null ? 'transport_gone' : 'stream_gone',
          'attempts': _sfuRetries,
        });
        return;
      }
      // ignore: unawaited_futures
      _reconnectSfu(retry: true);
    });
    Analytics.capture('call_recovery_retry_scheduled', {
      'call_id': config.room,
      'attempt': _sfuRetries,
      'delay_s': _kSurvivalBackoffSec[idx],
      'last_failure': from,
      'kind': 'sfu',
    });
  }

  /// [CALL-VIDEO-FIX-1 2026-08-17] Mid-call camera-on for the SFU path.
  ///
  /// Called only from `_restartWithVideo`, which already holds
  /// [_videoRenegoInFlight] for the duration — this function's only job is
  /// the media/publish work and reporting the result truthfully.
  /// [videoUpgrading] is cleared in `finally` so it is never left stuck on
  /// ANY exit (early return, publish failure, camera timeout, or exception).
  /// `_video`/`_camOn`/`videoActive`/`cameraOn`/`_speaker`/`speakerOn` are
  /// only ever set here on the CONFIRMED-success path — nothing sets them
  /// before `publishVideo` has actually returned `true`, so there is nothing
  /// to roll back on any failure path: they simply stay at whatever they
  /// were before this call started.
  Future<void> _enableSfuVideo() async {
    if (_ended || !_sfuActive || _sfu == null || _stream == null) {
      videoUpgrading.value = false;
      return;
    }
    MediaStreamTrack? track;
    try {
      final cellular = await _isLikelyCellular();
      MediaStream v;
      try {
        // [CALL-VIDEO-FIX-1] 8s timeout, matching the P2P upgrade path's own
        // getUserMedia idiom in spirit (that one has no explicit timeout but
        // is bounded by the same camera-acquisition reality) and the
        // existing accept-path audio getUserMedia timeout elsewhere in this
        // class. A camera that never resolves — permission dialog stuck,
        // hardware busy with another app — must not hang this upgrade (and
        // therefore `_videoRenegoInFlight`) forever.
        v = await navigator.mediaDevices.getUserMedia({
          'video': audio_tuning.avaVideoConstraints(cellular: cellular),
          'audio': false,
        }).timeout(const Duration(seconds: 8));
      } catch (e, st) {
        final timedOut = e is TimeoutException;
        _telemetry.runtimeError(
          stage: 'sfu_video_get_user_media_failed',
          error: e,
          stack: st,
          extra: {'timed_out': timedOut},
        );
        Analytics.capture('call_video_upgrade_failed', {
          'call_id': config.room,
          'reason': timedOut ? 'camera_timeout' : 'camera_failed',
        });
        return;
      }
      if (_ended || !_sfuActive || _sfu == null || _stream == null) {
        // Superseded while getUserMedia was pending (call ended, SFU
        // dropped). Nothing was ever attached to the stream or published —
        // just release the camera we just opened.
        for (final t in v.getVideoTracks()) {
          try {
            t.stop();
          } catch (_) {}
        }
        return;
      }
      track = v.getVideoTracks().first;
      await _stream!.addTrack(track);
      localRenderer.srcObject = _stream;
      final ok = await _sfu!.publishVideo(track, _stream!);
      if (!ok) {
        track.stop();
        try {
          await _stream?.removeTrack(track);
        } catch (_) {}
        track = null;
        // Nothing was set to true above, so there is nothing to roll back on
        // `_video`/`_camOn`/`videoActive`/`cameraOn` — they are exactly what
        // they were before this call started.
        Analytics.capture(
            'call_sfu_video_publish_failed', {'call_id': config.room});
        Analytics.capture('call_video_upgrade_failed', {
          'call_id': config.room,
          'reason': 'sfu_publish_failed',
        });
        return;
      }
      // NOTE: the sender limits for this new track are applied INSIDE
      // publishVideo, via `configurePeerConnection`, because they must land
      // before its offer is created. Do not re-apply them here.
      _video = true;
      _camOn = true;
      _speaker = true;
      videoActive.value = true;
      cameraOn.value = true;
      speakerOn.value = true;
      _send({'type': 'sfu-video', 'to': _remoteId});
      // [CALL-VIDEO-FIX-1] Retires the optimistic `call_sfu_video_upgraded`
      // for this path: this fires only once `publishVideo` has actually
      // returned `true` — a confirmed publish, not a tap. Remote-side
      // truthfulness (`remote_video_track_attached` /
      // `remote_video_first_frame`) lives in `_handleRemoteTrack` and the
      // renderer's first-frame callback.
      Analytics.capture('local_video_published', {'call_id': config.room});
    } catch (e, st) {
      _telemetry.runtimeError(
          stage: 'sfu_video_upgrade_failed', error: e, stack: st);
      Analytics.capture('call_video_upgrade_failed', {
        'call_id': config.room,
        'reason': 'exception',
      });
      if (track != null) {
        try {
          track.stop();
        } catch (_) {}
        try {
          await _stream?.removeTrack(track);
        } catch (_) {}
      }
    } finally {
      videoUpgrading.value = false;
    }
  }

  Future<void> _onSignal(dynamic raw) async {
    if (_receptionistActive) {
      String? t;
      try {
        t = (jsonDecode(raw as String) as Map)['type']?.toString();
      } catch (_) {}
      Analytics.capture('ava_recept_signal_suppressed', {
        'channel': 'signaling',
        if (t != null) 'type': t,
        'call_id': config.room
      });
      return;
    }
    if (_ended) return;
    // [CALL-DEADPEER-1 2026-08-03] (audit H3) ANY inbound frame proves the socket
    // is alive. Reset here, at the top, so the reset cannot be skipped by an
    // early return in one of the branches below.
    _missedPongs = 0;
    // [CALL-SIGNAL-PARSE-1 2026-08-03] (audit M4) GUARDED PARSE.
    //
    // This was a bare `jsonDecode(raw as String) as Map<String, dynamic>` inside
    // an async handler, so a malformed or unexpectedly-shaped frame did not
    // "fail to parse" — it became an UNHANDLED ASYNC ERROR, with no catch frame
    // above it because the handler is invoked by the stream, not by our code.
    // The server side of this same relay has been guarded since it was written
    // (call_room.ts wraps its JSON.parse and returns); the client half never was.
    //
    // The `as Map<String, dynamic>` cast is part of the hazard, not just the
    // decode: a well-formed JSON scalar or list parses fine and then throws on
    // the cast. Both are covered here.
    final Map<String, dynamic> d;
    try {
      final parsed = jsonDecode(raw as String);
      if (parsed is! Map<String, dynamic>) {
        Analytics.capture('call_signal_frame_malformed',
            {'call_id': config.room, 'reason': 'not_an_object'});
        return;
      }
      d = parsed;
    } catch (_) {
      Analytics.capture('call_signal_frame_malformed',
          {'call_id': config.room, 'reason': 'json_decode_failed'});
      return;
    }
    // [CALL-REDUCER-1 2026-08-01] Ring-surface cleanup for a DO-originated
    // authoritative status is delegated to the ONE reducer, which orders on
    // `seq` and drops anything stale. Only DO-stamped frames (src=='do') carry
    // a transition sequence; peer-relayed signalling frames do not and are
    // untouched here. This runs BEFORE the switch below so the ring surface is
    // torn down even if a later branch returns early.
    if ((d['src'] ?? '').toString() == 'do') {
      final st = (d['type'] ?? '').toString();
      final cid = (d['callId'] ?? config.room).toString();
      final seq = d['seq'] is int
          ? d['seq'] as int
          : int.tryParse((d['seq'] ?? '').toString());
      unawaited(applyRingTransition(cid, st, seq: seq, source: 'do_socket'));
    }
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
    final bool isPeerSignal = frameType == 'offer' ||
        frameType == 'answer' ||
        frameType == 'candidate';
    if (config.outgoing && frameFrom.isNotEmpty && isPeerSignal) {
      _onDeviceRinging();
    }
    if (d['country'] is String)
      _telemetry.setPeerCountry(d['country'] as String);
    switch (d['type']) {
      case 'welcome':
        _gotWelcome = true;
        _stage('ws_welcome'); // [CALL-DEADAIR-1]
        // CALL-GEN-1: adopt the generation the DO assigned us. On a reconnect the
        // DO bumps our gen, so this raises _gen and our subsequent frames outrank
        // any lingering old-socket frames. Absent on old servers → stays null.
        if (d['gen'] is num) _gen = (d['gen'] as num).toInt();
        _placeCallTimeout?.cancel();
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          unawaited(_refreshAndAnnounceNetClass());
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
            if (_rtkEligible && !_rtkAborted) {
              // [CALL-RTK-3] Precedence (spec §3.2): RealtimeKit → raw SFU →
              // P2P. Same announce-then-start discipline as `sfu-start`, for
              // the same reason: both phones must select ONE media transport
              // and can never silently split.
              _rtkDecider = true;
              _send({'type': 'rtk-start', 'to': _remoteId});
              await _startRtkMedia();
            } else if (RemoteConfig.callSfuV1 && !_sfuAborted) {
              // The newcomer/second socket is the existing CallRoom offerer.
              // Announce SFU before starting so both phones select one media
              // transport and can never silently split into SFU + P2P.
              _sfuDecider = true;
              _send({'type': 'sfu-start', 'to': _remoteId});
              await _startSfuMedia();
            } else {
              await _startP2pOffer();
            }
          }
        }
        // [CALLREC-PEER-1] We now know the peer id (fresh join OR our own
        // reconnect). Re-announce unconditionally: on a reconnect this is the
        // only thing that restores an indicator the peer lost with the socket.
        _announceRecordingState(force: true);
        // [CALLHOLD-1] Same reasoning, same three points: a peer who missed the
        // hold frame is sitting in silence with no explanation, and a peer who
        // missed the RESUME frame thinks we are still away.
        _announceHoldState(force: true);
        break;
      // [CALLREC-PEER-1] The DO tells existing peers when someone joins
      // (call_room.ts:2197). Nothing used to handle it. It is the ONLY hook for
      // "I armed recording before they arrived" — the announce broadcasts (no
      // `to` yet on this side) and reaches the newcomer. Deliberately does NOT
      // adopt `_remoteId`: call setup, SFU election and the P2P fallback all
      // decide who offers, and this must not touch that.
      case 'peer-joined':
        _announceRecordingState(force: true);
        _announceHoldState(force: true); // [CALLHOLD-1]
        break;
      // [CALLREC-PEER-1] The peer told us their recorder state. Defensive by
      // construction: anything that is not literally `true` reads as off, and a
      // frame from a client that predates this feature simply never arrives.
      case 'callrec':
        final peerRec = d['on'] == true;
        // [CALLREC-TELEM-1] The receiving half of the consent proof. This event
        // firing on the OTHER tester's timeline, with the same `call_id`, is the
        // evidence that the "Recording" indicator was actually delivered — as
        // opposed to sent into a socket and assumed. Emitted before the notifier
        // so a UI exception could never swallow the record of delivery.
        //
        // `changed` is here because the sender re-announces with `force` on
        // connect, rejoin and peer-joined: a burst of identical frames is normal
        // and expected, and without this a reader would read it as a loop.
        Analytics.capture('callrec_peer_indicator', {
          'call_id': config.room,
          'rec_id': 'callrec:${config.room}',
          'dir': 'received',
          'on': peerRec,
          'changed': peerRecording.value != peerRec,
          if (config.seed.isNotEmpty) 'peer_uid': config.seed,
        });
        if (peerRec != peerRecording.value) {
          AvaLog.I.log(
              'call', 'peer recording indicator ${peerRec ? 'ON' : 'OFF'}');
        }
        peerRecording.value = peerRec;
        break;
      // [CALLHOLD-1] The peer told us their hold state. Defensive by
      // construction, exactly like `callrec`: anything that is not literally
      // `true` reads as off, and a frame from a client that predates this
      // feature simply never arrives (so `peerHold` stays false and the call
      // behaves as it always did).
      case 'hold':
        peerHold.value = d['on'] == true;
        break;
      // [ADDCALL-2-UI] Add-to-call (spec §4.2). All four frames go to the one
      // dispatcher, which is a no-op unless the escalation service installed a
      // handler at boot. Nothing here touches call state: an escalation that
      // fails, or a handler that is missing entirely, leaves this call exactly
      // as it was.
      case 'addcall':
      case 'addcall-ack':
      case 'addcall-go':
      case 'addcall-abort':
        _dispatchEscalationFrame(d);
        break;
      // [CALLHOLD-1] The `mute` frame has been SENT by this client for a long
      // time (toggleMute's peers, the focus hold, the cellular hold) and there
      // was no case for it here, so every one of those frames was received and
      // discarded. Two lines, no behaviour change to anything that already
      // works, and the peer's mic state stops being invisible.
      case 'mute':
        peerMuted.value = d['muted'] == true;
        break;
      // [CALL-RTK-3] The peer elected RealtimeKit. Mirrors `sfu-start` exactly,
      // with one addition: `_rtkEligible` is re-checked on THIS phone, because
      // the flag and the translation gate are per-device. A peer that is
      // eligible while we are not gets an `rtk-abort` from `_startRtkMedia`'s
      // failure path rather than a call that half-joins a meeting we will never
      // be in.
      case 'rtk-start':
        if (!_ended && !_connected && !_rtkAborted) {
          if (_rtkEligible) {
            await _startRtkMedia();
          } else {
            _rtkAborted = true;
            if (_remoteId != null)
              _send({'type': 'rtk-abort', 'to': _remoteId});
          }
        }
        break;
      // [CALL-RTK-3] The peer fell back. Sticky, and identical in shape to
      // `sfu-abort`: leave the meeting if we joined one, then let the DECIDER
      // (never both phones) re-offer down the precedence ladder.
      case 'rtk-abort':
        _rtkAborted = true;
        if (_rtkStarting || _rtkActive) {
          await _cancelRtkEvents(); // [CALL-RTK-4]
          await _safeAwait(() => _rtk?.leave());
          _rtk = null;
          _rtkStarting = false;
          _rtkActive = false;
        }
        if (_rtkDecider && !_ended && !_connected) {
          if (RemoteConfig.callSfuV1 && !_sfuAborted) {
            _sfuDecider = true;
            _send({'type': 'sfu-start', 'to': _remoteId});
            await _startSfuMedia();
          } else {
            await _startP2pOffer();
          }
        }
        break;
      case 'sfu-start':
        if (!_ended && !_connected && !_sfuAborted) {
          await _startSfuMedia();
        }
        break;
      case 'sfu-abort':
        _sfuAborted = true;
        // [CALL-SFU-SURVIVE-1 2026-08-06] Disarm the ladder BEFORE the `if`.
        // During a backoff window `_sfuStarting` and `_sfuActive` are both
        // false, so the block below is skipped entirely — leaving a retry timer
        // armed to rejoin an SFU room the peer has just abandoned, while
        // `_sfuRetryPending` keeps P2P recovery switched off for the rest of the
        // backoff (up to 30s).
        _sfuRetryTimer?.cancel();
        _sfuRetryPending = false;
        if (_sfuStarting || _sfuActive) {
          await _sfu?.dispose();
          _sfu = null;
          _sfuStarting = false;
          _sfuActive = false;
          // [CALL-PCRETIRE-1] Detach before closing — see [_retirePc].
          await _retirePc(_pc);
        }
        // [CALL-PREJOIN-1 2026-08-16] Covers the case the caller pre-joined
        // but never got as far as `case 'sfu-start':` adopting it (the peer
        // aborted SFU immediately). No-ops if it was already adopted/consumed.
        await _discardPrejoinedSfu('sfu_aborted');
        if (_sfuDecider && !_ended && !_connected) await _startP2pOffer();
        break;
      case 'sfu-video':
        if (_sfuActive) await _sfu?.pullPeerVideo();
        break;
      // [CALL-SFU-REPULL-1 2026-08-06] The peer rejoined the SFU on a NEW
      // session, so the track name we are pulling is stale and that direction
      // has gone quiet. Re-pull. See `pullPeerAudio` for why nothing else can
      // detect this — there is no error, only silence.
      case 'sfu-rejoined':
        if (_sfuActive && _sfu != null) {
          await _repullPeerMedia('peer_rejoined');
        } else if (!_ended) {
          // We are mid-rejoin ourselves (dual handover) or not on the SFU yet.
          // Remember it — dropping it here is how one direction ends up
          // permanently silent, which is the whole failure this fix addresses.
          _sfuPeerRepullPending = true;
          Analytics.capture('call_sfu_peer_repull_deferred', {
            'call_id': config.room,
            'sfu_active': _sfuActive,
            'reconnect_in_flight': _sfuReconnectInFlight,
          });
        }
        break;
      case 'offer':
        // [CALL-GLARE-OBS-1 2026-08-05] Detect and REPORT offer collisions.
        //
        // This app does not implement perfect negotiation, and mostly does not
        // need to: glare is prevented structurally (the DO's newcomer-offers
        // rule, the `_weOffered` guard on every renegotiation, and a server-side
        // pair-keyed glare DO with a 30s mutual-dial window). But "mostly" was
        // being enforced by a bare `catch (_) {}` — if a collision ever DID
        // happen, `setRemoteDescription` would throw in the wrong signaling
        // state, the answer would never be sent, and the call would hang with
        // no event, no log and no way to know it had occurred.
        //
        // Deliberately still NOT rollback-based: silently rolling back would
        // paper over a violation of the structural invariants above, which is
        // information worth having. Detect, name it, and let the existing
        // recovery ladder handle the call.
        // [CALL-REDIAL-BUSY-1 2026-08-09] A P2P offer must NEVER be applied to
        // the SFU peer connection. On the SFU path `_pc` IS the SFU PC, parked
        // in have-local-offer while its publish answer is pending — prod
        // 2026-08-08 (avatok-b3e2da5c): the callee's stray P2P offer hit this
        // handler mid-publish, `setRemoteDescription` threw
        // (`offer_handling_failed`, glare_suspected=true), and the call died at
        // 0s on the caller while the callee sat on a dead screen for 30s. The
        // legitimate P2P fallback arrives only AFTER `sfu-abort` has torn the
        // SFU state down, at which point this guard no longer matches.
        if (_sfuActive || _sfuStarting) {
          Analytics.capture('call_p2p_offer_ignored_on_sfu', {
            'call_id': config.room,
            'sfu_active': _sfuActive,
            'sfu_starting': _sfuStarting,
            'connected': _connected,
          });
          break;
        }
        // [CALL-PREJOIN-1 2026-08-16] A genuine P2P offer means the peer
        // elected P2P — any caller pre-join seat is now dead weight and must
        // be released rather than left holding an SFU seat for a call that is
        // going direct.
        //
        // [CALL-PREJOIN-ISOLATE-1 2026-08-17] This used to be load-bearing for
        // a second reason: `_pc` could still BE the pre-join's SFU connection
        // (the `_sfuActive || _sfuStarting` guard above does not see a
        // pre-join), so `_pc ?? await _newPC()` below would have handed this
        // P2P offer's `setRemoteDescription` to the SFU peer connection. An
        // un-promoted pre-join no longer assigns `_pc` at all, so that hazard
        // is gone at the source — this call now exists purely to free the seat.
        await _discardPrejoinedSfu('p2p_offer_received');
        final sigState = _pc?.signalingState;
        final collision = sigState != null &&
            sigState != RTCSignalingState.RTCSignalingStateStable &&
            sigState != RTCSignalingState.RTCSignalingStateHaveRemoteOffer;
        if (collision) {
          Analytics.capture('call_offer_glare_detected', {
            'call_id': config.room,
            'signaling_state': sigState.toString().split('.').last,
            'we_offered': _weOffered,
            'connected': _connected,
            'video_renego_in_flight': _videoRenegoInFlight,
          });
          AvaLog.I.log('call',
              'offer arrived in signaling state $sigState — glare, answer may fail');
        }
        // [CALL-PREWARM-TRUTH-2 2026-08-21] The ANSWERER's missing mic guard.
        // `_startP2pOffer` has always done this before `_newPC()`; this path
        // never did, and this is the path the callee actually takes — the
        // callee is the ONLY side that can have `_prewarmAudioPending`, and it
        // is never the P2P offerer (the decider is). So a callee whose SFU
        // publish aborted to P2P built its peer connection straight from the
        // trackless protocol-silence stream: `_addStreamTracks` looped zero
        // times, `createAnswer` produced a recvonly audio m-line, and it shipped
        // silence for the whole call while hearing the caller perfectly. There
        // is no `replaceTrack`, no `onRenegotiationNeeded` and no renegotiation
        // path in this file that could have repaired it afterwards.
        if (_prewarmAudioPending && !await _ensureAcceptedAudio()) {
          _endWithMediaFailure(); // [STREAM-PERM-1]
          break;
        }
        try {
          _remoteId = d['from'] as String;
          final pc = _pc ?? await _newPC();
          await pc.setRemoteDescription(
              RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
          await _flushCandidates();
          final ans = _tuned(await pc.createAnswer());
          await pc.setLocalDescription(ans);
          _send({'type': 'answer', 'to': _remoteId, 'sdp': ans.toMap()});
        } catch (e, st) {
          // Was `catch (_) {}` — a failed answer is how a call dies silently.
          _telemetry.runtimeError(
            stage: 'offer_handling_failed',
            error: e,
            stack: st,
            extra: {
              'glare_suspected': collision,
              'signaling_state': sigState?.toString() ?? 'unknown',
              'we_offered': _weOffered,
            },
          );
        }
        break;
      case 'answer':
        // [CALL-TELEMETRY-1] Mark that SDP answer arrived — never_connected
        // failures split into "ring never landed" vs "answered but ICE failed".
        _gotSdpAnswer = true;
        _noteAnswerBoundary('remote_sdp_answer');
        try {
          await _pc?.setRemoteDescription(
              RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
          await _flushCandidates();
        } catch (_) {}
        break;
      case 'candidate':
        final c = d['candidate'];
        final cand =
            RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']);
        if (_pc == null || !_remoteSet) {
          _pendingCandidates.add(cand);
        } else {
          try {
            await _pc!.addCandidate(cand);
          } catch (_) {}
        }
        break;
      case 'device-ringing':
        // [CALL-4RINGS-1 2026-08-08] The receipt is no longer a one-shot — the
        // callee now sends one per ring CYCLE — so the frame is forwarded and
        // repeats are handled honestly instead of being dropped on the floor.
        _onDeviceRinging(d);
        break;
      case 'call-ringing':
        // Silent transport prewarm has completed (or its bounded fallback
        // promoted the call). This is the authoritative ring anchor; only now
        // may the existing real-ring pathway start ringback and the deadline.
        if (config.outgoing && !_connected && !_ended) {
          final deadline = d['ring_deadline_ms'];
          final parsedDeadline = deadline is num
              ? deadline.toInt()
              : int.tryParse((deadline ?? '').toString());
          _silentTransportPrewarming = false;
          noteServerRingDeadline(parsedDeadline);
          _deviceRingingTimer?.cancel();
          _deviceRingingTimer = null;
          _ringAckFallback?.cancel();
          _ringAckFallback = null;
          _ringAckHandled = true;
          _onDeviceRinging({
            ...d,
            'ringCount': d['ring_count'] ?? 0,
            'ringsRequired': d['rings_required'] ?? 0,
          });
          Analytics.capture('caller_waiting_room', {
            'call_id': config.room,
            'phase': 'ringing',
            'ring_started_at': d['ring_started_at'] ?? -1,
          });
        }
        break;
      case 'ring-delivered':
        _onRingDelivered();
        break;
      case 'ring-ack':
        _onRingAck(d['ok'] == true);
        break;
      case 'decline_agent':
        // [DIALPAD-BIZ-CALLS Phase C] Fast-WS "Send to Ava AI Agent" signal.
        if (_receptionistActive) break;
        if (!_connected && !_ended)
          businessAgentHandoff('manual_send_to_agent');
        break;
      case 'decline_ava':
        // Fast-WS twin of the durable call-status branch. Keep the explicit
        // handoff out of the generic decline/outcome-menu path.
        if (_receptionistActive) break;
        if (!_connected && !_ended && !config.video) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva(d['activation_mode']?.toString() == 'rings'
              ? 'rings'
              : 'decline');
        }
        break;
      case 'no-answer':
        if (!_connected && !_ended) {
          _ringTimeout?.cancel();
          _showOutcomeMenu('no-answer');
        }
        break;
      case 'decline_vm':
        // [CALL-VOICEMAIL-1 2026-08-01] Fast-WS twin of the push branch above.
        // Both paths MUST agree — the decline bug happened because two copies of
        // the same decision disagreed and whichever won the race decided the
        // outcome. Keep these two in lockstep.
        if (_receptionistActive) break;
        if (!_connected && !_ended) _showOutcomeMenu('voicemail');
        break;
      case 'decline':
        if (_receptionistActive) break;
        // [CALL-DECLINE-IS-TERMINAL-1 2026-08-01] OWNER RULING A. The SECOND
        // copy of the decline branch — this is the fast socket path, the one
        // above at ~:1562 is the durable push path. They must agree, and they
        // did not: this one handed off to Ava for ANY non-video call, ignoring
        // even the lane check the push path applied. Whichever path won the race
        // decided whether the caller got Ava, which is exactly how "sometimes it
        // goes to the receptionist, sometimes it doesn't" happened.
        //
        // Decline now ends the call on both paths, always.
        // Receptionist arrives as `decline_ava` and is handled separately.
        if (!_connected && !_ended) {
          _ringTimeout?.cancel();
          _endWith('declined', reason: 'decline-explicit-ws');
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
          // an ICE restart from our side too (harmless if already healthy).
          if (RemoteConfig.callIceRecoveryV2) {
            // ignore: unawaited_futures
            _requestRecovery(RecoveryReason.peerRejoined);
          } else {
            // _tryIceRestart no-ops unless we're the offerer with a live pc.
            // ignore: unawaited_futures
            _tryIceRestart('peer-rejoined');
          }
        }
        // [CALLREC-PEER-1] Their socket dropped and came back, so their copy of
        // our recording state went with it. Re-announce outside the `_connected`
        // guard above — a peer who reconnected must relearn this either way.
        _announceRecordingState(force: true);
        _announceHoldState(force: true); // [CALLHOLD-1]
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
      // [CALL-REL-5] Server-coordinated ICE recovery. Both are no-ops unless
      // RemoteConfig.callIceRecoveryV2 is on (guarded inside the handlers).
      case 'recovery-offer':
        _onRecoveryOffer(d);
        break;
      case 'recovery-ready':
        _onRecoveryReady(d);
        break;
      // [CALL-REL-6] Mid-call relay migration. No-ops unless
      // RemoteConfig.callRelayMigrationV1 is on (guarded inside the handlers).
      case 'relay-migrate-offer':
        // ignore: unawaited_futures
        _onRelayMigrateOffer(d);
        break;
      case 'relay-migrate-answer':
        // ignore: unawaited_futures
        _onRelayMigrateAnswer(d);
        break;
      case 'relay-migrate-candidate':
        // ignore: unawaited_futures
        _onRelayMigrateCandidate(d);
        break;
      case 'relay-migrate-ready':
        _onRelayMigrateReady(d);
        break;
      case 'relay-migrate-reject':
        _onRelayMigrateReject(d);
        break;
      // [BLOCKER-2 fix] Non-initiator asking the deterministic initiator to
      // start a migration instead of racing it with its own attempt.
      case 'relay-migrate-request':
        _onRelayMigrateRequest(d);
        break;
      // [CALL-RELAY-ANSWERER-1] The ANSWERER hit its 4s pre-connect deadline and
      // is asking us — the offerer, the only side allowed to renegotiate — to
      // escalate to a relay. `_forceRelayRestart` re-checks `_weOffered`,
      // `_connected`, `_ended` and `_relayForced` itself, so a request that
      // arrives late, twice, or at the wrong peer is a no-op rather than a
      // second offer racing the first.
      case 'relay-fallback-request':
        _forceRelayRestart();
        break;
      case 'net-class':
        _peerCellular = d['cellular'] == true;
        if (RemoteConfig.callCellPresetV1 && _localCellular && _peerCellular) {
          unawaited(_applyAudioBitrate(40000));
        }
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
    // [CALLHOLD-1] Was `t.enabled = !_muted` inline. It has to go through the
    // shared applier now: un-muting while the call is HELD would otherwise open
    // the microphone of someone who is on hold, and it would do it silently.
    // Un-holding later reads `_muted` at that moment, so a mute taken during a
    // hold is still honoured on resume.
    _applyLocalAudioEnabled();
    muted.value = _muted;
    Analytics.capture('call_mute_changed', {
      'call_id': config.room,
      'user_muted': _muted,
      'focus_held': _onFocusHold,
      'cellular_held': _onCellularHold,
      'effective_mic_enabled':
          !_muted && !_userHold && !_onFocusHold && !_onCellularHold,
      'source': 'user',
    });
  }

  /// Sends an RFC 4733 DTMF tone through the negotiated audio sender. This is
  /// intentionally media-plane only: digits never enter signaling logs or the
  /// call command reducer. The native WebRTC plugin reports unsupported sender
  /// state as a normal failed feasibility result instead of crashing the call.
  Future<bool> sendDtmf(String tone) async {
    if (_ended || !_connected || !RegExp(r'^[0-9A-D#*]$').hasMatch(tone))
      return false;
    try {
      final senders = await _pc?.getSenders();
      RTCDTMFSender? dtmf;
      for (final sender in senders ?? const <RTCRtpSender>[]) {
        if (sender.track?.kind == 'audio') {
          dtmf = sender.dtmfSender;
          break;
        }
      }
      if (dtmf == null || !await dtmf.canInsertDtmf()) return false;
      await dtmf.insertDTMF(tone, duration: 100, interToneGap: 70);
      Analytics.capture(
          'call_dtmf_sent', {'call_id': config.room, 'tone': tone});
      return true;
    } catch (e, st) {
      _telemetry.runtimeError(
          stage: 'dtmf_send_failed',
          error: e,
          stack: st,
          extra: {'call_id': config.room});
      return false;
    }
  }

  void toggleSpeaker() {
    if (RemoteConfig.callAudioOwnerV1) {
      // [CALL-AUDIO-OWNER-1] Update the controller's intent BEFORE queuing the
      // apply — a fast repeat toggle always carries the latest press, never a
      // stale one captured by an in-flight apply from `boot_media` or a
      // `reassert`. `onRouteConfirmed` (installed in `_bootMedia`) is what
      // actually updates `_speaker`/`speakerOn`/the tone player/the
      // receptionist once native confirms the route — never optimistically
      // here, so the UI always reflects the CONFIRMED route.
      final target =
          _speaker ? CallAudioRoute.earpiece : CallAudioRoute.speaker;
      CallAudioController.instance.setIntent(target);
      // ignore: unawaited_futures
      CallAudioController.instance.apply(source: 'user_toggle');
      return;
    }
    if (RemoteConfig.callAudioControllerV2) {
      // CALL-REL-1: the controller is the only route owner. toggleSpeaker is
      // now an awaited/serialized request; `speakerOn` is only updated once
      // the route event confirms the ACTUAL active route (never merely the
      // last button press). UI may optimistically show the pending intent —
      // it does not do so here to avoid a second, possibly wrong, UI update.
      final target =
          _speaker ? CallAudioRoute.earpiece : CallAudioRoute.speaker;
      // ignore: unawaited_futures
      NativeVoiceAudio.instance
          .selectRoute(target, source: 'user')
          .then((result) {
        _speaker = result.active == CallAudioRoute.speaker;
        speakerOn.value = _speaker;
        // ignore: unawaited_futures
        _receptionist?.setSpeaker(_speaker);
      });
      return;
    }
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

  void _startHandoffAuthorityPoll() {
    _handoffAuthorityPoll?.cancel();
    _handoffAuthorityPoll = Timer.periodic(const Duration(seconds: 2), (_) {
      if (_ended || _connected || _receptionistActive || _avaCountingDown) {
        _handoffAuthorityPoll?.cancel();
        return;
      }
      if (!_handoffAuthorityPollInFlight) {
        unawaited(_pollHandoffAuthority());
      }
    });
  }

  Future<void> _pollHandoffAuthority() async {
    _handoffAuthorityPollInFlight = true;
    try {
      final status = await PushService.fetchDurableCallStatus(
        config.room,
        timeout: const Duration(milliseconds: 1200),
      );
      if (status == 'decline_ava' &&
          !_ended &&
          !_connected &&
          !_receptionistActive &&
          !_avaCountingDown &&
          !config.video) {
        _handoffAuthorityPoll?.cancel();
        _ringTimeout?.cancel();
        Analytics.capture('call_handoff_recovered_authority_poll', {
          'call_id': config.room,
          'status': status!,
        });
        await _handoffToAva('decline');
      }
    } catch (_) {
      // Fail open: the room socket and FCM remain the primary + backstop paths.
    } finally {
      _handoffAuthorityPollInFlight = false;
    }
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
    ApiAuth.postJson(kCallCommandUrl, {
      'callId': config.room,
      'command': 'cancel_call',
    }).ignore();
    Analytics.capture('call_cancel_sent', {'call_id': config.room});
  }

  void toggleCamera() {
    if (!_video) {
      if (_sfuActive) {
        // [CALL-VIDEO-FIX-1] No optimistic success flags on the SFU path.
        // This upgrade is a real Cloudflare publish (getUserMedia, then an
        // offer/answer round trip) that can fail or hang, and setting
        // videoActive/cameraOn/speakerOn true HERE — before any of that had
        // happened — was one confirmed cause of "switching to video freezes
        // the app": the UI claimed video was live while the SFU negotiation
        // was still in flight or had already failed underneath it.
        // `videoUpgrading` gives the UI an honest transitional state
        // instead; `_enableSfuVideo` (via the now-shared
        // `_videoRenegoInFlight` guard in `_restartWithVideo`) sets the real
        // flags only once the publish actually succeeds, and rolls
        // `videoUpgrading` back on any failure/timeout.
        videoUpgrading.value = true;
        // ignore: unawaited_futures
        _restartWithVideo();
        return;
      }
      // P2P path: unchanged — optimistic UI, fire-and-forget renegotiation.
      _video = true;
      _camOn = true;
      _speaker = true;
      videoActive.value = true;
      cameraOn.value = true;
      speakerOn.value = true;
      // ignore: unawaited_futures
      _restartWithVideo();
      return;
    }
    _camOn = !_camOn;
    _stream?.getVideoTracks().forEach((t) => t.enabled = _camOn);
    cameraOn.value = _camOn;
  }

  /// [CF-CALL-P2P-1] Mid-call video-enable renegotiation, serialized so it can
  /// never race a concurrent offer from ICE recovery or relay migration
  /// (proposal Phase 5: "serialize renegotiation and ICE recovery"). Reuses
  /// the SAME kind of single-attempt guard the existing recovery/migration
  /// coordinators already use — [_videoRenegoInFlight] is, in turn, checked by
  /// [_requestRecovery]/[_tryIceRestart]/the relay-threshold trigger so THEY
  /// also defer to an in-flight video upgrade rather than racing it.
  ///
  /// [CALL-VIDEO-FIX-1 2026-08-17] The [_videoRenegoInFlight] guard now sits
  /// ABOVE the `_sfuActive` branch so BOTH paths are covered by it. It
  /// previously sat below the `if (_sfuActive) { ...; return; }` early exit,
  /// which meant a rapid double-tap of the camera button on the SFU path hit
  /// no re-entrancy guard at all — two concurrent `_enableSfuVideo` calls
  /// could both add a video track and both publish, mutating the one shared
  /// `RTCPeerConnection` from two call stacks at once.
  Future<void> _restartWithVideo() async {
    if (_ended) return;
    if (_videoRenegoInFlight) {
      _telemetry.runtimeError(
        stage: 'video_upgrade_skipped_concurrent',
        error: StateError('a video-enable renegotiation is already in flight'),
      );
      // Nothing was started on this call, so clear the transitional flag
      // `toggleCamera` set before calling in — otherwise a double-tap would
      // leave the UI stuck showing "Adding video…" forever.
      if (_sfuActive) videoUpgrading.value = false;
      return;
    }
    _videoRenegoInFlight = true;
    try {
      if (_sfuActive) {
        await _enableSfuVideo();
        return;
      }
      // Give any in-flight ICE recovery / relay migration a bounded window to
      // finish before we send a competing offer of our own.
      var waitedMs = 0;
      while (!_ended &&
          (_activeRecovery != null || _activeMigration != null) &&
          waitedMs < 4000) {
        await Future.delayed(const Duration(milliseconds: 250));
        waitedMs += 250;
      }
      if (_ended) return;
      if (_activeRecovery != null || _activeMigration != null) {
        _telemetry.runtimeError(
          stage: 'video_upgrade_deferred_negotiation_busy',
          error:
              StateError('recovery/relay-migration still active after 4s wait'),
        );
        return;
      }
      final pcAtStart = _pc;
      final cellular = await _isLikelyCellular();
      MediaStream v;
      try {
        v = await navigator.mediaDevices.getUserMedia({
          'video': audio_tuning.avaVideoConstraints(cellular: cellular),
          'audio': false,
        });
      } catch (e, st) {
        _telemetry.runtimeError(
            stage: 'video_upgrade_get_user_media_failed', error: e, stack: st);
        return;
      }
      if (_ended || !identical(_pc, pcAtStart))
        return; // superseded mid-capture
      final track = v.getVideoTracks().first;
      try {
        await _stream?.addTrack(track);
      } catch (e, st) {
        _telemetry.runtimeError(
            stage: 'video_upgrade_add_local_track_failed', error: e, stack: st);
      }
      if (_ended) return;
      localRenderer.srcObject = _stream;
      if (_stream != null && _pc != null) {
        try {
          await _pc!.addTrack(track, _stream!);
        } catch (e, st) {
          _telemetry.runtimeError(
              stage: 'video_upgrade_add_track_failed', error: e, stack: st);
        }
      }
      if (_pc != null) {
        // [CALL-MEDIA-540P-1] Codec preference belongs here too, and must be
        // set before the re-offer three lines down — the P2P upgrade path was
        // capping the bitrate but still letting libwebrtc pick VP8 first, which
        // also left the L1T3 temporal layering inert.
        await _applyVideoCodecPreference(_pc!);
        await _preferResolutionOnVideo(_pc!, cellular: cellular);
      }
      if (!_ended &&
          _pc != null &&
          identical(_pc, pcAtStart) &&
          _remoteId != null) {
        final offer = _tuned(await _pc!.createOffer());
        await _pc!.setLocalDescription(offer);
        _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
        Analytics.capture('call_video_upgraded', {'call_id': config.room});
      }
    } catch (e, st) {
      _telemetry.runtimeError(
          stage: 'video_upgrade_failed', error: e, stack: st);
    } finally {
      _videoRenegoInFlight = false;
    }
    _bump();
  }

  /// [CF-CALL-P2P-1] Front/back camera flip. flutter_webrtc's `Helper.switchCamera`
  /// swaps the physical camera feeding the EXISTING local video track in
  /// place — no new track, no renegotiation, no SDP round-trip — so it can't
  /// race the offer/answer serialization above; it only needs its own
  /// re-entrancy guard against a rapid double-tap. Reported via telemetry
  /// either way so a flip that silently no-ops on some device/OS combination
  /// is visible instead of being a cold support report.
  Future<void> flipCamera() async {
    if (_ended || !_video || !_camOn || _flippingCamera) return;
    final videoTracks = _stream?.getVideoTracks() ?? const [];
    if (videoTracks.isEmpty) return;
    final track = videoTracks.first;
    _flippingCamera = true;
    final pcAtStart = _pc;
    try {
      await Helper.switchCamera(track);
      // A stale/superseded call (ended, or the PC was swapped mid-flip by a
      // recovery/migration cutover) still performed the OS-level switch —
      // harmless either way since it operates on the local capture device,
      // not the PC — but only count/report it against the call that's still
      // live and on the same PC generation it started on.
      if (!_ended && identical(_pc, pcAtStart)) {
        Analytics.capture('call_camera_flipped', {'call_id': config.room});
      }
    } catch (e, st) {
      _telemetry.runtimeError(stage: 'camera_flip_failed', error: e, stack: st);
    } finally {
      _flippingCamera = false;
    }
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
      ApiAuth.postJson(kCallCommandUrl, {
        'callId': config.room,
        'command': 'end_call',
      }).ignore();
    }
    _telemetry.ended('local-hangup');
    await hangup('local-hangup');
  }

  /// [CALL-EXCL-1] Is this session currently talking to the receptionist (Ava)?
  bool get hasLiveReceptionist => _receptionist != null && !_ended;

  /// A terminal UI that is allowed to remain mounted for follow-up actions.
  /// It is safe to reap; an active human/receptionist leg is never included.
  bool get isOutcomeSurface =>
      !_ended &&
      (_phase == 'outcome-menu' || _phase == 'no-answer' || _phase == 'busy');

  /// [CALL-EXCL-1] Single-audio-authority yield: the device owner just accepted a
  /// real incoming call. If THIS session is a live receptionist leg, end it via
  /// the DO `owner_answered` path (no voicemail, no caller ack) and tear down.
  /// Returns true if it actually yielded a receptionist session.
  Future<bool> yieldReceptionistToOwner() async {
    final r = _receptionist;
    if (r == null || _ended) return false;
    try {
      await r.yieldToOwner();
    } catch (_) {}
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
      ApiAuth.postJson(kCallCommandUrl, {
        'callId': config.room,
        'command': 'end_call',
      }).ignore();
    }
    Analytics.capture('call_ended_for_accept', {
      'call_id': config.room,
      'reason': reason,
    });
    await hangup(reason);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  [CALL-RING-AUDIBLE-2 2026-08-08] Keep the caller's tone audible all the
  //  way to Ava's first word on the UNREACHABLE lane too.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // OWNER REPORT (2026-08-08, caller hdavy2002@gmail.com, call avatok-d679c96a):
  // "after a few beeps the voice disappears… then when Ava is about to come
  // online the sound wakes up again in the speaker."
  //
  // It is NOT a route bug and NOT the receptionist's audio session ducking the
  // tone. `call_audio_owner_apply` shows boot_media→earpiece at +0.3s,
  // user_toggle→speaker at +2s and then NOTHING until the receptionist's own
  // re-asserts at +18s: the route was SPEAKER for the whole window, and the
  // native engine's focus request is `AUDIOFOCUS_GAIN_TRANSIENT` while the tone
  // player pins `AndroidAudioFocus.none` (ringback_player.dart
  // `_ensureCallAudioContext`), so no focus interaction can silence it either.
  //
  // The tone was simply STOPPED. Three sites on the unreachable lane called
  // `_ringback.stop()` themselves before handing to `_onNoAnswer`: the 12s
  // device-wake timer in `start()`, the same timer re-armed in
  // [notePlaceResult], and `ok:false` in [_applyRingAck]. That is precisely the
  // "stop the tone before we even know whether a handoff will be attempted"
  // pattern [AVA-PREWARM-1] deleted from `_onNoAnswer` — it was left behind on
  // these three, so the callee-never-receipted lane (searching beeps, ~3 of
  // them, then the 12s deadline) still produced 6-8s of dead air until Ava's
  // first audio at the ava-live gate.
  //
  // The gate design already owns the stop: [_openAvaLiveGate] on success,
  // [_stopToneOnHandoffFailure] on failure/no-attempt, `_showOutcomeMenu` /
  // `businessAgentHandoff` / `_endWith` on every terminal. So the fix is to
  // stop stopping it here and let `_onNoAnswer` decide, exactly as the
  // no-answer lane already does.
  //
  // Gated on `RemoteConfig.callRingAudibilityV1` (declared in
  // worker/src/routes/config.ts, DEFAULTS false — it ships dark and arming it
  // is a deliberate flag flip). Flag OFF = byte-equivalent to before.
  void _goUnreachable(String source) {
    if (RemoteConfig.callRingAudibilityV1) {
      // Tone keeps running into the handoff; sample it so "still audible" is a
      // value we can read in PostHog rather than an assumption.
      _sampleRingAudible('unreachable_$source');
    } else {
      _ringback.stop();
    }
    _callUnreachable = true;
    _unreachableNotice?.call();
    unawaited(_onNoAnswer());
  }

  /// [CALL-RING-AUDIBLE-2] Emit `ringback_audible` twice for [phase] — now and
  /// again 2s later. ONE sample only proves nobody called `stop()`; the SECOND
  /// sample's `position_ms` is what proves the tone is still actually running
  /// through the receptionist spin-up (ship-gate rule 3: assert the success
  /// value, not the arrival of an event).
  void _sampleRingAudible(String phase) {
    unawaited(_emitRingAudible(phase, 0));
    Timer(const Duration(seconds: 2), () {
      if (_ended) return;
      unawaited(_emitRingAudible(phase, 2000));
    });
  }

  Future<void> _emitRingAudible(String phase, int sampleAtMs) async {
    try {
      final snap = await _ringback.audibleSnapshot();
      Analytics.capture('ringback_audible', {
        'call_id': config.room,
        'phase': phase,
        'sample_at_ms': sampleAtMs,
        'flag_on': RemoteConfig.callRingAudibilityV1,
        'ava_live_gate_open': _avaLiveGateOpen,
        'recept_active': _receptionistActive,
        'unreachable': _callUnreachable,
        ...snap,
      });
    } catch (e, st) {
      Analytics.captureException(e, st,
          screen: 'call',
          handled: true,
          extra: {'stage': 'ringback_audible_sample', 'phase': phase});
    }
  }

  Future<void> _onNoAnswer() async {
    // [AVA-RING-BLEED-1] A stale no-answer timer firing while Ava is live must
    // not end the call under her ("no-answer"/timeout-ringing).
    if (_receptionistActive || _receptionist != null || _avaCountingDown)
      return;
    // [DIALPAD-BIZ-CALLS Phase C] Same protection for a live agent hand-off.
    if (_phase == 'agent-handoff') return;
    // [NOANSWER-LEAVE-NOTE-1] The persistent leave-a-note card is already up
    // (this method is now its entry point) — a second stale ring/timeout firing
    // must not re-attempt the receptionist under it.
    if (_phase == 'outcome-menu') return;
    // [AVA-PREWARM-1] The ringback tone used to be stopped unconditionally
    // right here — before we even knew whether a receptionist handoff would
    // be attempted — which is exactly what produced the 10-11.5s silent gap
    // (prod ava_recept_first_audio ms=9801/11461: ringback stops, then dead
    // air through the entire HTTP/WS/mic/engine spin-up). It now keeps
    // playing through the attempt below and is stopped centrally at the
    // ava-live gate ([_openAvaLiveGate], success) or via
    // [_stopToneOnHandoffFailure] (failure / no attempt), never blindly here.
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
      if (started)
        return; // tone keeps playing — stops at the live gate or its own timeout
      await _stopToneOnHandoffFailure('receptionist_failed');
    } else {
      // Receptionist not attempted at all (video / not allowed for this
      // scenario) — nothing will ever stop the tone, so stop it here.
      await _stopToneOnHandoffFailure('no_receptionist');
      if (_calleePrefsKnown && !_calleeAiReceptionist) {
        Analytics.capture('ava_recept_skipped', {
          'call_id': config.room,
          'reason': 'callee_receptionist_off',
          'business': config.business,
          // For a PSTN/business call the pre-recorded PSTN voicemail lane owns the
          // fallback when this is on; AvaTOK calls always drop to the WS2 free VM.
          'pstn_voicemail_enabled': _calleePstnVoicemail,
        });
      }
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
      config.business &&
      config.outgoing &&
      !config.video &&
      RemoteConfig.businessCallUx;

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
      if (_menuEnabled) {
        _showOutcomeMenu('declined');
        return;
      }
      _endWith('declined', reason: 'decline');
      return;
    }
    _ringTimeout?.cancel();
    _ringback.stop();
    // Tear down the dialing leg (stops any other callee device ringing, frees
    // the mic for the agent bridge) — same teardown _showOutcomeMenu performs.
    try {
      _send({'type': 'bye'});
    } catch (_) {}
    try {
      _stream?.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    try {
      _pc?.close();
    } catch (_) {}
    _pc = null;
    _notifyCalleeCanceled();
    agentHandoffOutcome = outcome;
    _setPhase('agent-handoff');
    Analytics.capture('agent_handoff_started', {
      'call_id': config.room,
      'outcome': outcome,
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
    try {
      _send({'type': 'bye'});
    } catch (_) {}
    try {
      _stream?.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    // ignore: unawaited_futures
    try {
      _pc?.close();
    } catch (_) {}
    _pc = null;
    _notifyCalleeCanceled();
    _menuScenario = scenario;
    _setPhase('outcome-menu');
    Analytics.capture('call_menu_shown', {
      'call_id': config.room,
      'scenario': scenario,
      'video': config.video,
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
      'call_id': config.room,
      'option': 'talk_to_ava',
      'scenario': _menuScenario ?? '',
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

  /// [CALL-MENU-TEARDOWN-1] Awaitable terminal-menu teardown for actions that
  /// immediately start another call or navigate into another call surface.
  ///
  /// `menuDismiss()` intentionally remains synchronous for the existing note
  /// and close callbacks, but its fire-and-forget `_teardown()` used to leave
  /// `gLiveCallScreens` and the manager registry occupied while Call again was
  /// already constructing the next CallScreen. That deterministic overlap is
  /// the source of the recurring "Already on a call" lock. This method is the
  /// serialized path for redial/navigation actions.
  Future<void> dismissOutcomeAndWait({required String reason}) async {
    if (_ended) {
      // Still honor the memoized teardown so a caller that raced past `_ended`
      // (e.g. the reaper and a widget close callback firing the same frame)
      // gets the same completed future instead of assuming nothing to await.
      final f = _teardownFuture;
      if (f != null) {
        try {
          await f;
        } catch (e, st) {
          Analytics.captureException(e, st,
              handled: true,
              screen: 'call_session',
              extra: {
                'stage': 'dismiss_outcome_already_ended',
                'reason': reason
              });
        }
      }
      return;
    }
    _menuTimeout?.cancel();
    _telemetry.ended(reason);
    _ringback.stop();
    try {
      // [CALL-MENU-FIX-2] `_teardown` memoizes `_teardownFuture` internally
      // (`_teardownFuture ??= _teardownImpl(...)`), so two concurrent callers —
      // e.g. a voice-note completion callback and this widget-close callback —
      // both await the SAME single native teardown instead of racing two
      // independent closes of the same PC/audio route/FGS/camera (the "No
      // active stream to cancel" double EventChannel teardown class).
      await _teardown(reason: reason);
    } catch (e, st) {
      Analytics.captureException(e, st,
          handled: true,
          screen: 'call_session',
          extra: {'stage': 'dismiss_outcome_teardown', 'reason': reason});
    }
    if (_phase != 'ended') _setPhase('ended');
  }

  /// The widget logs option taps that it handles itself (notes).
  void menuLogOption(String option) {
    Analytics.capture('call_menu_option_selected', {
      'call_id': config.room,
      'option': option,
      'scenario': _menuScenario ?? '',
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
    _busyNotifyRegistered =
        true; // confirmed locally regardless of server state
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
      _endWith('receptionist-unavailable',
          reason: 'busy-receptionist-unavailable');
    }
  }

  Future<void> _probeReceptionist() async {
    try {
      final cfg = await ReceptionistApi.configFor(config.seed);
      if (_connected || _ended || cfg == null) return;
      _receptMode = (cfg['mode'] ?? 'rings').toString();
      _receptRings = (cfg['rings'] as num?)?.toInt() ?? 4;
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
      // The server owns the canonical 20-second/four-ring lease. Keep the local
      // timer two seconds behind it as a delivery backstop; it must never beat
      // the authoritative DO transition. First-ring remains the explicit fast
      // redirect exception.
      final Duration window = _receptMode == 'first_ring'
          ? const Duration(seconds: 6)
          : const Duration(seconds: 22);
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
    if (_silentTransportPrewarming) {
      _pendingRingWindow = window;
      return;
    }
    if (!_takeoverGuard) {
      _startRingWindow(window);
      return;
    }
    _pendingRingWindow = window;
    if (config.deferRing && !_placementResolved) {
      Analytics.capture('call_ring_window_deferred', {
        'call_id': config.room,
        'reason': 'placement_pending',
      });
      return;
    }
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
      // This is a provisional "no ack yet", not an authoritative negative.
      // Do not latch `_ringAckHandled`: POST /api/call or a delayed queue ack
      // may still arrive milliseconds later and must be allowed to cancel the
      // unreachable path. Prod call avatok-b6fd1397 hit exactly that 15ms race.
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
      _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 22));
    });
  }

  void _startRingWindow(Duration window) {
    if (_silentTransportPrewarming) return;
    // [AVA-RING-BLEED-1] Never (re)arm a no-answer window once Ava owns the call —
    // its _onNoAnswer would tear down the live receptionist session.
    if (_receptionistActive || _receptionist != null || _avaCountingDown)
      return;
    _ringTimeout?.cancel();
    _ringTimeout = Timer(_serverAlignedRingWindow(window), () {
      if (!_ended && !_connected) _onNoAnswer();
    });
  }

  /// [CALL-ONE-DEADLINE-1 2026-08-03] Prefer the server's absolute ring deadline
  /// over any locally-guessed duration.
  ///
  /// There were four numbers claiming to be "the ring timeout" — 20 s in the DO
  /// (the only one that actually fires), 22 s here, 30 s in `ringTimeoutSec` and
  /// in a dead campaign constant, 45 s in a comment. A duration computed on this
  /// device also starts from the wrong instant: it begins when the CLIENT armed
  /// it, while the server's deadline began when the ring was PLACED, and the gap
  /// between those has been measured at 5–8 s on failing calls. So the two ran
  /// on different clocks from different origins and drifted apart under exactly
  /// the conditions where agreeing mattered.
  ///
  /// The deadline is a fact owned by the CallRoom alarm. When we have been told
  /// it, honour it, and keep the deliberate ~2 s of slack so the SERVER always
  /// decides no-answer first (the client firing first is what produced a local
  /// "no answer" on a call the server was still ringing). When we have not been
  /// told it — an older push, a WS ring that lost the field — fall back to the
  /// caller-supplied window exactly as before.
  Duration _serverAlignedRingWindow(Duration fallback) {
    final deadline = _serverRingDeadlineMs;
    if (deadline == null || deadline <= 0) return fallback;
    final remaining =
        deadline + _kRingWindowSlackMs - DateTime.now().millisecondsSinceEpoch;
    // A deadline already in the past means the server has timed out or is about
    // to; do not arm a zero/negative timer, and do not silently wait `fallback`
    // as if nothing had happened.
    if (remaining <= 0) return Duration.zero;
    return Duration(milliseconds: remaining);
  }

  void _onRingAck(bool ok) {
    if (!_takeoverGuard || _connected || _ended || _silentTransportPrewarming)
      return;
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
    if (_pendingRingWindow == null && config.video) {
      _applyRingAck(ok);
      return;
    }
    if (_pendingRingWindow == null) {
      _pendingAckResult = ok;
      return;
    }
    _applyRingAck(ok);
  }

  void _applyRingAck(bool ok) {
    _ringAckOk = ok; // [CALL-TELEMETRY-1] recorded even if already handled
    // [CALL-PREJOIN-2 2026-08-17] THE correct moment to start publishing early.
    //
    // A positive ring-ack is the server confirming it accepted and enqueued the
    // ring — which it can only do for a call it has already recorded, with both
    // `caller_uid` and `callee_uid` set. That is exactly the precondition the
    // SFU seat write checks: on 2026-08-17 the pre-join fired from the socket's
    // `welcome` frame instead, raced call placement, and `POST /sfu-seat`
    // answered 403 `not_a_participant` (prod avatok-af94b158).
    //
    // Publishing here means our audio is already in the SFU while the callee's
    // phone is still ringing, so their first pull finds a live track instead of
    // both phones waiting on each other after Accept — the "connected, meter
    // running, hello? hello?" silence. Gated by `callerPrejoinOnRingV1`; a
    // no-op when off, and it never throws into the ring path.
    //
    // [CALL-PREJOIN-3 2026-08-18] Kept as a BACKSTOP only. The primary trigger
    // moved to `notePlaceResult` (placement is authoritative and strictly
    // earlier); `_maybeStartCallerPrejoin` is idempotent via `_prejoinStarted`,
    // so whichever fires first wins and the other is a no-op.
    if (ok) _maybeStartCallerPrejoin();
    if (_ringAckHandled) return;
    if (ok) {
      _ringAckHandled = true;
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
        _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 22));
        // [DIAL-NARRATION-1] The push verifiably reached the network — narrate it.
        // [FAKE-RING-HONEST-1] But an accepted push is NOT proof the device rang
        // (FCM-accepted != device-reached; delivered_semantics=
        // fcm_accepted_not_device_receipt). Keep the wording to "reaching the
        // phone" so it never implies the callee's phone is actually ringing — the
        // real ring narration/tone comes only from a device-ringing receipt.
        _setDialStage("Reaching $_peerFirst's phone…");
      }
      Analytics.capture('call_ring_ack', {
        'call_id': config.room,
        'ok': ok,
        'source': 'server',
        'window_extended': true
      });
      return;
    }
    _ringAckHandled = true;
    _ringAckFallback?.cancel();
    _deviceRingingTimer?.cancel();
    Analytics.capture('call_ring_ack',
        {'call_id': config.room, 'ok': ok, 'source': 'server'});
    if (!_connected) {
      _goUnreachable('ring_ack_false');
    }
  }

  // ── [INSTANT-CALL-MOUNT-1] Placement-result feedback ──────────────────────
  //
  // When a call screen is mounted OPTIMISTICALLY (config.deferRing — the screen
  // is shown the instant the user taps, before POST /api/call resolves), the
  // launch site runs that POST in the BACKGROUND and feeds the outcome back
  // here. This maps 1:1 onto the ring-ack machinery the guard flow already uses:
  //   reachable == true  → the backend has finished enqueueing the ring; START
  //                        the device-wake allowance now. This is provisional,
  //                        not the consumer's authoritative ring ack.
  //   reachable == false → no reachable device → honest unreachable → Ava, with
  //                        NO fake ringback ever having played.
  // Safe to call at most once; extra/late calls are absorbed by the ring-ack
  // guards (_ringAckHandled / _pendingAckResult). A no-op unless this session is
  // in guard/deferRing mode (_onRingAck early-returns when !_takeoverGuard).
  /// [CALL-PRESENCE-1 2026-08-03] The server told us the callee is holding a
  /// live WebSocket right now.
  ///
  /// This is PRESENCE, not ringing, and the distinction is the whole point. On
  /// 2026-07-22 a caller heard a complete ringback while the callee's phone was
  /// unreachable, because a signal that merely *suggested* the callee was
  /// reachable was allowed to manufacture a ring. FAKE-RING-HONEST-1 exists to
  /// stop that recurring.
  ///
  /// So this may do exactly two things: soften the waiting copy, and note that
  /// a real ring should arrive within a second. It must NEVER start a ringback,
  /// set phase `ringing`, or say their phone is ringing — only a device-ringing
  /// receipt does that, via [_onDeviceRinging].
  void noteCalleeLive(bool live) {
    if (!live || _ended || _connected || _deviceRinging) return;
    _calleeLive = true;
    _setDialStage('$_peerFirst is online — connecting…');
  }

  bool _calleeLive = false;

  /// [CALL-PRESENCE-1 2026-08-07] The server's HEARTBEAT verdict for the callee:
  /// `'fresh'`, `'stale'` or `'unknown'`.
  ///
  /// This is a DIFFERENT and stronger fact than [noteCalleeLive]. `callee_live`
  /// can only ever be true if the WS ring happened to land on an open socket
  /// during this call; `presence` is a standing record the callee's phone writes
  /// every ~25 s (POST /api/presence/beat), read by the server BEFORE it does any
  /// of its Durable Object round-trips.
  ///
  /// The SAME honesty rule as [noteCalleeLive] applies and is the reason this
  /// method does so little: FAKE-RING-HONEST-1. On 2026-07-22 a caller heard a
  /// full ringback while the callee's phone was unreachable, because a signal
  /// that merely *suggested* reachability was allowed to manufacture a ring. So
  /// this may only soften the waiting copy. It must NEVER start a ringback, set
  /// phase `ringing`, or claim their phone is ringing — only a real
  /// device-ringing receipt does that, via [_onDeviceRinging].
  ///
  /// `'unknown'` says nothing, deliberately. It is what an older client, a
  /// missing presence store, or a genuine read failure all produce, and inventing
  /// progress text for it is exactly the behaviour this change exists to delete.
  void notePresence(String presence) {
    if (_ended || _connected || _deviceRinging) return;
    if (presence == 'fresh') {
      _calleeLive = true;
      _setDialStage('$_peerFirst is online — connecting…');
      return;
    }
    if (presence == 'stale') {
      // A live socket is stronger evidence than a lapsed heartbeat; never
      // downgrade "online" to "waking" on the same call.
      if (_calleeLive) return;
      // Honest, and true: their phone is being woken by FCM, which takes seconds.
      _setDialStage("Waking $_peerFirst's phone…");
    }
  }

  void notePlaceResult(bool reachable,
      {bool prewarming = false, int? prewarmDeadlineMs}) {
    if (_ended || _connected) return;
    _placementResolved = true;
    if (!_placementFeedbackReady) {
      _pendingPlacementReachable = reachable;
      _pendingPlacementPrewarming = prewarming;
      _pendingPlacementPrewarmDeadlineMs = prewarmDeadlineMs;
      return;
    }
    if (!reachable) {
      _handoffAuthorityPoll?.cancel();
      _onRingAck(false);
      return;
    }
    _startHandoffAuthorityPoll();
    // [STREAM-CALL-PILOT-2] A provider decision is required before an
    // optimistic session can acquire media. Old workers do not send one, so
    // the documented compatibility default is Cloudflare. A Stream decision
    // is terminal for this call until Stream's native bridge is available —
    // never open the legacy room as a hidden mid-call fallback.
    _providerDecision ??= const CallProviderDecision.cloudflare(
        reason: 'missing_provider_defaults_cloudflare');
    if (_providerDecision!.usesStream) {
      _mediaStartRequested = true;
      unawaited(_startSelectedMedia());
      return;
    }
    if (!_mediaBooted && config.deferRing && StreamCallPilot.enabled) {
      _mediaStartRequested = true;
      _prejoinRequestedBeforeMedia = true;
      unawaited(_startSelectedMedia());
    }
    if (prewarming) {
      notePrewarming(deadlineMs: prewarmDeadlineMs);
      return;
    }
    // [CALL-PREJOIN-3 2026-08-18] START PUBLISHING HERE, not on the FCM
    // ring-ack. A 200 from /api/call means the backend has RECORDED both
    // participants — which is the only precondition the SFU seat write checks
    // (`CallRoom` 403s `not_a_participant` otherwise, the 2026-08-17 failure).
    // The ring-ack was correct but LATE: it arrives only after push token
    // fan-out completes, while the WebSocket ring can already have reached an
    // online callee — who may accept before the ack ever lands, which is
    // exactly the case where publishing early matters most. Ring-ack keeps
    // owning reachability and the no-answer window; it no longer gates media.
    if (_mediaBooted) {
      _maybeStartCallerPrejoin();
    } else if (config.deferRing && StreamCallPilot.enabled) {
      _prejoinRequestedBeforeMedia = true;
    }
    // A 200 from /api/call proves placement completed, not that FCM found a
    // live token or that the phone rang. Do not latch `_ringAckHandled`: the
    // consumer's later ok=false must still be able to fast-fail honestly, and
    // ok=true must still grant the full no-answer window. This timer replaces
    // the one deliberately omitted in start() for deferRing sessions, so slow
    // backend work can never consume the phone's 12-second wake allowance.
    if (!_takeoverGuard || _ringAckHandled || _deviceRinging) return;
    _deviceRingingTimer?.cancel();
    _deviceRingingTimer = Timer(const Duration(seconds: 12), () {
      if (_ended || _connected || _deviceRinging || _ringAckHandled) return;
      AvaLog.I.log(
          'call', 'Post-placement device ringing timeout: callee unreachable.');
      _goUnreachable('post_placement_wake_timeout');
    });
    Analytics.capture('call_device_wake_guard_armed', {
      'call_id': config.room,
      'source': 'placement_complete',
      'timeout_s': 12,
    });
  }

  /// The server intentionally skipped the human ring and routed straight to Ava.
  /// Connect directly; no local contact lookup or missed-call timer may
  /// reinterpret it.
  ///
  /// [reason] is the server's `routing_reason`:
  ///   • `'unknown_caller'` — the edge classified this caller against the
  ///     callee's synced contact directory (the original, and still the default
  ///     for older servers that send no reason).
  ///   • `'offline'` — [CALL-PRESENCE-1] the callee's heartbeat has lapsed AND
  ///     they have no wakeable device. Ringing them would be twenty seconds of
  ///     silence, so the server answered honestly and immediately instead.
  void noteServerReceptionistRoute([String reason = 'unknown_caller']) {
    if (_ended || _connected || _receptionistActive) return;
    _deviceRingingTimer?.cancel();
    _ringAckFallback?.cancel();
    _ringTimeout?.cancel();
    unawaited(_handoffToAva(reason));
  }

  /// [INSTANT-CALL-MOUNT-1] The place-call POST itself failed hard (network/DNS
  /// error) — drive the honest 'network-error' terminal (carrying the launch
  /// site's Retry affordance) instead of a silent hang or a fake ring. Mirrors
  /// the pre-mount abort the old awaited path performed before it ever mounted.
  void notePlaceFailed() {
    if (_ended || _connected) return;
    _placementResolved = true;
    if (!_placementFeedbackReady) {
      _pendingPlacementFailure = true;
      return;
    }
    _handoffAuthorityPoll?.cancel();
    _ringAckFallback?.cancel();
    _deviceRingingTimer?.cancel();
    _ringTimeout?.cancel();
    _endWith('network-error', reason: 'place-call-failed');
  }

  /// [CALL-RING-DELIVERED-1] The server confirms the ring frame reached a LIVE
  /// websocket on the callee's device — a couple of seconds sooner than FCM or
  /// the callee's own device-ringing receipt, which is what the caller's app
  /// was still waiting on for this narration. This is delivery to a live
  /// socket, NOT evidence the phone is physically ringing (only
  /// [_onDeviceRinging]'s genuine receipt may claim that — FAKE-RING-HONEST-1),
  /// so it may ONLY touch the dial-stage copy: no ringback, no phase change.
  /// Guarded on `_deviceRinging` so a straggling/duplicate frame can never
  /// supersede — or fight with — the real receipt once it lands.
  void _onRingDelivered() {
    if (_ended || _connected || _deviceRinging) return;
    if (_receptionistActive || _receptionist != null || _avaCountingDown)
      return;
    _setDialStage("Ringing $_peerFirst's phone…");
    Analytics.capture('call_ring_delivered_copy_applied', {
      'call_id': config.room,
    });
  }

  /// [CALL-4RINGS-1 2026-08-08] How many real ring CYCLES the callee's device has
  /// reported so far, and how many the server needs before Ava takes over. Both
  /// come from the server's `device-ringing` frame (the CallRoom is the only
  /// party that counts), so this is a mirror for honest UI — never a second,
  /// competing count that could disagree with the one that decides the handoff.
  int _ringCyclesHeard = 0;
  int _ringCyclesRequired = 0;

  void _onDeviceRinging([Map<String, dynamic>? frame]) {
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
    if (_connected || _ended || _silentTransportPrewarming) return;
    if (_deviceRinging) {
      // [CALL-4RINGS-1 2026-08-08] REPEAT RECEIPT — the callee's phone is on its
      // Nth ring cycle. This used to be an unconditional `return`, which was
      // correct when the receipt was a one-shot and every repeat was a duplicate.
      // Now a repeat is NEW INFORMATION and the caller's UI can finally reflect
      // real progress instead of narrating a stopwatch.
      _onRepeatRing(frame);
      return;
    }
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
    // [CALL-4RINGS-1] Seed the mirror from the server's own count. Absent (an
    // older Worker, or `callRealRingCount` off) it stays 0 and every repeat-ring
    // branch below is inert — which is exactly today's behaviour.
    _ringCyclesHeard = (frame?['ringCount'] as num?)?.toInt() ?? 0;
    _ringCyclesRequired = (frame?['ringsRequired'] as num?)?.toInt() ?? 0;

    AvaLog.I.log('call', 'Device ringing receipted.');

    // [DIAL-NARRATION-1] The phone is genuinely ringing — say so with delight,
    // then settle into the classic 'Ringing…' after a few seconds.
    _dialStage = "Ah — it's ringing!";
    for (final t in _dialStageTimers) {
      t.cancel();
    }
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

    _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 22));
  }

  /// [CALL-4RINGS-1 2026-08-08] A `device-ringing` frame for a ring cycle AFTER
  /// the first.
  ///
  /// THREE RULES, all of them things a previous version of this file got wrong:
  ///
  /// 1. DO NOT TOUCH THE RINGBACK. `playRingback` restarts the loop from zero;
  ///    calling it every ~6 s would chop the tone mid-cycle and produce an
  ///    audible stutter on the caller's ear. The ringback started on cycle 1 and
  ///    keeps running until something ends the call. The most this may do is
  ///    RE-ASSERT the audio ROUTE ([CALL-AUDIO-OWNER-1]) — no direct
  ///    `selectRoute` / `setSpeakerphoneOn`, and no tone restart.
  /// 2. DO NOT RE-ARM THE RING WINDOW. The server owns the deadline
  ///    ([CALL-ONE-DEADLINE-1]); a client that pushed its own timer out on every
  ///    receipt could outlive the server's handoff and fight it.
  /// 3. TRUST THE SERVER'S COUNT, never a local increment. The CallRoom is the
  ///    only party that decides what counts as a real ring (audible, not
  ///    DND-blocked, strictly increasing index). A caller-side `++` would drift
  ///    from it the first time a silent ring arrived, and then the caption would
  ///    be confidently wrong.
  void _onRepeatRing(Map<String, dynamic>? frame) {
    if (frame == null ||
        _receptionistActive ||
        _receptionist != null ||
        _avaCountingDown) return;
    final count = (frame['ringCount'] as num?)?.toInt() ?? 0;
    final required =
        (frame['ringsRequired'] as num?)?.toInt() ?? _ringCyclesRequired;
    // Stale or duplicate frame (the DO broadcasts to every socket, and a
    // reconnect can replay). Monotonic or nothing.
    if (count <= _ringCyclesHeard) return;
    _ringCyclesHeard = count;
    if (required > 0) _ringCyclesRequired = required;

    // Honest progress copy. Deliberately no "3 of 4" counter: the number of
    // rings is OUR mechanism, not something the caller asked to watch, and
    // showing it would make a delayed receipt look like a stall.
    // NOT on cycle 1. The first cycle's receipt lands within milliseconds of the
    // fast audibility-free receipt that set "Ah — it's ringing!", and stomping
    // that line instantly would delete the one moment of delight in the dial
    // sequence and replace it with something duller that says the same thing.
    // [DIAL-NARRATION-1]'s own 4 s timer clears it; from cycle 2 we take over.
    if (count >= 2) {
      if (_ringCyclesRequired > 0 && count >= _ringCyclesRequired) {
        _setDialStage('No answer — handing over to Ava…');
      } else {
        _setDialStage("Still ringing $_peerFirst…");
      }
    }

    // [CALL-AUDIO-OWNER-1] A long ring is exactly when something else
    // (boot_media finishing, an audio-focus change, another player) can quietly
    // move the route back to the earpiece under a tone that is still playing.
    // Re-assert the CURRENT intent — this starts and swaps nothing.
    unawaited(CallAudioController.instance.reassert('ring-cycle'));

    Analytics.capture('call_ring_cycle_caller', {
      'call_id': config.room,
      'ring_count': count,
      'rings_required': _ringCyclesRequired,
      'ring_index': (frame['ringIndex'] as num?)?.toInt() ?? -1,
      'audible': (frame['audible'] ?? 'unknown').toString(),
      'derived': frame['derived'] == true,
      'ringback_enabled': RemoteConfig.ringbackEnabled,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  [AVA-PREWARM-1] pre-warm the receptionist during the final rings
  // ─────────────────────────────────────────────────────────────────────────

  /// Schedule [_beginPrewarm] for ~[_prewarmLeadMs] before the server's ring
  /// deadline. Caller side, outgoing, audio-only, once per call. Guarded
  /// again (eligibility, config) at fire time in [_beginPrewarm] since prefs
  /// can still resolve between now and then.
  void _schedulePrewarm() {
    if (_prewarmScheduleAttempted) return;
    _prewarmScheduleAttempted = true;
    if (!config.outgoing || config.video || _businessFlow) return;
    if (!RemoteConfig.avaPrewarmEnabled) return;
    final deadline = _serverRingDeadlineMs;
    if (deadline == null) return;
    final delay =
        (deadline - _prewarmLeadMs) - DateTime.now().millisecondsSinceEpoch;
    // Too close to the deadline (or already past it) for a head start to be
    // worth the extra receptionist session — let the normal cold path handle
    // the handoff exactly as before.
    if (delay < 500) return;
    _prewarmTimer?.cancel();
    _prewarmTimer = Timer(Duration(milliseconds: delay), () {
      // ignore: unawaited_futures
      _beginPrewarm();
    });
  }

  /// Start a receptionist session in the background, held (buffered, silent)
  /// via [ReceptionistCall.beginHold]. Reuses the same eligibility signal the
  /// real no-answer handoff uses ([_receptionistAllowedFor]) — already
  /// resolved from the dial-time probe, so this adds no extra round trip. A
  /// failed/ineligible pre-warm is invisible: [_tryReceptionist] falls back to
  /// its normal cold start with no user-visible effect.
  Future<void> _beginPrewarm() async {
    if (_ended || _connected) return;
    if (_receptionistActive || _receptionist != null || _avaCountingDown)
      return;
    if (_prewarmCall != null) return; // already running
    if (!_receptionistAllowedFor(_callUnreachable ? 'unreachable' : 'missed'))
      return;
    final call = ReceptionistCall(
        calleeUid: config.seed,
        callId: config.room,
        activationMode: _callUnreachable
            ? 'unreachable'
            : (_receptMode == 'first_ring' ? 'first_ring' : 'rings'),
        speaker: _speaker,
        teamId: config.teamId,
        teamSlot: config.teamSlot);
    _armDeferredReceptAudio(call);
    _prewarmCall = call;
    _prewarmStartedAtMs = DateTime.now().millisecondsSinceEpoch;
    final deadline = _serverRingDeadlineMs;
    Analytics.capture('ava_prewarm_started', {
      'call_id': config.room,
      if (deadline != null)
        'ms_before_deadline': deadline - DateTime.now().millisecondsSinceEpoch,
    });
    var readyReported = false;
    call.onStatus = (s) {
      // Lightweight while pre-warmed: only track "ready" telemetry. The real
      // status handler (phase/gate wiring) is installed on adoption in
      // [_tryReceptionist] — [ReceptionistCall.avaLevel] is call-owned state
      // that survives the handler swap, so an already-live call is still
      // detected correctly at adoption (see [_armAvaLiveWatchdog]'s own
      // avaLevel check).
      if (s == 'live' && !readyReported) {
        readyReported = true;
        Analytics.capture('ava_prewarm_ready', {
          'call_id': config.room,
          'ms': DateTime.now().millisecondsSinceEpoch - _prewarmStartedAtMs!,
        });
      }
    };
    call.beginHold();
    final fut = call.start();
    _prewarmStartFuture = fut;
    final ok = await fut;
    if (!identical(_prewarmCall, call))
      return; // adopted/aborted/superseded already
    if (!ok) {
      _prewarmCall = null;
      _prewarmStartFuture = null;
      Analytics.capture(
          'ava_prewarm_aborted', {'call_id': config.room, 'reason': 'failed'});
    }
  }

  /// [CALL-RING-AUDIBLE-3 2026-08-09] Tell [call] not to open the device audio
  /// session inside `start()`, and wire the two read-only probes its
  /// `recept_engine_started` event reports with.
  ///
  /// WHY: [CALL-RING-AUDIBLE-2] proved the ringback tone is no longer stopped
  /// during the receptionist spin-up (prod call avatok-6e17cdc2, 2026-08-09
  /// 01:21 — `ringback_audible phase=prewarm playing=true` at both samples with
  /// an advancing position), yet the owner still heard it die at ~beep 7, at the
  /// exact second of `call_audio_owner_apply recept_prewarm_before/after`. The
  /// tone plays on `USAGE_VOICE_COMMUNICATION` (core/ringback_player.dart:150)
  /// and `startEngine` re-levels/re-routes precisely that output when it sets
  /// `MODE_IN_COMMUNICATION` and re-selects the communication device
  /// (AvaVoiceAudioPlugin.kt:461, :473-487) ~8s before the ring deadline. Moving
  /// that to the ava-live gate — which is already the one place the tone is
  /// stopped — collapses the attenuation window to zero.
  ///
  /// Flag OFF → not called, [ReceptionistCall.deferAudioStart] stays false and
  /// the audio session comes up inside `start()` exactly as it does today.
  void _armDeferredReceptAudio(ReceptionistCall call) {
    call.ringStartedAtMs = _startedAtMs;
    call.isAvaLiveGateOpen = () => _avaLiveGateOpen;
    if (!RemoteConfig.callRingAudibilityV1) return;
    call.deferAudioStart = true;
  }

  /// Abort a not-yet-adopted pre-warmed session (the callee answered, or the
  /// call ended for any other reason before the ring deadline). Side-effect
  /// free on the server — see [ReceptionistCall.abortPrewarm].
  Future<void> _abortPrewarm(String reason) async {
    final call = _prewarmCall;
    if (call == null) return;
    _prewarmCall = null;
    _prewarmStartFuture = null;
    _prewarmTimer?.cancel();
    Analytics.capture(
        'ava_prewarm_aborted', {'call_id': config.room, 'reason': reason});
    try {
      await call.abortPrewarm();
    } catch (_) {}
  }

  /// Stop the ringback tone on a receptionist-handoff FAILURE path (start()
  /// returned false, or the final ava-live-timeout miss) so a failed handoff
  /// can never loop the tone forever. A no-op if the tone already stopped at
  /// the ava-live gate (success raced the failure check).
  Future<void> _stopToneOnHandoffFailure(String reason) async {
    if (_avaLiveGateOpen) return;
    await _ringback.stop(reason: reason);
    Analytics.capture(
        'call_tone_stopped', {'call_id': config.room, 'reason': reason});
  }

  Future<void> _handoffToAva(String activationMode) async {
    _handoffAuthorityPoll?.cancel();
    // [AVA-PREWARM-1] The ringback tone now keeps playing through the whole
    // receptionist spin-up instead of being stopped into silence here — it is
    // stopped centrally at the moment Ava is provably about to be heard (the
    // ava-live gate, [_openAvaLiveGate]) or on a failure path below, never
    // blindly before the attempt. This is the fix for the 10-11.5s silent gap
    // between ringback stopping and Ava's first audio (prod
    // ava_recept_first_audio ms=9801/11461).
    final started = await _tryReceptionist(activationMode: activationMode);
    if (!started) {
      await _stopToneOnHandoffFailure('receptionist_failed');
      if (!_connected) {
        // [RECEPT-START-409-1] A 409 reattach_blocked means Ava is ALREADY live on
        // another leg of this exact call — ending with "Couldn't reach Ava" here was
        // a lie (the message IS being taken). End this duplicate leg quietly.
        if (_receptFailReason == 'reattach_blocked') {
          _endWith('ended', reason: 'recept-reattach-noop');
        } else if (_receptFailReason == 'insufficient_tokens' ||
            _receptFailReason == 'wallet_unavailable') {
          // The owner cannot fund Ava. Keep a clear, persistent caller message;
          // never mislabel this as a decline or offer another broken Ava button.
          _showOutcomeMenu('no-answer');
        } else {
          _endWith('declined', reason: 'receptionist-unavailable');
        }
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
      Analytics.capture(
          'ava_recept_suppressed_dup_session', {'call_id': config.room});
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
    // [CALL-LOG-TIME-1] Sticky twin of the flag above. `_receptionistActive` is
    // reset to false on every teardown path, so by the time the call log is
    // closed out it is always false and a call the caller spent two minutes on
    // with Ava would have been logged "Cancelled". This one is never cleared.
    _receptionistEverActive = true;
    // [AVA-PREWARM-1] Adopt an already-warming session instead of a cold
    // start when one exists and hasn't already died. `_prewarmCall` is only
    // ever non-null here because [_beginPrewarm] created it; a dead one
    // (start() failed) already cleared itself back to null, so `isEnded` only
    // needs to catch the abort/ended-after-check race.
    final warm = _prewarmCall;
    final isWarm = warm != null && !warm.isEnded;
    final warmStartFuture = _prewarmStartFuture;
    if (warm != null) {
      _prewarmCall = null;
      _prewarmStartFuture = null;
      _prewarmTimer?.cancel();
    }
    _handoffWasWarm = isWarm;
    try {
      try {
        _stream?.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      try {
        await _pc?.close();
      } catch (_) {}
      _pc = null;

      final call = isWarm
          ? warm!
          : ReceptionistCall(
              calleeUid: config.seed,
              callId: config.room,
              activationMode: activationMode,
              speaker: _speaker,
              teamId: config.teamId,
              teamSlot: config.teamSlot);
      // [CALL-RING-AUDIBLE-3] Cold start gets the same deferral as a pre-warm
      // (a warm one was already armed in [_beginPrewarm]; re-arming is
      // idempotent and just refreshes the gate probe onto this session).
      _armDeferredReceptAudio(call);
      // Publish the pending object BEFORE either async server request. Teardown
      // can now cancel a start that is still in flight instead of losing the
      // only reference and letting Ava begin after the caller hung up.
      _receptionist = call;
      // Replace the lightweight pre-warm status handler (if any) with the real
      // one below — [ReceptionistCall.avaLevel] is call-owned state that
      // survives the swap, so a 'live' frame that arrived while pre-warmed is
      // still picked up (via [_armAvaLiveWatchdog]'s own avaLevel check just
      // below, or immediately if the gate races open first).
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
            // ignore: unawaited_futures
            _openAvaLiveGate();
            break;
          case 'reconnecting':
            // [CALL-REL-7] The caller's WS to the receptionist DO dropped, but
            // Ava keeps listening/talking server-side — this is a transient
            // transport state, never an immediate end. Reuses the existing
            // 'Reconnecting…' phase label (call_session.dart _phaseLabel).
            _setPhase('reconnecting');
            break;
          case 'reconnected':
            // [CALL-REL-7] Socket reattached — resume whichever receptionist
            // phase we were honestly showing before the drop.
            if (_phase == 'reconnecting') {
              _setPhase(_avaLiveGateOpen
                  ? 'receptionist'
                  : 'receptionist-connecting');
            }
            break;
          case 'wrapup':
            // Ava reached her soft-cap → she is unambiguously live: open the
            // gate (if not already) then show the wrap-up line.
            // ignore: unawaited_futures
            _openAvaLiveGate();
            _setPhase('receptionist-wrapup');
            break;
          default:
            break;
        }
      };
      // [CALL-RING-AUDIBLE-2] The receptionist's audio session is about to come
      // up (ReceptionistCall._startAudio → `recept_prewarm_before` /
      // `startEngine` / `recept_prewarm_after`). This is the exact window the
      // owner reported as silent, so sample the tone here: `playing: true` with
      // an ADVANCING `position_ms` across the two samples is the success value
      // for this fix.
      if (RemoteConfig.callRingAudibilityV1) {
        _sampleRingAudible(isWarm ? 'prewarm' : 'recept_cold_start');
      }
      bool ok;
      if (isWarm) {
        // Already started (or still starting) in the background — just wait
        // for it. No on-screen 3-2-1 countdown for an adopted warm session:
        // the whole point of pre-warming is to skip that wait.
        ok = await (warmStartFuture ?? call.start());
      } else {
        _avaCountingDown = true;
        call.beginHold();
        final startFut = call.start();
        await _runAvaCountdown();
        ok = await startFut;
        _avaCountingDown = false;
      }
      if (!ok) {
        // [RECEPT-START-409-1] Keep the server's refusal reason so the caller
        // surface can distinguish "another leg already owns Ava for this call"
        // (benign 409 reattach) from a genuine receptionist outage.
        _receptFailReason = call.failReason;
        if (identical(_receptionist, call)) _receptionist = null;
        _receptionistActive = false;
        return false;
      }
      if (_ended || _teardownStarted) {
        await call.hangup();
        if (identical(_receptionist, call)) _receptionist = null;
        _receptionistActive = false;
        return false;
      }
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
      } else if (RemoteConfig.callRingAudibilityV1 && call.hasFirstAudio) {
        // [CALL-RING-AUDIBLE-3] A pre-warmed session that already rendered its
        // greeting (held/buffered, never heard) IS provably live — that is the
        // same deterministic proof `onStatus('live')` carries, and its handler
        // was the lightweight pre-warm one when it fired, so nothing opened the
        // gate. Waiting on the `avaLevel` meter here can miss it entirely: the
        // meter decays ~12x/s and Gemini sends nothing more until it hears the
        // caller — which, with the audio session now deferred, it cannot. That
        // would strand the tone until `ava_live_timeout`. Open the gate now:
        // the tone stops, the engine starts and her buffered greeting is
        // released, all at this one instant. The phase is set first because
        // [_openAvaLiveGate] only advances the label from
        // 'receptionist-connecting' (it must not stomp a wrapup/ended phase).
        _setPhase('receptionist-connecting');
        // ignore: unawaited_futures
        _openAvaLiveGate();
      } else {
        _setPhase('receptionist-connecting');
        _armAvaLiveWatchdog(call);
      }
      // [AVA-PREWARM-1] No unconditional release() here anymore — Ava's audio
      // stays held (buffered, silent) until the ava-live gate opens
      // ([_openAvaLiveGate]), which stops the ringback tone THEN releases her
      // audio, so the two can never overlap. If the gate already opened above
      // (a warm/fast call), the release already happened there.
      call.done.then((_) {
        if (!_ended) _endWith('ended', reason: 'receptionist-done');
      });
      return true;
    } catch (_) {
      try {
        await _receptionist?.hangup();
      } catch (_) {}
      _receptionist = null;
      _receptionistActive = false;
      _avaCountingDown = false;
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
        // ignore: unawaited_futures
        if (call.avaLevel.value > 0.02) _openAvaLiveGate();
      };
      call.avaLevel.addListener(_avaLevelListener!);
      _avaLevelSource = call;
      // Guard the race where audio already arrived before we attached (this is
      // exactly how an already-live pre-warmed session is caught on adoption).
      // ignore: unawaited_futures
      if (call.avaLevel.value > 0.02) {
        _openAvaLiveGate();
        return;
      }
    }
    _avaLiveWatchdog?.cancel();
    _avaLiveWatchdog = Timer(const Duration(milliseconds: _avaLiveTimeoutMs),
        () => _onAvaLiveTimeout(call));
  }

  /// The ava-live ack arrived (first Ava audio / ready frame). Open the gate:
  /// flip the confident "Ava is taking your call" status, stop the watchdog,
  /// and — [AVA-PREWARM-1] — this is now the ONE place the ringback tone
  /// stops for a successful handoff. `_avaLiveGateOpen` is set synchronously
  /// (before the first `await`) so a second concurrent caller (onStatus vs
  /// the avaLevel listener) sees it immediately and bails, same as before.
  /// The tone is stopped and AWAITED before releasing Ava's held audio, so the
  /// two can never overlap (CALL-REL-3) — this closes the 10-11.5s silent gap
  /// (prod ava_recept_first_audio ms=9801/11461) by moving the stop from
  /// "before we even try" to "the instant she's actually about to be heard".
  Future<void> _openAvaLiveGate() async {
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
    final toneStopStart = DateTime.now().millisecondsSinceEpoch;
    await _ringback.stop(reason: 'ava_live_gate');
    Analytics.capture('call_tone_stopped',
        {'call_id': config.room, 'reason': 'ava_live_gate'});
    // [CALL-RING-AUDIBLE-3] The tone is now stopped and awaited, so THIS is the
    // safe moment to switch the device into the in-call audio session
    // (`startEngine` → MODE_IN_COMMUNICATION + communication-device select),
    // which is what was quietly re-levelling the still-playing ringback when it
    // ran during pre-warm. Awaited before [release] so Ava's buffered first word
    // is fed into a fully-open engine rather than dropped on the floor.
    //
    // `speaker` is re-pinned first: a pre-warmed ReceptionistCall captured the
    // route at CONSTRUCTION time and `setSpeaker` is only ever routed to
    // `_receptionist` (call_session:6793/6825), which is null while it is still
    // `_prewarmCall` — so a Speaker press during the pre-warm window never
    // reached it. This is a plain field write, not a route request:
    // CallAudioController remains the single route owner.
    final recept = _receptionist;
    if (recept != null && recept.deferAudioStart) {
      recept.speaker = _speaker;
      await recept.startAudioNow();
    }
    _receptionist?.release();
    Analytics.capture('ava_takeover_warm', {
      'call_id': config.room,
      'gap_ms': DateTime.now().millisecondsSinceEpoch - toneStopStart,
      'warm': _handoffWasWarm,
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
      _avaLiveWatchdog = Timer(const Duration(milliseconds: _avaLiveTimeoutMs),
          () => _onAvaLiveTimeout(call));
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
    // [AVA-VM-FALLBACK-1 2026-08-08] AN AVA TIMEOUT MUST NEVER END THE CALL.
    //
    // What used to happen here (prod avatok-946b6090, 2026-08-07 20:52 IST) was
    // `_endWith('receptionist-unavailable', reason: 'ava-live-timeout')` — the
    // owner was mid-way through leaving a voicemail, had not spoken a word, and
    // the app hung up on him. A recording that works beats an assistant that
    // doesn't, so before any terminal state we ask the ALREADY-OPEN session to
    // degrade to a plain recorder. The audible confirmation is the flow's own
    // greeting + beep, and the recording lands through the identical
    // `finalize()` every other receptionist voicemail uses.
    if (RemoteConfig.avaVoicemailFallbackV1 &&
        !_ended &&
        !_connected &&
        !call.hasFirstAudio &&
        !_avaVmFallbackActive &&
        call.requestVoicemailFallback('live_timeout')) {
      _avaVmFallbackActive = true;
      _avaVmFallbackAtMs = DateTime.now().millisecondsSinceEpoch;
      call.onVmFallbackResult = (stored, recordedMs) => _emitAvaVmFallback(
          'live_timeout',
          stored: stored,
          recordedMs: recordedMs);
      // Re-arm on a LONGER window pointed at a DIFFERENT handler. The
      // deterministic greeting is a cached R2 render and the beep is generated
      // locally with no dependency at all, so if nothing arrives inside this
      // window there is genuinely nothing left to try — and `_avaLiveAttempt`
      // is pushed past 2 so a stray re-arm cannot re-enter the retry branch
      // above and start the whole ladder again.
      _avaLiveAttempt = 3;
      _avaLiveConnecting = true;
      _avaLiveWatchdog?.cancel();
      _avaLiveWatchdog = Timer(
          const Duration(milliseconds: _avaVmFallbackTimeoutMs),
          () => _onAvaVmFallbackTimeout(call));
      return;
    }
    _clearAvaLiveGate();
    // [AVA-PREWARM-1] The gate never opened, so the tone never stopped —
    // stop it now on this final-failure path so a dead handoff can never loop
    // the ringback forever.
    await _stopToneOnHandoffFailure('receptionist_failed');
    // Tear down the dead receptionist leg so it can't linger under the fallback.
    try {
      call.hangup();
    } catch (_) {}
    _receptionist = null;
    _receptionistActive = false;
    // [RECEPT-SETTINGS-1] voicemail removed — when the receptionist can't go live
    // there is no free-voicemail fallback; surface an HONEST end state rather than
    // dead air.
    if (!_ended && !_connected) {
      _endWith('receptionist-unavailable', reason: 'ava-live-timeout');
    }
  }

  // ── [AVA-VM-FALLBACK-1 2026-08-08] state ───────────────────────────────────

  /// True once the degrade-to-recorder frame has gone out for this call.
  bool _avaVmFallbackActive = false;
  int _avaVmFallbackAtMs = 0;
  bool _avaVmFallbackReported = false;

  /// How long to wait for the deterministic greeting/beep after asking for the
  /// fallback. Generous compared with [_avaLiveTimeoutMs] because this is the
  /// LAST thing we try: the greeting is an R2 cache read and the beep needs
  /// nothing at all, so a miss here means the socket itself is dead, not that
  /// a model is slow.
  static const int _avaVmFallbackTimeoutMs = 10000;

  /// Emit `ava_vm_fallback` exactly once. Carries BOTH parties (`peer_uid` is
  /// the callee whose receptionist took the message; the Analytics envelope
  /// carries this device's own identity) so either email retrieves the
  /// interaction, per CLAUDE.md's two-sided telemetry rule.
  void _emitAvaVmFallback(String trigger,
      {required bool stored, required int recordedMs}) {
    if (_avaVmFallbackReported) return;
    _avaVmFallbackReported = true;
    Analytics.capture('ava_vm_fallback', {
      'call_id': config.room,
      'trigger': trigger, // 'live_timeout' | 'connect_failed' | 'no_audio'
      'recorded_ms': recordedMs,
      'stored': stored,
      'fallback_wait_ms': _avaVmFallbackAtMs == 0
          ? -1
          : DateTime.now().millisecondsSinceEpoch - _avaVmFallbackAtMs,
      'activation_mode': _receptionist?.activationMode ?? '',
      if (config.seed.isNotEmpty) 'peer_uid': config.seed,
      if (_mySeed.isNotEmpty) 'caller_uid': _mySeed,
    });
  }

  /// The fallback recorder never produced its greeting or beep either. NOW the
  /// call is genuinely out of options — end it honestly, with a reason that says
  /// the fallback was tried rather than blaming the live agent alone.
  Future<void> _onAvaVmFallbackTimeout(ReceptionistCall call) async {
    if (_ended || _avaLiveGateOpen) return;
    _emitAvaVmFallback('live_timeout', stored: false, recordedMs: 0);
    _clearAvaLiveGate();
    await _stopToneOnHandoffFailure('receptionist_failed');
    try {
      call.hangup();
    } catch (_) {}
    _receptionist = null;
    _receptionistActive = false;
    if (!_ended && !_connected) {
      _endWith('receptionist-unavailable', reason: 'ava-vm-fallback-timeout');
    }
  }

  /// Detach the avaLevel listener + cancel the watchdog. Safe to call repeatedly.
  void _clearAvaLiveGate() {
    _avaLiveWatchdog?.cancel();
    _avaLiveWatchdog = null;
    _avaLiveConnecting = false;
    final l = _avaLevelListener;
    if (l != null) {
      try {
        _avaLevelSource?.avaLevel.removeListener(l);
      } catch (_) {}
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

  /// Memoize teardown so menu close, redial, and a terminal timer can all await
  /// the same native-resource shutdown rather than launching competing closes.
  Future<void> _teardown({String? reason}) {
    return _teardownFuture ??= _teardownImpl(reason: reason);
  }

  Future<void> _teardownImpl({String? reason}) async {
    if (_ended || _teardownStarted) return;
    _teardownStarted = true;
    // ── [CALLREC-STOP-ON-END-1] Finalize this call's recording WITH the call ──
    //
    // On 2026-08-08 (call avatok-85dc200b) nothing stopped the recorder when
    // the call ended: stop() was only ever wired to the record BUTTON. The
    // session died, both leg taps stalled 4s later, the zombie session then
    // refused recording on the NEXT call ("A recording is already running",
    // owner screenshot 18:14 IST), and the audio was only salvaged 30+ minutes
    // later by orphan recovery — as an unattributed "Call with Unknown" card.
    //
    // stop() finalizes and SAVES (never discards), is idempotent through
    // `_busy`, and remuxes off the call path — unawaited so teardown never
    // blocks on it. The one deliberate exemption is a group escalation, whose
    // design keeps the recorder running across this very teardown
    // (make-before-break; see markEscalatedToGroup).
    if (CallRecordingStore.I.activeCallId.value == config.room &&
        CallRecordingStore.I.phase.value == CallRecordingPhase.recording &&
        !CallRecordingStore.I.isEscalated(config.room)) {
      unawaited(Analytics.capture('callrec_auto_stop', {
        'call_id': config.room,
        'rec_id': 'callrec:${config.room}',
        'teardown_reason': reason ?? '',
      }));
      unawaited(CallRecordingStore.I.stop());
    }
    // [CALL-LOG-TIME-1] Close the call-history row HERE as well as in `_endWith`.
    // `_endWith` is NOT the common end path: the red button goes
    // `endByUser()` → `hangup()` → here and never touches `_endWith` at all, so
    // hooking only `_endWith` would have left every normal conversation — the
    // one case with a duration worth showing — without one. `_finishCallLog` is
    // idempotent, so the `_endWith` call (which knows the terminal PHASE and can
    // therefore say Declined/No answer/Busy) still wins when it ran first; this
    // is the backstop that maps from the phase we're currently in.
    _finishCallLog(_phase);
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
    // ── [CALL-GHOST-RING-1 2026-08-05] Mark this call terminated. FIRST. ─────
    //
    // `applyRingTransition` calls itself "THE ONE CLEANUP PATH", and it is —
    // it stamps `_terminalCallAt`, ends the CallKit call, dismisses the branded
    // FSI, stops the fallback ringtone, clears the glare globals, and clears
    // MainActivity's queued native tap. Every ring-ENDING path funnels through
    // it. Every path except the most common one: hanging up.
    //
    // `endByUser()` did `_telemetry.ended(...)` then `hangup(...)`, and neither
    // touched the reducer. So for a call the user ended, `wasCallTerminated()`
    // stayed FALSE and the native pending tap was never cleared — which made
    // every downstream "has this call ended?" guard a no-op, including the two
    // inside `_routeToBrandedIncoming`. On 2026-08-04 a stale tap for
    // avatok-528020ce drained 34 SECONDS after the user hung up and put a
    // full-screen incoming-call surface plus a status-bar notification back on
    // screen for a finished conversation.
    //
    // Placed at the TOP of teardown, before any await, because the ghost landed
    // INSIDE the teardown window — the guards have to be armed before the slow
    // part starts, not after it. Idempotent: with no `seq` the reducer returns
    // early when it has already run for this call, so the remote-bye path
    // (which does reach it via the DO socket) is unaffected.
    unawaited(() async {
      try {
        await applyRingTransition(config.room, 'ended',
            source: 'local_teardown');
      } catch (_) {/* never let cleanup bookkeeping block a hangup */}
    }());
    // [CALL-GHOST-RING-1] Both of these were UNBOUNDED awaits sitting directly
    // in the teardown path — the only two that weren't wrapped in `_safeAwait`.
    // The same 2026-08-04 call took 39s from `call_ended` to `call_teardown_slow`
    // (threshold: 5s), and that long tail is the window the ghost ring appeared
    // in. A receptionist or prewarm socket that refuses to close must not be
    // able to hold a hang-up open; 2s matches every other teardown step.
    await _safeAwait(() => _receptionist?.hangup() ?? Future.value());
    // [AVA-PREWARM-1] The call is ending (any reason) before the ring
    // deadline ever took over the pre-warmed session — abort it so it leaves
    // no trace. Also cancel a still-pending prewarm timer so a superseded
    // session's leftover Timer can't fire after teardown.
    _prewarmTimer?.cancel();
    if (_prewarmCall != null) {
      await _safeAwait(() => _abortPrewarm('call_ended'));
    }
    try {
      WakelockPlus.disable();
    } catch (_) {}
    // CALL-REL-1: one `endP2pSession` call replaces the scattered stop calls
    // when the controller owns the session. It is safe even if setup only
    // partially completed. Flag off keeps the exact prior teardown sequence.
    // Stop a queued focus-route retry before releasing audio ownership; a
    // teardown can await several native calls before `_ended` flips true.
    _focusRouteRecoveryTimer?.cancel();
    _focusRouteRecoveryTimer = null;
    // [CALL-AUDIO-OWNER-1] Release the controller's ownership of this call's
    // route before/with the session teardown, so a straggling apply from a
    // just-ended call can never reach into whatever call comes next.
    CallAudioController.instance.release(config.room);
    if (RemoteConfig.callAudioOwnerV1 || RemoteConfig.callAudioControllerV2) {
      await _safeAwait(
          () => NativeVoiceAudio.instance.endP2pSession(callId: config.room));
    } else {
      await _safeAwait(() => NativeVoiceAudio().stopP2pAudioMode());
      await _safeAwait(() => NativeVoiceAudio().stopBluetoothSco());
      await _safeAwait(() => NativeVoiceAudio().stopProximitySensor());
    }
    await _safeAwait(() => NativeVoiceAudio.instance
        .stopCallForegroundService(reason: reason ?? 'hangup'));
    await _safeAwait(() => NativeVoiceAudio().stopTelephonyMonitoring());
    _telephonySub?.cancel();
    // [CALL-FOCUS-DEADLOCK-1] Kill the release watchdog with the session, so a
    // torn-down call can never un-mute into the next one.
    _focusHoldWatchdog?.cancel();
    _focusHoldWatchdog = null;
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
      gOutgoingCallTo = null;
      gOutgoingCallId = null;
      gOutgoingSince = 0;
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
    _handoffAuthorityPoll?.cancel();
    _ringAckFallback?.cancel();
    _deviceRingingTimer?.cancel();
    for (final t in _dialStageTimers) {
      t.cancel();
    } // [DIAL-NARRATION-1]
    _dialStageTimers.clear();
    _failTimer?.cancel();
    _wsReconnectTimer?.cancel();
    _relayFallbackTimer?.cancel();
    _placeCallTimeout?.cancel();
    _netSub?.cancel();
    _statusSub?.cancel();
    // [CALLREC-PEER-1] Stop announcing for a call that is over, and clear the
    // peer's indicator so a stale "is recording" can never outlive the call.
    _detachRecordingBridge();
    peerRecording.value = false;
    // CALL-RC-D2: cancel every reconnect/ping timer so nothing keeps firing
    // after teardown (acceptance criterion — no leaked timers post-hangup).
    _reconnecting = false;
    _reconnectRetryTimer?.cancel();
    _reconnectGiveUpTimer?.cancel();
    _stopPingTimer();
    // [CALL-MEDIA-WATCH-1]
    _stopMediaWatchdog();
    _stopPlayoutHealthSampler(); // [CALL-REL-4]
    // [CALL-DEADAIR-1] A call that ends before audio ever flowed is the WORST
    // case, and it must not be the silent one. Emit the outstanding measurement
    // now (only when the probe actually ran, so an unanswered ring is unaffected)
    // rather than dropping it with the timer.
    _stopFirstAudioProbe();
    if (_firstAudioProbeStartMs > 0 && !_firstAudioReported) {
      _reportFirstAudio(bytes: 0, outcome: 'ended');
    }
    _emitSetupSummary(reason ?? (_connected ? 'ended' : _phase));
    // [CALL-AUDIBLE-1] A call that ends before audibility ever flipped must
    // not leak the listener or the 4s safety timer past teardown.
    _audibleSafetyTimer?.cancel();
    _audibleSafetyTimer = null;
    // [CALL-AUDIBLE-2] Same for the pc-path playout probe.
    _stopAudiblePlayoutProbe();
    if (_audibleGateArmed) {
      audioFlowing.removeListener(_onAudioFlowingForGate);
      _audibleGateArmed = false;
    }
    // [AVA-VM-FALLBACK-1] The fallback ran but the DO's receipt never arrived
    // (socket died, app killed). Report what we know rather than nothing — an
    // absent event and a failed fallback must not look the same.
    if (_avaVmFallbackActive && !_avaVmFallbackReported) {
      _emitAvaVmFallback('live_timeout', stored: false, recordedMs: 0);
    }
    _recoveryDeadlineTimer?.cancel(); // [CALL-REL-5]
    _activeRecovery = null;
    _survivalRetryTimer?.cancel(); // [CALL-SURVIVE-1]
    // [CALL-SFU-SURVIVE-1] The SFU ladder has its own timer (see the field doc
    // for why it is not shared); teardown must cancel it too or a backoff of up
    // to 30s outlives the call and fires `_reconnectSfu` on a dead session.
    _sfuRetryTimer?.cancel();
    _sfuRetryPending = false;
    _netDebounceTimer?.cancel(); // [CALL-SURVIVE-2]
    _migrationDeadlineTimer?.cancel(); // [CALL-REL-6]
    await _safeAwait(() => _activeMigration?.newPc?.close());
    _activeMigration = null;
    // [CALL-PREJOIN-1 2026-08-16] Covers hangup-while-ringing (caller cancels
    // before the callee ever accepts) — the one teardown path none of the
    // election-site discards above can reach. No-ops if already
    // adopted/discarded.
    await _discardPrejoinedSfu('call_ended');
    await _safeAwait(() => _sfu?.dispose());
    _sfu = null;
    _sfuActive = false;
    _sfuStarting = false;
    _prewarmAudioPending = false;
    // [CALL-RTK-3] The RealtimeKit leg has exactly one teardown path, here,
    // beside the SFU's. `RtcSession.leave()` is documented idempotent, and it
    // is wrapped in _safeAwait for the same reason everything else in this
    // teardown is: a call that will not end is worse than a leaked session.
    await _cancelRtkEvents(); // [CALL-RTK-4] before leave(): leave() emits.
    await _safeAwait(() => _rtk?.leave());
    _rtk = null;
    _rtkActive = false;
    _rtkStarting = false;
    final streamEvents = _streamRtcEvents;
    _streamRtcEvents = null;
    if (streamEvents != null) await _safeAwait(() => streamEvents.cancel());
    await _safeAwait(() => _streamRtc?.leave());
    _streamRtc = null;
    _streamRtcActive = false;
    _streamRtcStarting = false;
    await _safeAwait(() => FlutterCallkitIncoming.endCall(config.room));
    // [ADDCALL-2-UI] The ONE place the capture stream survives this teardown.
    //
    // Read ONCE, here, so the stop and the dispose below can never disagree
    // with each other (the borrower could in principle drop its claim between
    // the two, which would stop the tracks and then leak the stream object).
    // Everything else in this teardown is unchanged: the PC still closes, the
    // socket still closes, the renderers still detach and dispose. Only the two
    // lines that would silence a conference publishing these exact tracks are
    // conditional — and only while a borrower is actively claiming ownership.
    // See [loanCaptureStream]. For every ordinary call this is false and the
    // sequence is byte-for-byte what it has always been.
    final loanedOut = _captureStreamLoaned;
    if (loanedOut) {
      Analytics.capture('addcall_capture_stream_survived_teardown', {
        'call_id': config.room,
        'reason': reason ?? 'hangup',
      });
    } else {
      try {
        _stream?.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    }
    await _safeAwait(() => _pc?.close(), ms: 3000);
    await _safeAwait(() => _ws?.sink.close());
    try {
      localRenderer.srcObject = null;
    } catch (_) {}
    try {
      remoteRenderer.srcObject = null;
    } catch (_) {}
    remoteVideoActive.value = false;
    remoteVideoStatus.value = 'idle';
    if (!loanedOut) await _safeAwait(() => _stream?.dispose());
    _captureLoanCheck = null;
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
    PushService.clearAcceptedAtMsFor(config.room);
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
        'connected' => _onCellularHold
            ? 'On hold — cellular call'
            : 'Connected · end-to-end encrypted',
        'declined' => 'Call declined',
        'busy' => 'User is busy',
        'no-answer' => 'No answer',
        // [DIALPAD-BIZ-CALLS Phase C] the view swaps in the live agent panel;
        // this line only shows for the brief connect window.
        'agent-handoff' => "Connecting you to $_peerFirst's Ava AI agent…",
        // [CALL-OUTCOME-MENU-1] honest per-scenario status header (spec §1).
        'outcome-menu' => switch (_menuScenario) {
            'busy' => '$_peerFirst is busy on another call',
            'unreachable' =>
              "$_peerFirst's phone appears to be off or unreachable",
            'declined' => "$_peerFirst can't take your call right now",
            'no-answer' => 'User is not answering. Please try after sometime.',
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
