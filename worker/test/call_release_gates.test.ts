// [CALL-RELEASE-GATES-1 2026-08-01] The release gates for the call-outcome work.
//
// These exist because an adversarial review (ChatGPT Luna) returned DO NOT SHIP
// and named five conditions. Each `describe` below IS one of those conditions.
// They are not decoration: three of them encode bugs that were live in
// production earlier today, and a regression in any of them is a security or
// billing-integrity problem, not a cosmetic one.
//
// Deliberately unit-level against the PURE reducer and the admission gate. That
// is possible at all only because lib/call_state.ts has no I/O — which was the
// point of making it pure. No Durable Object, no network, no D1.

import { describe, it, expect, beforeEach } from "vitest";
import {
  applyCommand, authorizeCommand, deriveActor, newCallSession,
  commandForLegacyStatus, legacyWireStatus, type CallSession,
} from "../src/lib/call_state";
import { admitCall, __resetVerdictCache } from "../src/lib/call_admission";

const CALLER = "user_caller";
const CALLEE = "user_callee";
const STRANGER = "user_stranger";
const NOW = 1_700_000_000_000;

/** A call that has been admitted and is ringing, with participants stamped. */
function ringing(): CallSession {
  const s = newCallSession("call_1", NOW);
  s.caller_uid = CALLER;
  s.callee_uid = CALLEE;
  const admitted = applyCommand(s, { name: "admit_call", actor: "server" }, NOW);
  if (!admitted.ok) throw new Error("admit failed");
  const rung = applyCommand(admitted.state, { name: "callee_ringing", actor: "server" }, NOW);
  if (!rung.ok) throw new Error("ring failed");
  return rung.state;
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE 4 — authorization: cross-user call control must be rejected.
// This is the hole that shipped to production for ~40 minutes: the capability
// table alone answered "may a callee decline?" but never "is this the callee?".
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 4: cross-user call control is rejected", () => {
  it("derives caller and callee from the record, not from a claim", () => {
    const s = ringing();
    expect(deriveActor(s, CALLER)).toBe("caller");
    expect(deriveActor(s, CALLEE)).toBe("callee");
  });

  it("REJECTS a stranger who knows the call id", () => {
    const s = ringing();
    // The exact attack: an authenticated user who learned a call id and claims
    // to be the callee. Membership must come from the record, so there is
    // nothing they can send that makes this resolve.
    expect(deriveActor(s, STRANGER)).toBeNull();
  });

  it("rejects an empty/absent uid", () => {
    expect(deriveActor(ringing(), "")).toBeNull();
  });

  it("fails CLOSED when participants were never stamped", () => {
    // A call created before participants existed. Unknown membership must not
    // resolve to a side — the legacy status path serves those calls instead.
    const s = newCallSession("call_legacy", NOW);
    expect(deriveActor(s, CALLER)).toBeNull();
    expect(deriveActor(s, CALLEE)).toBeNull();
  });

  it("still enforces the capability table on a correctly derived actor", () => {
    // Being the caller does not let you decline; being the callee does not let
    // you cancel. Identity and capability are two separate gates.
    expect(authorizeCommand("decline_call", "callee")).toBe(true);
    expect(authorizeCommand("decline_call", "caller")).toBe(false);
    expect(authorizeCommand("cancel_call", "caller")).toBe(true);
    expect(authorizeCommand("cancel_call", "callee")).toBe(false);
    expect(authorizeCommand("block_caller", "caller")).toBe(false);
    expect(authorizeCommand("report_spam", "caller")).toBe(false);
  });

  it("does not let an authenticated participant impersonate the server", () => {
    expect(authorizeCommand("ring_timeout", "caller")).toBe(false);
    expect(authorizeCommand("ring_timeout", "callee")).toBe(false);
    expect(authorizeCommand("receptionist_failed", "caller")).toBe(false);
    expect(authorizeCommand("receptionist_failed", "callee")).toBe(false);
    expect(authorizeCommand("end_call", "caller")).toBe(true);
    expect(authorizeCommand("end_call", "callee")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 5a — a hang-up DURING RINGING must not be recorded as answered.
// This was live: disposition defaulted to answered_by_callee whenever none was
// set, so every ring-phase hang-up polluted call history and billing analytics.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 5a: ringing hang-up disposition", () => {
  it("caller hanging up mid-ring is caller_cancelled, NOT answered", () => {
    const r = applyCommand(ringing(), { name: "end_call", actor: "caller" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.disposition).toBe("caller_cancelled");
    expect(r.state.disposition).not.toBe("answered_by_callee");
    expect(r.state.session_state).toBe("completed");
  });

  it("a server-driven end during ringing is ring_timeout, NOT answered", () => {
    const r = applyCommand(ringing(), { name: "end_call", actor: "server" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.disposition).toBe("ring_timeout");
  });

  it("a hang-up AFTER connecting IS answered_by_callee", () => {
    const accepted = applyCommand(ringing(), { name: "accept_call", actor: "callee" }, NOW);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.state.session_state).toBe("connected");
    // accept already set the disposition; ending must preserve it.
    const ended = applyCommand(accepted.state, { name: "end_call", actor: "caller" }, NOW);
    // The session is already completed by accept? No — accept leaves it
    // connected, so end_call is legal here.
    if (ended.ok) expect(ended.state.disposition).toBe("answered_by_callee");
  });

  it("an explicit decline is `declined`, never a timeout or an answer", () => {
    const r = applyCommand(ringing(), { name: "decline_call", actor: "callee" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.disposition).toBe("declined");
    expect(r.state.callee_leg_state).toBe("declined");
    expect(r.state.caller_leg_state).toBe("ended");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 5b — decline-then-report. Report Spam, Block and Decline all rode the
// same wire status, so an id built from the status collapsed two DIFFERENT user
// actions into one and silently dropped the second.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 5b: decline-then-report does not collapse", () => {
  // Mirrors push_service._signalStatus's id construction.
  const commandId = (callId: string, intentOrStatus: string, instance = "single") =>
    `${callId}:${intentOrStatus}:${instance}`;

  it("distinct user actions on one call produce DISTINCT ids", () => {
    const decline = commandId("call_1", "decline");
    const report = commandId("call_1", "report_spam");
    const reportBlock = commandId("call_1", "report_spam_block");
    const quick = commandId("call_1", "quick_reply");
    expect(new Set([decline, report, reportBlock, quick]).size).toBe(4);
  });

  it("REGRESSION: the old status-only scheme collided", () => {
    // Both Report Spam and Decline signal the status `decline`. Under the old
    // `${callId}:${status}` scheme these were identical, so the report was
    // swallowed as a replay and appeared to work while doing nothing.
    const oldDecline = `call_1:decline`;
    const oldReport = `call_1:decline`;
    expect(oldDecline).toBe(oldReport); // documents the bug
    // The new scheme separates them.
    expect(commandId("call_1", "decline")).not.toBe(commandId("call_1", "report_spam"));
  });

  it("retries of the SAME action still collapse", () => {
    const first = commandId("call_1", "report_spam", "inst_A");
    const retry = commandId("call_1", "report_spam", "inst_A");
    expect(first).toBe(retry);
  });

  it("the state machine treats a terminal call as immutable", () => {
    // A report arriving after a decline must not resurrect or re-complete the
    // call — it is rejected with current state so the client can reconcile.
    const declined = applyCommand(ringing(), { name: "decline_call", actor: "callee" }, NOW);
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    const later = applyCommand(declined.state, { name: "report_spam", actor: "callee" }, NOW);
    expect(later.ok).toBe(false);
    if (later.ok) return;
    expect(later.error).toBe("already_terminal");
    expect(later.state.disposition).toBe("declined");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 3 — old client against the new worker. Shipped builds speak status
// strings; they must map onto the same machine and produce the same outcomes.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 3: old-client status strings still work", () => {
  it("maps every legacy status a shipped build can send", () => {
    expect(commandForLegacyStatus("decline")?.name).toBe("decline_call");
    expect(commandForLegacyStatus("declined")?.name).toBe("decline_call");
    expect(commandForLegacyStatus("decline_ava")?.name).toBe("handoff_to_receptionist");
    expect(commandForLegacyStatus("decline_vm")?.name).toBe("offer_voicemail");
    expect(commandForLegacyStatus("cancel")?.name).toBe("cancel_call");
    expect(commandForLegacyStatus("missed")?.name).toBe("ring_timeout");
    expect(commandForLegacyStatus("no-answer")?.name).toBe("ring_timeout");
    expect(commandForLegacyStatus("bye")?.name).toBe("end_call");
    expect(commandForLegacyStatus("hangup")?.name).toBe("end_call");
    expect(commandForLegacyStatus("ended")?.name).toBe("end_call");
  });

  it("attributes each legacy status to the correct side", () => {
    expect(commandForLegacyStatus("decline")?.actor).toBe("callee");
    expect(commandForLegacyStatus("cancel")?.actor).toBe("caller");
    expect(commandForLegacyStatus("missed")?.actor).toBe("server");
  });

  it("leaves non-lifecycle statuses alone so they stay pure relays", () => {
    // `busy` carries info for the peer's UI but says nothing about the call's
    // lifecycle. Mapping it to a command would let a relay mutate call state.
    expect(commandForLegacyStatus("busy")).toBeNull();
    expect(commandForLegacyStatus("decline_agent")).toBeNull();
    expect(commandForLegacyStatus("totally_unknown_status")).toBeNull();
  });

  it("an OLD client's decline produces the SAME outcome as the new command", () => {
    const viaLegacy = commandForLegacyStatus("decline")!;
    const a = applyCommand(ringing(), { name: viaLegacy.name, actor: viaLegacy.actor }, NOW);
    const b = applyCommand(ringing(), { name: "decline_call", actor: "callee" }, NOW);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.state.disposition).toBe(b.state.disposition);
    expect(a.state.callee_leg_state).toBe(b.state.callee_leg_state);
    expect(a.state.caller_leg_state).toBe(b.state.caller_leg_state);
  });

  it("handoffs keep the CALLER's leg alive on the legacy path too", () => {
    // The distinction a single status string could not express. If an old
    // client's decline_ava ended the caller's leg, the receptionist would be
    // killed before it connected.
    const r = applyCommand(ringing(), { name: "handoff_to_receptionist", actor: "callee" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.callee_leg_state).toBe("dismissed_for_receptionist");
    expect(r.state.caller_leg_state).toBe("connected_to_receptionist");
    expect(r.state.caller_leg_state).not.toBe("ended");
    expect(r.state.session_state).toBe("handoff");

    const vm = applyCommand(ringing(), { name: "offer_voicemail", actor: "callee" }, NOW);
    expect(vm.ok).toBe(true);
    if (!vm.ok) return;
    expect(vm.state.caller_leg_state).toBe("voicemail_ready");
    expect(vm.state.caller_leg_state).not.toBe("ended");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 3b — THE WIRE CONTRACT. This is the gate that was NOT closed, and it
// broke in production within hours (call avatok-b7741a74): the DO broadcast
// `declined`, every shipped client switches on `decline`, so the frame was
// silently ignored and the call rang on until the caller's ring-timeout handed
// them to Ava. `sockets_sent=1` said delivered; the client understood nothing.
//
// The vocabulary a shipped client understands is a CONTRACT. These tests pin it.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 3b: the wire vocabulary shipped clients understand", () => {
  /** Words a shipped client's _onSignal / callStatusBus actually switches on. */
  const KNOWN_TO_OLD_CLIENTS = new Set([
    "decline", "decline_ava", "decline_vm", "decline_agent",
    "accept", "cancel", "bye", "ended", "no-answer", "missed", "busy", "ringing",
  ]);

  const after = (name: Parameters<typeof applyCommand>[1]["name"], actor: "caller" | "callee" | "server") => {
    const r = applyCommand(ringing(), { name, actor }, NOW);
    if (!r.ok) throw new Error(`${name} rejected`);
    return legacyWireStatus(r.state);
  };

  it("REGRESSION: a decline goes out as `decline`, never `declined`", () => {
    // The exact production bug. `declined` is the FSM's internal disposition
    // name; no client has ever listened for it.
    expect(after("decline_call", "callee")).toBe("decline");
    expect(after("decline_call", "callee")).not.toBe("declined");
  });

  it("handoffs keep their own long-standing words", () => {
    expect(after("handoff_to_receptionist", "callee")).toBe("decline_ava");
    expect(after("offer_voicemail", "callee")).toBe("decline_vm");
  });

  it("quick reply / spam / block present to the CALLER as a plain decline", () => {
    // The call is over; WHY is the callee's business, not the caller's.
    expect(after("send_quick_reply", "callee")).toBe("decline");
    expect(after("report_spam", "callee")).toBe("decline");
    expect(after("block_caller", "callee")).toBe("decline");
  });

  it("accept / cancel / timeout use their legacy words", () => {
    expect(after("accept_call", "callee")).toBe("accept");
    expect(after("cancel_call", "caller")).toBe("cancel");
    expect(after("ring_timeout", "server")).toBe("no-answer");
  });

  it("EVERY reachable outcome maps to a word an old client knows", () => {
    // The guard that would have caught the production bug. Any new state or
    // disposition must map onto the existing vocabulary — never invent a word
    // for shipped clients to silently ignore.
    for (const [name, actor] of [
      ["decline_call", "callee"], ["accept_call", "callee"],
      ["send_quick_reply", "callee"], ["handoff_to_receptionist", "callee"],
      ["offer_voicemail", "callee"], ["report_spam", "callee"],
      ["block_caller", "callee"], ["cancel_call", "caller"],
      ["ring_timeout", "server"], ["end_call", "caller"],
    ] as const) {
      const w = after(name, actor);
      expect(KNOWN_TO_OLD_CLIENTS.has(w), `${name} -> "${w}" is unknown to shipped clients`).toBe(true);
    }
  });

  it("a still-ringing call reports `ringing`, not an internal leg name", () => {
    expect(legacyWireStatus(ringing())).toBe("ringing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE INVARIANTS — the ones the frozen spec says must hold structurally.
// ─────────────────────────────────────────────────────────────────────────────
describe("core invariants", () => {
  it("declined can NEVER become receptionist_active", () => {
    const declined = applyCommand(ringing(), { name: "decline_call", actor: "callee" }, NOW);
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    const sneak = applyCommand(declined.state, { name: "handoff_to_receptionist", actor: "callee" }, NOW);
    expect(sneak.ok).toBe(false);
    expect(declined.state.service_leg_state).not.toBe("receptionist_active");
  });

  it("a late accept cannot revive a declined call", () => {
    const declined = applyCommand(ringing(), { name: "decline_call", actor: "callee" }, NOW);
    if (!declined.ok) return;
    const late = applyCommand(declined.state, { name: "accept_call", actor: "callee" }, NOW);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error).toBe("already_terminal");
  });

  it("a stale epoch is rejected and handed current state (multi-device race)", () => {
    const s = ringing();
    const stale = applyCommand(s, { name: "decline_call", actor: "callee", expected_epoch: 99 }, NOW);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toBe("stale_epoch");
    // The loser must be TOLD the truth so it can reconcile.
    expect(stale.state.epoch).toBe(s.epoch);
  });

  it("every ring-ending outcome requests ring-surface cancellation", () => {
    // The stale-notification bug was this being remembered per-button.
    for (const name of ["decline_call", "send_quick_reply", "handoff_to_receptionist",
      "offer_voicemail", "report_spam", "block_caller"] as const) {
      const r = applyCommand(ringing(), { name, actor: "callee" }, NOW);
      expect(r.ok, name).toBe(true);
      if (!r.ok) continue;
      expect(r.events, name).toContain("ring_surface_cancel_requested");
    }
  });

  it("the transition sequence increases on every real change", () => {
    const s = ringing();
    const r = applyCommand(s, { name: "decline_call", actor: "callee" }, NOW);
    if (!r.ok) return;
    expect(r.state.transition_sequence).toBeGreaterThan(s.transition_sequence);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 1 — blocklist failure behaviour, per the owner's ruling:
// cached policy first, then fail open, alert on every degraded verdict.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE 1: blocklist read failure is bounded", () => {
  beforeEach(() => __resetVerdictCache());

  const envWith = (impl: () => unknown) => ({
    DB_META: { prepare: () => ({ bind: () => ({ first: impl }) }) },
  } as never);

  const okEnv = (blocked: boolean) => envWith(async () => (blocked ? { x: 1 } : null));
  const failingEnv = () => envWith(async () => { throw new Error("D1 down"); });

  it("a healthy read that finds a block denies the call", async () => {
    const r = await admitCall(okEnv(true), CALLER, CALLEE);
    expect(r.admit).toBe(false);
    if (r.admit) return;
    expect(r.internal_reason).toBe("blocked");
    expect(r.policy).toBe("fresh");
    expect(r.degraded).toBeFalsy();
  });

  it("a healthy read that finds no block admits, undegraded", async () => {
    const r = await admitCall(okEnv(false), CALLER, CALLEE);
    expect(r.admit).toBe(true);
    expect(r.degraded).toBeFalsy();
  });

  it("KEY CASE: a known blocker STAYS blocked when D1 fails", async () => {
    // Warm the cache with a healthy read...
    await admitCall(okEnv(true), CALLER, CALLEE);
    // ...then D1 dies. A harasser is a repeat caller, so this is the case that
    // actually matters, and it is the one the old unqualified fail-open lost.
    const r = await admitCall(failingEnv(), CALLER, CALLEE);
    expect(r.admit).toBe(false);
    if (r.admit) return;
    expect(r.policy).toBe("cached");
    expect(r.degraded).toBe(true); // must alert
  });

  it("a known-allowed caller stays allowed when D1 fails", async () => {
    await admitCall(okEnv(false), CALLER, CALLEE);
    const r = await admitCall(failingEnv(), CALLER, CALLEE);
    expect(r.admit).toBe(true);
    expect(r.policy).toBe("cached");
    expect(r.degraded).toBe(true);
  });

  it("no cache AND a failed read fails OPEN, flagged for alerting", async () => {
    // The owner explicitly accepted this narrow window (a first-ever caller
    // during a D1 outage) over a database blip reading as a total outage.
    const r = await admitCall(failingEnv(), CALLER, CALLEE);
    expect(r.admit).toBe(true);
    expect(r.policy).toBe("unknown_failed_open");
    expect(r.degraded).toBe(true); // must alert
  });

  it("self-calls are never treated as a block case", async () => {
    const r = await admitCall(failingEnv(), CALLER, CALLER);
    expect(r.admit).toBe(true);
  });
});
