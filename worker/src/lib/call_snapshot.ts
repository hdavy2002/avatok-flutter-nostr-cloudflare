// Rate/routing snapshot recorded on `call_created` (plan §13 "Snapshot the
// routing policy too", extends §15.3 "Rate snapshot"). At call_created we
// freeze the rate, length options, fee constants, and the entire routing
// configuration in force at that instant. ALL metering and settlement code
// downstream must read this snapshot, NEVER the live setting — otherwise a
// mid-call rate/config change could make shown-price != charged-price, or a
// replay six months later reflect today's settings instead of the ones that
// actually applied to the call.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import type { CallEvent } from "./call_events";

/** The §15.3 snapshot shape. Every field here is what settlement/replay code
 *  reads — never the live PlatformConfig / owner settings at read time. */
export interface CallSnapshot {
  rate: number | null;
  length_options: number[] | null;
  platform_fee_per_min: number;
  line_fee_per_min: number;
  routing_mode: string | null;
  business_hours_version: string | null;
  blocked: boolean;
  agent_enabled: boolean;
  voicemail_enabled: boolean;
  booking_authority: "auto_write" | "confirm_with_caller" | "require_owner_approval" | null;
}

/**
 * Assemble the snapshot at call_created time. `overrides` lets a caller pass
 * whatever per-number/Agent-Profile settings ARE already resolvable (rate,
 * length options, routing mode, business hours, block status, agent/
 * voicemail enablement, booking authority) — those data models don't exist
 * yet as of WP1, so callers pass sensible nulls/defaults until WP3/WP4 wire
 * the real lookups. Fee constants always come from the flag-overridable
 * config (never hardcoded), so a mid-rollout constant tweak is captured too.
 */
export async function buildCallSnapshot(
  env: Env,
  overrides: Partial<CallSnapshot> = {},
): Promise<CallSnapshot> {
  const cfg = await readConfig(env);
  return {
    rate: overrides.rate ?? null,
    length_options: overrides.length_options ?? null,
    platform_fee_per_min: overrides.platform_fee_per_min ?? cfg.platformFeePerMin,
    line_fee_per_min: overrides.line_fee_per_min ?? cfg.serviceLineFeePerMin,
    routing_mode: overrides.routing_mode ?? null,
    business_hours_version: overrides.business_hours_version ?? null,
    blocked: overrides.blocked ?? false,
    agent_enabled: overrides.agent_enabled ?? false,
    voicemail_enabled: overrides.voicemail_enabled ?? false,
    booking_authority: overrides.booking_authority ?? null,
  };
}

/**
 * Persist the snapshot inside the `call_created` event's props. Settlement
 * code reads it back from that event (`props.snapshot`) — never from live
 * settings. Pure helper: does not emit anything itself, so callers stay in
 * control of when/whether the event actually goes out (e.g. behind a flag).
 */
export function attachSnapshotToCallCreated(
  props: Record<string, unknown> | undefined,
  snapshot: CallSnapshot,
): Record<string, unknown> {
  return { ...(props ?? {}), snapshot };
}

/** Convenience: build a full call_created CallEvent (minus `props` extras the
 *  caller wants to add) with the snapshot already attached. */
export function callCreatedEvent(
  base: Omit<CallEvent, "event" | "event_schema_version" | "props">,
  snapshot: CallSnapshot,
  eventSchemaVersion: number,
  extraProps: Record<string, unknown> = {},
): CallEvent {
  return {
    ...base,
    event: "call_created",
    event_schema_version: eventSchemaVersion,
    props: attachSnapshotToCallCreated(extraProps, snapshot),
  };
}
