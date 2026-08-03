// [CALL-GLARE-LIFECYCLE-1] Locks the production callback-after-decline fix.

import { describe, expect, it } from "vitest";
import {
  GLARE_WINDOW_MS, glareJoinRoomToken, resolveGlarePlacement, type PendingGlareInvite,
} from "../src/lib/call_glare";

const NOW = 1_700_000_000_000;
const prior: PendingGlareInvite = { callId: "avatok-prior", ts: NOW - 7_000 };

describe("call glare lifecycle", () => {
  it("merges two genuinely live reciprocal placements", () => {
    const result = resolveGlarePlacement({
      callId: "avatok-callback", reciprocal: prior, now: NOW,
      reciprocalTerminal: false,
    });
    expect(result.kind).toBe("merge");
  });

  it.each(["declined", "cancelled", "timed out", "busy-ended"])(
    "never folds a callback into a %s call",
    () => {
      const result = resolveGlarePlacement({
        callId: "avatok-callback", reciprocal: prior, now: NOW,
        reciprocalTerminal: true,
      });
      expect(result).toEqual({
        kind: "place", pruneReciprocal: true, reason: "terminal",
      });
    },
  );

  it("prunes an expired reciprocal invite", () => {
    const result = resolveGlarePlacement({
      callId: "avatok-callback",
      reciprocal: { ...prior, ts: NOW - GLARE_WINDOW_MS },
      now: NOW,
      reciprocalTerminal: false,
    });
    expect(result).toEqual({
      kind: "place", pruneReciprocal: true, reason: "expired",
    });
  });

  it("does not treat a retry of the same call id as glare", () => {
    const result = resolveGlarePlacement({
      callId: prior.callId, reciprocal: prior, now: NOW,
      reciprocalTerminal: false,
    });
    expect(result).toEqual({
      kind: "place", pruneReciprocal: false, reason: "same_call",
    });
  });

  it("keeps the already-registered reciprocal call as the winner", () => {
    const result = resolveGlarePlacement({
      // Even though the current id sorts first, it has not been initialized;
      // the reciprocal call is already proceeding through registration.
      callId: "avatok-a", reciprocal: { callId: "avatok-z", ts: NOW - 100 },
      now: NOW, reciprocalTerminal: false,
    });
    expect(result).toMatchObject({ kind: "merge", winnerCallId: "avatok-z" });
  });

  it("hands the losing placer the reciprocal call's callee credential", () => {
    expect(glareJoinRoomToken({
      callId: "avatok-prior",
      ts: NOW - 100,
      callerRoomToken: "caller-secret",
      calleeRoomToken: "callee-secret",
    })).toBe("callee-secret");
  });
});
