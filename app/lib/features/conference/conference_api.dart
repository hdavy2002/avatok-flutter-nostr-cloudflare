// AvaTalk group conferencing API client (Phase 10 — LiveKit, ≤25 participants).
// Talks to the avatok-api Worker (`routes/conference.ts`), which mints LiveKit
// access tokens after checking membership + the 25-member cap. 1:1 calls do NOT
// go through here — they stay on the P2P CallRoom-DO path (call_screen.dart).
import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';

class ConferenceTicket {
  final String url;    // LiveKit ws(s) URL
  final String token;  // access token (identity = my Clerk uid)
  final String room;   // "group:<gid>"
  final String kind;   // "video" | "audio"
  const ConferenceTicket({required this.url, required this.token, required this.room, required this.kind});
}

class ConferenceStatus {
  final bool live;
  final int count;
  const ConferenceStatus(this.live, this.count);
}

/// Thrown with a user-presentable message (cap reached, disabled, not live…).
class ConferenceException implements Exception {
  final String message;
  final int status;
  const ConferenceException(this.message, this.status);
  @override
  String toString() => message;
}

/// Thrown when the server refuses an SFU token because the caller is on the FREE
/// plan — free group calls are P2P mesh (≤[maxMesh]). The client routes to
/// MeshCallScreen instead of ConferenceScreen.
class MeshRequiredException implements Exception {
  final int maxMesh;
  const MeshRequiredException(this.maxMesh);
}

class ConferenceApi {
  static ConferenceTicket _ticket(String body) {
    final j = jsonDecode(body) as Map<String, dynamic>;
    return ConferenceTicket(
      url: j['url'].toString(), token: j['token'].toString(),
      room: (j['room'] ?? '').toString(), kind: (j['kind'] ?? 'video').toString(),
    );
  }

  static Never _fail(int code, String body) {
    String msg = 'Conference error (HTTP $code)';
    try {
      final j = jsonDecode(body);
      if (j is Map) {
        // Free plan → P2P mesh. Signal the caller to route to MeshCallScreen.
        if (j['mode'] == 'mesh') throw MeshRequiredException((j['maxMesh'] as num?)?.toInt() ?? 5);
        if (j['error'] != null) msg = j['error'].toString();
      }
    } catch (e) {
      if (e is MeshRequiredException) rethrow;
    }
    throw ConferenceException(msg, code);
  }

  /// Per-minute SFU metering beat (paid plans). Returns true if the call may
  /// continue; false when the plan's conf_min daily cap is exhausted (the caller
  /// should leave and show an upgrade prompt). Never drops a call on a transient
  /// error — only a hard 402 returns false.
  static Future<bool> beat(String gid, {int minutes = 1}) async {
    try {
      final res = await ApiAuth.postJson('$kConferenceBase/$gid/beat', {'minutes': minutes},
          timeout: const Duration(seconds: 10));
      return res.statusCode != 402;
    } catch (_) {
      return true;
    }
  }

  /// Start (or rejoin) the group's conference. Server enforces membership and
  /// the ≤25 rule; LiveKit max_participants=25 is the backstop.
  static Future<ConferenceTicket> start(String gid, {required bool video}) async {
    final res = await ApiAuth.postJson('$kConferenceBase/$gid/start', {'kind': video ? 'video' : 'audio'},
        timeout: const Duration(seconds: 15));
    AvaLog.I.log('conference', 'start $gid -> HTTP ${res.statusCode}');
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return _ticket(res.body);
  }

  /// Join a live conference (404 if none is running, 409 if full).
  static Future<ConferenceTicket> join(String gid) async {
    final res = await ApiAuth.postJson('$kConferenceBase/$gid/join', const {},
        timeout: const Duration(seconds: 15));
    AvaLog.I.log('conference', 'join $gid -> HTTP ${res.statusCode}');
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return _ticket(res.body);
  }

  /// "End for all" — only honoured by the server for the call starter.
  static Future<void> end(String gid) async {
    try { await ApiAuth.postJson('$kConferenceBase/$gid/end', const {}); } catch (_) {/* best-effort */}
  }

  /// Is there an ongoing call? (drives the in-chat "tap to join" banner)
  static Future<ConferenceStatus> status(String gid) async {
    try {
      final res = await ApiAuth.getSigned('$kConferenceBase/$gid/status');
      if (res.statusCode != 200) return const ConferenceStatus(false, 0);
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return ConferenceStatus(j['live'] == true, (j['count'] as num?)?.toInt() ?? 0);
    } catch (_) {
      return const ConferenceStatus(false, 0);
    }
  }
}
