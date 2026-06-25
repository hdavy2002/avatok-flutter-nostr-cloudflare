// MeshRoom — P2P **mesh** group-call signaling relay for the FREE tier
// (≤5 participants). One instance per group id. Like CallRoom it is pure
// coordination — it relays WebRTC signaling between peers and persists nothing —
// but it allows up to 5 peers instead of 2 so a small group can run a full mesh
// (each device holds a direct P2P connection to every other; media never touches
// our servers, ICE via Cloudflare STUN/TURN). Paid tiers do NOT use this — they
// run on the LiveKit SFU (routes/conference.ts). 1:1 calls stay on CallRoom.
//
// Protocol (identical to CallRoom, so the client signaling code is shared):
//   newcomer joins  → server sends {type:"welcome", id, peers:[...]} to it
//                     and {type:"peer-joined", id} to everyone already here
//   peer leaves     → server sends {type:"peer-left", id} to the rest
//   offer/answer/candidate/bye carry a `to` (peer id); the server stamps `from`
//   and forwards ONLY to that peer. A message with no `to` is broadcast.
//
// Mesh role rule (avoids glare): the NEWCOMER creates an offer to EACH existing
// peer (the client createOffers from the `welcome.peers` list). Existing peers
// only answer. This is the same handshake CallRoom uses, generalized to N peers.
//
// Presence: a plain (non-WebSocket) GET returns {live,count,max} so the chat
// thread can show the "Ongoing call · N — tap to join" banner for mesh calls
// (the SFU has ListParticipants; mesh has this).
import type { Env } from "../types";

const MAX_MESH = 5;

export class MeshRoom {
  private state: DurableObjectState;
  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    // Presence probe (non-WS): how many are in this mesh call right now.
    if (req.headers.get("Upgrade") !== "websocket") {
      const count = this.state.getWebSockets().length;
      return new Response(JSON.stringify({ live: count > 0, count, max: MAX_MESH }), {
        headers: { "content-type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const peerId = (url.searchParams.get("id") || crypto.randomUUID()).slice(0, 64);

    // FREE mesh cap: 5 participants. The 6th is refused with a 'full' so the
    // extra caller ends cleanly (paid tiers should be on the SFU, not here).
    if (this.state.getWebSockets().length >= MAX_MESH) {
      const reject = new WebSocketPair();
      reject[1].accept();
      try {
        reject[1].send(JSON.stringify({ type: "full", reason: `mesh call is full (${MAX_MESH})` }));
        reject[1].close(1000, "room full (mesh ≤5)");
      } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: reject[0] });
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // Hibernation: the runtime manages the socket; the peer id rides in the tag.
    this.state.acceptWebSocket(server, [peerId]);

    const others = this.state.getWebSockets().filter((ws) => ws !== server);
    const otherIds = others
      .map((ws) => this.state.getTags(ws)[0])
      .filter((x) => x && x !== peerId);

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
      // A bye/decline addressed to a peer that already left must NOT be dropped —
      // broadcast it so that side ends cleanly (same hotfix as CallRoom).
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
