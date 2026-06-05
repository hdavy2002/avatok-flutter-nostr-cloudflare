// AvaTalk Nostr relay — thin entry. Forwards WebSocket + /export to the single
// global RelayRoom DO. No auth, no D1 here (Rulebook: router is a forwarder;
// auth + storage live inside the DO).
import { RelayRoom } from "./relay_do";
export { RelayRoom };

export interface Env {
  RELAY: DurableObjectNamespace;
  DB_RELAY: D1Database;
  Q_PUSH: Queue;
  Q_BRAIN: Queue;                     // AvaBrain extraction (public kinds only)
  ANALYTICS?: AnalyticsEngineDataset; // operational metrics (events per kind)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "avatok-relay" }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    // Per-user inbox DO sharding: route each connection to a DO keyed by the
    // client's pubkey (millions of tiny DOs, each hibernating when idle), instead
    // of one global DO. The pubkey is a routing hint only — NIP-42 inside the DO
    // still proves ownership before any private read/write. Anonymous readers get
    // an ephemeral DO so they don't all pile onto one instance.
    if (req.headers.get("Upgrade") === "websocket" || url.pathname === "/export") {
      const pk = (url.searchParams.get("pubkey") || "").toLowerCase();
      const name = /^[0-9a-f]{64}$/.test(pk) ? pk : `anon-${crypto.randomUUID()}`;
      return env.RELAY.get(env.RELAY.idFromName(name)).fetch(req);
    }

    if (req.headers.get("Accept") === "application/nostr+json") {
      return new Response(
        JSON.stringify({
          name: "AvaTalk Relay",
          description: "AvaTalk primary Nostr relay",
          supported_nips: [1, 9, 11, 17, 25, 42, 100],
          software: "avatok-relay",
          version: "0.2.0",
          limitation: { auth_required: false, restricted_writes: true },
        }),
        { headers: { "content-type": "application/nostr+json", "access-control-allow-origin": "*" } },
      );
    }

    return new Response("AvaTalk Nostr relay. Connect via WebSocket.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
