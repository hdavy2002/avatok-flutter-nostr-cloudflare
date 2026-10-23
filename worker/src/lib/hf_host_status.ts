// [HF-CALL-MODES-P0] Pure derivation of what a fan sees for a host (spec 2.1 table). No I/O: callers pass row values.
// Lane A owns this file; Lanes B and E read the same function so every surface agrees.
import type { CallRefusalReason, HostMode, LegacyPresence, PublicCallState } from "./hf_call_contracts";

export interface HostLineInput {
  /** hf_hosts.call_mode; unknown / null is treated as 'online' (column default) */
  mode: HostMode | string | null | undefined;
  /** hf_hosts.on_call_since: set only when both legs of a call joined */
  onCallSince: number | null | undefined;
  /** hf_hosts.presence_call_id: the line lock (a call id or 'q:<entryId>') */
  lockCallId: string | null | undefined;
  /** waiting queue entries */
  waiting: number;
}

/** Spec 2.1: offline > appointments > on_call > connecting > queue_only > available. */
export function publicCallState(h: HostLineInput): PublicCallState {
  const mode = h.mode === "offline" || h.mode === "bookings_only" ? h.mode : "online";
  if (mode === "offline") return "offline";
  if (mode === "bookings_only") return "appointments";
  if (h.onCallSince != null) return "on_call";
  if (h.lockCallId) return "connecting";
  if (h.waiting > 0) return "queue_only";
  return "available";
}

/** Legacy hf_hosts.presence for existing readers / shipped apps: busy if on a call, else online if mode online, else offline. */
export function derivePresence(mode: HostMode | string | null | undefined, onCallSince: number | null | undefined): LegacyPresence {
  if (onCallSince != null) return "busy";
  return mode === "bookings_only" || mode === "offline" ? "offline" : "online";
}

/** Can a fan join the queue now? (state check only; the other join rules live in Lane B.) */
export function canQueue(state: PublicCallState, paused: boolean): boolean {
  return !paused && (state === "on_call" || state === "connecting" || state === "queue_only");
}

/** Can a fan book a time? Offline takes no new bookings (D1). */
export function canBook(state: PublicCallState): boolean {
  return state !== "offline";
}

/** The refusal reason for a non-available state (null when the fan can call now). */
export function refusalReason(state: PublicCallState): CallRefusalReason | null {
  return state === "available" ? null : state;
}
