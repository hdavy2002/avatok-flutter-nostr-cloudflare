// [CALL-GLARE-LIFECYCLE-1 2026-08-02] Pure policy for reciprocal-dial folding.
// A pending invite is only a glare candidate while it is recent AND its call is
// still non-terminal. Time-only matching folded callbacks into declined calls.

export const GLARE_WINDOW_MS = 30_000;

export interface PendingGlareInvite {
  callId: string;
  ts: number;
  callerRoomToken?: string;
  calleeRoomToken?: string;
}

/** The second placer joins the reciprocal call as its callee. */
export function glareJoinRoomToken(reciprocal: PendingGlareInvite | null | undefined): string {
  return reciprocal?.calleeRoomToken ?? "";
}

export type GlarePlacementResolution =
  | { kind: "merge"; winnerCallId: string; reciprocalCallId: string }
  | {
      kind: "place";
      pruneReciprocal: boolean;
      reason: "none" | "same_call" | "expired" | "terminal";
    };

/** Decide whether two placements are genuinely simultaneous live calls. */
export function resolveGlarePlacement(args: {
  callId: string;
  reciprocal?: PendingGlareInvite | null;
  now: number;
  reciprocalTerminal: boolean;
}): GlarePlacementResolution {
  const { callId, reciprocal, now, reciprocalTerminal } = args;
  if (!reciprocal?.callId) {
    return { kind: "place", pruneReciprocal: false, reason: "none" };
  }
  if (reciprocal.callId === callId) {
    return { kind: "place", pruneReciprocal: false, reason: "same_call" };
  }
  if (now - reciprocal.ts >= GLARE_WINDOW_MS) {
    return { kind: "place", pruneReciprocal: true, reason: "expired" };
  }
  if (reciprocalTerminal) {
    return { kind: "place", pruneReciprocal: true, reason: "terminal" };
  }
  return {
    kind: "merge",
    // The reciprocal placement is already proceeding through participant/token
    // registration. Choosing the current placement can nominate an uninitialized
    // room because this request returns immediately after the merge verdict.
    winnerCallId: reciprocal.callId,
    reciprocalCallId: reciprocal.callId,
  };
}
