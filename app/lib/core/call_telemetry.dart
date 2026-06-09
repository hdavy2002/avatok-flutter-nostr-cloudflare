import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'analytics.dart';
import 'ava_log.dart';

/// Per-call quality telemetry (Scale proposal Phase 0 — "you can't tune what you
/// don't measure"). One instance per CallScreen lifetime. Captures:
///   call_connected  — setup_ms (tap → first remote frame), ice_type, relay_used
///   call_ended      — duration_s, teardown reason, RTT/loss aggregates,
///                     ice_restarts, net_changes
/// Budgets (audit §3.2): setup p75 < 2s, TURN usage < 25%, setup failure < 1%.
/// All best-effort: telemetry must never break a call.
class CallTelemetry {
  final String callId;
  final bool video;
  final bool outgoing;
  final int _t0 = DateTime.now().millisecondsSinceEpoch;

  int? _tConnected;
  String _iceType = 'unknown'; // host | srflx | prflx | relay | unknown
  int iceRestarts = 0;
  int netChanges = 0;
  bool _reported = false;

  // stats sampling
  Timer? _sampler;
  final List<double> _rttMs = [];
  double _lossPct = 0;

  CallTelemetry({required this.callId, required this.video, required this.outgoing});

  /// Call when the first remote track arrives (the user-perceived "connected").
  void connected(RTCPeerConnection? pc) {
    if (_tConnected != null) return;
    _tConnected = DateTime.now().millisecondsSinceEpoch;
    final setupMs = _tConnected! - _t0;
    _probeIceType(pc).then((_) {
      Analytics.capture('call_connected', {
        'call_id_hash': callId.hashCode.toString(),
        'setup_ms': setupMs,
        'ice_type': _iceType,
        'relay_used': _iceType == 'relay',
        'video': video,
        'outgoing': outgoing,
      });
      AvaLog.I.log('call', 'connected in ${setupMs}ms via $_iceType');
    });
    _sampler = Timer.periodic(const Duration(seconds: 10), (_) => _sample(pc));
  }

  /// Which candidate type won? (relay = TURN was needed.)
  Future<void> _probeIceType(RTCPeerConnection? pc) async {
    if (pc == null) return;
    try {
      final stats = await pc.getStats();
      String? selectedPairId;
      final pairs = <String, Map<dynamic, dynamic>>{};
      final locals = <String, Map<dynamic, dynamic>>{};
      for (final s in stats) {
        if (s.type == 'transport') {
          final id = s.values['selectedCandidatePairId'];
          if (id is String && id.isNotEmpty) selectedPairId = id;
        } else if (s.type == 'candidate-pair') {
          pairs[s.id] = s.values;
          if (s.values['selected'] == true) selectedPairId ??= s.id;
        } else if (s.type == 'local-candidate') {
          locals[s.id] = s.values;
        }
      }
      final pair = selectedPairId != null ? pairs[selectedPairId] : null;
      final localId = pair?['localCandidateId'];
      final cand = localId is String ? locals[localId] : null;
      final t = cand?['candidateType'];
      if (t is String && t.isNotEmpty) _iceType = t;
    } catch (_) {/* best-effort */}
  }

  Future<void> _sample(RTCPeerConnection? pc) async {
    if (pc == null) return;
    try {
      final stats = await pc.getStats();
      for (final s in stats) {
        if (s.type == 'candidate-pair' && s.values['currentRoundTripTime'] != null) {
          final rtt = s.values['currentRoundTripTime'];
          if (rtt is num && rtt > 0) _rttMs.add(rtt * 1000.0);
        }
        if (s.type == 'inbound-rtp') {
          final lost = s.values['packetsLost'], recv = s.values['packetsReceived'];
          if (lost is num && recv is num && (lost + recv) > 0) {
            _lossPct = 100.0 * lost / (lost + recv);
          }
        }
      }
    } catch (_) {/* best-effort */}
  }

  void onIceRestart() => iceRestarts++;
  void onNetChange() => netChanges++;

  /// Call exactly once from the call's end path with the teardown reason
  /// (ended | declined | busy | no-answer | failed | error).
  void ended(String reason) {
    if (_reported) return;
    _reported = true;
    _sampler?.cancel();
    final now = DateTime.now().millisecondsSinceEpoch;
    final avgRtt = _rttMs.isEmpty ? null : _rttMs.reduce((a, b) => a + b) / _rttMs.length;
    double? maxRtt;
    if (_rttMs.isNotEmpty) maxRtt = _rttMs.reduce((a, b) => a > b ? a : b);
    Analytics.capture('call_ended', {
      'call_id_hash': callId.hashCode.toString(),
      'reason': reason,
      'connected': _tConnected != null,
      'setup_ms': (_tConnected ?? now) - _t0,
      'duration_s': _tConnected == null ? 0 : ((now - _tConnected!) / 1000).round(),
      'ice_type': _iceType,
      'relay_used': _iceType == 'relay',
      if (avgRtt != null) 'avg_rtt_ms': avgRtt.round(),
      if (maxRtt != null) 'max_rtt_ms': maxRtt.round(),
      'packet_loss_pct': double.parse(_lossPct.toStringAsFixed(2)),
      'ice_restarts': iceRestarts,
      'net_changes': netChanges,
      'video': video,
      'outgoing': outgoing,
    });
    // A call that never connected is a setup failure unless the human declined/was busy.
    if (_tConnected == null && reason != 'declined' && reason != 'busy' && reason != 'no-answer') {
      Analytics.error(domain: 'call_setup', code: 'never_connected', action: reason);
    }
  }
}
