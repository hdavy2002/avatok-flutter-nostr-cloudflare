// platform_types.ts — FROZEN CONTRACT of Canonical Architecture v1.0
// (Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md, "Platform
// contracts" §72-93 — AVA-RCPT-29). This is the shared vocabulary every
// execution mode (voicemail today, AI_AGENT/IVR/HUMAN_TRANSFER/SPAM_SINK
// later) and every consumer (worker routes, per-call DO, PostHog, Guardian,
// billing) speaks. Changing anything here is a frozen-contract change per the
// plan's guardrail block and needs an ADR (Specs/ADR-*.md) approved by the
// owner — an implementation commit alone is never sufficient.
//
// V1 SCOPE NOTE: v1 ships VOICEMAIL-ONLY (plan "Rollout inversion"). This
// module still declares the full CallState/ExecutionMode vocabulary because
// the contract is meant to outlive the AI pipeline being dark — voicemail.ts
// (worker/src/routes/pstn.ts) only ever touches the VOICEMAIL/ORPHAN slice of
// it. No AI/receptionist code is imported by, or imports, this file's
// voicemail-relevant members.

/** Canonical call lifecycle (plan §"call state machine", AVA-RCPT-17,
 *  contract #4: single definition, consumed by worker/DO/PostHog/analytics/
 *  billing — no string literals, no duplicate enums anywhere).
 *
 *  V1 (voicemail-only) walks a small slice of this: FORWARDED → ANSWERED →
 *  EXECUTING → RECORDING_FINALIZE → INBOX_STORED → DONE, with LOST/ORPHAN as
 *  the failure/no-owner edges. The AI-mode states (AI_CONNECTING, AI_ACTIVE,
 *  WRAP_UP, GUARDIAN_QUEUED as an active step, …) are reserved for when
 *  AI_AGENT execution mode is flipped on (v2+) — declared now so the contract
 *  never needs a breaking rename later. */
export const CallState = {
  FORWARDED: "FORWARDED",                     // carrier CFB/CFNRy delivered the call to Vobiz
  ANSWERED: "ANSWERED",                        // our /answer webhook has responded with XML
  EXECUTING: "EXECUTING",                      // the chosen Execution Mode is actively running (voicemail record window, or AI session)
  RECORDING_FINALIZE: "RECORDING_FINALIZE",    // recording fetched/stored, transcript pending
  INBOX_STORED: "INBOX_STORED",                // InboxDO append succeeded — source of truth reached
  GUARDIAN_QUEUED: "GUARDIAN_QUEUED",          // post-call signal-harvest queued (async, best-effort)
  DONE: "DONE",                                // terminal — call fully processed
  LOST: "LOST",                                // DO/session unreachable before finalize; recovered via hangup webhook, degraded:true
  ORPHAN: "ORPHAN",                            // no owner resolved (neither ForwardedFrom nor an expectation matched)
} as const;
export type CallState = (typeof CallState)[keyof typeof CallState];

/** Execution modes — AI is one mode among many, never an architectural
 *  dependency (plan guardrail). V1 only ever selects VOICEMAIL (or REJECT in
 *  pathological cases); AI_AGENT is declared dark for v2. */
export const ExecutionMode = {
  VOICEMAIL: "VOICEMAIL",
  AI_AGENT: "AI_AGENT",   // v2+ — dark in v1, no engine code exists yet
  REJECT: "REJECT",
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/** Immutable per-call context (plan contract #5/#17): built once at
 *  admission, passed to every module, never mutated (Object.freeze /
 *  readonly). A changed fact is a NEW CallContext, never an edit. */
export interface CallContext {
  readonly call_id: string;
  readonly trace_id: string;
  readonly owner_uid: string | null;         // null until/unless resolved (ForwardedFrom or expectation match)
  readonly caller_e164: string | null;       // null for hidden/withheld caller ID
  readonly forwarded_from: string | null;    // raw carrier-supplied ForwardedFrom, if present
  readonly tier: "free" | "paid" | "business";
  readonly execution_mode: ExecutionMode;
  readonly admission_reason: string;         // why this mode was chosen — human-readable, stable string
  readonly created_ms: number;
}

/** Build a frozen CallContext — the only sanctioned constructor. Never
 *  spread-and-edit an existing context; call this again for a new fact. */
export function freezeCallContext(ctx: CallContext): Readonly<CallContext> {
  return Object.freeze({ ...ctx });
}

/** Typed platform event names (plan contract #15 — Event Contract). PostHog,
 *  Billing, and Guardian are CONSUMERS of these events; no module emits
 *  ad-hoc telemetry strings. V1 emits the voicemail-relevant subset only. */
export const PlatformEvent = {
  AdmissionDecision: "AdmissionDecision",
  CallAnswered: "CallAnswered",
  ExecutionStarted: "ExecutionStarted",
  ExecutionEnded: "ExecutionEnded",
  RecordingUploaded: "RecordingUploaded",
  TranscriptReady: "TranscriptReady",
  InboxDelivered: "InboxDelivered",
  GuardianQueued: "GuardianQueued",
  StateTransition: "StateTransition",
} as const;
export type PlatformEvent = (typeof PlatformEvent)[keyof typeof PlatformEvent];
