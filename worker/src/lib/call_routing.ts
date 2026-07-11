// Call routing engine (WP3, plan §3/§4/§12.5/§12.8/§12.10/§15.1/§15.2 of
// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// decideRouting() is the single brain that answers "where should this call
// go?" for a dialpad (business-channel) call, and WHY — every branch emits a
// `routing_decision` event (lib/call_events.ts) with a structured ReasonCode
// so "why did this call never ring?" is answered from the event stream alone,
// no log correlation needed (plan §13).
//
// REUSES, does not duplicate:
//   - lib/call_events.ts    — emitRoutingDecision / ReasonCode / RoutingSnapshot
//   - lib/call_snapshot.ts  — CallSnapshot (frozen at call_created, §15.3)
//   - lib/call_authority.ts — authorityQuery() = the existing per-account
//     call-state authority DO, used here ONLY as a read (busy detection);
//     fail-open (null → "not busy") per that module's safety contract.
//   - routes/agent_profiles.ts — Agent Profile + service-number lookups (the
//     data model WP3 also introduces). Imported here, not duplicated.
//
// Two entry points:
//   - decideRouting()        — called at `/api/call` time (plan §3 step 1-4):
//     blocked / offline / busy / business-hours / concurrency, decided
//     BEFORE any ring is sent for the cases that skip ringing entirely.
//   - decideNoAnswerRouting() — called once ringing has genuinely timed out
//     (declined / no-answer / the callee tapped "Send to Ava AI Agent") — the
//     plan §3 step 4 branches that only make sense AFTER a real ring window.
//     Mirrors how the existing Ava Receptionist flow is triggered by the
//     CLIENT calling /api/receptionist/start once it detects no-answer.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { buildCallSnapshot, type CallSnapshot } from "./call_snapshot";
import { emitRoutingDecision, type ReasonCode } from "./call_events";
import { authorityQuery, authorityEnabled } from "./call_authority";
import { resolveNumberAndProfile, type ResolvedNumber } from "../routes/agent_profiles";

// 'busy' added (plan §11/§15.1, owner decision 2026-07-11): PAID lines
// (Mode B — service numbers) never overflow to voicemail. Two variants are
// distinguished by `busy_kind` on RoutingDecisionResult: 'agents_full' (every
// AGENT_CONCURRENCY_B agent slot is in use) and 'human_busy' (a human-answered
// paid line already on a call). Mode A (primary number, free receptionist)
// keeps voicemail overflow unchanged — 'busy' is only ever returned for a
// service number.
export type RoutingAction = "ring" | "agent" | "voicemail" | "silent_noanswer" | "busy";

/** Sub-classifies a 'busy' RoutingAction — see RoutingAction doc above. */
export type BusyKind = "agents_full" | "human_busy" | null;

export interface RoutingDecisionInput {
  call_id: string;
  trace_id: string;
  caller_id: string;
  callee_id: string;
  /** The AvaTOK number actually dialed (primary or service). Optional — when
   *  omitted we assume the callee's primary/identity number (Mode A). */
  number_dialed?: string | null;
  /** 'dialpad' when placed from the Flutter dialpad (business channel). The
   *  client already sends this on /api/call; friend-channel (email/chat)
   *  calls never reach this engine. */
  via?: string | null;
  /** Known device-reachability signal, already computed by the call site
   *  (e.g. /api/call's existing tokenCount(...) > 0 check) — reused here as
   *  the OFFLINE_DETECT signal instead of re-querying push state. `undefined`
   *  = unknown, treated as reachable (fail toward ringing, never silently
   *  dead-end a call on a telemetry gap). */
  callee_reachable?: boolean;
}

export interface RoutingDecisionResult {
  action: RoutingAction;
  reason: ReasonCode;
  snapshot: CallSnapshot;
  is_service_number: boolean;
  agent_profile_id: string | null;
  concurrency_in_use: number;
  concurrency_cap: number;
  /** Set only when action === 'busy' — see BusyKind doc above. */
  busy_kind: BusyKind;
}

// ---------------------------------------------------------------------------
// Concurrency (plan §15.1): AGENT_CONCURRENCY_A = 1 (primary number agent —
// one call at a time), AGENT_CONCURRENCY_B = 5 (per service number, safe
// because every Mode-B caller escrows their own funds up front). Tracked in a
// lazily-ensured D1 table so the count is server-authoritative; WP4 (the Grok
// pipeline) INSERTs a row when an agent session actually starts and DELETEs
// it when the session ends — this module only READS the count for routing
// decisions and exposes reserve/release so WP4 doesn't need its own table.
// ---------------------------------------------------------------------------
let concurrencyTableEnsured = false;
async function ensureConcurrencyTable(env: Env): Promise<void> {
  if (concurrencyTableEnsured) return;
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS agent_active_sessions (
       call_id TEXT PRIMARY KEY,
       number_key TEXT NOT NULL,
       mode TEXT NOT NULL,
       started_at INTEGER NOT NULL
     )`,
  ).run();
  await metaDb(env).prepare(
    `CREATE INDEX IF NOT EXISTS idx_agent_active_sessions_number_key ON agent_active_sessions (number_key)`,
  ).run();
  concurrencyTableEnsured = true;
}

/** number_key convention shared with WP4: 'primary:<owner_uid>' (Mode A) or
 *  'service:<number>' (Mode B). */
export function concurrencyKeyFor(resolved: ResolvedNumber): string {
  return resolved.is_service_number ? `service:${resolved.number}` : `primary:${resolved.owner_uid}`;
}

/** Count of still-live agent sessions for a number_key. A row older than
 *  `agentMaxCallSec` (+ 30s slack for teardown) is treated as stale/leaked and
 *  excluded, so a crashed WP4 session can never wedge a number's concurrency
 *  forever. */
async function countActiveAgentSessions(env: Env, numberKey: string, agentMaxCallSec: number): Promise<number> {
  await ensureConcurrencyTable(env);
  const cutoff = Date.now() - (agentMaxCallSec + 30) * 1000;
  try {
    const r = await metaDb(env).prepare(
      "SELECT count(*) AS n FROM agent_active_sessions WHERE number_key=?1 AND started_at>?2",
    ).bind(numberKey, cutoff).first<{ n: number }>();
    return r?.n ?? 0;
  } catch { return 0; } // fail-open: a count hiccup never blocks routing
}

/** WP4 calls this the instant a Grok/agent session actually starts talking. */
export async function reserveAgentSlot(env: Env, args: { call_id: string; number_key: string; mode: "A" | "B" }): Promise<void> {
  await ensureConcurrencyTable(env);
  try {
    await metaDb(env).prepare(
      "INSERT INTO agent_active_sessions (call_id, number_key, mode, started_at) VALUES (?1,?2,?3,?4) ON CONFLICT(call_id) DO NOTHING",
    ).bind(args.call_id, args.number_key, args.mode, Date.now()).run();
  } catch { /* best-effort */ }
}

/** WP4 calls this on agent session end (any reason). */
export async function releaseAgentSlot(env: Env, call_id: string): Promise<void> {
  try { await metaDb(env).prepare("DELETE FROM agent_active_sessions WHERE call_id=?1").bind(call_id).run(); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Blocking (plan §15.2) — account-level, reuses the SAME `blocks` table
// messaging/safety.ts already writes (routes/safety.ts convBlock). Silent
// semantics live at the call site (caller sees a normal ring→no-answer card);
// this helper only answers the yes/no question.
// ---------------------------------------------------------------------------
async function isBlocked(env: Env, ownerUid: string, otherUid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare(
      "SELECT 1 AS x FROM blocks WHERE uid=?1 AND blocked_uid=?2",
    ).bind(ownerUid, otherUid).first<{ x: number }>();
    return !!r;
  } catch { return false; } // blocks table absent/schema drift → fail open (never silently drops a real call)
}

// ---------------------------------------------------------------------------
// Business hours (plan §15.1 / §12.5 business_hours + business_hours_version).
// Stored on the Agent Profile as JSON: { tz: string, windows: [{ day: 0-6,
// start: "HH:MM", end: "HH:MM" }] }. No schedule saved → always "in hours"
// (ring normally; business-hours routing is opt-in per the plan).
// ---------------------------------------------------------------------------
interface BusinessHoursWindow { day: number; start: string; end: string }
interface BusinessHoursSchedule { tz?: string; windows: BusinessHoursWindow[] }

function inBusinessHours(schedule: BusinessHoursSchedule | null): boolean {
  if (!schedule || !Array.isArray(schedule.windows) || schedule.windows.length === 0) return true;
  const now = new Date();
  // tz handling kept intentionally simple (server-UTC comparison unless a
  // fixed offset is encoded in the tz string as "+05:30"/"-08:00"); a full
  // IANA-tz evaluator is out of scope for WP3 — the schedule is still USEFUL
  // (owner picks times in their own head) and never blocks routing on error.
  let hh = now.getUTCHours(), mm = now.getUTCMinutes(), day = now.getUTCDay();
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(schedule.tz || "");
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const offMin = sign * (Number(m[2]) * 60 + Number(m[3]));
    const total = ((hh * 60 + mm + offMin) % 1440 + 1440) % 1440;
    const dayShift = Math.floor((hh * 60 + mm + offMin) / 1440);
    hh = Math.floor(total / 60); mm = total % 60;
    day = ((day + dayShift) % 7 + 7) % 7;
  }
  const nowMin = hh * 60 + mm;
  for (const w of schedule.windows) {
    if (w.day !== day) continue;
    const [sh, sm] = (w.start || "00:00").split(":").map(Number);
    const [eh, em] = (w.end || "23:59").split(":").map(Number);
    const startMin = (sh || 0) * 60 + (sm || 0), endMin = (eh || 23) * 60 + (em || 59);
    if (nowMin >= startMin && nowMin <= endMin) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// agentOrFallback — the shared "pick the agent, or fall back" decision used
// at every branch that previously did `agentEnabled && hasSlot ? agent : ...`
// (offline / busy / business-hours / no-answer / manual-send-to-agent).
// Centralized so the plan §15.1 PAID-lines-never-overflow-to-voicemail rule
// is enforced identically everywhere instead of being re-derived per branch:
// a Mode B (service) number whose AGENT_CONCURRENCY_B slots are all in use
// gets 'busy'/agents_full, never voicemail/silent. Mode A is untouched — its
// overflow (cap=1) still falls through to voicemail/silent exactly as before.
// ---------------------------------------------------------------------------
function agentOrFallback(
  resolved: ResolvedNumber,
  agentEnabled: boolean,
  hasSlot: boolean,
  voicemailEnabled: boolean,
): { action: RoutingAction; busy_kind: BusyKind } {
  if (agentEnabled && hasSlot) return { action: "agent", busy_kind: null };
  if (agentEnabled && !hasSlot && resolved.is_service_number) {
    return { action: "busy", busy_kind: "agents_full" };
  }
  if (voicemailEnabled) return { action: "voicemail", busy_kind: null };
  return { action: "silent_noanswer", busy_kind: null };
}

/** A 'busy' action always carries reason BUSY (plan §15.1 instruction),
 *  regardless of which branch produced it — the contextual reason otherwise
 *  used at that branch (OFFLINE/BUSINESS_HOURS/etc.) is dropped in favor of
 *  BUSY so "why busy?" is answered by `busy_kind`, not by re-deriving it from
 *  the branch's base reason. */
function reasonFor(fb: { action: RoutingAction }, base: ReasonCode): ReasonCode {
  return fb.action === "busy" ? "BUSY" : base;
}

// ---------------------------------------------------------------------------
// decideRouting — the pre-ring decision (plan §3 steps 1-4, §15.1, §15.2).
// ---------------------------------------------------------------------------
export async function decideRouting(env: Env, input: RoutingDecisionInput): Promise<RoutingDecisionResult> {
  const cfg = await readConfig(env);
  const resolved = await resolveNumberAndProfile(env, input.callee_id, input.number_dialed ?? null);

  // Number lifecycle (plan §15.3): a retired service number is never
  // recycled — it resolves to "service no longer available", not a normal
  // no-answer. Reuses BLOCKED's silent semantics (caller never learns why) as
  // the closest existing reason code; a dedicated NUMBER_RETIRED code can be
  // added to the registry later without breaking this call site.
  if (resolved.retired) {
    const snapshot = await buildCallSnapshot(env, { blocked: false, agent_enabled: false, voicemail_enabled: false });
    return finalize(env, cfg, input, resolved, snapshot, "silent_noanswer", "BLOCKED", 0, 0, null);
  }

  const blocked = await isBlocked(env, input.callee_id, input.caller_id);

  const agentEnabled = resolved.agent_profile != null; // Mode A/B: an Agent Profile in force = agent is a candidate
  const voicemailEnabled = cfg.voicemailBot === true;
  const schedule = resolved.agent_profile?.business_hours ?? null;
  const inHours = inBusinessHours(schedule);

  const numberKey = concurrencyKeyFor(resolved);
  const cap = resolved.is_service_number ? cfg.agentConcurrencyB : cfg.agentConcurrencyA;
  const inUse = await countActiveAgentSessions(env, numberKey, cfg.agentMaxCallSec);
  const hasSlot = inUse < cap;

  const snapshot = await buildCallSnapshot(env, {
    rate: resolved.agent_profile?.rate ?? null,
    length_options: resolved.agent_profile?.length_options ?? null,
    routing_mode: resolved.agent_profile?.routing ?? null,
    business_hours_version: resolved.agent_profile?.business_hours_version != null ? String(resolved.agent_profile.business_hours_version) : null,
    blocked,
    agent_enabled: agentEnabled,
    voicemail_enabled: voicemailEnabled,
    booking_authority: resolved.agent_profile?.booking_authority ?? null,
  });

  // 1. Blocked — silent no-answer (plan §15.2): normal ring UX, voicemail
  //    unavailable, caller never told.
  if (blocked) return finalize(env, cfg, input, resolved, snapshot, "silent_noanswer", "BLOCKED", inUse, cap, null);

  // 1b. Concurrency (plan §11/§15.1, owner decision 2026-07-11): a Mode B
  //     (service/paid) number whose AGENT_CONCURRENCY_B slots are all in use
  //     is busy right now regardless of ring/offline/hours state — there is
  //     no point ringing an AI line with zero capacity, and paid lines never
  //     overflow to voicemail. Checked ahead of offline/busy/hours so a
  //     genuinely-full agent number never dead-ends into a silent ring first.
  if (resolved.is_service_number && agentEnabled && !hasSlot) {
    return finalize(env, cfg, input, resolved, snapshot, "busy", "BUSY", inUse, cap, "agents_full");
  }

  // 2. Offline (plan §15.1 OFFLINE_DETECT): skip the ring entirely.
  if (input.callee_reachable === false) {
    const fb = agentOrFallback(resolved, agentEnabled, hasSlot, voicemailEnabled);
    return finalize(env, cfg, input, resolved, snapshot, fb.action, reasonFor(fb, "OFFLINE"), inUse, cap, fb.busy_kind);
  }

  // 3. Busy (plan §15.1): callee already on a call = decline immediately, no
  //    fake ringing. Reads the existing call-state authority DO (fail-open —
  //    a null/errored read is treated as "not busy", never as a false block).
  let busy = false;
  if (authorityEnabled(cfg as unknown as Parameters<typeof authorityEnabled>[0])) {
    try {
      const q = await authorityQuery(env, input.callee_id);
      const phase = (q?.phase as string | undefined) ?? null;
      busy = phase === "connected" || phase === "connecting";
    } catch { busy = false; }
  }
  if (busy) {
    // Mode B human-answered paid line (no AI agent configured) already on a
    // call — busy tone, no voicemail, no charge, hold released at the call
    // site (plan §11 refund matrix / §15.1). Distinguished from agents_full
    // (checked in step 1b above) by the absence of an agent profile.
    if (resolved.is_service_number && !agentEnabled) {
      return finalize(env, cfg, input, resolved, snapshot, "busy", "BUSY", inUse, cap, "human_busy");
    }
    const fb = agentOrFallback(resolved, agentEnabled, hasSlot, voicemailEnabled);
    return finalize(env, cfg, input, resolved, snapshot, fb.action, reasonFor(fb, "BUSY"), inUse, cap, fb.busy_kind);
  }

  // 4. Business hours (plan §15.1): out-of-hours = agent/voicemail
  //    immediately, no ring.
  if (!inHours) {
    const fb = agentOrFallback(resolved, agentEnabled, hasSlot, voicemailEnabled);
    return finalize(env, cfg, input, resolved, snapshot, fb.action, reasonFor(fb, "BUSINESS_HOURS"), inUse, cap, fb.busy_kind);
  }

  // 5. Concurrency overflow while otherwise ringable is NOT a routing
  //    decision by itself for Mode A — a caller still gets a normal ring;
  //    overflow only matters once the ring times out with no answer
  //    (decideNoAnswerRouting below), so a busy agent never pre-empts a live
  //    human pickup. Mode B's overflow was already handled unconditionally in
  //    step 1b above (never rings an AI line with zero capacity).
  return finalize(env, cfg, input, resolved, snapshot, "ring", "RANG_OWNER", inUse, cap, null);
}

// ---------------------------------------------------------------------------
// decideNoAnswerRouting — plan §3 step 4: once the ring has genuinely timed
// out (or the callee explicitly declined / hit "Send to Ava AI Agent"), pick
// the after-ring outcome. Called by the CLIENT once it detects the outcome —
// same trigger shape as the existing receptionistStart() (routes/receptionist.ts).
// ---------------------------------------------------------------------------
export type NoAnswerOutcome = "declined" | "no_answer" | "manual_send_to_agent";

export async function decideNoAnswerRouting(
  env: Env,
  input: RoutingDecisionInput & { outcome: NoAnswerOutcome },
): Promise<RoutingDecisionResult> {
  const cfg = await readConfig(env);
  const resolved = await resolveNumberAndProfile(env, input.callee_id, input.number_dialed ?? null);
  if (resolved.retired) {
    const snapshot = await buildCallSnapshot(env, { blocked: false, agent_enabled: false, voicemail_enabled: false });
    return finalize(env, cfg, input, resolved, snapshot, "silent_noanswer", "BLOCKED", 0, 0, null);
  }
  const blocked = await isBlocked(env, input.callee_id, input.caller_id);
  const agentEnabled = resolved.agent_profile != null;
  const voicemailEnabled = cfg.voicemailBot === true;
  const numberKey = concurrencyKeyFor(resolved);
  const cap = resolved.is_service_number ? cfg.agentConcurrencyB : cfg.agentConcurrencyA;
  const inUse = await countActiveAgentSessions(env, numberKey, cfg.agentMaxCallSec);
  const hasSlot = inUse < cap;
  const snapshot = await buildCallSnapshot(env, {
    rate: resolved.agent_profile?.rate ?? null,
    length_options: resolved.agent_profile?.length_options ?? null,
    routing_mode: resolved.agent_profile?.routing ?? null,
    booking_authority: resolved.agent_profile?.booking_authority ?? null,
    blocked, agent_enabled: agentEnabled, voicemail_enabled: voicemailEnabled,
  });

  if (blocked) return finalize(env, cfg, input, resolved, snapshot, "silent_noanswer", "BLOCKED", inUse, cap, null);

  if (input.outcome === "manual_send_to_agent") {
    // Callee explicitly tapped "Send to Ava AI Agent" on the ringing screen —
    // MANUAL_SEND_TO_AGENT always wins over AUTO/timeout semantics, but still
    // respects concurrency (Mode B overflow → busy, never voicemail; Mode A
    // overflow → voicemail, unchanged; plan §15.1).
    const fb = agentOrFallback(resolved, agentEnabled, hasSlot, voicemailEnabled);
    return finalize(env, cfg, input, resolved, snapshot, fb.action, reasonFor(fb, "MANUAL_SEND_TO_AGENT"), inUse, cap, fb.busy_kind);
  }

  if (input.outcome === "no_answer") {
    // AUTO after agentAutoanswerSec (≈2 rings) IF the owner set AUTO routing
    // on the profile; else falls straight to voicemail after ringTimeoutSec
    // (≈5 rings) — the client is the one enforcing the two different timers
    // (it calls this route at whichever timeout actually elapsed).
    const autoRouting = resolved.agent_profile?.routing === "auto";
    if (autoRouting) {
      const fb = agentOrFallback(resolved, agentEnabled, hasSlot, voicemailEnabled);
      return finalize(env, cfg, input, resolved, snapshot, fb.action, reasonFor(fb, "AGENT_AUTO"), inUse, cap, fb.busy_kind);
    }
    if (voicemailEnabled) return finalize(env, cfg, input, resolved, snapshot, "voicemail", "VOICEMAIL", inUse, cap, null);
    return finalize(env, cfg, input, resolved, snapshot, "silent_noanswer", "VOICEMAIL", inUse, cap, null);
  }

  // "declined" — the callee hit Decline, or has no agent set up (plan §3
  // step 4): straight to voicemail, never the agent (declining is an
  // explicit "not now", not a routing invitation). Not a concurrency-overflow
  // path, so the Mode B busy substitution above doesn't apply here.
  if (voicemailEnabled) return finalize(env, cfg, input, resolved, snapshot, "voicemail", "VOICEMAIL", inUse, cap, null);
  return finalize(env, cfg, input, resolved, snapshot, "silent_noanswer", "VOICEMAIL", inUse, cap, null);
}

// ---------------------------------------------------------------------------
async function finalize(
  env: Env,
  cfg: { businessCallUx: boolean },
  input: RoutingDecisionInput,
  resolved: ResolvedNumber,
  snapshot: CallSnapshot,
  action: RoutingAction,
  reason: ReasonCode,
  concurrency_in_use: number,
  concurrency_cap: number,
  busy_kind: BusyKind,
): Promise<RoutingDecisionResult> {
  const result: RoutingDecisionResult = {
    action, reason, snapshot,
    is_service_number: resolved.is_service_number,
    agent_profile_id: resolved.agent_profile?.id ?? null,
    concurrency_in_use, concurrency_cap, busy_kind,
  };
  // Emit routing_decision ALWAYS when businessCallUx is on (plan §3 deliverable).
  if (cfg.businessCallUx) {
    try {
      await emitRoutingDecision(env, {
        call_id: input.call_id,
        trace_id: input.trace_id,
        caller_id: input.caller_id,
        callee_id: input.callee_id,
        reason,
        call_mode: resolved.is_service_number ? "paid_ai" : "business",
        billing_mode: resolved.is_service_number ? "B" : "A",
        busy_kind,
        snapshot: {
          routing_mode: snapshot.routing_mode,
          business_hours_version: snapshot.business_hours_version,
          blocked: snapshot.blocked,
          agent_enabled: snapshot.agent_enabled,
          voicemail_enabled: snapshot.voicemail_enabled,
          booking_authority: snapshot.booking_authority,
          concurrency_in_use,
        },
      });
    } catch { /* best-effort — telemetry never blocks routing */ }
  }
  return result;
}
