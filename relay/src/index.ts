/**
 * AvaTalk Nostr relay (NIP-01) on Cloudflare Workers + Durable Object (SQLite).
 *
 * Supports: EVENT (verify id + schnorr sig, store, broadcast), REQ (query +
 * live subscribe + EOSE), CLOSE. One global relay DO for the foundation; shard
 * by kind/time later. Call signaling (kind 25050, NIP-100) rides on this.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

export interface Env {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (req.headers.get("Upgrade") === "websocket" || url.pathname === "/export") {
      const id = env.RELAY.idFromName("relay-global");
      return env.RELAY.get(id).fetch(req);
    }
    // NIP-11 relay information document
    if (req.headers.get("Accept") === "application/nostr+json") {
      return new Response(
        JSON.stringify({
          name: "AvaTalk Relay",
          description: "AvaTalk primary Nostr relay",
          supported_nips: [1, 9, 11, 17, 25, 42, 100],
          software: "avatok-relay",
          version: "0.1.0",
        }),
        { headers: { "content-type": "application/nostr+json", "access-control-allow-origin": "*" } },
      );
    }
    return new Response("AvaTalk Nostr relay. Connect via WebSocket.", {
      headers: { "content-type": "text/plain" },
    });
  },
};

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagKey: string]: unknown; // #e, #p, ...
};

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function serializeForId(e: NostrEvent): Uint8Array {
  const arr = [0, e.pubkey, e.created_at, e.kind, e.tags, e.content];
  return new TextEncoder().encode(JSON.stringify(arr));
}

function verifyEvent(e: NostrEvent): boolean {
  try {
    const id = hex(sha256(serializeForId(e)));
    if (id !== e.id) return false;
    return schnorr.verify(e.sig, e.id, e.pubkey);
  } catch {
    return false;
  }
}

export class RelayRoom {
  state: DurableObjectState;
  // ws -> (subId -> filters[])
  subs = new Map<WebSocket, Map<string, Filter[]>>();

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY, pubkey TEXT, created_at INTEGER, kind INTEGER,
        tags TEXT, content TEXT, sig TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kind ON events(kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_author ON events(pubkey, created_at);`,
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Account export (Backup): a user's own events + gift wraps addressed to them.
    if (url.pathname === "/export") {
      const pubkey = (url.searchParams.get("pubkey") || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pubkey)) {
        return new Response(JSON.stringify({ error: "bad pubkey" }),
          { status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      }
      const rows = this.state.storage.sql.exec(
        `SELECT id,pubkey,created_at,kind,tags,content,sig FROM events
         WHERE pubkey=? OR (kind=1059 AND tags LIKE ?)
         ORDER BY created_at DESC LIMIT 10000`,
        pubkey, `%${pubkey}%`,
      ).toArray();
      const events = rows.map((r: any) => ({
        id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind,
        tags: JSON.parse(r.tags), content: r.content, sig: r.sig,
      }));
      return new Response(
        JSON.stringify({ pubkey, count: events.length, exported_at: Date.now(), events }),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.subs.set(server, new Map());
    server.addEventListener("message", (ev) => this.onMessage(server, ev.data as string));
    server.addEventListener("close", () => this.subs.delete(server));
    server.addEventListener("error", () => this.subs.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws: WebSocket, msg: unknown) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  onMessage(ws: WebSocket, raw: string) {
    let msg: unknown[];
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg)) return;
    const type = msg[0];
    if (type === "EVENT") this.handleEvent(ws, msg[1] as NostrEvent);
    else if (type === "REQ") this.handleReq(ws, msg[1] as string, msg.slice(2) as Filter[]);
    else if (type === "CLOSE") this.subs.get(ws)?.delete(msg[1] as string);
  }

  handleEvent(ws: WebSocket, e: NostrEvent) {
    if (!e || !e.id || !e.sig || !verifyEvent(e)) {
      this.send(ws, ["OK", e?.id ?? "", false, "invalid: bad id or signature"]);
      return;
    }
    // NIP-09 deletion / replaceable handling kept minimal for the foundation.
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO events(id,pubkey,created_at,kind,tags,content,sig)
       VALUES (?,?,?,?,?,?,?)`,
      e.id, e.pubkey, e.created_at, e.kind, JSON.stringify(e.tags), e.content, e.sig,
    );
    this.send(ws, ["OK", e.id, true, ""]);
    // Live broadcast to matching subscriptions.
    for (const [sock, subMap] of this.subs) {
      for (const [subId, filters] of subMap) {
        if (filters.some((f) => matches(f, e))) this.send(sock, ["EVENT", subId, e]);
      }
    }
  }

  handleReq(ws: WebSocket, subId: string, filters: Filter[]) {
    this.subs.get(ws)?.set(subId, filters);
    // Query stored events for each filter, union, newest first.
    const seen = new Set<string>();
    const out: NostrEvent[] = [];
    for (const f of filters) {
      for (const e of this.query(f)) {
        if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
      }
    }
    out.sort((a, b) => b.created_at - a.created_at);
    for (const e of out) this.send(ws, ["EVENT", subId, e]);
    this.send(ws, ["EOSE", subId]);
  }

  query(f: Filter): NostrEvent[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.authors?.length) {
      where.push(`pubkey IN (${f.authors.map(() => "?").join(",")})`);
      args.push(...f.authors);
    }
    if (f.kinds?.length) {
      where.push(`kind IN (${f.kinds.map(() => "?").join(",")})`);
      args.push(...f.kinds);
    }
    if (typeof f.since === "number") { where.push(`created_at >= ?`); args.push(f.since); }
    if (typeof f.until === "number") { where.push(`created_at <= ?`); args.push(f.until); }
    if (f.ids?.length) {
      where.push(`id IN (${f.ids.map(() => "?").join(",")})`);
      args.push(...f.ids);
    }
    const limit = Math.min(typeof f.limit === "number" ? f.limit : 500, 2000);
    const sql = `SELECT id,pubkey,created_at,kind,tags,content,sig FROM events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC LIMIT ${limit}`;
    const rows = this.state.storage.sql.exec(sql, ...args).toArray();
    const events: NostrEvent[] = rows.map((r: any) => ({
      id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind,
      tags: JSON.parse(r.tags), content: r.content, sig: r.sig,
    }));
    // Tag filters (#e, #p, ...) applied in JS.
    const tagFilters = Object.keys(f).filter((k) => k.startsWith("#"));
    if (!tagFilters.length) return events;
    return events.filter((e) =>
      tagFilters.every((tk) => {
        const want = f[tk] as string[];
        const letter = tk.slice(1);
        return e.tags.some((t) => t[0] === letter && want.includes(t[1]));
      }),
    );
  }
}

function matches(f: Filter, e: NostrEvent): boolean {
  if (f.ids?.length && !f.ids.includes(e.id)) return false;
  if (f.authors?.length && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds?.length && !f.kinds.includes(e.kind)) return false;
  if (typeof f.since === "number" && e.created_at < f.since) return false;
  if (typeof f.until === "number" && e.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (!k.startsWith("#")) continue;
    const want = f[k] as string[];
    const letter = k.slice(1);
    if (!e.tags.some((t) => t[0] === letter && want.includes(t[1]))) return false;
  }
  return true;
}
