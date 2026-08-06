/// [ADDCALL-2-UI 2026-08-06] The escape hatch for the one-call-at-a-time rule,
/// scoped to exactly one in-flight make-before-break escalation.
///
/// Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §4.3 gap #3 — *"the client's
/// one-call-at-a-time guards will block the overlap… this is the most
/// easily-missed blocker in the whole feature."*
///
/// ## WHY THIS IS NOT A BOOLEAN
///
/// The obvious implementation is `static bool escalating = true/false` around
/// the migration. Three things go wrong with that, all of them silently:
///
///  1. **It latches.** Any early return, thrown exception or killed isolate
///     between set and clear leaves the device permanently willing to be in two
///     calls at once — which is a WORSE bug than the one being fixed, because
///     from then on a second incoming call is answered instead of auto-busied
///     and one microphone feeds two conversations.
///  2. **It says nothing.** A guard site that reads `if (escalating) allow` has
///     no way to check that the second call it is being asked to permit is
///     *the escalation's own* conference rather than an unrelated group call
///     the user tapped into at the wrong moment.
///  3. **It reads as dead code.** A bare bool with two writers and one reader is
///     exactly the shape someone deletes in a cleanup pass six months later.
///
/// So this is a **lease**: it identifies the escalation, it identifies the two
/// calls that are allowed to coexist, it is released explicitly on success AND
/// on every failure, and — the part that matters — **it expires on wall-clock
/// time whether or not anybody releases it**. [maxOverlapMs] is checked lazily
/// on every single read, so a leaked lease closes itself on the next question
/// anyone asks. There is no code path, including a crash between acquire and
/// release, that can leave this open.
///
/// ## AUDITABLE
///
/// Acquire, release and expiry all emit telemetry carrying the shared
/// `escalation_id`, so an overlap that ran long, or a lease that had to be
/// expired rather than released, is visible in PostHog next to the rest of the
/// escalation funnel instead of being invisible client-side state.
library;

import '../analytics.dart';

/// One granted permission to be in two calls at once. Immutable; the guard
/// holds at most one at a time.
class CallEscalationLease {
  const CallEscalationLease({
    required this.escalationId,
    required this.callId,
    required this.gid,
    required this.startedAtMs,
  });

  /// `addcall:<call_id>` — the funnel key shared with the Worker (spec §10).
  final String escalationId;

  /// The 1:1 room being escalated. This is the call that is allowed to still be
  /// up while the conference comes alive.
  final String callId;

  /// The ad-hoc conversation id of the conference. This is the ONLY second call
  /// the lease permits; any other gid is still refused.
  final String gid;

  final int startedAtMs;

  int get ageMs => DateTime.now().millisecondsSinceEpoch - startedAtMs;
}

class CallEscalationGuard {
  CallEscalationGuard._();

  /// Hard ceiling on the overlap, enforced without any cooperation from the
  /// code that took the lease.
  ///
  /// Generous on purpose — it is a **safety net, not a deadline**. The
  /// coordinator's own budgets (conference build, peer ack) are far shorter and
  /// are what actually decide whether an escalation succeeds; if one of those
  /// fires, the lease is released immediately in a `finally`. This value only
  /// matters in the case where the releasing code never ran at all.
  static const int maxOverlapMs = 45000;

  static CallEscalationLease? _lease;

  /// The live lease, or null. **Every** read goes through here, which is what
  /// makes the expiry unavoidable.
  static CallEscalationLease? get lease {
    final l = _lease;
    if (l == null) return null;
    if (l.ageMs > maxOverlapMs) {
      _lease = null;
      Analytics.capture('addcall_guard_expired', {
        'escalation_id': l.escalationId,
        'call_id': l.callId,
        'age_ms': l.ageMs,
        'max_overlap_ms': maxOverlapMs,
      });
      return null;
    }
    return l;
  }

  /// True while a make-before-break escalation is deliberately holding two
  /// calls open on this device.
  static bool get overlapping => lease != null;

  /// Is [gid] the conference this escalation is moving to? A guard site that
  /// wants to permit the overlap must ask THIS, not [overlapping] — otherwise
  /// it also permits an unrelated group call the user tapped during the window.
  static bool allowsConference(String? gid) {
    if (gid == null || gid.isEmpty) return false;
    return lease?.gid == gid;
  }

  /// Is [callId] the 1:1 leg this escalation is moving off?
  static bool allowsSourceCall(String callId) =>
      callId.isNotEmpty && lease?.callId == callId;

  /// Take the lease. Returns null when one is already live — which is the
  /// device-local single flight: a second Add press, or both parties pressing
  /// Add on the same phone-shared account, cannot start two migrations.
  ///
  /// (The cross-DEVICE single flight is the server's: `ConferenceRoomDO./start`
  /// refuses a second ad-hoc room for the same 1:1 with 409 `group_mismatch`,
  /// and `/migration/reserve` refuses a second commit with 409 `single_flight`.
  /// This one only stops a device racing itself.)
  static CallEscalationLease? acquire({
    required String escalationId,
    required String callId,
    required String gid,
  }) {
    final existing = lease; // triggers lazy expiry
    if (existing != null) {
      Analytics.capture('addcall_guard_refused', {
        'escalation_id': escalationId,
        'call_id': callId,
        'held_by': existing.escalationId,
        'held_ms': existing.ageMs,
      });
      return null;
    }
    final l = CallEscalationLease(
      escalationId: escalationId,
      callId: callId,
      gid: gid,
      startedAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    _lease = l;
    Analytics.capture('addcall_guard_acquired', {
      'escalation_id': escalationId,
      'call_id': callId,
      'gid_hash': gid.hashCode.toString(),
    });
    return l;
  }

  /// Give the lease back. Safe to call twice, and safe to call with a lease that
  /// has already expired — both are no-ops. [outcome] is free text for the
  /// funnel (`committed`, `rolled_back`, `peer_timeout`, …).
  ///
  /// Deliberately identity-checked: a late release from an abandoned escalation
  /// must never revoke a NEWER one's permission.
  static void release(CallEscalationLease? l, {required String outcome}) {
    if (l == null) return;
    if (!identical(_lease, l)) return;
    _lease = null;
    Analytics.capture('addcall_guard_released', {
      'escalation_id': l.escalationId,
      'call_id': l.callId,
      'outcome': outcome,
      'overlap_ms': l.ageMs,
    });
  }

  /// Account switch / logout hard reset. Mirrors `clearCallState()`.
  static void reset() {
    final l = _lease;
    _lease = null;
    if (l != null) {
      Analytics.capture('addcall_guard_released', {
        'escalation_id': l.escalationId,
        'call_id': l.callId,
        'outcome': 'state_cleared',
        'overlap_ms': l.ageMs,
      });
    }
  }
}
