// Event-sourced calls — the append-only foundation (Specs/PLAN-2026-07-11-
// dialpad-business-calls-ava-voice-agent.md §13/§14). Call state is NOT a
// mutable row. Each call has a permanent `call_id`, and its life is an
// append-only event stream — the same philosophy as the ledger, messaging,
// and trust engine. Reconstructing "what happened" = replaying the events.
//
// ── IMMUTABILITY INVARIANT (write it into the code, not just the doc) ──────
// Events are immutable — append-only means append-only. Never edited, never
// deleted, only SUPERSEDED by a later event. There is no UPDATE/DELETE helper
// exported from this module on purpose — the write path physically doesn't
// expose one. A correction is a NEW event that references the old one (e.g.
// via `props.supersedes = <event row id or trace_id>`), never a mutation of
// the original row. Any consumer that thinks it needs to "fix" a past event
// is wrong — it should emit a new one.
// ─────────────────────────────────────────────────────────────────────────
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { track } from "../hooks";

/** Bump whenever a CallEvent's shape changes. Replay/consumer code decodes any
 *  historical event by the schema version IT was written with — no consumer
 *  may assume "current shape" (plan §13, invariant 2). */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * Reason codes are a versioned, stable enum — never free text (plan §14).
 * Analytics, alerts, and Guardian key off the code only; a human-readable
 * message MAY ride alongside in `props.reason_detail`. New codes are ADDED
 * here; existing codes are never renamed or reused for a different meaning.
 */
export type ReasonCode =
  | "CAL_TIMEOUT"
  | "CAL_403"
  | "CAL_429"
  | "TOOL_TIMEOUT"
  | "OAUTH_EXPIRED"
  | "NETWORK"
  | "VALIDATION"
  | "WALLET_INSUFFICIENT"
  | "GROK_SESSION_FAIL"
  | "BUSY"
  | "OFFLINE"
  | "BLOCKED"
  | "BUSINESS_HOURS"
  | "MANUAL_SEND_TO_AGENT"
  | "AGENT_AUTO"
  | "PAID_PROMPT"
  | "VOICEMAIL"
  | "RANG_OWNER"
  // Added WP4 (Ava AI Voice Agent, plan §4/§9) — a normal, non-error end of an
  // agent call (hangup, wrap-up, or the agentMaxCallSec hard cap). Distinct
  // from GROK_SESSION_FAIL (which means the agent never/stopped working) so a
  // refund-completed event can be told apart from an actual failure downstream.
  | "CALL_ENDED";

/** Registry mirror of the ReasonCode union, for runtime validation/iteration
 *  (e.g. an admin tool listing all known codes). Keep in lockstep with the
 *  type above — this is the "versioned registry" the plan calls for. */
export const REASON_CODES: readonly ReasonCode[] = [
  "CAL_TIMEOUT",
  "CAL_403",
  "CAL_429",
  "TOOL_TIMEOUT",
  "OAUTH_EXPIRED",
  "NETWORK",
  "VALIDATION",
  "WALLET_INSUFFICIENT",
  "GROK_SESSION_FAIL",
  "BUSY",
  "OFFLINE",
  "BLOCKED",
  "BUSINESS_HOURS",
  "MANUAL_SEND_TO_AGENT",
  "AGENT_AUTO",
  "PAID_PROMPT",
  "VOICEMAIL",
  "RANG_OWNER",
  "CALL_ENDED",
] as const;

/** Versions of the logic that produced this event (plan §14 "version
 *  EVERYTHING"). All optional — most events only stamp the ones that apply. */
export interface EventVersions {
  prompt_version?: string;
  agent_version?: string;
  agent_profile_version?: string;
  collection_version?: string;
  tool_manifest_version?: string;
  liveness_policy_version?: string;
  guardian_policy_version?: string;
  pricing_policy_version?: string;
  refund_policy_version?: string;
  trust_engine_version?: string;
  voice_pipeline_version?: string;
  rag_pipeline_version?: string;
}

/** Shared shape for every event on the call stream (plan §13/§14). PII never
 *  rides on the event — only IDs (`person_id`, `caller_id`, `callee_id`); PII
 *  lives once on the PostHog Person Profile, resolved via `person_id`. */
export interface CallEvent {
  /** Event name, e.g. 'call_created' | 'routing_decision' | 'call_ended' | ... */
  event: string;
  /** Business identity of the call (billing, dashboards, replay). */
  call_id: string;
  /** Distributed-debugging correlation id — every downstream action this call
   *  spawns (Grok → Composio → Calendar → Supabase → ledger → email) inherits it. */
  trace_id: string;
  /** Child span id under the trace, for an external-call event (see withSpan). */
  span_id?: string;
  person_id?: string;
  caller_id: string;
  callee_id: string;
  primary_number?: string;
  service_number?: string;
  call_mode: "friend" | "business" | "paid_human" | "paid_ai";
  billing_mode?: "A" | "B";
  agent_profile_id?: string;
  agent_profile_version?: string;
  reason?: ReasonCode;
  ts: number;
  event_schema_version: number;
  versions?: EventVersions;
  props?: Record<string, unknown>;
}

let tableEnsured = false;

/** Idempotent create — D1 has no migration runner in the request path, so this
 *  route ensures its own table (the same `ensureTable` pattern used across
 *  worker/src/routes/*.ts, e.g. agent_settings.ts). Cheap: CREATE TABLE IF NOT
 *  EXISTS is a no-op once applied. Memoized per isolate so a hot Worker doesn't
 *  re-run it on every event. */
async function ensureCallEventsTable(env: Env): Promise<void> {
  if (tableEnsured) return;
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS call_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       call_id TEXT NOT NULL,
       trace_id TEXT NOT NULL,
       event TEXT NOT NULL,
       ts INTEGER NOT NULL,
       schema_version INTEGER NOT NULL,
       json TEXT NOT NULL
     )`,
  ).run();
  await metaDb(env).prepare(
    `CREATE INDEX IF NOT EXISTS idx_call_events_call_id ON call_events (call_id)`,
  ).run();
  await metaDb(env).prepare(
    `CREATE INDEX IF NOT EXISTS idx_call_events_event ON call_events (event)`,
  ).run();
  tableEnsured = true;
}

/**
 * Append one event to the call stream. INSERT-only — there is no update/delete
 * export from this module; see the immutability invariant at the top of the
 * file. ALSO fans out to PostHog via the shared `track()` hook (hooks.ts) so
 * the same event reaches the analytics consumer without a second queue-send
 * call site. Best-effort: a telemetry/storage hiccup must never break the
 * call the event describes.
 */
export async function emitCallEvent(env: Env, ev: CallEvent): Promise<void> {
  try {
    await ensureCallEventsTable(env);
    await metaDb(env).prepare(
      `INSERT INTO call_events (call_id, trace_id, event, ts, schema_version, json)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(ev.call_id, ev.trace_id, ev.event, ev.ts, ev.event_schema_version, JSON.stringify(ev)).run();
  } catch { /* best-effort — storage hiccup must never break the call */ }

  // Fan out to PostHog. `uid` is the caller — PostHog Person resolution keys
  // off caller_id here; callee-side dashboards join on callee_id from props.
  try {
    const { props: rawProps, ...rest } = ev;
    await track(env, ev.caller_id, ev.event, "avatok", {
      ...rest,
      ...(rawProps ?? {}),
      call_id: ev.call_id,
      trace_id: ev.trace_id,
    }, ev.trace_id);
  } catch { /* best-effort */ }
}

/** Routing-policy snapshot recorded on `routing_decision` (plan §13 extends §15.3). */
export interface RoutingSnapshot {
  routing_mode: string | null;
  business_hours_version: string | null;
  blocked: boolean;
  agent_enabled: boolean;
  voicemail_enabled: boolean;
  booking_authority: "auto_write" | "confirm_with_caller" | "require_owner_approval" | null;
  concurrency_in_use: number;
}

/**
 * Thin wrapper emitting the `routing_decision` event — WHY a call went where
 * it went, with a structured `reason` and the routing-policy snapshot in
 * force at decision time (plan §13). This is the first thing support reads
 * when debugging "why did this call never ring?"
 */
export async function emitRoutingDecision(env: Env, args: {
  call_id: string;
  trace_id: string;
  caller_id: string;
  callee_id: string;
  reason: ReasonCode;
  snapshot: RoutingSnapshot;
  call_mode?: CallEvent["call_mode"];
  billing_mode?: CallEvent["billing_mode"];
}): Promise<void> {
  await emitCallEvent(env, {
    event: "routing_decision",
    call_id: args.call_id,
    trace_id: args.trace_id,
    caller_id: args.caller_id,
    callee_id: args.callee_id,
    call_mode: args.call_mode ?? "business",
    billing_mode: args.billing_mode,
    reason: args.reason,
    ts: Date.now(),
    event_schema_version: EVENT_SCHEMA_VERSION,
    props: { snapshot: args.snapshot },
  });
}

/** New call_id / trace_id — crypto.randomUUID based (Workers runtime). */
export function newTraceId(): string {
  return crypto.randomUUID();
}

/** New span_id — a child span under a trace_id (see withSpan). */
export function newSpanId(): string {
  return crypto.randomUUID();
}

/**
 * Times `fn`, emitting a `span_completed` event with `span_id`, `span_name`,
 * `latency_ms`, `ok`, and `reason` (on failure) — the "each with its own
 * start/end/latency" child-span mechanism from plan §13 (e.g. Calendar write =
 * span A, Supabase write = span B, confirmation email = span C). The span_id
 * is minted here and also stamped onto the returned promise's caller via the
 * emitted event, so a slow booking's timeline shows exactly which dependency
 * ate the time.
 */
export async function withSpan<T>(
  env: Env,
  ctx: { call_id: string; trace_id: string; caller_id: string; callee_id: string },
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const span_id = newSpanId();
  const started = Date.now();
  try {
    const result = await fn();
    await emitCallEvent(env, {
      event: "span_completed",
      call_id: ctx.call_id,
      trace_id: ctx.trace_id,
      span_id,
      caller_id: ctx.caller_id,
      callee_id: ctx.callee_id,
      call_mode: "business",
      ts: Date.now(),
      event_schema_version: EVENT_SCHEMA_VERSION,
      props: { span_name: name, latency_ms: Date.now() - started, ok: true },
    });
    return result;
  } catch (e) {
    await emitCallEvent(env, {
      event: "span_completed",
      call_id: ctx.call_id,
      trace_id: ctx.trace_id,
      span_id,
      caller_id: ctx.caller_id,
      callee_id: ctx.callee_id,
      call_mode: "business",
      reason: "TOOL_TIMEOUT",
      ts: Date.now(),
      event_schema_version: EVENT_SCHEMA_VERSION,
      props: { span_name: name, latency_ms: Date.now() - started, ok: false, error: String(e) },
    });
    throw e;
  }
}
