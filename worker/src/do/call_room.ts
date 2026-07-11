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
  // CALL-GEN-1: per-peer generation counter. Each accepted (re)join / reconnect of
  // a peer id bumps its gen; the 'welcome' tells the client its current gen, and it
  // stamps gen on every frame. A frame whose gen is LOWER than the DO's current gen
  // for that sender is a stale artifact from a superseded transport → dropped, so a
  // gen-1 zombie socket can never disrupt a gen-2 call. Persisted so it survives
  // hibernation/eviction (a re-hydrated DO must not hand out a lower gen).
  private gens: Record<string, number> | undefined; // undefined = not loaded yet
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
    if (!wasEnded) await this.stopBilling(reason);
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

  /** Disarm the ticker and refund whatever's left in escrow. Safe to call more
   *  than once (refundUnused is idempotent on `refund:call:<call_id>`, and a
   *  second call here is a no-op once `billing` is cleared). Never throws —
   *  a billing hiccup must never break call teardown. */
  private async stopBilling(reason: ReasonCode): Promise<void> {
    const b = await this.loadBilling();
    if (!b || b.stopped) return;
    await this.setBilling({ ...b, stopped: true });
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

    const all = this.state.getWebSockets();
    const out = JSON.stringify(data);

    // CALL-RC-D1: explicit hangup ends the call immediately for both sides —
    // no grace period, even if the other peer is currently "away". Clear any
    // pending away/alarm state before relaying so a lingering alarm can't fire
    // a stray peer-left after the call already ended cleanly.
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
