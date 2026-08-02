// call_state.ts — [CALL-FSM-1 2026-08-01]
//
// THE CALL AGGREGATE AND THE ONLY PLACE A CALL OUTCOME IS DECIDED.
// Spec: Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md.
//
// WHY THIS FILE EXISTS
// --------------------
// Every recurrence of the call-UI bug class came from the same thing: a call's
// outcome was DECIDED independently in many places. A button handler decided
// "declined means Ava takes over". A different socket branch decided "declined
// means end the call". FCM decided something else again. Whichever ran first
// won, so the same user action produced different outcomes depending on network
// timing. Four separate production bugs were all instances of that.
//
// This module is deliberately PURE — no I/O, no env, no fetch, no storage. It
// takes a state and a command and returns the next state plus the events that
// follow. That means:
//   * every legal transition is written down in ONE readable place
//   * the invariants are enforced structurally rather than by convention
//   * it is trivially unit-testable without a Durable Object or a network
//
// The Durable Object owns persistence and delivery. It does NOT own the rules.
// If you are adding a call outcome, add it HERE and nowhere else.
//
// THE CENTRAL INSIGHT the old code missed: a call has FOUR independent state
// machines, not one. "The callee stopped ringing" and "the caller's call is
// over" are DIFFERENT facts. Receptionist and voicemail are exactly the cases
// where they diverge — the callee is done, the caller is very much still on the
// line. Modelling this as a single `status` string is what made those two cases
// impossible to express, which is why they kept getting bolted on as special
// cases that then fought each other.

// ── The four legs ──────────────────────────────────────────────────────────

export type SessionState =
  | "creating" | "ringing" | "connected" | "handoff" | "completed";

export type CallerLegState =
  | "pending" | "ringing" | "connected_to_callee" | "connected_to_receptionist"
  | "voicemail_ready" | "voicemail_recording" | "ended";

export type CalleeLegState =
  | "not_started" | "ringing" | "accepted" | "declined"
  | "dismissed_for_message" | "dismissed_for_receptionist"
  | "dismissed_for_voicemail" | "dismissed_for_spam" | "dismissed_for_block"
  | "timed_out" | "ended";

export type ServiceLegState =
  | "none" | "starting_receptionist" | "receptionist_active"
  | "voicemail_ready" | "voicemail_recording" | "completed" | "failed";

/** The FINAL answer to "what happened to this call". Distinct from the current
 *  state: state is where we are, disposition is how it ended. */
export type Disposition =
  | "none"
  | "answered_by_callee" | "declined" | "quick_reply_sent"
  | "answered_by_receptionist" | "receptionist_failed"
  | "voicemail_left" | "voicemail_abandoned" | "voicemail_failed"
  | "reported_spam" | "blocked_by_callee"
  | "caller_cancelled" | "ring_timeout" | "recipient_unavailable";

export type CallSession = {
  call_id: string;
  /** [CALL-AUTHZ-1 2026-08-01] THE PARTICIPANTS, stamped once at admission from
   *  the AUTHENTICATED caller uid and the dialled callee uid.
   *
   *  These exist so `actor` can be DERIVED from the authenticated identity plus
   *  the call record, never taken from the request body. The earlier design
   *  accepted a client-sent `role` hint, and the authorization table only
   *  checked that the claimed role was allowed to issue the command — it never
   *  checked that the authenticated user actually occupied that side of the
   *  call. Any authenticated user who learned a call id could send
   *  `role: "callee"` and decline, block, report or accept a stranger's call.
   *  Membership is now a fact of the record, not a claim of the request. */
  caller_uid: string | null;
  callee_uid: string | null;
  /** Bumped on any structural restart of the call. A command carrying a stale
   *  expected_epoch is rejected — this is the multi-device CAS guard. */
  epoch: number;
  /** Strictly increasing. Stamped on every emitted transition so clients can
   *  order and dedupe. Persisted with the rest of the aggregate, so a DO
   *  eviction mid-call cannot restart it at 1 and make a NEWER transition look
   *  stale to a client that already applied a higher number. */
  transition_sequence: number;

  session_state: SessionState;
  caller_leg_state: CallerLegState;
  callee_leg_state: CalleeLegState;
  service_leg_state: ServiceLegState;
  disposition: Disposition;

  created_at: number;
  updated_at: number;
};

export function newCallSession(callId: string, now: number): CallSession {
  return {
    call_id: callId,
    caller_uid: null,
    callee_uid: null,
    epoch: 1,
    transition_sequence: 0,
    session_state: "creating",
    caller_leg_state: "pending",
    callee_leg_state: "not_started",
    service_leg_state: "none",
    disposition: "none",
    created_at: now,
    updated_at: now,
  };
}

// ── Commands ───────────────────────────────────────────────────────────────

export type CommandName =
  | "admit_call" | "callee_ringing"
  | "accept_call" | "decline_call" | "send_quick_reply"
  | "handoff_to_receptionist" | "offer_voicemail"
  | "report_spam" | "block_caller"
  | "cancel_call" | "ring_timeout"
  | "receptionist_connected" | "receptionist_failed"
  | "voicemail_recording_started" | "voicemail_stored" | "voicemail_abandoned"
  | "end_call";

export type Command = {
  name: CommandName;
  /** Who issued it. Authorization is enforced by the CALLER of this module —
   *  see `authorizeCommand` below for the rule table. */
  actor: "caller" | "callee" | "server";
  /** Idempotency key, minted per USER ACTION (not per HTTP attempt). */
  command_id?: string;
  /** Multi-device CAS. When present and not equal to the current epoch the
   *  command is rejected as stale and the caller is handed current state. */
  expected_epoch?: number;
  /** Command-specific payload (e.g. quick_reply_id). Opaque here. */
  data?: Record<string, unknown>;
};

/** Emitted alongside a state change. Consumers PERFORM these; they never
 *  reinterpret state. Split deliberately: a state-transition event changes the
 *  aggregate, a side-effect intent asks someone to do work. If the work fails
 *  you retry the intent WITHOUT replaying the transition. */
export type CallEvent =
  // state-transition events
  | "call_admitted" | "callee_ringing_started" | "callee_accepted"
  | "callee_declined" | "callee_dismissed_for_message"
  | "callee_dismissed_for_receptionist" | "callee_dismissed_for_voicemail"
  | "callee_dismissed_for_spam" | "callee_dismissed_for_block"
  | "receptionist_started" | "receptionist_connected" | "receptionist_failed"
  | "voicemail_offered" | "voicemail_recording_started" | "voicemail_message_created"
  | "voicemail_abandoned"
  | "caller_cancelled" | "ring_timed_out" | "call_completed"
  // side-effect intents
  | "ring_surface_cancel_requested" | "quick_reply_delivery_requested"
  | "receptionist_start_requested" | "voicemail_offer_requested"
  | "spam_report_requested" | "block_requested" | "push_backstop_requested";

export type ApplyResult =
  | { ok: true; state: CallSession; events: CallEvent[]; changed: boolean }
  | { ok: false; error: "stale_epoch" | "illegal_transition" | "already_terminal"; state: CallSession };

/** A callee leg that will never ring again. */
const CALLEE_TERMINAL: ReadonlySet<CalleeLegState> = new Set<CalleeLegState>([
  "accepted", "declined", "dismissed_for_message", "dismissed_for_receptionist",
  "dismissed_for_voicemail", "dismissed_for_spam", "dismissed_for_block",
  "timed_out", "ended",
]);

/** Is the whole call finished? Terminal sessions are IMMUTABLE — the first
 *  outcome to land wins and nothing may overwrite it. This is what stops a late
 *  `accept` from reviving a call the callee already declined. */
function isSessionTerminal(s: CallSession): boolean {
  return s.session_state === "completed";
}

/**
 * [CALL-AUTHZ-1 2026-08-01] Derive which side of the call an AUTHENTICATED user
 * occupies, from the persisted record. Returns null when the user is not a
 * participant at all — which must be treated as a hard rejection.
 *
 * This is the security boundary. `role` from the request body is not consulted
 * anywhere; membership is a property of the call, not a claim of the caller.
 *
 * Before the participants are stamped (a call created by an older client that
 * never went through admission) both uids are null. In that case we return null
 * — UNKNOWN, not "allowed". Fail-closed here is correct and cheap: the legacy
 * status path still works for those calls, so the only thing refused is the NEW
 * command endpoint on a call whose membership we cannot prove.
 */
export function deriveActor(s: CallSession, authenticatedUid: string): Command["actor"] | null {
  if (!authenticatedUid) return null;
  if (s.caller_uid && authenticatedUid === s.caller_uid) return "caller";
  if (s.callee_uid && authenticatedUid === s.callee_uid) return "callee";
  return null;
}

/**
 * Authorization table. The server MUST enforce this — an FCM action replay or a
 * hostile client must not be able to accept a call on someone else's behalf.
 *
 * NOTE this is the SECOND of two gates and is useless alone: it answers "may a
 * callee decline?", not "is this person the callee?". [deriveActor] answers the
 * latter and must run first. The original design had only this gate, which is
 * why a client-supplied role was enough to act on a stranger's call.
 *
 * Returns true when `actor` is permitted to issue `name`.
 */
export function authorizeCommand(name: CommandName, actor: Command["actor"]): boolean {
  switch (name) {
    // Only the person being called may dispose of the ring.
    case "accept_call":
    case "decline_call":
    case "send_quick_reply":
    case "offer_voicemail":
    case "report_spam":
    case "block_caller":
      return actor === "callee";
    // The authenticated callee may explicitly send the call to Ava. The Worker
    // may also commit an automatic no-answer/unreachable handoff atomically.
    case "handoff_to_receptionist":
      return actor === "callee" || actor === "server";
    // Only the caller may abandon their own call or record a voicemail.
    case "cancel_call":
    case "voicemail_recording_started":
    case "voicemail_stored":
    case "voicemail_abandoned":
      return actor === "caller";
    // Server-driven lifecycle.
    case "admit_call":
    case "callee_ringing":
    case "ring_timeout":
    case "receptionist_connected":
    case "receptionist_failed":
      return actor === "server";
    // Either party may hang up an established call.
    case "end_call":
      return actor === "caller" || actor === "callee" || actor === "server";
  }
}

/**
 * THE transition function. Pure.
 *
 * Given the current aggregate and a command, produce the next aggregate and the
 * events that follow. Rejects stale-epoch commands and illegal transitions
 * rather than silently coercing them — a rejected command gets handed the
 * CURRENT state so the client can reconcile instead of inventing an outcome.
 */
export function applyCommand(prev: CallSession, cmd: Command, now: number): ApplyResult {
  // Multi-device CAS. Phone A accepts; tablet B declines 80ms later carrying the
  // old epoch → B is rejected and renders "answered on another device".
  if (cmd.expected_epoch != null && cmd.expected_epoch !== prev.epoch) {
    return { ok: false, error: "stale_epoch", state: prev };
  }

  // Terminal sessions are immutable. Note this is checked BEFORE the switch so
  // no individual case can forget it — the invariant is structural, not a
  // convention each branch has to remember.
  if (isSessionTerminal(prev)) {
    // A repeat of the SAME outcome is a harmless no-op, not an error: retries
    // and replays are expected and must not surface as failures.
    return { ok: false, error: "already_terminal", state: prev };
  }

  const s: CallSession = { ...prev };
  const events: CallEvent[] = [];
  /** Anything that ends the callee's ring must cancel the ring surface. Emitted
   *  centrally so no outcome can forget it — the stale-notification bug was
   *  exactly this being remembered per-button. */
  const endCalleeRing = (next: CalleeLegState) => {
    s.callee_leg_state = next;
    events.push("ring_surface_cancel_requested");
  };
  const complete = (d: Disposition) => {
    s.caller_leg_state = "ended";
    s.session_state = "completed";
    s.disposition = d;
    events.push("call_completed");
  };

  switch (cmd.name) {
    case "admit_call":
      s.session_state = "ringing";
      s.caller_leg_state = "ringing";
      s.callee_leg_state = "not_started";
      events.push("call_admitted");
      break;

    case "callee_ringing":
      if (s.callee_leg_state !== "not_started") break; // idempotent
      s.callee_leg_state = "ringing";
      events.push("callee_ringing_started");
      break;

    case "accept_call":
      if (CALLEE_TERMINAL.has(s.callee_leg_state)) {
        return { ok: false, error: "illegal_transition", state: prev };
      }
      s.callee_leg_state = "accepted";
      s.caller_leg_state = "connected_to_callee";
      s.session_state = "connected";
      s.disposition = "answered_by_callee";
      events.push("callee_accepted", "ring_surface_cancel_requested");
      break;

    // OWNER RULING A: Decline ends the call. It NEVER starts the receptionist.
    // The invariant `declined may never transition to receptionist_active` is
    // guaranteed here by completing the session, which makes every later
    // command hit the `already_terminal` guard above.
    case "decline_call":
      endCalleeRing("declined");
      complete("declined");
      events.push("callee_declined");
      break;

    case "send_quick_reply":
      endCalleeRing("dismissed_for_message");
      complete("quick_reply_sent");
      events.push("callee_dismissed_for_message", "quick_reply_delivery_requested");
      break;

    case "report_spam":
      endCalleeRing("dismissed_for_spam");
      complete("reported_spam");
      events.push("callee_dismissed_for_spam", "spam_report_requested");
      break;

    case "block_caller":
      endCalleeRing("dismissed_for_block");
      complete("blocked_by_callee");
      events.push("callee_dismissed_for_block", "block_requested");
      break;

    // HANDOFFS. The callee's ring ends but the CALLER's leg stays alive — this
    // is the distinction a single `status` field could not express, and the
    // reason receptionist/voicemail kept breaking when bolted onto it.
    case "handoff_to_receptionist":
      endCalleeRing("dismissed_for_receptionist");
      s.caller_leg_state = "connected_to_receptionist";
      s.service_leg_state = "starting_receptionist";
      s.session_state = "handoff";
      events.push("callee_dismissed_for_receptionist", "receptionist_start_requested",
        "receptionist_started");
      break;

    case "offer_voicemail":
      endCalleeRing("dismissed_for_voicemail");
      s.caller_leg_state = "voicemail_ready";
      s.service_leg_state = "voicemail_ready";
      s.session_state = "handoff";
      events.push("callee_dismissed_for_voicemail", "voicemail_offer_requested",
        "voicemail_offered");
      break;

    case "receptionist_connected":
      if (s.service_leg_state !== "starting_receptionist") break;
      s.service_leg_state = "receptionist_active";
      events.push("receptionist_connected");
      break;

    case "receptionist_failed":
      s.service_leg_state = "failed";
      complete("receptionist_failed");
      events.push("receptionist_failed");
      break;

    case "voicemail_recording_started":
      if (s.service_leg_state !== "voicemail_ready") break;
      s.service_leg_state = "voicemail_recording";
      s.caller_leg_state = "voicemail_recording";
      events.push("voicemail_recording_started");
      break;

    case "voicemail_stored":
      s.service_leg_state = "completed";
      complete("voicemail_left");
      events.push("voicemail_message_created");
      break;

    // The caller closed the app before recording. Never leave a session parked
    // in `handoff` forever.
    case "voicemail_abandoned":
      s.service_leg_state = "completed";
      complete("voicemail_abandoned");
      events.push("voicemail_abandoned");
      break;

    case "cancel_call":
      if (s.callee_leg_state === "ringing" || s.callee_leg_state === "not_started") {
        endCalleeRing("ended");
      }
      complete("caller_cancelled");
      events.push("caller_cancelled");
      break;

    case "ring_timeout":
      if (CALLEE_TERMINAL.has(s.callee_leg_state)) {
        return { ok: false, error: "illegal_transition", state: prev };
      }
      endCalleeRing("timed_out");
      complete("ring_timeout");
      events.push("ring_timed_out");
      break;

    // [CALL-AUTHZ-1 2026-08-01] The disposition here used to default to
    // `answered_by_callee` whenever none had been set yet. That is only true
    // for a call that actually CONNECTED. A hang-up DURING RINGING — which is
    // exactly what the socket `bye`/`cancel` path produces — has no disposition
    // yet, so it was being recorded as an answered call. Call history, billing
    // analytics and the missed-call surface would all have disagreed with what
    // the user experienced.
    //
    // Now the disposition follows the evidence: if the call was never connected
    // it ended without being answered, and which side hung up decides whether
    // that reads as a cancel or a timeout.
    case "end_call": {
      const wasConnected =
        prev.session_state === "connected" || prev.caller_leg_state === "connected_to_callee";
      if (!CALLEE_TERMINAL.has(s.callee_leg_state)) endCalleeRing("ended");
      if (s.disposition !== "none") {
        complete(s.disposition);
      } else if (wasConnected) {
        complete("answered_by_callee");
      } else {
        // Never connected. `caller` hanging up mid-ring is a cancel; anything
        // else ending an unanswered ring is a timeout.
        complete(cmd.actor === "caller" ? "caller_cancelled" : "ring_timeout");
      }
      break;
    }
  }

  const changed =
    s.session_state !== prev.session_state ||
    s.caller_leg_state !== prev.caller_leg_state ||
    s.callee_leg_state !== prev.callee_leg_state ||
    s.service_leg_state !== prev.service_leg_state ||
    s.disposition !== prev.disposition;

  if (changed) {
    s.transition_sequence = prev.transition_sequence + 1;
    s.updated_at = now;
  }
  return { ok: true, state: s, events, changed };
}

/**
 * [CALL-WIRE-COMPAT-1 2026-08-01] The INVERSE of commandForLegacyStatus: the
 * aggregate → the status string a SHIPPED client understands.
 *
 * This is a CONTRACT, not an implementation detail. Every client in the field
 * switches on these exact words, and they cannot be renamed to match whatever
 * the state machine happens to call things internally. Getting this wrong is
 * not a cosmetic mismatch — the client silently falls through to `default`,
 * ignores the frame, and behaves as though the call never ended.
 *
 * That is exactly what happened in prod (call avatok-b7741a74): the broadcast
 * said `declined`, every client listens for `decline`, so a declined call kept
 * ringing until the caller's own ring-timeout handed them to the receptionist.
 *
 * RULE: if you add a state or a disposition, map it HERE to an existing legacy
 * word. Never invent a new wire value for old clients to not understand.
 */
export function legacyWireStatus(s: CallSession): string {
  // Handoffs first: the callee's ring is over but the caller's leg lives on,
  // and these have their own long-standing wire words.
  if (s.callee_leg_state === "dismissed_for_receptionist") return "decline_ava";
  if (s.callee_leg_state === "dismissed_for_voicemail") return "decline_vm";

  switch (s.disposition) {
    case "declined":
    // Quick reply / spam / block all present to the CALLER as a plain decline:
    // the call is over and the reason is the callee's business, not theirs.
    case "quick_reply_sent":
    case "reported_spam":
    case "blocked_by_callee":
      return "decline";
    case "answered_by_callee":     return "accept";
    case "caller_cancelled":       return "cancel";
    case "ring_timeout":           return "no-answer";
    case "answered_by_receptionist": return "decline_ava";
    case "voicemail_left":
    case "voicemail_abandoned":
    case "voicemail_failed":       return "decline_vm";
    case "receptionist_failed":    return "ended";
    case "recipient_unavailable":  return "no-answer";
    default: break;
  }
  // Not yet terminal — report the ring's own state in legacy words.
  switch (s.callee_leg_state) {
    case "accepted":               return "accept";
    case "declined":               return "decline";
    case "timed_out":              return "no-answer";
    case "ended":                  return "ended";
    case "ringing":                return "ringing";
    default:                       return "ringing";
  }
}

/**
 * Legacy `/api/call-status` strings → commands.
 *
 * The old status-string API is still what shipped clients speak, and will be for
 * as long as an old build exists in the wild. Rather than keep two parallel
 * decision paths — which is the exact failure this whole effort is unwinding —
 * the legacy path is TRANSLATED into a command and run through the same
 * machine. There is one set of rules, reached two ways.
 *
 * Returns null for a status with no aggregate meaning (e.g. `busy`, which is
 * handled entirely by the caller-side busy card and never mutates call state).
 */
export function commandForLegacyStatus(status: string): { name: CommandName; actor: Command["actor"] } | null {
  switch (status) {
    case "decline":
    case "declined":      return { name: "decline_call", actor: "callee" };
    case "decline_ava":   return { name: "handoff_to_receptionist", actor: "callee" };
    case "decline_vm":    return { name: "offer_voicemail", actor: "callee" };
    case "cancel":        return { name: "cancel_call", actor: "caller" };
    case "missed":
    case "no-answer":     return { name: "ring_timeout", actor: "server" };
    case "bye":
    case "hangup":
    case "ended":         return { name: "end_call", actor: "server" };
    // `decline_agent` is the business AI-agent lane, which owns its own
    // handoff flow end-to-end and does not (yet) model a service leg here.
    // `busy` never mutates the aggregate.
    default:              return null;
  }
}
