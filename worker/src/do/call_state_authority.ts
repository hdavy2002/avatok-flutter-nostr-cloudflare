// CallStateAuthorityDO — Phase A scaffolding (see Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md,
// "2. Part A — CallStateAuthorityDO: the control plane").
//
// WHAT THIS OWNS (and only this): ownership, not media. One instance per
// account_uid (idFromName(uid)). Current call, peer, phase, receptionist
// state, reservation tokens, epoch, lease, active device. It NEVER stores
// SDP, ICE candidates, media, or WebSocket signaling frames — CallRoom/
// GroupCallDO/ReceptionRoom own that; this DO stays tiny so millions of
// instances are cheap and cold-start fast (§Part E gap 1).
//
// SINGLE-WRITER CONTROL PLANE: this is the only writer of call ownership,
// busy, receptionist state, reservations, and migration status (§Part G DoD).
// Every mutation is a compare-and-swap on a monotonic uint64 `epoch` (never
// wall-clock/UUID ordering, §2.4) plus an idempotency key (`mutation_uuid`,
// §2.5). "Busy" is NEVER a stored boolean — it is derived: phase !== 'idle'
// OR an active (non-expired) reservation exists (§2.3).
//
// CURRENT STATUS: DORMANT. Nothing in the Worker calls this DO yet — it is
// not registered in wrangler config, not exported from the DO index, and no
// route constructs a DurableObjectId for it. This file is pure Phase A
// plumbing (§5.2 "Phase A: ship schema/RPC/epochs/leases; nothing reads it").
// Phase B+ (dual-write, shadow divergence measurement, enforcement) is
// out of scope here and gated behind the rollout flags in §5.3
// (authorityShadow → authorityRead → authorityWrite → authorityEnforced).
//
// Transport: this codebase's DOs are addressed via fetch() (see call_room.ts,
// inbox.ts), not native Cloudflare RPC classes — so despite the spec's
// "RPC internally" framing (§2.5 header), this implementation exposes plain
// JSON POST endpoints over fetch(), matching the rest of the codebase.
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// §8B.3 Global enums — string-literal unions, snake_case values, EXACTLY as
// specified. Never send/accept free-form strings for these fields.
// ---------------------------------------------------------------------------

/** §2.3 state machine phases (+ §8B.3 authority_phase). "busy" is NOT a phase. */
export type CallPhase =
  | "idle"
  | "incoming_ringing"
  | "outgoing_ringing"
  | "connecting"
  | "connected"
  | "receptionist_active"
  | "callback_reserved"
  | "migrating"
  | "releasing";

/** §8B.3 busy_reason — closed enum, never free-form. */
export type BusyReason =
  | "active_call"
  | "receptionist"
  | "callback_reserved"
  | "group_full"
  | "migration"
  | "ringing_other_device"
  | "account_switch"
  | "device_handoff"
  | "rate_limited"
  | "blocked"
  | "do_not_disturb"
  | "provider_failure"
  | "unknown";

/** §8B.3 authority_decision. */
export type AuthorityDecision =
  | "allow"
  | "busy"
  | "preempt"
  | "redirect_receptionist"
  | "reject"
  | "retry"
  | "conflict";

/** §2.5 call direction. */
export type CallDirection = "in" | "out";

/** §8B.3 rtc_provider. */
export type RtcProvider = "cloudflare" | "jitsi" | "livekit" | "mock" | "unknown";

const LEASE_MS = 30_000; // §2.4: lease = now + 30s, heartbeat refresh every 10s while CONNECTED
const CALLBACK_RESERVATION_TTL_MS = 8_000; // §2.5 reserveCallback: expires = +8s
const TRANSITIONS_RETENTION_MS = 24 * 60 * 60 * 1000; // §2.2: 24h retention, debugging only

/** DO-local SQLite row shape for the single `call_state` row (§2.2). */
interface CallStateRow {
  uid: string;
  call_id: string | null;
  peer_uid: string | null;
  phase: CallPhase | null;
  direction: CallDirection | null;
  rtc_provider: RtcProvider | null;
  epoch: number;
  lease_expiry_ms: number | null;
  owner_session_id: string | null;
  owner_device_id: string | null;
  receptionist_target_uid: string | null;
  callback_reserved_peer: string | null;
  callback_reservation_until: number | null;
  callroom_id: string | null;
  last_transition_ms: number | null;
  last_mutation_uuid: string | null;
  updated_at: number | null;
}

interface ReservationRow {
  peer_uid: string;
  reservation_type: string;
  expires_at: number;
  epoch: number;
}

/** Generic JSON shape returned by every mutation endpoint. */
interface MutationResult {
  ok: boolean;
  decision: AuthorityDecision;
  epoch: number;
  phase: CallPhase;
  busy: boolean;
  busy_reason?: BusyReason;
  call_id?: string | null;
  reservation?: { reservation_id: string; authority_epoch: number; expires_at: number; peer_uid: string } | null;
  error?: string;
  actual_epoch?: number;
}

/** Idempotency store: every mutation_uuid's response is persisted in the
 *  `idempotency` SQLite table (see initSchema) so a duplicate mutation
 *  returns the identical result even after this DO hibernates/evicts and
 *  is re-instantiated (§2.5). This is the ONLY source of truth for
 *  idempotency decisions — there is no in-memory fallback. */

export class CallStateAuthorityDO {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS call_state (
         uid                        TEXT PRIMARY KEY,
         call_id                    TEXT,
         peer_uid                   TEXT,
         phase                      TEXT,
         direction                  TEXT,
         rtc_provider               TEXT,
         epoch                      INTEGER NOT NULL DEFAULT 0,
         lease_expiry_ms            INTEGER,
         owner_session_id           TEXT,
         owner_device_id            TEXT,
         receptionist_target_uid    TEXT,
         callback_reserved_peer     TEXT,
         callback_reservation_until INTEGER,
         callroom_id                TEXT,
         last_transition_ms         INTEGER,
         last_mutation_uuid         TEXT,
         updated_at                 INTEGER
       );
       CREATE TABLE IF NOT EXISTS call_transitions (
         epoch INTEGER,
         call_id TEXT,
         from_phase TEXT,
         to_phase TEXT,
         reason TEXT,
         mutation_uuid TEXT,
         timestamp INTEGER
       );
       CREATE INDEX IF NOT EXISTS idx_transitions_ts ON call_transitions(timestamp);
       CREATE TABLE IF NOT EXISTS reservations (
         peer_uid TEXT,
         reservation_type TEXT,
         expires_at INTEGER,
         epoch INTEGER
       );
       CREATE INDEX IF NOT EXISTS idx_reservations_peer ON reservations(peer_uid);
       CREATE TABLE IF NOT EXISTS idempotency (
         mutation_uuid TEXT PRIMARY KEY,
         response_json TEXT NOT NULL,
         created_at INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency(created_at);`,
    );
  }

  // -------------------------------------------------------------------------
  // Row load/save helpers
  // -------------------------------------------------------------------------

  /** Loads the single call_state row, creating a fresh IDLE row (epoch 0) if
   *  this authority has never been written to. Also performs the §2.9
   *  hibernation-wake lease check: if CONNECTED and the lease has expired,
   *  auto-transitions CONNECTED → IDLE before returning (never orphans a call). */
  private loadRow(): CallStateRow {
    const uid = this.accountUid();
    const rows = this.sql.exec(`SELECT * FROM call_state WHERE uid = ?`, uid).toArray() as unknown as CallStateRow[];
    let row: CallStateRow;
    if (rows.length === 0) {
      row = {
        uid,
        call_id: null,
        peer_uid: null,
        phase: "idle",
        direction: null,
        rtc_provider: null,
        epoch: 0,
        lease_expiry_ms: null,
        owner_session_id: null,
        owner_device_id: null,
        receptionist_target_uid: null,
        callback_reserved_peer: null,
        callback_reservation_until: null,
        callroom_id: null,
        last_transition_ms: null,
        last_mutation_uuid: null,
        updated_at: Date.now(),
      };
      this.persistRow(row);
      return row;
    }
    row = rows[0];
    // §2.9 hibernation wake: lease_expired? -> CONNECTED -> IDLE.
    if (row.phase === "connected" && row.lease_expiry_ms != null && Date.now() > row.lease_expiry_ms) {
      row = this.applyTransition(row, "idle", "lease_expired_on_wake");
      row.peer_uid = null;
      row.call_id = null;
      row.owner_session_id = null;
      row.owner_device_id = null;
      row.lease_expiry_ms = null;
      this.persistRow(row);
    }
    return row;
  }

  private persistRow(row: CallStateRow): void {
    row.updated_at = Date.now();
    this.sql.exec(
      `INSERT INTO call_state (
         uid, call_id, peer_uid, phase, direction, rtc_provider, epoch,
         lease_expiry_ms, owner_session_id, owner_device_id,
         receptionist_target_uid, callback_reserved_peer,
         callback_reservation_until, callroom_id, last_transition_ms,
         last_mutation_uuid, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(uid) DO UPDATE SET
         call_id=excluded.call_id,
         peer_uid=excluded.peer_uid,
         phase=excluded.phase,
         direction=excluded.direction,
         rtc_provider=excluded.rtc_provider,
         epoch=excluded.epoch,
         lease_expiry_ms=excluded.lease_expiry_ms,
         owner_session_id=excluded.owner_session_id,
         owner_device_id=excluded.owner_device_id,
         receptionist_target_uid=excluded.receptionist_target_uid,
         callback_reserved_peer=excluded.callback_reserved_peer,
         callback_reservation_until=excluded.callback_reservation_until,
         callroom_id=excluded.callroom_id,
         last_transition_ms=excluded.last_transition_ms,
         last_mutation_uuid=excluded.last_mutation_uuid,
         updated_at=excluded.updated_at`,
      row.uid, row.call_id, row.peer_uid, row.phase, row.direction, row.rtc_provider,
      row.epoch, row.lease_expiry_ms, row.owner_session_id, row.owner_device_id,
      row.receptionist_target_uid, row.callback_reserved_peer,
      row.callback_reservation_until, row.callroom_id, row.last_transition_ms,
      row.last_mutation_uuid, row.updated_at,
    );
  }

  /** account_uid this instance is keyed by. DO name === account_uid (idFromName(uid)),
   *  matching the "one DO per account_uid" contract in §2.1. */
  private accountUid(): string {
    return this.state.id.name ? String(this.state.id.name) : "";
  }

  // -------------------------------------------------------------------------
  // Epoch / transition / idempotency helpers
  // -------------------------------------------------------------------------

  /** CAS check: expected_epoch must match the row's current epoch. */
  private casOk(row: CallStateRow, expectedEpoch: number): boolean {
    return row.epoch === expectedEpoch;
  }

  /** Bumps epoch, records a transition row (§2.2 call_transitions, 24h retention),
   *  and returns the mutated row (caller still must persistRow()). Mutates row in place. */
  private applyTransition(row: CallStateRow, toPhase: CallPhase, reason: string, mutationUuid?: string): CallStateRow {
    const fromPhase = row.phase ?? "idle";
    const now = Date.now();
    row.epoch = row.epoch + 1;
    row.phase = toPhase;
    row.last_transition_ms = now;
    if (mutationUuid) row.last_mutation_uuid = mutationUuid;
    this.sql.exec(
      `INSERT INTO call_transitions (epoch, call_id, from_phase, to_phase, reason, mutation_uuid, timestamp)
       VALUES (?,?,?,?,?,?,?)`,
      row.epoch, row.call_id, fromPhase, toPhase, reason, mutationUuid ?? null, now,
    );
    // Best-effort retention trim; never blocks the mutation.
    try {
      this.sql.exec(`DELETE FROM call_transitions WHERE timestamp < ?`, now - TRANSITIONS_RETENTION_MS);
    } catch { /* best-effort */ }
    return row;
  }

  /** §2.5: "if idem exists -> return prior; never execute twice." Persisted in
   *  the `idempotency` SQLite table, so a replayed mutation_uuid returns the
   *  same response even after this DO hibernates/evicts and wakes fresh. */
  private checkIdempotent(mutationUuid: string | undefined): MutationResult | null {
    if (!mutationUuid) return null;
    const stored = this.idempotentGet(mutationUuid);
    return stored != null ? (stored as MutationResult) : null;
  }

  private rememberMutation(mutationUuid: string | undefined, result: MutationResult): void {
    if (!mutationUuid) return;
    this.idempotentPut(mutationUuid, result);
  }

  /** Reads a previously-stored mutation response from SQLite, if any. */
  private idempotentGet(mutationUuid: string): unknown | undefined {
    const rows = this.sql
      .exec(`SELECT response_json FROM idempotency WHERE mutation_uuid = ?`, mutationUuid)
      .toArray() as unknown as Array<{ response_json: string }>;
    if (rows.length === 0) return undefined;
    try {
      return JSON.parse(rows[0].response_json);
    } catch {
      return undefined;
    }
  }

  /** Persists a mutation response keyed by mutation_uuid, and best-effort
   *  prunes entries older than 1 hour so the table never grows unbounded. */
  private idempotentPut(mutationUuid: string, response: unknown): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO idempotency (mutation_uuid, response_json, created_at) VALUES (?,?,?)`,
      mutationUuid, JSON.stringify(response), now,
    );
    try {
      this.sql.exec(`DELETE FROM idempotency WHERE created_at < ?`, now - 3_600_000);
    } catch { /* best-effort */ }
  }

  /** §2.3: busy ⇔ (phase != idle) OR an active (non-expired) reservation exists.
   *  Never stored — always derived at read time. */
  private isBusy(row: CallStateRow): boolean {
    if ((row.phase ?? "idle") !== "idle") return true;
    const now = Date.now();
    const activeReservations = this.sql
      .exec(`SELECT COUNT(*) as c FROM reservations WHERE expires_at > ?`, now)
      .toArray() as unknown as Array<{ c: number }>;
    return (activeReservations[0]?.c ?? 0) > 0;
  }

  private busyReasonFor(row: CallStateRow): BusyReason | undefined {
    if (!this.isBusy(row)) return undefined;
    switch (row.phase) {
      case "receptionist_active": return "receptionist";
      case "callback_reserved": return "callback_reserved";
      case "migrating": return "migration";
      case "incoming_ringing":
      case "outgoing_ringing":
      case "connecting":
      case "connected": return "active_call";
      default: return "unknown";
    }
  }

  private conflict(actualEpoch: number): Response {
    return Response.json({ error: "conflict", actual_epoch: actualEpoch }, { status: 409 });
  }

  // -------------------------------------------------------------------------
  // fetch() router — internal-only, never client-exposed (called Worker-to-DO,
  // matching the CallRoom /state and /glare-place convention). Phase A: no
  // caller wires this up yet.
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path.endsWith("/query")) {
      return this.handleQuery();
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    let body: Record<string, unknown> = {};
    try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body */ }

    if (path.endsWith("/acquire")) return this.handleAcquire(body);
    if (path.endsWith("/transition")) return this.handleTransition(body);
    if (path.endsWith("/query")) return this.handleQuery(); // POST fallback, read-only
    if (path.endsWith("/reserve-callback")) return this.handleReserveCallback(body);
    if (path.endsWith("/preempt-callback")) return this.handlePreemptCallback(body);
    if (path.endsWith("/abandon-receptionist")) return this.handleAbandonReceptionist(body);
    if (path.endsWith("/release")) return this.handleRelease(body);

    return Response.json({ error: "unknown endpoint" }, { status: 404 });
  }

  // -------------------------------------------------------------------------
  // §2.5 API endpoints
  // -------------------------------------------------------------------------

  /** POST /acquire — acquireCall(caller,peer,call_id,dir,idem,expected_epoch).
   *  Claim a call. IDLE -> acquire (epoch++, OK); else BUSY(reason). */
  private handleAcquire(body: Record<string, unknown>): Response {
    const mutationUuid = typeof body.mutation_uuid === "string" ? body.mutation_uuid : undefined;
    const cached = this.checkIdempotent(mutationUuid);
    if (cached) return Response.json(cached);

    const row = this.loadRow();
    const expectedEpoch = typeof body.expected_epoch === "number" ? body.expected_epoch : row.epoch;
    if (!this.casOk(row, expectedEpoch)) return this.conflict(row.epoch);

    const peer = typeof body.peer === "string" ? body.peer : "";
    const callId = typeof body.call_id === "string" ? body.call_id : "";
    const direction: CallDirection = body.direction === "in" ? "in" : "out";
    const rtcProvider: RtcProvider =
      typeof body.rtc_provider === "string" &&
      ["cloudflare", "jitsi", "livekit", "mock"].includes(body.rtc_provider)
        ? (body.rtc_provider as RtcProvider)
        : "unknown";
    const ownerSessionId = typeof body.owner_session_id === "string" ? body.owner_session_id : null;
    const ownerDeviceId = typeof body.owner_device_id === "string" ? body.owner_device_id : null;

    if (this.isBusy(row)) {
      const result: MutationResult = {
        ok: false,
        decision: "busy",
        epoch: row.epoch,
        phase: row.phase ?? "idle",
        busy: true,
        busy_reason: this.busyReasonFor(row),
        call_id: row.call_id,
      };
      this.rememberMutation(mutationUuid, result);
      return Response.json(result);
    }

    row.call_id = callId || null;
    row.peer_uid = peer || null;
    row.direction = direction;
    row.rtc_provider = rtcProvider;
    row.owner_session_id = ownerSessionId;
    row.owner_device_id = ownerDeviceId;
    row.lease_expiry_ms = Date.now() + LEASE_MS;
    const toPhase: CallPhase = direction === "out" ? "outgoing_ringing" : "incoming_ringing";
    this.applyTransition(row, toPhase, "acquire_call", mutationUuid);
    this.persistRow(row);

    const result: MutationResult = {
      ok: true,
      decision: "allow",
      epoch: row.epoch,
      phase: row.phase ?? toPhase,
      busy: false,
      call_id: row.call_id,
    };
    this.rememberMutation(mutationUuid, result);
    return Response.json(result);
  }

  /** POST /transition — transitionPhase(call_id,from,to,expected_epoch,mut). CAS; epoch++. */
  private handleTransition(body: Record<string, unknown>): Response {
    const mutationUuid = typeof body.mutation_uuid === "string" ? body.mutation_uuid : undefined;
    const cached = this.checkIdempotent(mutationUuid);
    if (cached) return Response.json(cached);

    const row = this.loadRow();
    const expectedEpoch = typeof body.expected_epoch === "number" ? body.expected_epoch : row.epoch;
    if (!this.casOk(row, expectedEpoch)) return this.conflict(row.epoch);

    const fromPhase = typeof body.from === "string" ? (body.from as CallPhase) : row.phase;
    const toPhase = typeof body.to === "string" ? (body.to as CallPhase) : row.phase;
    if (fromPhase && row.phase !== fromPhase) return this.conflict(row.epoch);
    if (!toPhase) return Response.json({ error: "to phase required" }, { status: 400 });

    // Persist the receptionist target when entering RECEPTIONIST_ACTIVE so a later
    // preemptForCallback can match the caller (§2.5); clear it on leaving the phase.
    if (typeof body.receptionist_target_uid === "string") {
      row.receptionist_target_uid = body.receptionist_target_uid;
    } else if (toPhase !== "receptionist_active" && row.phase === "receptionist_active") {
      row.receptionist_target_uid = null;
    }

    // Refresh the lease whenever we (re)enter CONNECTED, per §2.4 heartbeat contract.
    if (toPhase === "connected") row.lease_expiry_ms = Date.now() + LEASE_MS;
    this.applyTransition(row, toPhase, typeof body.reason === "string" ? body.reason : "transition", mutationUuid);
    this.persistRow(row);

    const result: MutationResult = {
      ok: true,
      decision: "allow",
      epoch: row.epoch,
      phase: row.phase ?? toPhase,
      busy: this.isBusy(row),
      busy_reason: this.busyReasonFor(row),
      call_id: row.call_id,
    };
    this.rememberMutation(mutationUuid, result);
    return Response.json(result);
  }

  /** GET|POST /query — queryBusy(peer). Read-only; never mutates epoch/state. */
  private handleQuery(): Response {
    const row = this.loadRow(); // read-only aside from the lease-expiry auto-release
    const result: MutationResult = {
      ok: true,
      decision: this.isBusy(row) ? "busy" : "allow",
      epoch: row.epoch,
      phase: row.phase ?? "idle",
      busy: this.isBusy(row),
      busy_reason: this.busyReasonFor(row),
      call_id: row.call_id,
    };
    return Response.json(result);
  }

  /** POST /reserve-callback — reserveCallback(peer,call_id,ttl,expected_epoch).
   *  Sets callback_reserved_peer, expires=+8s, phase CALLBACK_RESERVED, epoch++. */
  private handleReserveCallback(body: Record<string, unknown>): Response {
    const mutationUuid = typeof body.mutation_uuid === "string" ? body.mutation_uuid : undefined;
    const cached = this.checkIdempotent(mutationUuid);
    if (cached) return Response.json(cached);

    const row = this.loadRow();
    const expectedEpoch = typeof body.expected_epoch === "number" ? body.expected_epoch : row.epoch;
    if (!this.casOk(row, expectedEpoch)) return this.conflict(row.epoch);

    const peer = typeof body.peer === "string" ? body.peer : "";
    const callId = typeof body.call_id === "string" ? body.call_id : row.call_id;
    const ttlMs = typeof body.ttl_ms === "number" && body.ttl_ms > 0 ? body.ttl_ms : CALLBACK_RESERVATION_TTL_MS;
    const expiresAt = Date.now() + ttlMs;

    row.callback_reserved_peer = peer || null;
    row.callback_reservation_until = expiresAt;
    row.call_id = callId ?? row.call_id;
    this.applyTransition(row, "callback_reserved", "reserve_callback", mutationUuid);
    this.persistRow(row);

    this.sql.exec(
      `INSERT INTO reservations (peer_uid, reservation_type, expires_at, epoch) VALUES (?,?,?,?)`,
      peer, "callback", expiresAt, row.epoch,
    );
    // Best-effort sweep of expired reservations so the table never grows unbounded.
    try { this.sql.exec(`DELETE FROM reservations WHERE expires_at < ?`, Date.now()); } catch { /* best-effort */ }

    const reservationId = crypto.randomUUID();
    const result: MutationResult = {
      ok: true,
      decision: "allow",
      epoch: row.epoch,
      phase: row.phase ?? "callback_reserved",
      busy: true,
      busy_reason: "callback_reserved",
      call_id: row.call_id,
      reservation: { reservation_id: reservationId, authority_epoch: row.epoch, expires_at: expiresAt, peer_uid: peer },
    };
    this.rememberMutation(mutationUuid, result);
    return Response.json(result);
  }

  /** POST /preempt-callback — preemptForCallback(caller,target,call_id,reservation,expected_epoch).
   *  If phase==RECEPTIONIST_ACTIVE && receptionist_target==caller -> PREEMPT, epoch++;
   *  else ALLOW/BUSY. */
  private handlePreemptCallback(body: Record<string, unknown>): Response {
    const mutationUuid = typeof body.mutation_uuid === "string" ? body.mutation_uuid : undefined;
    const cached = this.checkIdempotent(mutationUuid);
    if (cached) return Response.json(cached);

    const row = this.loadRow();
    const expectedEpoch = typeof body.expected_epoch === "number" ? body.expected_epoch : row.epoch;
    if (!this.casOk(row, expectedEpoch)) return this.conflict(row.epoch);

    const caller = typeof body.caller === "string" ? body.caller : "";
    const callId = typeof body.call_id === "string" ? body.call_id : row.call_id;

    if (row.phase === "receptionist_active" && row.receptionist_target_uid === caller) {
      row.call_id = callId ?? row.call_id;
      this.applyTransition(row, "callback_reserved", "preempt_receptionist", mutationUuid);
      row.callback_reserved_peer = caller || null;
      row.callback_reservation_until = Date.now() + CALLBACK_RESERVATION_TTL_MS;
      this.persistRow(row);

      const result: MutationResult = {
        ok: true,
        decision: "preempt",
        epoch: row.epoch,
        phase: row.phase ?? "callback_reserved",
        busy: true,
        busy_reason: "callback_reserved",
        call_id: row.call_id,
      };
      this.rememberMutation(mutationUuid, result);
      return Response.json(result);
    }

    const busy = this.isBusy(row);
    const result: MutationResult = {
      ok: true,
      decision: busy ? "busy" : "allow",
      epoch: row.epoch,
      phase: row.phase ?? "idle",
      busy,
      busy_reason: this.busyReasonFor(row),
      call_id: row.call_id,
    };
    this.rememberMutation(mutationUuid, result);
    return Response.json(result);
  }

  /** POST /abandon-receptionist — abandonReceptionist(call_id,reason,mut,expected_epoch).
   *  Kill Ava cleanly: phase RELEASING, epoch++, (caller notifies ReceptionRoom and
   *  awaits ACK outside this DO), phase IDLE, epoch++.
   *  Phase A note: this DO does not itself RPC ReceptionRoom (nothing calls this DO
   *  yet); it performs the two local transitions the spec calls for and leaves the
   *  ReceptionRoom notify/ACK choreography to the future caller (Phase F, §5.2). */
  private handleAbandonReceptionist(body: Record<string, unknown>): Response {
    const mutationUuid = typeof body.mutation_uuid === "string" ? body.mutation_uuid : undefined;
    const cached = this.checkIdempotent(mutationUuid);
    if (cached) return Response.json(cached);

    const row = this.loadRow();
    const expectedEpoch = typeof body.expected_epoch === "number" ? body.expected_epoch : row.epoch;
    if (!this.casOk(row, expectedEpoch)) return this.conflict(row.epoch);

    const reason = typeof body.reason === "string" ? body.reason : "abandon_receptionist";
    this.applyTransition(row, "releasing", reason, mutationUuid);
    this.persistRow(row);

    this.applyTransition(row, "idle", reason, mutationUuid);
    row.call_id = null;
    row.peer_uid = null;
    row.receptionist_target_uid = null;
    row.owner_session_id = null;
    row.owner_device_id = null;
    row.lease_expiry_ms = null;
    this.persistRow(row);

    const result: MutationResult = {
      ok: true,
      decision: "allow",
      epoch: row.epoch,
      phase: row.phase ?? "idle",
      busy: this.isBusy(row),
      busy_reason: this.busyReasonFor(row),
      call_id: row.call_id,
    };
    this.rememberMutation(mutationUuid, result);
    return Response.json(result);
  }

  /** POST /release — releaseCall(call_id,expected_epoch). CAS -> clear row, epoch++, IDLE. */
  private handleRelease(body: Record<string, unknown>): Response {
    const mutationUuid = typeof body.mutation_uuid === "string" ? body.mutation_uuid : undefined;
    const cached = this.checkIdempotent(mutationUuid);
    if (cached) return Response.json(cached);

    const row = this.loadRow();
    const expectedEpoch = typeof body.expected_epoch === "number" ? body.expected_epoch : row.epoch;
    if (!this.casOk(row, expectedEpoch)) return this.conflict(row.epoch);

    this.applyTransition(row, "idle", typeof body.reason === "string" ? body.reason : "release_call", mutationUuid);
    row.call_id = null;
    row.peer_uid = null;
    row.direction = null;
    row.rtc_provider = null;
    row.owner_session_id = null;
    row.owner_device_id = null;
    row.receptionist_target_uid = null;
    row.callback_reserved_peer = null;
    row.callback_reservation_until = null;
    row.callroom_id = null;
    row.lease_expiry_ms = null;
    this.persistRow(row);
    try { this.sql.exec(`DELETE FROM reservations WHERE expires_at < ?`, Date.now()); } catch { /* best-effort */ }

    const result: MutationResult = {
      ok: true,
      decision: "allow",
      epoch: row.epoch,
      phase: "idle",
      busy: false,
    };
    this.rememberMutation(mutationUuid, result);
    return Response.json(result);
  }
}
