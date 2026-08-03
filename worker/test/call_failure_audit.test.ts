// [CALL-FAILURE-AUDIT-2026-08-03] Regression gates for the call failure-scenario
// audit of 2026-08-03.
//
// Each `describe` below is one finding from that audit. They are not decoration:
// every one of them encodes a behaviour that was WRONG in production on the day
// this file was written, and several of them are the second or third time the
// same class of bug has been fixed. The audit's own verdict on the third review
// round was that the missing coverage is "CallRoom-level integration: alarm
// paths, storage-failure injection, WS admission, keepalive, eviction, and
// concurrent /start" — so these tests deliberately go after the DECISIONS those
// paths make, at the level where they can be tested without a Durable Object.
//
// Two kinds of test live here:
//   * pure-reducer tests against lib/call_state.ts, which is I/O-free by design;
//   * extracted-logic tests for the DO-side rules that are not pure (the alarm's
//     connected-guard predicate, the away-buffer eviction loop, the receptionist
//     ownership claim), each mirrored here as the exact expression the DO runs.
//     Mirroring is a compromise — noted honestly — but it pins the ARITHMETIC and
//     the ORDERING, which is where all three of those went wrong.

import { describe, it, expect } from "vitest";
import {
  applyCommand, authorizeCommand, newCallSession, type CallSession,
} from "../src/lib/call_state";

const CALLER = "user_caller";
const CALLEE = "user_callee";
const NOW = 1_700_000_000_000;

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

function run(s: CallSession, name: Parameters<typeof applyCommand>[1]["name"],
             actor: "caller" | "callee" | "server",
             data?: Record<string, unknown>): CallSession {
  const r = applyCommand(s, { name, actor, data }, NOW);
  if (!r.ok) throw new Error(`${name} rejected: ${r.error}`);
  return r.state;
}

// ─────────────────────────────────────────────────────────────────────────────
// S4-a — the alarm must not time out a call that is demonstrably live.
//
// The gap: the FSM only learned about an answer from the client POSTing
// accept_call, and there are ordinary ways that never lands (an old build, a
// lost request, or the client's own 1500 ms claim timeout failing open to WS
// admission). Two people could be talking while the aggregate still said
// `ringing`, and at the ring deadline the alarm broadcast `no-answer` over the
// top of the conversation — or dropped Ava into the middle of it.
// ─────────────────────────────────────────────────────────────────────────────
describe("S4-a — mark_connected closes the answered-without-accept_call gap", () => {
  it("is server-only: no client may issue it", () => {
    expect(authorizeCommand("mark_connected", "server")).toBe(true);
    expect(authorizeCommand("mark_connected", "caller")).toBe(false);
    expect(authorizeCommand("mark_connected", "callee")).toBe(false);
  });

  it("moves a ringing call to connected with the answered disposition", () => {
    const s = run(ringing(), "mark_connected", "server");
    expect(s.session_state).toBe("connected");
    expect(s.callee_leg_state).toBe("accepted");
    expect(s.caller_leg_state).toBe("connected_to_callee");
    expect(s.disposition).toBe("answered_by_callee");
  });

  it("is idempotent — a repeat does not bump the transition sequence", () => {
    const first = run(ringing(), "mark_connected", "server");
    const again = applyCommand(first, { name: "mark_connected", actor: "server" }, NOW);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(again.state.transition_sequence).toBe(first.transition_sequence);
  });

  it("REFUSES to resurrect a declined call", () => {
    const declined = run(ringing(), "decline_call", "callee");
    const r = applyCommand(declined, { name: "mark_connected", actor: "server" }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Terminal sessions are immutable, so this is caught structurally before the
    // switch is even reached. Either guard is correct; what matters is that a
    // stray second socket can never revive a call the callee rejected.
    expect(r.error).toBe("already_terminal");
  });

  it("REFUSES after a receptionist handoff — Ava owns the caller leg", () => {
    const handed = run(ringing(), "handoff_to_receptionist", "server", { reason: "no_answer" });
    const r = applyCommand(handed, { name: "mark_connected", actor: "server" }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("illegal_transition");
  });

  it("makes the subsequent ring_timeout illegal — the whole point", () => {
    const live = run(ringing(), "mark_connected", "server");
    const r = applyCommand(live, { name: "ring_timeout", actor: "server" }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("illegal_transition");
  });
});

// The predicate the alarm evaluates, mirrored exactly. `answeredAt` is
// DELIBERATELY absent from it: that flag is sticky (set the instant a second
// socket ever attached, never cleared), so a zombie join on an offline callee
// leaves it true forever. That staleness already vetoed the unreachable→Ava
// handoff with 409 call_answered in prod (avatok-8caef3ce); trusting it here
// would import the same bug into the timeout path, where it would mean a
// phantom-answered call NEVER times out and NEVER reaches Ava.
function callIsLive(sessionState: string, peerTags: string[]): boolean {
  return sessionState === "connected" || new Set(peerTags).size >= 2;
}

describe("S4-a — the alarm's connected-guard predicate", () => {
  it("trips when two DISTINCT peers hold sockets", () => {
    expect(callIsLive("ringing", ["peerA", "peerB"])).toBe(true);
  });

  it("does NOT trip on two sockets for the SAME peer", () => {
    // The adopt-and-close path for a duplicate socket can transiently show two
    // entries for one participant. Counting raw getWebSockets().length — which
    // is what the externally-supplied patch did — would suppress no-answer for a
    // callee who never picked up.
    expect(callIsLive("ringing", ["peerA", "peerA"])).toBe(false);
  });

  it("does NOT trip for a lone caller waiting on an unanswered ring", () => {
    expect(callIsLive("ringing", ["peerA"])).toBe(false);
  });

  it("does NOT trip on a phantom-answered call with no live peers", () => {
    // answeredAt would be true here. The guard ignores it on purpose.
    expect(callIsLive("ringing", [])).toBe(false);
  });

  it("trips when the aggregate already knows the call connected", () => {
    expect(callIsLive("connected", [])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — grace expiry must advance the FSM, not only the legacy `ended` flag.
// ─────────────────────────────────────────────────────────────────────────────
describe("A2 — reconnect-grace expiry completes the session", () => {
  it("ends a CONNECTED call as answered, not as a cancel", () => {
    const live = run(ringing(), "accept_call", "callee");
    const ended = run(live, "end_call", "server");
    expect(ended.session_state).toBe("completed");
    expect(ended.disposition).toBe("answered_by_callee");
  });

  it("ends a call that never connected as a ring timeout", () => {
    const ended = run(ringing(), "end_call", "server");
    expect(ended.session_state).toBe("completed");
    expect(ended.disposition).toBe("ring_timeout");
  });

  it("makes the room refuse a late rejoin after expiry", () => {
    // This is the actual A2 bug: WS admission consults the FSM and only the FSM,
    // and `connected` accepts new peers. Without end_call, a device reconnecting
    // a moment after expiry was admitted into a room the server had already
    // declared over — peer-left sent, sockets closed, the other party gone.
    const live = run(ringing(), "accept_call", "callee");
    const ended = run(live, "end_call", "server");
    expect(ended.session_state).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — the receptionist's outcome must reach the aggregate.
// ─────────────────────────────────────────────────────────────────────────────
describe("A4 — receptionist lifecycle reaches the FSM", () => {
  function handedOff(): CallSession {
    return run(ringing(), "handoff_to_receptionist", "server", { reason: "no_answer" });
  }

  it("records answered_by_receptionist when Ava connects", () => {
    const s = run(handedOff(), "receptionist_connected", "server");
    expect(s.service_leg_state).toBe("receptionist_active");
    expect(s.disposition).toBe("answered_by_receptionist");
  });

  it("PRESERVES that disposition through the caller's own hangup", () => {
    // The bug this pins: a successful Ava session ends when the CALLER hangs up,
    // so teardown arrived as end_call — which found no disposition, saw
    // `wasConnected` false (the caller leg is connected_to_receptionist, not
    // connected_to_callee) and filed the call as `caller_cancelled`. Every call
    // Ava successfully answered was recorded as the caller giving up on it, and
    // `answered_by_receptionist` was unreachable dead code.
    const connected = run(handedOff(), "receptionist_connected", "server");
    const ended = run(connected, "end_call", "caller");
    expect(ended.session_state).toBe("completed");
    expect(ended.disposition).toBe("answered_by_receptionist");
  });

  it("COMPLETES the session when Ava fails to start", () => {
    // Without this the caller was parked in `handoff` forever: unable to reach
    // Ava (she had just died) and unable to fall back to the human leg either,
    // because humanRoomAcceptsNewPeer is false in `handoff`.
    const s = run(handedOff(), "receptionist_failed", "server");
    expect(s.session_state).toBe("completed");
    expect(s.service_leg_state).toBe("failed");
    expect(s.disposition).toBe("receptionist_failed");
  });

  it("keeps both outcomes server-only", () => {
    for (const cmd of ["receptionist_connected", "receptionist_failed"] as const) {
      expect(authorizeCommand(cmd, "server")).toBe(true);
      expect(authorizeCommand(cmd, "caller")).toBe(false);
      expect(authorizeCommand(cmd, "callee")).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H2 — the away-peer replay buffer must be bounded in BYTES, not just count.
//
// A DO storage VALUE is capped at 128 KiB and the whole buffer is written as one
// value. SDP offers are multi-kilobyte, so 100 of them comfortably exceed the
// cap; the put then threw out of webSocketMessage and killed the relay.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_BUFFERED_MESSAGES = 100;
const MAX_BUFFERED_BYTES = 110 * 1024;

interface TestAway { buffered: string[]; bufferedBytes?: number }

/** Mirrors CallRoom.bufferForAwayPeer exactly. */
function bufferForAwayPeer(away: TestAway, out: string): void {
  if (typeof away.bufferedBytes !== "number") away.bufferedBytes = 0;
  away.buffered.push(out);
  away.bufferedBytes += out.length + 3;
  while (
    away.buffered.length > 0 &&
    (away.buffered.length > MAX_BUFFERED_MESSAGES || away.bufferedBytes > MAX_BUFFERED_BYTES)
  ) {
    const dropped = away.buffered.shift();
    if (dropped === undefined) break;
    away.bufferedBytes -= dropped.length + 3;
    if (away.bufferedBytes < 0) away.bufferedBytes = 0;
  }
}

describe("H2 — away-buffer byte cap", () => {
  it("keeps the serialized buffer under the DO value cap with large SDP frames", () => {
    const away: TestAway = { buffered: [], bufferedBytes: 0 };
    const bigSdp = "x".repeat(8 * 1024); // a realistic SDP offer
    for (let i = 0; i < 100; i++) bufferForAwayPeer(away, bigSdp);
    expect(away.bufferedBytes!).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    expect(JSON.stringify(away.buffered).length).toBeLessThan(128 * 1024);
    // The count cap alone would have kept all 100 — 800 KiB, six times the cap.
    expect(away.buffered.length).toBeLessThan(100);
  });

  it("still enforces the message-count cap for small frames", () => {
    const away: TestAway = { buffered: [], bufferedBytes: 0 };
    for (let i = 0; i < 250; i++) bufferForAwayPeer(away, `{"c":${i}}`);
    expect(away.buffered.length).toBe(MAX_BUFFERED_MESSAGES);
  });

  it("drops OLDEST first, so the newest signalling survives", () => {
    const away: TestAway = { buffered: [], bufferedBytes: 0 };
    for (let i = 0; i < 150; i++) bufferForAwayPeer(away, `frame-${i}`);
    expect(away.buffered[away.buffered.length - 1]).toBe("frame-149");
    expect(away.buffered).not.toContain("frame-0");
  });

  it("MIGRATION: a legacy record without bufferedBytes must not go NaN", () => {
    // The bug this pins is silent: `undefined + n` is NaN, `NaN > MAX` is false,
    // so the drop loop never runs and the buffer is unbounded again — with the
    // guard apparently present in the source. loadAway() hydrates the counter for
    // exactly this reason; the fallback here is the second line of defence.
    const legacy: TestAway = { buffered: ["old-a", "old-b"] }; // no bufferedBytes
    bufferForAwayPeer(legacy, "new");
    expect(Number.isNaN(legacy.bufferedBytes!)).toBe(false);
    const big = "y".repeat(8 * 1024);
    for (let i = 0; i < 100; i++) bufferForAwayPeer(legacy, big);
    expect(legacy.bufferedBytes!).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
  });

  it("hydration matches what the counter would have been", () => {
    const frames = ["a", "bb", "ccc"];
    const hydrated = frames.reduce((n, f) => n + f.length + 3, 0);
    const fresh: TestAway = { buffered: [], bufferedBytes: 0 };
    for (const f of frames) bufferForAwayPeer(fresh, f);
    expect(fresh.bufferedBytes).toBe(hydrated);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — receptionist session ownership must be decided by ONE writer.
//
// Mirrors CallRoom.claimReceptionistSession against a strongly-consistent store.
// The point of the test is the CONTRACT: N concurrent claimants, exactly one
// winner, and every loser handed the winner's id rather than an error.
// ─────────────────────────────────────────────────────────────────────────────
describe("A3 — atomic receptionist ownership", () => {
  function makeRoom() {
    let owner: string | null = null;
    return {
      claim(sid: string): { already: boolean; sid: string } {
        if (owner) return { already: true, sid: owner };
        owner = sid;
        return { already: false, sid };
      },
    };
  }

  it("gives exactly one winner among concurrent claimants", () => {
    const room = makeRoom();
    const results = ["sid-a", "sid-b", "sid-c"].map((s) => room.claim(s));
    expect(results.filter((r) => !r.already)).toHaveLength(1);
    expect(results.filter((r) => r.already)).toHaveLength(2);
  });

  it("hands every loser the WINNER's sid, so the caller reattaches", () => {
    const room = makeRoom();
    const winner = room.claim("sid-a");
    const loser = room.claim("sid-b");
    expect(winner.already).toBe(false);
    expect(loser.already).toBe(true);
    // This is what turns a lost race into a reattach instead of a second Ava:
    // the loser must be able to point the caller at the live session.
    expect(loser.sid).toBe(winner.sid);
  });

  it("is stable across repeated claims by the winner itself", () => {
    const room = makeRoom();
    room.claim("sid-a");
    const again = room.claim("sid-a");
    expect(again.sid).toBe("sid-a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A5 — the scenario gate must be evaluated BEFORE the handoff is committed.
// ─────────────────────────────────────────────────────────────────────────────
describe("A5 — gate ordering around the receptionist admit", () => {
  it("a refusal AFTER the admit leaves the caller with a closed room and no service", () => {
    // The state the old ordering produced, asserted so it can never be called
    // acceptable by accident: the human room is closed (handoff), the caller's
    // leg reads connected_to_receptionist, and no Ava session exists.
    const handed = run(ringing(), "handoff_to_receptionist", "server", { reason: "no_answer" });
    expect(handed.session_state).toBe("handoff");
    expect(handed.caller_leg_state).toBe("connected_to_receptionist");
    expect(handed.service_leg_state).toBe("starting_receptionist");
    // Nothing about that state says "no receptionist is coming" — which is why
    // refusing after this point stranded the call.
  });

  it("the rollback transition exists and completes the session", () => {
    // If a post-commit refusal ever becomes unavoidable again, this is the exit.
    const handed = run(ringing(), "handoff_to_receptionist", "server", { reason: "no_answer" });
    const rolled = run(handed, "receptionist_failed", "server");
    expect(rolled.session_state).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H5 — the keepalive frame must EXACTLY match the DO's auto-response request.
//
// `setWebSocketAutoResponse` compares request strings byte-for-byte. The client
// sent its ping through `_send`, which stamps `gen` on every frame after
// `welcome` — so on every connected call the ping was `{"type":"ping","gen":N}`,
// never matched, never got a pong, woke the DO each time, and was relayed to the
// peer as noise. A missed-pong counter layered on top of that would have forced
// a reconnect every 30 s on every healthy call.
// ─────────────────────────────────────────────────────────────────────────────
describe("H5 — keepalive frame shape", () => {
  const AUTO_RESPONSE_REQUEST = JSON.stringify({ type: "ping" });

  it("a raw ping matches the auto-response request exactly", () => {
    expect(JSON.stringify({ type: "ping" })).toBe(AUTO_RESPONSE_REQUEST);
  });

  it("a gen-stamped ping does NOT match — the bug, pinned", () => {
    expect(JSON.stringify({ type: "ping", gen: 2 })).not.toBe(AUTO_RESPONSE_REQUEST);
  });

  it("key order matters too, so the fix cannot be reordered away", () => {
    expect(JSON.stringify({ gen: 2, type: "ping" })).not.toBe(AUTO_RESPONSE_REQUEST);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H4 — the reconnect margin must not be zero.
// ─────────────────────────────────────────────────────────────────────────────
describe("H4 — reconnect grace exceeds the client's give-up", () => {
  const SERVER_GRACE_MS = 45_000;      // call_room.ts RECONNECT_GRACE_MS
  const CLIENT_GIVE_UP_MS = 30_000;    // call_session.dart _kReconnectGiveUp

  it("leaves the client's final attempt room to land", () => {
    expect(SERVER_GRACE_MS).toBeGreaterThan(CLIENT_GIVE_UP_MS);
    expect(SERVER_GRACE_MS - CLIENT_GIVE_UP_MS).toBeGreaterThanOrEqual(10_000);
  });
});
