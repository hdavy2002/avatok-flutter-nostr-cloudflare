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
// --- Legacy billing retirement (owner decision 2026-08-02) ------------------
// Human audio/video calls are permanently free. New /billing-arm requests are
// rejected. A DO carrying pre-transition billing state refunds the unused
// escrow without settling another minute, then removes the state. The billing
// fields remain temporarily so already-created DOs can be reconciled safely.
import type { Env } from "../types";
import type { CallSnapshot } from "../lib/call_snapshot";
import { refundUnused } from "../lib/call_billing";
import { brainIngest } from "../lib/brain_ingest";
import {
  applyCommand, authorizeCommand, deriveActor, newCallSession, commandForLegacyStatus,
  humanRoomAcceptsNewPeer, legacyWireStatus,
  type CallSession, type Command, type CommandName,
} from "../lib/call_state";
import { CALL_RING_LIFETIME_MS } from "../lib/call_delivery_contract";
import { readConfig } from "../routes/config";
import {
  GLARE_WINDOW_MS, glareJoinRoomToken, resolveGlarePlacement, type PendingGlareInvite,
} from "../lib/call_glare";
import {
  authenticatedSideTag, roomSeatIsFull, roomTokenExpired, sameRoomSeat,
  socketSeatKey, type RoomSideTag,
} from "../lib/call_room_auth";

// [ONEBRAIN-B2] Human-readable call length for a brain summary (e.g. "4m12s").
function fmtCallDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

interface AwayPeer {
  id: string;
  /** Authenticated seat identity. Absent on records created before room auth. */
  side?: RoomSideTag;
  awaySince: number;
  /** Signaling messages addressed to this peer while it was away, oldest first. */
  buffered: string[];
  /** [CALL-AWAYBUF-BYTES-1] Running serialized size of `buffered`. Optional on
   *  the type because records persisted before this change do not have it —
   *  loadAway() hydrates it rather than letting `undefined + n` produce NaN
   *  (`NaN > MAX` is false, which would silently restore the unbounded buffer). */
  bufferedBytes?: number;
}

// Legacy persisted shape only. New state cannot be armed; old state is read so
// its escrow can be refunded safely during the free-policy transition.
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

/** [CALL-GRACE-MARGIN-1 2026-08-03] (audit H4) 30 s → 45 s.
 *
 *  The client gives up reconnecting at exactly 30 s (`_kReconnectGiveUp`,
 *  call_session.dart) and the server expired the peer at exactly 30 s. Zero
 *  margin: a reconnect that lands at t≈29.5 s races this alarm, and which one
 *  wins is decided by scheduler jitter. The loser's user sees a call that
 *  reconnected and then died anyway.
 *
 *  45 s gives the client's final attempt a 15 s runway to complete. The cost is
 *  paid only by a peer that is genuinely gone: 15 s more "reconnecting" before
 *  peer-left. The margin is added on ONE side deliberately — moving the client
 *  down to ~20 s AS WELL would just re-create the tight coupling in the other
 *  direction. */
const RECONNECT_GRACE_MS = 45_000;
const MAX_BUFFERED_MESSAGES = 100;
/** [CALL-AWAYBUF-BYTES-1 2026-08-03] (audit H2) Byte budget for the away-peer
 *  replay buffer, measured on the JSON-SERIALIZED AwayPeer — not on the raw
 *  frames, and not on a message COUNT.
 *
 *  The count cap alone is not a bound: a Durable Object storage VALUE is capped
 *  at 128 KiB, and `awayPeer` is written as ONE value containing up to 100
 *  buffered frames. SDP offers are multi-kilobyte, and a re-offer storm during
 *  ICE recovery can put several of them in the buffer, so 100 frames can exceed
 *  the cap comfortably. The put then THROWS, and because it was unguarded that
 *  throw propagated out of webSocketMessage and killed the relay for that
 *  message — a buffering optimisation taking down live signalling.
 *
 *  110 KiB leaves headroom for the id/timestamp fields and the array's own
 *  serialization overhead. Enforced by drop-oldest-until-it-fits (not a fixed
 *  splice count) against a RUNNING byte counter, so nothing has to re-serialize
 *  the whole buffer on every message. */
const MAX_BUFFERED_BYTES = 110 * 1024;
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
  /** [CALL-ATOMIC-1 2026-08-03] Re-entrancy flag for withAggregateLock().
   *  See that method for why a plain boolean is sufficient and correct here. */
  private inAggregateCriticalSection = false;
  private ringDeadline: number | null | undefined; // undefined = not loaded
  private autoReceptionistEligible: boolean | undefined;
  private noAnswerReason: string | null | undefined;
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

  /** [CALL-WS-AUTH-1 2026-08-03] Is WS join authentication ENFORCED right now?
   *
   *  Cached per DO instance. The value is read from the config KV blob exactly
   *  once per instance lifetime rather than on every join, because this sits on
   *  the call-setup critical path and a KV round-trip here is time-to-ring.
   *  Caching also means a flag flip takes effect as rooms turn over rather than
   *  mid-call, which is the behaviour you want from a security enforcement
   *  switch: no call changes its admission rules halfway through.
   *
   *  Fails OPEN on a config read error. That is deliberate and is not a weakening
   *  of the gate: the flag defaults to false anyway, so a config outage cannot
   *  make the system LESS safe than its own default, whereas failing closed would
   *  turn a KV blip into a total calling outage. */
  private authEnforced: boolean | undefined;
  private async roomAuthEnforced(): Promise<boolean> {
    if (this.authEnforced !== undefined) return this.authEnforced;
    try {
      const cfg = await readConfig(this.env);
      this.authEnforced = cfg.callRoomAuthEnforced === true;
    } catch {
      this.authEnforced = false;
    }
    return this.authEnforced;
  }

  /** [CALL-WS-AUTH-1] Resolve a presented `?t=` room token to the call SIDE it
   *  entitles the holder to occupy.
   *
   *  Returns a reason on failure so the telemetry can distinguish "old client
   *  that sends nothing" (`missing`) from "credentials were never minted for this
   *  call" (`unprovisioned` — a call placed before this shipped) from an actual
   *  bad token (`mismatch`). Those three want very different responses when the
   *  flag is flipped, and collapsing them into one boolean would hide that. */
  private async classifyRoomToken(
    presented: string,
  ): Promise<{ ok: true; side: "caller" | "callee" } | { ok: false; reason: string }> {
    const [callerTok, calleeTok, expiresAt] = await Promise.all([
      this.state.storage.get<string>("room_token_caller"),
      this.state.storage.get<string>("room_token_callee"),
      this.state.storage.get<number>("room_token_expires_at"),
    ]);
    if (!callerTok || !calleeTok) return { ok: false, reason: "unprovisioned" };
    if (!presented) return { ok: false, reason: "missing" };
    // Reconnects are NEW admissions, so this expiry deliberately outlives the
    // ring lease. Terminal FSM/legacy state below revokes admission immediately.
    if (roomTokenExpired(expiresAt, Date.now())) return { ok: false, reason: "expired" };
    if (presented === callerTok) return { ok: true, side: "caller" };
    if (presented === calleeTok) return { ok: true, side: "callee" };
    return { ok: false, reason: "mismatch" };
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
   *  bye/hangup skip legacy-billing retirement and the call_completed ingest
   *  ([AVACALL-RING-CANCEL-2] fix). Every terminal-status consumer keys off
   *  `terminal_status`, not `ended`, so suppression is unaffected.
   *  Idempotent. [CALL-FAILCLOSED-1 2026-08-03] IT NO LONGER SWALLOWS ITS PUTS,
   *  so the "never throws" contract this comment used to advertise is gone and
   *  propagation is now INTENTIONAL. `terminalStatus` is not decoration: the FCM
   *  ring-suppression probe (consumers/src/fcm.ts) reads it to decide whether to
   *  ring a phone at all, and `/api/call-state` reads it to decide whether a late
   *  Accept may proceed. A silently-lost write fails BOTH of those OPEN — a
   *  cancelled call rings anyway, and a late accept joins a call that is over.
   *  Better to reset the DO and make the caller retry.
   *
   *  [CALL-TERMINAL-BCAST-1 2026-08-01] MONOTONIC. The first terminal status to
   *  land wins and is IMMUTABLE; a later/racing terminal request must NOT
   *  overwrite it. Before this, a `decline` could be silently replaced by the
   *  caller's own follow-up `cancel`, so `/api/call-state` reported the wrong
   *  reason and a late `accept` could revive a call the callee had rejected.
   *  Returns whether this call was already terminal so callers can report it. */
  private async markTerminal(status: string): Promise<{ already: boolean; status: string }> {
    // [CALL-ATOMIC-1 2026-08-03] The "first writer wins and is IMMUTABLE" rule
    // above was a check-then-act across the `await` in loadCallState(): two
    // terminal statuses arriving together both observed `terminalStatus === null`
    // and both wrote, which is exactly the decline-replaced-by-cancel bug this
    // comment says it prevents. Re-entrant: runCommandLocked() already holds the
    // section, so that path runs inline.
    return await this.withAggregateLock(async () => {
    await this.loadCallState();
    if (this.terminalStatus) {
      // Already terminal — immutable. Do not rewrite storage, do not move terminalAt.
      return { already: true, status: this.terminalStatus };
    }
    const s = (status || "ended").slice(0, 24);
    const at = Date.now();
    // One put, fail-closed. Written BEFORE the in-memory mirrors so nothing in
    // this instance believes the call is terminal until storage agrees.
    await this.state.storage.put({ terminalStatus: s, terminalAt: at });
    this.terminalStatus = s;
    this.terminalAt = at;
    return { already: false, status: s };
    });
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

  /** Hydrate the aggregate from storage on first touch after an eviction.
   *
   *  [CALL-FAILCLOSED-1 2026-08-03] THIS READ MUST NOT BE SWALLOWED.
   *
   *  It used to end in `.catch(() => undefined)`, which turned a storage READ
   *  failure into `stored === undefined` — indistinguishable from "this call has
   *  no aggregate yet". The DO then FABRICATED a brand-new `ringing` session for
   *  a call that may already have been declined, connected or completed, and
   *  every guard downstream (already_terminal, CALLEE_TERMINAL, the WS admission
   *  check) evaluated against that fiction. A transient storage blip could
   *  therefore resurrect a dead call and let a late Accept join it.
   *
   *  Letting the read throw is the correct behaviour: Cloudflare's output gate
   *  resets the DO and holds outgoing messages, and the caller retries against a
   *  fresh instance. "I could not read the call" must never be reported as "the
   *  call is new". Absent state and unreadable state are different facts. */
  private async loadSession(callId: string): Promise<CallSession> {
    if (this.session) return this.session;
    const stored = await this.state.storage.get<CallSession>("fsm");
    this.session = stored ?? newCallSession(callId, Date.now());
    return this.session;
  }

  /**
   * [CALL-ATOMIC-1 2026-08-03] THE AGGREGATE CRITICAL SECTION. Read this before
   * touching anything that mutates `fsm`.
   *
   * A Durable Object is single-threaded, and that fact was mistaken for atomicity
   * across the whole file. It is not. Single-threaded means no PARALLELISM; it
   * says nothing about what happens at an `await`. Every aggregate mutation was
   *
   *     await storage.get("fsm")   →   applyCommand(...)   →   await storage.put("fsm")
   *
   * and the runtime is free to run another request's continuation at either
   * await. Two commands entering a COLD DO together therefore both resolved
   * `loadSession()` against the same absent-then-stored snapshot, both evaluated
   * the reducer's guards against that same `prev`, and the second `put` silently
   * overwrote the first.
   *
   * PROD PROOF (call avatok-cb1618e6, 2026-08-03 08:44 UTC). `accept_call`
   * returned `changed=true seq=3` and 245 ms later a native `decline_call`
   * returned `changed=true seq=4`. Neither ordering can produce that pair:
   *   - accept THEN decline → decline hits the `session_state === "connected"`
   *     no-op guard in call_state.ts and returns `changed=false`;
   *   - decline THEN accept → accept hits `isSessionTerminal` and returns
   *     `ok=false, already_terminal`.
   * Two mutually exclusive `changed=true` results are only possible if both
   * commands read the SAME `prev`. The callee had answered; the caller was told
   * the call was declined and tore down 96 ms later. Five of the seven accepts
   * in the preceding fortnight died this way, and the same interleaving killed a
   * receptionist session 932 ms after its first audio (avatok-b836d350).
   *
   * The reducer in lib/call_state.ts was never wrong — it guards this exact case
   * explicitly. It was being handed a stale snapshot. That is why the fix is HERE
   * and not another guard there: four layers of guard already existed, and the
   * Dart one even FIRED on the failing call. All four are downstream of this.
   *
   * `blockConcurrencyWhile` is the right primitive rather than a promise-chain
   * mutex because it also defers delivery of incoming WebSocket messages, alarms
   * and fetches for the duration — so an alarm cannot fire mid-transition either.
   * Keep the section SHORT and free of cross-DO/network calls: everything inside
   * must be local storage plus synchronous socket sends, or the whole room stalls.
   * (`clearPendingGlareInvite` is the one cross-DO touch and is deliberately
   * dispatched via `waitUntil`, never awaited in here.)
   *
   * RE-ENTRANCY. `runCommand` calls `markTerminal`, and nesting a real
   * `blockConcurrencyWhile` inside another one deadlocks. The boolean is safe
   * because the DO is single-threaded: a nested call is by definition the SAME
   * logical task that already holds the section, and a concurrent caller's
   * callback is queued by the runtime and cannot observe the flag until it is
   * genuinely its turn. Setting it synchronously as the first statement inside
   * the callback — with no await in between — is what makes that true.
   */
  private async withAggregateLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inAggregateCriticalSection) return await fn();
    return await this.state.blockConcurrencyWhile(async () => {
      this.inAggregateCriticalSection = true;
      try {
        return await fn();
      } finally {
        this.inAggregateCriticalSection = false;
      }
    });
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
    // [CALL-ATOMIC-1] load → authorize → reduce → persist → broadcast is ONE
    // indivisible step. See withAggregateLock() for the incident this fixes.
    return await this.withAggregateLock(() => this.runCommandLocked(callId, name, actor, opts));
  }

  /** The body of runCommand(). MUST only ever be called from inside
   *  withAggregateLock() — it is not safe on its own. */
  private async runCommandLocked(
    callId: string, name: CommandName, actor: Command["actor"],
    opts: {
      commandId?: string; expectedEpoch?: number; data?: Record<string, unknown>;
      authenticatedUid?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
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
    // Idempotency lookup happens only AFTER membership authorization. Returning
    // a cached result before this gate would let a stranger who guessed a
    // command id learn that a call exists and inspect its prior outcome.
    if (opts.commandId) {
      const prior = this.seenCommands.get(opts.commandId);
      if (prior) return { ...prior, replayed: true };
      const durable = await this.state.storage.get<Record<string, unknown>>(`cmd:${opts.commandId}`).catch(() => undefined);
      if (durable) { this.seenCommands.set(opts.commandId, durable); return { ...durable, replayed: true }; }
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

    let fan = { seen: 0, sent: 0, seq: r.state.transition_sequence };
    if (r.changed) {
      // [CALL-FAILCLOSED-1 2026-08-03] PERSIST BEFORE ANYONE IS TOLD.
      //
      // Two things changed here and they only work together.
      //
      // 1. The put is no longer wrapped in `try {} catch { /* best-effort */ }`.
      //    A swallowed put meant the DO advanced IN MEMORY, broadcast the new
      //    state to both phones, and returned it to the HTTP caller — while
      //    storage still held the OLD state. After the next eviction the call
      //    silently rewound to a state every participant had already been told
      //    was over. Broadcast was reliable; persistence was not; the two
      //    disagreed and the unreliable one was the one nobody was told about.
      //    Letting it throw hands the problem to Cloudflare's output gate, which
      //    exists for exactly this: the DO is reset, the in-memory advance is
      //    discarded, and any outgoing messages are HELD rather than delivered.
      //    That is the fail-closed semantics we want, and the old catch is
      //    precisely what defeated the platform guarantee.
      //
      // 2. `this.session = r.state` moved to AFTER the put. With output gates a
      //    failed put resets the instance anyway, so this is belt-and-braces —
      //    but it costs nothing and it makes the invariant readable: nothing in
      //    this process believes a transition happened until it is durable.
      //
      // NOT every swallowed put in this file becomes fail-closed — see the
      // `cmd:` idempotency record and `gens` below, which are deliberately
      // best-effort. Failing a transition that ALREADY succeeded durably,
      // because its replay-record could not be written, would be strictly worse
      // than the degraded behaviour a lost record causes (the FSM's own
      // already_terminal / no-change guards catch the retry and hand back state).
      await this.state.storage.put("fsm", r.state);
      this.session = r.state;
      // Keep the legacy terminal marker in lock-step: /api/call-state and the
      // ring-suppression probe still read it, and they must never disagree with
      // the aggregate. Two sources of truth is the bug we are removing.
      if (r.state.session_state === "completed" && !this.terminalStatus) {
        await this.markTerminal(r.state.disposition);
      }
      if (r.state.session_state === "completed") {
        // [CALL-GLARE-LIFECYCLE-1] A finished call cannot remain eligible for
        // reciprocal-dial folding. The placement path also probes the durable
        // terminal marker, so cleanup failure and pre-deploy calls stay safe.
        // Do not await a cross-DO cleanup while the pair DO may be probing this
        // call's terminal state. waitUntil avoids an A→B→A dependency cycle;
        // the already-persisted terminal marker is the synchronous backstop.
        this.state.waitUntil(this.clearPendingGlareInvite(r.state, callId));
      }
      fan = this.broadcastTransition(r.state, r.events, callId);
      if (r.state.session_state === "connected" || r.state.session_state === "handoff" || r.state.session_state === "completed") {
        this.ringDeadline = null;
        try { await this.state.storage.delete("ringDeadline"); } catch { /* best-effort */ }
      }
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
      // Keep the push/API contract on the legacy wire vocabulary. Internal
      // dispositions such as `caller_cancelled` are not understood by older
      // clients and otherwise leave their incoming ring alive.
      wire_status: legacyWireStatus(r.state),
      epoch: r.state.epoch,
      seq: r.state.transition_sequence,
      sockets_seen: fan.seen,
      sockets_sent: fan.sent,
      peer_uid: effectiveActor === "caller" ? r.state.callee_uid : r.state.caller_uid,
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

  /**
   * [RECEPT-DO-OWNERSHIP-1 2026-08-03] (audit A3) THE receptionist session owner
   * for this call. First writer wins; every later claimant is handed the winner.
   *
   * WHY THIS MOVED INTO THE DO. Ownership used to be decided by a KV lock in
   * routes/receptionist.ts, and it had two independent holes that together
   * reproduced the exact avatok-14739b84 incident the lock was written to
   * prevent — two greetings, two recordings, two billing events for one call:
   *
   *   1. The KV "claim" was READ-then-PUT, while the comment above it described
   *      a write-then-read-back protocol the code did not implement. Even the
   *      described version would not have worked: KV is EVENTUALLY consistent,
   *      so two concurrent /start requests in different colos both read null,
   *      both write their own sid, and both believe they won. There is no
   *      arrangement of KV operations that makes this safe.
   *   2. The DO admit gate did not dedupe either. Both requests send
   *      `receptionist-admit` with the SAME commandId, so the idempotency cache
   *      replays the original `ok:true` to the second one, and the FSM's
   *      repeat-handoff no-op also reports success. Both callers were told they
   *      had won.
   *
   * [CALL-ATOMIC-1 2026-08-03] CORRECTION TO THE PARAGRAPH THAT USED TO BE HERE.
   * It read: "A Durable Object is single-threaded and strongly consistent, so
   * here check-then-put IS atomic — the property KV cannot provide at any price."
   * That is wrong, and it is the same mistake that let the accept/decline lost
   * update through. Single-threaded means no PARALLELISM; it does not make a
   * `get` and a `put` atomic when there is an `await` between them. Two
   * concurrent /receptionist-admit calls both suspended on the get below, both
   * saw `undefined`, both put, and both were told `claimed: true` — i.e. the fix
   * for avatok-14739b84 had the same shape as the bug. It is narrower than the KV
   * version (microseconds instead of cross-colo eventual consistency), which is
   * why it mostly held, but narrower is not safe.
   *
   * What IS true: a DO gives strong consistency and, via blockConcurrencyWhile,
   * real mutual exclusion. So the claim now runs inside the aggregate critical
   * section. The KV lock stays as a cheap first-line cache, but it is not the
   * authority.
   *
   * Note this deliberately sits OUTSIDE the runCommand idempotency cache. The
   * two answer different questions: the cache asks "have I already performed
   * this command?", this asks "who owns the session?" — and the second question
   * still needs a real answer when the first one was a replay, because a replay
   * is exactly what the losing concurrent /start receives.
   */
  private async claimReceptionistSession(sid: string): Promise<{ already: boolean; sid: string }> {
    return await this.withAggregateLock(async () => {
      const existing = await this.state.storage.get<string>("receptionist_sid");
      if (existing) return { already: true, sid: existing };
      await this.state.storage.put("receptionist_sid", sid);
      return { already: false, sid };
    });
  }

  /** Remove this exact call from its pair-keyed glare index. The pair DO checks
   *  the call id before deleting, so delayed cleanup cannot erase a newer dial. */
  private async clearPendingGlareInvite(s: CallSession, callId: string): Promise<void> {
    if (!callId || !s.caller_uid || !s.callee_uid) return;
    const lo = s.caller_uid < s.callee_uid ? s.caller_uid : s.callee_uid;
    const hi = s.caller_uid < s.callee_uid ? s.callee_uid : s.caller_uid;
    try {
      const pairStub = this.env.CALL_ROOMS.get(this.env.CALL_ROOMS.idFromName(`glare:${lo}__${hi}`));
      await pairStub.fetch("https://call/glare-clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ placer: s.caller_uid, callId }),
      });
    } catch { /* durable terminal-state probe remains the correctness backstop */ }
  }

  /** [CALL-AUTHZ-1] Stamp the participants once, at admission, from the
   *  AUTHENTICATED caller uid and the dialled callee uid. Everything downstream
   *  derives membership from this, so it must be written before any
   *  client-originated command can be accepted. Idempotent. */
  private async setParticipants(
    callId: string,
    callerUid: string,
    calleeUid: string,
    autoReceptionistEligible = false,
    noAnswerReason: string | null = null,
  ): Promise<{ ok: true; seq: number; epoch: number; ringDeadlineMs: number | null } | { ok: false; error: string }> {
    const s = await this.loadSession(callId);
    if (s.caller_uid || s.callee_uid) {
      if (s.caller_uid !== callerUid || s.callee_uid !== calleeUid) return { ok: false, error: "participant_mismatch" };
      return {
        ok: true, seq: s.transition_sequence, epoch: s.epoch,
        ringDeadlineMs: this.ringDeadline ?? null,
      };
    }
    if (!callId || !callerUid || !calleeUid || callerUid === calleeUid) return { ok: false, error: "invalid_participants" };
    s.caller_uid = callerUid;
    s.callee_uid = calleeUid;
    s.call_id = s.call_id || callId;
    this.session = s;
    this.autoReceptionistEligible = autoReceptionistEligible;
    this.noAnswerReason = noAnswerReason;
    await this.state.storage.put({
      fsm: s,
      autoReceptionistEligible,
      noAnswerReason: noAnswerReason ?? "",
    });
    const deadline = Date.now() + CALL_RING_LIFETIME_MS;
    this.ringDeadline = deadline;
    await this.state.storage.put("ringDeadline", deadline);
    // Seed the server-owned lifecycle before any ring push is sent. The client
    // may display the ring, but only this aggregate may decide timeout.
    await this.runCommand(callId, "admit_call", "server");
    await this.runCommand(callId, "callee_ringing", "server");
    await this.scheduleNextAlarm();
    // [CALL-CALLEE-SEQ-1 2026-08-03] Hand the ring's authoritative sequence back
    // to the placing route so it can travel WITH the ring. Until now the callee
    // had no sequence at all: caller-side transitions carried the DO's
    // `transition_sequence` and correctly dropped stale ones (59 recorded
    // `call_transition_dropped reason=stale_seq` in a fortnight), while every
    // callee-side transition was stamped `-1` — a value that can never lose a
    // comparison, so the callee applied whatever arrived last. This is the seed
    // the callee's reducer needs to be able to order anything at all.
    const seeded = await this.loadSession(callId);
    // [CALL-ONE-DEADLINE-1 2026-08-03] Hand out the ABSOLUTE ring deadline this
    // DO will actually enforce, so no other layer has to guess it. Four numbers
    // claimed to be "the ring timeout" — 20 s here, 22 s in the client, 30 s in
    // `ringTimeoutSec` and in a dead campaign constant, 45 s in a comment — and
    // only this one ever fires. A deadline is a fact the owner should state, not
    // a constant every layer re-derives and drifts from.
    return {
      ok: true, seq: seeded.transition_sequence, epoch: seeded.epoch,
      ringDeadlineMs: this.ringDeadline ?? deadline,
    };
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
      ...(s.handoff_reason === "no_answer" ? { activation_mode: "rings" } : {}),
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

  /** Guarded so a call end is only "handled" once even if markEnded() is
   *  invoked again later (e.g. a stray alarm after an explicit hangup). */
  private async markEnded(): Promise<void> {
    const wasEnded = this.ended === true;
    this.ended = true;
    try { await this.state.storage.put("ended", true); } catch { /* best-effort */ }
    if (!wasEnded) {
      // [ONEBRAIN-B2] Record the completed call in the brain BEFORE retirement
      // clears the billing state (which holds the two account ids). Fire-and-forget
      // inside a guard so a brain hiccup can never affect call teardown.
      try { await this.ingestCallCompleted(); } catch { /* best-effort */ }
      await this.retireLegacyBillingAsFree();
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
    if (stored && !Array.isArray(stored.buffered)) stored.buffered = [];
    // [CALL-AWAYBUF-BYTES-1] MIGRATION. A record written before this change has
    // no `bufferedBytes`. Without this line the first `+=` yields NaN, every
    // `NaN > MAX_BUFFERED_BYTES` comparison is false, the drop loop never runs,
    // and the buffer grows unbounded again — silently, which is the worst
    // possible way for a size guard to fail.
    if (stored && typeof stored.bufferedBytes !== "number") {
      stored.bufferedBytes = stored.buffered.reduce((n, f) => n + f.length + 3, 0);
    }
    this.away = stored ?? null;
    return this.away;
  }

  private async setAway(peer: AwayPeer | null): Promise<void> {
    this.away = peer;
    if (peer) await this.state.storage.put("awayPeer", peer);
    else await this.state.storage.delete("awayPeer");
  }

  /** [CALL-AWAYBUF-BYTES-1 2026-08-03] (audit H2) Append one signalling frame to
   *  an away peer's replay buffer, bounded by BOTH a message count and a byte
   *  budget, dropping OLDEST first until the new frame fits.
   *
   *  Drop-oldest-until-it-fits rather than a fixed `splice(0, 5)`: the frames are
   *  wildly different sizes (a candidate is ~200 bytes, an SDP offer several KB),
   *  so any fixed count either drops far more than needed or still leaves the
   *  buffer over budget. Oldest-first is also the right eviction order for
   *  signalling replay — the newest offer/candidates are the ones that still
   *  describe reality when the peer comes back.
   *
   *  Sizing uses the frame's own serialized length + 3 (the surrounding quotes
   *  and separating comma in the persisted array). `out` is already a JSON
   *  string, so `.length` is its true contribution; nothing re-measures the whole
   *  buffer per message. */
  private bufferForAwayPeer(away: AwayPeer, out: string): void {
    if (typeof away.bufferedBytes !== "number") away.bufferedBytes = 0;
    const cost = out.length + 3;
    away.buffered.push(out);
    away.bufferedBytes += cost;
    while (
      away.buffered.length > 0 &&
      (away.buffered.length > MAX_BUFFERED_MESSAGES || away.bufferedBytes > MAX_BUFFERED_BYTES)
    ) {
      const dropped = away.buffered.shift();
      if (dropped === undefined) break;
      away.bufferedBytes -= dropped.length + 3;
      if (away.bufferedBytes < 0) away.bufferedBytes = 0;
    }
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

  /** Recompute the single DO alarm as the earliest reconnect/ring deadline or
   * legacy-billing refund retry. New human-call billing cannot be armed. */
  private async scheduleNextAlarm(): Promise<void> {
    const away = await this.loadAway();
    const billing = await this.loadBilling();
    if (this.ringDeadline === undefined) {
      this.ringDeadline = (await this.state.storage.get<number>("ringDeadline")) ?? null;
    }
    const candidates: number[] = [];
    if (away) candidates.push(away.awaySince + RECONNECT_GRACE_MS);
    if (billing && !billing.stopped) candidates.push(billing.next_tick);
    if (this.ringDeadline != null) candidates.push(this.ringDeadline);
    if (candidates.length === 0) {
      try { await this.state.storage.deleteAlarm(); } catch { /* no alarm set */ }
      return;
    }
    // [CALL-REL-R4-4 2026-08-03] This single alarm owns ring expiry, away-peer
    // reconnect expiry and legacy-billing retirement. Cloudflare's at-least-once
    // alarm guarantee only begins ONCE THE ALARM IS SUCCESSFULLY SCHEDULED —
    // swallowing setAlarm() failure therefore does not degrade gracefully, it
    // opts the call out of the platform's retry entirely and leaves a ring that
    // never times out or an away peer that is never reaped, with no signal.
    //
    // Ring + reconnect deadlines are CRITICAL: on persistent failure we rethrow
    // so the enclosing request fails (client retries) or, when we are already
    // inside alarm(), so the runtime retries the alarm itself. Legacy billing
    // alone stays best-effort — a missed refund tick is money, not a stuck call,
    // and failing dial setup over it would be a worse trade.
    const critical = away != null || this.ringDeadline != null;
    const at = Math.min(...candidates);
    try {
      await this.state.storage.setAlarm(at);
      return;
    } catch (firstErr) {
      // One inline retry: setAlarm failures are dominated by transient storage
      // contention, and retrying here is far cheaper than a whole failed dial.
      try {
        await this.state.storage.setAlarm(at);
        this.reportAlarmScheduling("recovered_on_retry", at, critical, firstErr);
        return;
      } catch (err) {
        this.reportAlarmScheduling("set_alarm_failed", at, critical, err);
        if (critical) throw err;
      }
    }
  }

  /** [CALL-REL-R4-4] Make alarm-scheduling trouble visible. Previously every
   *  setAlarm() failure was swallowed silently, so a call stuck with no ring
   *  expiry was indistinguishable from a healthy one in telemetry. */
  private reportAlarmScheduling(kind: string, at: number, critical: boolean, err: unknown): void {
    try {
      void this.env.Q_ANALYTICS.send({
        event: "invariant_protected", uid: "", ts: Date.now(),
        props: {
          kind: `call_alarm_${kind}`, side: "server", critical,
          scheduled_for: at, in_ms: at - Date.now(),
          has_ring_deadline: this.ringDeadline != null,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          call_id: this.state.id.name ? String(this.state.id.name).slice(0, 64) : null,
          app_name: "avatok", service_name: "avatok-api", worker: true,
        },
      });
    } catch { /* best-effort — telemetry never blocks or breaks signaling */ }
  }

  /** Retire pre-free-policy billing without settling any additional minute. */
  private async retireLegacyBillingAsFree(): Promise<boolean> {
    const b = await this.loadBilling();
    if (!b) return false;
    await this.setBilling({ ...b, stopped: true });
    try {
      await refundUnused(this.env, {
        call_id: b.call_id, trace_id: b.trace_id, caller_id: b.caller_id, callee_id: b.callee_id,
        caller_or_callee_id: b.billing_mode === "A" ? b.callee_id : b.caller_id,
        reason: "CALL_ENDED", billing_mode: b.billing_mode,
      });
    } catch {
      // Keep the legacy state retryable. The alarm path only calls this refund
      // method now; it can no longer settle another minute.
      await this.setBilling({ ...b, stopped: false, next_tick: Date.now() + BILLING_TICK_MS });
      await this.scheduleNextAlarm();
      return false;
    }
    await this.setBilling(null);
    await this.scheduleNextAlarm();
    return true;
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
        const aggregate = await this.loadSession(
          stateUrl.searchParams.get("callId") ?? (this.state.id.name ? String(this.state.id.name) : ""),
        );
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
          // [CALL-HANDOFF-CALLEE-CLOSE-1] Non-terminal for the CALLER does not
          // mean the CALLEE may keep ringing. The public proxy uses these fields
          // to expose a callee-only ring-ending status without marking Ava's
          // caller leg terminal.
          session_state: aggregate.session_state,
          callee_leg_state: aggregate.callee_leg_state,
          service_leg_state: aggregate.service_leg_state,
          wire_status: legacyWireStatus(aggregate),
          caller_uid: aggregate.caller_uid,
          callee_uid: aggregate.callee_uid,
          // CALL-ANSWERED-LIVE-1: how many transports are on the call RIGHT NOW.
          // `answered` is sticky (set the instant a 2nd socket ever joined), so a
          // transient/zombie join — e.g. an offline callee's FCM-woken socket that
          // dies before media, or a caller reconnect with a fresh tag — leaves
          // answered=true forever even though no real conversation happened. That
          // stale flag was vetoing the unreachable→Ava handoff with 409
          // call_answered (PostHog: /api/receptionist/start 409, call avatok-8caef3ce
          // 2026-07-08). Exposing the LIVE peer count lets the receptionist gate
          // distinguish "genuinely on a call now" (>=2) from "phantom-answered".
          peers: new Set(this.state.getWebSockets()
            .map((w) => socketSeatKey(this.state.getTags(w)))
            .filter(Boolean)).size,
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
      // the already-registered reciprocal placement wins, because the current
      // request returns before initializing its room. DO storage is
      // strongly consistent (no ordered state in KV), and this holds no socket.
      // [CALL-GLARE-LIFECYCLE-1] Terminal call cleanup reaches the same pair DO
      // that owns the pending invite. Compare call ids before deleting so a
      // delayed completion can never erase a newer call by the same placer.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/glare-clear")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const placer = typeof body.placer === "string" ? body.placer : "";
        const callId = typeof body.callId === "string" ? body.callId : "";
        if (!placer || !callId) {
          return Response.json({ error: "placer and callId required" }, { status: 400 });
        }
        const key = `glare_invite:${placer}`;
        const current = await this.state.storage.get<PendingGlareInvite>(key);
        if (current?.callId !== callId) return Response.json({ ok: true, cleared: false });
        await this.state.storage.delete(key);
        return Response.json({ ok: true, cleared: true });
      }
      if (req.method === "POST" && stateUrl.pathname.endsWith("/glare-place")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const placer = typeof body.placer === "string" ? body.placer : "";
        const peer = typeof body.peer === "string" ? body.peer : "";
        const callId = typeof body.callId === "string" ? body.callId : "";
        const callerRoomToken = typeof body.callerRoomToken === "string" ? body.callerRoomToken : "";
        const calleeRoomToken = typeof body.calleeRoomToken === "string" ? body.calleeRoomToken : "";
        if (!placer || !peer || !callId) {
          return Response.json({ error: "placer, peer, callId required" }, { status: 400 });
        }
        const now = Date.now();
        // Reciprocal = a pending invite recorded by the PEER (peer→placer) still
        // inside the window. Stored per-direction keyed by the placer uid.
        const reciprocalKey = `glare_invite:${peer}`;
        const recip = await this.state.storage.get<PendingGlareInvite>(reciprocalKey);
        let reciprocalTerminal = false;
        if (recip?.callId && recip.callId !== callId && now - recip.ts < GLARE_WINDOW_MS) {
          // Time proximity is not enough: a declined/cancelled/timed-out call is
          // not simultaneous with a callback. Read the candidate call's strongly
          // consistent terminal marker before folding. Fail open only on a DO
          // probe failure, preserving genuine simultaneous-dial behaviour.
          try {
            const callStub = this.env.CALL_ROOMS.get(this.env.CALL_ROOMS.idFromName(recip.callId));
            const sr = await callStub.fetch("https://call/state");
            const state = await sr.json() as { ended?: boolean; terminal_status?: string | null };
            reciprocalTerminal = state.ended === true || Boolean(state.terminal_status);
          } catch { reciprocalTerminal = false; }
        }
        const resolution = resolveGlarePlacement({
          callId, reciprocal: recip, now, reciprocalTerminal,
        });
        if (resolution.kind === "merge") {
          // The reciprocal call is already proceeding through registration;
          // this call has not been initialized and returns here. Therefore the
          // reciprocal call must win, and its callee credential belongs to this
          // placer. This is both deterministic and free of a token/push race.
          const winner = resolution.winnerCallId;
          try { await this.state.storage.delete(`glare_invite:${placer}`); } catch { /* best-effort */ }
          try { await this.state.storage.delete(`glare_invite:${peer}`); } catch { /* best-effort */ }
          try {
            void this.env.Q_ANALYTICS.send({
              event: "call_glare_autoconnect", uid: placer, ts: now,
              props: {
                winner_call_id: winner, this_call_id: callId,
                peer_call_id: resolution.reciprocalCallId,
                app_name: "avatok", service_name: "avatok-api", worker: true,
              },
            });
          } catch { /* best-effort telemetry */ }
          return Response.json({
            glare: true,
            join_call_id: winner,
            roomToken: glareJoinRoomToken(recip),
          });
        }
        if (resolution.pruneReciprocal) {
          try { await this.state.storage.delete(reciprocalKey); } catch { /* best-effort */ }
          try {
            void this.env.Q_ANALYTICS.send({
              event: "call_glare_stale_pruned", uid: placer, ts: now,
              props: {
                reason: resolution.reason, this_call_id: callId,
                peer_call_id: recip?.callId ?? null,
                app_name: "avatok", service_name: "avatok-api", worker: true,
              },
            });
          } catch { /* telemetry never blocks call placement */ }
        }
        // No reciprocal yet — record this placer's pending invite for the window.
        try {
          await this.state.storage.put(`glare_invite:${placer}`, {
            callId, ts: now, callerRoomToken, calleeRoomToken,
          } satisfies PendingGlareInvite);
        } catch { /* best-effort */ }
        return Response.json({ glare: false });
      }
      // Legacy endpoint retained only to prevent old callers from creating new
      // billing state. Human calls are permanently free.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/billing-arm")) {
        await this.retireLegacyBillingAsFree();
        return Response.json({ error: "human calling is permanently free", code: "CALLING_IS_FREE" }, { status: 410 });
      }
      // [WP2] Internal-only: explicit disarm (e.g. a caller/callee abandons the
      // price prompt before the DO ever sees a second peer, or an upstream
      // route needs to cancel billing without a WS close/bye ever happening).
      if (req.method === "POST" && stateUrl.pathname.endsWith("/billing-disarm")) {
        await this.retireLegacyBillingAsFree();
        return Response.json({ ok: true, disarmed: true, free: true });
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
      // Internal-only atomic receptionist admission. Automatic no-answer paths
      // must advance the SAME aggregate that owns cancel/accept; a separate
      // read-then-start check leaves a race in which Ava starts after hangup.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/receptionist-admit")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const callId = typeof body.callId === "string" ? body.callId : "";
        if (!callId) return Response.json({ error: "callId required" }, { status: 400 });
        const out = await this.runCommand(callId, "handoff_to_receptionist", "server", {
          commandId: typeof body.commandId === "string" ? body.commandId.slice(0, 128) : undefined,
        });
        // [RECEPT-DO-OWNERSHIP-1] The admit and the session claim ride together
        // so the automatic no-answer handoff — the latency-sensitive one, where
        // every serial round-trip is silence the caller hears — pays for only one
        // DO hop, not two. The claim runs even when `out` was an idempotent
        // REPLAY, which is the entire point: see claimReceptionistSession().
        //
        // [CALL-ATOMIC-1 2026-08-03] But NOT when the FSM refused the handoff.
        // This used to claim unconditionally and then return 409 on the next
        // line — so a call the aggregate had already declined, connected or
        // completed still had a receptionist session id durably pinned to it,
        // and the real winner's later claim was handed the loser's sid. A replay
        // (`ok:true`, `changed:false`) still claims; a REJECTION does not.
        const sid = typeof body.sid === "string" ? body.sid.slice(0, 64) : "";
        const claim = sid && out.ok !== false ? await this.claimReceptionistSession(sid) : null;
        return Response.json(
          claim ? { ...out, claimed: !claim.already, receptionist_sid: claim.sid } : out,
          { status: out.ok === false ? 409 : 200 },
        );
      }
      // ── [RECEPT-FSM-LIFECYCLE-1 2026-08-03] (audit A4) SERVICE-LEG OUTCOMES ──
      //
      // `receptionist_connected` and `receptionist_failed` were DEFINED in
      // call_state.ts and issued by nobody — grep found zero call sites in any
      // route or DO. Three things followed from that:
      //   * `service_leg_state` was stuck at `starting_receptionist` for the life
      //     of every call that ever reached Ava, so nothing downstream could tell
      //     a session that connected from one that never did;
      //   * a FAILED Ava start never completed the session, parking the caller in
      //     `handoff` — where `humanRoomAcceptsNewPeer` is false, so they could
      //     not fall back to the human leg either — with no service on the line;
      //   * a SUCCESSFUL session's teardown arrived as the client's own
      //     cancel_call/bye, recording `caller_cancelled` for a call Ava actually
      //     answered. The `answered_by_receptionist` disposition was unreachable
      //     dead code.
      //
      // This is the internal-only entry point that closes that loop. Same trust
      // boundary as GET /state and /participants: only reachable from within this
      // Worker, never client-exposed. It accepts ONLY server-lifecycle commands —
      // an allowlist, not a general command proxy, because a route that could
      // issue any command with server authority would quietly reintroduce the
      // client-claimed-role hole that [CALL-AUTHZ-1] closed.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/service-outcome")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const callId = typeof body.callId === "string" ? body.callId : "";
        const name = String(body.command ?? "");
        const ALLOWED: ReadonlySet<string> = new Set([
          "receptionist_connected", "receptionist_failed",
        ]);
        if (!ALLOWED.has(name)) {
          return Response.json({ error: "command_not_allowed", command: name }, { status: 400 });
        }
        const out = await this.runCommand(callId, name as CommandName, "server", {
          commandId: typeof body.commandId === "string" ? body.commandId.slice(0, 128) : undefined,
        });
        return Response.json(out, { status: out.ok === false ? 409 : 200 });
      }
      // [RECEPT-DO-OWNERSHIP-1] Claim WITHOUT a handoff transition, for the
      // caller-initiated lanes (decline-to-Ava, busy) where the callee's own
      // command already advanced the aggregate and only the duplicate-session
      // question is open.
      if (req.method === "POST" && stateUrl.pathname.endsWith("/receptionist-claim")) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const sid = typeof body.sid === "string" ? body.sid.slice(0, 64) : "";
        if (!sid) return Response.json({ error: "sid required" }, { status: 400 });
        const claim = await this.claimReceptionistSession(sid);
        return Response.json({ ok: true, claimed: !claim.already, receptionist_sid: claim.sid });
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
        const result = await this.setParticipants(
          callId,
          callerUid,
          calleeUid,
          body.autoReceptionistEligible === true,
          typeof body.noAnswerReason === "string" ? body.noAnswerReason.slice(0, 48) : null,
        );
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      // Internal-only lookup used by authenticated API routes. Missing
      // participants return no identity data, so call ids cannot be used as an
      // oracle and no recipient can be client-selected.
      if (req.method === "GET" && stateUrl.pathname.endsWith("/participants")) {
        const s = await this.loadSession(stateUrl.searchParams.get("callId") ?? "");
        if (!s.caller_uid || !s.callee_uid) {
          return Response.json({ ok: false, error: "participants_unavailable" }, { status: 503 });
        }
        return Response.json({ ok: true, callerUid: s.caller_uid, calleeUid: s.callee_uid });
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
          const fsm = await this.runCommand(callId ?? "", legacy.name, legacy.actor, {
            commandId,
            authenticatedUid: typeof body.authenticatedUid === "string" ? body.authenticatedUid : undefined,
          });
          const denied = fsm.error === "unauthorized" || fsm.error === "not_a_participant";
          return Response.json(fsm, { status: fsm.ok === false ? (denied ? 403 : 409) : 200 });
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
          const nativeActionToken = typeof body.nativeActionToken === "string"
            ? body.nativeActionToken : "";
          const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : 0;
          const roomTokenExpiresAt = typeof body.roomTokenExpiresAt === "number"
            ? body.roomTokenExpiresAt : 0;
          if (token && expiresAt) {
            await this.state.storage.put("ring_receipt_token", token);
            await this.state.storage.put("token_expires_at", expiresAt);
          }
          if (nativeActionToken && expiresAt) {
            await this.state.storage.put("native_action_token", nativeActionToken);
          }
          // [CALL-WS-AUTH-1 2026-08-03] (audit A1) Per-SIDE room credentials.
          //
          // Two separate tokens, not one shared secret, because the point is not
          // only "is this a participant" but "which participant". A single call
          // token would let either party present it twice and occupy both seats.
          // Minted by routes/api.ts at dial time; the caller's is returned in the
          // /api/call response, the callee's rides the ring push (FCM + the
          // InboxDO WS ring). They outlive ringing because every reconnect is a
          // fresh admission; terminal state is the revocation boundary.
          const callerRoomToken = typeof body.callerRoomToken === "string" ? body.callerRoomToken : "";
          const calleeRoomToken = typeof body.calleeRoomToken === "string" ? body.calleeRoomToken : "";
          if (callerRoomToken && calleeRoomToken && roomTokenExpiresAt) {
            await this.state.storage.put({
              room_token_caller: callerRoomToken,
              room_token_callee: calleeRoomToken,
              room_token_expires_at: roomTokenExpiresAt,
            });
          }
          return Response.json({ ok: true });
        }

        // [CALL-NATIVE-DECLINE-1] The OS notification action can execute while
        // Flutter is completely dead. Validate its short-lived per-call
        // capability INSIDE the same DO that owns the lifecycle, derive the
        // actor from persisted participants, then enter the one call FSM.
        if (type === "native-decline") {
          const clientToken = typeof body.token === "string" ? body.token : "";
          const storedToken = await this.state.storage.get<string>("native_action_token");
          const expiresAt = await this.state.storage.get<number>("token_expires_at") ?? 0;
          const now = Date.now();
          if (!storedToken || clientToken !== storedToken || now > expiresAt) {
            return Response.json({ error: "invalid_or_expired_token" }, { status: 403 });
          }
          const callId = typeof body.callId === "string" ? body.callId : "";
          const session = await this.loadSession(callId);
          if (!callId || !session.callee_uid) {
            return Response.json({ error: "call_authority_unavailable" }, { status: 503 });
          }
          const out = await this.runCommand(callId, "decline_call", "server", {
            authenticatedUid: session.callee_uid,
            commandId: `native-decline:${clientToken}`,
          });
          const denied = out.error === "unauthorized" || out.error === "not_a_participant";
          return Response.json(out, { status: out.ok === false ? (denied ? 403 : 409) : 200 });
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

    // ── [CALL-WS-AUTH-1 2026-08-03] AUTHENTICATE THE WEBSOCKET JOIN (audit A1) ─
    //
    // THE HOLE: index.ts matches `/(api/)?room/<id>` BEFORE any auth and forwards
    // the request straight here, and this handler took `peerId` from a query
    // string with no identity check at all. The only join gates were the session
    // phase, the 2-peer cap and duplicate-socket adoption — none of which asks
    // WHO is joining. Call ids are `avatok-` + 8 hex characters (~32 bits) and
    // they travel through pushes, telemetry and logs. Anyone holding a live call
    // id could:
    //   * join as the second peer — which sets `answeredAt`, so the REAL callee's
    //     accept then hits the 2-peer cap and is busy-rejected, and the
    //     no-answer→Ava handoff is suppressed by the answered probe;
    //   * read and inject SDP/candidates, since the relay is scoped only by
    //     self-declared peer ids;
    //   * simply occupy a seat so neither real party can connect.
    //
    // [CALL-AUTHZ-1] is NOT a mitigation: it gates /api/call/command, an entirely
    // different surface from this relay.
    //
    // THE GATE: a per-side token minted at dial time (see register-token above),
    // presented as `?t=`. It proves both membership AND which seat the joiner is
    // entitled to. Note the check runs BEFORE the aggregate is loaded and before
    // any telemetry that would echo call state — an unauthenticated joiner must
    // not be able to use this endpoint as an oracle for whether a call exists.
    //
    // ROLLOUT: enforcement is behind `callRoomAuthEnforced`, default FALSE, so
    // installed builds that do not yet send `?t=` keep working. Until it is
    // flipped this only OBSERVES — every join is tagged authenticated or not, so
    // the flip can be timed on real data rather than hope. The flag is declared
    // in the PlatformConfig interface AND in DEFAULTS in the same change, per the
    // fake-flag rule (a client-read flag config.ts does not declare can never
    // actually be flipped — the inAppUpdateEnabled failure of 2026-07-15).
    const presentedToken = (url.searchParams.get("t") || "").slice(0, 128);
    const authVerdict = await this.classifyRoomToken(presentedToken);
    const authenticatedSide = authVerdict.ok
      ? authenticatedSideTag(authVerdict.side)
      : null;
    if (!authVerdict.ok) {
      const enforced = await this.roomAuthEnforced();
      try {
        void this.env.Q_ANALYTICS.send({
          event: "invariant_protected", uid: peerId, ts: Date.now(),
          props: {
            kind: "call_ws_join_unauthenticated", side: "server",
            reason: authVerdict.reason, enforced,
            call_id: this.state.id.name ? String(this.state.id.name).slice(0, 64) : null,
            app_name: "avatok", service_name: "avatok-api", worker: true,
          },
        });
      } catch { /* best-effort */ }
      if (enforced) {
        return Response.json({ error: "room_auth_required", reason: authVerdict.reason }, { status: 403 });
      }
    }

    // [CALL-HANDOFF-CALLEE-CLOSE-1] The service handoff and the human room are
    // mutually exclusive. A cancellation push can be delayed or missed, so the
    // CallRoom itself must reject a late Accept after Ava/voicemail owns the
    // caller leg. This is the final server-side safety boundary: even an old or
    // modified client cannot join beside Ava and corrupt the call outcome.
    const aggregate = await this.loadSession(
      url.searchParams.get("callId") ?? (this.state.id.name ? String(this.state.id.name) : ""),
    );
    // [CALL-GRACE-ENDCALL-1 2026-08-03] (audit A2, belt half) The FSM is the
    // primary admission authority and, with the grace-expiry `end_call` above, it
    // is now correct on its own. This second check exists because the two
    // "is the call over" records reached the same conclusion by different routes
    // for a long time, and a room that has been torn down — sockets closed,
    // peer-left delivered — must not accept a new peer under ANY reading. If a
    // future path calls markEnded() without advancing the aggregate, admission
    // stays closed instead of silently reopening the room.
    await this.loadCallState();
    if (this.ended === true) {
      return Response.json({
        error: "human_call_closed",
        status: this.terminalStatus ?? legacyWireStatus(aggregate),
        session_state: aggregate.session_state,
      }, { status: 409 });
    }
    if (!humanRoomAcceptsNewPeer(aggregate)) {
      try {
        void this.env.Q_ANALYTICS.send({
          event: "invariant_protected", uid: peerId, ts: Date.now(),
          props: {
            kind: "late_human_join_after_handoff_rejected",
            call_id: aggregate.call_id,
            session_state: aggregate.session_state,
            wire_status: legacyWireStatus(aggregate),
            app_name: "avatok", service_name: "avatok-api", worker: true,
          },
        });
      } catch { /* best-effort — rejection is authoritative */ }
      return Response.json({
        error: "human_call_closed",
        status: legacyWireStatus(aggregate),
        session_state: aggregate.session_state,
      }, { status: 409 });
    }

    // CALL-RC-D1: is this the SAME peer re-attaching within its grace window?
    // Identity = the `id` query-param tag (the only identity the client already
    // sends and reconnects with — there is no separate auth uid on this route).
    const away = await this.loadAway();
    const isRejoin = !!away && (authenticatedSide && away.side
      ? away.side === authenticatedSide
      : away.id === peerId);

    // Once authenticated, the token's side—not the client-supplied peer id—is
    // the seat identity. This prevents one valid side token opening two sockets
    // under different ids and occupying both seats.
    const isSameSeat = (w: WebSocket): boolean => {
      return sameRoomSeat(this.state.getTags(w), authenticatedSide, peerId);
    };

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
      .filter(isSameSeat);
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
      .filter((w) => !isSameSeat(w));
    const otherSeatCount = new Set(otherPeerSockets
      .map((w) => socketSeatKey(this.state.getTags(w)))
      .filter(Boolean)).size;
    const roomIsFull = roomSeatIsFull(authenticatedSide, otherSeatCount);
    if (!isRejoin && roomIsFull) {
      const reject = new WebSocketPair();
      reject[1].accept();
      try {
        reject[1].send(JSON.stringify({ type: "busy", reason: "AvaTOK calls are 1:1 only" }));
        reject[1].close(1000, "room full (1:1 only)");
      } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: reject[0] });
    }

    // [CALL-ATOMIC-1 2026-08-03] RE-CHECK IMMEDIATELY BEFORE ADMISSION.
    //
    // The authority check above ("the final server-side safety boundary") ran
    // roughly ten awaits ago — loadAway, setAway, scheduleNextAlarm, bumpGen,
    // loadCallState, two puts and a KV write all sit between the decision and
    // this line. A decline, cancel or receptionist handoff landing anywhere in
    // that window was never reconsidered, and the peer was admitted into a call
    // that was already over. That is a boundary with a hole in the middle of it.
    //
    // This costs nothing: runCommandLocked() assigns `this.session` on every
    // transition, so loadSession() returns the current aggregate from memory
    // without touching storage. Re-reading it is the whole fix.
    const admitNow = await this.loadSession(
      url.searchParams.get("callId") ?? (this.state.id.name ? String(this.state.id.name) : ""),
    );
    // Read `ended` back from storage rather than the in-memory mirror. Two
    // reasons, and both matter. Correctness: markEnded() persists it (see that
    // method), so storage is the fresher of the two after any interleaved
    // teardown. Compilation: the earlier `this.ended === true` guard narrows the
    // property to `false | undefined`, TypeScript does not reset that narrowing
    // across an await, and a re-check written against the field therefore fails
    // to compile as the runtime check it is meant to be. One extra read on a
    // path that runs once or twice per call is a fair price.
    const endedNow = (await this.state.storage.get<boolean>("ended")) === true;
    if (endedNow || !humanRoomAcceptsNewPeer(admitNow)) {
      try {
        void this.env.Q_ANALYTICS.send({
          event: "invariant_protected", uid: peerId, ts: Date.now(),
          props: {
            kind: "late_human_join_raced_admission",
            call_id: admitNow.call_id,
            session_state: admitNow.session_state,
            wire_status: legacyWireStatus(admitNow),
            app_name: "avatok", service_name: "avatok-api", worker: true,
          },
        });
      } catch { /* best-effort — rejection is authoritative */ }
      return Response.json({
        error: "human_call_closed",
        status: this.terminalStatus ?? legacyWireStatus(admitNow),
        session_state: admitNow.session_state,
      }, { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // Hibernation: the runtime manages the socket; the peer id rides in the tag
    // so we can address messages and report joins/leaves across hibernation.
    // [CALL-WS-AUTH-1] A SECOND tag records the side the presented room token
    // entitled this socket to. Tag[0] stays the peer id — every existing lookup
    // in this file reads getTags(w)[0] and is untouched — so this is purely
    // additive: it survives hibernation and makes the socket's proven identity
    // inspectable later, rather than being a fact that existed only during the
    // upgrade handshake.
    this.state.acceptWebSocket(
      server,
      authenticatedSide ? [peerId, authenticatedSide] : [peerId],
    );
    // Keepalive: let hibernated sockets answer client pings without waking the
    // DO (CALL-RC-D1 item 5). Same JSON ping/pong convention already used by
    // do/inbox.ts and do/party.ts — the client sends
    // jsonEncode({'type':'ping'}) every ~15s and expects {"type":"pong"} back.
    //
    // [CALL-KEEPALIVE-1 2026-08-03] This comment used to end "the manual
    // webSocketMessage handler never sees these frames once auto-response is
    // armed, so no extra handling needed there". THAT WAS FALSE for every
    // connected call: the match is an EXACT string comparison, and the client
    // stamped `gen` on the frame after `welcome`, so nothing matched, every ping
    // woke the DO, and every ping was relayed to the peer as noise. The client
    // now sends the keepalive raw — but old builds do not, and never will, so
    // webSocketMessage ALSO answers and absorbs `ping` explicitly. Both halves
    // are required; neither is redundant.
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ type: "ping" }),
          JSON.stringify({ type: "pong" }),
        ),
      );
    } catch { /* older runtimes without auto-response: harmless no-op */ }

    const others = this.state.getWebSockets().filter((ws) => ws !== server && !isSameSeat(ws));
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

    // ── [CALL-KEEPALIVE-1 2026-08-03] (audit H5, server half) ────────────────
    //
    // A `ping` should never reach this handler at all: `setWebSocketAutoResponse`
    // is supposed to answer it while the DO stays hibernated. It reached here for
    // every connected call anyway, because the client stamped `gen` on the frame
    // and the auto-response is an EXACT string match. The client fix stops that
    // for new builds; this covers every build already in the field, and it must
    // stay for as long as one of them exists.
    //
    // Two behaviours, both previously wrong:
    //   * ANSWER it. Without a pong the client's new keepalive deadline would
    //     trip on a perfectly healthy call.
    //   * Do NOT RELAY it. With no `to`, a ping fell through to the broadcast
    //     branch below and was forwarded to the PEER — one useless wakeup and one
    //     useless frame per peer every 15 seconds, for the life of every call.
    // `pong` is likewise absorbed: nothing downstream has ever acted on one.
    if (data.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* socket gone */ }
      return;
    }
    if (data.type === "pong") return;

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
      await this.scheduleNextAlarm(); // idempotent after legacy-billing retirement
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
        this.bufferForAwayPeer(away, out);
        // [CALL-AWAYBUF-BYTES-1 2026-08-03] THIS TRY/CATCH IS THE H2 CRASH FIX,
        // and it is the one place in this change where swallowing is CORRECT.
        //
        // `setAway` was called bare here. Its put is the only unbounded write in
        // the relay path, so when the buffer exceeded the 128 KiB DO value cap
        // the throw propagated straight out of webSocketMessage and took the
        // relay down for that frame — an optimisation killing the thing it was
        // optimising. The byte cap above should now make that unreachable, but
        // the correct failure mode if it ever isn't must be stated explicitly,
        // not left to whatever the runtime does.
        //
        // Fail-open is right HERE and fail-closed is right for `fsm` because the
        // stakes are opposite: losing the buffer costs a peer some replayed
        // candidates it can renegotiate for, while losing an FSM write means
        // every participant was told an outcome the server has forgotten.
        try {
          await this.setAway(away);
        } catch {
          // Buffer lost, relay alive. Keep the in-memory copy — it may still
          // replay if this instance survives to the rejoin.
        }
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
    const tags = this.state.getTags(ws);
    const from = tags[0];
    const side = tags[1] === "side:caller" || tags[1] === "side:callee"
      ? tags[1] as RoomSideTag
      : undefined;
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* already closed */ }

    const allOthers = this.state.getWebSockets().filter((w) => w !== ws);
    // Closing the stale half of adopt-and-replace must not mark that seat away.
    const replacementAlive = allOthers.some((w) => {
      const otherTags = this.state.getTags(w);
      return side ? otherTags[1] === side : otherTags[0] === from;
    });
    if (replacementAlive) return;
    const others = allOthers.filter((w) => {
      const otherTags = this.state.getTags(w);
      return side ? otherTags[1] !== side : otherTags[0] !== from;
    });
    if (!from || others.length === 0) {
      // No `from` tag, or the other peer already isn't here (e.g. this was the
      // only socket, or it's already gone) — nothing to grace, nothing to notify.
      return;
    }

    await this.setAway({ id: from, side, awaySince: Date.now(), buffered: [], bufferedBytes: 0 });
    await this.scheduleNextAlarm(); // [WP2] multiplexed with any pending billing tick
    for (const w of others) this.sendTo(w, { type: "peer-away", id: from });
  }

  /** Single alarm for ring timeout, reconnect grace, and retryable retirement
   * of pre-free-policy billing state. It never settles a human-call minute. */
  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.ringDeadline === undefined) this.ringDeadline = (await this.state.storage.get<number>("ringDeadline")) ?? null;
    if (this.ringDeadline != null && now >= this.ringDeadline - 500) {
      const session = await this.loadSession("");
      // ── [CALL-ALARM-ANSWERED-1 2026-08-03] DO NOT TIME OUT A LIVE CALL ──────
      //
      // Scenario 4's residual gap. This branch used to consult NOTHING except
      // the clock: at the ring deadline it ran `ring_timeout` — or started Ava —
      // regardless of whether two people were already talking. The FSM only ever
      // learned about an answer from the client POSTing `accept_call`, and there
      // are several ordinary ways that POST never lands: an old build that never
      // sends it, a lost request, or the client's own 1500 ms claim timeout,
      // which fails OPEN to WebSocket admission by design. In every one of those
      // the room has two live peers on a working call while the aggregate still
      // says `ringing`, and 20 s in the alarm broadcasts `no-answer` over the top
      // of the conversation or drops Ava into the middle of it.
      //
      // EVIDENCE USED, and one that deliberately is NOT:
      //   * `session_state === "connected"` — the aggregate already knows.
      //   * two DISTINCT peer tags holding sockets right now. Distinct tags, not
      //     `getWebSockets().length`: the adopt-and-close path for a duplicate
      //     socket on the SAME peer id can transiently show two entries for one
      //     participant, and counting those as a connected call would suppress
      //     no-answer for a callee who never picked up.
      //   * `answeredAt` is NOT sufficient on its own and is deliberately not
      //     part of this test. It is STICKY — set the instant a second socket
      //     ever attached, never cleared — so a zombie join (an FCM-woken socket
      //     on an offline callee that dies before media) leaves it true forever.
      //     That exact staleness already vetoed the unreachable→Ava handoff with
      //     409 call_answered in prod (avatok-8caef3ce). Trusting it here would
      //     re-import that bug into the timeout path: a phantom-answered call
      //     would never time out and never reach Ava. Live sockets are evidence;
      //     a sticky historical flag is not.
      //
      // On a trip we also issue `mark_connected`, so the aggregate stops
      // disagreeing with the sockets. Without it the session would sit in
      // `ringing` for a call that is demonstrably live, and a later `end_call`
      // would mislabel the disposition — `wasConnected` reads the FSM, not the
      // room (call_state.ts). The command is idempotent, so an alarm that trips
      // this guard repeatedly costs nothing.
      //
      // STRUCTURE: this skips the RING BRANCH ONLY and falls through. `alarm()`
      // is multiplexed — reconnect-grace expiry, legacy-billing retirement and
      // scheduleNextAlarm() all live below. An early `return` here would silently
      // kill the away-peer grace expiry and the billing refund retry on any
      // connected call, which is a worse bug than the one being fixed.
      const liveTags = new Set(
        this.state.getWebSockets()
          .map((w) => socketSeatKey(this.state.getTags(w)))
          .filter((t): t is string => typeof t === "string" && t.length > 0),
      );
      const callIsLive = session.session_state === "connected" || liveTags.size >= 2;
      if (callIsLive) {
        // Hydrate before the telemetry below reads `answeredAt`. It is NOT part
        // of the guard (see above — it is sticky and would re-import the
        // phantom-answered bug), but it is the single most useful field for
        // telling a genuine lost-accept from a zombie join when reading these
        // events back, and after an eviction it is `undefined` until this runs.
        await this.loadCallState();
        this.ringDeadline = null;
        try { await this.state.storage.delete("ringDeadline"); } catch { /* best-effort */ }
        if (session.session_state !== "connected") {
          // The room proves what the aggregate missed. Teach it.
          await this.runCommand(session.call_id || String(this.state.id.name ?? ""), "mark_connected", "server");
        }
        try {
          void this.env.Q_ANALYTICS.send({
            event: "invariant_protected", uid: session.callee_uid ?? "", ts: now,
            props: {
              kind: "ring_timeout_suppressed_call_live", side: "server",
              call_id: session.call_id || (this.state.id.name ? String(this.state.id.name).slice(0, 64) : null),
              session_state: session.session_state,
              live_peers: liveTags.size,
              answered_at: this.answeredAt ?? null,
              caller_uid: session.caller_uid, callee_uid: session.callee_uid,
              app_name: "avatok", service_name: "avatok-api", worker: true,
            },
          });
        } catch { /* best-effort — the guard itself is authoritative */ }
      } else {
      if (this.autoReceptionistEligible === undefined) {
        this.autoReceptionistEligible =
          (await this.state.storage.get<boolean>("autoReceptionistEligible")) ?? false;
      }
      if (this.noAnswerReason === undefined) {
        this.noAnswerReason =
          (await this.state.storage.get<string>("noAnswerReason")) || null;
      }
      const autoAva = this.autoReceptionistEligible === true;
      // The deadline itself decides the outcome. A client timer may only act as
      // a delivery backstop; it cannot independently race no-answer against Ava.
      const result = await this.runCommand(
        session.call_id,
        autoAva ? "handoff_to_receptionist" : "ring_timeout",
        "server",
        autoAva ? { data: { reason: "no_answer" } } : {},
      );
      this.ringDeadline = null;
      try { await this.state.storage.delete("ringDeadline"); } catch { /* best-effort */ }
      if (result.ok === true && result.changed === true && typeof result.peer_uid === "string") {
        try {
          await this.env.Q_PUSH.send({
            kind: "call-status",
            to: result.peer_uid,
            callId: session.call_id,
            status: result.wire_status,
            ...(autoAva ? { activation_mode: "rings" } : {}),
            ...(!autoAva && this.noAnswerReason
              ? { no_answer_reason: this.noAnswerReason }
              : {}),
            ts: Date.now(),
            seq: result.seq,
          });
        } catch { /* socket path remains authoritative for connected clients */ }
        // The callee may have received the invite through FCM without ever
        // attaching a socket. Explicitly cancel that native ring as well; this
        // is what prevents a delayed invite from ringing past the server lease.
        if (session.callee_uid && session.callee_uid !== result.peer_uid) {
          try {
            await this.env.Q_PUSH.send({
              kind: "call-status",
              to: session.callee_uid,
              callId: session.call_id,
              status: "cancel",
              ts: Date.now(),
              seq: result.seq,
            });
          } catch { /* native duration remains the final ring backstop */ }
        }
      }
      } // ← end of the connected-guard `else` (ring branch). Fall through.
    }
    const away = await this.loadAway();
    if (away && now >= away.awaySince + RECONNECT_GRACE_MS - 500) {
      // CALL-RC-D1: fires ~45s after a peer's WS closed/errored. If it never
      // reconnected (still marked away), end the call the old way: peer-left
      // to whoever's left, then close their socket too.
      await this.setAway(null);
      // ── [CALL-GRACE-ENDCALL-1 2026-08-03] (audit A2) ───────────────────────
      //
      // This branch used to call markEnded() ONLY, which sets the legacy `ended`
      // flag and nothing else. The AGGREGATE was never advanced, so a call whose
      // grace had expired — peer-left already sent, both sockets closed, the
      // surviving user already shown "call ended" — was still `connected` or
      // `ringing` as far as the FSM was concerned.
      //
      // WS admission consults the FSM and only the FSM (humanRoomAcceptsNewPeer),
      // so `connected` still ACCEPTS new peers. A device that reconnected a
      // moment after expiry was therefore admitted into a room the server had
      // already declared over, resurrecting a dead call against a peer who was
      // gone. It also meant a graced-out call never recorded a disposition at
      // all, so it was invisible in call history and analytics.
      //
      // Issuing `end_call` as `server` fixes both: the session becomes terminal
      // (so the admission check refuses the late rejoin), and the reducer picks
      // the honest disposition from the evidence — `answered_by_callee` if the
      // call had connected, `ring_timeout` if it never did.
      try {
        await this.runCommand(String(this.state.id.name ?? ""), "end_call", "server");
      } catch { /* the markEnded + close below still tears the room down */ }
      await this.markEnded(); // CALL-KV-STATE-1: grace expired, call ended (also disarms billing → refundUnused)
      for (const w of this.state.getWebSockets()) {
        this.sendTo(w, { type: "peer-left", id: away.id });
        try { w.close(1000, "peer reconnect grace expired"); } catch { /* already closed */ }
      }
    }
    // Never settle another legacy human-call minute after the permanent-free
    // policy. Full-refund any pre-transition state on its next alarm.
    await this.retireLegacyBillingAsFree();
    await this.scheduleNextAlarm();
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }
}
