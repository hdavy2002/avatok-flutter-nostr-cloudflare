/// [ADDCALL-1-UI 2026-08-06] Thin client for the two add-to-call routes.
///
/// Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` (§2 the room, §8 caps, §9 phasing).
/// Server: `worker/src/routes/adhoc_room.ts` — `POST /api/adhoc-room/create` and
/// `POST /api/adhoc-room/add`.
///
/// Shaped exactly like `call_sfu_api.dart` beside it: `ApiAuth` for the signed
/// request, one small result class, and no widget/BuildContext anywhere.
///
/// THE ONE DELIBERATE DIFFERENCE from its siblings: this file does NOT throw on a
/// non-200. It returns a typed [AdhocRoomError] the UI can `switch` on, because
/// every one of this route's refusals is a DIFFERENT sentence to a human —
/// "the feature is off", "you have to verify your identity", "a call can hold ten
/// people", "you can't add someone you've blocked". A single thrown exception
/// carrying a raw `error` string ends up rendered as raw JSON in a snackbar,
/// which is exactly what CLAUDE.md's honesty rule forbids. `message` on the
/// result is the sentence; `raw` is kept only for telemetry.
library;

import 'dart:convert';

import '../api_auth.dart';
import '../config.dart';

String get _base => '$kApiBase/adhoc-room';

/// Every way the server can say no, in the client's own vocabulary.
///
/// These map 1:1 onto `adhoc_room.ts`'s responses. `unknown` is the catch-all for
/// a shape we have not seen (an added error code, an HTML error page from an
/// edge, a 500) — it always carries a usable sentence, never an empty string.
enum AdhocRoomError {
  /// 403 `{error:"disabled", flag:"addToCallEnabled"}` — the kill switch is off.
  /// The tile is hidden when the flag is off, so reaching this means the config
  /// changed under a live call: still say so plainly rather than "failed".
  disabled,

  /// 403 `{error:"identity_required"}` — the liveness gate. `ApiAuth`'s global
  /// interceptor has ALREADY opened the consent/Didit flow by the time we see
  /// this (see `core/api_auth.dart`), so the UI must not stack a second prompt
  /// on top; it just stops quietly.
  identityRequired,

  /// 400 `{error:"too_many_participants", code:"adhoc_room_full", max_members, requested}`.
  /// The picker caps selection so this should be unreachable — it is the server's
  /// backstop, and it wins if the two ever disagree.
  full,

  /// 400 `{error:"invalid_invitees", code:"unknown_uid", invalid:[...]}` — a
  /// contact whose uid the server does not know (a stale local contact row, or a
  /// `tel:` phone-only contact that should never have been offered).
  unknownUid,

  /// 403 `{error:"invalid_invitees", code:"blocked", invalid:[...]}` — blocked in
  /// either direction. Deliberately named for the person, not the request.
  blocked,

  /// 404 `{error:"not found"}` (add route) — the room row is gone.
  notFound,

  /// 400 `{error:"not_an_adhoc_room"}` (add route) — we handed it a real group or
  /// a DM. A bug on our side, not something the user did.
  notAnAdhocRoom,

  /// 403 `{error:"not a member"}` (add route).
  notAMember,

  /// Bad request shape, 5xx, non-JSON body, or no network at all.
  unknown,
}

/// The outcome of a create/add. Exactly one of [convId]/[members] (ok) or
/// [error] (not ok) is meaningful.
class AdhocRoomResult {
  const AdhocRoomResult._({
    required this.ok,
    this.convId,
    this.members = const [],
    this.added = const [],
    this.error,
    this.message = '',
    this.raw = '',
    this.status = 0,
    this.maxMembers,
    this.invalid = const [],
  });

  final bool ok;

  /// The invisible `kind='call'` conversation id — the gid the conference joins.
  final String? convId;
  final List<String> members;
  final List<String> added;

  final AdhocRoomError? error;

  /// A finished sentence for a human. Never JSON, never empty on a failure.
  final String message;

  /// The server's own `error` string, for telemetry only. Never rendered.
  final String raw;
  final int status;

  /// Set on [AdhocRoomError.full] — the server's cap, which is authoritative.
  final int? maxMembers;

  /// Set on [AdhocRoomError.unknownUid] / [AdhocRoomError.blocked] — the uids the
  /// server refused, so the picker can name or drop them.
  final List<String> invalid;

  static AdhocRoomResult _ok(Map<String, dynamic> j) => AdhocRoomResult._(
        ok: true,
        convId: j['conv_id']?.toString(),
        members: ((j['members'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(),
        added: ((j['added'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(),
      );
}

class AdhocRoomApi {
  AdhocRoomApi._();

  /// Longer than `CallSfuApi`'s 12s on purpose: create does an identity gate, two
  /// D1 lookups and a batched write, and it runs while the user is staring at a
  /// live call. A premature timeout here would end the 1:1 for a room that in
  /// fact got created.
  static const Duration _t = Duration(seconds: 15);

  /// POST /api/adhoc-room/create — mint the invisible room for an escalating 1:1.
  ///
  /// [callId] is the live 1:1 room id, [peerUid] the person already on the call
  /// (the server adds them; do NOT put them in [invitees]).
  static Future<AdhocRoomResult> create({
    required String callId,
    required String peerUid,
    required List<String> invitees,
    String? title,
  }) async {
    return _post('$_base/create', {
      'call_id': callId,
      'peer_uid': peerUid,
      'invitees': invitees,
      if (title != null && title.isNotEmpty) 'title': title,
    });
  }

  /// POST /api/adhoc-room/add — add more people to a room that already exists.
  static Future<AdhocRoomResult> add({
    required String convId,
    required List<String> invitees,
  }) async {
    return _post('$_base/add', {'conv_id': convId, 'invitees': invitees});
  }

  static Future<AdhocRoomResult> _post(String url, Map<String, dynamic> body) async {
    try {
      final res = await ApiAuth.postJson(url, body, timeout: _t);
      Map<String, dynamic>? j;
      try {
        final d = jsonDecode(res.body);
        if (d is Map) j = d.cast<String, dynamic>();
      } catch (_) {/* non-JSON body — handled as unknown below */}
      if (res.statusCode == 200 && j != null && j['ok'] == true) {
        return AdhocRoomResult._ok(j);
      }
      return _mapError(res.statusCode, j);
    } catch (e) {
      // Network/timeout. The call is still up at this point — say what happened
      // rather than pretending the room exists.
      return AdhocRoomResult._(
        ok: false,
        error: AdhocRoomError.unknown,
        message: "We couldn't reach the call service. Check your connection and "
            'try again.',
        raw: e.runtimeType.toString(),
      );
    }
  }

  static AdhocRoomResult _mapError(int status, Map<String, dynamic>? j) {
    final err = (j?['error'] ?? '').toString();
    final code = (j?['code'] ?? '').toString();
    final invalid = ((j?['invalid'] as List?) ?? const [])
        .map((e) => e.toString())
        .toList();

    AdhocRoomError kind;
    String msg;
    int? maxMembers;

    if (err == 'disabled') {
      kind = AdhocRoomError.disabled;
      msg = 'Adding people to a call is switched off right now. This is a '
          'setting on our side, not something wrong with your call.';
    } else if (err == 'identity_required') {
      kind = AdhocRoomError.identityRequired;
      // ApiAuth has already opened the verification flow — do not duplicate it.
      msg = 'You need to finish verifying your identity before you can add '
          'people to a call.';
    } else if (err == 'too_many_participants' || code == 'adhoc_room_full') {
      kind = AdhocRoomError.full;
      final m = j?['max_members'];
      maxMembers = m is num ? m.toInt() : null;
      msg = 'A call can have at most ${maxMembers ?? 10} people.';
    } else if (err == 'invalid_invitees' && code == 'blocked') {
      kind = AdhocRoomError.blocked;
      msg = invalid.length == 1
          ? "You can't add someone who is blocked."
          : "You can't add people who are blocked.";
    } else if (err == 'invalid_invitees') {
      kind = AdhocRoomError.unknownUid;
      msg = invalid.length == 1
          ? "One of those contacts isn't on AvaTOK any more, so they can't join "
              'the call.'
          : "Some of those contacts aren't on AvaTOK any more, so they can't "
              'join the call.';
    } else if (status == 404 || err == 'not found') {
      kind = AdhocRoomError.notFound;
      msg = 'That call room no longer exists.';
    } else if (err == 'not_an_adhoc_room') {
      kind = AdhocRoomError.notAnAdhocRoom;
      msg = "We couldn't add anyone to this call. Please try again.";
    } else if (err == 'not a member') {
      kind = AdhocRoomError.notAMember;
      msg = "You're not in that call any more.";
    } else {
      kind = AdhocRoomError.unknown;
      msg = "We couldn't set up the group call. Please try again.";
    }

    return AdhocRoomResult._(
      ok: false,
      error: kind,
      message: msg,
      raw: err.isEmpty ? 'http_$status' : err,
      status: status,
      maxMembers: maxMembers,
      invalid: invalid,
    );
  }
}
