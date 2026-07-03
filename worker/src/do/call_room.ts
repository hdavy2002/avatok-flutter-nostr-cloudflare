// CallRoom — 1:1 call signaling relay (WebSocket Hibernation). One instance per
// room id. Pure coordination: relays WebRTC signaling between the two peers in a
// room; persists nothing (per Rulebook, DOs are coordination, not storage).
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
import type { Env } from "../types";

export class CallRoom {
  private state: DurableObjectState;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
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

    // STANDARD RULE: AvaTOK calls are strictly 1:1 (P2P). Never allow a third
    // participant — there are no group calls in AvaTOK (group calling lives in
    // AvaConsult). Refuse the join with a 'busy' so the extra caller ends cleanly.
    if (this.state.getWebSockets().length >= 2) {
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

    const others = this.state.getWebSockets().filter((ws) => ws !== server);
    const otherIds = others
      .map((ws) => this.state.getTags(ws)[0])
      .filter((x) => x && x !== peerId);

    // CALLFIX-R8: when the second peer joins (both peers now present), write the
    // call_answered KV flag so receptionist.ts's abort guard fires. Extract the
    // call_id from the room name (idFromName output); format matches receptionist.ts.
    if (otherIds.length > 0) {
      const roomId = this.state.id.name;
      const callId = roomId ? String(roomId).slice(0, 64) : null;
      if (callId) {
        try {
          await this.env.TOKENS.put(`call_answered:${callId}`, "true", { expirationTtl: 300 });
        } catch { /* best-effort: KV failure never breaks signaling */ }
      }
    }

    this.sendTo(server, { type: "welcome", id: peerId, peers: otherIds });
    for (const ws of others) this.sendTo(ws, { type: "peer-joined", id: peerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(message); } catch { return; }

    data.from = this.state.getTags(ws)[0];
    const all = this.state.getWebSockets();
    const out = JSON.stringify(data);

    if (typeof data.to === "string" && data.to) {
      let delivered = false;
      for (const w of all) {
        if (this.state.getTags(w)[0] === data.to) {
          try { w.send(out); delivered = true; } catch { /* peer gone */ }
        }
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

  webSocketClose(ws: WebSocket, code: number): void {
    const from = this.state.getTags(ws)[0];
    for (const w of this.state.getWebSockets()) {
      if (w !== ws) this.sendTo(w, { type: "peer-left", id: from });
    }
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* already closed */ }
  }

  webSocketError(ws: WebSocket): void {
    try { ws.close(1011); } catch { /* ignore */ }
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }
}
