// CallRoom — 1:1 call signaling relay (WebSocket Hibernation). One instance per
// room id. Pure coordination: relays WebRTC signaling between the two peers in a
// room; persists nothing durable beyond the short-lived reconnect-grace state
// below (per Rulebook, DOs are coordination, not storage).
//
// Protocol (must stay in lock-step with app/lib/features/avatok/call_screen.dart
// and the browser test client):
//   newcomer joins  → server sends {type:"welcome", id, peers:[...]} to it
//                     and {type:"peer-joined", id} to everyone already here
//   peer leaves     → server sends {type:"peer-left", id} to the rest
//   offer/answer/candidate/bye carry a `to` (peer id); the server stamps `from`
//   and forwards ONLY to that peer. A message with no `to` is broadcast.
//
// Role rule that avoids glare for 1:1: the NEWCOMER creates the offer to each
// existing peer (the client only calls createOffer() from the `welcome` handler).
// A dumb fan-out that never sends `welcome` leaves BOTH peers waiting and no call
// ever connects — this restores the handshake the client depends on.
//
// --- CALL-RC-D1: reconnect grace window (WS-D server half) -----------------
// A WS close/error (screen off, network blip, backgrounding) no longer ends
// the call instantly. The dropped peer is marked "away" for 30s:
//   webSocketClose/Error → do NOT send peer-left. Persist away state, send
//     {type:"peer-away", id} to the other peer, set a DO alarm for 30s.
//   same peer (identified by its `id` query-param tag, matched against the
//     room's own DO id as the callId) re-attaches within the window →
//     cancel the pending away/alarm, send {type:"peer-rejoined", id} to the
//     other peer, and replay any signaling messages that were buffered for
//     the away peer while it was gone (offer/answer/candidate; cap 100,
//     drop-oldest).
//   alarm fires and the peer is still away → send peer-left + close the room
//     (today's behavior, now delayed instead of removed).
//   An explicit {type:"bye"} (hangup) still ends the call immediately for
//     both sides — no grace, no alarm, matches existing behavior exactly.
// Only ONE peer can be "away" at a time in a 1:1 room; the 2-peer cap and
// the join/welcome/offer flow above are untouched.
//
// --- [WP2] Per-minute billing ticker (plan §3B/§11/§15.3) -------------------
// A paid call is "armed" via an internal POST /billing-arm right after the
// escrow hold succeeds (routes/call_billing_routes.ts, or the WP4 Mode-A
// agent path). Once armed, the DO's single alarm ALSO settles one minute
// every 60s (lib/call_billing.ts settleCallMinute) and, on any call-end path
// (bye/hangup, or the reconnect-grace alarm expiring), auto-refunds whatever
// escrow is left (lib/call_billing.ts refundUnused). This is multiplexed onto
// the SAME alarm the reconnect-grace window above already uses —
// scheduleNextAlarm() always re-arms for whichever purpose is due soonest.
// Signaling, the 2-peer cap, glare, and reconnect-grace are untouched by any
// of this.
import type { Env } from "../types";
import type { CallSnapshot } from "../lib/call_snapshot";
import type { ReasonCode } from "../lib/call_events";
import { settleCallMinute, refundUnused } from "../lib/call_billing";
import { brainIngest } from "../lib/brain_ingest";
import {
  applyCommand, authorizeCommand, deriveActor, newCallSession, commandForLegacyStatus,
  legacyWireStatus,
  type CallSession, type Command, type CommandName,
} from "../lib/call_state";

// [ONEBRAIN-B2] Human-readable call length for a brain summary (e.g. "4m12s").
function fmtCallDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

interface AwayPeer {
  id: string;
  awaySince: number;
  /** Signaling messages addressed to this peer while it was away, oldest first. */
  buffered: string[];
}

// [WP2] Per-minute billing ticker state (plan §3B/§11/§15.3). Armed by an
// internal POST /billing-arm (called from routes/call_billing_routes.ts right
// after the escrow hold succeeds, or by the WP4 Mode-A agent path). The DO's
// SINGLE alarm is multiplexed between this ticker and the pre-existing
// reconnect-grace alarm (see scheduleNextAlarm) — neither purpose can starve
// the other, and arming/disarming billing never touches the reconnect-grace
// logic, the 2-peer cap, glare, or signaling above.
interface BillingState {
  call_id: string;
  trace_id: string;
  caller_id: string;
  callee_id: string;
  billing_mode: "A" | "B";
  is_service_number: boolean;
  snapshot: CallSnapshot;
  minute_index: number; // next minute index to settle (0-based)
  next_tick: number;    // epoch ms — when the next minute settle is due
  max_minutes: number;  // hard cap (Mode A = agentMaxCallSec/60; Mode B = chosen length)
  stopped: boolean;
}

const RECONNECT_GRACE_MS = 30_000;
const MAX_BUFFERED_MESSAGES = 100;
const BILLING_TICK_MS = 60_000;

export class CallRoom {
  private state: DurableObjectState;
  private env: Env;
  /** In-memory mirror of the away peer, if any. Restored lazily from storage
   *  on first access after a DO restart/hibernation wake so a reconnect or
   *  the alarm still resolves correctly even if the instance was evicted. */
  private away: AwayPeer | null | undefined; // undefined = not loaded yet
  // CALL-KV-STATE-1: authoritative answered/ended state (replaces the KV flag).
  // In-memory mirrors; hydrated lazily from DO storage after hibernation/eviction.
  private answeredAt: number | null | undefined; // undefined = not loaded yet
  private answeredBy: string | null | undefined;
  private ended: boolean | undefined;
  // [AVACALL-RING-CANCEL-1] Durable terminal status for a call that ended BEFORE
  // (or without) the two peers ever connecting — most importantly a caller
  // `cancel` sent while the callee's ring push was still in flight. Written by
  // POST /mark-terminal (from routes/api.ts callStatus) and by an explicit
  // bye/hangup/decline over the socket. Exposed via GET /state so the callee's
  // accept path (client [AVACALL-CANCEL-1]) and the push consumer's ring fan-out
  // can both refuse to ring / connect a call whose caller is already gone.
  private terminalStatus: string | null | undefined; // undefined = not loaded yet
  private terminalAt: number | null | undefined;
  /** [CALL-REDUCER-1 2026-08-01] Monotonic transition counter stamped on every
   *  authoritative status broadcast so clients can order and dedupe them.
   *  See broadcastStatus() for why in-memory is sufficient. */
  private transitionSeq = 0;
  /** [CALL-CMD-IDEMPOTENT-1 2026-08-01] commandId → the result that command
   *  produced, so a retry/replay returns the ORIGINAL outcome instead of
   *  performing the transition a second time. Insertion-ordered (JS Map) so
   *  eviction is oldest-first. See the /mark-terminal handler. */
  private seenCommands = new Map<string, Record<string, unknown>>();
  /** [CALL-FSM-1 2026-08-01] The multi-leg call aggregate. `undefined` = not yet
   *  loaded from storage; see loadSession(). The RULES live in lib/call_state.ts
   *  (pure); this DO owns only persistence and delivery. */
  private session: CallSession | undefined;
  // CALL-GEN-1: per-peer generation counter. Each accepted (re)join / reconnect of
  // a peer id bumps its gen; the 'welcome' tells the client its current gen, and it
  // stamps gen on every frame. A frame whose gen is LOWER than the DO's current gen
  // for that sender is a stale artifact from a superseded transport → dropped, so a
  // gen-1 zombie socket can never disrupt a gen-2 call. Persisted so it survives
  // hibernation/eviction (a re-hydrated DO must not hand out a lower gen).
  private gens: Record<string, number> | undefined; // undefined = not loaded yet
  // [CALL-REL-5] The peer id that sent the very FIRST 'offer' in this room —
  // the "original offerer" for deterministic recovery-offerer selection
  // (plan §7.3.3). Persisted so it survives hibernation/eviction.
  private originalOffererId: string | null | undefined; // undefined = not loaded yet
  // [CALL-REL-5] attemptId of the currently in-flight recovery request, or
  // null. A NEW 'recovery-request' reuses this exact id if it matches (both
  // peers requesting the same drop) or starts a fresh attempt otherwise.
  private activeRecoveryAttemptId: string | null | undefined;
  // [CALL-REL-6] attemptId of the currently in-flight relay migration, or
  // null; relay-migrate-* messages carrying any OTHER attemptId are dropped
  // (stale-attempt rejection, plan §7.4). `migrationUsed` enforces "MAX one
  // migration per call" even after the active attempt finishes/fails.
  private activeMigrationAttemptId: string | null | undefined;
  private migrationUsed: boolean | undefined;

  /** [CALL-REL-5/6] Hydrate the recovery/migration coordination fields from DO
   *  storage on first use. Does NOT touch generation state, the 2-peer cap, or
   *  reconnect-grace — entirely separate persisted keys. */
  private async loadRecoveryState(): Promise<void> {
    if (this.originalOffererId !== undefined) return;
    this.originalOffererId = (await this.state.storage.get<string>("originalOffererId")) ?? null;
    this.activeRecoveryAttemptId = (await this.state.storage.get<string>("activeRecoveryAttemptId")) ?? null;
    this.activeMigrationAttemptId = (await this.state.storage.get<string>("activeMigrationAttemptId")) ?? null;
    this.migrationUsed = (await this.state.storage.get<boolean>("migrationUsed")) ?? false;
  }

  /** [CALL-REL-5] A peer requested recovery. Picks the offerer deterministically
   *  (plan §7.3.3: "original offerer unless it is away; otherwise the
   *  connected peer with lexicographically lower stable peer id") and notifies
   *  BOTH peers with `recovery-offer`. Never relays the raw request — this
   *  fully replaces the generic `to`-scoped relay for this one message type.
   *  Contains NO SDP and NO PII, matching the generic relay's own payload
   *  shape (peer ids only). */
  private async handleRecoveryRequest(fromId: string, data: Record<string, unknown>): Promise<void> {
    await this.loadRecoveryState();
    const attemptId = typeof data.attemptId === "string" ? data.attemptId.slice(0, 64) : "";
    if (!attemptId || !fromId) return;
    if (this.activeRecoveryAttemptId === attemptId) return; // duplicate request, already answered
    this.activeRecoveryAttemptId = attemptId;
    try { await this.state.storage.put("activeRecoveryAttemptId", attemptId); } catch { /* best-effort */ }

    const all = this.state.getWebSockets();
    const ids = all
      .map((w) => this.state.getTags(w)[0])
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const away = await this.loadAway();
    const awayId = away?.id ?? null;

    let offererId: string | null =
      this.originalOffererId && this.originalOffererId !== awayId ? this.originalOffererId : null;
    if (!offererId) {
      const candidates = ids.filter((id) => id !== awayId);
      candidates.sort();
      offererId = candidates[0] ?? fromId;
    }

    const reason = typeof data.reason === "string" ? data.reason.slice(0, 40) : "unknown";
    const path = typeof data.path === "string" ? data.path.slice(0, 16) : "unknown";
    const payload = { type: "recovery-offer", attemptId, offererId, reason, path };
    for (const w of all) this.sendTo(w, payload);
  }

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** CALL-KV-STATE-1: hydrate answered/ended state from DO storage on first use
   *  after a restart so GET /state is correct even if the instance was evicted. */
  private async loadCallState(): Promise<void> {
    if (this.answeredAt !== undefined) return;
    this.answeredAt = (await this.state.storage.get<number>("answeredAt")) ?? null;
    this.answeredBy = (await this.state.storage.get<string>("answeredBy")) ?? null;
    this.ended = (await this.state.storage.get<boolean>("ended")) ?? false;
    // [AVACALL-RING-CANCEL-1] hydrate durable terminal status alongside the rest.
    this.terminalStatus = (await this.state.storage.get<string>("terminalStatus")) ?? null;
    this.terminalAt = (await this.state.storage.get<number>("terminalAt")) ?? null;
  }

  /** [AVACALL-RING-CANCEL-1] Persist a terminal status (cancel/bye/ended/decline)
   *  for this call so a late accept and an in-flight ring push both learn the
   *  caller is already gone. Records ONLY terminalStatus/terminalAt — it must
   *  NOT flip `ended`, because markEnded() guards billing settlement + brain
   *  ingest on `wasEnded`; pre-flipping `ended` here would make a normal
   *  bye/hangup skip stopBilling()/refundUnused() and the call_completed ingest
   *  ([AVACALL-RING-CANCEL-2] fix). Every terminal-status consumer keys off
   *  `terminal_status`, not `ended`, so suppression is unaffected.
   *  Idempotent + never throws — a status write must not break signaling.
   *
   *  [CALL-TERMINAL-BCAST-1 2026-08-01] MONOTONIC. The first terminal status to
   *  land wins and is IMMUTABLE; a later/racing terminal request must NOT
   *  overwrite it. Before this, a `decline` could be silently replaced by the
   *  caller's own follow-up `cancel`, so `/api/call-state` reported the wrong
   *  reason and a late `accept` could revive a call the callee had rejected.
   *  Returns whether this call was already terminal so callers can report it. */
  private async markTerminal(status: string): Promise<{ already: boolean; status: string }> {
    await this.loadCallState();
    if (this.terminalStatus) {
      // Already terminal — immutable. Do not rewrite storage, do not move terminalAt.
      return { already: true, status: this.terminalStatus };
    }
    const s = (status || "ended").slice(0, 24);
    this.terminalStatus = s;
    this.terminalAt = Date.now();
    try { await this.state.storage.put("terminalStatus", s); } catch { /* best-effort */ }
    try { await this.state.storage.put("terminalAt", this.terminalAt); } catch { /* best-effort */ }
    return { already: false, status: s };
  }

  /** [CALL-TERMINAL-BCAST-1 2026-08-01] Push a call-status frame to every socket
   *  attached to this room, so the OTHER party learns about it over the live
   *  WebSocket it is already holding instead of waiting on the FCM queue.
   *
   *  ROOT CAUSE this fixes (prod call avatok-f0c0ef5c, 2026-08-01 01:31 UTC): the
   *  callee declined at 01:31:47.66; `/mark-terminal` wrote storage and told
   *  NOBODY; the caller only learned via FCM at 01:31:53.06 — 5.4s of ringback
   *  into a call that was already over. The caller was attached to THIS DO the
   *  whole time. `/ring-ack` above already fans out this way; the terminal path
   *  simply never did.
   *
   *  Deliberately separate from markTerminal(): non-terminal handoff statuses
   *  (`decline_ava`, `decline_agent`) must reach the caller instantly WITHOUT
   *  marking the call terminal, or the caller's CallSession would tear down
   *  before it could hand the leg to the receptionist.
   *
   *  Hibernation-safe: an inbound fetch() wakes the DO and getWebSockets()
   *  returns the currently-attached sockets. A detached caller yields 0 sends —
   *  which is exactly why the FCM queue path stays as the durable backstop. */
  // ── [CALL-FSM-1 2026-08-01] THE COMMAND PIPELINE ──────────────────────────
  //
  // Every call outcome now enters through here. The DO's job is narrow on
  // purpose: load the aggregate, hand the command to the PURE reducer in
  // lib/call_state.ts, persist whatever came back, broadcast it, return it.
  // It does not decide anything. All the rules — which transitions are legal,
  // which outcomes end the caller's leg, which keep it alive — live in one
  // readable file that can be unit-tested without a network.

  /** Hydrate the aggregate from storage on first touch after an eviction. */
  private async loadSession(callId: string): Promise<CallSession> {
    if (this.session) return this.session;
    const stored = await this.state.storage.get<CallSession>("fsm").catch(() => undefined);
    this.session = stored ?? newCallSession(callId, Date.now());
    return this.session;
  }

  /**
   * Execute one command against the aggregate.
   *
   * Idempotent by `command_id`: a retry, an FCM action replay or a double-tap
   * returns the ORIGINAL result rather than transitioning again. Returning the
   * original (not an error) is what makes it safe for a client to retry freely.
   *
   * A rejected command returns the CURRENT authoritative state rather than an
   * error alone, so a stale device can reconcile — e.g. render "answered on
   * another device" — instead of inventing its own outcome. That is the whole
   * point: a loser in a race must be TOLD what actually happened.
   */
  private async runCommand(
    callId: string, name: CommandName, actor: Command["actor"],
    opts: {
      commandId?: string; expectedEpoch?: number; data?: Record<string, unknown>;
      /** [CALL-AUTHZ-1] When present, `actor` is IGNORED and derived from the
       *  persisted participants instead. Every client-originated command must
       *  pass this. Only internal server-driven transitions omit it. */
      authenticatedUid?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (opts.commandId) {
      const prior = this.seenCommands.get(opts.commandId);
      if (prior) return { ...prior, replayed: true };
      // [CALL-AUTHZ-1] Idempotency must survive a DO eviction. seenCommands is
      // in-memory, so before this the first request after an eviction would
      // re-run a command that had already been applied. The durable copy is the
      // authority; the map is just a hot cache in front of it.
      const durable = await this.state.storage.get<Record<string, unknown>>(`cmd:${opts.commandId}`).catch(() => undefined);
      if (durable) { this.seenCommands.set(opts.commandId, durable); return { ...durable, replayed: true }; }
    }

    const loaded = await this.loadSession(callId);
    // ── GATE 1: MEMBERSHIP ────────────────────────────────────────────────
    // Is this authenticated user actually on this call? Answered from the
    // persisted record, never from the request. This is the gate whose absence
    // meant anyone holding a call id could act on a stranger's call.
    let effectiveActor = actor;
    if (opts.authenticatedUid !== undefined) {
      const derived = deriveActor(loaded, opts.authenticatedUid);
      if (!derived) {
        return {
          ok: false, error: "not_a_participant", command: name,
          // Deliberately no call state in the response: a non-participant must
          // not learn whether the call exists, who is on it, or what it is doing.
        };
      }
      effectiveActor = derived;
    }
    // ── GATE 2: CAPABILITY ────────────────────────────────────────────────
    // Given that they ARE the callee, may a callee do this?
    if (!authorizeCommand(name, effectiveActor)) {
      return { ok: false, error: "unauthorized", command: name, actor: effectiveActor };
    }
    actor = effectiveActor;

    const prev = loaded;
    const r = applyCommand(prev, { name, actor, command_id: opts.commandId, expected_epoch: opts.expectedEpoch, data: opts.data }, Date.now());

    if (!r.ok) {
      return {
        ok: false, error: r.error,
        // Hand back current truth so the loser of a race can reconcile.
        state: r.state, seq: r.state.transition_sequence, epoch: r.state.epoch,
      };
    }

    this.session = r.state;
    let fan = { seen: 0, sent: 0, seq: r.state.transition_sequence };
    if (r.changed) {
      try { await this.state.storage.put("fsm", r.state); } catch { /* best-effort */ }
      // Keep the legacy terminal marker in lock-step: /api/call-state and the
      // ring-suppression probe still read it, and they must never disagree with
      // the aggregate. Two sources of truth is the bug we are removing.
      if (r.state.session_state === "completed" && !this.terminalStatus) {
        await this.markTerminal(r.state.disposition);
      }
      fan = this.broadcastTransition(r.state, r.events, callId);
    }

    const result = {
      ok: true,
      command: name,
      changed: r.changed,
      events: r.events,
      session_state: r.state.session_state,
      caller_leg_state: r.state.caller_leg_state,
      callee_leg_state: r.state.callee_leg_state,
      service_leg_state: r.state.service_leg_state,
      disposition: r.state.disposition,
      epoch: r.state.epoch,
      seq: r.state.transition_sequence,
      sockets_seen: fan.seen,
      sockets_sent: fan.sent,
    };
    if (opts.commandId) {
      this.seenCommands.set(opts.commandId, result);
      // [CALL-AUTHZ-1] Durable copy so idempotency survives an eviction. Only
      // recorded for commands that actually CHANGED something — a rejected or
      // no-op command should stay retryable rather than be permanently pinned
      // to its failure.
      if (r.changed) {
        try { await this.state.storage.put(`cmd:${opts.commandId}`, result); } catch { /* best-effort */ }
      }
      if (this.seenCommands.size > 64) {
        const oldest = this.seenCommands.keys().next().value;
        if (oldest !== undefined) this.seenCommands.delete(oldest);
      }
    }
    return result;
  }

  /** [CALL-AUTHZ-1] Stamp the participants once, at admission, from the
   *  AUTHENTICATED caller uid and the dialled callee uid. Everything downstream
   *  derives membership from this, so it must be written before any
   *  client-originated command can be accepted. Idempotent. */
  private async setParticipants(callId: string, callerUid: string, calleeUid: string): Promise<void> {
    const s = await this.loadSession(callId);
    if (s.caller_uid && s.callee_uid) return; // already stamped
    s.caller_uid = callerUid || s.caller_uid;
    s.callee_uid = calleeUid || s.callee_uid;
    s.call_id = s.call_id || callId;
    this.session = s;
    try { await this.state.storage.put("fsm", s); } catch { /* best-effort */ }
  }

  /**
   * Broadcast an authoritative transition to every attached socket.
   *
   * Carries the FULL leg state, not just a status string. A client that missed
   * an earlier frame can reconcile from this one alone rather than trying to
   * infer where it is from a sequence of deltas. `type` keeps the legacy status
   * shape so shipped clients keep working unchanged.
   */
  private broadcastTransition(s: CallSession, events: string[], callId?: string): { seen: number; sent: number; seq: number } {
    let seen = 0, sent = 0;
    const frame = JSON.stringify({
      // [CALL-WIRE-COMPAT-1 2026-08-01] `type` MUST be a legacy status string.
      //
      // This previously emitted the DISPOSITION or the LEG STATE — so a decline
      // went out as `declined`, and every shipped client switches on `decline`.
      // Old callers fell through to `default`, ignored the frame entirely, and
      // kept ringing until their own ring-timeout handed the caller to Ava.
      // Confirmed in prod: call avatok-b7741a74, decline at 09:09:21.8,
      // DO broadcast delivered (sockets_sent=1) at 09:09:23.4, caller ignored
      // it and started the receptionist at 09:09:27.0 with
      // activation_mode "rings" — the ring TIMEOUT, not the decline.
      //
      // I had written "keeps the legacy status shape" in this very comment and
      // it did not. The vocabulary a shipped client understands is a CONTRACT;
      // the FSM's internal names are not part of it. New clients read `fsm`.
      type: legacyWireStatus(s),
      ...(callId ? { callId } : {}),
      fsm: {
        session_state: s.session_state,
        caller_leg_state: s.caller_leg_state,
        callee_leg_state: s.callee_leg_state,
        service_leg_state: s.service_leg_state,
        disposition: s.disposition,
      },
      events,
      epoch: s.epoch,
      seq: s.transition_sequence,
      terminalAt: this.terminalAt ?? Date.now(),
      src: "do",
    });
    for (const w of this.state.getWebSockets()) {
      seen++;
      try { w.send(frame); sent++; } catch { /* stale socket */ }
    }
    return { seen, sent, seq: s.transition_sequence };
  }

  private broadcastStatus(status: string, callId?: string, extra?: Record<string, unknown>): { seen: number; sent: number; seq: number } {
    let seen = 0, sent = 0;
    // [CALL-REDUCER-1 2026-08-01] MONOTONIC TRANSITION SEQUENCE.
    //
    // Every authoritative transition carries a strictly increasing `seq`, so a
    // client can ORDER what it receives and drop anything stale. Without this a
    // late FCM redelivery, a socket reconnect replay, a duplicate queue message
    // or a multi-device race can all re-apply an OLD transition on top of a
    // newer one — which is how a call that had already moved on could snap back
    // to a ringing UI. The client reducer (push_service.applyRingTransition)
    // refuses any seq <= the one it has already applied.
    //
    // In-memory is sufficient and correct here: the sequence only has to be
    // monotonic within one call's lifetime, and a DO eviction mid-call would
    // also drop the sockets this is broadcast to. Persisting it would add a
    // storage write to the latency-critical decline path for no benefit.
    this.transitionSeq = (this.transitionSeq ?? 0) + 1;
    const frame = JSON.stringify({
      type: status,
      ...(callId ? { callId } : {}),
      ...(extra ?? {}),
      terminalAt: this.terminalAt ?? Date.now(),
      seq: this.transitionSeq,
      src: "do",
    });
    for (const w of this.state.getWebSockets()) {
      seen++;
      // Count successful send() calls, not attached sockets — a stale socket
      // throws here and must not be reported to the caller as a delivery.
      try { w.send(frame); sent++; } catch { /* stale socket */ }
    }
    return { seen, sent, seq: this.transitionSeq };
  }

  /** [WP2] `reason` drives the refund event's ReasonCode when this transition
   *  also disarms billing — defaults to NETWORK (the reconnect-grace-expiry
   *  path); the explicit bye/hangup call site passes a more specific code.
   *  Guarded so a call end is only "handled" once even if markEnded() is
   *  invoked again later (e.g. a stray alarm after an explicit hangup). */
  private async markEnded(reason: ReasonCode = "NETWORK"): Promise<void> {
    const wasEnded = this.ended === true;
    this.ended = true;
    try { await this.state.storage.put("ended", true); } catch { /* best-effort */ }
    if (!wasEnded) {
      // [ONEBRAIN-B2] Record the completed call in the brain BEFORE stopBilling
      // clears the billing state (which holds the two account ids). Fire-and-forget
      // inside a guard so a brain hiccup can never affect call teardown.
      try { await this.ingestCallCompleted(); } catch { /* best-effort */ }
      await this.stopBilling(reason);
    }
  }

  /** [ONEBRAIN-B2] Emit one `call_completed` brain event per participant when a
   *  paid, ANSWERED call ends. Paid because the billing state is the only place the
   *  DO holds both account ids; answered because a never-connected call is a missed
   *  call (missedcall.ts owns the `missed` domain), not a completed one. sourceId is
   *  the call id, so a redelivered/duplicate teardown collapses to one row per uid.
   *  Text carries only the duration (no numbers); ids live in meta (§ contract). */
  private async ingestCallCompleted(): Promise<void> {
    const b = await this.loadBilling();
    if (!b) return; // free call — no server-side account ids in this DO
    await this.loadCallState();
    if (!this.answeredAt) return; // never connected → missed, not completed
    const durationSec = Math.max(0, Math.round((Date.now() - this.answeredAt) / 1000));
    const dur = fmtCallDuration(durationSec);
    // caller placed the call → outgoing (peer = callee); callee → incoming.
    void brainIngest(this.env, {
      uid: b.caller_id, domain: "calls", kind: "call_completed", sourceId: b.call_id,
      text: `Call ${dur}, outgoing`,
      meta: { peer: b.callee_id, duration: durationSec, direction: "outgoing" },
    });
    void brainIngest(this.env, {
      uid: b.callee_id, domain: "calls", kind: "call_completed", sourceId: b.call_id,
      text: `Call ${dur}, incoming`,
      meta: { peer: b.caller_id, duration: durationSec, direction: "incoming" },
    });
  }

  /** CALL-GEN-1: bump + return the new generation for a peer id (accepted join/
   *  rejoin/reconnect). Hydrates the map from storage on first use, persists the
   *  bump so an evicted-then-rehydrated DO never regresses a peer's generation. */
  private async bumpGen(peerId: string): Promise<number> {
    if (this.gens === undefined) {
      this.gens = (await this.state.storage.get<Record<string, number>>("gens")) ?? {};
    }
    const next = (this.gens[peerId] ?? 0) + 1;
    this.gens[peerId] = next;
    try { await this.state.storage.put("gens", this.gens); } catch { /* best-effort */ }
    return next;
  }

  private async currentGen(peerId: string): Promise<number> {
    if (this.gens === undefined) {
      this.gens = (await this.state.storage.get<Record<string, number>>("gens")) ?? {};
    }
    return this.gens[peerId] ?? 0;
  }

  /** CALL-GEN-1: fire-and-forget telemetry when a stale-gen frame was dropped.
   *  Follows the inbox.ts invariant_protected pattern; never on the critical path. */
  private reportStaleGen(peerId: string, frameGen: number, curGen: number, type: string): void {
    try {
      void this.env.Q_ANALYTICS.send({
        event: "invariant_protected", uid: peerId, ts: Date.now(),
        props: {
          kind: "stale_generation_rejected", side: "server",
          frame_gen: frameGen, current_gen: curGen, frame_type: type,
          call_id: this.state.id.name ? String(this.state.id.name).slice(0, 64) : null,
          app_name: "avatok", service_name: "avatok-api", worker: true,
        },
      });
    } catch { /* best-effort — telemetry never blocks or breaks signaling */ }
  }

  private async loadAway(): Promise<AwayPeer | null> {
    if (this.away !== undefined) return this.away;
    const stored = await this.state.storage.get<AwayPeer>("awayPeer");
    this.away = stored ?? null;
    return this.away;
  }

  private async setAway(peer: AwayPeer | null): Promise<void> {
    this.away = peer;
    if (peer) await this.state.storage.put("awayPeer", peer);
    else await this.state.storage.delete("awayPeer");
  }

  // ---------------------------------------------------------------------
  // [WP2] Billing ticker (plan §3B/§11/§15.3) — multiplexed onto the SAME
  // single DO alarm the reconnect-grace logic already uses. Neither purpose
  // is aware of the other beyond scheduleNextAlarm() picking whichever is
  // due soonest; reconnect-grace behaviour above is untouched.
  // ---------------------------------------------------------------------
  private billing: BillingState | null | undefined; // undefined = not loaded yet

  private async loadBilling(): Promise<BillingState | null> {
    if (this.billing !== undefined) return this.billing;
    const stored = await this.state.storage.get<BillingState>("billing");
    this.billing = stored ?? null;
    return this.billing;
  }

  private async setBilling(b: BillingState | null): Promise<void> {
    this.billing = b;
    if (b) await this.state.storage.put("billing", b);
    else await this.state.storage.delete("billing");
  }

  /** Recompute the single DO alarm as the EARLIEST of (a) a pending reconnect-
   *  grace expiry and (b) a pending billing tick. If neither is pending, the
   *  alarm is cleared. Call this after ANY change to either purpose's state —
   *  it is the only place that touches state.storage.setAlarm/deleteAlarm for
   *  these two purposes, so they can never clobber each other. */
  private async scheduleNextAlarm(): Promise<void> {
    const away = await this.loadAway();
    const billing = await this.loadBilling();
    const candidates: number[] = [];
    if (away) candidates.push(away.awaySince + RECONNECT_GRACE_MS);
    if (billing && !billing.stopped) candidates.push(billing.next_tick);
    if (candidates.length === 0) {
      try { await this.state.storage.deleteAlarm(); } catch { /* no alarm set */ }
      return;
    }
    try { await this.state.storage.setAlarm(Math.min(...candidates)); } catch { /* best-effort */ }
  }

  /** Arm the per-minute ticker for a paid call that just connected. Idempotent
   *  re-arm (e.g. a retried /billing-arm) simply overwrites the state with a
   *  fresh next_tick — safe because settleCallMinute is itself idempotent per
   *  minute_index, so at worst a re-arm restarts the minute clock, never
   *  double-charges. */
  private async armBilling(b: Omit<BillingState, "minute_index" | "next_tick" | "stopped">): Promise<void> {
    await this.setBilling({ ...b, minute_index: 0, next_tick: Date.now() + BILLING_TICK_MS, stopped: false });
    await this.scheduleNextAlarm();
  }

  /** Disarm the ticker: round UP the in-progress partial minute to one whole
   *  settled minute (plan §11, owner decision 2026-07-11 — supersedes the
   *  earlier round-down rule: "a started minute counts as a whole minute"),
   *  THEN refund whatever's left in escrow. Safe to call more than once
   *  (settleCallMinute and refundUnused are both idempotent per call_id/
   *  minute_index, and a second call here is a no-op once `billing` is
   *  cleared). Never throws — a billing hiccup must never break call teardown.
   *
   *  Guard against over-settling: `b.minute_index` is only ever a minute the
   *  60s ticker has NOT yet settled (tickBilling disarms billing entirely
   *  once max_minutes is reached, so a live `billing` state here always has
   *  minute_index < max_minutes), and settleCallMinute itself clamps to
   *  whatever remains in the call's escrow (escrowBalance), so this can never
   *  settle more than was actually held for the call. */
  private async stopBilling(reason: ReasonCode): Promise<void> {
    const b = await this.loadBilling();
    if (!b || b.stopped) return;
    await this.setBilling({ ...b, stopped: true });
    if (b.minute_index < b.max_minutes) {
      try {
        await settleCallMinute(this.env, {
          call_id: b.call_id, trace_id: b.trace_id, caller_id: b.caller_id, callee_id: b.callee_id,
          minute_index: b.minute_index, snapshot: b.snapshot, is_service_number: b.is_service_number,
          billing_mode: b.billing_mode,
        });
      } catch { /* best-effort — an unsettled partial minute just refunds instead below */ }
    }
    try {
      await refundUnused(this.env, {
        call_id: b.call_id, trace_id: b.trace_id, caller_id: b.caller_id, callee_id: b.callee_id,
        caller_or_callee_id: b.billing_mode === "A" ? b.callee_id : b.caller_id,
        reason, billing_mode: b.billing_mode,
      });
    } catch { /* best-effort — teardown must proceed regardless */ }
    await this.setBilling(null);
    await this.scheduleNextAlarm();
  }

  /** Settle one delivered minute and advance the ticker, capping at
   *  max_minutes (Mode A = agentMaxCallSec/60, Mode B = the chosen length).
   *  Hitting the cap disarms billing (refunds nothing further — the escrow is
   *  fully consumed by definition at the cap) rather than refunding, since a
   *  cap-out is "call completed its full paid length", not an early end. */
  private async tickBilling(b: BillingState): Promise<void> {
    try {
      await settleCallMinute(this.env, {
        call_id: b.call_id, trace_id: b.trace_id, caller_id: b.caller_id, callee_id: b.callee_id,
        minute_index: b.minute_index, snapshot: b.snapshot, is_service_number: b.is_service_number,
        billing_mode: b.billing_mode,
      });
    } catch { /* best-effort — a settle hiccup must never break signaling; next tick retries the NEXT minute */ }
    const nextIndex = b.minute_index + 1;
    if (nextIndex >= b.max_minutes) {
      // Full paid length delivered — nothing left to refund, just disarm.
      await this.setBilling(null);
      await this.scheduleNextAlarm();
      return;
    }
    await this.setBilling({ ...b, minute_index: nextIndex, next_tick: Date.now() + BILLING_TICK_MS });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      // CALL-KV-STATE-1: internal state probe. receptionist.ts asks the DO
      // (env.CALL_ROOMS.idFromName(callId).fetch('https://call/state')) whether the
      // call was already answered before spawning Ava — the DO is strongly
      // consistent, unlike the KV flag this replaces. No auth: DO fetch is only
      // reachable from within the same Worker (never client-exposed).
      const stateUrl = new URL(req.url);
      if (req.method === "GET" && stateUrl.pathname.endsWith("/state")) {
        await this.loadCallState();
        return Response.json({
          answered: this.answeredAt != null,
          answered_at: this.answeredAt ?? null,
          answered_by: this.answeredBy ?? null,
          ended: this.ended === true,
          // [AVACALL-RING-CANCEL-1] Durable terminal status (e.g. 'cancel') set by
          // a caller who ended before the callee connected — null when the call is
          // still live. The accept path + ring fan-out both key off this.
          terminal_status: this.terminalStatus ?? null,
          terminal_at: this.terminalAt ?? null,
          // CALL-ANSWERED-LIVE-1: how many transports are on the call RIGHT NOW.
          // `answered` is sticky (set the instant a 2nd socket ever joined), so a
          // transient/zombie join — e.g. an offline callee's FCM-woken socket that
          // dies before media, or a caller reconnect with a fresh tag — leaves
          // answered=true forever even though no real conversation happened. That
          // stale flag was vetoing the unreachable→Ava handoff with 409
          // call_answered (PostHog: /api/receptionist/start 409, call avatok-8caef3ce
          // 2026-07-08). Exposing the LIVE peer count lets the receptionist gate
          // distinguish "genuinely on a call now" (>=2) from "phantom-answered".
          peers: this.state.getWebSockets().length,
        });
      }
      // P1 ring-ack control-plane (Phase 1, receptTakeoverGuard). A server worker
      // (the FCM push consumer) POSTs the outcome of the incoming-call push so the
      // CALLER — the only peer in the room during ring — learns whether the callee's
      // phone could ring. Broadcast to every connected socket (only the caller is
      // here pre-answer); the client ignores unknown frames when the flag is OFF.
      // No sockets connected → harmless no-op. Never persists anything.
      // [CALL-GLARE-2] Deterministic mutual-dial (glare) resolution — server side.
      // This DO instance is addressed by a PAIR key (glare:<lo>__<hi>), NOT a call
      // id, so both directions of a mutual dial land on the SAME instance. On each
      // place, we record the placer's pending invite (callId + placer uid + ts) and
      // check whether the OTHER party already has a live pending invite (a reciprocal
      // dial) within the 30s glare window. If so the two calls are folded into ONE:
      // the lexicographically SMALLER callId wins as "the call", and BOTH placers are
      // told to auto-accept it instead of opening a second room. DO storage is
      // strongly consistent (no ordered state in KV), and this holds no socket.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/glare-place")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const placer = typeof body.placer === "string" ? body.placer : "";
        const peer = typeof body.peer === "string" ? body.peer : "";
        const callId = typeof body.callId === "string" ? body.callId : "";
        if (!placer || !peer || !callId) {
          return Response.json({ error: "placer, peer, callId required" }, { status: 400 });
        }
        const GLARE_MS = 30_000;
        const now = Date.now();
        // Reciprocal = a pending invite recorded by the PEER (peer→placer) still
        // inside the window. Stored per-direction keyed by the placer uid.
        const recip = await this.state.storage.get<{ callId: string; ts: number }>(`glare_invite:${peer}`);
        if (recip && recip.callId && recip.callId !== callId && now - recip.ts < GLARE_MS) {
          // Mutual dial detected. Deterministic winner = smaller callId (both sides
          // compute the SAME verdict from the same two ids). Clear both pendings so a
          // later unrelated dial isn't mis-folded, and tell THIS placer to auto-accept
          // the winner (their own client CALL-GLARE-1 stays as the fallback).
          const winner = callId < recip.callId ? callId : recip.callId;
          try { await this.state.storage.delete(`glare_invite:${placer}`); } catch { /* best-effort */ }
          try { await this.state.storage.delete(`glare_invite:${peer}`); } catch { /* best-effort */ }
          try {
            void this.env.Q_ANALYTICS.send({
              event: "call_glare_autoconnect", uid: placer, ts: now,
              props: {
                winner_call_id: winner, this_call_id: callId, peer_call_id: recip.callId,
                app_name: "avatok", service_name: "avatok-api", worker: true,
              },
            });
          } catch { /* best-effort telemetry */ }
          return Response.json({ glare: true, join_call_id: winner });
        }
        // No reciprocal yet — record this placer's pending invite for the window.
        try { await this.state.storage.put(`glare_invite:${placer}`, { callId, ts: now }); } catch { /* best-effort */ }
        return Response.json({ glare: false });
      }
      // [WP2] Internal-only: arm the per-minute billing ticker once a paid call
      // connects (called from routes/call_billing_routes.ts right after the
      // escrow hold succeeds, or the WP4 Mode-A agent path). No auth — same
      // trust boundary as GET /state and /glare-place (only reachable from
      // within this Worker, never client-exposed). Does not touch signaling,
      // the 2-peer cap, glare, or reconnect-grace state.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/billing-arm")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const call_id = typeof body.call_id === "string" ? body.call_id : "";
        const trace_id = typeof body.trace_id === "string" ? body.trace_id : "";
        const caller_id = typeof body.caller_id === "string" ? body.caller_id : "";
        const callee_id = typeof body.callee_id === "string" ? body.callee_id : "";
        const billing_mode = body.billing_mode === "A" || body.billing_mode === "B" ? body.billing_mode : null;
        const snapshot = body.snapshot as CallSnapshot | undefined;
        const max_minutes = typeof body.max_minutes === "number" ? body.max_minutes : 0;
        if (!call_id || !trace_id || !caller_id || !callee_id || !billing_mode || !snapshot || !(max_minutes > 0)) {
          return Response.json({ error: "call_id, trace_id, caller_id, callee_id, billing_mode, snapshot, max_minutes required" }, { status: 400 });
        }
        await this.armBilling({
          call_id, trace_id, caller_id, callee_id, billing_mode, snapshot, max_minutes,
          is_service_number: body.is_service_number === true,
        });
        return Response.json({ ok: true, armed: true, next_tick: (await this.loadBilling())?.next_tick ?? null });
      }
      // [WP2] Internal-only: explicit disarm (e.g. a caller/callee abandons the
      // price prompt before the DO ever sees a second peer, or an upstream
      // route needs to cancel billing without a WS close/bye ever happening).
      if (req.method === "POST" && stateUrl.pathname.endsWith("/billing-disarm")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const reason = (typeof body.reason === "string" ? body.reason : "NETWORK") as ReasonCode;
        await this.stopBilling(reason);
        return Response.json({ ok: true, disarmed: true });
      }
      // ── [CALL-FSM-1 2026-08-01] THE SINGLE COMMAND ENDPOINT ─────────────────
      // Every call outcome enters here. The DO validates authorization and
      // epoch, hands the command to the pure reducer, persists, broadcasts and
      // returns the resulting state. Nothing else in the system decides what a
      // call outcome means.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/command")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const name = String(body.command ?? "") as CommandName;
        const callId = typeof body.callId === "string" ? body.callId : "";
        if (!name) return Response.json({ error: "command required" }, { status: 400 });
        // [CALL-AUTHZ-1] `authenticatedUid` is the ONLY identity input accepted
        // from the route. There is deliberately no way to pass an `actor` here:
        // the DO derives it from the persisted participants, so a compromised or
        // buggy Worker route still cannot let someone act on a stranger's call.
        const authenticatedUid = typeof body.authenticatedUid === "string" ? body.authenticatedUid : "";
        if (!authenticatedUid) return Response.json({ error: "authenticatedUid required" }, { status: 400 });
        const out = await this.runCommand(callId, name, "server", {
          authenticatedUid,
          commandId: typeof body.commandId === "string" ? body.commandId.slice(0, 128) : undefined,
          expectedEpoch: typeof body.expectedEpoch === "number" ? body.expectedEpoch : undefined,
          data: (body.data ?? undefined) as Record<string, unknown> | undefined,
        });
        // A rejected command is a normal, expected outcome (a stale device, a
        // replay, a race loser) — not a server error. 409 tells the client
        // "your view is out of date, here is the truth" without it being logged
        // as a failure. 403 is a genuine authorization refusal.
        const denied = out.error === "unauthorized" || out.error === "not_a_participant";
        return Response.json(out, { status: out.ok === false ? (denied ? 403 : 409) : 200 });
      }
      // [CALL-AUTHZ-1] Internal-only: stamp the call's participants at
      // admission. Called from routes/api.ts call() with the AUTHENTICATED
      // caller uid and the dialled callee uid. Must happen before any
      // client-originated command can be authorized. Same trust boundary as
      // GET /state — only reachable from within this Worker.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/participants")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const callId = typeof body.callId === "string" ? body.callId : "";
        const callerUid = typeof body.callerUid === "string" ? body.callerUid : "";
        const calleeUid = typeof body.calleeUid === "string" ? body.calleeUid : "";
        if (!callerUid || !calleeUid) return Response.json({ error: "callerUid and calleeUid required" }, { status: 400 });
        await this.setParticipants(callId, callerUid, calleeUid);
        return Response.json({ ok: true });
      }
      // [CALL-FSM-1] Read the authoritative aggregate (late-joining client,
      // reconnect reconciliation, support debugging).
      if (req.method === "GET" && stateUrl.pathname.endsWith("/session")) {
        const s = await this.loadSession(stateUrl.searchParams.get("callId") ?? "");
        return Response.json({ ok: true, session: s });
      }
      // [AVACALL-RING-CANCEL-1] Internal-only: record that this call is terminal
      // (caller cancelled / ended before connect). Called from routes/api.ts
      // callStatus when the caller POSTs a cancel/bye/ended status. Same trust
      // boundary as GET /state (only reachable within this Worker). Best-effort,
      // never touches the 2-peer cap / glare / reconnect-grace state.
      //
      // [CALL-TERMINAL-BCAST-1 2026-08-01] It now ALSO fans the status out to
      // every attached socket, making the DO the fast authoritative path instead
      // of a write-only marker (see broadcastStatus). `terminal:false` in the
      // body means "relay this to the peers but do NOT mark the call over" —
      // that is the decline_ava / decline_agent handoff lane.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/mark-terminal")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const status = typeof body.status === "string" ? body.status : "ended";
        const callId = typeof body.callId === "string" ? body.callId : undefined;
        // NOTE [CALL-FSM-2]: the old `terminal:false` flag is no longer read.
        // Whether an outcome is terminal is decided by the state machine, not
        // asserted by the caller — that was the loophole through which a
        // handoff could be mislabelled as terminal and kill the caller's leg.
        // [CALL-CMD-IDEMPOTENT-1 2026-08-01] Command-level idempotency.
        //
        // A `commandId` is minted ONCE per user action on the device. Retries,
        // FCM action replays, a double-tap and the app's own re-send after a
        // flaky network all carry the SAME id, so they collapse into one
        // transition instead of each bumping the sequence and re-broadcasting.
        //
        // Without this, the ordering fix alone is not enough: every duplicate
        // would still be a NEW, higher sequence, so every client would dutifully
        // apply it as if it were fresh. Ordering stops STALE work; this stops
        // DUPLICATE work. Both are needed.
        //
        // The replay returns the ORIGINAL result rather than an error, so the
        // caller cannot tell a retry from a first attempt — which is exactly
        // what makes it safe for the client to retry freely.
        const commandId = typeof body.commandId === "string" ? body.commandId.slice(0, 64) : "";
        if (commandId) {
          const prior = this.seenCommands.get(commandId);
          if (prior) return Response.json({ ...prior, replayed: true });
        }
        // [CALL-FSM-2 2026-08-01] THE LEGACY DECISION PATH IS GONE.
        //
        // What could NOT be deleted: the status-string API itself. Shipped
        // builds speak it and will until every install in the wild rolls over,
        // so `/api/call-status` stays. But an API is not a decision path — it is
        // a vocabulary. commandForLegacyStatus() translates it into a command
        // and the SAME state machine decides what happens. One set of rules,
        // reached through two vocabularies.
        //
        // What WAS deleted: the fallthrough. This used to run the FSM and then,
        // if the FSM did not report a change, ALSO run markTerminal +
        // broadcastStatus — a second, independent implementation of the same
        // decision, kept "as belt and braces during the migration window".
        //
        // That belt-and-braces was itself the bug. The FSM declines to change
        // state in exactly three cases — the command was a replay, the call is
        // already terminal, or the transition is illegal — and in ALL THREE the
        // correct action is to broadcast NOTHING. Re-broadcasting an old status
        // over a call that has already moved on is precisely how a dead ring
        // screen came back to life. The "safety net" was re-introducing the
        // failure it was meant to guard against.
        //
        // So: a status with a command mapping now ALWAYS returns the FSM result,
        // change or no change. `broadcastStatus` survives ONLY for statuses with
        // no aggregate meaning (`busy`), which are pure peer-to-peer relays and
        // never mutate call state.
        const legacy = commandForLegacyStatus(status);
        if (legacy) {
          const fsm = await this.runCommand(callId ?? "", legacy.name, legacy.actor, { commandId });
          return Response.json(fsm, { status: fsm.ok === false ? 409 : 200 });
        }
        // ── Non-state relay only (e.g. `busy`) ───────────────────────────────
        // These carry information for the peer's UI but say nothing about the
        // call's lifecycle, so there is no aggregate to advance and no risk of a
        // competing decision. markTerminal is deliberately NOT called here: a
        // status without a command mapping is by definition not terminal.
        await this.loadCallState();
        const fan = this.broadcastStatus(status, callId);
        const result = {
          ok: true,
          relay_only: true,
          terminal_status: this.terminalStatus ?? null,
          terminal_persisted: false,
          already_terminal: false,
          sockets_seen: fan.seen,
          sockets_sent: fan.sent,
          // [CALL-REDUCER-1] The caller (routes/api.ts) copies this onto the FCM
          // backstop so BOTH delivery paths carry the SAME sequence number.
          // If they carried different ones the client could not tell a socket
          // frame and its own FCM duplicate apart, and would apply both.
          seq: fan.seq,
        };
        if (commandId) {
          this.seenCommands.set(commandId, result);
          // Bounded: a call room is short-lived, but a pathological client could
          // otherwise grow this without limit. Oldest-first eviction is safe —
          // an evicted id can only ever be replayed as a fresh command, which is
          // the pre-idempotency behaviour, not a regression.
          if (this.seenCommands.size > 64) {
            const oldest = this.seenCommands.keys().next().value;
            if (oldest !== undefined) this.seenCommands.delete(oldest);
          }
        }
        return Response.json(result);
      }
      if (req.method === "POST") {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const type = typeof body.type === "string" ? body.type : "";

        if (type === "register-token") {
          const token = typeof body.token === "string" ? body.token : "";
          const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : 0;
          if (token && expiresAt) {
            await this.state.storage.put("ring_receipt_token", token);
            await this.state.storage.put("token_expires_at", expiresAt);
          }
          return Response.json({ ok: true });
        }

        if (type === "device-ringing") {
          const clientToken = typeof body.token === "string" ? body.token : "";
          const storedToken = await this.state.storage.get<string>("ring_receipt_token");
          const expiresAt = await this.state.storage.get<number>("token_expires_at") ?? 0;
          const now = Date.now();
          if (!storedToken || clientToken !== storedToken || now > expiresAt) {
            return Response.json({
              error: "invalid_or_expired_token",
              reason: !storedToken ? "no_token" : (now > expiresAt ? "expired" : "mismatch"),
            }, { status: 403 });
          }

          const frame = JSON.stringify({
            type: "device-ringing",
            ...(typeof body.callId === "string" ? { callId: body.callId } : {}),
          });
          let sent = 0;
          for (const w of this.state.getWebSockets()) {
            try { w.send(frame); sent++; } catch { /* peer gone */ }
          }
          return Response.json({ ok: true, sent });
        }

        if (type === "ring-ack") {
          const frame = JSON.stringify({
            type: "ring-ack",
            ok: body.ok === true,
            ...(typeof body.callId === "string" ? { callId: body.callId } : {}),
          });
          let sent = 0;
          for (const w of this.state.getWebSockets()) {
            try { w.send(frame); sent++; } catch { /* peer gone */ }
          }
          return Response.json({ ok: true, sent });
        }

        return Response.json({ error: "unknown control type" }, { status: 400 });
      }
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const peerId = (url.searchParams.get("id") || crypto.randomUUID()).slice(0, 64);

    // CALL-RC-D1: is this the SAME peer re-attaching within its grace window?
    // Identity = the `id` query-param tag (the only identity the client already
    // sends and reconnects with — there is no separate auth uid on this route).
    const away = await this.loadAway();
    const isRejoin = !!away && away.id === peerId;

    // CALL-DUP-SESSION-2 (server backstop): a join whose `id` ALREADY has a live
    // socket in this room is the same peer re-attaching on a fresh transport (a
    // reconnect that beat webSocketClose, or a duplicate accept leg that reused the
    // peer id) — NOT a genuine third participant. ADOPT the new socket and close the
    // stale one, rather than counting it toward the 2-peer cap and busy-rejecting it
    // (which, on the caller's client, tripped the busy handler that killed the live
    // call — PostHog avatok-3a2d4f15). We choose adopt-and-close over `already_joined`
    // to match the room's existing rejoin semantics (CALL-RC-D1 also swaps the peer's
    // transport in place), so the newest socket always wins and signaling stays live.
    const dupSockets = this.state
      .getWebSockets()
      .filter((w) => this.state.getTags(w)[0] === peerId);
    if (dupSockets.length > 0) {
      for (const stale of dupSockets) {
        try { stale.close(1000, "superseded by newer socket for same peer"); } catch { /* already gone */ }
      }
      try {
        void this.env.Q_ANALYTICS.send({
          event: "call_dup_session_blocked", uid: peerId, ts: Date.now(),
          props: {
            via: "server_adopt_same_peer", side: "server",
            call_id: this.state.id.name ? String(this.state.id.name).slice(0, 64) : null,
            app_name: "avatok", service_name: "avatok-api", worker: true,
          },
        });
      } catch { /* best-effort telemetry */ }
    }

    // STANDARD RULE: AvaTOK calls are strictly 1:1 (P2P). Never allow a third
    // participant — there are no group calls in AvaTOK (group calling lives in
    // AvaConsult). Refuse the join with a 'busy' so the extra caller ends cleanly.
    // An away-peer rejoin doesn't count against the cap: the stale socket for
    // that peer is already gone (webSocketClose already fired for it).
    // CALL-DUP-SESSION-2: count only sockets belonging to a DIFFERENT peer id — any
    // stale socket for THIS peer id was just adopted+closed above and must not push
    // us over the cap (a closed socket can still briefly appear in getWebSockets()).
    // So a same-peer reconnect/duplicate is never busy-rejected as a phantom 3rd peer.
    const otherPeerSockets = this.state
      .getWebSockets()
      .filter((w) => this.state.getTags(w)[0] !== peerId);
    if (!isRejoin && otherPeerSockets.length >= 2) {
      const reject = new WebSocketPair();
      reject[1].accept();
      try {
        reject[1].send(JSON.stringify({ type: "busy", reason: "AvaTOK calls are 1:1 only" }));
        reject[1].close(1000, "room full (1:1 only)");
      } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: reject[0] });
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // Hibernation: the runtime manages the socket; the peer id rides in the tag
    // so we can address messages and report joins/leaves across hibernation.
    this.state.acceptWebSocket(server, [peerId]);
    // Keepalive: let hibernated sockets answer client pings without waking the
    // DO (CALL-RC-D1 item 5). Same JSON ping/pong convention already used by
    // do/inbox.ts and do/party.ts — the WS-D client half (CallSession reconnect
    // state machine) sends jsonEncode({'type':'ping'}) every ~15s and expects
    // {"type":"pong"} back. The manual webSocketMessage handler never sees
    // these frames once auto-response is armed, so no extra handling needed
    // there; unmatched/older-client frames just fall through as before.
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ type: "ping" }),
          JSON.stringify({ type: "pong" }),
        ),
      );
    } catch { /* older runtimes without auto-response: harmless no-op */ }

    const others = this.state.getWebSockets().filter((ws) => ws !== server);
    const otherIds = others
      .map((ws) => this.state.getTags(ws)[0])
      .filter((x) => x && x !== peerId);

    if (isRejoin) {
      // Cancel the pending alarm/away-state and tell the other peer we're back.
      await this.setAway(null);
      await this.scheduleNextAlarm(); // [WP2] re-arms the alarm for a still-pending billing tick, if any
      const buffered = away!.buffered;
      // CALL-GEN-1: a rejoin is a NEW transport for this peer — bump its gen and
      // tell it, so its post-reconnect frames outrank any lingering old-socket ones.
      const rejoinGen = await this.bumpGen(peerId);
      this.sendTo(server, { type: "welcome", id: peerId, peers: otherIds, gen: rejoinGen });
      for (const ws of others) this.sendTo(ws, { type: "peer-rejoined", id: peerId });
      // Replay buffered signaling (offer/answer/candidate) addressed to the
      // rejoined peer, oldest first, in original order.
      for (const raw of buffered) {
        try { server.send(raw); } catch { /* client gone again already */ }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // CALL-KV-STATE-1: when the second peer joins (both peers now present) the
    // call is ANSWERED. Persist that fact in the DO's OWN storage — the DO is the
    // sole authority for call state, and DO storage is strongly consistent (KV is
    // eventually consistent and was implicated in receptionist start_failed races).
    // receptionist.ts now reads this via GET /state (see fetch() above), DO-first.
    //   DUAL-WRITE (transitional): we still write the call_answered KV flag for ONE
    //   release as a read-fallback for any receptionist path not yet cut over.
    //   REMOVE the KV put + the TOKENS fallback read in receptionist.ts once the
    //   full Call FSM (CALL-FSM-1) lands and ANSWERED becomes an FSM state.
    if (otherIds.length > 0) {
      await this.loadCallState();
      if (!this.answeredAt) {
        this.answeredAt = Date.now();
        this.answeredBy = peerId;
        try { await this.state.storage.put("answeredAt", this.answeredAt); } catch { /* best-effort */ }
        try { await this.state.storage.put("answeredBy", this.answeredBy); } catch { /* best-effort */ }
      }
      const roomId = this.state.id.name;
      const callId = roomId ? String(roomId).slice(0, 64) : null;
      if (callId) {
        try {
          // CALL-KV-STATE-1 dual-write fallback — remove when CALL-FSM-1 lands.
          await this.env.TOKENS.put(`call_answered:${callId}`, "true", { expirationTtl: 300 });
        } catch { /* best-effort: KV failure never breaks signaling */ }
      }
    }

    // CALL-GEN-1: fresh join — assign this peer its generation and stamp welcome.
    const joinGen = await this.bumpGen(peerId);
    this.sendTo(server, { type: "welcome", id: peerId, peers: otherIds, gen: joinGen });
    for (const ws of others) this.sendTo(ws, { type: "peer-joined", id: peerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(message); } catch { return; }

    data.from = this.state.getTags(ws)[0];

    // CALL-GEN-1: drop stale-generation frames server-side. A frame that carries a
    // numeric `gen` LOWER than the DO's current gen for this sender came from a
    // superseded transport (an old socket that reconnected under a newer gen) — it
    // must not be relayed or it could disrupt the live call. Frames WITHOUT a gen
    // (old app versions) are processed exactly as before — fully backward compatible.
    // CALL-GEN-2: the drop-check is PER-SENDER (keyed on `fromId`), and every relayed
    // frame is RE-STAMPED with the SENDER's authoritative gen from the `gens` map —
    // never the client-asserted value. That way each RECEIVER learns the correct
    // per-sender gen (which it tracks in its own `_peerGens[fromId]`), and a client
    // can never spoof a higher gen to defeat the receiver's stale-frame guard.
    const fromId = typeof data.from === "string" ? data.from : "";
    if (fromId) {
      const cur = await this.currentGen(fromId);
      if (typeof data.gen === "number" && data.gen < cur) {
        this.reportStaleGen(fromId, data.gen, cur, typeof data.type === "string" ? data.type : "");
        return; // stale artifact — drop silently, no side effects
      }
      // Re-stamp with the sender's authoritative gen so receivers see per-sender
      // truth. Only stamp when the sender actually has a gen (>0) — an old client
      // that never got a `welcome` gen has cur===0, and we leave the frame gen-less
      // so old receivers behave exactly as before (fully backward compatible).
      if (cur > 0) data.gen = cur;
    }

    // [CALL-REL-5] Record the FIRST offerer seen in this room (used to pick
    // the deterministic recovery offerer). Never overwritten once set — the
    // "original offerer" is fixed for the life of the call. Untouched: the
    // generation protection and 2-peer cap above/below.
    if (data.type === "offer" && fromId) {
      await this.loadRecoveryState();
      if (!this.originalOffererId) {
        this.originalOffererId = fromId;
        try { await this.state.storage.put("originalOffererId", fromId); } catch { /* best-effort */ }
      }
    }

    // [CALL-REL-5] `recovery-request` is answered by the DO directly (it picks
    // the offerer) — it is NEVER relayed like a normal `to`-scoped message.
    if (data.type === "recovery-request") {
      await this.handleRecoveryRequest(fromId, data);
      return;
    }

    // [CALL-REL-6] Mid-call relay migration: forward these message types
    // exactly like SDP/candidates (scoped by `to`, via the generic relay
    // below), but reject a stale/unknown `attemptId` and enforce "MAX one
    // migration per call" (plan §7.4) BEFORE they're relayed. Preserves the
    // 2-peer cap / generation protection above untouched — this only adds an
    // attemptId gate on top.
    if (data.type === "relay-migrate-offer") {
      await this.loadRecoveryState();
      const attemptId = typeof data.attemptId === "string" ? data.attemptId.slice(0, 64) : "";
      if (!attemptId) return;
      if (this.migrationUsed && this.activeMigrationAttemptId !== attemptId) {
        this.sendTo(ws, { type: "relay-migrate-reject", attemptId, reason: "migration_already_used" });
        return;
      }
      if (this.activeMigrationAttemptId && this.activeMigrationAttemptId !== attemptId) {
        this.sendTo(ws, { type: "relay-migrate-reject", attemptId, reason: "migration_in_progress" });
        return;
      }
      this.activeMigrationAttemptId = attemptId;
      this.migrationUsed = true;
      try {
        await this.state.storage.put("activeMigrationAttemptId", attemptId);
        await this.state.storage.put("migrationUsed", true);
      } catch { /* best-effort */ }
      // fall through to the generic `to`-scoped relay below
    } else if (
      data.type === "relay-migrate-answer" ||
      data.type === "relay-migrate-candidate" ||
      data.type === "relay-migrate-ready"
    ) {
      await this.loadRecoveryState();
      const attemptId = typeof data.attemptId === "string" ? data.attemptId.slice(0, 64) : "";
      if (!attemptId || attemptId !== this.activeMigrationAttemptId) {
        return; // stale/unknown attempt — drop silently, never relayed
      }
      // fall through to the generic `to`-scoped relay below
    }

    const all = this.state.getWebSockets();
    const out = JSON.stringify(data);

    // CALL-RC-D1: explicit hangup ends the call immediately for both sides —
    // no grace period, even if the other peer is currently "away". Clear any
    // pending away/alarm state before relaying so a lingering alarm can't fire
    // a stray peer-left after the call already ended cleanly.
    if (data.type === "bye" || data.type === "hangup" || data.type === "decline" || data.type === "cancel") {
      await this.setAway(null);
      // [CALL-FSM-2 2026-08-01] THE THIRD DECISION POINT, now also routed
      // through the state machine.
      //
      // This branch used to call markTerminal() directly — a peer sending `bye`
      // or `decline` over the SOCKET took a completely different route to
      // "the call is over" than the same peer sending it over HTTP. Two routes,
      // two implementations, and whichever the client happened to use decided
      // what got recorded. That is the same disease, in a third place.
      //
      // It now issues a command like everything else, so the aggregate, the
      // durable marker and the broadcast all come from one place. runCommand is
      // idempotent and monotonic, so a socket `bye` that follows an HTTP
      // decline is correctly a no-op rather than an overwrite.
      //
      // Actor is `server`: this frame arrived on an established socket whose
      // peer identity is the room's own tagging, not an authenticated uid, so
      // it must not claim to be the caller or the callee — `end_call` is the
      // one command either party may legitimately issue.
      const cmd = commandForLegacyStatus(String(data.type));
      if (cmd) {
        await this.runCommand(this.state.id.name ?? "", cmd.name === "decline_call" ? "end_call" : cmd.name, "server");
      }
    }
    if (data.type === "bye" || data.type === "hangup") {
      await this.setAway(null);
      await this.markEnded(); // CALL-KV-STATE-1: call is over — GET /state reports ended (also disarms billing → refundUnused)
      await this.scheduleNextAlarm(); // [WP2] markEnded's stopBilling already clears the alarm when nothing else is pending; idempotent to call again here
    }

    if (typeof data.to === "string" && data.to) {
      let delivered = false;
      for (const w of all) {
        if (this.state.getTags(w)[0] === data.to) {
          try { w.send(out); delivered = true; } catch { /* peer gone */ }
        }
      }
      // Away-peer buffering (CALL-RC-D1): the target is mid-reconnect-grace,
      // not gone. Buffer signaling (offer/answer/candidate) so it replays on
      // rejoin instead of being silently dropped. Explicit hangup is relayed
      // above via broadcast fallback, never buffered, so it isn't delayed.
      const away = await this.loadAway();
      if (!delivered && away && away.id === data.to && data.type !== "bye" && data.type !== "decline" && data.type !== "hangup") {
        away.buffered.push(out);
        if (away.buffered.length > MAX_BUFFERED_MESSAGES) away.buffered.shift(); // drop oldest
        await this.setAway(away);
        delivered = true; // handled via buffer, not a delivery failure
      }
      // Ringing race (zombie-call hotfix A4.3): a bye/decline addressed to a
      // peer that hasn't registered (hangup-before-welcome) or already left
      // must NOT be dropped — broadcast it so the other side ends cleanly.
      if (!delivered && (data.type === "bye" || data.type === "decline")) {
        for (const w of all) {
          if (w !== ws) { try { w.send(out); } catch { /* peer gone */ } }
        }
      }
    } else {
      for (const w of all) {
        if (w !== ws) { try { w.send(out); } catch { /* peer gone */ } }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.beginAwayOrEnd(ws, code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.beginAwayOrEnd(ws, 1011);
  }

  /** CALL-RC-D1: shared close/error path — start the 30s reconnect grace
   *  instead of ending the call immediately. */
  private async beginAwayOrEnd(ws: WebSocket, code: number): Promise<void> {
    const from = this.state.getTags(ws)[0];
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* already closed */ }

    const others = this.state.getWebSockets().filter((w) => w !== ws);
    if (!from || others.length === 0) {
      // No `from` tag, or the other peer already isn't here (e.g. this was the
      // only socket, or it's already gone) — nothing to grace, nothing to notify.
      return;
    }

    await this.setAway({ id: from, awaySince: Date.now(), buffered: [] });
    await this.scheduleNextAlarm(); // [WP2] multiplexed with any pending billing tick
    for (const w of others) this.sendTo(w, { type: "peer-away", id: from });
  }

  /** CALL-RC-D1 + [WP2]: the single DO alarm now serves TWO purposes —
   *  reconnect-grace expiry (unchanged behaviour) AND the per-minute billing
   *  ticker. Both are checked on every firing; scheduleNextAlarm() at the end
   *  re-arms whichever is still pending (or clears the alarm if neither is).
   *  A firing that's "early" for one purpose (e.g. billing fired but away
   *  hasn't expired yet) simply no-ops that branch — no cross-purpose effect. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const away = await this.loadAway();
    if (away && now >= away.awaySince + RECONNECT_GRACE_MS - 500) {
      // CALL-RC-D1: fires ~30s after a peer's WS closed/errored. If it never
      // reconnected (still marked away), end the call the old way: peer-left
      // to whoever's left, then close their socket too.
      await this.setAway(null);
      await this.markEnded(); // CALL-KV-STATE-1: grace expired, call ended (also disarms billing → refundUnused)
      for (const w of this.state.getWebSockets()) {
        this.sendTo(w, { type: "peer-left", id: away.id });
        try { w.close(1000, "peer reconnect grace expired"); } catch { /* already closed */ }
      }
    }
    // [WP2] Billing tick — independent of the away branch above (markEnded,
    // if it ran, already cleared `billing`, so loadBilling() below reflects that).
    const billing = await this.loadBilling();
    if (billing && !billing.stopped && now >= billing.next_tick - 500) {
      await this.tickBilling(billing);
    }
    await this.scheduleNextAlarm();
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }
}
