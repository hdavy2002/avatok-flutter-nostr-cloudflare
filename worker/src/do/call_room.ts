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
import type { Env } from "../types";

interface AwayPeer {
  id: string;
  awaySince: number;
  /** Signaling messages addressed to this peer while it was away, oldest first. */
  buffered: string[];
}

const RECONNECT_GRACE_MS = 30_000;
const MAX_BUFFERED_MESSAGES = 100;

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

  private async markEnded(): Promise<void> {
    this.ended = true;
    try { await this.state.storage.put("ended", true); } catch { /* best-effort */ }
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
        });
      }
      // P1 ring-ack control-plane (Phase 1, receptTakeoverGuard). A server worker
      // (the FCM push consumer) POSTs the outcome of the incoming-call push so the
      // CALLER — the only peer in the room during ring — learns whether the callee's
      // phone could ring. Broadcast to every connected socket (only the caller is
      // here pre-answer); the client ignores unknown frames when the flag is OFF.
      // No sockets connected → harmless no-op. Never persists anything.
      if (req.method === "POST") {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
        const type = typeof body.type === "string" ? body.type : "";
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

    // STANDARD RULE: AvaTOK calls are strictly 1:1 (P2P). Never allow a third
    // participant — there are no group calls in AvaTOK (group calling lives in
    // AvaConsult). Refuse the join with a 'busy' so the extra caller ends cleanly.
    // An away-peer rejoin doesn't count against the cap: the stale socket for
    // that peer is already gone (webSocketClose already fired for it).
    if (!isRejoin && this.state.getWebSockets().length >= 2) {
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
      try { await this.state.storage.deleteAlarm(); } catch { /* no alarm set */ }
      const buffered = away!.buffered;
      this.sendTo(server, { type: "welcome", id: peerId, peers: otherIds });
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

    this.sendTo(server, { type: "welcome", id: peerId, peers: otherIds });
    for (const ws of others) this.sendTo(ws, { type: "peer-joined", id: peerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(message); } catch { return; }

    data.from = this.state.getTags(ws)[0];
    const all = this.state.getWebSockets();
    const out = JSON.stringify(data);

    // CALL-RC-D1: explicit hangup ends the call immediately for both sides —
    // no grace period, even if the other peer is currently "away". Clear any
    // pending away/alarm state before relaying so a lingering alarm can't fire
    // a stray peer-left after the call already ended cleanly.
    if (data.type === "bye" || data.type === "hangup") {
      await this.setAway(null);
      await this.markEnded(); // CALL-KV-STATE-1: call is over — GET /state reports ended
      try { await this.state.storage.deleteAlarm(); } catch { /* no alarm set */ }
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
    try { await this.state.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS); } catch { /* best-effort */ }
    for (const w of others) this.sendTo(w, { type: "peer-away", id: from });
  }

  /** CALL-RC-D1: fires ~30s after a peer's WS closed/errored. If it never
   *  reconnected (still marked away), end the call the old way: peer-left to
   *  whoever's left, then close their socket too. */
  async alarm(): Promise<void> {
    const away = await this.loadAway();
    if (!away) return; // peer already rejoined and cleared this
    await this.setAway(null);
    await this.markEnded(); // CALL-KV-STATE-1: grace expired, call ended
    for (const w of this.state.getWebSockets()) {
      this.sendTo(w, { type: "peer-left", id: away.id });
      try { w.close(1000, "peer reconnect grace expired"); } catch { /* already closed */ }
    }
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }
}
