import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'ice_cache.dart' show CallDiag;

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
  // bitrate deltas
  int _lastRecvBytes = 0, _lastSendBytes = 0, _lastBytesAt = 0;

  CallTelemetry({required this.callId, required this.video, required this.outgoing});

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
    });
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
        'ice_type': _iceType,
        'remote_ice_type': _remoteIceType,
        'relay_used': _iceType == 'relay',
        if (_relayProtocol.isNotEmpty) 'relay_protocol': _relayProtocol,
        // relay over TCP/TLS ⇒ the user is on a UDP-blocked/locked-down network.
        'network_restricted': relayTcp,
        if (_codecAudio.isNotEmpty) 'codec_audio': _codecAudio,
        if (_codecVideo.isNotEmpty) 'codec_video': _codecVideo,
        'turn_only': CallDiag.turnOnly,
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
      final pair = selectedPairId != null ? pairs[selectedPairId] : null;
      final localId = pair?['localCandidateId'];
      final cand = localId is String ? locals[localId] : null;
      final t = cand?['candidateType'];
      if (t is String && t.isNotEmpty) _iceType = t;
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
          } else if (kind == 'audio') {
            final c = v['concealedSamples'], ts = v['totalSamplesReceived'];
            if (c is num) concealed = c.toDouble();
            if (ts is num) totalSamples = ts.toDouble();
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
    });
  }

  void onIceRestart() => iceRestarts++;
  void onNetChange() => netChanges++;

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
      // perceived quality
      if (avgMos != null) 'mos_avg': _round2(avgMos),
      if (_mos.isNotEmpty) 'mos_min': _round2(_mos.reduce(math.min)),
      if (avgMos != null) 'quality': _rating(avgMos),
      // resilience
      'ice_restarts': iceRestarts,
      'net_changes': netChanges,
      // reconnected = we had to restart ICE but still ended while connected.
      'reconnected': iceRestarts > 0 && _tConnected != null,
      'samples': _rttMs.length,
      'video': video,
      'outgoing': outgoing,
    });
    // A call that never connected is a setup failure unless the human declined/was busy.
    if (_tConnected == null && reason != 'declined' && reason != 'busy' && reason != 'no-answer') {
      Analytics.error(domain: 'call_setup', code: 'never_connected', action: reason, extra: {
        'call_id': callId,
        'setup_ms': now - _t0,
        'ice_restarts': iceRestarts,
        'relay_used': _iceType == 'relay',
      });
    }
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
