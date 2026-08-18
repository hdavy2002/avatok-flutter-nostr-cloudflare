/// [CALL-SFU-1 2026-08-06] Thin client for the 1:1 SFU media routes.
///
/// Mirrors `features/conference/cloudflare_conference_api.dart` on purpose: same
/// shape, same timeouts, same "the server owns the contract, we just pass it"
/// discipline. The group version is the one that has been in production since the
/// LiveKit cutover, so it is the reference implementation, not this file.
///
/// The ONE deliberate difference: [CallSfuJoinResult] surfaces `relayAvailable`
/// and `relayDegraded` and callers are expected to act on them. The P2P path's
/// `ice_cache.dart` parsed only `iceServers` and silently threw the relay status
/// away, which is why a TURN outage and a healthy deployment looked identical
/// from the app. Not repeating that mistake on the new transport.
library;

import 'dart:convert';

import '../api_auth.dart';
import '../config.dart';

String get _base => '$kApiBase/callsfu';

/// Thrown for any non-200. Carries the server's own `error` string so the caller
/// can branch on `sfu_unavailable` (fall back to P2P, expected) versus a real
/// failure, rather than guessing from an HTTP code.
class CallSfuException implements Exception {
  CallSfuException(this.error, this.status);
  final String error;
  final int status;

  /// True when the server is telling us the SFU is off or unconfigured — a
  /// deliberate, non-alarming refusal that should route the call to P2P.
  bool get unavailable => error == 'sfu_unavailable' || status == 503;

  @override
  String toString() => 'CallSfuException($error, $status)';
}

Never _fail(int status, String body) {
  String err = 'http_$status';
  try {
    final j = jsonDecode(body);
    if (j is Map && j['error'] is String) err = j['error'] as String;
  } catch (_) {/* non-JSON body: keep http_<status> */}
  throw CallSfuException(err, status);
}

class CallSfuJoinResult {
  CallSfuJoinResult({
    required this.sessionId,
    required this.iceServers,
    required this.relayAvailable,
    required this.relayDegraded,
    required this.videoAllowed,
    this.relayReason,
  });

  final String sessionId;
  final List<Map<String, dynamic>> iceServers;
  final bool relayAvailable;
  final bool relayDegraded;

  /// False when the operator has `callSfuAudioOnly` on. Publishing video anyway
  /// gets a 409, so the client must respect this rather than discover it.
  final bool videoAllowed;
  final String? relayReason;

  static CallSfuJoinResult fromJson(Map<String, dynamic> j) => CallSfuJoinResult(
        sessionId: (j['session_id'] ?? '').toString(),
        iceServers: ((j['ice_servers'] as List?) ?? const [])
            .cast<Map>()
            .map((e) => e.cast<String, dynamic>())
            .toList(),
        relayAvailable: j['relay_available'] == true,
        relayDegraded: j['relay_degraded'] == true,
        videoAllowed: ((j['media'] as Map?)?['video']) != false,
        relayReason: j['relay_reason']?.toString(),
      );
}

/// What the other phone is publishing. `sessionId == null` means "not yet" — a
/// normal race, not an error, because both phones create their sessions
/// concurrently. Callers poll.
class CallSfuPeer {
  CallSfuPeer(this.sessionId, this.audioTrack, this.videoTrack);
  final String? sessionId;
  final String? audioTrack;
  final String? videoTrack;

  bool get hasAudio => sessionId != null && audioTrack != null;
  bool get hasVideo => sessionId != null && videoTrack != null;
}

class CallSfuPullResult {
  CallSfuPullResult(this.offer, this.tracks, this.renegotiate);

  /// The SFU offers on a pull — the client answers via [CallSfuApi.renegotiate].
  /// This inversion is Cloudflare's contract, and it is why none of the P2P
  /// ICE-restart machinery (which assumes we always offer) ports over.
  final Map<String, dynamic>? offer;
  final List<dynamic> tracks;
  final bool renegotiate;
}

class CallSfuApi {
  CallSfuApi._();

  static const Duration _t = Duration(seconds: 12);

  /// POST /join → a Cloudflare session for THIS phone, plus ICE servers.
  /// Also registers our seat in the CallRoom DO, which is what makes the peer
  /// able to find us at all.
  static Future<CallSfuJoinResult> join(String room) async {
    final res = await ApiAuth.postJson('$_base/$room/join', const {}, timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return CallSfuJoinResult.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// POST /prepare — negotiate a datachannel-only transport against an
  /// already-joined SFU session. The accepted call later re-offers on this
  /// same PC after adding its microphone.
  static Future<Map<String, dynamic>?> prepare(
    String room,
    String sessionId,
    String offerSdp,
  ) async {
    final res = await ApiAuth.postJson('$_base/$room/prepare', {
      'sessionId': sessionId,
      'offer': {'type': 'offer', 'sdp': offerSdp},
    }, timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final answer = j['answer'];
    if (answer is Map) return answer.cast<String, dynamic>();
    if (j['sdp'] != null) {
      return {'type': (j['type'] ?? 'answer').toString(), 'sdp': j['sdp'].toString()};
    }
    return null;
  }

  /// Tell CallRoom that this foreground-owned transport really reached
  /// ICE/DTLS connected. This is intentionally separate from local telemetry:
  /// the server starts the audible ring only after this acknowledgement.
  static Future<void> prewarmReady(
    String room, {
    required String nonce,
    required int generation,
    required String sessionId,
    required String deviceId,
  }) async {
    final res = await ApiAuth.postJson('$kApiBase/call/command', {
      'callId': room,
      'command': 'prewarm_ready',
      'data': {
        'nonce': nonce,
        'generation': generation,
        'sessionId': sessionId,
        'deviceId': deviceId,
      },
    }, timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
  }

  /// POST /publish — we offer, the SFU answers. Track names are ours to choose;
  /// the server bounds them and records them on our seat so the peer's /peer
  /// read is enough to pull without any extra signalling message.
  static Future<Map<String, dynamic>?> publish(
    String room,
    String sessionId,
    String offerSdp,
    List<Map<String, dynamic>> tracks,
  ) async {
    final res = await ApiAuth.postJson('$_base/$room/publish', {
      'sessionId': sessionId,
      'offer': {'type': 'offer', 'sdp': offerSdp},
      'tracks': tracks,
    }, timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return (j['answer'] as Map?)?.cast<String, dynamic>();
  }

  /// GET /peer — what the other side is publishing, or nulls if not yet.
  static Future<CallSfuPeer> peer(String room) async {
    final res = await ApiAuth.getSigned('$_base/$room/peer', timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final seat = (j['seat'] as Map?)?.cast<String, dynamic>();
    return CallSfuPeer(
      seat?['session_id']?.toString(),
      seat?['audio_track']?.toString(),
      seat?['video_track']?.toString(),
    );
  }

  /// POST /heartbeat — renew this phone's server-owned SFU lease.
  static Future<void> heartbeat(String room, String sessionId) async {
    final res = await ApiAuth.postJson('$_base/$room/heartbeat', {
      'sessionId': sessionId,
    }, timeout: const Duration(seconds: 8));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
  }

  /// POST /pull — the SFU offers us the peer's track. Note we do NOT send the
  /// remote session id: the server reads it from the seat registry, because a
  /// client-nameable session id would let any signed-in user pull anyone's audio.
  static Future<CallSfuPullResult> pull(
    String room, {
    required String sessionId,
    required String kind, // 'audio' | 'video'
  }) async {
    final res = await ApiAuth.postJson('$_base/$room/pull', {
      'sessionId': sessionId,
      'kind': kind,
    }, timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return CallSfuPullResult(
      (j['offer'] as Map?)?.cast<String, dynamic>(),
      (j['tracks'] as List?) ?? const [],
      j['renegotiate'] == true,
    );
  }

  /// PUT /renegotiate — deliver our answer to a pull offer.
  static Future<void> renegotiate(String room, String sessionId, String answerSdp) async {
    final res = await ApiAuth.putJson('$_base/$room/renegotiate', {
      'sessionId': sessionId,
      'answer': {'type': 'answer', 'sdp': answerSdp},
    }, timeout: _t);
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
  }

  /// POST /close — best-effort, NEVER throws. Closing tracks must not be able to
  /// block a hangup; a call that will not end is a worse bug than a leaked track,
  /// which the SFU reaps on its own anyway.
  static Future<void> close(String room, String sessionId, List<String> mids) async {
    try {
      await ApiAuth.postJson('$_base/$room/close', {
        'sessionId': sessionId,
        'mids': mids,
      }, timeout: const Duration(seconds: 8));
    } catch (_) {/* teardown is unconditional */}
  }
}
