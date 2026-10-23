// [HF-CALL-MODES-P0] Single entry point that starts a call for instant, queued and (later) booked callers.
// STUB: Lane C owns this file and moves startTokenCall (routes/hf_calls.ts) here. Nothing calls it yet, so it throws rather than pretend.
// Spec: Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md sections 2.2 rule 4, 2.3.
import type { Env } from "../types";
import type { CallSource } from "./hf_call_contracts";

export interface StartInstantCallInput {
  callerUid: string;
  hostUid: string;
  /** 'queue' = dispatched by HfHostLineDO (line already locked as 'q:<queueEntryId>'; use claimHostFromQueue). */
  source: Extract<CallSource, "instant" | "queue">;
  queueEntryId?: string;
  /** Epoch ms hard stop (e.g. next booking cutoff). */
  hardEndsAt?: number;
}
export type StartInstantCallResult =
  | { ok: true; callId: string }
  | { ok: false; error: string; status?: number };

export async function startInstantCall(_env: Env, _input: StartInstantCallInput): Promise<StartInstantCallResult> {
  throw new Error("not_implemented");
}
