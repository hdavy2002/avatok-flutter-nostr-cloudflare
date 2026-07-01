// PartyDO — the AvaVerse "PartyKit" realtime layer (replaces Ably; owner decision
// 2026-07-01). One Durable Object per ROOM, keyed by idFromName(`${type}:${id}`),
// holding the room's hibernatable WebSockets. This is the partyserver pattern
// (rooms of sockets on our OWN Durable Objects) built in the house style used by
// InboxDO — NOT a third-party edge, so it can't thrash the way Ably did, and it
// runs on the same infra as the durable InboxDO backbone.
//
// STRICTLY EPHEMERAL. Nothing here is a source of truth: no SQLite, no history.
// Durable delivery stays on InboxDO (+ /sync + marketplace forceResync). The
// party carries only the live layer — typing, presence, receipts, reactions, the
// marketplace "agents negotiating" stream, listing/viewer updates, conference
// presence, Ava token streaming, live badges. If the party socket is down, the
// user loses only the live nicety; the durable copy still lands in InboxDO.
//
// WebSocket framing (client ↔ DO):
//   (connect)  GET /ws?uid=<uid>&room=<type:id>   → 101, joins the room
//   server →   {t:'presence', roster:[uid...], count, event:'join'|'leave', uid}
//   client →   {t:<eventType>, ...}   → DO stamps {from, ts} and RELAYS to others
//   client →   {t:'ping'}             → {t:'pong'} (auto-response, no DO wake)
//
// Event types are OPAQUE to the DO — it just relays them — so adding a new live
// feature is a client-only change. Known types in use: typing, receipt, reaction,
// agent_status, neg_stream, deal_ready, viewer, listing_update, conf_presence,
// ava_stream, badge.
import type { Env } from "../types";

interface SockMeta { uid: string; room: string; since: number; events: number }

export class PartyDO {
  private state: DurableObjectState;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Let the runtime answer the client's keepalive ping WITHOUT waking this DO
    // (same billing win as InboxDO). Frame must match the Dart client exactly.
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ t: "ping" }),
          JSON.stringify({ t: "pong" }),
        ),
      );
    } catch { /* older runtime: manual ping handler below covers it */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws") && req.headers.get("Upgrade") === "websocket") {
      const uid = url.searchParams.get("uid") || "";
      const room = url.searchParams.get("room") || "";
      if (!uid || !room) return new Response("uid+room required", { status: 400 });
      return this.accept(uid, room);
    }
    // Server-side broadcast INTO a room (e.g. the marketplace agent loop streaming
    // progress from the Worker). POST /emit {t,...}. Never persisted.
    if (url.pathname.endsWith("/emit") && req.method === "POST") {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body.t !== "string") return new Response("bad", { status: 400 });
      const live = this.broadcast(JSON.stringify({ ...body, from: body.from ?? "server", ts: Date.now() }), null);
      return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }

  private accept(uid: string, room: string): Response {
    const pair = new WebSocketPair();
    const server = pair[1];
    // tag = uid so getWebSockets(uid) can target a user; attachment survives
    // hibernation and carries per-socket identity + a live event tally.
    this.state.acceptWebSocket(server, [uid]);
    const meta: SockMeta = { uid, room, since: Date.now(), events: 0 };
    try { server.serializeAttachment(meta); } catch { /* */ }
    // Tell the joiner + everyone else the new roster.
    const roster = this.roster();
    this.broadcast(JSON.stringify({ t: "presence", event: "join", uid, roster, count: roster.length }), null);
    this.track("party_room_join", uid, { room, count: roster.length });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let m: any;
    try { m = JSON.parse(message); } catch { return; }
    if (m.t === "ping") { try { ws.send(JSON.stringify({ t: "pong" })); } catch { /* */ } return; }
    const meta = this.meta(ws);
    if (!meta) return;
    if (typeof m.t !== "string") return;
    // Stamp sender identity server-side (client can't spoof `from`) + relay to the
    // rest of the room. The DO does not interpret the event — pure fan-out.
    meta.events++;
    try { ws.serializeAttachment(meta); } catch { /* */ }
    const frame = JSON.stringify({ ...m, from: meta.uid, ts: Date.now() });
    this.broadcast(frame, ws); // exclude the sender's own socket
    // Sample event telemetry (1 in 20) so a busy room doesn't flood analytics but
    // we can still see live-layer traffic by type.
    if (Math.random() < 0.05) this.track("party_event", meta.uid, { room: meta.room, type: m.t });
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const meta = this.meta(ws);
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* */ }
    if (meta) {
      // getWebSockets() still includes this closing socket briefly; recompute the
      // roster EXCLUDING it so the "left" broadcast reflects reality.
      const roster = this.roster(ws);
      this.broadcast(JSON.stringify({ t: "presence", event: "leave", uid: meta.uid, roster, count: roster.length }), ws);
      this.track("party_room_leave", meta.uid, {
        room: meta.room, count: roster.length,
        uptime_ms: Date.now() - meta.since, events: meta.events,
      });
    }
  }

  webSocketError(ws: WebSocket): void {
    const meta = this.meta(ws);
    if (meta) this.track("party_socket_error", meta.uid, { room: meta.room });
    try { ws.close(1011); } catch { /* */ }
  }

  // ---- helpers ---------------------------------------------------------------
  private meta(ws: WebSocket): SockMeta | null {
    try { return (ws.deserializeAttachment() as SockMeta) ?? null; } catch { return null; }
  }

  /** Unique uids currently in the room, optionally excluding one socket. */
  private roster(exclude?: WebSocket): string[] {
    const uids = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      const meta = this.meta(ws);
      if (meta?.uid) uids.add(meta.uid);
    }
    return [...uids];
  }

  private broadcast(frame: string, exclude: WebSocket | null): boolean {
    let live = false;
    for (const ws of this.state.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      try { ws.send(frame); live = true; } catch { /* socket gone */ }
    }
    return live;
  }

  /** Rich, non-blocking telemetry so the live layer is never a black box. */
  private track(event: string, uid: string, props: Record<string, unknown>): void {
    try {
      void (this.env as any).Q_ANALYTICS?.send({
        event, uid, ts: Date.now(),
        props: { ...props, transport: "party", app_name: "avatok", service_name: "avatok-api", worker: true, account_id: uid },
      });
    } catch { /* best-effort */ }
  }
}
