/// Provider-agnostic RTC abstraction boundary.
///
/// Per `Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md` §4.7 ("Provider-agnostic
/// `RtcProvider` — the minimum viable contract") and the client `RtcProvider`
/// sketch in §1 / Part C: this is the seam that makes Cloudflare Realtime SFU
/// → Jitsi → LiveKit a **config flip**, never a client rewrite. Concrete
/// providers (Cloudflare Realtime, Jitsi, LiveKit, a test `mock`) implement
/// [RtcProvider]/[RtcSession] in their own files; **no Cloudflare/Jitsi/
/// LiveKit-specific type may leak past this file** — call sites only ever see
/// [RtcProvider], [RtcSession], [RtcJoinTicket], [RtcCapabilities],
/// [RtcStatsSnapshot], [RtcMode] and [RtcSessionEvent].
///
/// Phase A skeleton only: pure interface + data classes, no implementation,
/// not wired anywhere yet. 1:1 calls stay on the existing P2P `CallSession`
/// (`app/lib/core/calls/call_session.dart`); this abstraction is for the
/// group/SFU path (§4 Part C) and future provider migrations. Server-side
/// enforcement (e.g. rejecting a video publish while `audioLocked`) happens
/// **through the provider adapter**, per §4.6 — never trust the client alone.
library;

/// Wire-level call mode, mirroring the server-authoritative `media_mode`
/// enum in §8B.3 (`audio · video · audio_locked`) and the mode state machine
/// in §4 Part C (`VIDEO | AUDIO_LOCKED`). `audioLocked` is a one-way degrade
/// for the remainder of the call (owner decision D7) — a session never moves
/// back from `audioLocked` to `video` mid-call; a new call starts fresh.
enum RtcMode {
  audio('audio'),
  video('video'),
  audioLocked('audio_locked');

  const RtcMode(this.wireValue);

  /// The exact snake_case string sent to/received from the server and used
  /// in telemetry (`media_mode`), per §8B.1/§8B.3.
  final String wireValue;

  static RtcMode fromWire(String value) {
    for (final m in RtcMode.values) {
      if (m.wireValue == value) return m;
    }
    throw ArgumentError.value(value, 'value', 'Unknown RtcMode wire value');
  }
}

/// Lifecycle/quality events an [RtcSession] emits, normalized across
/// providers per §4.7 ("Events"). Concrete adapters translate their native
/// SDK callbacks into exactly these — callers never branch on provider name.
enum RtcSessionEvent {
  /// Initial join to the room/session completed.
  connected,

  /// Transport dropped and the provider is attempting to recover in place
  /// (distinct from a full re-join).
  reconnecting,

  /// Session ended — locally initiated, provider-initiated, or transport
  /// loss that exhausted recovery. See [RtcSession.leave].
  disconnected,

  /// A remote participant joined the room.
  remoteJoin,

  /// A remote participant left the room.
  remoteLeave,

  /// A remote track (audio or video) was added.
  trackAdded,

  /// A remote track (audio or video) was removed.
  trackRemoved,

  /// Normalized stats crossed a provider-defined quality threshold (e.g.
  /// packet loss / RTT degraded materially). Distinct from [degraded], which
  /// is this abstraction's higher-level "something is wrong" signal.
  qualityChanged,

  /// Server or provider changed this session's [RtcMode] (e.g. an
  /// audio-lock enforced server-side per §4.6).
  modeChanged,

  /// Media/connection quality degraded enough to warrant surfacing to the
  /// call UI (distinct from a hard [error]).
  degraded,

  /// A provider-level error occurred. Callers should read [RtcSession.stats]
  /// / provider-specific error surfaces (outside this abstraction) for
  /// detail; this event only signals that one happened.
  error,
}

/// A join credential handed to the client by the server for a group/SFU
/// call, carrying enough for [RtcProvider.join] to connect without the
/// client ever constructing a provider-specific URL or token itself.
///
/// Mirrors the signed ticket fields described in §4.5 (HMAC ticket:
/// `call_id, participant_uid, generation, role, expiry, nonce, signature`)
/// narrowed to what the CLIENT needs to open a transport connection; the
/// server retains and validates the full signed ticket.
class RtcJoinTicket {
  const RtcJoinTicket({
    required this.provider,
    required this.url,
    required this.token,
    required this.mode,
    required this.callId,
  });

  /// Which concrete provider this ticket is for (`cloudflare · jitsi ·
  /// livekit · mock`, per the `rtc_provider` enum in §8B.3). The client
  /// looks this up to pick the matching [RtcProvider] implementation; it
  /// never has to parse [url]/[token] to figure out the provider.
  final String provider;

  /// Provider connection endpoint (SFU/room URL) issued by the server.
  final String url;

  /// Opaque, provider-specific, time-limited join credential issued by the
  /// server. Never a raw API/account secret — always short-lived per call.
  final String token;

  /// The mode this session should join in. May be downgraded from the
  /// caller's request (e.g. to [RtcMode.audioLocked]) if the server already
  /// applied a one-way degrade (§4.6) before minting this ticket.
  final RtcMode mode;

  /// The call this ticket is valid for. Used for correlation/telemetry
  /// (`call_id`, `call_trace_id` propagation per §8B.1) and must match the
  /// session the client believes it is joining.
  final String callId;
}

/// Normalized, per-provider-agnostic connection/media health snapshot.
///
/// Field set mirrors §4.7 ("Normalized stats") plus the ICE/candidate detail
/// used for `client_sfu_latency_snapshot` (§8B.9): `rtt · packet_loss ·
/// jitter · mos · available_bitrate · audio_level · encode_latency ·
/// decode_latency · publish_state · subscribe_state · ice_state ·
/// candidate_type(relay|direct)`. Every concrete provider adapter is
/// responsible for mapping its native stats API onto this shape so caller
/// code (UI HUD, telemetry) never touches a provider-specific stats type.
class RtcStatsSnapshot {
  const RtcStatsSnapshot({
    this.rttMs = -1,
    this.jitterMs = -1,
    this.packetLossPct = -1,
    this.mos = -1,
    this.audioBitrateKbps = 0,
    this.videoBitrateKbps = 0,
    this.availableBitrateKbps = 0,
    this.audioLevel = -1,
    this.encodeLatencyMs = -1,
    this.decodeLatencyMs = -1,
    this.publishState = RtcTransportState.unknown,
    this.subscribeState = RtcTransportState.unknown,
    this.iceState = RtcIceState.unknown,
    this.candidateType = RtcCandidateType.unknown,
  });

  /// Round-trip time in ms, -1 if unknown. Same convention as the existing
  /// `CallNetStats.rttMs` in `call_session.dart`.
  final int rttMs;

  /// Jitter in ms, -1 if unknown.
  final int jitterMs;

  /// Packet loss percentage (0-100), -1 if unknown.
  final double packetLossPct;

  /// Mean Opinion Score estimate (typically 1.0-4.5), -1 if unavailable —
  /// not all providers expose this.
  final double mos;

  /// Current outbound audio bitrate in kbps.
  final int audioBitrateKbps;

  /// Current outbound video bitrate in kbps (0 when audio-only/locked).
  final int videoBitrateKbps;

  /// Provider-estimated available send bitrate in kbps (bandwidth estimate).
  final int availableBitrateKbps;

  /// Local mic input level, provider-normalized 0.0-1.0, -1 if unknown.
  final double audioLevel;

  /// Encode latency in ms, -1 if unknown/not exposed.
  final int encodeLatencyMs;

  /// Decode latency in ms, -1 if unknown/not exposed.
  final int decodeLatencyMs;

  /// Publish (uplink) transport state.
  final RtcTransportState publishState;

  /// Subscribe (downlink) transport state.
  final RtcTransportState subscribeState;

  /// ICE connection state, normalized across providers.
  final RtcIceState iceState;

  /// Whether the active candidate pair is relayed (TURN) or a direct path —
  /// feeds `relay_used`/`candidate_type` in `client_sfu_latency_snapshot`
  /// (§8B.9) and the geo-placement RTT metric (§4.8).
  final RtcCandidateType candidateType;
}

/// Normalized publish/subscribe transport state, provider-agnostic.
enum RtcTransportState { unknown, connecting, connected, disconnected, failed }

/// Normalized ICE connection state, provider-agnostic.
enum RtcIceState { unknown, checking, connected, completed, disconnected, failed, closed }

/// Whether the active candidate pair is a direct path or relayed via TURN,
/// per §4.7/§4.8 (`candidate_type(relay|direct)`).
enum RtcCandidateType { unknown, direct, relay }

/// Provider capability flags, per §4.7 ("Capability flags") — "so client
/// code never checks provider *names*." Callers gate UI affordances (e.g.
/// showing a "record" button) on these flags, never on [RtcProvider.name].
class RtcCapabilities {
  const RtcCapabilities({
    required this.supportsSimulcast,
    required this.supportsDynacast,
    required this.supportsServerMute,
    required this.supportsRecording,
    required this.supportsScreenshare,
    required this.maxParticipants,
    required this.maxPublishedTracks,
    required this.maxSubscriptions,
  });

  /// Provider can publish multiple encoded resolutions/qualities of a video
  /// track and let subscribers choose (or the SFU choose for them).
  final bool supportsSimulcast;

  /// Provider can dynamically stop encoding unused simulcast layers
  /// (Dynacast) to save uplink cost.
  final bool supportsDynacast;

  /// Provider can force-mute a remote participant's publish server-side
  /// (used for moderation / enforcement, distinct from client self-mute).
  final bool supportsServerMute;

  /// Provider supports server-side room recording.
  final bool supportsRecording;

  /// Provider supports screen-share as a publishable track.
  final bool supportsScreenshare;

  /// Maximum participants this provider/plan allows in one room. Group
  /// conferences are capped at 25 by product rule regardless of a higher
  /// provider ceiling (see CLAUDE.md 2026-06-10 rule change); this field is
  /// the provider's own ceiling, not the product cap.
  final int maxParticipants;

  /// Maximum tracks this client may publish simultaneously (e.g. mic + cam
  /// + screenshare).
  final int maxPublishedTracks;

  /// Maximum tracks this client may subscribe to simultaneously.
  final int maxSubscriptions;
}

/// A single active connection to a room/session on some [RtcProvider].
/// Created by [RtcProvider.join] and torn down exactly once via [leave].
///
/// Mirrors the "1.1 Client `RtcProvider` interface" sketch: publish
/// local mic/cam, observe remote tracks, switch [RtcMode], read normalized
/// stats, and observe lifecycle via [events]. Concrete implementations wrap
/// a provider SDK's peer/room/session object; none of that leaks through
/// this interface.
abstract class RtcSession {
  /// The call this session belongs to (echoes [RtcJoinTicket.callId]).
  String get callId;

  /// The mode this session is currently operating in. May differ from the
  /// mode requested at [RtcProvider.join] if the server enforced a
  /// server-side degrade (e.g. [RtcMode.audioLocked]) after join.
  RtcMode get mode;

  /// Start (or resume) publishing the local microphone track.
  Future<void> publishMic({required bool enabled});

  /// Start (or resume) publishing the local camera track. Providers MUST
  /// reject this (per §4.6) when the session is [RtcMode.audioLocked] —
  /// enforcement happens at the provider/SFU, not here.
  Future<void> publishCam({required bool enabled});

  /// Remote tracks becoming available/unavailable over this session's
  /// lifetime. The event type on each [RtcSessionEvent] distinguishes
  /// [RtcSessionEvent.trackAdded] from [RtcSessionEvent.trackRemoved]; the
  /// concrete provider/track payload itself is intentionally NOT part of
  /// this abstraction (it stays provider-specific and is exposed by the
  /// implementing class via its own typed members).
  Stream<RtcSessionEvent> get remoteTrackEvents;

  /// All lifecycle/quality events for this session (connected, reconnecting,
  /// disconnected, remote join/leave, track added/removed, quality/mode
  /// changed, degraded, error) — the normalized event set from §4.7.
  Stream<RtcSessionEvent> get events;

  /// Request a mode change (e.g. downgrading to audio-only). The provider
  /// adapter is responsible for actually stopping/rejecting video publish
  /// when moving to/already in [RtcMode.audioLocked].
  Future<void> setMode(RtcMode mode);

  /// A synchronous snapshot of the current normalized connection/media
  /// stats. Implementations should cache the latest poll rather than block.
  RtcStatsSnapshot stats();

  /// Leave the room and release all provider resources. Idempotent — safe
  /// to call more than once. This is the single teardown path for a
  /// session, mirroring the "[hangup] is the single teardown path" pattern
  /// used by `CallSession` in `call_session.dart`.
  Future<void> leave();
}

/// The provider-agnostic entry point: given a server-issued [RtcJoinTicket],
/// produce a connected [RtcSession]. Exactly one concrete implementation
/// exists per provider (Cloudflare Realtime, Jitsi, LiveKit, `mock` for
/// tests); which one is selected is a config flip (`rtc_provider` per
/// account/room), never a client code change, per §4.7's design goal.
///
/// Per §4.7 ("Never migrate an active room across providers") — an
/// [RtcProvider] only ever joins *new* rooms; provider selection for an
/// already-active call never changes mid-call.
abstract class RtcProvider {
  /// Provider identifier matching the `rtc_provider` telemetry enum in
  /// §8B.3 (`cloudflare · jitsi · livekit · mock`). Used only for
  /// telemetry/logging/config selection — callers must never branch UI or
  /// enforcement logic on this value; use [capabilities] instead.
  String get name;

  /// This provider's capability flags (§4.7), fixed for the provider's
  /// current configuration/plan.
  RtcCapabilities get capabilities;

  /// Join the room/session described by [ticket] in the given [mode].
  /// Returns once the underlying transport has been established; session
  /// lifecycle after that point is observed via [RtcSession.events].
  Future<RtcSession> join(RtcJoinTicket ticket, {required RtcMode mode});
}
