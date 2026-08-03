/**
 * [RECEPT-FSM-COMPLETE-1 / CALL-ATOMIC-1 2026-08-03] Pure-reducer tests for the
 * lifecycle holes found in the 2026-08-03 call race audit.
 *
 * These need no Durable Object and no network — that is the whole point of
 * keeping lib/call_state.ts pure.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommand, newCallSession, humanRoomAcceptsNewPeer, legacyWireStatus,
  type CallSession, type CommandName,
} from "../src/lib/call_state";

const NOW = 1_754_000_000_000;

function ringing(): CallSession {
  const s = newCallSession("avatok-lifecycle", NOW);
  s.caller_uid = "uid-caller";
  s.callee_uid = "uid-callee";
  s.session_state = "ringing";
  s.caller_leg_state = "ringing";
  s.callee_leg_state = "ringing";
  s.transition_sequence = 2;
  return s;
}

function run(s: CallSession, name: CommandName, actor: "caller" | "callee" | "server") {
  return applyCommand(s, { name, actor }, NOW);
}

/** Drive a session to a live Ava conversation, the way production does. */
function receptionistActive(): CallSession {
  const handoff = run(ringing(), "handoff_to_receptionist", "callee");
  expect(handoff.ok).toBe(true);
  const connected = run((handoff as any).state, "receptionist_connected", "server");
  expect(connected.ok).toBe(true);
  return (connected as any).state;
}

describe("[RECEPT-FSM-COMPLETE-1] a finished Ava session completes the call", () => {
  it("receptionist_active is not terminal and blocks a late human join", () => {
    const s = receptionistActive();
    expect(s.session_state).toBe("handoff");
    expect(s.service_leg_state).toBe("receptionist_active");
    expect(s.disposition).toBe("answered_by_receptionist");
    // This is the trap: not terminal, but no human may join either. Before
    // receptionist_completed existed, an Ava-ended call stayed here forever.
    expect(humanRoomAcceptsNewPeer(s)).toBe(false);
  });

  it("receptionist_completed completes it and KEEPS the answered disposition", () => {
    const r = run(receptionistActive(), "receptionist_completed", "server");
    expect(r.ok).toBe(true);
    const s = (r as any).state as CallSession;
    expect(s.session_state).toBe("completed");
    expect(s.service_leg_state).toBe("completed");
    // Ava answered. How the session wound up does not change that.
    expect(s.disposition).toBe("answered_by_receptionist");
  });

  it("is idempotent — a second report is a harmless no-op, not an error state", () => {
    const first = run(receptionistActive(), "receptionist_completed", "server");
    const second = run((first as any).state, "receptionist_completed", "server");
    // Terminal sessions are immutable: the repeat is rejected, and the state
    // handed back is unchanged. Both engines report from finalize(), and the
    // client may also have posted end_call, so this WILL happen routinely.
    expect(second.ok).toBe(false);
    expect((second as any).error).toBe("already_terminal");
    expect((second as any).state.disposition).toBe("answered_by_receptionist");
  });

  it("a session that never connected completes as failed, not as answered", () => {
    const handoff = run(ringing(), "handoff_to_receptionist", "callee");
    const r = run((handoff as any).state, "receptionist_completed", "server");
    expect((r as any).state.disposition).toBe("receptionist_failed");
  });
});

describe("[CALL-ATOMIC-1] a late cancel cannot erase an answered call", () => {
  it("cancel_call after accept_call is a no-op", () => {
    const accepted = run(ringing(), "accept_call", "callee");
    const s = (accepted as any).state as CallSession;
    expect(s.session_state).toBe("connected");

    const cancelled = run(s, "cancel_call", "caller");
    expect(cancelled.ok).toBe(true);
    expect((cancelled as any).changed).toBe(false);
    // The specific damage this prevents: an ANSWERED call recorded as
    // caller_cancelled, which is what every downstream consumer would then
    // report — call log, brain ingest, missed-call surface, billing.
    expect((cancelled as any).state.disposition).toBe("answered_by_callee");
    expect((cancelled as any).state.session_state).toBe("connected");
  });

  it("cancel_call while still ringing still works", () => {
    const r = run(ringing(), "cancel_call", "caller");
    expect((r as any).changed).toBe(true);
    expect((r as any).state.disposition).toBe("caller_cancelled");
  });

  it("decline_call after accept_call is a no-op (the production defect)", () => {
    const accepted = run(ringing(), "accept_call", "callee");
    const declined = run((accepted as any).state, "decline_call", "callee");
    expect((declined as any).changed).toBe(false);
    expect((declined as any).state.session_state).toBe("connected");
  });
});

describe("[CALL-WIRE-DECLINE-1] a decline goes out on the wire as a decline", () => {
  it("declining emits `decline`, never `no-answer`", () => {
    const r = run(ringing(), "decline_call", "callee");
    expect((r as any).changed).toBe(true);
    // The bug this guards (prod call avatok-b7741a74): a decline that reached
    // the caller as `no-answer` made them hand the call to Ava instead of
    // stopping. The wire word is a contract, not a label.
    expect(legacyWireStatus((r as any).state)).toBe("decline");
  });

  it("an actual ring timeout still emits `no-answer`", () => {
    const r = run(ringing(), "ring_timeout", "server");
    expect(legacyWireStatus((r as any).state)).toBe("no-answer");
  });
});
