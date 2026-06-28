// CF Realtime SFU group-AUDIO API client (Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md).
// Talks to the avatok-api Worker (`routes/groupcall.ts`) which proxies the
// rtc.live.cloudflare.com sessions/tracks API (the SFU app token stays
// server-side). Audio-only, ≤32, active-speaker pull. Used by
// SfuGroupCallScreen. Gated server- and client-side by groupAudioSfuEnabled.
import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';

/// Base for the group-audio routes. WS is `wss://$kSignalingHost/api/groupcall/<gid>/ws`.
const String kGroupCallBase = '$kApiBase/groupcall';

class SfuJoin {
  final String sessionId;
  final List<dynamic> iceServers;
  final String wsPath;
  final int max;
  const SfuJoin(this.sessionId, this.iceServers, this.wsPath, this.max);
}

class SfuGroupCallException implements Exception {
  final String message;
  final int status;
  const SfuGroupCallException(this.message, this.status);
  @override
  String toString() => message;
}

class SfuGroupCallApi {
  static const int maxParticipants = 32;

  static String wsUrl(String gid, String uid, String sessionId) =>
      'wss://$kSignalingHost/api/groupcall/$gid/ws?id=$uid&session=$sessionId';

  static Never _fail(int code, String body) {
    var msg = 'Group audio error (HTTP $code)';
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] != null) msg = j['error'].toString();
    } catch (_) {/* keep default */}
    throw SfuGroupCallException(msg, code);
  }

  /// Join: server mints an SFU session + ICE + the roster WS path.
  static Future<SfuJoin> join(String gid) async {
    final res = await ApiAuth.postJson('$kGroupCallBase/$gid/join', const {},
        timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return SfuJoin(
      j['sessionId'].toString(),
      (j['iceServers'] as List?) ?? const [],
      (j['wsPath'] ?? '/api/groupcall/$gid/ws').toString(),
      (j['max'] as num?)?.toInt() ?? maxParticipants,
    );
  }

  /// Publish the local mic track: send our offer, get the SFU answer + the
  /// assigned track name (which we then announce to the roster over the WS).
  static Future<Map<String, dynamic>> publish(
      String gid, String sessionId, String offerSdp,
      {String? trackName, String mid = '0'}) async {
    final res = await ApiAuth.postJson('$kGroupCallBase/$gid/publish', {
      'sessionId': sessionId,
      'offer': {'type': 'offer', 'sdp': offerSdp},
      'mid': mid,
      if (trackName != null) 'trackName': trackName,
    }, timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Pull a remote speaker's audio track → returns an SFU offer to apply.
  static Future<Map<String, dynamic>> pull(
      String gid, String sessionId, String remoteSessionId, String trackName) async {
    final res = await ApiAuth.postJson('$kGroupCallBase/$gid/pull', {
      'sessionId': sessionId,
      'remoteSessionId': remoteSessionId,
      'trackName': trackName,
    }, timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Answer the SFU's pull offer.
  static Future<void> renegotiate(String gid, String sessionId, String answerSdp) async {
    final res = await ApiAuth.putJson('$kGroupCallBase/$gid/renegotiate', {
      'sessionId': sessionId,
      'answer': {'type': 'answer', 'sdp': answerSdp},
    }, timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
  }

  /// Close some pulled tracks (a speaker dropped out of the active set).
  static Future<void> close(String gid, String sessionId, List<String> mids) async {
    try {
      await ApiAuth.postJson('$kGroupCallBase/$gid/close',
          {'sessionId': sessionId, 'mids': mids}, timeout: const Duration(seconds: 10));
    } catch (_) {/* best-effort */}
  }

  /// Ongoing-call probe for the in-chat banner.
  static Future<({bool live, int count})> status(String gid) async {
    try {
      final res = await ApiAuth.getSigned('$kGroupCallBase/$gid/status');
      if (res.statusCode != 200) return (live: false, count: 0);
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return (live: j['live'] == true, count: (j['count'] as num?)?.toInt() ?? 0);
    } catch (_) {
      return (live: false, count: 0);
    }
  }
}
