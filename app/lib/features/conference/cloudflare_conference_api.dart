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

// ─────────────────────────────────────────────────────────────────────────────
//  [ADDCALL-3-UI 2026-08-06] Ringing people INTO a call that is already running.
//
//  Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §5. Server:
//  `worker/src/routes/groupcall.ts` `groupCallInvite` (`[ADDCALL-3-SRV]`).
//
//  ── TWO STEPS, IN THIS ORDER, ALWAYS ─────────────────────────────────────────
//    1. `AdhocRoomApi.add`  → writes the `conversation_members` rows.
//    2. `GroupCallInviteApi.invite` → rings them.
//
//  Step 2 deliberately does NOT insert membership: a uid with no row comes back
//  in `failed` with `not_a_member` and is not rung. `guard()` is the single
//  authorization path for every groupcall endpoint, so a route that inserted the
//  row it needs to pass its own check would be authorizing itself. Both steps are
//  idempotent, so a client that loses either response may safely repeat both.
//
//  THE ESCALATION PATH SKIPS STEP 1. `POST /api/adhoc-room/create` already wrote
//  every invitee's membership row, so `call_screen.dart` calls invite ONLY.
//  Calling `add` there too would be a redundant round trip on the critical path
//  of a live call.
//
//  ── WHY THIS ONE DOES NOT THROW ──────────────────────────────────────────────
//  Same reasoning as `core/calls/adhoc_room_api.dart`: every refusal here is a
//  DIFFERENT sentence to a human, and — uniquely — most of them are PER PERSON.
//  "Sam is already in the call" and "we couldn't reach Priya's phone" are not the
//  same event and must not collapse into one thrown string. `CloudflareConferenceApi`
//  throws because its callers are media plumbing with one failure mode; this one
//  is read by a person.
//
//  ── DECLINE IS NOT IMPLEMENTED FOR GROUP RINGS (spec §5, accepted for v1) ─────
//  There is no receipt token, no per-callee record and no server ring deadline. A
//  ring that nobody answers simply times out at 45s and writes a `missed` call-log
//  entry. **No copy in this file may imply a decline was received.** "Ringing X…"
//  is the strongest thing we can honestly say, and `groupcall_invite_declined`
//  exists in the catalogue with no emit site on either side. If you are adding
//  copy here, do not write "X declined", "X didn't answer" or "no answer" — we
//  cannot tell those apart from "the ring is still going".
// ─────────────────────────────────────────────────────────────────────────────

/// Why ONE requested uid was not rung. Mirrors `InviteFailReason` in
/// `groupcall.ts` — these strings are part of the wire contract.
enum GroupCallInviteFail {
  /// You cannot invite yourself. A client bug (the picker excludes self).
  self,

  /// No `conversation_members` row — step 1 was skipped or lost.
  notAMember,

  /// A block exists in either direction with the inviter.
  blocked,

  /// Already has a live socket in this call.
  alreadyPresent,

  /// The call's ring-target list is full (server-side, 64).
  ringTargetCap,

  /// Both the WS frame and the FCM push failed for this uid.
  ringFailed,

  /// A reason string this build does not know — a newer Worker. Always renders
  /// as an honest generic rather than the raw enum value.
  unknown,
}

/// One person's outcome. [uid] is never rendered — [sentence] takes the display
/// name the UI already has.
class GroupCallInviteFailure {
  const GroupCallInviteFailure(this.uid, this.reason, this.raw);

  final String uid;
  final GroupCallInviteFail reason;

  /// The server's own string, for telemetry only. Never rendered.
  final String raw;

  static GroupCallInviteFail _parse(String r) {
    switch (r) {
      case 'self':
        return GroupCallInviteFail.self;
      case 'not_a_member':
        return GroupCallInviteFail.notAMember;
      case 'blocked':
        return GroupCallInviteFail.blocked;
      case 'already_present':
        return GroupCallInviteFail.alreadyPresent;
      case 'ring_target_cap':
        return GroupCallInviteFail.ringTargetCap;
      case 'ring_failed':
        return GroupCallInviteFail.ringFailed;
      default:
        return GroupCallInviteFail.unknown;
    }
  }

  /// A finished sentence about [name]. Never mentions a decline (see the header).
  String sentence(String name) {
    switch (reason) {
      case GroupCallInviteFail.self:
        return "You're already in this call.";
      case GroupCallInviteFail.notAMember:
        return "We couldn't add $name to this call.";
      case GroupCallInviteFail.blocked:
        // Deliberately does NOT say who blocked whom — the direction is private.
        return "You can't add $name.";
      case GroupCallInviteFail.alreadyPresent:
        return '$name is already in the call.';
      case GroupCallInviteFail.ringTargetCap:
        return "$name couldn't be rung — too many people have been invited to "
            'this call.';
      case GroupCallInviteFail.ringFailed:
        return "We couldn't reach $name's phone.";
      case GroupCallInviteFail.unknown:
        return "We couldn't ring $name.";
    }
  }
}

/// Whole-request refusals — the invite reached nobody.
enum GroupCallInviteError {
  /// 403 `{error:"disabled", flag:"addToCallEnabled"}`.
  disabled,

  /// 403 `{error:"not a member"}` — you are not in this conversation.
  notAMember,

  /// 400 `{error:"uids required"}` — a client bug, never the user's fault.
  badRequest,

  /// 409 `{code:"not_live"}` — the call ended underneath us.
  notLive,

  /// 409 `{code:"call_full", cap, count}`.
  callFull,

  /// 502 — the ring or the call authority failed. NOBODY was rung.
  ringFailed,

  /// No network, timeout, non-JSON body, 5xx.
  network,

  unknown,
}

/// The outcome of one `POST /invite`.
///
/// On [ok] the request succeeded but individual people may still have failed —
/// [rung] and [failed] are BOTH meaningful and the UI must show both. That split
/// is the whole reason the route answers per-uid.
class GroupCallInviteResult {
  const GroupCallInviteResult._({
    required this.ok,
    this.callId = '',
    this.generation,
    this.count,
    this.cap,
    this.rung = const [],
    this.failed = const [],
    this.error,
    this.message = '',
    this.raw = '',
    this.status = 0,
  });

  final bool ok;

  /// The call's EXISTING call_id — not a new one. Useful for stitching client
  /// telemetry to the server's `groupcall_invite_sent`.
  final String callId;
  final int? generation;
  final int? count;

  /// Set on [GroupCallInviteError.callFull] — the server's cap, authoritative.
  final int? cap;

  /// Whose phone we asked to ring. NOT "who joined" and NOT "who accepted" —
  /// there is no accept receipt for a group ring (see the header).
  final List<String> rung;
  final List<GroupCallInviteFailure> failed;

  final GroupCallInviteError? error;

  /// A finished sentence for a whole-request failure. Empty when [ok].
  final String message;

  /// The server's `error` string, telemetry only. Never rendered.
  final String raw;
  final int status;

  /// Every per-person line, in the order a person would want to read them:
  /// who is being rung first, then who was not.
  ///
  /// [nameOf] resolves a uid to the display name the caller already has;
  /// it should fall back to something human ("Someone"), never a raw uid.
  List<String> lines(String Function(String uid) nameOf) {
    final out = <String>[];
    if (rung.isNotEmpty) {
      out.add('Ringing ${_join(rung.map(nameOf).toList())}…');
    }
    for (final f in failed) {
      out.add(f.sentence(nameOf(f.uid)));
    }
    return out;
  }

  /// [lines] as one paragraph, for a notice bar or a snackbar.
  String summary(String Function(String uid) nameOf) => lines(nameOf).join(' ');

  /// `['a:not_a_member', 'b:blocked']` — the telemetry shape the Worker uses for
  /// `failed_uids`, so both halves of the funnel are directly comparable.
  List<String> get failedTags =>
      failed.map((f) => '${f.uid}:${f.raw}').toList(growable: false);

  static String _join(List<String> names) {
    if (names.isEmpty) return '';
    if (names.length == 1) return names.first;
    if (names.length == 2) return '${names[0]} and ${names[1]}';
    return '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
  }
}

class GroupCallInviteApi {
  GroupCallInviteApi._();

  /// Longer than a media call's 15s would buy us nothing — the route rings each
  /// target over WS and FCM before answering, and it runs while the user is
  /// looking at a live call. 20s is the point past which "did it work?" is a
  /// better question than "wait longer".
  static const Duration _t = Duration(seconds: 20);

  /// POST /api/groupcall/:gid/invite — ring [uids] into the call already running
  /// in [gid]. **They must already be `conversation_members`** (see the header).
  static Future<GroupCallInviteResult> invite(String gid, List<String> uids) async {
    if (uids.isEmpty) {
      return const GroupCallInviteResult._(
        ok: false,
        error: GroupCallInviteError.badRequest,
        message: 'Select who to add to the call.',
        raw: 'no_uids',
      );
    }
    try {
      final res = await ApiAuth.postJson(
          '$kCfGroupCallBase/$gid/invite', {'uids': uids}, timeout: _t);
      Map<String, dynamic>? j;
      try {
        final d = jsonDecode(res.body);
        if (d is Map) j = d.cast<String, dynamic>();
      } catch (_) {/* non-JSON — falls through to the error map below */}

      if (res.statusCode == 200 && j != null && j['ok'] == true) {
        return GroupCallInviteResult._(
          ok: true,
          callId: (j['call_id'] ?? '').toString(),
          generation: (j['generation'] as num?)?.toInt(),
          count: (j['count'] as num?)?.toInt(),
          rung: ((j['rung'] as List?) ?? const [])
              .map((e) => e.toString())
              .toList(),
          failed: ((j['failed'] as List?) ?? const []).map((e) {
            final m = (e is Map)
                ? e.cast<String, dynamic>()
                : const <String, dynamic>{};
            final raw = (m['reason'] ?? '').toString();
            return GroupCallInviteFailure(
                (m['uid'] ?? '').toString(),
                GroupCallInviteFailure._parse(raw),
                raw);
          }).toList(),
          status: res.statusCode,
        );
      }
      return _mapError(res.statusCode, j);
    } catch (e) {
      // The call is still up — say what happened rather than implying anyone was
      // rung. Nobody was.
      return GroupCallInviteResult._(
        ok: false,
        error: GroupCallInviteError.network,
        message: "We couldn't reach the call service, so nobody was rung. Check "
            'your connection and try again.',
        raw: e.runtimeType.toString(),
      );
    }
  }

  static GroupCallInviteResult _mapError(int status, Map<String, dynamic>? j) {
    final err = (j?['error'] ?? '').toString();
    final code = (j?['code'] ?? '').toString();
    final cap = (j?['cap'] as num?)?.toInt();

    GroupCallInviteError kind;
    String msg;

    if (err == 'disabled') {
      kind = GroupCallInviteError.disabled;
      msg = 'Adding people to a call is switched off right now. This is a '
          'setting on our side, not something wrong with your call.';
    } else if (err == 'not a member') {
      kind = GroupCallInviteError.notAMember;
      msg = "You're not in this call any more.";
    } else if (err == 'uids required') {
      kind = GroupCallInviteError.badRequest;
      msg = 'Select who to add to the call.';
    } else if (code == 'not_live') {
      kind = GroupCallInviteError.notLive;
      msg = 'This call has already ended, so nobody was rung.';
    } else if (code == 'call_full') {
      kind = GroupCallInviteError.callFull;
      msg = cap == null
          ? 'This call is full, so nobody else can be rung.'
          : 'This call is full — it can have at most $cap people.';
    } else if (status == 502) {
      kind = GroupCallInviteError.ringFailed;
      msg = "We couldn't reach the call service, so nobody was rung. Please try "
          'again.';
    } else {
      kind = GroupCallInviteError.unknown;
      msg = "We couldn't ring anyone into this call. Please try again.";
    }

    return GroupCallInviteResult._(
      ok: false,
      error: kind,
      message: msg,
      raw: err.isEmpty ? 'http_$status' : err,
      status: status,
      cap: cap,
      count: (j?['count'] as num?)?.toInt(),
    );
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

  /// [ADDCALL-2-UI] NO `call_epoch` HERE. `ConferenceRoomDO.reserveMigration`
  /// does not read one — it RETURNS the `generation` that `prepare` must echo
  /// back. Sending an epoch to reserve was harmless (the DO ignores unknown
  /// body keys) but it invited the far more expensive mistake of computing the
  /// epoch from the wrong counter and only finding out at `prepare`, which 409s
  /// `stale_epoch` three steps from the cause. Take the value from the server's
  /// own answer and echo it; never derive it.
  static Future<Map<String, dynamic>> reserveMigration(String roomId) => _post(roomId, 'migration/reserve', const {});

  /// `callEpoch` is `ConferenceRoomDO`'s `generation` — NOT the 1:1 call's
  /// epoch. They are different counters over different lifecycles. Pass the
  /// `generation` returned by [start] or [reserveMigration].
  static Future<Map<String, dynamic>> prepareMigration(String roomId, {required String migrationId, required String callEpoch}) => _post(roomId, 'migration/prepare', {'migration_id': migrationId, 'call_epoch': callEpoch});
  static Future<Map<String, dynamic>> commitMigration(String roomId, {required String migrationId, required bool sfuReady}) => _post(roomId, 'migration/commit', {'migration_id': migrationId, 'sfu_ready': sfuReady});
  static Future<Map<String, dynamic>> abortMigration(String roomId, {String? migrationId, String? reason}) => _post(roomId, 'migration/abort', {
        if (migrationId != null) 'migration_id': migrationId,
        if (reason != null) 'reason': reason,
      });

  /// [ADDCALL-2-UI] Spec §4.1 step 8 — the 1:1 leg is down and the escalation is
  /// finished. POST-COMMIT ONLY (the DO 409s a release before commit, which is
  /// the exact failure make-before-break exists to prevent). Returns
  /// `overlap_ms`: how long this device ran two encoders and two audio sessions.
  static Future<Map<String, dynamic>> releaseMigration(String roomId) => _post(roomId, 'migration/release', const {});
  static Future<Map<String, dynamic>> reserveParticipant(String roomId, {String? sessionId}) => _post(roomId, 'participant/reserve', {'session_id': sessionId});
  static Future<Map<String, dynamic>> joinParticipant(String roomId, {String? sessionId}) => _post(roomId, 'participant/join', {'session_id': sessionId});
  static Future<Map<String, dynamic>> leaveParticipant(String roomId) => _post(roomId, 'participant/leave', const {});
  static Future<Map<String, dynamic>> acceptSponsorship(String roomId, {required int reservedMinutes}) => _post(roomId, 'billing/sponsor/accept', {'reserved_minutes': reservedMinutes});
  static Future<Map<String, dynamic>> startBilling(String roomId, {required int reservedMinutes}) => _post(roomId, 'billing/start', {'reserved_minutes': reservedMinutes});
  static Future<Map<String, dynamic>> billingTick(String roomId, {required String segmentId, required int minuteIndex}) => _post(roomId, 'billing/tick', {'segment_id': segmentId, 'minute_index': minuteIndex});
  static Future<Map<String, dynamic>> transferHost(String roomId, {required String targetUid}) => _post(roomId, 'host/transfer', {'target_uid': targetUid});
  static Future<Map<String, dynamic>> end(String roomId) => _post(roomId, 'end', const {});
}
