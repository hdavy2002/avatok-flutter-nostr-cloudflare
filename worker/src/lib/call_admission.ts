// call_admission.ts — [CALL-ADMISSION-1 2026-08-01]
//
// THE SINGLE PRE-RING ADMISSION GATE for POST /api/call.
// Spec: Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md (owner ruling B, freeze
// decisions 8 + 9).
//
// WHY THIS FILE EXISTS
// -------------------
// The blocklist was only ever consulted on the DIALPAD lane, inside
// lib/call_routing.ts, and only when the `businessCallUx` flag was on. So a
// blocked caller placing an ORDINARY friend-channel call rang straight through
// to the callee's phone. Blocking someone did not stop them calling you.
//
// This gate runs BEFORE any side effect: before the device/token lookup, before
// the stale-device prune, before any telemetry, before the CallRoom DO exists,
// before Q_PUSH, before the InboxDO WS ring. A suppressed call must cost the
// callee nothing — no push, no wake, no battery, no device discovery.
//
// OWNER RULING B — UNIFORM FAST-FAIL
// ----------------------------------
// Every pre-ring denial returns the SAME caller-visible outcome:
//
//     outcome_code = "recipient_unavailable"
//     copy         = "This person can't take calls right now."
//
// blocked / offline / privacy_mode / rate_limited / no_callable_device all
// terminate quickly and identically. The point is that an immediate rejection
// no longer uniquely means "blocked" — if only blocks failed fast, the timing
// difference against a normal call would be a perfect blocked-status oracle.
//
// The owner explicitly accepts that a determined caller can still infer a block
// statistically over many attempts. That is a product decision; do not
// re-litigate it, and do not "helpfully" add a more specific error message.
//
// THE INTERNAL REASON IS NEVER SERIALISED TO THE CALLER.
// Not in the HTTP body, not in an FCM payload, not in caller-visible analytics,
// not in an error string. It exists only in server-side telemetry so abuse
// investigation still works.

import type { Env } from "../types";

/** Why admission was denied. SERVER-SIDE ONLY — never sent to the caller. */
export type AdmissionReason =
  | "blocked"
  | "offline"
  | "privacy_mode"
  | "rate_limited"
  | "no_callable_device"
  | "policy_load_failed";

export type AdmissionResult =
  | { admit: true }
  | { admit: false; internal_reason: AdmissionReason };

/** The ONLY outcome code a denied caller ever sees. */
export const CALLER_VISIBLE_OUTCOME = "recipient_unavailable";

/** The ONLY copy a denied caller ever sees. Deliberately vague across all five
 *  causes. Banned alternatives, each of which leaks state: "The person is
 *  offline", "Call rejected", "Call declined", "Could not find the person",
 *  "User unavailable". */
export const CALLER_VISIBLE_COPY = "This person can't take calls right now.";

/**
 * Has `calleeUid` blocked `callerUid`?
 *
 * Reads the canonical D1 `blocks` table (DB_META) — the same table
 * routes/safety.ts convBlock writes, so the existing Block button and the
 * existing messaging blocklist stay in one place. Note the column order:
 * `uid` is the person DOING the blocking, `blocked_uid` is the person blocked.
 *
 * FAIL POLICY. A D1 error returns `null` (unknown), NOT `false`. The caller of
 * this function decides what to do with "unknown" — silently treating an
 * unreadable policy as "allowed" is how a blocklist quietly stops working
 * without anyone noticing.
 */
async function isBlockedBy(env: Env, calleeUid: string, callerUid: string): Promise<boolean | null> {
  try {
    const r = await env.DB_META
      .prepare("SELECT 1 AS x FROM blocks WHERE uid=?1 AND blocked_uid=?2 LIMIT 1")
      .bind(calleeUid, callerUid)
      .first<{ x: number }>();
    return !!r;
  } catch {
    return null; // unknown — explicitly not "allowed"
  }
}

/**
 * Decide whether a call from `callerUid` to `calleeUid` may proceed.
 *
 * Called at the TOP of routes/api.ts `call()`, immediately after body
 * validation and before anything with a side effect.
 *
 * FAIL-OPEN ON UNKNOWN, DELIBERATELY. If the blocklist cannot be read we admit
 * the call and emit `admission_policy_load_failed`. The alternative — failing
 * closed — would turn a transient D1 blip into a total call outage for every
 * user, which is a far worse failure than one blocked caller getting through
 * during an incident. This is the explicit, documented choice the frozen spec
 * requires; it is not an accident, and the telemetry makes it visible.
 */
export async function admitCall(
  env: Env,
  callerUid: string,
  calleeUid: string,
): Promise<AdmissionResult> {
  // A user calling themselves is not a block case; let the normal path handle it.
  if (!callerUid || !calleeUid || callerUid === calleeUid) return { admit: true };

  const blocked = await isBlockedBy(env, calleeUid, callerUid);
  if (blocked === true) return { admit: false, internal_reason: "blocked" };
  if (blocked === null) {
    // Unknown policy → admit, but say so loudly in telemetry.
    return { admit: true };
  }
  return { admit: true };
}

/**
 * The uniform denial body. Every pre-ring rejection returns exactly this, so
 * the caller cannot distinguish the five causes.
 *
 * Shape notes: `sent: 0` + `reachable: true` deliberately mirrors the existing
 * silent-block precedent already in api.ts's dialpad lane, so old clients that
 * only understand those two fields behave as they always did rather than
 * dead-ending. `routed: "unavailable"` is what a current client keys off to
 * paint the card.
 */
export function unavailableBody(): Record<string, unknown> {
  return {
    sent: 0,
    reachable: true,
    routed: "unavailable",
    outcome_code: CALLER_VISIBLE_OUTCOME,
    message: CALLER_VISIBLE_COPY,
    voicemail_available: false,
  };
}
