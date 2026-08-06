// [ADDCALL-3-UI 2026-08-06] The two-step "add these people and ring them", plus
// the honest per-person report of what happened.
//
// Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §5. Server:
// `worker/src/routes/adhoc_room.ts` (`/add`) and `worker/src/routes/groupcall.ts`
// (`/invite`).
//
// ── WHY THIS IS A SHARED FILE AND NOT A METHOD ON EITHER SCREEN ───────────────
// There are two entry points into exactly the same operation:
//
//   · `call_screen.dart` — the escalation. Membership already exists (the room
//     was minted by `/adhoc-room/create` with every invitee in it), so it needs
//     the RING ONLY: `addMembership: false`.
//   · `cloudflare_conference_screen.dart` — adding someone once the call is
//     already a conference. Nobody has written a membership row for them, so it
//     needs BOTH steps: `addMembership: true`.
//
// That single boolean is the entire difference, and it is the thing most likely
// to be got wrong twice if the logic is copied. Everything else — the ordering,
// the error mapping, the telemetry and the sentences the user reads — is
// identical and lives here once.
//
// ── ADD BEFORE RING, ALWAYS ──────────────────────────────────────────────────
// `/invite` deliberately does not insert membership; a uid with no
// `conversation_members` row comes back as `not_a_member` and is not rung. Both
// calls are idempotent, so losing either response is safe to retry.
//
// ── WHAT WE MAY HONESTLY SAY ─────────────────────────────────────────────────
// **Declining a group ring is not implemented** (spec §5, accepted for v1): no
// receipt token, no per-callee record, no server ring deadline. An unanswered
// ring just times out at 45s into a `missed` call-log entry. So "Ringing Ana…"
// is the strongest claim available — never "Ana joined", "Ana declined" or
// "no answer", because we genuinely cannot tell those apart from a ring that is
// still going. `groupcall_invite_declined` is catalogued with no emit site on
// either side, and that is deliberate.
import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/calls/adhoc_room_api.dart';
import '../../core/calls/call_telemetry_events.dart';
import 'cloudflare_conference_api.dart';

/// The result of one add-and-ring.
///
/// [blockingMessage] is set when the operation failed as a WHOLE — nobody was
/// rung — and is already a finished sentence. [invite] is set when the ring
/// request itself succeeded, in which case individual people may still have
/// failed and [GroupCallInviteResult.lines] is what to show.
class AddToCallRingOutcome {
  const AddToCallRingOutcome({this.blockingMessage, this.invite});

  final String? blockingMessage;
  final GroupCallInviteResult? invite;

  bool get ok => blockingMessage == null && (invite?.ok ?? false);
}

class AddToCallRing {
  AddToCallRing._();

  /// Add [uids] to [gid] if needed, then ring them into the live call.
  ///
  /// [escalationId] is the shared funnel key (`addcall:<id>`).
  ///
  /// [serverEscalationId]: the Worker stamps `addcall:<group_id>` on its own
  /// half of this funnel (`escalationIdFor(groupId)` in `groupcall.ts`). When
  /// the client's [escalationId] is keyed on something else — the escalation
  /// path keys on the 1:1 call id — pass the server's form here so a PostHog
  /// query on either key finds both halves. Without it the funnel splits in two.
  ///
  /// Never throws. Display names are NOT needed here; they belong to [report].
  static Future<AddToCallRingOutcome> run({
    required String gid,
    required List<String> uids,
    required String escalationId,
    required bool addMembership,
    String callId = '',
    String? serverEscalationId,
  }) async {
    if (uids.isEmpty) {
      return const AddToCallRingOutcome(
          blockingMessage: 'Select who to add to the call.');
    }
    final tags = <String, Object>{
      'escalation_id': escalationId,
      'gid_hash': gid.hashCode.toString(),
      if (callId.isNotEmpty) 'call_id': callId,
      if (serverEscalationId != null) 'invite_escalation_id': serverEscalationId,
    };

    // ── Step 1: membership. Skipped on the escalation path, where `create`
    //    already wrote these rows.
    if (addMembership) {
      final add = await AdhocRoomApi.add(convId: gid, invitees: uids);
      // A REAL group's conference is not an ad-hoc room, and `/adhoc-room/add`
      // says so (`not_an_adhoc_room`). That is not a failure of this operation:
      // a group's membership is managed in the group, not by a call, so the
      // people already in it can still be rung and the rest come back per-person
      // as `not_a_member`. Blocking on it would make the Add control dead on
      // every group call, with copy ("please try again") that would never come
      // true no matter how many times they tried.
      if (!add.ok && add.error == AdhocRoomError.notAnAdhocRoom) {
        AvaLog.I.log('addcall', 'invite into a real group — skipping add step');
      } else if (!add.ok) {
        Analytics.capture(CallEvents.groupcallEscalateFailed, {
          ...tags,
          'stage': 'add_members',
          'reason': add.raw,
          'error': add.error?.name ?? 'unknown',
          'http': add.status,
          'invitee_count': uids.length,
        });
        // The identity gate is the one silent case — see `AdhocRoomError`.
        return AddToCallRingOutcome(
          blockingMessage:
              add.error == AdhocRoomError.identityRequired ? null : add.message,
        );
      }
      if (add.ok) {
        Analytics.capture(CallEvents.groupcallInviteCreated, {
          ...tags,
          'member_count': add.members.length,
          'invitee_count': uids.length,
          'participants': add.members,
          'source': 'conference',
        });
      }
    }

    // ── Step 2: the ring.
    final res = await GroupCallInviteApi.invite(gid, uids);

    if (!res.ok) {
      AvaLog.I.log('addcall', 'invite failed: ${res.raw}');
      if (res.error == GroupCallInviteError.callFull) {
        Analytics.capture(CallEvents.groupcallFullRejected, {
          ...tags,
          'stage': 'invite',
          'requested': uids.length,
          if (res.cap != null) 'cap': res.cap!,
          if (res.count != null) 'count': res.count!,
        });
      } else {
        Analytics.capture(CallEvents.groupcallEscalateFailed, {
          ...tags,
          'stage': 'invite',
          'reason': res.raw,
          'error': res.error?.name ?? 'unknown',
          'http': res.status,
          'requested': uids.length,
        });
      }
      return AddToCallRingOutcome(blockingMessage: res.message, invite: res);
    }

    // One event per invite, tagging EVERY participant so any of their emails
    // retrieves it (CLAUDE.md) — the same shape the Worker emits, so "he added
    // me and my phone never rang" can be joined from either end.
    Analytics.capture(CallEvents.groupcallInviteSent, {
      ...tags,
      'via': 'ring',
      'live_call_id': res.callId,
      if (res.generation != null) 'generation': res.generation!,
      'requested': uids.length,
      'rung_count': res.rung.length,
      'failed_count': res.failed.length,
      'rung_uids': res.rung,
      'failed_uids': res.failedTags,
      'participants': uids,
    });
    return AddToCallRingOutcome(invite: res);
  }

  /// Resolve a uid for display. Never returns a uid — a raw id on screen is the
  /// thing CLAUDE.md's honesty rule and every design review both reject.
  static String Function(String) nameResolver(Map<String, String> names) =>
      (uid) {
        final n = names[uid];
        return (n == null || n.trim().isEmpty) ? 'Someone' : n.trim();
      };

  /// Show what happened, per person.
  ///
  /// A ring is neither instant nor guaranteed, so this deliberately reports both
  /// halves: who is being rung, and who could not be reached and why. One
  /// blanket "invites sent" would be the lie the server's per-uid answer exists
  /// to prevent.
  ///
  /// Safe to call after the calling widget is gone — it takes the messenger
  /// rather than a `BuildContext`.
  static void report(
    ScaffoldMessengerState? messenger,
    AddToCallRingOutcome outcome,
    Map<String, String> names,
  ) {
    if (messenger == null) return;
    final blocking = outcome.blockingMessage;
    if (blocking != null && blocking.isNotEmpty) {
      messenger.showSnackBar(SnackBar(content: Text(blocking)));
      return;
    }
    final res = outcome.invite;
    if (res == null || !res.ok) return;
    final lines = res.lines(nameResolver(names));
    if (lines.isEmpty) return;
    messenger.showSnackBar(SnackBar(
      // Longer than the default 4s: with several people this is several
      // sentences, and the one that matters ("we couldn't reach Priya") is the
      // last one.
      duration: Duration(seconds: lines.length > 1 ? 7 : 4),
      content: Text(lines.join('\n')),
    ));
  }
}
