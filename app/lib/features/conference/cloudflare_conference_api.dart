// [CF-CALL-003] Typed client for the Cloudflare Realtime A/V group-call wire
// contract (Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md
// Phase 2/3, worker/src/routes/groupcall.ts, worker/src/do/group_call_room.ts).
//
// This is the ticket-authenticated contract that superseded the audio-only
// `sfu_group_call_api.dart` shape (see the Spec's "groupAudioSfuEnabled is
// SUPERSEDED" section) — join returns `join_ticket`/`ws_url`/`call_id`/
// `call_trace_id`/`generation`/`session_id`, and the WS upgrade is ticket-only
// (no `id`/`session` query params). Do NOT reuse `SfuGroupCallApi` for this
// path; it predates the ticket contract and cannot speak to it.
//
// Never logs SDP, ICE credentials, or the raw ticket (Non-negotiable rule 7 /
// telemetry contract §0.3) — callers must not print `wsUrl` verbatim either;
// use `CloudflareConferenceApi.wsUrlOriginOnly` when a loggable form is needed.
import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';

const String kCfGroupCallBase = '$kApiBase/groupcall';

class CfJoinResult {
  final String provider; // "cloudflare_realtime"
  final String callId;
  final String callTraceId;
  final String sessionId;
  final String joinTicket;
  final List<dynamic> iceServers;
  final bool mediaAudio;
  final bool mediaVideo;
  final int maxParticipants;
  final String wsUrl;
  final int generation;
  /// [GCALL-W1-RELAY] The Worker has always sent `relay_available`/
  /// `relay_degraded`/`relay_reason` on join; the client simply dropped them,
  /// so a call running without a usable TURN relay looked identical to a
  /// healthy one right up until the media didn't connect.
  final bool relayAvailable;
  final bool relayDegraded;
  final String? relayReason;

  const CfJoinResult({
    required this.provider,
    required this.callId,
    required this.callTraceId,
    required this.sessionId,
    required this.joinTicket,
    required this.iceServers,
    required this.mediaAudio,
    required this.mediaVideo,
    required this.maxParticipants,
    required this.wsUrl,
    required this.generation,
    this.relayAvailable = true,
    this.relayDegraded = false,
    this.relayReason,
  });

  /// Loggable / telemetry-safe form: bare `wss://host/path`, ticket query
  /// stripped (telemetry contract §0.3 forbids the ticket/nonce query string).
  String get wsUrlOriginOnly {
    try {
      final u = Uri.parse(wsUrl);
      return '${u.scheme}://${u.host}${u.path}';
    } catch (_) {
      return '';
    }
  }

  factory CfJoinResult.fromJson(Map<String, dynamic> j) {
    final media = (j['media'] as Map?)?.cast<String, dynamic>() ?? const {};
    return CfJoinResult(
      provider: (j['provider'] ?? 'cloudflare_realtime').toString(),
      callId: (j['call_id'] ?? '').toString(),
      callTraceId: (j['call_trace_id'] ?? j['call_id'] ?? '').toString(),
      sessionId: (j['session_id'] ?? '').toString(),
      joinTicket: (j['join_ticket'] ?? '').toString(),
      iceServers: (j['ice_servers'] as List?) ?? const [],
      mediaAudio: media['audio'] != false,
      mediaVideo: media['video'] == true,
      maxParticipants: (j['max_participants'] as num?)?.toInt() ?? 25,
      wsUrl: (j['ws_url'] ?? '').toString(),
      generation: (j['generation'] as num?)?.toInt() ?? 1,
      relayAvailable: j['relay_available'] != false,
      relayDegraded: j['relay_degraded'] == true,
      relayReason: j['relay_reason']?.toString(),
    );
  }
}

class CfTrackSpec {
  final String location; // always "local" on publish
  final String mid;
  final String kind; // "audio" | "video"
  final String trackName;
  const CfTrackSpec({required this.mid, required this.kind, required this.trackName, this.location = 'local'});
  Map<String, dynamic> toJson() => {'location': location, 'mid': mid, 'kind': kind, 'trackName': trackName};
}

class CfPublishResult {
  final Map<String, dynamic>? answer; // {type, sdp}
  final List<dynamic> tracks;
  const CfPublishResult(this.answer, this.tracks);
}

class CfPullResult {
  final Map<String, dynamic>? offer; // {type, sdp}
  final List<dynamic> tracks;
  final bool renegotiate;
  const CfPullResult(this.offer, this.tracks, this.renegotiate);
}

class CloudflareConferenceException implements Exception {
  final String message;
  final int status;
  const CloudflareConferenceException(this.message, this.status);
  @override
  String toString() => message;
}

class CloudflareConferenceApi {
  static Never _fail(int code, String body) {
    var msg = 'Group call error (HTTP $code)';
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] != null) msg = j['error'].toString();
    } catch (_) {/* keep default */}
    throw CloudflareConferenceException(msg, code);
  }

  /// POST /join {video?} → the ticket-authenticated join contract.
  static Future<CfJoinResult> join(String gid, {bool video = false}) async {
    final res = await ApiAuth.postJson('$kCfGroupCallBase/$gid/join', {'video': video},
        timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return CfJoinResult.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// POST /rejoin {sessionId} → a fresh one-time WS ticket for the existing
  /// SFU session. Ticket nonces are consumed at upgrade and cannot be reused.
  static Future<CfJoinResult> rejoin(String gid, {required String sessionId}) async {
    final res = await ApiAuth.postJson('$kCfGroupCallBase/$gid/rejoin', {'sessionId': sessionId},
        timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    return CfJoinResult.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// POST /publish {sessionId, offer:{sdp}, tracks:[...]} → {answer, tracks}.
  /// `attempt` increments on a retried publish (e.g. after generation_conflict)
  /// per the telemetry contract §3.1 — the server counts it, we just pass it.
  static Future<CfPublishResult> publish(
    String gid,
    String sessionId,
    String offerSdp,
    List<CfTrackSpec> tracks, {
    int attempt = 1,
  }) async {
    final res = await ApiAuth.postJson('$kCfGroupCallBase/$gid/publish', {
      'sessionId': sessionId,
      'offer': {'type': 'offer', 'sdp': offerSdp},
      'tracks': tracks.map((t) => t.toJson()).toList(),
      'attempt': attempt,
    }, timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return CfPublishResult(
      (j['answer'] as Map?)?.cast<String, dynamic>(),
      (j['tracks'] as List?) ?? const [],
    );
  }

  /// POST /pull {sessionId, remoteSessionId, remoteUid, kind, trackName, maxVideo?, rid?}
  /// → {offer, tracks, renegotiate}.
  static Future<CfPullResult> pull(
    String gid, {
    required String sessionId,
    required String remoteSessionId,
    required String remoteUid,
    required String kind, // "audio" | "video"
    required String trackName,
    int? maxVideo,
    String? rid,
    int attempt = 1,
  }) async {
    final res = await ApiAuth.postJson('$kCfGroupCallBase/$gid/pull', {
      'sessionId': sessionId,
      'remoteSessionId': remoteSessionId,
      'remoteUid': remoteUid,
      'kind': kind,
      'trackName': trackName,
      if (maxVideo != null) 'maxVideo': maxVideo,
      if (rid != null) 'rid': rid,
      'attempt': attempt,
    }, timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return CfPullResult(
      (j['offer'] as Map?)?.cast<String, dynamic>(),
      (j['tracks'] as List?) ?? const [],
      j['renegotiate'] == true,
    );
  }

  /// PUT /renegotiate {sessionId, answer:{sdp}} → {ok}.
  static Future<void> renegotiate(String gid, String sessionId, String answerSdp) async {
    final res = await ApiAuth.putJson('$kCfGroupCallBase/$gid/renegotiate', {
      'sessionId': sessionId,
      'answer': {'type': 'answer', 'sdp': answerSdp},
    }, timeout: const Duration(seconds: 15));
    if (res.statusCode != 200) _fail(res.statusCode, res.body);
  }

  /// POST /close {sessionId, mids, tracks?} — best-effort, never throws (mirrors
  /// SfuGroupCallApi.close: closing tracks must never block a leave/teardown).
  static Future<void> close(String gid, String sessionId, List<String> mids,
      {List<Map<String, String>>? tracks}) async {
    try {
      await ApiAuth.postJson('$kCfGroupCallBase/$gid/close', {
        'sessionId': sessionId,
        'mids': mids,
        if (tracks != null) 'tracks': tracks,
      }, timeout: const Duration(seconds: 10));
    } catch (_) {/* best-effort */}
  }

  /// GET /status — in-chat "ongoing call" banner probe.
  ///
  /// [GCALL-W1-STATUS] The record now carries four more fields the Worker was
  /// either already able to answer or has just been taught to:
  ///  - `mediaKind`/`state`: so the banner can join with the call's ACTUAL media
  ///    kind. It hardcoded a video join, and a video publish into an audio call
  ///    is rejected server-side — which failed the entire join, not just the
  ///    camera.
  ///  - `available`/`unavailableReason`: so "calls are switched off", "we
  ///    couldn't reach the call service" and "there is no call right now" stop
  ///    collapsing into one indistinguishable `live:false`.
  /// A transport failure reports `unavailableReason:'network'` rather than
  /// pretending the service said no.
  static Future<({
    bool live,
    int count,
    int max,
    String? callId,
    String? state,
    String? mediaKind,
    bool available,
    String? unavailableReason,
  })> status(String gid) async {
    try {
      final res = await ApiAuth.getSigned('$kCfGroupCallBase/$gid/status');
      if (res.statusCode != 200) {
        return (live: false, count: 0, max: 25, callId: null, state: null,
            mediaKind: null, available: false, unavailableReason: 'http_${res.statusCode}');
      }
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return (
        live: j['live'] == true,
        count: (j['count'] as num?)?.toInt() ?? 0,
        max: (j['max'] as num?)?.toInt() ?? 25,
        callId: j['call_id']?.toString(),
        state: j['state']?.toString(),
        mediaKind: j['media_kind']?.toString(),
        // Absent on a Worker that predates this field — treat silence as
        // available so an old backend keeps behaving exactly as it used to.
        available: j['available'] != false,
        unavailableReason: j['unavailable_reason']?.toString(),
      );
    } catch (_) {
      return (live: false, count: 0, max: 25, callId: null, state: null,
          mediaKind: null, available: false, unavailableReason: 'network');
    }
  }
}

/// Durable migration/billing control plane. Media tickets and SDP remain on
/// CloudflareConferenceApi; these calls only coordinate the make-before-break
/// protocol and server-owned sponsor state.
class ConferenceRoomApi {
  static String _url(String roomId, String action) => '$kApiBase/conference-room/$roomId/$action';

  static Future<Map<String, dynamic>> _post(String roomId, String action, Map<String, dynamic> body) async {
    final res = await ApiAuth.postJson(_url(roomId, action), body, timeout: const Duration(seconds: 15));
    if (res.statusCode < 200 || res.statusCode >= 300) CloudflareConferenceApi._fail(res.statusCode, res.body);
    return (jsonDecode(res.body) as Map).cast<String, dynamic>();
  }

  static Future<Map<String, dynamic>> state(String roomId) async {
    final res = await ApiAuth.getSigned(_url(roomId, 'state'));
    if (res.statusCode != 200) CloudflareConferenceApi._fail(res.statusCode, res.body);
    return (jsonDecode(res.body) as Map).cast<String, dynamic>();
  }

  static Future<Map<String, dynamic>> start(String roomId, {required String groupId, String mediaKind = 'audio'}) => _post(roomId, 'start', {'group_id': groupId, 'media_kind': mediaKind});
  static Future<Map<String, dynamic>> reserveMigration(String roomId, {required String callEpoch}) => _post(roomId, 'migration/reserve', {'call_epoch': callEpoch});
  static Future<Map<String, dynamic>> prepareMigration(String roomId, {required String migrationId, required String callEpoch}) => _post(roomId, 'migration/prepare', {'migration_id': migrationId, 'call_epoch': callEpoch});
  static Future<Map<String, dynamic>> commitMigration(String roomId, {required String migrationId, required bool sfuReady}) => _post(roomId, 'migration/commit', {'migration_id': migrationId, 'sfu_ready': sfuReady});
  static Future<Map<String, dynamic>> abortMigration(String roomId, {required String migrationId}) => _post(roomId, 'migration/abort', {'migration_id': migrationId});
  static Future<Map<String, dynamic>> reserveParticipant(String roomId, {String? sessionId}) => _post(roomId, 'participant/reserve', {'session_id': sessionId});
  static Future<Map<String, dynamic>> joinParticipant(String roomId, {String? sessionId}) => _post(roomId, 'participant/join', {'session_id': sessionId});
  static Future<Map<String, dynamic>> leaveParticipant(String roomId) => _post(roomId, 'participant/leave', const {});
  static Future<Map<String, dynamic>> acceptSponsorship(String roomId, {required int reservedMinutes}) => _post(roomId, 'billing/sponsor/accept', {'reserved_minutes': reservedMinutes});
  static Future<Map<String, dynamic>> startBilling(String roomId, {required int reservedMinutes}) => _post(roomId, 'billing/start', {'reserved_minutes': reservedMinutes});
  static Future<Map<String, dynamic>> billingTick(String roomId, {required String segmentId, required int minuteIndex}) => _post(roomId, 'billing/tick', {'segment_id': segmentId, 'minute_index': minuteIndex});
  static Future<Map<String, dynamic>> transferHost(String roomId, {required String targetUid}) => _post(roomId, 'host/transfer', {'target_uid': targetUid});
  static Future<Map<String, dynamic>> end(String roomId) => _post(roomId, 'end', const {});
}
