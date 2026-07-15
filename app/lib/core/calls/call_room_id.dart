import 'package:uuid/uuid.dart';

/// [CALL-ROOM-ID-1 2026-07-14] The ONE place a 1:1 AvaTalk call room id is
/// minted.
///
/// ## Why this file exists
///
/// The room id is not cosmetic. It is the Durable Object name —
/// `worker/src/routes/api.ts` does `env.CALL_ROOMS.idFromName(b.callId)` — and
/// it is the idempotency key the callee's push layer dedupes on. Two different
/// conventions had grown up side by side:
///
///   · `chat_thread.dart`      → 'avatok-<uuid8>'  (unique per call — CORRECT)
///   · `place_1to1_call.dart`  → 'avatok-<userId>' (stable per callee — BROKEN)
///     `calls_screen.dart`, `ava_phone_screen.dart`, `team_inbox.dart` likewise.
///
/// A stable-per-callee id means every call you ever place to a given person
/// reuses ONE CallRoom DO, and reuses ONE call id. That produced the 2026-07-14
/// prod incident (call_id `avatok-user_3AuqQjMD6gKbcm3aj2V1irhZ9wD`, callee
/// never rang), via two independent mechanisms:
///
///  1. **Callee-side permanent suppression.** `PushService._isCallIdProcessed`
///     persists handled call ids to disk with NO TTL. The first dialer call to
///     someone is handled and its id remembered forever; every subsequent call
///     reuses that exact id and is silently dropped as a duplicate.
///  2. **Server-side room reuse.** The same DO accumulates stale hibernated
///     WebSockets from previous calls. `call_room.ts` caps a room at 2 peers and
///     only adopts a duplicate socket when the `peerId` matches — but `_myId` is
///     a fresh uuid each session, so a zombie from an earlier call is never
///     adopted and instead occupies a cap slot.
///
/// ## The rule
///
/// A call id identifies a CALL, not a PERSON. It must be unique per attempt.
/// The callee's identity travels separately (the `to`/`seed`/`fromPub` fields) —
/// it never needed to be encoded in the room id at all.
///
/// Route every new call site through [newRoomId]. Do not hand-roll
/// `'avatok-$something'` again; `call_telemetry.dart` emits `call_id_shape` on
/// `call_started`/`call_ended` specifically so a regression here shows up as a
/// spike in `call_id_shape='uid'` instead of another week of silent dropped
/// calls.
abstract class CallRoomId {
  static const Uuid _uuid = Uuid();

  /// Prefix shared by every AvaTalk 1:1 room id.
  static const String prefix = 'avatok-';

  /// Mint a fresh, unique room id for ONE call attempt.
  ///
  /// 8 hex chars ≈ 4.3e9 values. Collisions only matter between two calls alive
  /// at the same instant, so this is ample — and it matches the existing
  /// `chat_thread.dart` convention exactly, so ids stay visually consistent in
  /// PostHog and in the DO namespace.
  static String newRoomId() => '$prefix${_uuid.v4().substring(0, 8)}';

  /// True when [id] follows the correct per-call convention.
  ///
  /// Used by [assertPerCall] and mirrored by `CallTelemetry._callIdShape`.
  static bool isPerCall(String id) {
    if (!id.startsWith(prefix)) return false;
    return RegExp(r'^[0-9a-f]{8}$').hasMatch(id.substring(prefix.length));
  }

  /// True when [id] is the BROKEN stable-per-callee convention
  /// (`avatok-user_…`) that caused the 2026-07-14 incident.
  static bool isPerCallee(String id) =>
      id.startsWith('${prefix}user_');
}
