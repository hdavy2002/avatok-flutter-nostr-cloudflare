// call_fsm.ts — [AVA-CAMP-B2-FSM] CallFSM: the deterministic per-attempt state
// machine for outbound AI calling campaigns (Specs/OUTBOUND-AI-CALLING-
// CAMPAIGNS.md §2 "CallFSM owns state, not the room", §4 "Call state
// machine", §3 D1 columns for `campaign_call_attempts` + `fsm_transitions`).
//
// SERVICE BOUNDARY: this module is pure D1 + pure state-machine logic. It
// takes a `D1Database` directly (not `Env`) so every B2 caller (CampaignDO,
// webhook routes, tool-call handlers) can use it without importing the
// Worker's `Env` type or reaching through a DO. It holds no telephony/
// provider logic itself — callers decide WHEN to transition (a webhook, a
// tool result, a timer); this module only decides WHETHER the transition is
// legal and persists it.
//
// ── STATE DERIVATION (no `state` column exists on campaign_call_attempts) ──
// The migration (worker/migrations/2026-07-20-outbound-ai-calling-campaigns.sql)
// does not carry an explicit `state` column for the attempt-level FSM — the
// row's progress columns (`ring_at`, `answered_at`, `ended_at`) plus the
// terminal `outcome` column double as the state, per the task's derivation
// rule. `applyAttemptTransition` reads the CURRENT row and derives `from` as
// follows (see `deriveAttemptState`):
//   1. `outcome` is set (answered|no_answer|busy|machine|failed|canceled) AND
//      `ended_at` is set + no further in-flight signal            -> outcome
//      itself is the terminal state (or 'settled' if outcome was already
//      finalized by billing — see below).
//   2. else if `answered_at` is set                                -> 'answered'
//   3. else if `ring_at` is set                                    -> 'ringing'
//   4. else if `call_uuid` is set (dial placed, no ring webhook yet)-> 'calling'
//   5. else (fresh attempt row, no call_uuid yet)                  -> 'dial_reserved'
// `settled` is a BILLING-LIFECYCLE marker, not a call outcome, and is handled
// specially (see applyAttemptTransition): it is recorded ONLY as an
// `fsm_transitions` audit row and NEVER overwrites `outcome`. The real terminal
// outcome (answered|no_answer|busy|machine|failed|canceled) stays authoritative
// in the `outcome` column forever, because analytics §12 `call_completed`
// breaks down by that real `call_outcome`. `deriveAttemptState` therefore never
// returns `settled` from a row — settlement is a fact in the audit trail, and a
// re-applied `settled` transition (duplicate hangup webhook, §6.3 step 5) is a
// deduped no-op.
//
// This derivation is intentionally conservative: it never guesses a
// non-terminal state from a terminal `outcome`, and never guesses a terminal
// state without `outcome` being set.

export type AttemptState =
  | "dial_reserved"
  | "calling"
  | "ringing"
  | "answered"
  | "no_answer"
  | "busy"
  | "machine"
  | "failed"
  | "canceled"
  | "settled";

export type HandoverState =
  | "none"
  | "HandoverRequested"
  | "DialHuman"
  | "HumanAnswered"
  | "BridgeRequested"
  | "BridgeConfirmed"
  | "AILeaving"
  | "Completed"
  | "failed"
  | "failed_machine"
  | "caller_abandoned";

export type FsmTrigger = "webhook" | "tool" | "user" | "system";

// ---------------------------------------------------------------------------
// Allowed transitions (spec §4 "Attempt lifecycle" / "Handover sub-machine")
// ---------------------------------------------------------------------------

/** Attempt lifecycle: dial_reserved -> calling -> (answered|no_answer|busy|
 *  machine|failed|canceled) -> settled. `canceled` is reachable from any
 *  in-flight state (owner cancel / campaign cancel wrap-up, §6.6). Terminal
 *  states other than `settled` may still transition to `settled` once wallet
 *  settlement + Inbox write finalize (§6.3 step 5); `settled` itself has no
 *  further outbound edges. */
export const ATTEMPT_ALLOWED: Record<AttemptState, AttemptState[]> = {
  dial_reserved: ["calling", "canceled", "failed"],
  calling: ["ringing", "answered", "no_answer", "busy", "failed", "canceled"],
  ringing: ["answered", "no_answer", "busy", "failed", "canceled"],
  answered: ["machine", "settled", "failed"],
  no_answer: ["settled"],
  busy: ["settled"],
  machine: ["settled"],
  failed: ["settled"],
  canceled: ["settled"],
  settled: [],
};

/** Handover sub-machine (spec §4, §16 H1-H9). Every "failure" leaf
 *  (`failed` / `failed_machine` / `caller_abandoned`) is reachable from the
 *  in-flight states per the H1-H9 failure matrix:
 *   - H1 transfer API 5xx at DialHuman              -> failed
 *   - H2 BridgeRequested join-event timeout          -> failed
 *   - H3 caller hangs up during DialHuman            -> caller_abandoned
 *   - H4 human answers then hangs up pre-bridge       -> failed
 *   - H5 owner voicemail answers (AMD/whisper abort)  -> failed_machine
 *   - H6 room dies mid-handover, unrecoverable pre-bridge -> failed
 *  The AI leg never leaves before BridgeConfirmed (spec §4) — AILeaving is
 *  only reachable from BridgeConfirmed. */
export const HANDOVER_ALLOWED: Record<HandoverState, HandoverState[]> = {
  none: ["HandoverRequested"],
  HandoverRequested: ["DialHuman", "failed"],
  DialHuman: ["HumanAnswered", "failed", "failed_machine", "caller_abandoned"],
  HumanAnswered: ["BridgeRequested", "failed", "caller_abandoned"],
  BridgeRequested: ["BridgeConfirmed", "failed"],
  BridgeConfirmed: ["AILeaving"],
  AILeaving: ["Completed"],
  Completed: [],
  failed: [],
  failed_machine: [],
  caller_abandoned: [],
};

export function isTerminalAttempt(s: AttemptState): boolean {
  return (
    s === "no_answer" ||
    s === "busy" ||
    s === "machine" ||
    s === "failed" ||
    s === "canceled" ||
    s === "settled"
  );
}

/** True for handover states that admit no further outbound edges (spec §4,
 *  §16 H1-H9 failure leaves). Exported alongside `isTerminalAttempt` for
 *  callers that need to short-circuit on "handover is done, one way or
 *  another" (e.g. deciding whether to still poll for a bridge event). */
export function isTerminalHandover(s: HandoverState): boolean {
  return (
    s === "Completed" ||
    s === "failed" ||
    s === "failed_machine" ||
    s === "caller_abandoned"
  );
}

// ---------------------------------------------------------------------------
// Timeout constants (ms) — spec §4 "Timeout rules"
// ---------------------------------------------------------------------------

/** Ring timeout for the primary outbound leg (provider `ring_timeout=30`). */
export const RING_TIMEOUT_MS = 30_000;
/** Handover human-leg ring timeout. */
export const HANDOVER_RING_MS = 25_000;
/** `BridgeRequested` caller-leg join-event timeout -> `handover_failed`. */
export const BRIDGE_JOIN_TIMEOUT_MS = 25_000;
/** Conference TTL + destroy-on-single-participant. */
export const CONFERENCE_TTL_MS = 60_000;
/** AI hard cap (provider `time_limit=615s` backstop). */
export const AI_HARD_CAP_MS = 615_000;
/** Wrap-up cue fired at 8 minutes into the AI leg. */
export const WRAP_CUE_MS = 480_000;

// ---------------------------------------------------------------------------
// Row shape (subset of campaign_call_attempts we read to derive state)
// ---------------------------------------------------------------------------

interface AttemptRow {
  attempt_uuid: string;
  call_uuid: string | null;
  ring_at: number | null;
  answered_at: number | null;
  ended_at: number | null;
  outcome: string | null;
  handover_status: string | null;
}

const ATTEMPT_TERMINAL_OUTCOMES = new Set<string>([
  "no_answer",
  "busy",
  "machine",
  "failed",
  "canceled",
  "settled",
]);

/** Derive the attempt's current FSM state from its row — see the file-level
 *  comment for the full derivation rule. Exported for callers/tests that
 *  need to read "what state is this attempt in" without performing a
 *  transition. */
export function deriveAttemptState(row: AttemptRow): AttemptState {
  if (row.outcome && ATTEMPT_TERMINAL_OUTCOMES.has(row.outcome)) {
    return row.outcome as AttemptState;
  }
  if (row.answered_at) return "answered";
  if (row.ring_at) return "ringing";
  if (row.call_uuid) return "calling";
  return "dial_reserved";
}

function deriveHandoverState(row: AttemptRow): HandoverState {
  const raw = row.handover_status;
  if (!raw) return "none";
  // handover_status column comment enumerates a coarser set
  // (none|attempted|connected|failed|failed_machine|caller_abandoned) than
  // the fine-grained sub-machine states this module tracks; once this module
  // has started driving transitions it writes the fine-grained state name
  // directly into handover_status, so a value matching a HandoverState key
  // is trusted as-is. Legacy/coarse values are mapped down conservatively.
  if (raw in HANDOVER_ALLOWED) return raw as HandoverState;
  if (raw === "attempted") return "HandoverRequested";
  if (raw === "connected") return "Completed";
  if (raw === "failed") return "failed";
  if (raw === "failed_machine") return "failed_machine";
  if (raw === "caller_abandoned") return "caller_abandoned";
  return "none";
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface FsmResult {
  ok: boolean;
  from?: string;
  to?: string;
  reason?: string;
  noop?: boolean;
}

interface TransitionOpts {
  trigger: FsmTrigger;
  correlationId?: string;
  patch?: Record<string, unknown>;
}

// D1Database doesn't ship a strict TS type in every worker context here, so
// we accept the ambient Cloudflare Workers type directly (same convention as
// worker/src/do/call_state_authority.ts).
type DB = D1Database;

async function insertTransition(
  db: DB,
  attemptUuid: string,
  fromState: string | null,
  toState: string,
  trigger: FsmTrigger,
  correlationId: string | undefined
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fsm_transitions (attempt_uuid, from_state, to_state, ts, trigger, correlation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(attemptUuid, fromState, toState, Date.now(), trigger, correlationId ?? null)
    .run();
}

/** Build a `SET col1=?, col2=?, ...` fragment + bind values from a patch
 *  object, guarding against accidental primary-key overwrite. */
function buildPatchSet(
  patch: Record<string, unknown> | undefined
): { sql: string; values: unknown[] } {
  if (!patch) return { sql: "", values: [] };
  const cols = Object.keys(patch).filter((k) => k !== "attempt_uuid");
  if (cols.length === 0) return { sql: "", values: [] };
  const sql = cols.map((c) => `${c}=?`).join(", ") + ", ";
  const values = cols.map((c) => patch[c]);
  return { sql, values };
}

// ---------------------------------------------------------------------------
// applyAttemptTransition
// ---------------------------------------------------------------------------

export async function applyAttemptTransition(
  db: DB,
  attemptUuid: string,
  to: AttemptState,
  opts: { trigger: FsmTrigger; correlationId?: string; patch?: Record<string, unknown> }
): Promise<FsmResult> {
  const row = await db
    .prepare(
      `SELECT attempt_uuid, call_uuid, ring_at, answered_at, ended_at, outcome, handover_status
       FROM campaign_call_attempts WHERE attempt_uuid=?1`
    )
    .bind(attemptUuid)
    .first<AttemptRow>();

  if (!row) {
    return { ok: false, reason: "attempt_not_found" };
  }

  const from = deriveAttemptState(row);

  if (from === to) {
    // Idempotent-friendly: re-applying the same target state that already
    // holds is a no-op success, not an error (duplicate webhook delivery,
    // spec §4 "unknown/duplicate webhooks are ignored if no longer valid").
    // Patch fields, if any, are still applied so a duplicate webhook can
    // still enrich the row (e.g. a repeated `answered` webhook carrying a
    // fuller `hangup_cause_raw`) without re-auditing a transition.
    if (opts.patch && Object.keys(opts.patch).length > 0) {
      const { sql, values } = buildPatchSet(opts.patch);
      if (sql) {
        await db
          .prepare(`UPDATE campaign_call_attempts SET ${sql}attempt_uuid=attempt_uuid WHERE attempt_uuid=?`)
          .bind(...values, attemptUuid)
          .run();
      }
    }
    return { ok: true, from, to, noop: true };
  }

  const allowed = ATTEMPT_ALLOWED[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, from, to, reason: `illegal_transition:${from}->${to}` };
  }

  // The terminal state is the source of truth for "current state" per the
  // derivation rule, so `to` is always written into `outcome` when it's a
  // recognized terminal/settlement value. Non-terminal states (`calling`,
  // `ringing`, `answered`) are represented purely via the progress columns
  // (`ring_at`/`answered_at`), which callers are expected to set via
  // `opts.patch` (e.g. `{ ring_at: Date.now() }` when transitioning to
  // `ringing`) — this module does not stamp those timestamps itself because
  // it doesn't know the true provider-reported instant, only that a
  // transition was requested at import time.
  // `settled` is a BILLING-LIFECYCLE marker, not a call outcome. It must NEVER
  // overwrite `outcome` — analytics §12 `call_completed{call_outcome}` reads the
  // real terminal outcome (answered|no_answer|busy|machine|failed|canceled), so
  // that value stays authoritative in the column forever. `settled` is recorded
  // only as an `fsm_transitions` audit row (from_state = the real outcome), and
  // is idempotent via a dedupe check on an existing settled transition — the
  // settlement caller (CampaignDO.onCallEnded) may be re-entered on duplicate
  // hangup webhooks (§4 "duplicate webhooks are idempotent").
  if (to === "settled") {
    const already = await db
      .prepare(`SELECT 1 FROM fsm_transitions WHERE attempt_uuid=?1 AND to_state='settled' LIMIT 1`)
      .bind(attemptUuid)
      .first();
    if (opts.patch && Object.keys(opts.patch).length > 0) {
      const { sql, values } = buildPatchSet(opts.patch);
      if (sql) {
        await db
          .prepare(`UPDATE campaign_call_attempts SET ${sql}attempt_uuid=attempt_uuid WHERE attempt_uuid=?`)
          .bind(...values, attemptUuid)
          .run();
      }
    }
    if (already) return { ok: true, from, to, noop: true };
    await insertTransition(db, attemptUuid, from, to, opts.trigger, opts.correlationId);
    return { ok: true, from, to };
  }

  // Non-settlement terminal states (no_answer|busy|machine|failed|canceled) are
  // written into `outcome` (the derivation source of truth); non-terminal states
  // (calling|ringing|answered) live purely in the progress columns the caller
  // sets via `opts.patch` (this module never invents provider timestamps).
  const patch: Record<string, unknown> = { ...(opts.patch ?? {}) };
  if (isTerminalAttempt(to)) {
    patch.outcome = to;
    if (!("ended_at" in patch)) {
      patch.ended_at = patch.ended_at ?? Date.now();
    }
  }

  const { sql, values } = buildPatchSet(patch);
  if (sql) {
    await db
      .prepare(`UPDATE campaign_call_attempts SET ${sql}attempt_uuid=attempt_uuid WHERE attempt_uuid=?`)
      .bind(...values, attemptUuid)
      .run();
  }

  await insertTransition(db, attemptUuid, from, to, opts.trigger, opts.correlationId);

  return { ok: true, from, to };
}

// ---------------------------------------------------------------------------
// applyHandoverTransition
// ---------------------------------------------------------------------------

export async function applyHandoverTransition(
  db: DB,
  attemptUuid: string,
  to: HandoverState,
  opts: { trigger: FsmTrigger; correlationId?: string; patch?: Record<string, unknown> }
): Promise<FsmResult> {
  const row = await db
    .prepare(
      `SELECT attempt_uuid, call_uuid, ring_at, answered_at, ended_at, outcome, handover_status
       FROM campaign_call_attempts WHERE attempt_uuid=?1`
    )
    .bind(attemptUuid)
    .first<AttemptRow>();

  if (!row) {
    return { ok: false, reason: "attempt_not_found" };
  }

  const from = deriveHandoverState(row);

  if (from === to) {
    if (opts.patch && Object.keys(opts.patch).length > 0) {
      const { sql, values } = buildPatchSet(opts.patch);
      if (sql) {
        await db
          .prepare(`UPDATE campaign_call_attempts SET ${sql}attempt_uuid=attempt_uuid WHERE attempt_uuid=?`)
          .bind(...values, attemptUuid)
          .run();
      }
    }
    return { ok: true, from, to, noop: true };
  }

  const allowed = HANDOVER_ALLOWED[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, from, to, reason: `illegal_transition:${from}->${to}` };
  }

  const patch: Record<string, unknown> = { ...(opts.patch ?? {}), handover_status: to };
  const { sql, values } = buildPatchSet(patch);
  await db
    .prepare(`UPDATE campaign_call_attempts SET ${sql}attempt_uuid=attempt_uuid WHERE attempt_uuid=?`)
    .bind(...values, attemptUuid)
    .run();

  await insertTransition(db, attemptUuid, from, to, opts.trigger, opts.correlationId);

  return { ok: true, from, to };
}
