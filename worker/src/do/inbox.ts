// InboxDO — one per user (idFromName(uid)). The messaging core of the
// Cloudflare-native architecture (Nostr deprecated). Holds:
//   • the user's live hibernatable WebSocket(s) — presence = a socket is open,
//   • the user's DURABLE message log in DO-local SQLite (per-user sharded write,
//     never a central D1 hot store).
// The avatok-api Worker is the router: it validates (Clerk JWT + KYC + block),
// then appends to each member's InboxDO and pushes live or enqueues FCM.
//
// Internal ops (Worker → DO fetch, never exposed publicly):
//   POST /append   {conv, sender, owner, kind, body, media_ref, client_id, created_at}
//                  → {id, live}   (live = at least one socket open)
//   GET  /sync?cursor=N            → {messages, receipts, convs}
//   POST /receipt  {conv, peer, delivered_id?, read_id?} → {ok, live}
// WebSocket framing (client ↔ DO):
//   client → {type:'hello'|'sync', cursor}     server → {type:'sync', messages, receipts, convs}
//   client → {type:'ping'}                      server → {type:'pong'}
//   server → {type:'msg', ...row}               (live delivery)
//   server → {type:'receipt', conv, peer, delivered_id?, read_id?}
import type { Env } from "../types";

const SYNC_LIMIT = 500;

export class InboxDO {
  private state: DurableObjectState;
  private sql: SqlStorage;
  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         conv TEXT NOT NULL,
         sender TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'text',
         body TEXT,
         media_ref TEXT,
         client_id TEXT,
         created_at INTEGER NOT NULL,
         edited_at INTEGER
       );
       CREATE INDEX IF NOT EXISTS idx_msg_id ON messages(id);
       CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv, id);
       CREATE TABLE IF NOT EXISTS receipts (
         conv TEXT NOT NULL,
         peer TEXT NOT NULL,
         delivered_id INTEGER,
         read_id INTEGER,
         updated_at INTEGER,
         PRIMARY KEY (conv, peer)
       );
       CREATE TABLE IF NOT EXISTS conv_meta (
         conv TEXT PRIMARY KEY,
         last_id INTEGER,
         unread INTEGER NOT NULL DEFAULT 0,
         peer TEXT,
         updated_at INTEGER
       );`,
    );
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") return this.accept();
    const url = new URL(req.url);
    try {
      if (url.pathname.endsWith("/append")) return this.append(await req.json());
      if (url.pathname.endsWith("/sync")) {
        return new Response(JSON.stringify(this.syncPayload(Number(url.searchParams.get("cursor") || 0))), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/receipt")) return this.receipt(await req.json());
      if (url.pathname.endsWith("/event")) return this.event(await req.json());
      // GDPR deletion cascade (Phase 9 A1): wipe ALL DO storage for this user.
      // Peers keep their own copies in their own InboxDOs (their side of the
      // conversation survives, as the spec requires).
      if (url.pathname.endsWith("/purge") && req.method === "POST") {
        // Row deletes keep the schema valid for any in-flight access; the DO
        // then idles back to (near-)nothing.
        this.sql.exec("DELETE FROM messages");
        this.sql.exec("DELETE FROM receipts");
        this.sql.exec("DELETE FROM conv_meta");
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500 });
    }
    return new Response("not found", { status: 404 });
  }

  private accept(): Response {
    const pair = new WebSocketPair();
    // Hibernation: the runtime owns the socket; all durable state is in SQLite.
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---- internal ops ----------------------------------------------------------
  private append(b: {
    conv: string; sender: string; owner: string; kind?: string;
    body?: string; media_ref?: string; client_id?: string; created_at?: number;
  }): Response {
    const created = b.created_at || Date.now();
    const row = this.sql.exec(
      `INSERT INTO messages (conv, sender, kind, body, media_ref, client_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      b.conv, b.sender, b.kind || "text", b.body ?? null, b.media_ref ?? null, b.client_id ?? null, created,
    ).one();
    const id = Number(row.id);
    const incoming = b.sender !== b.owner;
    this.sql.exec(
      `INSERT INTO conv_meta (conv, last_id, unread, peer, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(conv) DO UPDATE SET last_id=?2, unread=unread+?3, updated_at=?5`,
      b.conv, id, incoming ? 1 : 0, b.sender, created,
    );
    const frame = JSON.stringify({
      type: "msg", id, conv: b.conv, sender: b.sender, kind: b.kind || "text",
      body: b.body ?? null, media_ref: b.media_ref ?? null, client_id: b.client_id ?? null, created_at: created,
    });
    const live = this.broadcast(frame);
    return new Response(JSON.stringify({ id, live }), { headers: { "content-type": "application/json" } });
  }

  private syncPayload(cursor: number): { type: "sync"; messages: unknown[]; receipts: unknown[]; convs: unknown[] } {
    const messages = this.sql.exec(
      `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at
       FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      cursor, SYNC_LIMIT,
    ).toArray();
    const receipts = this.sql.exec(`SELECT conv, peer, delivered_id, read_id FROM receipts`).toArray();
    const convs = this.sql.exec(`SELECT conv, last_id, unread, peer FROM conv_meta`).toArray();
    return { type: "sync", messages, receipts, convs };
  }

  private receipt(b: { conv: string; peer: string; delivered_id?: number; read_id?: number }): Response {
    this.sql.exec(
      `INSERT INTO receipts (conv, peer, delivered_id, read_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(conv, peer) DO UPDATE SET
         delivered_id=MAX(COALESCE(delivered_id,0), COALESCE(?3, delivered_id, 0)),
         read_id=MAX(COALESCE(read_id,0), COALESCE(?4, read_id, 0)),
         updated_at=?5`,
      b.conv, b.peer, b.delivered_id ?? null, b.read_id ?? null, Date.now(),
    );
    const live = this.broadcast(JSON.stringify({
      type: "receipt", conv: b.conv, peer: b.peer,
      delivered_id: b.delivered_id ?? null, read_id: b.read_id ?? null,
    }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  // Transient SYSTEM event (Phase 4+: storage summary, booking blips, …) —
  // broadcast to open sockets only, never persisted in the message log. The
  // frame is the body as-is; callers set {type:'storage'|...}. Screens that
  // missed it (socket closed) refresh on open, so durability isn't needed.
  private event(b: Record<string, unknown>): Response {
    const live = this.broadcast(JSON.stringify(b));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  private broadcast(frame: string): boolean {
    let live = false;
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); live = true; } catch { /* socket gone */ }
    }
    return live;
  }

  // ---- WebSocket (hibernation handlers) --------------------------------------
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let m: any;
    try { m = JSON.parse(message); } catch { return; }
    if (m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* */ } return; }
    if (m.type === "hello" || m.type === "sync") {
      try { ws.send(JSON.stringify(this.syncPayload(Number(m.cursor || 0)))); } catch { /* */ }
    }
  }
  webSocketClose(ws: WebSocket, code: number): void {
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* */ }
  }
  webSocketError(ws: WebSocket): void {
    try { ws.close(1011); } catch { /* */ }
  }
}
