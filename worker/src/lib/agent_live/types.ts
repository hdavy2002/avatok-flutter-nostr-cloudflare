// [AGENT-LIVE-1] Shared types + constants for AI voice agent listings on
// GPT-Live-1. Every other agent_live module imports from here — see
// Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md (the "BUILD SPEC") §1/§2/§3/§9
// and Specs/codex-rounds/round2-astra.md ("R2") §1-§3 for the detailed design
// this mirrors. This file is WS-A owned; do not edit outside that workstream.
import type { Env } from "../../types";

// ---------------------------------------------------------------------------
// Voices (BUILD SPEC §3 admin voices list)
// ---------------------------------------------------------------------------

export interface AgentVoiceOption {
  id: string;
  label: string;
}

export const AGENT_LIVE_VOICES: readonly AgentVoiceOption[] = [
  { id: "quartz", label: "Quartz" },
  { id: "ripple", label: "Ripple" },
  { id: "vesper", label: "Vesper" },
  { id: "willow", label: "Willow" },
  { id: "stone", label: "Stone" },
  { id: "gleam", label: "Gleam" },
  { id: "meridian", label: "Meridian" },
  { id: "bossa", label: "Bossa" },
  { id: "tempo", label: "Tempo" },
  { id: "beacon", label: "Beacon" },
  { id: "delta", label: "Delta" },
  { id: "cinder", label: "Cinder" },
] as const;

export type AgentVoiceId = (typeof AGENT_LIVE_VOICES)[number]["id"];

// ---------------------------------------------------------------------------
// Constants (D1-D12, §1, §2)
// ---------------------------------------------------------------------------

/** Slot lengths (minutes) allowed on the 5-min grid — D9. */
export const DEFAULT_SLOT_MINUTES: readonly number[] = [5, 10, 20, 30, 40, 60];

/** Frozen onto every booking (`agent_live_bookings.policy_version`) — D7. */
export const AGENT_LIVE_POLICY_VERSION = "agent-live-v2" as const;

/** Platform fee on a full charge, in basis points (20%) — D7. */
export const PLATFORM_FEE_BPS = 2000;

/** Seat authority: provisional reservation expiry — D8. */
export const PROVISIONAL_TTL_MS = 5 * 60_000;

/** Seat authority: active lease heartbeat cadence — D8. */
export const LEASE_HEARTBEAT_MS = 30_000;

/** Seat authority: reconnect grace before a lease is treated as lost — D8. */
export const RECONNECT_GRACE_MS = 45_000;

/** Slot/availability grid granularity — D9. */
export const SLOT_GRID_MS = 5 * 60_000;

/** Max photos a customer may share in one talk session — R2 §6.1. */
export const MAX_IMAGES_PER_SESSION = 6;

/** Max bytes per shared photo — R2 §6.1. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Max bytes per knowledge-base file — D5. */
export const MAX_KB_FILE_BYTES = 25 * 1024 * 1024;

/** Max knowledge-base files per agent — D5. */
export const MAX_KB_FILES = 50;

/** `listings`/ledger order id for a booking — 'agl_<bookingId>'. */
export function agentOrderId(bookingId: string): string {
  return `agl_${bookingId}`;
}

/** Deterministic wallet-hold opId for a booking — D7. */
export function holdOpId(bookingId: string): string {
  return `agentlive:hold:${bookingId}`;
}

/** Deterministic wallet-refund opId for a booking (the ONE id for every
 * full-refund outcome on the booking — R2 §2.3). */
export function refundOpId(bookingId: string): string {
  return `agentlive:refund:${bookingId}`;
}

// ---------------------------------------------------------------------------
// D1 row types — mirror worker/migrations/2026-09-12-agent-live.sql (§1)
// ---------------------------------------------------------------------------

export interface AgentLiveAgentRow {
  listing_id: string;
  owner_uid: string;
  persona_kind: string;
  voice: string;
  language: string;
  greeting: string | null;
  instructions: string;
  backend_instructions: string;
  image_instructions: string;
  live_model: string;
  backend_model: string;
  price_per_min: number;
  slot_minutes: string;
  max_concurrent: number;
  image_reading: number; // 0|1
  memory_enabled: number; // 0|1
  adults_only: number; // 0|1
  vector_store_id: string | null;
  persona_version: number;
  created_at: number;
  updated_at: number;
}

export type AgentLiveBookingStatus =
  | "pending"
  | "booked"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentLiveMoneyState =
  | "none"
  | "hold_pending"
  | "held"
  | "refund_pending"
  | "refunded"
  | "release_pending"
  | "released"
  | "needs_attention";

/** Checkout recovery phases (§11 M2, WS-D). `runAgentLiveSweeps` resumes any
 * booking stuck in `reserved|hold_pending|held|confirm_pending` past a short
 * timeout, WITHOUT a browser — this is what makes that possible: the phase
 * durably records exactly how far checkout got before the crash. */
export type AgentLiveCheckoutPhase =
  | "quoted"
  | "reserved"
  | "hold_pending"
  | "held"
  | "confirm_pending"
  | "booked"
  | "aborted";

export interface AgentLiveBookingRow {
  id: string;
  agent_id: string;
  buyer_uid: string;
  buyer_email: string | null;
  buyer_tz: string | null;
  starts_at: number;
  ends_at: number;
  minutes: number;
  price_per_min: number;
  amount: number;
  beneficiary_uid: string;
  persona_version: number;
  policy_version: string;
  order_id: string;
  idempotency_key: string | null;
  request_hash: string | null;
  status: AgentLiveBookingStatus;
  money_state: AgentLiveMoneyState;
  instant: number; // 0|1
  is_test: number; // 0|1
  join_token_hash: string | null;
  created_at: number;
  updated_at: number;
  /** §11 M2 (WS-D) — checkout recovery. */
  checkout_phase: AgentLiveCheckoutPhase;
  /** Signed AgentQuote JSON as verified at `book` time, for recovery replay. */
  quote_json: string | null;
  /** Frozen `AgentLiveAgentRow` JSON at checkout time (`persona_snapshot_json`
   * in the migration — the agent's config as the buyer saw/paid for it). */
  persona_snapshot_json: string;
}

export interface AgentLiveSessionRow {
  id: string;
  booking_id: string;
  agent_id: string;
  buyer_uid: string;
  session_generation: number;
  provider_session_id: string | null;
  provider_started_at: number | null;
  customer_first_attached_at: number | null;
  last_heartbeat_at: number | null;
  ended_at: number | null;
  end_reason: EndReason | null;
  billed_seconds: number;
  images_count: number;
  tool_calls: number;
  transcript_r2_key: string | null;
  usage_json: string | null;
  evidence_json: string | null;
  // §11 M8 (WS-E2 owns this field): erasure generation this session row was
  // created/last active under — lets the room and memory jobs detect a
  // Forget-me that happened mid- or post-session.
  erasure_generation: number;
  created_at: number;
  updated_at: number;
}

export interface AgentLiveDecisionRow {
  booking_id: string;
  outcome: DecisionOutcome;
  reason: string | null;
  amount: number;
  refund_amount: number;
  release_gross: number;
  fee: number;
  net: number;
  beneficiary_uid: string;
  decision_hash: string;
  decided_at: number;
}

export type AgentLiveMoneyJobKind = "refund" | "release";
export type AgentLiveMoneyJobState = "pending" | "running" | "done" | "needs_attention";

export interface AgentLiveMoneyJobRow {
  id: string;
  booking_id: string;
  kind: AgentLiveMoneyJobKind;
  state: AgentLiveMoneyJobState;
  attempts: number;
  next_attempt_at: number;
  lock_token: string | null;
  lock_until: number | null;
  last_error: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentLiveMemoryRow {
  agent_id: string;
  buyer_uid: string;
  display_name: string | null;
  summary: string;
  facts_json: string;
  open_threads_json: string;
  timezone: string | null;
  sessions_count: number;
  last_seen_at: number | null;
  version: number;
  erasure_generation: number;
  memory_enabled: number; // 0|1
  updated_at: number;
}

export type AgentLiveKbFileStatus = "uploaded" | "indexing" | "indexed" | "failed" | "deleted";

export interface AgentLiveKbFileRow {
  id: string;
  agent_id: string;
  name: string;
  mime: string;
  bytes: number;
  content_sha256: string;
  r2_key: string;
  openai_file_id: string | null;
  status: AgentLiveKbFileStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type AgentLiveImageStatus = "analyzing" | "ready" | "failed";

export interface AgentLiveImageRow {
  id: string;
  session_id: string;
  booking_id: string;
  r2_key: string;
  status: AgentLiveImageStatus;
  analysis: string | null;
  error: string | null;
  // §11 M8 (WS-E2 owns these fields): client idempotency key (UNIQUE with
  // session_id — a retried upload of the same photo returns the prior result
  // instead of consuming another image slot), the session/erasure generation
  // the image was accepted under, and the vision-analysis attempt revision.
  client_upload_id: string;
  session_generation: number;
  erasure_generation: number;
  analysis_revision: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Quote (R2 §2.2)
// ---------------------------------------------------------------------------

export interface AgentQuote {
  quoteId: string;
  buyerUid: string;
  agentId: string;
  minutes: number;
  instant: boolean;
  scheduledStartMs: number | null;
  pricePerMin: number;
  amount: number;
  beneficiaryUid: string;
  feeBps: 2000;
  personaVersion: number;
  policyVersion: "agent-live-v2";
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Settlement (D7 / R2 §2.4)
// ---------------------------------------------------------------------------

export type DecisionOutcome =
  | "completed_full"
  | "no_show"
  | "cancelled_by_customer_early"
  | "refunded_platform_failure";

export type EndReason =
  | "slot_complete"
  | "customer_end"
  | "disconnect_timeout"
  | "provider_error"
  | "capacity"
  | "platform_error"
  | "emergency_stop"
  | "no_show";

// ---------------------------------------------------------------------------
// Browser <-> DO envelope (R2 §3.2)
// ---------------------------------------------------------------------------

export type BrowserControl =
  | { v: 1; type: "hello"; connectionGeneration: number; timezone: string; lastServerSeq: number }
  | { v: 1; type: "mute"; connectionGeneration: number; muted: boolean }
  | { v: 1; type: "ping"; connectionGeneration: number; id: string }
  | {
      v: 1;
      type: "playback";
      connectionGeneration: number;
      playedSamples: number;
      queuedSamples: number;
    }
  | { v: 1; type: "end"; connectionGeneration: number; permanent: true };

export type RoomControl =
  | {
      v: 1;
      type: "ready";
      seq: number;
      connectionGeneration: number;
      sessionGeneration: number;
      sampleRate: 24000;
      channels: 1;
      format: "pcm16le";
      startsAt: number;
      endsAt: number;
      serverNow: number;
    }
  | {
      v: 1;
      type: "caption";
      seq: number;
      connectionGeneration: number;
      speaker: "customer" | "agent";
      delta: string;
      startMs: number;
      endMs: number;
    }
  | {
      v: 1;
      type: "timer";
      seq: number;
      connectionGeneration: number;
      serverNow: number;
      endsAt: number;
      remainingMs: number;
    }
  | {
      v: 1;
      type: "image_ack";
      seq: number;
      connectionGeneration: number;
      imageId: string;
      status: "accepted" | "analyzing" | "ready" | "failed";
      code?: string;
    }
  | { v: 1; type: "playback_clear"; seq: number; connectionGeneration: number }
  | { v: 1; type: "pong"; seq: number; connectionGeneration: number; id: string }
  | {
      v: 1;
      type: "ended";
      seq: number;
      connectionGeneration: number;
      reason: EndReason;
      money: "full_charge" | "refund_pending" | "refunded";
    };

// ---------------------------------------------------------------------------
// Function tools (D3)
// ---------------------------------------------------------------------------

export type AgentToolName =
  | "search_knowledge"
  | "remember_fact"
  | "get_customer_time"
  | "describe_shared_image";

// ---------------------------------------------------------------------------
// Dispatcher handler contract (BUILD SPEC §9 "Dispatcher contract")
// ---------------------------------------------------------------------------

export type AgentLiveHandler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response>;
