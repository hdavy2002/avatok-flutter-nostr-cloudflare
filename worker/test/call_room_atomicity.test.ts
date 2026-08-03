/**
 * [CALL-ATOMIC-1 2026-08-03] REGRESSION TESTS FOR THE AGGREGATE CRITICAL SECTION.
 *
 * These reproduce the production incident directly. On 2026-08-03 call
 * avatok-cb1618e6, `accept_call` returned `changed=true seq=3` and 245 ms later a
 * native `decline_call` returned `changed=true seq=4`. Neither ordering can
 * produce that pair — accept-then-decline hits the reducer's `connected` no-op
 * guard, decline-then-accept hits `already_terminal` — so both commands must have
 * read the same snapshot. Five of the seven accepts in the preceding fortnight
 * died this way.
 *
 * THE FAKE MUST YIELD. Every storage operation below awaits a real macrotask, and
 * `blockConcurrencyWhile` implements genuine mutual exclusion via a promise chain,
 * exactly as the runtime does. A fake whose `get` resolves synchronously cannot
 * express the bug: the interleaving IS the bug. Verified by reverting
 * `withAggregateLock` to run its callback inline: all five tests then fail, which
 * is the defect they guard. Re-run that experiment if you ever "simplify" the
 * lock away — a green suite with a synchronous fake proves nothing.
 */
import { describe, expect, it } from "vitest";
import { CallRoom } from "../src/do/call_room";
import type { CallSession } from "../src/lib/call_state";

const CALLER = "uid-caller";
const CALLEE = "uid-callee";
const CALL_ID = "avatok-atomic";

/** A ringing call, mid-flight — the exact state a real accept/decline race hits. */
function ringingSession(): CallSession {
  const now = Date.now();
  return {
    call_id: CALL_ID,
    caller_uid: CALLER,
    callee_uid: CALLEE,
    epoch: 1,
    transition_sequence: 2,
    session_state: "ringing",
    caller_leg_state: "ringing",
    callee_leg_state: "ringing",
    service_leg_state: "none",
    disposition: "none",
    created_at: now,
    updated_at: now,
  };
}

/** Yield to the macrotask queue so another in-flight request's continuation can
 *  genuinely run here — this is what a real `await storage.get()` does. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeRoom(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  // Serialize like the real runtime: one callback at a time, FIFO.
  let lock: Promise<unknown> = Promise.resolve();

  const state = {
    id: { name: CALL_ID },
    storage: {
      get: async <T>(key: string) => { await tick(); return data.get(key) as T | undefined; },
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        await tick();
        if (typeof key === "string") data.set(key, value);
        else for (const [k, v] of Object.entries(key)) data.set(k, v);
      },
      delete: async (key: string) => { await tick(); return data.delete(key); },
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = lock.then(fn, fn);
      lock = run.then(() => undefined, () => undefined);
      return run;
    },
    getWebSockets: () => [],
    getTags: () => [],
    waitUntil: (p?: Promise<unknown>) => { void Promise.resolve(p).catch(() => undefined); },
  };
  const env = { Q_ANALYTICS: { send: async () => undefined } };
  return { room: new CallRoom(state as any, env as any), data };
}

/** Fire two commands at a COLD room with no await between them, so both are
 *  in flight before either can persist. */
async function race(a: [string, string], b: [string, string]) {
  const { room, data } = fakeRoom({ fsm: ringingSession() });
  const run = (name: string, uid: string) =>
    (room as any).runCommand(CALL_ID, name, "server", { authenticatedUid: uid });
  const [ra, rb] = await Promise.all([run(a[0], a[1]), run(b[0], b[1])]);
  return { ra, rb, data };
}

describe("[CALL-ATOMIC-1] concurrent commands on a cold CallRoom", () => {
  it("accept vs decline: exactly one transition commits", async () => {
    const { ra, rb, data } = await race(["accept_call", CALLEE], ["decline_call", CALLEE]);

    const changed = [ra, rb].filter((r) => r.changed === true);
    expect(changed).toHaveLength(1);

    // And the survivor is what storage actually holds — no lost update.
    const stored = data.get("fsm") as CallSession;
    const winner = changed[0];
    expect(stored.session_state).toBe(winner.session_state);
    expect(stored.disposition).toBe(winner.disposition);
    expect(stored.transition_sequence).toBe(winner.seq);

    // The loser is told the truth rather than inventing an outcome.
    const loser = [ra, rb].find((r) => r.changed !== true)!;
    expect(loser.ok === false || loser.changed === false).toBe(true);
  });

  it("accept vs caller cancel: the accept wins and the cancel is a no-op", async () => {
    const { ra, rb, data } = await race(["accept_call", CALLEE], ["cancel_call", CALLER]);
    const changed = [ra, rb].filter((r) => r.changed === true);
    expect(changed).toHaveLength(1);
    // Specifically: an answered call must never be recorded as caller_cancelled.
    const stored = data.get("fsm") as CallSession;
    expect(stored.session_state).toBe("connected");
    expect(stored.disposition).toBe("answered_by_callee");
  });

  it("receptionist handoff vs caller cancel: serialized, never a lost update", async () => {
    // Both of these are legal in sequence — the caller may hang up on Ava while
    // she is starting — so the invariant here is not "one winner" but "the second
    // command SAW the first". Two commands emerging with the same sequence number
    // is the signature of the production defect.
    const { ra, rb, data } = await race(
      ["handoff_to_receptionist", CALLEE], ["cancel_call", CALLER],
    );
    const seqs = [ra, rb].filter((r) => r.changed === true).map((r) => r.seq as number);
    expect(new Set(seqs).size).toBe(seqs.length);

    const stored = data.get("fsm") as CallSession;
    expect(stored.transition_sequence).toBe(Math.max(...seqs));
    expect(["handoff", "completed"]).toContain(stored.session_state);
  });

  it("a decline that loses to an accept never marks the call terminal", async () => {
    const { ra, rb, data } = await race(["accept_call", CALLEE], ["decline_call", CALLEE]);
    const accept = [ra, rb].find((r) => r.command === "accept_call")!;
    if (accept.changed === true) {
      // This is the production case: the accept won, so nothing may have
      // written a terminal marker on its behalf.
      expect(data.get("terminalStatus")).toBeUndefined();
      expect((data.get("fsm") as CallSession).session_state).toBe("connected");
    }
  });
});

describe("[CALL-ATOMIC-1] concurrent receptionist session claims", () => {
  it("two simultaneous claims on a cold room agree on one winner", async () => {
    const { room } = fakeRoom({ fsm: ringingSession() });
    const claim = (sid: string) => (room as any).claimReceptionistSession(sid);
    const [x, y] = await Promise.all([claim("sid-a"), claim("sid-b")]);

    // Exactly one winner, and both callers are handed the SAME session id —
    // two `already:false` results is the duplicate-Ava incident (avatok-14739b84):
    // two greetings, two recordings, two billing events for one call.
    expect([x, y].filter((r: any) => r.already === false)).toHaveLength(1);
    expect(x.sid).toBe(y.sid);
  });
});
