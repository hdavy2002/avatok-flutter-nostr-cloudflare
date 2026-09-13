// [AGENT-LIVE-1] Single global seat/capacity authority for AI voice agent
// listings — the only thing allowed to admit a booking against BOTH the
// per-agent cap and the platform cap (BUILD SPEC §4 D8, Specs/codex-rounds/
// round2-astra.md §1.2-1.6 for the detailed algorithm this mirrors).
//
// v1 simplification (BUILD SPEC §0 "v1 simplifications over R2" + §11 M5,
// BINDING): no separate outbox table (the room/D1 projection is written by
// the caller, not by this DO) and no separate quarantine table — a released
// runtime lease whose provider close could not be confirmed is represented
// on the SAME reservation row via `provider_uncertain`/`provider_expires_at`
// instead of a second table. Everything else (boundary-sweep admission
// against both caps, alarms, lease fencing) follows R2 §1.2-1.6.
//
// Single instance: `env.AGENT_SEAT_AUTHORITY.get(idFromName('global'))`.
// RPC = JSON over `fetch`, `POST https://seat/<op>` — see `seats.ts` for the
// typed client every other workstream imports.
import type { Env } from "../types";
import { track } from "../hooks";
import { PROVISIONAL_TTL_MS } from "../lib/agent_live/types";

// ---------------------------------------------------------------------------
// Constants (M5 binding overrides some R2 numbers — see the constants file)
// ---------------------------------------------------------------------------

/** M5: lease TTL is 90s (vs 30s heartbeat cadence, `LEASE_HEARTBEAT_MS`). */
const LEASE_TTL_MS = 90_000;
/** Alarm sweep cadence. */
const ALARM_TICK_MS = 60_000;
/** M5: default provider_expires_at horizon when a runtime release cannot
 * confirm the upstream provider actually closed. */
const PROVIDER_UNCERTAIN_DEFAULT_MS = 60 * 60_000;
/** Availability horizon for nextFreeStart/freeStarts (R2 §1.6). */
const AVAILABILITY_HORIZON_MS = 30 * 24 * 60 * 60_000;
/** freeStarts cell cap (BUILD SPEC §4). */
const MAX_FREE_START_CELLS = 288;
/** reserveProvisional: max outstanding provisional reservations per buyer (R2 §1.4). */
const MAX_PROVISIONAL_PER_BUYER = 2;
/** Field-length guard for ids passed across the RPC boundary. */
const MAX_ID_LEN = 128;

type ReservationState =
  | "provisional"
  | "confirmed"
  | "active"
  | "released"
  | "expired"
  | "aborted";

interface ReservationRow {
  booking_id: string;
  agent_id: string;
  buyer_uid: string;
  request_hash: string;
  start_ms: number;
  end_ms: number;
  state: ReservationState;
  token: string;
  fence: number;
  expires_at: number;
  agent_cap_snapshot: number;
  platform_cap_snapshot: number;
  policy_revision: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_heartbeat_at: number | null;
  provider_uncertain: number; // 0|1
  provider_expires_at: number | null;
  released_at: number | null;
  release_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface Interval {
  bookingId: string;
  agentId: string;
  startMs: number;
  endMs: number;
}

// ---------------------------------------------------------------------------
// Response shapes (mirrors the seats.ts client contract exactly)
// ---------------------------------------------------------------------------

type ReserveResult =
  | { ok: true; token: string; startMs: number; endMs: number }
  | { ok: false; reason: "seat_taken" | "bad_request"; nextFreeAt?: number };

type ConfirmResult =
  | { ok: true; startMs: number; endMs: number }
  | { ok: false; reason: string; nextFreeAt?: number };

type LeaseResult =
  | { ok: true; fence: number; startMs: number; endMs: number }
  | { ok: false; reason: "not_confirmed" | "provider_uncertain" | "expired" | "bad_request" };

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ ok: false, reason: "bad_request", error: msg }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function jsonOut(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN;
}
function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}
function isPositiveInt(v: unknown): v is number {
  return isFiniteInt(v) && v > 0;
}

export class AgentSeatAuthorityDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_live_reservations (
        booking_id             TEXT PRIMARY KEY,
        agent_id               TEXT NOT NULL,
        buyer_uid              TEXT NOT NULL,
        request_hash           TEXT NOT NULL,
        start_ms               INTEGER NOT NULL,
        end_ms                 INTEGER NOT NULL,
        state                  TEXT NOT NULL,
        token                  TEXT NOT NULL,
        fence                  INTEGER NOT NULL DEFAULT 1,
        expires_at             INTEGER NOT NULL,
        agent_cap_snapshot     INTEGER NOT NULL,
        platform_cap_snapshot  INTEGER NOT NULL,
        policy_revision        INTEGER NOT NULL,
        lease_owner            TEXT,
        lease_expires_at       INTEGER,
        last_heartbeat_at      INTEGER,
        provider_uncertain     INTEGER NOT NULL DEFAULT 0,
        provider_expires_at    INTEGER,
        released_at            INTEGER,
        release_reason         TEXT,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_live_resv_window ON agent_live_reservations(state, start_ms, end_ms)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_live_resv_agent ON agent_live_reservations(agent_id, state, start_ms, end_ms)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_live_resv_expiry ON agent_live_reservations(state, expires_at)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_live_resv_lease ON agent_live_reservations(lease_expires_at)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_live_resv_buyer ON agent_live_reservations(buyer_uid, state)",
    );

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_live_seat_policy (
        singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
        platform_cap INTEGER NOT NULL,
        revision     INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )
    `);
    // Per-agent cap on file (BUILD SPEC §11 M5 "Caps": the caller passes the
    // listing's persona_version as revision on each call). Tracked so a
    // caller replaying a stale, larger cap after the agent's cap was reduced
    // (an old cached quote, a race with an admin edit) cannot admit past the
    // real current cap.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_live_agent_caps (
        agent_id   TEXT PRIMARY KEY,
        cap        INTEGER NOT NULL,
        revision   INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Ensure the 60s sweep alarm is (and stays) armed even if this DO
    // instance was just created with no activity yet — alarm() re-arms
    // itself on every fire, so this only needs to prime the very first one.
    state.blockConcurrencyWhile(async () => {
      const current = await state.storage.getAlarm();
      if (current == null) await state.storage.setAlarm(Date.now() + ALARM_TICK_MS);
    });
  }

  // -------------------------------------------------------------------------
  // fetch() — JSON-over-fetch RPC dispatch. POST https://seat/<op>.
  // -------------------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    let op: string;
    try {
      op = new URL(req.url).pathname.replace(/^\/+/, "");
    } catch {
      return badRequest("bad url");
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return badRequest("bad json");
    }
    if (!body || typeof body !== "object") return badRequest("bad body");

    try {
      switch (op) {
        case "reserveProvisional":
          return jsonOut(this.reserveProvisional(body));
        case "confirm":
          return jsonOut(this.confirm(body));
        case "abort":
          return jsonOut(this.abort(body));
        case "getReservation":
          return jsonOut(this.getReservation(body));
        case "release":
          return jsonOut(this.release(body));
        case "acquireLease":
          return jsonOut(this.acquireLease(body));
        case "heartbeat":
          return jsonOut(this.heartbeat(body));
        case "releaseRuntime":
          return jsonOut(this.releaseRuntime(body));
        case "providerClosed":
          return jsonOut(this.providerClosedOp(body));
        case "nextFreeStart":
          return jsonOut(this.nextFreeStart(body));
        case "freeStarts":
          return jsonOut(this.freeStarts(body));
        case "activeCount":
          return jsonOut(this.activeCount(body));
        case "applyPolicy":
          return jsonOut(this.applyPolicy(body));
        default:
          return badRequest(`unknown op: ${op}`);
      }
    } catch (e) {
      console.warn("[AgentSeatAuthorityDO] op failed:", op, String(e));
      return jsonOut({ ok: false, reason: "bad_request" }, 500);
    }
  }

  // -------------------------------------------------------------------------
  // Alarm — expires provisional reservations & stale leases every 60s.
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    this.state.storage.transactionSync(() => {
      this.sweepExpirations(Date.now());
    });
    await this.armAlarm();
  }

  private async armAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_TICK_MS);
  }

  /** Lazy + alarm-driven expiry: provisional TTL, lease TTL (-> provider_uncertain),
   * and uncertain-provider TTL. Must run inside a transactionSync (or the alarm,
   * which already wraps this). No I/O / await inside. */
  private sweepExpirations(now: number): void {
    // 1. Provisional reservations past their 5-min deadline never confirmed.
    this.sql.exec(
      "UPDATE agent_live_reservations SET state='expired', updated_at=?1 WHERE state='provisional' AND expires_at<?1",
      now,
    );

    // 2. Confirmed/active reservations whose lease has gone stale (no
    // heartbeat within LEASE_TTL_MS) and whose room never called
    // releaseRuntime: we cannot know whether the provider actually stopped,
    // so flag provider_uncertain and keep occupying until provider_expires_at
    // (M5) rather than silently freeing the seat.
    const staleLeases = this.sql
      .exec(
        "SELECT booking_id FROM agent_live_reservations WHERE state='active' AND lease_expires_at IS NOT NULL AND lease_expires_at<?1 AND provider_uncertain=0",
        now,
      )
      .toArray() as any[];
    for (const row of staleLeases) {
      this.sql.exec(
        `UPDATE agent_live_reservations
         SET provider_uncertain=1, provider_expires_at=?2, lease_owner=NULL, lease_expires_at=NULL, updated_at=?3
         WHERE booking_id=?1`,
        String(row.booking_id),
        now + PROVIDER_UNCERTAIN_DEFAULT_MS,
        now,
      );
      void track(this.env, "server", "agent_seat_lease_expired", "avatok-api", {
        booking_id: String(row.booking_id),
      });
    }

    // 3. Uncertain-provider rows whose horizon has fully elapsed: capacity is
    // reclaimed unconditionally (M5 default 60 min).
    const clearedUncertain = this.sql
      .exec(
        "SELECT booking_id FROM agent_live_reservations WHERE provider_uncertain=1 AND provider_expires_at IS NOT NULL AND provider_expires_at<?1",
        now,
      )
      .toArray() as any[];
    for (const row of clearedUncertain) {
      void track(this.env, "server", "agent_seat_provider_uncertain_expired", "avatok-api", {
        booking_id: String(row.booking_id),
      });
    }
    this.sql.exec(
      "UPDATE agent_live_reservations SET provider_uncertain=0, provider_expires_at=NULL, state='expired', updated_at=?1 WHERE provider_uncertain=1 AND provider_expires_at IS NOT NULL AND provider_expires_at<?1",
      now,
    );
  }

  // -------------------------------------------------------------------------
  // Occupancy — the boundary-sweep admission algorithm (R2 §1.3).
  // -------------------------------------------------------------------------

  /** All rows that currently occupy capacity (as of `now`), expressed as the
   * interval they occupy. A provider-uncertain row occupies the union of its
   * booked interval and its uncertainty window (M5 in place of a quarantine
   * table); everything else occupies exactly `[start_ms, end_ms)`. */
  private occupyingIntervals(now: number, excludeBookingId?: string): Interval[] {
    const rows = this.sql
      .exec(
        `SELECT booking_id, agent_id, start_ms, end_ms, provider_uncertain, provider_expires_at
         FROM agent_live_reservations
         WHERE (state IN ('provisional','confirmed','active') AND (state!='provisional' OR expires_at>=?1))
            OR (provider_uncertain=1 AND provider_expires_at IS NOT NULL AND provider_expires_at>=?1)`,
        now,
      )
      .toArray() as any[];
    const out: Interval[] = [];
    for (const r of rows) {
      const bookingId = String(r.booking_id);
      if (excludeBookingId && bookingId === excludeBookingId) continue;
      const startMs = Number(r.start_ms);
      let endMs = Number(r.end_ms);
      if (Number(r.provider_uncertain) === 1 && r.provider_expires_at != null) {
        endMs = Math.max(endMs, Number(r.provider_expires_at));
      }
      out.push({ bookingId, agentId: String(r.agent_id), startMs, endMs });
    }
    return out;
  }

  private static peak(rows: Interval[], s: number, e: number): number {
    const events: Array<{ t: number; delta: -1 | 1 }> = [];
    for (const r of rows) {
      const a = Math.max(s, r.startMs);
      const b = Math.min(e, r.endMs);
      if (a >= b) continue;
      events.push({ t: a, delta: 1 }, { t: b, delta: -1 });
    }
    events.sort((a, b) => a.t - b.t || a.delta - b.delta);
    let current = 0;
    let maximum = 0;
    for (const ev of events) {
      current += ev.delta;
      maximum = Math.max(maximum, current);
    }
    return maximum;
  }

  private fits(
    rows: Interval[],
    agentId: string,
    s: number,
    e: number,
    agentCap: number,
    platformCap: number,
  ): boolean {
    if (!(platformCap > 0) || !(agentCap > 0)) return false;
    if (AgentSeatAuthorityDO.peak(rows, s, e) + 1 > platformCap) return false;
    const agentRows = rows.filter((r) => r.agentId === agentId);
    if (AgentSeatAuthorityDO.peak(agentRows, s, e) + 1 > agentCap) return false;
    return true;
  }

  /** Fix (code review round 4, P0): `applyPolicy` used to store a platform
   * cap that admission never read. Every admission check now clamps the
   * caller-supplied platform cap to the stored policy cap (when one is on
   * file) instead of trusting the caller alone — a caller cannot admit past
   * a platform-wide cap the admin already tightened. Must be called from
   * inside a transactionSync. */
  private effectivePlatformCap(callerCap: number): number {
    const row = this.sql.exec("SELECT platform_cap FROM agent_live_seat_policy WHERE singleton=1").toArray() as any[];
    if (!row.length) return callerCap;
    return Math.min(callerCap, Number(row[0].platform_cap));
  }

  /** Fix (code review round 4, P0): resolves the per-agent cap to use for an
   * admission check, and records/validates it against `agent_live_agent_caps`.
   *
   * - `callerRevision == null` (a re-check with no fresh revision, e.g. the
   *   `acquireLease` capacity re-check below): never trust a caller cap
   *   higher than what is already on file for the agent.
   * - `callerRevision` older than the cap on file: the caller is replaying a
   *   stale (possibly larger) cap — rejected as `stale_cap` rather than
   *   silently admitting past a cap the admin already tightened.
   * - `callerRevision` at or ahead of the cap on file: trusted and recorded.
   *
   * Must be called from inside a transactionSync. */
  private effectiveAgentCap(
    agentId: string,
    callerCap: number,
    callerRevision: number | null,
  ): { ok: true; cap: number } | { ok: false; reason: "stale_cap" } {
    const existing = this.sql.exec("SELECT cap, revision FROM agent_live_agent_caps WHERE agent_id=?1", agentId).toArray() as any[];
    const stored = existing.length ? { cap: Number(existing[0].cap), revision: Number(existing[0].revision) } : null;
    if (stored && callerRevision != null && callerRevision < stored.revision) {
      return { ok: false, reason: "stale_cap" };
    }
    if (callerRevision != null) {
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO agent_live_agent_caps (agent_id, cap, revision, updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(agent_id) DO UPDATE SET cap=excluded.cap, revision=excluded.revision, updated_at=excluded.updated_at
         WHERE excluded.revision >= agent_live_agent_caps.revision`,
        agentId, callerCap, callerRevision, now,
      );
      return { ok: true, cap: callerCap };
    }
    return { ok: true, cap: stored ? Math.min(callerCap, stored.cap) : callerCap };
  }

  // -------------------------------------------------------------------------
  // reserveProvisional
  // -------------------------------------------------------------------------

  private reserveProvisional(body: any): ReserveResult {
    const { bookingId, agentId, buyerUid, requestHash, startMs, endMs, agentCap, platformCap } = body;
    if (
      !isId(bookingId) || !isId(agentId) || !isId(buyerUid) || !isId(requestHash) ||
      !isFiniteInt(startMs) || !isFiniteInt(endMs) || endMs <= startMs ||
      !isPositiveInt(agentCap) || !isPositiveInt(platformCap)
    ) {
      return { ok: false, reason: "bad_request" };
    }
    const now = Date.now();
    // Scheduled starts must still be in the future; instant bookings are
    // allowed to start "now" (small clock skew tolerance).
    if (endMs - startMs > 24 * 60 * 60_000) return { ok: false, reason: "bad_request" };
    if (startMs < now - 60_000) return { ok: false, reason: "bad_request" };

    return this.state.storage.transactionSync((): ReserveResult => {
      this.sweepExpirations(now);

      const existing = this.getRow(bookingId);
      if (existing) {
        if (existing.state === "aborted") return { ok: false, reason: "bad_request" };
        if (existing.request_hash !== requestHash) {
          return { ok: false, reason: "bad_request" };
        }
        // Idempotent replay — do not refresh the 5-min deadline (R2 §1.4).
        if (existing.state === "provisional" || existing.state === "confirmed" || existing.state === "active") {
          return { ok: true, token: existing.token, startMs: existing.start_ms, endMs: existing.end_ms };
        }
        // released/expired: fall through and treat as a fresh reservation attempt.
      }

      const outstanding = (
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM agent_live_reservations WHERE buyer_uid=?1 AND state='provisional' AND expires_at>=?2",
          buyerUid,
          now,
        ).one() as any
      ).n as number;
      if (Number(outstanding) >= MAX_PROVISIONAL_PER_BUYER) {
        return { ok: false, reason: "seat_taken" };
      }

      // M5: caller passes the listing's persona_version as the cap revision
      // (BUILD SPEC §11 M5 "Caps"). Resolve both caps against what's on file
      // (fix, code review round 4 P0) before admitting.
      const callerRevision = isFiniteInt(body.revision) ? body.revision : null;
      const agentCapResolved = this.effectiveAgentCap(agentId, agentCap, callerRevision);
      if (!agentCapResolved.ok) return { ok: false, reason: "bad_request" };
      const effAgentCap = agentCapResolved.cap;
      const effPlatformCap = this.effectivePlatformCap(platformCap);
      const revision = callerRevision ?? 1;

      const rows = this.occupyingIntervals(now, bookingId);
      if (!this.fits(rows, agentId, startMs, endMs, effAgentCap, effPlatformCap)) {
        void track(this.env, "server", "agent_capacity_refused", "avatok-api", { agent_id: agentId });
        const nextFreeAt = this.computeNextFreeStart(agentId, endMs - startMs, now, effAgentCap, effPlatformCap);
        return { ok: false, reason: "seat_taken", ...(nextFreeAt != null ? { nextFreeAt } : {}) };
      }

      const token = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO agent_live_reservations
           (booking_id, agent_id, buyer_uid, request_hash, start_ms, end_ms, state, token, fence,
            expires_at, agent_cap_snapshot, platform_cap_snapshot, policy_revision, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,'provisional',?7,1,?8,?9,?10,?11,?12,?12)
         ON CONFLICT(booking_id) DO UPDATE SET
           agent_id=excluded.agent_id, buyer_uid=excluded.buyer_uid, request_hash=excluded.request_hash,
           start_ms=excluded.start_ms, end_ms=excluded.end_ms, state='provisional', token=excluded.token,
           fence=agent_live_reservations.fence+1, expires_at=excluded.expires_at,
           agent_cap_snapshot=excluded.agent_cap_snapshot, platform_cap_snapshot=excluded.platform_cap_snapshot,
           policy_revision=excluded.policy_revision, provider_uncertain=0, provider_expires_at=NULL,
           lease_owner=NULL, lease_expires_at=NULL, released_at=NULL, release_reason=NULL, updated_at=excluded.updated_at`,
        bookingId, agentId, buyerUid, requestHash, startMs, endMs, token,
        now + PROVISIONAL_TTL_MS, effAgentCap, effPlatformCap, revision, now,
      );

      return { ok: true, token, startMs, endMs };
    });
  }

  // -------------------------------------------------------------------------
  // confirm
  // -------------------------------------------------------------------------

  private confirm(body: any): ConfirmResult {
    const { bookingId, token, instant, agentCap, platformCap } = body;
    if (!isId(bookingId) || !isId(token)) return { ok: false, reason: "bad_request" };
    const now = Date.now();

    return this.state.storage.transactionSync((): ConfirmResult => {
      this.sweepExpirations(now);
      const row = this.getRow(bookingId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.state === "aborted") return { ok: false, reason: "aborted" };
      if (row.state === "confirmed" || row.state === "active") {
        // Idempotent replay of a committed confirmation.
        if (row.token !== token) return { ok: false, reason: "bad_request" };
        return { ok: true, startMs: row.start_ms, endMs: row.end_ms };
      }
      if (row.state !== "provisional") return { ok: false, reason: "expired" };
      if (row.token !== token) return { ok: false, reason: "bad_request" };
      if (row.expires_at < now) return { ok: false, reason: "expired" };

      let startMs = row.start_ms;
      let endMs = row.end_ms;
      // Fix (code review round 4, P0): resolve against the stored per-agent
      // cap / platform policy cap, not the caller's number alone.
      const callerRevision = isFiniteInt(body.revision) ? body.revision : null;
      const callerAgentCap = isPositiveInt(agentCap) ? agentCap : row.agent_cap_snapshot;
      const agentCapResolved = this.effectiveAgentCap(row.agent_id, callerAgentCap, callerRevision);
      if (!agentCapResolved.ok) return { ok: false, reason: "stale_cap" };
      const cap = agentCapResolved.cap;
      const plat = this.effectivePlatformCap(isPositiveInt(platformCap) ? platformCap : row.platform_cap_snapshot);

      if (instant === true) {
        // M5: instant bookings are rebased to confirmation time and the
        // WHOLE interval is re-checked, excluding this booking's own row.
        const duration = row.end_ms - row.start_ms;
        startMs = now;
        endMs = now + duration;
        const rows = this.occupyingIntervals(now, bookingId);
        if (!this.fits(rows, row.agent_id, startMs, endMs, cap, plat)) {
          const nextFreeAt = this.computeNextFreeStart(row.agent_id, duration, now, cap, plat);
          return { ok: false, reason: "seat_taken", ...(nextFreeAt != null ? { nextFreeAt } : {}) };
        }
      } else {
        // Scheduled: re-verify the (unchanged) interval still fits, since
        // capacity may have shifted between reserve and confirm.
        const rows = this.occupyingIntervals(now, bookingId);
        if (!this.fits(rows, row.agent_id, startMs, endMs, cap, plat)) {
          const nextFreeAt = this.computeNextFreeStart(row.agent_id, endMs - startMs, now, cap, plat);
          return { ok: false, reason: "seat_taken", ...(nextFreeAt != null ? { nextFreeAt } : {}) };
        }
      }

      this.sql.exec(
        `UPDATE agent_live_reservations
         SET state='confirmed', start_ms=?2, end_ms=?3, expires_at=?3, agent_cap_snapshot=?4, platform_cap_snapshot=?5, updated_at=?6
         WHERE booking_id=?1`,
        bookingId, startMs, endMs, cap, plat, now,
      );
      return { ok: true, startMs, endMs };
    });
  }

  // -------------------------------------------------------------------------
  // abort — terminal, blocks any later confirm.
  // -------------------------------------------------------------------------

  private abort(body: any): { ok: true } | { ok: false; reason: string } {
    const { bookingId } = body;
    if (!isId(bookingId)) return { ok: false, reason: "bad_request" };
    const now = Date.now();
    return this.state.storage.transactionSync((): { ok: true } | { ok: false; reason: string } => {
      const row = this.getRow(bookingId);
      if (!row) {
        // Nothing reserved yet — insert a tombstone row so a subsequent
        // reserveProvisional/confirm for the same booking id is refused.
        this.sql.exec(
          `INSERT INTO agent_live_reservations
             (booking_id, agent_id, buyer_uid, request_hash, start_ms, end_ms, state, token, fence,
              expires_at, agent_cap_snapshot, platform_cap_snapshot, policy_revision, created_at, updated_at)
           VALUES (?1,'','','',0,1,'aborted','',1,0,1,1,0,?2,?2)`,
          bookingId, now,
        );
        return { ok: true };
      }
      if (row.state === "active") return { ok: false, reason: "already_active" };
      if (row.state !== "aborted") {
        this.sql.exec(
          "UPDATE agent_live_reservations SET state='aborted', released_at=?2, release_reason='abort', updated_at=?2 WHERE booking_id=?1",
          bookingId, now,
        );
      }
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // getReservation
  // -------------------------------------------------------------------------

  private getReservation(body: any): { ok: true; reservation: Record<string, unknown> } | { ok: false; reason: string } {
    const { bookingId } = body;
    if (!isId(bookingId)) return { ok: false, reason: "bad_request" };
    const row = this.getRow(bookingId);
    if (!row) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      reservation: {
        bookingId: row.booking_id,
        agentId: row.agent_id,
        buyerUid: row.buyer_uid,
        state: row.state,
        startMs: row.start_ms,
        endMs: row.end_ms,
        fence: row.fence,
        providerUncertain: row.provider_uncertain === 1,
        providerExpiresAt: row.provider_expires_at,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
      },
    };
  }

  // -------------------------------------------------------------------------
  // release — pre-runtime (cancel / failed hold). No token required: this is
  // called by trusted internal checkout/money code, not by the room.
  // -------------------------------------------------------------------------

  private release(body: any): { ok: true } | { ok: false; reason: string } {
    const { bookingId, reason } = body;
    if (!isId(bookingId)) return { ok: false, reason: "bad_request" };
    const now = Date.now();
    return this.state.storage.transactionSync((): { ok: true } | { ok: false; reason: string } => {
      const row = this.getRow(bookingId);
      if (!row) return { ok: true }; // idempotent — nothing to release
      if (row.state === "active") return { ok: false, reason: "active_lease" };
      if (row.state === "released" || row.state === "expired" || row.state === "aborted") return { ok: true };
      this.sql.exec(
        "UPDATE agent_live_reservations SET state='released', released_at=?2, release_reason=?3, updated_at=?2 WHERE booking_id=?1",
        bookingId, now, typeof reason === "string" ? reason.slice(0, 200) : null,
      );
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // acquireLease
  // -------------------------------------------------------------------------

  private acquireLease(body: any): LeaseResult {
    const { bookingId, owner } = body;
    if (!isId(bookingId) || !isId(owner)) return { ok: false, reason: "bad_request" };
    const now = Date.now();
    return this.state.storage.transactionSync((): LeaseResult => {
      this.sweepExpirations(now);
      const row = this.getRow(bookingId);
      if (!row) return { ok: false, reason: "not_confirmed" };
      if (row.provider_uncertain === 1) return { ok: false, reason: "provider_uncertain" };
      if (row.state !== "confirmed" && row.state !== "active") return { ok: false, reason: "not_confirmed" };
      if (now < row.start_ms || now >= row.end_ms) return { ok: false, reason: "expired" };
      if (row.state === "active" && row.lease_owner && row.lease_owner !== owner) {
        // An existing valid lease cannot be displaced by another owner.
        if (row.lease_expires_at != null && row.lease_expires_at > now) {
          return { ok: false, reason: "not_confirmed" };
        }
      }
      const sameOwnerIdempotent = row.state === "active" && row.lease_owner === owner && row.lease_expires_at != null && row.lease_expires_at > now;

      // Fix (code review round 4, P0, F7): confirming a reservation only
      // proved capacity at confirm time. A neighbouring booking can later
      // become `provider_uncertain` and occupy this reservation's own
      // window past its `end_ms` (e.g. cap 1, adjacent [0,10) then [10,20):
      // the first booking's uncertain provider now occupies [10, +60min)).
      // Re-run the same boundary-sweep peak check here, excluding this
      // booking's own row, before a lease is actually granted — a confirmed
      // reservation is a promise conditioned on capacity still holding, not
      // an unconditional one. Skipped only for an idempotent re-acquire by
      // the SAME owner of an already-valid lease: that seat is already this
      // booking's own occupancy and nothing else could have displaced it
      // between heartbeats.
      if (!sameOwnerIdempotent) {
        const rows = this.occupyingIntervals(now, bookingId);
        const capAgent = this.effectiveAgentCap(row.agent_id, row.agent_cap_snapshot, null);
        const capPlatform = this.effectivePlatformCap(row.platform_cap_snapshot);
        if (!capAgent.ok || !this.fits(rows, row.agent_id, row.start_ms, row.end_ms, capAgent.cap, capPlatform)) {
          void track(this.env, "server", "agent_seat_lease_capacity_refused", "avatok-api", { booking_id: bookingId });
          return { ok: false, reason: "provider_uncertain" };
        }
      }

      const fence = sameOwnerIdempotent ? row.fence : row.fence + 1;
      const leaseExpiresAt = Math.min(now + LEASE_TTL_MS, row.end_ms);
      this.sql.exec(
        `UPDATE agent_live_reservations
         SET state='active', fence=?2, lease_owner=?3, lease_expires_at=?4, last_heartbeat_at=?5, updated_at=?5
         WHERE booking_id=?1`,
        bookingId, fence, owner, leaseExpiresAt, now,
      );
      return { ok: true, fence, startMs: row.start_ms, endMs: row.end_ms };
    });
  }

  // -------------------------------------------------------------------------
  // heartbeat
  // -------------------------------------------------------------------------

  private heartbeat(body: any): { ok: true; endMs: number } | { ok: false; reason: string } {
    const { bookingId, fence } = body;
    if (!isId(bookingId) || !isFiniteInt(fence)) return { ok: false, reason: "bad_request" };
    const now = Date.now();
    return this.state.storage.transactionSync((): { ok: true; endMs: number } | { ok: false; reason: string } => {
      const row = this.getRow(bookingId);
      if (!row || row.state !== "active" || row.fence !== fence) return { ok: false, reason: "bad_fence" };
      if (row.lease_expires_at == null || row.lease_expires_at < now) return { ok: false, reason: "expired" };
      const leaseExpiresAt = Math.min(now + LEASE_TTL_MS, row.end_ms);
      this.sql.exec(
        "UPDATE agent_live_reservations SET lease_expires_at=?2, last_heartbeat_at=?3, updated_at=?3 WHERE booking_id=?1",
        bookingId, leaseExpiresAt, now,
      );
      return { ok: true, endMs: row.end_ms };
    });
  }

  // -------------------------------------------------------------------------
  // releaseRuntime — M5: providerClosed:boolean gates whether the seat frees
  // immediately or stays occupying via provider_uncertain.
  // -------------------------------------------------------------------------

  private releaseRuntime(body: any): { ok: true } | { ok: false; reason: string } {
    const { bookingId, fence, providerClosed, reason } = body;
    if (!isId(bookingId) || !isFiniteInt(fence) || typeof providerClosed !== "boolean") {
      return { ok: false, reason: "bad_request" };
    }
    const now = Date.now();
    return this.state.storage.transactionSync((): { ok: true } | { ok: false; reason: string } => {
      const row = this.getRow(bookingId);
      if (!row) return { ok: true }; // idempotent
      if (row.state === "released" || row.state === "expired") return { ok: true };
      if (row.fence !== fence) return { ok: false, reason: "bad_fence" };

      if (providerClosed) {
        this.sql.exec(
          `UPDATE agent_live_reservations
           SET state='released', released_at=?2, release_reason=?3, lease_owner=NULL, lease_expires_at=NULL,
               provider_uncertain=0, provider_expires_at=NULL, updated_at=?2
           WHERE booking_id=?1`,
          bookingId, now, typeof reason === "string" ? reason.slice(0, 200) : null,
        );
      } else {
        void track(this.env, "server", "agent_seat_provider_uncertain_set", "avatok-api", {
          booking_id: bookingId,
        });
        this.sql.exec(
          `UPDATE agent_live_reservations
           SET state='released', released_at=?2, release_reason=?3, lease_owner=NULL, lease_expires_at=NULL,
               provider_uncertain=1, provider_expires_at=?4, updated_at=?2
           WHERE booking_id=?1`,
          bookingId, now, typeof reason === "string" ? reason.slice(0, 200) : null, now + PROVIDER_UNCERTAIN_DEFAULT_MS,
        );
      }
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // providerClosed — later confirmation that an uncertain provider did close.
  // -------------------------------------------------------------------------

  private providerClosedOp(body: any): { ok: true } | { ok: false; reason: string } {
    const { bookingId, fence } = body;
    if (!isId(bookingId) || !isFiniteInt(fence)) return { ok: false, reason: "bad_request" };
    const now = Date.now();
    return this.state.storage.transactionSync((): { ok: true } | { ok: false; reason: string } => {
      const row = this.getRow(bookingId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.provider_uncertain !== 1) return { ok: true }; // already resolved — idempotent
      if (row.fence !== fence) return { ok: false, reason: "bad_fence" };
      this.sql.exec(
        "UPDATE agent_live_reservations SET provider_uncertain=0, provider_expires_at=NULL, updated_at=?2 WHERE booking_id=?1",
        bookingId, now,
      );
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  private nextFreeStart(body: any): { startMs: number } | { ok: false; reason: string } {
    const { agentId, minutes, fromMs, agentCap, platformCap } = body;
    if (!isId(agentId) || !isPositiveInt(minutes) || !isFiniteInt(fromMs) || !isPositiveInt(agentCap) || !isPositiveInt(platformCap)) {
      return { ok: false, reason: "bad_request" };
    }
    const now = Date.now();
    return this.state.storage.transactionSync((): { startMs: number } | { ok: false; reason: string } => {
      this.sweepExpirations(now);
      // Fix (code review round 4, P0): clamp to the stored per-agent /
      // platform policy caps, same as the admitting calls, so availability
      // never advertises a start the real caps would refuse.
      const capAgentResolved = this.effectiveAgentCap(agentId, agentCap, null);
      const effAgentCap = capAgentResolved.ok ? capAgentResolved.cap : 0;
      const effPlatformCap = this.effectivePlatformCap(platformCap);
      const startMs = this.computeNextFreeStart(agentId, minutes * 60_000, Math.max(fromMs, now), effAgentCap, effPlatformCap);
      if (startMs == null) return { ok: false, reason: "no_availability" };
      return { startMs };
    });
  }

  /** Must be called from inside a transactionSync (no I/O). */
  private computeNextFreeStart(agentId: string, durationMs: number, fromMs: number, agentCap: number, platformCap: number): number | null {
    const horizon = fromMs + AVAILABILITY_HORIZON_MS;
    const rows = this.occupyingIntervals(Date.now());
    const candidates = new Set<number>([fromMs]);
    for (const r of rows) {
      if (r.endMs >= fromMs && r.endMs < horizon) candidates.add(r.endMs);
    }
    const sorted = Array.from(candidates).sort((a, b) => a - b);
    for (const s of sorted) {
      const e = s + durationMs;
      if (e > horizon) break;
      if (this.fits(rows, agentId, s, e, agentCap, platformCap)) return s;
    }
    return null;
  }

  private freeStarts(body: any): { starts: number[] } | { ok: false; reason: string } {
    const { agentId, minutes, dayStartMs, dayEndMs, gridMs, agentCap, platformCap } = body;
    if (
      !isId(agentId) || !isPositiveInt(minutes) || !isFiniteInt(dayStartMs) || !isFiniteInt(dayEndMs) ||
      dayEndMs <= dayStartMs || !isPositiveInt(gridMs) || !isPositiveInt(agentCap) || !isPositiveInt(platformCap)
    ) {
      return { ok: false, reason: "bad_request" };
    }
    const now = Date.now();
    const durationMs = minutes * 60_000;
    return this.state.storage.transactionSync((): { starts: number[] } | { ok: false; reason: string } => {
      this.sweepExpirations(now);
      // Fix (code review round 4, P0): same clamp as reserveProvisional.
      const capAgentResolved = this.effectiveAgentCap(agentId, agentCap, null);
      const effAgentCap = capAgentResolved.ok ? capAgentResolved.cap : 0;
      const effPlatformCap = this.effectivePlatformCap(platformCap);
      const rows = this.occupyingIntervals(now);
      const starts: number[] = [];
      for (let s = dayStartMs; s < dayEndMs && starts.length < MAX_FREE_START_CELLS; s += gridMs) {
        if (s < now) continue;
        const e = s + durationMs;
        if (this.fits(rows, agentId, s, e, effAgentCap, effPlatformCap)) starts.push(s);
      }
      return { starts };
    });
  }

  private activeCount(body: any): { count: number } {
    const { agentId } = body;
    const now = Date.now();
    return this.state.storage.transactionSync((): { count: number } => {
      this.sweepExpirations(now);
      const rows = isId(agentId)
        ? this.occupyingIntervals(now).filter((r) => r.agentId === agentId)
        : this.occupyingIntervals(now);
      // "Active" here means currently occupying, i.e. now falls inside the
      // occupied interval (not merely overlapping some future window).
      const count = rows.filter((r) => r.startMs <= now && now < r.endMs).length;
      return { count };
    });
  }

  private applyPolicy(body: any): { ok: true } | { ok: false; reason: string } {
    const { platformCap, revision } = body;
    if (!isPositiveInt(platformCap) || !isFiniteInt(revision)) return { ok: false, reason: "bad_request" };
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO agent_live_seat_policy (singleton, platform_cap, revision, updated_at) VALUES (1,?1,?2,?3)
       ON CONFLICT(singleton) DO UPDATE SET platform_cap=excluded.platform_cap, revision=excluded.revision, updated_at=excluded.updated_at
       WHERE excluded.revision >= agent_live_seat_policy.revision`,
      platformCap, revision, now,
    );
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Row helper
  // -------------------------------------------------------------------------

  private getRow(bookingId: string): ReservationRow | null {
    const r = this.sql.exec("SELECT * FROM agent_live_reservations WHERE booking_id=?1", bookingId).toArray() as any[];
    if (!r.length) return null;
    const row = r[0];
    return {
      booking_id: String(row.booking_id),
      agent_id: String(row.agent_id),
      buyer_uid: String(row.buyer_uid),
      request_hash: String(row.request_hash),
      start_ms: Number(row.start_ms),
      end_ms: Number(row.end_ms),
      state: row.state as ReservationState,
      token: String(row.token),
      fence: Number(row.fence),
      expires_at: Number(row.expires_at),
      agent_cap_snapshot: Number(row.agent_cap_snapshot),
      platform_cap_snapshot: Number(row.platform_cap_snapshot),
      policy_revision: Number(row.policy_revision),
      lease_owner: row.lease_owner != null ? String(row.lease_owner) : null,
      lease_expires_at: row.lease_expires_at != null ? Number(row.lease_expires_at) : null,
      last_heartbeat_at: row.last_heartbeat_at != null ? Number(row.last_heartbeat_at) : null,
      provider_uncertain: Number(row.provider_uncertain),
      provider_expires_at: row.provider_expires_at != null ? Number(row.provider_expires_at) : null,
      released_at: row.released_at != null ? Number(row.released_at) : null,
      release_reason: row.release_reason != null ? String(row.release_reason) : null,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }
}
