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
// P8 Stage 1 (chatArchiveV2): batch message appends into R2 cold-archive jsonl.
// R2 PUT ops are the cost driver, not bytes — so we flush on whichever comes first:
const ARCHIVE_FLUSH_COUNT = 100;      // …every 100 newly-appended messages, or…
const ARCHIVE_FLUSH_MS = 5 * 60_000;  // …every 5 minutes (the alarm cadence when on).
const ARCHIVE_BATCH_MAX = 1000;       // rows read per flush (bounds a backfill burst)

export class InboxDO {
  private state: DurableObjectState;
  private sql: SqlStorage;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    // [WS-AUTORESP-1] Let the runtime answer the client's 25s app-level
    // {"type":"ping"} with {"type":"pong"} WITHOUT waking this hibernated DO.
    // Previously every ping ran webSocketMessage → ~3,456 needless wakes/day per
    // connected user (billed DO requests/duration). The string must match the
    // client frame EXACTLY (sync_hub.dart sends jsonEncode({'type':'ping'})).
    // The manual ping handler in webSocketMessage stays as a fallback for any
    // differently-shaped ping; it just never fires for the common case now.
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ type: "ping" }),
          JSON.stringify({ type: "pong" }),
        ),
      );
    } catch { /* older runtimes without auto-response: manual handler covers it */ }
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
       );
       -- Per-user CALL LOG (Cloudflare-native, multi-device). The call history is
       -- the OWNER's own state — it lives in their InboxDO so every device on the
       -- account (Mac/iPhone/Android) shares ONE history and a delete/clear on any
       -- device syncs to the rest (live frame to open sockets + FCM wake for asleep
       -- devices + full snapshot on the next /sync). entry_id is a client UUID =
       -- the cross-device identity for per-row delete. deleted=1 is a tombstone so a
       -- late echo can't resurrect a removed row; tombstones are pruned opportunistically.
       CREATE TABLE IF NOT EXISTS call_log (
         entry_id TEXT PRIMARY KEY,
         name TEXT,
         seed TEXT,
         video INTEGER NOT NULL DEFAULT 0,
         dir TEXT NOT NULL DEFAULT 'outgoing',
         ts INTEGER NOT NULL DEFAULT 0,
         deleted INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER
       );
       CREATE INDEX IF NOT EXISTS idx_call_ts ON call_log(ts);`,
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
    // Owner's per-message SOFT-DELETE flag (1 = hidden on this user's devices, with
    // Undo; the body is retained). This is the OWNER's private state — it lives in
    // their own InboxDO so all of their devices (iPhone/Mac/PC) sync the same hide/
    // Undo via /sync + the live 'hide' broadcast. Never set on a peer's inbox.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN hidden INTEGER`); } catch { /* already present */ }
    // P8 Stage 1: tiny durable KV for the archive owner uid + high-water (last
    // archived message id). Kept in DO-SQLite so it survives hibernation cheaply.
    try { this.sql.exec(`CREATE TABLE IF NOT EXISTS meta_kv (k TEXT PRIMARY KEY, v TEXT)`); } catch { /* present */ }
    // Retention: turn the per-user inbox into a RELAY + offline buffer instead of a
    // permanent archive (the device keeps history locally + in Drive/R2 backup).
    // Controlled by INBOX_RETENTION_DAYS — UNSET/0 = disabled (keep forever, current
    // behavior). When enabled, a daily alarm prunes aged-out messages. We set the
    // alarm once on construction (only if none pending) so enabling the env var and
    // redeploying starts pruning without per-request cost.
    if (this.retentionMs() > 0 || this.archiveOn()) {
      this.state.blockConcurrencyWhile(async () => {
        if ((await this.state.storage.getAlarm()) == null) {
          // Faster cadence when the batched archive is on (it flushes on the alarm).
          await this.state.storage.setAlarm(Date.now() + (this.archiveOn() ? ARCHIVE_FLUSH_MS : DAY_MS));
        }
      });
    }
  }

  // ── P8 Stage 1: batched R2 cold archive ────────────────────────────────────
  private _archivePending = 0; // appends since last flush (in-memory; reset on hibernation — the alarm still flushes)

  private archiveOn(): boolean {
    // Gated by a cheap Worker var (like INBOX_RETENTION_DAYS/CHAT_ARCHIVE) so we
    // never pay a per-wake KV read. Maps to the `chatArchiveV2` launch flag.
    return (this.env as unknown as { CHAT_ARCHIVE_V2?: string }).CHAT_ARCHIVE_V2 === "1" && !!this.env.BACKUP_R2;
  }
  private getMeta(k: string): string | null {
    try { return String((this.sql.exec(`SELECT v FROM meta_kv WHERE k=?`, k).one() as { v: string }).v); }
    catch { return null; }
  }
  private setMeta(k: string, v: string): void {
    try { this.sql.exec(`INSERT INTO meta_kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=?`, k, v, v); }
    catch { /* best-effort */ }
  }
  private archiveHw(): number { return Number(this.getMeta("archive_hw") || 0) || 0; }

  /** Flush new (id > high-water) rows to a per-user R2 jsonl segment. Idempotent by
   *  high-water; never throws (durability, not delivery). One R2 PUT per batch. */
  private async flushArchive(): Promise<void> {
    if (!this.archiveOn()) return;
    const owner = this.getMeta("owner");
    if (!owner) return;
    const t0 = Date.now();
    const hw = this.archiveHw();
    // F3: a flush that starts from high-water 0 IS the one-time backfill of this
    // user's existing DO-SQLite history — same idempotent, high-water-gated, paced
    // (ARCHIVE_BATCH_MAX) mechanism, so no separate job is needed.
    const isBackfill = hw === 0;
    let rows: Record<string, unknown>[] = [];
    try {
      rows = this.sql.exec(
        `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at, audience, hidden
           FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`, hw, ARCHIVE_BATCH_MAX,
      ).toArray() as Record<string, unknown>[];
    } catch { return; }
    if (!rows.length) return;
    const firstId = Number(rows[0].id);
    const lastId = Number(rows[rows.length - 1].id);
    const jsonl = rows.map((r) => JSON.stringify({ t: "msg", ...r })).join("\n") + "\n";
    const d = new Date();
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `archive/${owner}/${ym}/${firstId}.jsonl`;
    try {
      await this.env.BACKUP_R2.put(key, jsonl, { httpMetadata: { contentType: "application/x-ndjson" } });
    } catch { return; } // leave high-water unchanged → retried next flush (idempotent by firstId key)
    this.setMeta("archive_hw", String(lastId));
    this._archivePending = 0;
    const done = rows.length < ARCHIVE_BATCH_MAX; // this batch drained the tail
    try {
      void this.env.Q_ANALYTICS.send({
        event: isBackfill ? "archive_backfill" : "chat_archive_flush", uid: owner, ts: Date.now(),
        props: { count: rows.length, msgs: rows.length, ms: Date.now() - t0, done,
          first_id: firstId, last_id: lastId, bytes: jsonl.length, key,
          app_name: "avatok", service_name: "avatok-api", worker: true, account_id: owner },
      });
    } catch { /* best-effort */ }
    // Backfill/large batch: more than a batch waiting → keep draining (best-effort;
    // the alarm re-drives it too).
    if (rows.length >= ARCHIVE_BATCH_MAX) { void this.flushArchive(); }
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
    // P8 Stage 1 safety: when the batched archive is ON, NEVER drop a row that
    // hasn't been durably archived yet — only prune id <= the archive high-water.
    // (When the archive is off, the device + Drive/R2 blob remain the durable copy,
    // so the original age-only prune stands.)
    const hwGuard = this.archiveOn() ? ` AND id <= ${this.archiveHw()}` : "";
    this.sql.exec(
      `DELETE FROM messages
         WHERE ((stored_at IS NOT NULL AND stored_at < ?1)
            OR (stored_at IS NULL AND created_at > 1000000000000 AND created_at < ?1))${hwGuard}`,
      cutoff,
    );
  }

  /** Retention/archive alarm — flush the R2 archive (when on) BEFORE pruning so
   *  the high-water covers everything eligible, then prune, then reschedule. */
  async alarm(): Promise<void> {
    if (this.archiveOn()) { try { await this.flushArchive(); } catch { /* best-effort */ } }
    this.prune();
    if (this.retentionMs() > 0 || this.archiveOn()) {
      await this.state.storage.setAlarm(Date.now() + (this.archiveOn() ? ARCHIVE_FLUSH_MS : DAY_MS));
    }
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") return this.accept();
    const url = new URL(req.url);
    try {
      // Call-log ops MUST be matched before "/append" — "/call/append" also ends
      // with "/append" and would otherwise hit the message-append path.
      if (url.pathname.endsWith("/call/append")) return this.callAppend(await req.json());
      if (url.pathname.endsWith("/call/delete")) return this.callDelete(await req.json());
      if (url.pathname.endsWith("/call/clear")) return this.callClear();
      if (url.pathname.endsWith("/append")) return this.append(await req.json());
      if (url.pathname.endsWith("/sync")) {
        return new Response(JSON.stringify(this.syncPayload(Number(url.searchParams.get("cursor") || 0))), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/receipt")) return this.receipt(await req.json());
      if (url.pathname.endsWith("/hide")) return this.hide(await req.json());
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
        try { this.sql.exec("DELETE FROM call_log"); } catch { /* table may predate this migration */ }
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

    // DELETE-FOR-EVERYONE. A {t:'del'|'gdel', target:<client_id>} control is NEVER
    // stored as a message row — a stored control renders as raw `{"t":"del",...}`
    // text on any client that doesn't special-case it (e.g. an older build), which
    // is exactly the leak we saw. Instead, mirror hide(): redact the recipient's
    // targeted copy so it never re-syncs, and broadcast a {type:'del'} CONTROL frame
    // so a live recipient redacts now (offline recipients are reached by the
    // high-priority FCM 'del' push from the send route). The OWNER's own copy is
    // left intact (soft-hide + Undo is handled client-side / via the hide channel),
    // and we do NOT bump their unread. Returns WITHOUT inserting a message row.
    if (b.body && (b.body.includes('"t":"del"') || b.body.includes('"t":"gdel"'))) {
      let target = "";
      try {
        const ctrl = JSON.parse(b.body);
        if (ctrl && (ctrl.t === "del" || ctrl.t === "gdel")) target = String(ctrl.target ?? "");
      } catch { /* not actually a control envelope — fall through to normal store */ }
      if (target) {
        let live = false;
        if (b.owner !== b.sender) {
          this.sql.exec(
            `UPDATE messages SET kind='deleted', body='{"t":"deleted"}', media_ref=NULL, edited_at=? WHERE conv=? AND client_id=?`,
            Date.now(), b.conv, target,
          );
          live = this.broadcast(JSON.stringify({ type: "del", conv: b.conv, target }));
          try { void this.env.Q_ANALYTICS.send({ event: "message_tombstoned", uid: b.owner, ts: Date.now(),
            props: { conv: b.conv, target, delete_id: target, by: b.sender, app_name: "avatok", service_name: "avatok-api", worker: true, account_id: b.owner } }); } catch { /* best-effort */ }
        }
        return new Response(JSON.stringify({ id: 0, live }), { headers: { "content-type": "application/json" } });
      }
    }

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
      // created_at is the SENDER's clock (unreliable for latency math). server_ts is
      // the InboxDO append/broadcast instant — the recipient computes
      // msg_delivery_latency = now - server_ts against it (P13-A). Additive field.
      created_at: created, server_ts: Date.now(), audience,
    });
    const live = this.broadcast(frame);
    // P8 Stage 1: feed the batched R2 archive (dark unless CHAT_ARCHIVE_V2=1). Flush
    // on the 100-message threshold; the alarm covers the 5-minute time bound. The
    // R2 write runs after the response via waitUntil — never blocks delivery.
    if (this.archiveOn()) {
      if (!this.getMeta("owner")) this.setMeta("owner", b.owner);
      this._archivePending++;
      if (this._archivePending >= ARCHIVE_FLUSH_COUNT) {
        this._archivePending = 0;
        void this.flushArchive(); // best-effort; the 5-min alarm is the backstop
      }
    }
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

  private syncPayload(cursor: number): { type: "sync"; messages: unknown[]; receipts: unknown[]; convs: unknown[]; reads: unknown[]; calls: unknown[] } {
    const messages = this.sql.exec(
      `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at, audience, hidden
       FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      cursor, SYNC_LIMIT,
    ).toArray();
    const receipts = this.sql.exec(`SELECT conv, peer, delivered_id, read_id FROM receipts`).toArray();
    const convs = this.sql.exec(`SELECT conv, last_id, unread, peer FROM conv_meta`).toArray();
    // OWNER read high-water per conv — lets a fresh client restore its unread
    // state instead of recounting the whole re-synced backlog as new.
    const reads = this.sql.exec(`SELECT conv, read_ts FROM read_state`).toArray();
    // Authoritative call-log snapshot (live rows + tombstones). The client merges:
    // adds live rows it's missing, removes any it holds that are tombstoned here.
    // Small + capped, so a full snapshot every sync is cheap (no separate cursor).
    let calls: unknown[] = [];
    try {
      calls = this.sql.exec(
        `SELECT entry_id, name, seed, video, dir, ts, deleted FROM call_log ORDER BY ts DESC LIMIT 200`,
      ).toArray();
    } catch { /* table may predate this migration on an old DO */ }
    return { type: "sync", messages, receipts, convs, reads, calls };
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

  // Owner soft-hides / un-hides one of their own messages (delete-for-me, the
  // owner side of delete-for-everyone, or Undo). Persisted on the owner's own
  // message row and broadcast to their OTHER open sockets so a second device
  // (Mac/PC) reflects the hide/Undo live. Matched on the shared client_id.
  private hide(b: { conv: string; target?: string; hidden?: boolean }): Response {
    const target = String(b.target ?? "");
    const conv = String(b.conv ?? "");
    if (!target || !conv) return new Response(JSON.stringify({ ok: false, error: "conv + target required" }), { headers: { "content-type": "application/json" } });
    const hidden = b.hidden ? 1 : 0;
    this.sql.exec(`UPDATE messages SET hidden=?1 WHERE conv=?2 AND client_id=?3`, hidden, conv, target);
    const live = this.broadcast(JSON.stringify({ type: "hide", conv, target, hidden: !!b.hidden }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  // ---- call log (owner multi-device) -----------------------------------------
  // Tombstones older than this are pruned opportunistically on the next write, so
  // the table can't grow without bound after repeated deletes/clears.
  private static readonly CALL_TOMBSTONE_TTL_MS = 30 * DAY_MS;

  private pruneCallTombstones(): void {
    try {
      this.sql.exec(
        `DELETE FROM call_log WHERE deleted=1 AND updated_at IS NOT NULL AND updated_at < ?1`,
        Date.now() - InboxDO.CALL_TOMBSTONE_TTL_MS,
      );
    } catch { /* best-effort */ }
  }

  // A new call entry, recorded by whichever device placed/received the call. INSERT
  // OR REPLACE keeps it idempotent on the shared entry_id (the same row re-synced
  // or re-pushed never duplicates), and un-tombstones nothing because a deleted id
  // is never re-appended. Broadcasts {type:'call'} to the owner's OTHER open sockets.
  private callAppend(b: { entry_id?: string; name?: string; seed?: string; video?: boolean; dir?: string; ts?: number }): Response {
    const id = String(b.entry_id ?? "").trim();
    if (!id) return new Response(JSON.stringify({ ok: false, error: "entry_id required" }), { headers: { "content-type": "application/json" } });
    // If this id was already deleted on another device, honor the tombstone — don't
    // resurrect it (the owner removed it deliberately). Idempotent re-append is a no-op.
    const existing = this.sql.exec(`SELECT deleted FROM call_log WHERE entry_id=?1`, id).toArray();
    if (existing.length && Number((existing[0] as any).deleted) === 1) {
      return new Response(JSON.stringify({ ok: true, tombstoned: true, live: false }), { headers: { "content-type": "application/json" } });
    }
    this.sql.exec(
      `INSERT INTO call_log (entry_id, name, seed, video, dir, ts, deleted, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
       ON CONFLICT(entry_id) DO UPDATE SET name=?2, seed=?3, video=?4, dir=?5, ts=?6, updated_at=?7`,
      id, b.name ?? "", b.seed ?? "", b.video ? 1 : 0, String(b.dir ?? "outgoing"), Math.floor(Number(b.ts) || 0), Date.now(),
    );
    const live = this.broadcast(JSON.stringify({
      type: "call", entry_id: id, name: b.name ?? "", seed: b.seed ?? "",
      // Emit `video` as an INTEGER (0/1), NOT a JS boolean. The deployed 0.1.17
      // client parses this live frame with `r['video'] as num?` and CRASHES on a
      // JSON bool ("type 'bool' is not a subtype of type 'num?'", CallEntry.fromServer
      // → SyncHub._onFrame) — every call-log frame took the app down, which is why
      // "any FCM (voicemail/missed) crashes the app": the FCM woke a sync that
      // delivered this frame. The stored column + /sync snapshot are already 0/1;
      // only this broadcast leaked a bool. Int parses cleanly on old AND new apps.
      video: b.video ? 1 : 0, dir: String(b.dir ?? "outgoing"), ts: Math.floor(Number(b.ts) || 0),
    }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  // Owner deletes one call entry on any device → tombstone + broadcast {type:'call_del'}.
  private callDelete(b: { entry_id?: string }): Response {
    const id = String(b.entry_id ?? "").trim();
    if (!id) return new Response(JSON.stringify({ ok: false, error: "entry_id required" }), { headers: { "content-type": "application/json" } });
    this.sql.exec(
      `INSERT INTO call_log (entry_id, video, dir, ts, deleted, updated_at)
         VALUES (?1, 0, 'outgoing', 0, 1, ?2)
       ON CONFLICT(entry_id) DO UPDATE SET deleted=1, updated_at=?2`,
      id, Date.now(),
    );
    this.pruneCallTombstones();
    const live = this.broadcast(JSON.stringify({ type: "call_del", entry_id: id }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  // Owner clears the WHOLE history on any device. Drop every row (the snapshot the
  // other devices pull on /sync is then empty) and broadcast {type:'call_clear'}.
  private callClear(): Response {
    this.sql.exec(`DELETE FROM call_log`);
    const live = this.broadcast(JSON.stringify({ type: "call_clear" }));
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
      return;
    }
    // ONLINE message search — across ALL of THIS user's conversations, server-side.
    // Per-user isolated by construction (this is the user's own InboxDO), so it
    // fills the gaps a single device is missing (other devices' history). No new
    // HTTP route — rides the socket the user already has open.
    if (m.type === "search" && typeof m.q === "string") {
      try { ws.send(JSON.stringify(this.searchPayload(m.q, m.reqId))); } catch { /* */ }
    }
  }

  private searchPayload(q: string, reqId: unknown): { type: "searchResults"; reqId: unknown; results: unknown[] } {
    const query = String(q || "").trim();
    if (query.length < 2) return { type: "searchResults", reqId, results: [] };
    const like = "%" + query.replace(/[%_]/g, "") + "%";
    const rows = this.sql.exec(
      `SELECT conv, sender, body, client_id, created_at, hidden FROM messages
        WHERE body LIKE ? AND (kind IS NULL OR kind != 'deleted')
        ORDER BY id DESC LIMIT 60`,
      like,
    ).toArray();
    return { type: "searchResults", reqId, results: rows };
  }
  webSocketClose(ws: WebSocket, code: number): void {
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* */ }
  }
  webSocketError(ws: WebSocket): void {
    try { ws.close(1011); } catch { /* */ }
  }
}
