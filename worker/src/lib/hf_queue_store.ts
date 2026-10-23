// [HF-CALL-MODES-P0] Call-queue helpers: STUBS ONLY (Lane B owns and implements this file; nothing calls it yet).
// Spec: Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md section 2.2 (HF-CALL-10). Every stub returns a safe "no queue" default so a premature
// caller changes nothing. Behind flag hfCallQueueEnabled (default off).
import type { Env } from "../types";
import type { PublicCallState, QueueSkipReason } from "./hf_call_contracts";

/**
 * The host's line became free (HfCallDO called releaseHost). Pokes the host's HfHostLineDO ({op:"line-free"}) so it can start the break and
 * dispatch the next fan. Must never throw (called from settle paths). Stub: no-op.
 */
export async function notifyLineFree(_env: Env, _hostUid: string, _callId: string): Promise<void> {
  return;
}

/**
 * The fairness gate used by claimHost / POST /api/hf/calls: while anyone waits, an instant caller must queue instead of jumping.
 * Returns { waiting, paused, open } for the host. Stub: nobody waiting, queue closed.
 */
export async function queueGate(_env: Env, _hostUid: string, _state?: PublicCallState): Promise<{ waiting: number; paused: boolean; open: boolean }> {
  return { waiting: 0, paused: false, open: false };
}

/**
 * Close the whole queue (mode left 'online', account closing, host forced offline): every waiting/offered entry -> 'closed' with
 * skip_reason (default host_offline), WhatsApp each fan, release any 'q:' lock. Returns how many entries were closed. Stub: 0.
 */
export async function closeQueue(_env: Env, _hostUid: string, _reason: QueueSkipReason = "host_offline"): Promise<number> {
  return 0;
}
