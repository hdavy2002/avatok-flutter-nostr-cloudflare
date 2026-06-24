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
import { type MessageScope, scopeAudience } from "../lib/ava_kinds";

const SYNC_LIMIT = 500;

const DAY_MS = 86_400_000;

export class InboxDO {
  private state: DurableObjectState;
  private sql: SqlStorage;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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
       -- Ava visibility scope (Phase 0 contract). NULL = thread-scoped (the
       -- default, every existing row); a uid = private-to-that-uid (ava_private,
       -- Guardian warnings). The worker decides WHICH InboxDO a private message
       -- is written to (server-side enforcement); this column lets the client
       -- render/withhold correctly. See worker/src/lib/ava_kinds.ts.
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
       );
       -- The OWNER's own read high-water per conversation (a unix-SECONDS ts,
       -- matching the client createdAt unit). Distinct from the receipts table,
       -- which tracks the PEER's read state of MY messages (for the tick marks).
       -- This restores what I have already read on a fresh login / second device,
       -- so old messages do not re-appear as unread after a full re-sync.
       CREATE TABLE IF NOT EXISTS read_state (
         conv TEXT PRIMARY KEY,
         read_ts INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER
       );`,
    );
    // Additive migration for the Ava visibility scope. Guarded: on a fresh DO
    // the column is created by the (extended) CREATE above's absence — SQLite has
    // no "ADD COLUMN IF NOT EXISTS", so we try and swallow the "duplicate column"
    // error on already-migrated DOs. Backward compatible: existing rows get NULL
    // (= thread-scoped). New `messages` tables created after this code ships
    // still need the column, so we ALTER unconditionally inside the try.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN audience TEXT`); } catch { /* already present */ }
    // Server-stamped insert time (ms) — used for retention pruning. created_at is
    // client-supplied and unit-ambiguous (seconds vs ms across legacy rows), so we
    // never prune on it directly. stored_at is always server-ms.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN stored_at INTEGER`); } catch { /* already present */ }
    // Retention: turn the per-user inbox into a RELAY + offline buffer instead of a
    // permanent archive (the device keeps history locally + in Drive/R2 backup).
    // Controlled by INBOX_RETENTION_DAYS — UNSET/0 = disabled (keep forever, current
    // behavior). When enabled, a daily alarm prunes aged-out messages. We set the
    // alarm once on construction (only if none pending) so enabling the env var and
    // redeploying starts pruning without per-request cost.
    if (this.retentionMs() > 0) {
      this.state.blockConcurrencyWhile(async () => {
        if ((await this.state.storage.getAlarm()) == null) {
          await this.state.storage.setAlarm(Date.now() + DAY_MS);
        }
      });
    }
  }

  /** Retention window in ms (0 = disabled). */
  private retentionMs(): number {
    const days = Number(this.env.INBOX_RETENTION_DAYS || 0);
    return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
  }

  /** Delete aged-out messages. Unit-safe: prune on server stored_at, plus legacy
   *  ms-scale created_at rows; never touch seconds-scale rows. No-op if disabled. */
  private prune(): void {
    const ms = this.retentionMs();
    if (ms <= 0) return;
    const cutoff = Date.now() - ms;
    this.sql.exec(
      `DELETE FROM messages
         WHERE (stored_at IS NOT NULL AND stored_at < ?1)
            OR (stored_at IS NULL AND created_at > 1000000000000 AND created_at < ?1)`,
      cutoff,
    );
  }

  /** Daily retention alarm — prune + reschedule while retention is enabled. */
  async alarm(): Promise<void> {
    this.prune();
    if (this.retentionMs() > 0) {
      await this.state.storage.setAlarm(Date.now() + DAY_MS);
    }
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
      if (url.pathname.endsWith("/read")) return this.markRead(await req.json());
      if (url.pathname.endsWith("/event")) return this.event(await req.json());
      // Transient "Ava is working…" chip — broadcast only, never persisted.
      if (url.pathname.endsWith("/ava_status")) return this.avaStatus(await req.json());
      // Backfill export: recent text-bearing messages so the Ava brain can index
      // them into the user's Cloudflare AI Search instance (server-readable — the
      // body is plaintext in the Cloudflare-native arch). Used by /api/ava/rag/backfill.
      if (url.pathname.endsWith("/export")) {
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 1000)));
        const rows = this.sql.exec(
          `SELECT id, conv, sender, kind, body, created_at FROM messages
           WHERE body IS NOT NULL AND body != '' ORDER BY id DESC LIMIT ?`,
          limit,
        ).toArray();
        return new Response(JSON.stringify({ messages: rows }), { headers: { "content-type": "application/json" } });
      }
      // GDPR deletion cascade (Phase 9 A1): wipe ALL DO storage for this user.
      // Peers keep their own copies in their own InboxDOs (their side of the
      // conversation survives, as the spec requires).
      if (url.pathname.endsWith("/purge") && req.method === "POST") {
        // Row deletes keep the schema valid for any in-flight access; the DO
        // then idles back to (near-)nothing.
        this.sql.exec("DELETE FROM messages");
        this.sql.exec("DELETE FROM receipts");
        this.sql.exec("DELETE FROM conv_meta");
        this.sql.exec("DELETE FROM read_state");
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
  // `scope` (Phase 0 contract): 'thread' (default) fans out normally; `to:<uid>`
  // marks the row private to that uid. PRIVACY ENFORCEMENT IS SERVER-SIDE: the
  // avatok-api Worker decides which InboxDO(s) to append a private message to (it
  // only writes the intended recipient's InboxDO). This DO just persists the
  // `audience` on the row + echoes it on the frame/sync so the client renders or
  // withholds correctly. `kind` may be a new Ava kind ('ava' | 'ava_private');
  // 'ava_status' must NOT be persisted — use `avaStatus()`/`event()` for that.
  private append(b: {
    conv: string; sender: string; owner: string; kind?: string;
    body?: string; media_ref?: string; client_id?: string; created_at?: number;
    scope?: MessageScope;
  }): Response {
    const created = b.created_at || Date.now();
    const audience = scopeAudience(b.scope); // null = thread-scoped (default)
    const row = this.sql.exec(
      `INSERT INTO messages (conv, sender, kind, body, media_ref, client_id, created_at, audience, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      b.conv, b.sender, b.kind || "text", b.body ?? null, b.media_ref ?? null, b.client_id ?? null, created, audience, Date.now(),
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
      body: b.body ?? null, media_ref: b.media_ref ?? null, client_id: b.client_id ?? null,
      created_at: created, audience,
    });
    const live = this.broadcast(frame);
    return new Response(JSON.stringify({ id, live }), { headers: { "content-type": "application/json" } });
  }

  // Transient "Ava is working…" chip (Phase 0 contract). Broadcast-only, NEVER
  // persisted (reuses the `event` fan-out path). The frame carries the
  // AvaStatusBody fields so the client can show/replace/clear the chip. Reached
  // via POST /event with {type:'ava_status', ...} too — this helper is the
  // typed entry point the agent loop (P3) / Guardian (P8) / image gen (P9) call.
  private avaStatus(b: { conv: string; label: string; status_id?: string; phase?: "start" | "end"; source?: string }): Response {
    const live = this.broadcast(JSON.stringify({
      type: "ava_status", conv: b.conv, label: b.label,
      status_id: b.status_id ?? null, phase: b.phase ?? "start", source: b.source ?? null,
    }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  private syncPayload(cursor: number): { type: "sync"; messages: unknown[]; receipts: unknown[]; convs: unknown[]; reads: unknown[] } {
    const messages = this.sql.exec(
      `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at, audience
       FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      cursor, SYNC_LIMIT,
    ).toArray();
    const receipts = this.sql.exec(`SELECT conv, peer, delivered_id, read_id FROM receipts`).toArray();
    const convs = this.sql.exec(`SELECT conv, last_id, unread, peer FROM conv_meta`).toArray();
    // OWNER read high-water per conv — lets a fresh client restore its unread
    // state instead of recounting the whole re-synced backlog as new.
    const reads = this.sql.exec(`SELECT conv, read_ts FROM read_state`).toArray();
    return { type: "sync", messages, receipts, convs, reads };
  }

  // Owner marks a conversation read up to `read_ts` (unix seconds). Monotonic —
  // never moves backwards. Zeroes the server unread counter for the conv so it
  // can't resurrect, and broadcasts to the owner's OTHER open sockets (a second
  // device) so their badge clears live too.
  private markRead(b: { conv: string; read_ts?: number }): Response {
    const ts = Math.max(0, Math.floor(Number(b.read_ts) || 0));
    this.sql.exec(
      `INSERT INTO read_state (conv, read_ts, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(conv) DO UPDATE SET read_ts=MAX(read_ts, ?2), updated_at=?3`,
      b.conv, ts, Date.now(),
    );
    this.sql.exec(`UPDATE conv_meta SET unread=0 WHERE conv=?1`, b.conv);
    const live = this.broadcast(JSON.stringify({ type: "read", conv: b.conv, read_ts: ts }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
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
    if (m.type === "read" && typeof m.conv === "string") {
      // Persist + fan out to the owner's other sockets. Same path as POST /read.
      this.markRead({ conv: m.conv, read_ts: Number(m.read_ts) || 0 });
      return;
    }
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
