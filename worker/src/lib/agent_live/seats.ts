// [AGENT-LIVE-1] Typed RPC client for `AgentSeatAuthorityDO`
// (worker/src/do/agent_seat_authority.ts). Every other workstream calls the
// seat authority ONLY through `seatAuthority(env)` — never construct the DO
// stub directly, so the wire contract stays in one place.
//
// BUILD SPEC §4 D8 + §11 M5 (binding). Single global instance, `idFromName
// ('global')`. RPC is JSON over `fetch`, `POST https://seat/<op>`.
import type { Env } from "../../types";

function stub(env: Env): DurableObjectStub {
  return env.AGENT_SEAT_AUTHORITY.get(env.AGENT_SEAT_AUTHORITY.idFromName("global"));
}

async function call<T>(env: Env, op: string, body: Record<string, unknown>): Promise<T> {
  const res = await stub(env).fetch(`https://seat/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type SeatReserveResult =
  | { ok: true; token: string; startMs: number; endMs: number }
  | { ok: false; reason: "seat_taken" | "bad_request"; nextFreeAt?: number };

export type SeatConfirmResult =
  | { ok: true; startMs: number; endMs: number }
  | { ok: false; reason: string; nextFreeAt?: number };

export type SeatSimpleResult = { ok: true } | { ok: false; reason: string };

export interface SeatReservationSnapshot {
  bookingId: string;
  agentId: string;
  buyerUid: string;
  state: "provisional" | "confirmed" | "active" | "released" | "expired" | "aborted";
  startMs: number;
  endMs: number;
  fence: number;
  providerUncertain: boolean;
  providerExpiresAt: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
}

export type SeatGetReservationResult =
  | { ok: true; reservation: SeatReservationSnapshot }
  | { ok: false; reason: string };

export type SeatLeaseResult =
  | { ok: true; fence: number; startMs: number; endMs: number }
  | { ok: false; reason: "not_confirmed" | "provider_uncertain" | "expired" | "bad_request" };

export type SeatHeartbeatResult = { ok: true; endMs: number } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SeatAuthorityClient {
  /** Provisional hold (5-min TTL) against both the per-agent and platform
   * caps for `[startMs, endMs)`. Idempotent on `(bookingId, requestHash)` —
   * a different hash for an existing booking id is rejected. `revision`
   * (optional) should be the listing's `persona_version` per M5. */
  reserveProvisional(input: {
    bookingId: string;
    agentId: string;
    buyerUid: string;
    requestHash: string;
    startMs: number;
    endMs: number;
    agentCap: number;
    platformCap: number;
    revision?: number;
  }): Promise<SeatReserveResult>;

  /** Commits a provisional reservation after a successful wallet hold.
   * `instant:true` rebases the interval to confirmation time and re-checks
   * the whole interval (M5) — the returned `{startMs,endMs}` is
   * authoritative; callers must use it for D1/room/response, not their own
   * copy. */
  confirm(input: {
    bookingId: string;
    token: string;
    instant: boolean;
    agentCap?: number;
    platformCap?: number;
  }): Promise<SeatConfirmResult>;

  /** Terminal — blocks any later `confirm` for this booking id (M5). Safe
   * to call on a booking that was never reserved (installs a tombstone). */
  abort(input: { bookingId: string }): Promise<SeatSimpleResult>;

  /** Read-only snapshot of a reservation row, or `{ok:false}` if none exists. */
  getReservation(input: { bookingId: string }): Promise<SeatGetReservationResult>;

  /** Pre-runtime release (cancel, failed hold) — no lease credential needed;
   * only trusted internal (checkout/money) callers should reach this. */
  release(input: { bookingId: string; reason: string }): Promise<SeatSimpleResult>;

  /** Acquire (or idempotently re-acquire, same owner) the runtime lease for
   * an already-confirmed reservation whose window has opened. Refused while
   * a prior generation's provider close is unconfirmed
   * (`reason:'provider_uncertain'`, M5). */
  acquireLease(input: { bookingId: string; owner: string }): Promise<SeatLeaseResult>;

  /** Extends the lease to `min(now + 90_000, endMs)`. Requires the current
   * fence from `acquireLease`/the last successful heartbeat. */
  heartbeat(input: { bookingId: string; fence: number }): Promise<SeatHeartbeatResult>;

  /** Ends the runtime lease. `providerClosed:false` flags the row
   * `provider_uncertain` so it keeps occupying capacity past `endMs` until
   * either a later `providerClosed` call or `provider_expires_at` (default
   * now + 60 min) — M5, replacing R2's separate quarantine table. */
  releaseRuntime(input: {
    bookingId: string;
    fence: number;
    providerClosed: boolean;
    reason: string;
  }): Promise<SeatSimpleResult>;

  /** Later confirmation that an uncertain provider did in fact close —
   * clears `provider_uncertain` and frees the seat immediately. */
  providerClosed(input: { bookingId: string; fence: number }): Promise<SeatSimpleResult>;

  /** Earliest fit at or after `fromMs` (advisory — only `reserveProvisional`
   * promises a seat), bounded to the next 30 days. */
  nextFreeStart(input: {
    agentId: string;
    minutes: number;
    fromMs: number;
    agentCap: number;
    platformCap: number;
  }): Promise<{ startMs: number } | { ok: false; reason: string }>;

  /** Grid-aligned free starts within `[dayStartMs, dayEndMs)`, ≤ 288 cells. */
  freeStarts(input: {
    agentId: string;
    minutes: number;
    dayStartMs: number;
    dayEndMs: number;
    gridMs: number;
    agentCap: number;
    platformCap: number;
  }): Promise<{ starts: number[] } | { ok: false; reason: string }>;

  /** Count of reservations currently occupying capacity, optionally scoped
   * to one agent. */
  activeCount(input?: { agentId?: string }): Promise<{ count: number }>;

  /** Installs the current platform cap/revision for bookkeeping. Per-call
   * `agentCap`/`platformCap` on every other method remain authoritative — a
   * lower revision than the one on file is ignored. */
  applyPolicy(input: { platformCap: number; revision: number }): Promise<SeatSimpleResult>;
}

/** The one seat authority client — every workstream imports this, never the
 * DO stub directly. */
export function seatAuthority(env: Env): SeatAuthorityClient {
  return {
    reserveProvisional: (input) => call(env, "reserveProvisional", input),
    confirm: (input) => call(env, "confirm", input),
    abort: (input) => call(env, "abort", input),
    getReservation: (input) => call(env, "getReservation", input),
    release: (input) => call(env, "release", input),
    acquireLease: (input) => call(env, "acquireLease", input),
    heartbeat: (input) => call(env, "heartbeat", input),
    releaseRuntime: (input) => call(env, "releaseRuntime", input),
    providerClosed: (input) => call(env, "providerClosed", input),
    nextFreeStart: (input) => call(env, "nextFreeStart", input),
    freeStarts: (input) => call(env, "freeStarts", input),
    activeCount: (input) => call(env, "activeCount", input ?? {}),
    applyPolicy: (input) => call(env, "applyPolicy", input),
  };
}
