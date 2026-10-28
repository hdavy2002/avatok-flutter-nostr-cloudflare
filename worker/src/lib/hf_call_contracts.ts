// [HF-CALL-MODES-P0] Shared TYPE contract for the call-modes / queue / chunk-billing / booking-lengths feature.
// Spec: Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md section 2.5 (endpoints) and 2.1-2.4 (semantics).
// Types and constants ONLY: no runtime behaviour, so every lane (A host mode, B queue, C money + call DO, D bookings, E clients) imports from here
// and nobody redefines a shape. Lane A owns this file after Phase 0; change it additively.

// ── host mode + public call state (spec 2.1) ────────────────────────────────────────────────────────────────────────────────────────────
/** What the INFLUENCER chose (hf_hosts.call_mode). Written only by her or by account closing. */
export type HostMode = "online" | "bookings_only" | "offline";
export const HOST_MODES: readonly HostMode[] = ["online", "bookings_only", "offline"];

/** What a FAN sees (derived by publicCallState in lib/hf_host_status.ts). */
export type PublicCallState = "available" | "on_call" | "connecting" | "queue_only" | "appointments" | "offline";

/** Legacy hf_hosts.presence value kept for every existing reader and the shipped app (always derived, never chosen). */
export type LegacyPresence = "online" | "busy" | "offline";

/** Why a fan's "Call now" was refused (the non-available PublicCallStates). */
/** [HF-INTRO-W2] adds "bookings_only": the host chose call option A, so no live call / queue spot exists (only bookings). */
export type CallRefusalReason = Exclude<PublicCallState, "available"> | "bookings_only";

/** GET/PUT /api/hosts/me/presence (PUT accepts {mode} or legacy {online:boolean}: true -> online, false -> bookings_only). */
export interface HostPresenceResponse {
  ok: true;
  presence: LegacyPresence;
  mode: HostMode;
  onCall: boolean;
  queue: { waiting: number; paused: boolean; open: boolean };
  /** [HF-CALL-MODES-A] confirmed future bookings that still ring when she picks Offline (D1: "You have N booked calls. They will still ring."). */
  bookedCalls?: number;
}
export interface HostPresenceRequest { mode?: HostMode; online?: boolean }

// ── queue (spec 2.2) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type QueueStatus = "waiting" | "offered" | "connected" | "done" | "left" | "skipped" | "expired" | "closed";
export type QueueSkipReason = "fan_no_answer" | "low_balance" | "blocked" | "host_missed" | "host_offline" | "booking_conflict";

/** One hf_call_queue row. */
export interface QueueEntry {
  id: string;
  hostUid: string;
  fanUid: string;
  seq: number;
  status: QueueStatus;
  skipReason: QueueSkipReason | null;
  hostMissCount: number;
  callId: string | null;
  joinedAt: number;
  offeredAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  waJoinAt: number | null;
  waNextAt: number | null;
}

/** POST /api/hf/hosts/:slug/queue */
export interface QueueJoinResponse { ok: true; entryId: string; position: number; waiting: number }
export type QueueJoinErrorCode = "queue_closed" | "queue_full" | "already_queued" | "low_balance" | "not_verified";
export interface QueueJoinError {
  ok?: false;
  error: QueueJoinErrorCode;
  /** low_balance: how much more the wallet needs to start (paise). */
  shortfallPaise?: number;
  /** already_queued: the host the fan is already waiting for. */
  hostSlug?: string;
}

/** GET /api/hosts/me/queue (first names only, never numbers) and PUT /api/hosts/me/queue {paused}. */
export interface HostQueueView {
  ok: true;
  waiting: number;
  paused: boolean;
  entries: Array<{ position: number; firstName: string; joinedAt: number }>;
}

/** GET /api/hf/queue/me */
export interface MyQueueResponse {
  ok: true;
  entry: null | { entryId: string; hostSlug: string; hostName: string; position: number; status: QueueStatus; callId?: string };
}

// ── POST /api/hf/calls refusal (keeps error:"host_unavailable"; spec 2.5) ───────────────────────────────────────────────────────────────
export interface CallStartRefusal {
  ok?: false;
  error: "host_unavailable";
  reason: CallRefusalReason;
  canQueue: boolean;
  canBook: boolean;
  queueWaiting: number;
}

/** How a call began; stored in hf_calls.source. */
export type CallSource = "instant" | "queue" | "booking";

/** Additions to GET /api/hf/calls/:id (spec 2.3). capAt moves as chunks are funded / topped up. */
export interface CallInfoAdditions {
  /** Epoch ms until which the call is funded. */
  fundedUntil: number | null;
  /** true while the caller's wallet cannot fund the next chunk (the caller-only whisper has played). */
  short: boolean;
  /** Epoch ms the call will end at the current funding / hard cap (moving). */
  capAt: number | null;
  source: CallSource;
}

// ── bookings (spec 2.4) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Allowed booking lengths in minutes (replaces HF_BOOKING_MINUTES when hfBookingLengthsEnabled). */
export const HF_BOOKING_LENGTHS = [15, 30, 60, 120, 180, 240, 300] as const;
export type BookingLength = (typeof HF_BOOKING_LENGTHS)[number];

/** Additive fields on booking slots / quote / app POST responses. */
export interface BookingLengthFields {
  /** Lengths the host sells (subset of HF_BOOKING_LENGTHS). */
  durationsMinutes: number[];
  /** What is held at booking time (cost of min(length, hold minutes)). */
  holdPaise: number;
  holdMinutes: number;
}
/** Columns added to hf_bookings / hf_booking_quotes. NULL on old rows: fall back to duration_min * 60. */
export interface BookingHoldColumns { hold_seconds: number | null }
/** Request side: durationMinutes absent from an old app -> 15 when hfBookingLengthsEnabled, else 10. */
export interface BookingDurationRequest { durationMinutes?: number }

// ── chunk-billing constants (spec 2.3) ────────────────────────────────────────────────────────────────────────────────────────────────
/** Defaults only; the live values come from config (hfCallChunkMinutes, hfCallMaxMinutes, hfBookingHoldMinutes). */
export const HF_CHUNK_MINUTES_DEFAULT = 5;
export const HF_CALL_MAX_MINUTES_DEFAULT = 300;
export const HF_BOOKING_HOLD_MINUTES_DEFAULT = 15;

// ── internal Durable Object messages ──────────────────────────────────────────────────────────────────────────────────────────────────
/** HfCallDO POST /funds: a wallet top-up landed mid-call; reserve any needed chunks now (idempotent). Body of pokeLiveCall. */
export interface HfCallFundsRequest { uid: string; reason: "topup" | "retry" }
export interface HfCallFundsResponse {
  ok: boolean;
  fundedSec: number;
  short: boolean;
  /** Seconds added by this call (0 when nothing needed / possible). */
  addedSec: number;
}
/** HfCallDO GET /info additions. */
export interface HfCallInfoExtra { fundedSec: number; short: boolean }

/** HfHostLineDO messages (one DO per host, idFromName(hostUid)); it serialises every queue mutation and owns break / dispatch / expiry alarms. */
export type HfHostLineMessage =
  | { op: "join"; fanUid: string; entryId: string }
  | { op: "leave"; fanUid: string; entryId?: string }
  /** Poked by HfCallDO after releaseHost. outcome tells the DO whether the host answered (D3 miss counting). */
  | { op: "line-free"; callId: string; outcome: "completed" | "fan_no_answer" | "host_missed" | "failed" }
  | { op: "mode"; mode: HostMode }
  | { op: "pause"; paused: boolean; by: "host" | "system" }
  /** 5-minute cron safety sweep (lost alarms, orphan q: locks, expiries). */
  | { op: "sweep" };
export type HfHostLineOp = HfHostLineMessage["op"];
export interface HfHostLineResponse { ok: boolean; error?: QueueJoinErrorCode | "not_implemented"; position?: number; waiting?: number }
