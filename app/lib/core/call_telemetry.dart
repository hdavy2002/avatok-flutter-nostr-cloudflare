import 'dart:async';
import 'dart:io' show ProcessInfo;
import 'dart:math' as math;

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'ice_cache.dart' show CallDiag;

/// [CALL-REL-4] Playout-aware media-health classification (plan §7.2). Kept in
/// this file (not call_session.dart) so the Milestone C recovery coordinator
/// (CALL-REL-5) and relay migration (CALL-REL-6) can both consume it without a
/// second definition. OBSERVE-ONLY in the CALL-REL-4 commit — classification is
/// reported via [CallTelemetry.mediaHealth] but nothing acts on it until
/// CALL-REL-5 (gated separately behind RemoteConfig.callIceRecoveryV2).
enum MediaHealthClass {
  /// Not yet sampled, or a required stat was unavailable — never inferred as a
  /// healthy/degraded value.
  unknown,
  healthy,
  remoteQuiet,
  networkDegraded,
  noRtp,
  noPlayout,
  routeBroken,
}

extension MediaHealthClassWire on MediaHealthClass {
  String get wire => switch (this) {
        MediaHealthClass.unknown => 'unknown',
        MediaHealthClass.healthy => 'healthy',
        MediaHealthClass.remoteQuiet => 'remote_quiet',
        MediaHealthClass.networkDegraded => 'network_degraded',
        MediaHealthClass.noRtp => 'no_rtp',
        MediaHealthClass.noPlayout => 'no_playout',
        MediaHealthClass.routeBroken => 'route_broken',
      };
}

/// One 5s `getStats()` sampling pass over the inbound AUDIO stream only (plan
/// §7.1). Every numeric field is nullable — a stat the platform didn't expose
/// is `null` ("unknown"), NEVER coerced to 0 (plan: "never infer zero").
class MediaHealthSnapshot {
  final MediaHealthClass cls;
  final int atMs;
  // Interval deltas (this sample vs the previous one). Null on the first
  // sample of a call/segment (no prior baseline) or if the underlying stat
  // was absent from the report.
  final int? bytesDelta;
  final int? packetsDelta;
  final int? lostDelta;
  final double? jitterMs; // instantaneous, not a delta
  final double? audioLevel; // instantaneous 0..1
  final double? totalAudioEnergyDelta;
  final int? jitterBufferEmittedDelta;
  final double? jitterBufferDelayMsAvg; // derived: Δdelay / Δemitted, this interval
  final int? concealedSamplesDelta;
  final int? silentConcealedSamplesDelta;
  final int? totalSamplesReceivedDelta;
  final double? concealmentPctInterval; // 100 * concealedDelta / totalSamplesDelta
  final double? lossPctInterval; // 100 * lostDelta / (lostDelta + packetsDelta)
  final int? lastPacketReceivedTimestampMs;
  final String? selectedCandidatePairId;
  final String? localCandidateType;
  final String? remoteCandidateType;
  final String? relayProtocol;
  final String activeAudioRoute; // 'unknown' when the controller is off/unavailable
  final bool routeConfirmed; // requested route == active route
  final bool? nativeFocusHeld; // null = unknown (controller off)

  const MediaHealthSnapshot({
    required this.cls,
    required this.atMs,
    this.bytesDelta,
    this.packetsDelta,
    this.lostDelta,
    this.jitterMs,
    this.audioLevel,
    this.totalAudioEnergyDelta,
    this.jitterBufferEmittedDelta,
    this.jitterBufferDelayMsAvg,
    this.concealedSamplesDelta,
    this.silentConcealedSamplesDelta,
    this.totalSamplesReceivedDelta,
    this.concealmentPctInterval,
    this.lossPctInterval,
    this.lastPacketReceivedTimestampMs,
    this.selectedCandidatePairId,
    this.localCandidateType,
    this.remoteCandidateType,
    this.relayProtocol,
    this.activeAudioRoute = 'unknown',
    this.routeConfirmed = false,
    this.nativeFocusHeld,
  });

  Map<String, Object> toTelemetryMap() => {
        'class': cls.wire,
        if (bytesDelta != null) 'audio_bytes_delta': bytesDelta! else 'audio_bytes_delta': 'unknown',
        if (packetsDelta != null) 'audio_packets_delta': packetsDelta! else 'audio_packets_delta': 'unknown',
        if (lostDelta != null) 'audio_lost_delta': lostDelta! else 'audio_lost_delta': 'unknown',
        if (jitterMs != null) 'jitter_ms': jitterMs! else 'jitter_ms': 'unknown',
        if (lossPctInterval != null) 'loss_pct_interval': lossPctInterval! else 'loss_pct_interval': 'unknown',
        if (audioLevel != null) 'audio_level': audioLevel! else 'audio_level': 'unknown',
        if (concealmentPctInterval != null)
          'concealment_pct_interval': concealmentPctInterval!
        else
          'concealment_pct_interval': 'unknown',
        if (jitterBufferDelayMsAvg != null)
          'jitter_buffer_ms_interval': jitterBufferDelayMsAvg!
        else
          'jitter_buffer_ms_interval': 'unknown',
        if (jitterBufferEmittedDelta != null)
          'jitter_buffer_emitted_delta': jitterBufferEmittedDelta!
        else
          'jitter_buffer_emitted_delta': 'unknown',
        if (lastPacketReceivedTimestampMs != null)
          'last_packet_received_ms_ago': atMs - lastPacketReceivedTimestampMs!
        else
          'last_packet_received_ms_ago': 'unknown',
        'candidate_pair_id': selectedCandidatePairId ?? 'unknown',
        'local_candidate_type': localCandidateType ?? 'unknown',
        'remote_candidate_type': remoteCandidateType ?? 'unknown',
        'relay_protocol': relayProtocol ?? 'unknown',
        'active_audio_route': activeAudioRoute,
        'route_confirmed': routeConfirmed,
        'native_focus_held': nativeFocusHeld?.toString() ?? 'unknown',
      };
}

/// Per-call quality telemetry (Scale proposal Phase 0 — "you can't tune what you
/// don't measure"). One instance per CallScreen lifetime.
///
/// Emits four PostHog events, all auto-stamped with the user's email/phone via
/// the [Analytics] envelope so support can pull a specific user's call issues:
///   • call_started   — a call attempt began (funnel root: started→connected→ended)
///   • call_connected — first remote frame: setup_ms, ice/relay type, codecs
///   • call_progress  — heartbeat every 30 s while connected (live RTT/jitter/loss/
///                      bitrate/fps/MOS). Survives an app kill mid-call, so we keep
///                      quality data even when call_ended never fires.
///   • call_ended     — duration/minutes, teardown reason, RTT/jitter/loss/bitrate
///                      aggregates (avg + p50/p95 + max), video frame health,
///                      audio glitch %, estimated MOS, restarts, net changes.
///
/// "Country of use" is added automatically by PostHog's server-side GeoIP
/// ($geoip_country_name) on ingest, so it needs no field here.
///
/// Budgets (audit §3.2): setup p75 < 2s, TURN usage < 25%, setup failure < 1%,
/// MOS p50 ≥ 3.6 ("good"). All best-effort: telemetry must never break a call.
class CallTelemetry {
  final String callId;
  final bool video;
  final bool outgoing;
  /// Media topology: 'p2p' (direct), 'relay' (via TURN), or 'sfu' (a conference
  /// routed through the LiveKit SFU). 1:1 calls pass 'p2p'; it's promoted to
  /// 'relay' automatically once we see the selected pair went through a relay.
  String transportMode;
  final int _t0 = DateTime.now().millisecondsSinceEpoch;

  int? _tConnected;
  String _iceType = 'unknown'; // local selected candidate type
  String _remoteIceType = 'unknown';
  String _relayProtocol = ''; // udp | tcp | tls (when relay was used)
  String _codecAudio = '';
  String _codecVideo = '';
  int iceRestarts = 0;
  int netChanges = 0;
  bool _reported = false;
  bool _startedEmitted = false;

  // ── [CALL-RELSCORE-1] Reliability Score inputs (TELEMETRY-FLIGHT-RECORDER §
  // "Reliability Score") ────────────────────────────────────────────────────
  // Session-level signals the telemetry can't observe itself, handed in via
  // [setReliabilityInputs] just before [ended]. Weights live in ONE place below.
  int _reconnectAttempts = 0; // mid-call reconnect attempts
  int _mediaStalls = 0;       // distinct media-stall episodes
  bool _relayForced = false;  // TURN/relay was forced
  bool _unreachable = false;  // callee had no reachable device (push failure)
  // [CALL-TELEMETRY-1] setup-stage markers (see setReliabilityInputs).
  bool _deviceRinging = false; // callee device confirmed ringing
  bool? _ringAckOk;            // server ring-ack outcome (null = never arrived)
  bool _gotSdpAnswer = false;  // SDP answer received (callee accepted)
  // [CALL-NETHUD-1] Last HUD snapshot the session observed (up/down kbps, rtt,
  // loss %) — surfaced on call_ended so the network HUD's own numbers land in
  // the reliability payload. -1 means "not captured".
  int _hudUpKbps = -1;
  int _hudDownKbps = -1;
  int _hudRttMs = -1;
  double _hudLossPct = -1;
  // Weights (points docked). Tunable in one place per spec.
  static const int _wReconnect = 10; // per reconnect attempt
  static const int _wStall = 15;     // per media stall
  static const int _wRelay = 5;      // if relay used
  static const int _wUnreachable = 10; // if callee unreachable
  static const double _wLossPerPct = 1.0; // per 1% packet loss (cheap, available)

  /// [CALL-RELSCORE-1] Feed the session-level resilience signals used by the
  /// reliability score. Call once, immediately before [ended].
  void setReliabilityInputs({
    int reconnectAttempts = 0,
    int mediaStalls = 0,
    bool relayForced = false,
    bool unreachable = false,
    // [CALL-NETHUD-1] Last network-HUD snapshot (-1 = not captured).
    int hudUpKbps = -1,
    int hudDownKbps = -1,
    int hudRttMs = -1,
    double hudLossPct = -1,
    // [CALL-TELEMETRY-1 2026-07-14] Setup-stage markers so never_connected
    // failures name the stage the call died at (motivated by the 2026-07-11
    // "user is not available" incident: never_connected rows carried no signal
    // about whether the ring ever reached the callee).
    bool deviceRinging = false,
    bool? ringAckOk,
    bool gotSdpAnswer = false,
  }) {
    _reconnectAttempts = reconnectAttempts;
    _mediaStalls = mediaStalls;
    _relayForced = relayForced;
    _unreachable = unreachable;
    _hudUpKbps = hudUpKbps;
    _hudDownKbps = hudDownKbps;
    _hudRttMs = hudRttMs;
    _hudLossPct = hudLossPct;
    _deviceRinging = deviceRinging;
    _ringAckOk = ringAckOk;
    _gotSdpAnswer = gotSdpAnswer;
  }

  // ── peer geo + ICE/STUN/TURN topology ──────────────────────────────────────
  // The remote party's country, relayed by the signaling server at connect, so a
  // single call_connected / call_ended row carries BOTH ends' countries (the
  // emitter's own is added server-side by PostHog GeoIP). '' when unknown.
  String _peerCountry = '';
  int _iceGatherStartMs = 0;
  int _iceGatherMs = 0; // local ICE candidate gathering time
  int _hostCands = 0, _srflxCands = 0, _relayCands = 0, _prflxCands = 0;
  int _candidatePairs = 0;
  String _turnServerHash = ''; // hashed TURN url (no creds) — which relay served us

  // ── bandwidth headroom (WebRTC available bitrate estimates) ─────────────────
  final List<double> _availOutKbps = [];
  final List<double> _availInKbps = [];

  // ── video performance counters ──────────────────────────────────────────────
  int _framesDecoded = 0, _framesDropped = 0;
  int _nackCount = 0, _pliCount = 0;
  final List<double> _jbufMs = []; // jitter-buffer delay (ms)
  final List<double> _audioLevel = []; // inbound audio level 0..1

  // ── device memory footprint during the call (RSS) ───────────────────────────
  final List<double> _rssMb = [];
  double _rssPeakMb = 0;

  // ── rolling quality samples ────────────────────────────────────────────────
  Timer? _sampler;
  int _heartbeats = 0;
  final List<double> _rttMs = [];
  final List<double> _jitterMs = [];
  final List<double> _recvKbps = [];
  final List<double> _sendKbps = [];
  final List<double> _mos = [];
  double _lossPct = 0; // last cumulative inbound loss %
  double _fps = 0; // last video fps
  int _frameW = 0, _frameH = 0;
  int _freezeCount = 0; // cumulative video freezes
  double _audioGlitchPct = 0; // cumulative concealment %
  String _lastMediaFlowState = 'unknown';
  final Set<String> _reportedRuntimeErrorStages = <String>{};
  // bitrate deltas
  int _lastRecvBytes = 0, _lastSendBytes = 0, _lastBytesAt = 0;

  // ── [CALL-REL-4] playout-aware media health (plan §7.1/§7.2/§9) ─────────────
  // Cached "last known" values so call_progress can amend itself with the
  // compact fields the plan asks for, without publishing every raw 5s sample.
  MediaHealthClass _lastHealthClass = MediaHealthClass.unknown;
  String _mediaPath = 'direct'; // direct | relay — set by CALL-REL-5/6
  String _activeAudioRoute = 'unknown';
  bool _routeConfirmed = false;
  bool? _audioPlayoutOk; // null = unknown
  double? _concealmentPctInterval;
  double? _jitterBufferMsInterval;
  // ── [CALL-REL-5] recovery state surfaced onto call_progress ─────────────────
  String _recoveryState = 'none'; // none|recovering_ice|migrating_relay|recovered|failed
  int _recoveryAttemptCount = 0;

  CallTelemetry({
    required this.callId,
    required this.video,
    required this.outgoing,
    this.transportMode = 'p2p',
  });

  /// The remote party's country (server-relayed at connect), so one row carries
  /// both ends' geo. Best-effort; ignored when empty.
  void setPeerCountry(String c) {
    if (c.isNotEmpty) _peerCountry = c.toUpperCase();
  }

  /// Tally one locally-gathered ICE candidate by type so we can see STUN-
  /// reflexive vs TURN-relay reliance per network (host=LAN, srflx=STUN,
  /// relay=TURN, prflx=peer-reflexive). [turnUrl] (no creds) records which relay.
  void onLocalCandidate(String candidateType, {String? turnUrl}) {
    switch (candidateType) {
      case 'host':
        _hostCands++;
        break;
      case 'srflx':
        _srflxCands++;
        break;
      case 'relay':
        _relayCands++;
        break;
      case 'prflx':
        _prflxCands++;
        break;
    }
    if (turnUrl != null && turnUrl.isNotEmpty && _turnServerHash.isEmpty) {
      _turnServerHash = turnUrl.hashCode.toString();
    }
  }

  void onIceGatheringStart() {
    if (_iceGatherStartMs == 0) {
      _iceGatherStartMs = DateTime.now().millisecondsSinceEpoch;
    }
  }

  void onIceGatheringDone() {
    if (_iceGatherStartMs > 0 && _iceGatherMs == 0) {
      _iceGatherMs = DateTime.now().millisecondsSinceEpoch - _iceGatherStartMs;
    }
  }

  static double _sampleRssMb() {
    try {
      return ProcessInfo.currentRss / (1024 * 1024);
    } catch (_) {
      return 0;
    }
  }

  /// Funnel root — a call attempt began. Lets us compute answer rate and setup
  /// failure rate (started without a matching connected). Idempotent.
  void started() {
    if (_startedEmitted) return;
    _startedEmitted = true;
    Analytics.capture('call_started', {
      'call_id': callId,
      'call_id_hash': callId.hashCode.toString(),
      'video': video,
      'outgoing': outgoing,
      'turn_only': CallDiag.turnOnly, // diagnostics: forced-relay run
      // [CALL-ID-SHAPE-OBS-1] Which call_id CONVENTION this attempt used.
      //
      // The codebase mints room ids two incompatible ways: chat_thread.dart uses
      // 'avatok-<uuid8>' (unique per call, correct), while place_1to1_call.dart /
      // calls_screen.dart / ava_phone_screen.dart use 'avatok-<userId>' — a
      // STABLE, PERMANENT room id per callee. That reuses one CallRoom DO for
      // every call ever placed to that person (stale hibernated sockets vs the
      // 2-peer cap) and, worse, trips the callee's `_processedCallIds` cache,
      // which is disk-persisted with NO TTL — so the 2nd+ call to that person is
      // silently dropped client-side. That is the 2026-07-14 "she never heard a
      // ring" callback.
      //
      // `call_id_shape` makes this a one-query breakdown: compare setup-failure
      // rate for shape='uid' vs shape='uuid' and the bug proves itself, instead
      // of needing someone to eyeball a call_id and recognise a user id.
      'call_id_shape': _callIdShape(callId),
    });
  }

  /// Classify the room-id convention behind [callId] — see `started()`.
  /// 'uid'     → 'avatok-user_…' (stable per callee; the buggy convention)
  /// 'uuid'    → 'avatok-<8 hex>' (unique per call; the correct convention)
  /// 'numeric' → 'avatok-<digits>' (team IVR / PSTN number rooms)
  /// 'other'   → anything unrecognised, so a new convention can't hide.
  static String _callIdShape(String id) {
    final suffix = id.startsWith('avatok-') ? id.substring(7) : id;
    if (suffix.startsWith('user_')) return 'uid';
    if (RegExp(r'^[0-9a-f]{8}$').hasMatch(suffix)) return 'uuid';
    if (RegExp(r'^\+?[0-9]+$').hasMatch(suffix)) return 'numeric';
    return 'other';
  }

  /// Call when the first remote track arrives (the user-perceived "connected").
  void connected(RTCPeerConnection? pc) {
    if (_tConnected != null) return;
    _tConnected = DateTime.now().millisecondsSinceEpoch;
    final setupMs = _tConnected! - _t0;
    _probeIceType(pc).then((_) {
      final relayTcp = _iceType == 'relay' && _relayProtocol != 'udp' && _relayProtocol.isNotEmpty;
      Analytics.capture('call_connected', {
        // call_id = room id, shared by BOTH sides so their events join (A4.5).
        'call_id': callId,
        'call_id_hash': callId.hashCode.toString(),
        'setup_ms': setupMs,
        // P13-C: dial-tap → first remote frame. For outgoing calls _t0 is the
        // CallScreen construct instant (≈ dial tap), so this IS the setup latency
        // we optimise on LTE; explicit alias so dashboards can chart it plainly.
        'call_setup_ms': setupMs,
        'ice_type': _iceType,
        'remote_ice_type': _remoteIceType,
        'relay_used': _iceType == 'relay',
        if (_relayProtocol.isNotEmpty) 'relay_protocol': _relayProtocol,
        // relay over TCP/TLS ⇒ the user is on a UDP-blocked/locked-down network.
        'network_restricted': relayTcp,
        if (_codecAudio.isNotEmpty) 'codec_audio': _codecAudio,
        if (_codecVideo.isNotEmpty) 'codec_video': _codecVideo,
        'turn_only': CallDiag.turnOnly,
        // topology + both-ends geo
        'transport_mode': transportMode,
        'direction': outgoing ? 'outgoing' : 'incoming',
        if (_peerCountry.isNotEmpty) 'peer_country': _peerCountry,
        // ICE / STUN / TURN setup detail
        if (_iceGatherMs > 0) 'ice_gather_ms': _iceGatherMs,
        'host_cands': _hostCands,
        'srflx_cands': _srflxCands,
        'relay_cands': _relayCands,
        if (_prflxCands > 0) 'prflx_cands': _prflxCands,
        if (_candidatePairs > 0) 'candidate_pairs': _candidatePairs,
        if (_turnServerHash.isNotEmpty) 'turn_server_hash': _turnServerHash,
        if (_availOutKbps.isNotEmpty) 'avail_out_kbps': _availOutKbps.last.round(),
        'video': video,
        'outgoing': outgoing,
      });
      AvaLog.I.log('call', 'connected in ${setupMs}ms via $_iceType'
          '${_relayProtocol.isNotEmpty ? "/$_relayProtocol" : ""}');
    });
    _sampler = Timer.periodic(const Duration(seconds: 30), (_) => _heartbeat(pc));
  }

  /// Which candidate types won, the relay transport, and negotiated codecs.
  Future<void> _probeIceType(RTCPeerConnection? pc) async {
    if (pc == null) return;
    try {
      final stats = await pc.getStats();
      String? selectedPairId;
      final pairs = <String, Map<dynamic, dynamic>>{};
      final locals = <String, Map<dynamic, dynamic>>{};
      final remotes = <String, Map<dynamic, dynamic>>{};
      final codecs = <String, String>{};
      for (final s in stats) {
        switch (s.type) {
          case 'transport':
            final id = s.values['selectedCandidatePairId'];
            if (id is String && id.isNotEmpty) selectedPairId = id;
            break;
          case 'candidate-pair':
            pairs[s.id] = s.values;
            if (s.values['selected'] == true) selectedPairId ??= s.id;
            break;
          case 'local-candidate':
            locals[s.id] = s.values;
            break;
          case 'remote-candidate':
            remotes[s.id] = s.values;
            break;
          case 'codec':
            final mime = s.values['mimeType'];
            if (mime is String) codecs[s.id] = mime;
            break;
        }
      }
      _candidatePairs = pairs.length;
      final pair = selectedPairId != null ? pairs[selectedPairId] : null;
      final localId = pair?['localCandidateId'];
      final cand = localId is String ? locals[localId] : null;
      final t = cand?['candidateType'];
      if (t is String && t.isNotEmpty) _iceType = t;
      // Promote the topology label to 'relay' when the winning path used TURN —
      // keeps 'sfu' intact for conferences that construct with transportMode:'sfu'.
      if (_iceType == 'relay' && transportMode == 'p2p') transportMode = 'relay';
      // relayProtocol is the transport TURN used to reach the relay (udp/tcp/tls).
      final rp = cand?['relayProtocol'] ?? cand?['protocol'];
      if (rp is String && rp.isNotEmpty) _relayProtocol = rp.toLowerCase();
      final remoteId = pair?['remoteCandidateId'];
      final rcand = remoteId is String ? remotes[remoteId] : null;
      final rt = rcand?['candidateType'];
      if (rt is String && rt.isNotEmpty) _remoteIceType = rt;
      // Negotiated codecs (mime like "audio/opus", "video/VP8").
      for (final mime in codecs.values) {
        final m = mime.toLowerCase();
        if (m.startsWith('audio/') && _codecAudio.isEmpty) _codecAudio = mime.split('/').last;
        if (m.startsWith('video/') && _codecVideo.isEmpty) _codecVideo = mime.split('/').last;
      }
    } catch (_) {/* best-effort */}
  }

  /// Pull one sample of live stats into the rolling aggregates. [emit] controls
  /// whether a call_progress heartbeat is sent (we sample, then emit on the beat).
  Future<void> _sample(RTCPeerConnection? pc) async {
    if (pc == null) return;
    try {
      final stats = await pc.getStats();
      int recvBytes = 0, sendBytes = 0;
      double? rtt, jitter;
      double? concealed, totalSamples;
      for (final s in stats) {
        final v = s.values;
        if (s.type == 'candidate-pair') {
          final r = v['currentRoundTripTime'];
          if (r is num && r > 0) rtt = r * 1000.0;
          // Congestion-control bitrate estimates → live bandwidth headroom.
          final ao = v['availableOutgoingBitrate'];
          if (ao is num && ao > 0) _availOutKbps.add(ao / 1000.0);
          final ai = v['availableIncomingBitrate'];
          if (ai is num && ai > 0) _availInKbps.add(ai / 1000.0);
        } else if (s.type == 'inbound-rtp') {
          final lost = v['packetsLost'], recv = v['packetsReceived'];
          if (lost is num && recv is num && (lost + recv) > 0) {
            _lossPct = 100.0 * lost / (lost + recv);
          }
          final b = v['bytesReceived'];
          if (b is num) recvBytes += b.toInt();
          final j = v['jitter'];
          if (j is num && j >= 0) jitter = j * 1000.0; // seconds → ms
          final kind = (v['kind'] ?? v['mediaType'])?.toString();
          if (kind == 'video') {
            final f = v['framesPerSecond'];
            if (f is num) _fps = f.toDouble();
            final w = v['frameWidth'], h = v['frameHeight'];
            if (w is num) _frameW = w.toInt();
            if (h is num) _frameH = h.toInt();
            final fz = v['freezeCount'];
            if (fz is num) _freezeCount = fz.toInt();
            // decode throughput + loss-recovery signalling (NACK/PLI)
            final fd = v['framesDecoded'];
            if (fd is num) _framesDecoded = fd.toInt();
            final fdr = v['framesDropped'];
            if (fdr is num) _framesDropped = fdr.toInt();
            final nk = v['nackCount'];
            if (nk is num) _nackCount = nk.toInt();
            final pli = v['pliCount'];
            if (pli is num) _pliCount = pli.toInt();
          } else if (kind == 'audio') {
            final c = v['concealedSamples'], ts = v['totalSamplesReceived'];
            if (c is num) concealed = c.toDouble();
            if (ts is num) totalSamples = ts.toDouble();
            final al = v['audioLevel'];
            if (al is num) _audioLevel.add(al.toDouble());
          }
          // jitter-buffer delay (audio or video): cumulative seconds / emitted
          // count → per-sample ms. High values = buffering to mask network j
          final jbd = v['jitterBufferDelay'], jbe = v['jitterBufferEmittedCount'];
          if (jbd is num && jbe is num && jbe > 0) {
            _jbufMs.add(1000.0 * jbd / jbe);
          }
        } else if (s.type == 'outbound-rtp') {
          final b = v['bytesSent'];
          if (b is num) sendBytes += b.toInt();
        }
      }
      if (rtt != null) _rttMs.add(rtt);
      if (jitter != null) _jitterMs.add(jitter);
      if (concealed != null && totalSamples != null && totalSamples > 0) {
        _audioGlitchPct = 100.0 * concealed / totalSamples;
      }
      // bitrate from byte deltas over wall-clock interval
      final now = DateTime.now().millisecondsSinceEpoch;
      if (_lastBytesAt > 0) {
        final dt = (now - _lastBytesAt) / 1000.0;
        if (dt > 0) {
          final dr = (recvBytes - _lastRecvBytes) * 8 / 1000.0 / dt;
          final ds = (sendBytes - _lastSendBytes) * 8 / 1000.0 / dt;
          if (dr >= 0 && dr < 100000) _recvKbps.add(dr);
          if (ds >= 0 && ds < 100000) _sendKbps.add(ds);
        }
      }
      _lastRecvBytes = recvBytes;
      _lastSendBytes = sendBytes;
      _lastBytesAt = now;
      // running MOS estimate for this interval
      final mos = _estimateMos(rtt ?? 0.0, jitter ?? 0.0, _lossPct);
      if (mos > 0) _mos.add(mos);
      // device memory footprint (RSS) during the call
      final rss = _sampleRssMb();
      if (rss > 0) {
        _rssMb.add(rss);
        if (rss > _rssPeakMb) _rssPeakMb = rss;
      }
    } catch (_) {/* best-effort */}
  }

  Future<void> _heartbeat(RTCPeerConnection? pc) async {
    await _sample(pc);
    if (_reported) return;
    _heartbeats++;
    final now = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('call_progress', {
      'call_id': callId,
      'call_id_hash': callId.hashCode.toString(),
      'beat': _heartbeats,
      'elapsed_s': _tConnected == null ? 0 : ((now - _tConnected!) / 1000).round(),
      if (_rttMs.isNotEmpty) 'rtt_ms': _rttMs.last.round(),
      if (_jitterMs.isNotEmpty) 'jitter_ms': _jitterMs.last.round(),
      'loss_pct': _round2(_lossPct),
      if (_recvKbps.isNotEmpty) 'recv_kbps': _recvKbps.last.round(),
      if (_sendKbps.isNotEmpty) 'send_kbps': _sendKbps.last.round(),
      if (video && _fps > 0) 'fps': _fps.round(),
      if (video && _frameW > 0) 'resolution': '${_frameW}x$_frameH',
      if (_mos.isNotEmpty) 'mos': _round2(_mos.last),
      'ice_type': _iceType,
      'relay_used': _iceType == 'relay',
      'media_flow_state': _lastMediaFlowState,
      'rtc_error_count': _reportedRuntimeErrorStages.length,
      // live bandwidth headroom (congestion-control estimate)
      if (_availOutKbps.isNotEmpty) 'avail_out_kbps': _availOutKbps.last.round(),
      if (_availInKbps.isNotEmpty) 'avail_in_kbps': _availInKbps.last.round(),
      // jitter buffer + video decode health
      if (_jbufMs.isNotEmpty) 'jitter_buffer_ms': _jbufMs.last.round(),
      if (video && _framesDecoded > 0) 'frames_decoded': _framesDecoded,
      if (video && _framesDropped > 0) 'frames_dropped': _framesDropped,
      // device memory footprint
      if (_rssMb.isNotEmpty) 'rss_mb': _rssMb.last.round(),
      // [CALL-REL-4/CALL-REL-5 — plan §9 "Amend call_progress"] last-known
      // playout/route/recovery fields — economical (not raw per-5s samples).
      'media_path': _mediaPath,
      'active_audio_route': _activeAudioRoute,
      'route_confirmed': _routeConfirmed,
      'audio_playout_ok': _audioPlayoutOk?.toString() ?? 'unknown',
      'audio_concealment_pct_interval': _concealmentPctInterval ?? 'unknown',
      'audio_jitter_buffer_ms_interval': _jitterBufferMsInterval ?? 'unknown',
      'recovery_state': _recoveryState,
      'recovery_attempt_count': _recoveryAttemptCount,
    });
  }

  void onIceRestart() => iceRestarts++;
  void onNetChange() => netChanges++;

  /// [CALL-REL-4] Report one classified playout-health sample. Emits
  /// `call_media_health` ONLY when [snapshot.cls] differs from the previously
  /// reported class (plan §7.1: "Emit ... ONLY on class transitions"); every
  /// call still refreshes the cached fields [call_progress] amends with, so
  /// the 30s heartbeat always carries the latest known state even between
  /// transitions.
  void mediaHealth(MediaHealthSnapshot snapshot) {
    _activeAudioRoute = snapshot.activeAudioRoute;
    _routeConfirmed = snapshot.routeConfirmed;
    // audio_playout_ok: true once we've seen jitter-buffer emission or audio
    // energy advance this interval; false when RTP/route is provably broken;
    // null/unknown otherwise. Never inferred from bytes alone (REL-1).
    switch (snapshot.cls) {
      case MediaHealthClass.healthy:
      case MediaHealthClass.remoteQuiet:
        _audioPlayoutOk = true;
        break;
      case MediaHealthClass.noRtp:
      case MediaHealthClass.noPlayout:
      case MediaHealthClass.routeBroken:
        _audioPlayoutOk = false;
        break;
      case MediaHealthClass.networkDegraded:
      case MediaHealthClass.unknown:
        // Degraded still has playout; unknown stays unknown — never guessed.
        if (snapshot.cls == MediaHealthClass.networkDegraded) _audioPlayoutOk = true;
        break;
    }
    if (snapshot.concealmentPctInterval != null) {
      _concealmentPctInterval = snapshot.concealmentPctInterval;
    }
    if (snapshot.jitterBufferDelayMsAvg != null) {
      _jitterBufferMsInterval = snapshot.jitterBufferDelayMsAvg;
    }
    if (snapshot.cls == _lastHealthClass) return;
    _lastHealthClass = snapshot.cls;
    Analytics.capture('call_media_health', {
      'call_id': callId,
      'video': video,
      'outgoing': outgoing,
      'media_path': _mediaPath,
      ...snapshot.toTelemetryMap(),
    });
  }

  /// [CALL-REL-6] Direct vs relay, surfaced onto call_media_health/call_progress.
  void setMediaPath(String path) {
    _mediaPath = path;
  }

  /// [CALL-REL-5] Recovery-coordinator state, surfaced onto call_progress.
  void setRecoveryState(String state, {int? attemptCount}) {
    _recoveryState = state;
    if (attemptCount != null) _recoveryAttemptCount = attemptCount;
  }

  /// Low-volume media breadcrumb: emit only on a state transition. RTP receipt
  /// is reported as receipt, never mislabeled as proof the user heard audio.
  void mediaFlowState({
    required String state,
    int? inboundAudioBytesDelta,
    String? transportState,
  }) {
    if (_lastMediaFlowState == state) return;
    final prior = _lastMediaFlowState;
    _lastMediaFlowState = state;
    Analytics.capture('call_media_flow_state', {
      'call_id': callId,
      'from_state': prior,
      'to_state': state,
      if (inboundAudioBytesDelta != null) 'inbound_audio_bytes_delta': inboundAudioBytesDelta,
      if (transportState != null) 'transport_state': transportState,
      'ice_type': _iceType,
      'relay_used': _iceType == 'relay',
      'video': video,
      'outgoing': outgoing,
    });
  }

  /// One grouped handled PostHog Error Tracking issue per stage per call, plus
  /// a query-friendly rtc_error event. No caller content or connection secrets.
  void runtimeError({
    required String stage,
    required Object error,
    StackTrace? stack,
    Map<String, Object>? extra,
  }) {
    if (!_reportedRuntimeErrorStages.add(stage)) return;
    final context = <String, Object>{
      'call_id': callId,
      'stage': stage,
      'video': video,
      'outgoing': outgoing,
      'connected': _tConnected != null,
      'ice_type': _iceType,
      'relay_used': _iceType == 'relay',
      ...?extra,
    };
    Analytics.capture('rtc_error', context);
    Analytics.error(domain: 'call_rtc', code: stage, message: error.toString(),
        action: 'recoverable', extra: context);
    Analytics.captureException(error, stack, screen: 'call', handled: true, extra: context);
  }

  /// Call exactly once from the call's end path with the teardown reason
  /// (ended | declined | busy | no-answer | failed | error | local-hangup |
  /// remote-bye | peer-left | socket-lost | rtc-failed | rtc-disconnected).
  void ended(String reason) {
    if (_reported) return;
    _reported = true;
    _sampler?.cancel();
    final now = DateTime.now().millisecondsSinceEpoch;
    final durS = _tConnected == null ? 0 : ((now - _tConnected!) / 1000).round();
    final avgMos = _avg(_mos);
    Analytics.capture('call_ended', {
      'call_id': callId,
      'call_id_hash': callId.hashCode.toString(),
      // [CALL-ID-SHAPE-OBS-1] Repeated on the OUTCOME event (not just
      // `call_started`) so "setup-failure rate by call_id convention" is a
      // single-event breakdown with no join. See `started()` for the why.
      'call_id_shape': _callIdShape(callId),
      'reason': reason,
      'connected': _tConnected != null,
      'setup_ms': (_tConnected ?? now) - _t0,
      'duration_s': durS,
      'minutes_used': (durS / 60).ceil(), // billing-style minutes
      'ice_type': _iceType,
      'remote_ice_type': _remoteIceType,
      'relay_used': _iceType == 'relay',
      if (_relayProtocol.isNotEmpty) 'relay_protocol': _relayProtocol,
      if (_codecAudio.isNotEmpty) 'codec_audio': _codecAudio,
      if (_codecVideo.isNotEmpty) 'codec_video': _codecVideo,
      // RTT distribution
      if (_rttMs.isNotEmpty) 'avg_rtt_ms': _avg(_rttMs)!.round(),
      if (_rttMs.isNotEmpty) 'p50_rtt_ms': _pct(_rttMs, 0.50).round(),
      if (_rttMs.isNotEmpty) 'p95_rtt_ms': _pct(_rttMs, 0.95).round(),
      if (_rttMs.isNotEmpty) 'max_rtt_ms': _rttMs.reduce(math.max).round(),
      // jitter + loss
      if (_jitterMs.isNotEmpty) 'avg_jitter_ms': _avg(_jitterMs)!.round(),
      if (_jitterMs.isNotEmpty) 'max_jitter_ms': _jitterMs.reduce(math.max).round(),
      'packet_loss_pct': _round2(_lossPct),
      // throughput
      if (_recvKbps.isNotEmpty) 'avg_recv_kbps': _avg(_recvKbps)!.round(),
      if (_sendKbps.isNotEmpty) 'avg_send_kbps': _avg(_sendKbps)!.round(),
      // video health
      if (video && _fps > 0) 'last_fps': _fps.round(),
      if (video && _frameW > 0) 'last_resolution': '${_frameW}x$_frameH',
      if (video) 'freeze_count': _freezeCount,
      // audio health
      'audio_glitch_pct': _round2(_audioGlitchPct),
      'media_flow_state': _lastMediaFlowState,
      'rtc_error_count': _reportedRuntimeErrorStages.length,
      // perceived quality
      if (avgMos != null) 'mos_avg': _round2(avgMos),
      if (_mos.isNotEmpty) 'mos_min': _round2(_mos.reduce(math.min)),
      if (avgMos != null) 'quality': _rating(avgMos),
      // resilience
      'ice_restarts': iceRestarts,
      'net_changes': netChanges,
      // reconnected = we had to restart ICE but still ended while connected.
      'reconnected': iceRestarts > 0 && _tConnected != null,
      // [CALL-TELEMETRY-1] setup-stage markers on EVERY call_ended (not just
      // failures) so ring/ack/answer rates are trendable per release.
      'setup_device_ringing': _deviceRinging,
      'setup_ring_ack_ok': _ringAckOk?.toString() ?? 'none',
      'setup_got_sdp_answer': _gotSdpAnswer,
      // ── [CALL-RELSCORE-1] Reliability Score + its components ──────────────
      // 100 minus weighted penalties, clamped 0–100. "Worst 100 calls today" =
      // sort call_ended by reliability_score ascending — triage without logs.
      'reliability_score': _reliabilityScore(),
      'rel_reconnects': _reconnectAttempts,
      'rel_media_stalls': _mediaStalls,
      'rel_relay_used': _relayForced,
      'rel_unreachable': _unreachable,
      'rel_loss_penalty': (_lossPct * _wLossPerPct).round(),
      // [CALL-NETHUD-1] network-HUD summary (only if the HUD captured a sample).
      if (_hudUpKbps >= 0) 'hud_up_kbps': _hudUpKbps,
      if (_hudDownKbps >= 0) 'hud_down_kbps': _hudDownKbps,
      if (_hudRttMs >= 0) 'hud_rtt_ms': _hudRttMs,
      if (_hudLossPct >= 0) 'hud_loss_pct': _round2(_hudLossPct),
      'samples': _rttMs.length,
      'video': video,
      'outgoing': outgoing,
      // ── topology + both-ends geo ──────────────────────────────────────────
      'transport_mode': transportMode,
      'direction': outgoing ? 'outgoing' : 'incoming',
      if (_peerCountry.isNotEmpty) 'peer_country': _peerCountry,
      // ── ICE / STUN / TURN ─────────────────────────────────────────────────
      if (_iceGatherMs > 0) 'ice_gather_ms': _iceGatherMs,
      'host_cands': _hostCands,
      'srflx_cands': _srflxCands,
      'relay_cands': _relayCands,
      if (_prflxCands > 0) 'prflx_cands': _prflxCands,
      if (_candidatePairs > 0) 'candidate_pairs': _candidatePairs,
      if (_turnServerHash.isNotEmpty) 'turn_server_hash': _turnServerHash,
      // ── bandwidth headroom ────────────────────────────────────────────────
      if (_availOutKbps.isNotEmpty) 'avail_out_kbps_avg': _avg(_availOutKbps)!.round(),
      if (_availInKbps.isNotEmpty) 'avail_in_kbps_avg': _avg(_availInKbps)!.round(),
      // ── video performance ─────────────────────────────────────────────────
      if (video) 'frames_decoded': _framesDecoded,
      if (video) 'frames_dropped': _framesDropped,
      if (video) 'nack_count': _nackCount,
      if (video) 'pli_count': _pliCount,
      if (_jbufMs.isNotEmpty) 'jitter_buffer_ms_avg': _avg(_jbufMs)!.round(),
      // ── audio level ───────────────────────────────────────────────────────
      if (_audioLevel.isNotEmpty) 'audio_level_avg': _round2(_avg(_audioLevel)!),
      // ── device memory footprint ───────────────────────────────────────────
      if (_rssMb.isNotEmpty) 'rss_mb_avg': _avg(_rssMb)!.round(),
      if (_rssPeakMb > 0) 'rss_mb_peak': _rssPeakMb.round(),
    });
    // A call that never connected is a setup failure unless the human declined/was busy.
    if (_tConnected == null && reason != 'declined' && reason != 'busy' && reason != 'no-answer') {
      // [CALL-TELEMETRY-1] setup_stage classifies WHERE the setup died, so a
      // never_connected row is self-diagnosing without pulling logs:
      //   no_ring_ack     → server never acked the ring push (worker/queue issue)
      //   ring_not_landed → server said the push could not be delivered
      //                     (dead/pruned tokens — see push_no_device / the
      //                     call_callee_reachability snapshot for that call_id)
      //   rang_no_answer  → device rang, callee never accepted
      //   answered_no_ice → callee ACCEPTED (SDP answer) but ICE never connected
      //                     (NAT/TURN problem — check relay_used, ice_restarts)
      final setupStage = _gotSdpAnswer
          ? 'answered_no_ice'
          : _deviceRinging
              ? 'rang_no_answer'
              : _ringAckOk == false
                  ? 'ring_not_landed'
                  : _ringAckOk == null
                      ? 'no_ring_ack'
                      : 'ring_acked_no_device_ring';
      Analytics.error(domain: 'call_setup', code: 'never_connected', action: reason, extra: {
        'call_id': callId,
        'setup_ms': now - _t0,
        'ice_restarts': iceRestarts,
        'relay_used': _iceType == 'relay',
        'setup_stage': setupStage,
        'device_ringing': _deviceRinging,
        'ring_ack_ok': _ringAckOk?.toString() ?? 'none',
        'got_sdp_answer': _gotSdpAnswer,
        'unreachable': _unreachable,
        'video': video,
        'outgoing': outgoing,
        'transport_mode': transportMode,
        'host_cands': _hostCands,
        'srflx_cands': _srflxCands,
        'relay_cands': _relayCands,
        if (_iceGatherMs > 0) 'ice_gather_ms': _iceGatherMs,
      });
    }
  }

  // [CALL-RELSCORE-1] reliability_score = 100 − weighted penalties, clamped 0–100.
  // Packet-loss penalty uses the last cumulative inbound loss % (cheaply on hand).
  int _reliabilityScore() {
    var score = 100.0;
    score -= _wReconnect * _reconnectAttempts;
    score -= _wStall * _mediaStalls;
    score -= _relayForced ? _wRelay : 0;
    score -= _unreachable ? _wUnreachable : 0;
    score -= _lossPct * _wLossPerPct;
    return score.clamp(0, 100).round();
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  static double? _avg(List<double> xs) =>
      xs.isEmpty ? null : xs.reduce((a, b) => a + b) / xs.length;

  static double _pct(List<double> xs, double p) {
    if (xs.isEmpty) return 0;
    final s = [...xs]..sort();
    return s[((s.length - 1) * p).round()];
  }

  static double _round2(double x) => double.parse(x.toStringAsFixed(2));

  /// Simplified ITU-T E-model: RTT+jitter+loss → R-factor → MOS (1.0–5.0).
  static double _estimateMos(double rttMs, double jitterMs, double lossPct) {
    final latency = rttMs / 2 + 2 * jitterMs + 10; // effective one-way delay
    double r = latency < 160 ? 93.2 - latency / 40 : 93.2 - (latency - 120) / 10;
    r -= 2.5 * lossPct; // each 1% loss ≈ 2.5 R-points
    r = r.clamp(0, 93.2).toDouble();
    final mos = 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
    return mos.clamp(1.0, 5.0).toDouble();
  }

  static String _rating(double mos) {
    if (mos >= 4.0) return 'excellent';
    if (mos >= 3.6) return 'good';
    if (mos >= 3.1) return 'fair';
    if (mos >= 2.6) return 'poor';
    return 'bad';
  }
}
