// CallRoom — group-call signaling relay (WebSocket Hibernation). One instance
// per room id. Pure coordination: relays signaling messages between connected
// peers; persists nothing (per Rulebook, DOs are coordination, not storage).
// Phase 3 migrates 1:1 signaling to NIP-100 over the relay; this stays for
// group SFU coordination.
import type { Env } from "../types";

export class CallRoom {
  private state: DurableObjectState;
  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    // Hibernation: the runtime manages the socket; webSocketMessage wakes us.
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Fan out to every other peer in this room.
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws) {
        try { peer.send(message); } catch { /* peer gone */ }
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    try { ws.close(code); } catch { /* already closed */ }
  }

  webSocketError(ws: WebSocket): void {
    try { ws.close(1011); } catch { /* ignore */ }
  }
}
