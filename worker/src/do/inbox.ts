// InboxDO — one per user (idFromName(uid)). The messaging core of the
// Cloudflare-native architecture (Nostr deprecated). Holds:
//   • the user's live hibernatable WebSocket(s) — presence = a socket is open,
//   • the user's DURABLE message log in DO-local SQLite (per-user sharded write,
//     never a central D1 hot store).
// The avatok-api Worker is the router: it validates (Clerk JWT + KYC + block),
// then appends to each member's InboxDO and pushes live or enqueues FCM.
//
// Internal ops (Worker → DO fetch, never exposed publicly):
//   POST /append   {conv, sender, owner, kind, body, media_ref, client_id, created_at, device_id?}
//                  → {id, live, already_processed?}   (live = at least one socket
//                    open; already_processed=true when [SRV-MSG-IDEMP-1] deduped a
//                    re-sent client_id — the caller/client treats it as a success)
//   GET  /sync?cursor=N            → {messages, receipts, convs}
//   POST /receipt  {conv, peer, delivered_id?, read_id?} → {ok, live}
//   POST /msg_receipt {conv, peer, status, msg_ids} → {ok, live}   [AVAGRP-SEENBY-1]
//                  per-message group receipts, called on the ORIGINAL AUTHOR's own
//                  InboxDO only. GET /msg_receipt?conv=&mids=a,b,c → {conv, receipts}
// WebSocket framing (client ↔ DO):
//   client → {type:'hello'|'sync', cursor}     server → {type:'sync', messages, receipts, convs}
//   client → {type:'ping'}                      server → {type:'pong'}
//   server → {type:'msg', ...row}               (live delivery)
//   server → {type:'receipt', conv, peer, delivered_id?, read_id?}
import type { Env } from "../types";
import { type MessageScope, scopeAudience } from "../lib/ava_kinds";
import { shouldFail } from "../lib/fault_inject";

const SYNC_LIMIT = 500;

// [SRV-MSG-IDEMP-1] Cheap 32-bit FNV-1a → 8-hex. Used ONLY to hash a conv id for
// duplicate-block telemetry so PostHog never carries a raw conversation id. Not a
// security primitive — collision-resistance is irrelevant for a per-thread counter.
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const DAY_MS = 86_400_000;
// P8 Stage 1 (chatArchiveV2): batch message appends into R2 cold-archive jsonl.
// R2 PUT ops are the cost driver, not bytes — so we flush on whichever comes first:
const ARCHIVE_FLUSH_COUNT = 100;      // …every 100 newly-appended messages, or…
const ARCHIVE_FLUSH_MS = 5 * 60_000;  // …every 5 minutes (the alarm cadence when on).
// [AVAGRP-SEENBY-1] Retention for msg_receipts (bounded storage requirement). This
// is ancillary "who saw it" metadata, not the message itself — 30 days comfortably
// outlives WhatsApp-style relevance (nobody checks "seen by" on a month-old group
// post) and bounds the per-message × per-member row growth independent of whether
// INBOX_RETENTION_DAYS (the message-body retention knob) is even enabled. Pruned
// on the SAME daily alarm as message retention/archive (see constructor + alarm()).
const MSG_RECEIPT_RETENTION_MS = 30 * DAY_MS;
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
       -- STREAM B (stranger safety gate): the OWNER's thread-level acceptance
       -- state for a conversation. 'accepted' (default — never locks anyone out)
       -- | 'pending' (a new thread from a NON-CONTACT — the recipient sees the
       -- Accept/Block/Report gate and their read-receipts are withheld from the
       -- sender until they Accept) | 'blocked'. This is the OWNER's own state, so
       -- it lives in their InboxDO. The initial 'pending' is set by the client
       -- (which knows the local contact list); the server ENFORCES the suppression
       -- via shouldSuppressReceipt(conv). See worker/src/routes/safety.ts.
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
       CREATE INDEX IF NOT EXISTS idx_call_ts ON call_log(ts);
       -- [G2] GUARDIAN SAFETY FLAGS (store-and-forward). The recipient's own
       -- red-bubble state for a flagged message: one row per flagged msg_id (the
       -- flagged message's client_id). dismissed=1 records the owner's "This is
       -- fine" so it survives reinstall AND reaches their other devices. Owner
       -- state → lives in THIS user's InboxDO. Seeded on /sync (like hidden/reads/
       -- calls), broadcast live on write (store-and-forward replaces the old
       -- broadcast-only /event push). The SENDER's InboxDO is never written.
       CREATE TABLE IF NOT EXISTS safety_flags (
         msg_id     TEXT PRIMARY KEY,
         conv       TEXT,
         category   TEXT,
         severity   INTEGER,
         dismissed  INTEGER NOT NULL DEFAULT 0,
         ts         INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX IF NOT EXISTS idx_safety_flags_ts ON safety_flags(ts);
       -- [MSG-DELETE-1] Per-account THREAD CLEAR cursor (Issue 3, self-scoped clear).
       -- One row per conversation, owned by THIS user's InboxDO — a "clear/delete
       -- thread for me" is an append-only, self-only op that NEVER touches the peer.
       -- The cursor is ANCHORED ON THE GLOBAL CANONICAL MESSAGE ID (canonicalMsgId /
       -- mid: "<13-digit-ms>.<8hex>", chronologically sortable as a STRING), NOT the
       -- local autoincrement id (which diverges across devices and resurrects history
       -- on re-sync — the #1 risk called out in the plan §7). Materialization hides
       -- messages at/below cleared_through_mid for this account only; a newer message
       -- (mid > cursor) reappears normally. Monotonic-max: the server enforces
       -- cleared_through_mid = MAX(existing, incoming) on every write so a stale
       -- offline device can never move the cursor backward.
       CREATE TABLE IF NOT EXISTS thread_clears (
         conv                 TEXT PRIMARY KEY,
         cleared_through_mid  TEXT NOT NULL,
         cleared_through_seq  INTEGER NOT NULL DEFAULT 0,
         op_id                TEXT,
         updated_at           INTEGER NOT NULL DEFAULT 0
       );
       -- [AVAGRP-SEENBY-1] Per-MESSAGE receipts, living in the ORIGINAL SENDER's
       -- own InboxDO (never a peer's, never a central store) — the same "owner
       -- state lives in the owner's DO" idiom as read_state/call_log/safety_flags.
       -- This is deliberately a SEPARATE table from 'receipts' above: 'receipts'
       -- is a per-(conv,peer) HIGH-WATER pair that 1:1 ticks depend on unchanged;
       -- a group message can be authored by ANY member, so the reader must be able
       -- to name a msg_id (the canonical, cross-device 'mid' on messages.mid — NOT
       -- the local autoincrement id, which differs per-DO) without touching that
       -- 1:1 table at all. msg_id is TEXT (a mid, e.g. "<13-digit-ms>.<8hex>").
       -- NB: no backticks in this comment — it lives inside a template literal,
       -- and a stray backtick silently terminates the SQL string (cost us a
       -- failed prod deploy on 2026-07-17).
       -- WRITE AMPLIFICATION: one row per (message, reader) that has actually
       -- crossed it — NOT one row per member per historical message on every
       -- catch-up (see msgReceipt() below, which upserts only the mids the
       -- client explicitly reports as newly seen, capped per call). Bounded
       -- further by msgReceiptRetentionCutoff() pruning (see prune()).
       CREATE TABLE IF NOT EXISTS msg_receipts (
         conv       TEXT NOT NULL,
         msg_id     TEXT NOT NULL,
         peer       TEXT NOT NULL,
         status     TEXT NOT NULL DEFAULT 'delivered',
         ts         INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (conv, msg_id, peer)
       );
       CREATE INDEX IF NOT EXISTS idx_msg_receipts_conv_msg ON msg_receipts(conv, msg_id);`,
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
    // STREAM B (stranger safety gate): additive accept_state on conv_meta. Existing
    // rows default to 'accepted' via COLUMN DEFAULT, so this migration can NEVER
    // lock an existing conversation into the gate. A brand-new pending thread is
    // stamped 'pending' explicitly by setAcceptState (client-initiated on a new
    // non-contact thread). SQLite has no "ADD COLUMN IF NOT EXISTS" — try + swallow.
    try { this.sql.exec(`ALTER TABLE conv_meta ADD COLUMN accept_state TEXT NOT NULL DEFAULT 'accepted'`); } catch { /* already present */ }
    // [SRV-MSG-IDEMP-1] Transactional idempotency. The client mints a per-message
    // client_id ([MSG-OUTBOX-1]); a durable PARTIAL UNIQUE index on (conv, client_id)
    // makes a re-sent message (network retry, app-kill mid-send, dual-device echo) a
    // guaranteed no-op instead of a duplicate row. The index survives DO eviction/
    // restart/migration for free — an in-memory LRU of processed ids survives none of
    // them, which is why it's explicitly rejected here. The WHERE guard keeps legacy
    // rows with a NULL client_id (pre-outbox clients) OUT of the uniqueness set, so
    // they behave exactly as before. Runs for EXISTING DOs too (idempotent DDL).
    try { this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_client ON messages(conv, client_id) WHERE client_id IS NOT NULL`); } catch { /* already present */ }
    // [SRV-MSG-IDEMP-1] Multi-device readiness: which device originated the send.
    // Nullable, no backfill; SQLite has no "ADD COLUMN IF NOT EXISTS" so we try +
    // swallow the duplicate-column error on already-migrated DOs.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN device_id TEXT`); } catch { /* already present */ }
    // [SYNC-OPS-1] Phase 0 (State Sync Engine build plan): per-conversation MONOTONIC
    // sequence — the sync-engine "operation position" that will replace the global
    // id-cursor in Phase 1. Additive + nullable, and NO reader depends on it yet
    // (syncPayload still pages by global id), so stamping it is a pure dual-write with
    // ZERO behaviour change. conv_meta.seq is the per-conversation counter (the InboxDO
    // is single-threaded, so seq=seq+1 is race-free and strictly monotonic per conv);
    // messages.conv_seq is the stamped value. Reversible via the SYNC_OPS_V2 wrangler
    // var (no KV read on the hot path). SQLite has no "ADD COLUMN IF NOT EXISTS" — try+swallow.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN conv_seq INTEGER`); } catch { /* already present */ }
    try { this.sql.exec(`ALTER TABLE conv_meta ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`); } catch { /* already present */ }
    // [MSG-DELETE-1] Persist the GLOBAL canonical message id (mid) on the row so the
    // per-account thread-clear cursor can hide/keep messages by a device-stable,
    // chronologically-sortable key (not the local autoincrement id). Legacy rows get
    // NULL and are treated as "always visible" (never hidden by a clear) — safe, and
    // they age out via the archive/retention lanes. New rows carry it from the router.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN mid TEXT`); } catch { /* already present */ }
    try { this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_conv_mid ON messages(conv, mid)`); } catch { /* already present */ }
    // [MSG-DELETE-1] Author-only unsend keeps the row (replies/reactions/counts
    // survive) but records WHY it is hidden. reason='author_retract' on a peer copy.
    try { this.sql.exec(`ALTER TABLE messages ADD COLUMN retract_reason TEXT`); } catch { /* already present */ }
    // [MSG-DELETE-1] Cache the highest visible conv_seq per conversation so the chat
    // list render is O(1) (no O(messages) scan) even for a cleared thread. Maintained
    // on append + thread_clear; NULL/0 means "compute lazily".
    try { this.sql.exec(`ALTER TABLE conv_meta ADD COLUMN visible_last_seq INTEGER NOT NULL DEFAULT 0`); } catch { /* already present */ }
    // P8 Stage 1: tiny durable KV for the archive owner uid + high-water (last
    // archived message id). Kept in DO-SQLite so it survives hibernation cheaply.
    try { this.sql.exec(`CREATE TABLE IF NOT EXISTS meta_kv (k TEXT PRIMARY KEY, v TEXT)`); } catch { /* present */ }
    // Retention: turn the per-user inbox into a RELAY + offline buffer instead of a
    // permanent archive (the device keeps history locally + in Drive/R2 backup).
    // Controlled by INBOX_RETENTION_DAYS — UNSET/0 = disabled (keep forever, current
    // behavior). When enabled, a daily alarm prunes aged-out messages. We set the
    // alarm once on construction (only if none pending) so enabling the env var and
    // redeploying starts pruning without per-request cost.
    // [AVAGRP-SEENBY-1] The daily alarm now ALSO prunes msg_receipts (bounded
    // storage), so it must fire even when message retention/archive are both off —
    // previously this branch (and therefore the alarm) was skipped entirely on the
    // vast majority of DOs. A once-a-day wake per user is a cheap, fixed cost.
    this.state.blockConcurrencyWhile(async () => {
      if ((await this.state.storage.getAlarm()) == null) {
        // Faster cadence when the batched archive is on (it flushes on the alarm).
        await this.state.storage.setAlarm(Date.now() + (this.archiveOn() ? ARCHIVE_FLUSH_MS : DAY_MS));
      }
    });
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
    // [AVA-RCPT-20, owner rule 2026-07-16] VOICEMAILS ARE DURABLE USER ASSETS,
    // NOT CHAT FRAMES — a caller's recorded message must NEVER age out with
    // conversation retention. If INBOX_RETENTION_DAYS is ever enabled for
    // chats, voicemail/receptionist rows are exempt unconditionally (their R2
    // audio has no lifecycle rule either; the pair outlives any chat-pruning
    // policy). Canonical Architecture v1.0 records this as a frozen rule.
    this.sql.exec(
      `DELETE FROM messages
         WHERE ((stored_at IS NOT NULL AND stored_at < ?1)
            OR (stored_at IS NULL AND created_at > 1000000000000 AND created_at < ?1))
           AND kind NOT IN ('voicemail','receptionist','recept')${hwGuard}`,
      cutoff,
    );
  }

  /** [AVAGRP-SEENBY-1] Delete msg_receipts rows older than the retention window.
   *  Best-effort — a pruning failure must never break the alarm cycle. */
  private pruneMsgReceipts(): void {
    try {
      this.sql.exec(`DELETE FROM msg_receipts WHERE ts < ?1`, Date.now() - MSG_RECEIPT_RETENTION_MS);
    } catch { /* best-effort */ }
  }

  /** Retention/archive alarm — flush the R2 archive (when on) BEFORE pruning so
   *  the high-water covers everything eligible, then prune, then reschedule.
   *  Always reschedules now (see constructor note) so msg_receipts pruning keeps
   *  running even on DOs with message retention/archive both off. */
  async alarm(): Promise<void> {
    if (this.archiveOn()) { try { await this.flushArchive(); } catch { /* best-effort */ } }
    this.prune();
    this.pruneMsgReceipts();
    await this.state.storage.setAlarm(Date.now() + (this.archiveOn() ? ARCHIVE_FLUSH_MS : DAY_MS));
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
        // [SYNC-CURSOR-1] Phase 1 (dark): per-conversation catch-up. Taken ONLY when
        // the client passes ?conv= AND SYNC_CONV_CURSOR_V2 is enabled; otherwise the
        // legacy global id-cursor path runs verbatim (default, fully reversible — no
        // current client sends ?conv=, so this is dark until we flip both).
        const convParam = url.searchParams.get("conv");
        const convCursorOn = (this.env as unknown as Record<string, unknown>).SYNC_CONV_CURSOR_V2 === "1";
        if (convParam && convCursorOn) {
          return new Response(JSON.stringify(this.syncConvPayload(convParam, Number(url.searchParams.get("after") || 0))), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(this.syncPayload(Number(url.searchParams.get("cursor") || 0))), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/receipt")) return this.receipt(await req.json());
      // [AVAGRP-SEENBY-1] Per-message receipts — this IS the original sender's own
      // InboxDO (the router only ever addresses this endpoint at env.INBOX.get(
      // idFromName(<message author>)), never a reader's or a peer's). GET reads back
      // a batch for the "Info → seen by" sheet; POST records a reader's batch of
      // newly-seen mids. See msgReceipt()/msgReceiptsFor() below.
      if (url.pathname.endsWith("/msg_receipt")) {
        if (req.method === "GET") {
          const conv = url.searchParams.get("conv") || "";
          const mids = (url.searchParams.get("mids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
          return new Response(JSON.stringify({ conv, receipts: this.msgReceiptsFor(conv, mids) }),
            { headers: { "content-type": "application/json" } });
        }
        return this.msgReceipt(await req.json());
      }
      // STREAM B: read/write the OWNER's thread-level accept_state.
      if (url.pathname.endsWith("/accept_state")) {
        if (req.method === "POST") return this.setAcceptState(await req.json());
        // GET ?conv=… → {conv, accept_state, suppress}
        const conv = url.searchParams.get("conv") || "";
        const st = this.acceptState(conv);
        return new Response(JSON.stringify({ conv, accept_state: st, suppress: st === "pending" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/hide")) return this.hide(await req.json());
      // [MSG-DELETE-1] Whole-thread clear for THIS account (Issue 3). Self-scoped
      // append-only cursor write — never touches the peer. See threadClear().
      if (url.pathname.endsWith("/thread_clear")) return this.threadClear(await req.json());
      // [ONEBRAIN-B0-CONSUMERS] HARD-delete a SINGLE conversation's rows (used by the
      // AvaBrain deletion job to wipe the 'brain' AvaChat thread). Distinct from
      // /purge (wipes EVERYTHING) and /thread_clear (a soft, per-account cursor
      // tombstone that keeps the rows). Idempotent: an unknown/missing conv is a
      // clean {ok:true, deleted:0}. See convDelete().
      if (url.pathname.endsWith("/conv_delete") && req.method === "POST") return this.convDelete(await req.json());
      // [MSG-DELETE-1] Author-only unsend gate: return the stored author (sender)
      // of a message by its client_id so the router can verify ctx.uid authored it
      // BEFORE fanning out a delete-for-everyone. Reads the owner's OWN copy.
      if (url.pathname.endsWith("/msg_author")) {
        const conv = url.searchParams.get("conv") || "";
        const target = url.searchParams.get("target") || "";
        return new Response(JSON.stringify({ author: this.msgAuthor(conv, target) }), {
          headers: { "content-type": "application/json" },
        });
      }
      // [G2] Guardian safety flag: upsert the owner's red-bubble/dismiss state,
      // then broadcast it live (store-and-forward). Replaces the old broadcast-only
      // /event push for this frame type so red bubbles survive reinstall + reach
      // every device.
      if (url.pathname.endsWith("/safety_flag")) return this.safetyFlag(await req.json());
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
      // STREAM G (AI in chats): text-only messages for ONE conversation, since a
      // given InboxDO row id (unread window). Media rows are SKIPPED per D6 (only
      // kind text/ava with a non-empty body). Oldest-first so a summary reads in
      // order. Used by /api/ai/catchup and /api/safety/score (server-readable arch).
      if (url.pathname.endsWith("/convtext")) {
        const conv = url.searchParams.get("conv") || "";
        const since = Math.max(0, Number(url.searchParams.get("since") || 0));
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
        if (!conv) return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
        const rows = this.sql.exec(
          `SELECT id, conv, sender, kind, body, created_at FROM messages
           WHERE conv = ? AND id > ? AND (kind = 'text' OR kind = 'ava')
             AND body IS NOT NULL AND body != '' AND (hidden IS NULL OR hidden = 0)
           ORDER BY id ASC LIMIT ?`,
          conv, since, limit,
        ).toArray();
        return new Response(JSON.stringify({ messages: rows }), { headers: { "content-type": "application/json" } });
      }
      // GDPR deletion cascade (Phase 9 A1): wipe ALL DO storage for this user.
      // Peers keep their own copies in their own InboxDOs (their side of the
      // conversation survives, as the spec requires).
      // [LASTSEEN-SERVER-1] WhatsApp-style presence truth: online = a live
      // hibernatable socket exists RIGHT NOW; last_seen = the last connect/
      // disconnect stamp. Read-only, no SQLite touch — cheap even when idle.
      if (url.pathname.endsWith("/last-seen") && req.method === "GET") {
        const online = this.state.getWebSockets().length > 0;
        const lastActiveAt = (await this.state.storage.get<number>("last_active_at")) ?? null;
        return new Response(JSON.stringify({ ok: true, online, last_active_at: lastActiveAt }),
          { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/purge") && req.method === "POST") {
        // Row deletes keep the schema valid for any in-flight access; the DO
        // then idles back to (near-)nothing.
        this.sql.exec("DELETE FROM messages");
        this.sql.exec("DELETE FROM receipts");
        this.sql.exec("DELETE FROM conv_meta");
        this.sql.exec("DELETE FROM read_state");
        try { this.sql.exec("DELETE FROM call_log"); } catch { /* table may predate this migration */ }
        try { this.sql.exec("DELETE FROM safety_flags"); } catch { /* table may predate this migration */ }
        try { this.sql.exec("DELETE FROM thread_clears"); } catch { /* table may predate this migration */ }
        try { this.sql.exec("DELETE FROM msg_receipts"); } catch { /* table may predate this migration */ }
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
    // [LASTSEEN-SERVER-1] WhatsApp-style last seen: the DO is the one place that
    // truthfully knows when this user's device was last connected. Stamp on
    // connect; webSocketClose stamps on disconnect (hibernation wakes for both).
    void this.state.storage.put("last_active_at", Date.now());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // [SRV-MSG-IDEMP-1] Fire-and-forget PostHog signal that the durable index caught a
  // duplicate append. The conv is HASHED (never the raw id) so the black-box recorder
  // can slice dedup rate per-thread without leaking conversation identity. Best-effort:
  // this NEVER runs on the critical path — a telemetry failure can't affect the response.
  private reportDuplicateBlocked(owner: string, conv: string, clientId: string): void {
    try {
      void this.env.Q_ANALYTICS.send({
        event: "invariant_protected", uid: owner, ts: Date.now(),
        props: {
          kind: "duplicate_message_blocked",
          conv_hash: fnv1aHex(conv), client_id: clientId,
          app_name: "avatok", service_name: "avatok-api", worker: true, account_id: owner,
        },
      });
    } catch { /* best-effort — telemetry never blocks or breaks dedup */ }
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
    device_id?: string; scope?: MessageScope; mid?: string;
  }): Response {
    // [TEST-FAILURE-INJECT-1] no-op unless FAULT_INJECT=inbox_append is set.
    if (shouldFail(this.env, "inbox_append")) throw new Error("fault_inject:inbox_append");
    const created = b.created_at || Date.now();
    const audience = scopeAudience(b.scope); // null = thread-scoped (default)
    // [MSG-DELETE-1] Global canonical id used by the thread-clear cursor. Absent for
    // legacy/callers that don't stamp it → stored NULL (always visible).
    const mid = b.mid != null ? String(b.mid) : null;

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
          // [MSG-DELETE-1] Author-only unsend NEVER physically deletes the row —
          // replies/quotes/reactions/counts must survive (plan §7 item 4). We keep
          // the row, mark it hidden as a tombstone, and record WHY (author_retract).
          // The author-verification gate itself lives in the router (sendMsg) before
          // this fan-out ever runs, so an unauthored retract never reaches here.
          this.sql.exec(
            `UPDATE messages SET kind='deleted', body='{"t":"deleted"}', media_ref=NULL, retract_reason='author_retract', edited_at=? WHERE conv=? AND client_id=?`,
            Date.now(), b.conv, target,
          );
          live = this.broadcast(JSON.stringify({ type: "del", conv: b.conv, target }));
          try { void this.env.Q_ANALYTICS.send({ event: "message_tombstoned", uid: b.owner, ts: Date.now(),
            props: { conv: b.conv, target, delete_id: target, by: b.sender, reason: "author_retract", app_name: "avatok", service_name: "avatok-api", worker: true, account_id: b.owner } }); } catch { /* best-effort */ }
        }
        return new Response(JSON.stringify({ id: 0, live }), { headers: { "content-type": "application/json" } });
      }
    }

    // [SRV-MSG-IDEMP-1] Idempotent insert. When the client supplies a client_id we
    // insert against the partial UNIQUE index (conv, client_id): a re-sent message
    // hits ON CONFLICT DO NOTHING, so RETURNING yields NO row. That is the ONLY
    // signal we trust for "already processed" — we then look up the original row id
    // and short-circuit, firing NONE of the first-time side effects below (no
    // unread bump, no broadcast, no archive feed). This makes send exactly-once
    // end-to-end without a client-visible error. Rows with a NULL client_id are
    // outside the index, so legacy clients keep the plain-INSERT behaviour verbatim.
    let row: { id: number | string };
    if (b.client_id) {
      const inserted = this.sql.exec(
        `INSERT INTO messages (conv, sender, kind, body, media_ref, client_id, created_at, audience, stored_at, device_id, mid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conv, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
        b.conv, b.sender, b.kind || "text", b.body ?? null, b.media_ref ?? null, b.client_id, created, audience, Date.now(), b.device_id ?? null, mid,
      ).toArray();
      if (inserted.length === 0) {
        // Duplicate: find the winning row and return it as an ALREADY-PROCESSED
        // success. Skip the unread bump, broadcast, and archive — they all ran (or
        // are running) for the first copy. This is an INVARIANT protection, telemetered.
        const existing = this.sql.exec(
          `SELECT id FROM messages WHERE conv=? AND client_id=? LIMIT 1`, b.conv, b.client_id,
        ).toArray();
        const dupId = existing.length ? Number(existing[0].id) : 0;
        this.reportDuplicateBlocked(b.owner, b.conv, b.client_id);
        return new Response(
          JSON.stringify({ id: dupId, live: false, already_processed: true }),
          { headers: { "content-type": "application/json" } },
        );
      }
      row = inserted[0] as { id: number | string };
    } else {
      row = this.sql.exec(
        `INSERT INTO messages (conv, sender, kind, body, media_ref, client_id, created_at, audience, stored_at, device_id, mid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        b.conv, b.sender, b.kind || "text", b.body ?? null, b.media_ref ?? null, null, created, audience, Date.now(), b.device_id ?? null, mid,
      ).one() as { id: number | string };
    }
    const id = Number(row.id);
    const incoming = b.sender !== b.owner;
    // [SYNC-OPS-1] Phase 0: bump the per-conversation sequence in the SAME upsert that
    // maintains conv_meta, and RETURN it. The counter always advances (monotonic even
    // if stamping is later toggled); only writing conv_seq onto the row + the telemetry
    // are gated by SYNC_OPS_V2 (default ON; set the wrangler var to '0' to disable —
    // a cheap env read, never a KV fetch). Nothing READS conv_seq until Phase 1, so
    // this remains a zero-behaviour-change dual-write.
    const stampSeq = (this.env as unknown as Record<string, unknown>).SYNC_OPS_V2 !== "0";
    const meta = this.sql.exec(
      `INSERT INTO conv_meta (conv, last_id, unread, peer, updated_at, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT(conv) DO UPDATE SET last_id=?2, unread=unread+?3, updated_at=?5, seq=seq+1
       RETURNING seq`,
      b.conv, id, incoming ? 1 : 0, b.sender, created,
    ).one() as { seq: number | string };
    const convSeq = Number(meta.seq);
    // [MSG-DELETE-1] Keep visible_last_seq O(1) for the chat-list render. A newly
    // appended message that sits ABOVE this conv's clear cursor (or a conv that was
    // never cleared) makes the thread visible again → advance the cached high-water.
    // Anchored on the canonical mid so it stays device-stable; legacy rows (mid=NULL)
    // are always visible, so they advance it too.
    try {
      const clearedMid = this.clearedThroughMid(b.conv);
      if (!clearedMid || mid === null || mid > clearedMid) {
        this.sql.exec(`UPDATE conv_meta SET visible_last_seq=?2 WHERE conv=?1 AND visible_last_seq < ?2`, b.conv, convSeq);
      }
    } catch { /* best-effort; syncPayload recomputes visibility from the cursor anyway */ }
    if (stampSeq) {
      this.sql.exec(`UPDATE messages SET conv_seq=? WHERE id=?`, convSeq, id);
      // op_appended: the sync-engine's core correctness event (State Platform Part XIII).
      // account_id/uid carry the owner so telemetry is retrievable per user in PostHog.
      try {
        void this.env.Q_ANALYTICS.send({ event: "op_appended", uid: b.owner, ts: Date.now(),
          props: { conv: b.conv, conv_seq: convSeq, msg_id: id, incoming, kind: b.kind || "text",
            stream: "conversation", app_name: "avatok", service_name: "avatok-api", worker: true, account_id: b.owner } });
      } catch { /* best-effort telemetry */ }
    }
    const frame = JSON.stringify({
      type: "msg", id, conv: b.conv, sender: b.sender, kind: b.kind || "text",
      // [SYNC-CURSOR-1] Additive: the per-conversation sequence on the LIVE frame too
      // (backlog/sync frames already carry it), so a Phase-1 client can track its
      // per-conv position from live messages. Ignored by older clients.
      conv_seq: convSeq,
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

  // [SYNC-CURSOR-1] Phase 1: per-conversation catch-up by conv_seq (the Phase 0
  // stamp). Returns ONLY the messages for one conversation with conv_seq > after,
  // ordered by the per-conversation sequence, so a device can top up a single thread
  // without the full-backlog re-download the global id-cursor forces. `seq` is the
  // conversation's current high-water so the client knows when it is caught up. Dark
  // until SYNC_CONV_CURSOR_V2=1 AND a client opts in with ?conv=.
  private syncConvPayload(conv: string, after: number): { type: "sync_conv"; conv: string; after: number; messages: unknown[]; seq: number; cleared_through_mid: string | null } {
    const messages = this.sql.exec(
      `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at, audience, hidden, conv_seq, mid
       FROM messages WHERE conv = ? AND conv_seq IS NOT NULL AND conv_seq > ? ORDER BY conv_seq ASC LIMIT ?`,
      conv, after, SYNC_LIMIT,
    ).toArray();
    const seqRow = this.sql.exec(`SELECT seq FROM conv_meta WHERE conv = ? LIMIT 1`, conv).toArray();
    const seq = seqRow.length ? Number(seqRow[0].seq) : 0;
    // [MSG-DELETE-1] Carry this conv's clear cursor so a single-thread catch-up
    // applies the same self-scoped hide as the global snapshot.
    return { type: "sync_conv", conv, after, messages, seq, cleared_through_mid: this.clearedThroughMid(conv) };
  }

  // [SYNC-CURSOR-3] Phase 1 switch-over: the HYBRID live-sync payload. It is the plain
  // global sweep (syncPayload) PLUS, for each conversation the client reports a position
  // for, any messages it is missing IN THAT THREAD that sit at/below the global cursor
  // (the projection-repair / selective-gap case the global sweep alone can't reach).
  // SAFETY INVARIANT: the result is a strict SUPERSET of syncPayload, so enabling this
  // can never deliver FEWER messages than today — at worst a few de-duped extras. The
  // per-conv backfill is bounded by SYNC_LIMIT so the payload stays capped.
  private syncPayloadHybrid(globalCursor: number, cc: Record<string, number>): ReturnType<InboxDO["syncPayload"]> {
    const base = this.syncPayload(globalCursor);
    const seen = new Set<number>((base.messages as Array<{ id: number }>).map((r) => Number(r.id)));
    const extra: unknown[] = [];
    let budget = SYNC_LIMIT;
    for (const conv of Object.keys(cc)) {
      if (budget <= 0) break;
      const after = Number(cc[conv]) || 0;
      const rows = this.sql.exec(
        `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at, audience, hidden, conv_seq, mid
         FROM messages WHERE conv = ? AND conv_seq IS NOT NULL AND conv_seq > ? AND id <= ? ORDER BY conv_seq ASC LIMIT ?`,
        conv, after, globalCursor, budget,
      ).toArray();
      for (const r of rows) {
        const id = Number((r as { id: number }).id);
        if (!seen.has(id)) { extra.push(r); seen.add(id); budget--; }
      }
    }
    return { ...base, messages: [...base.messages, ...extra] };
  }

  // [MSG-DELETE-1] Per-account thread-clear cursor snapshot for /sync. Small (one row
  // per cleared conv), so a full snapshot every sync is cheap. The client applies it
  // locally — render only messages whose mid > cleared_through_mid[conv] — so a
  // cleared thread stays hidden across devices/reinstalls until a newer message
  // arrives. Additive: older clients ignore this field entirely.
  private threadClearsSnapshot(): unknown[] {
    try {
      return this.sql.exec(
        `SELECT conv, cleared_through_mid, cleared_through_seq FROM thread_clears`,
      ).toArray();
    } catch { return []; }
  }

  private syncPayload(cursor: number): { type: "sync"; messages: unknown[]; receipts: unknown[]; convs: unknown[]; reads: unknown[]; calls: unknown[]; safety_flags: unknown[]; thread_clears: unknown[] } {
    // conv_seq (Phase 0 stamp) and conv_meta.seq are added as ADDITIVE fields so a
    // Phase-1-aware client can learn each conversation's per-stream position from the
    // ordinary snapshot; older clients simply ignore the extra columns. No behaviour
    // change to the legacy global-cursor path. [MSG-DELETE-1] `mid` (canonical global
    // id) is also selected so the client can apply the thread-clear cursor locally.
    const messages = this.sql.exec(
      `SELECT id, conv, sender, kind, body, media_ref, client_id, created_at, edited_at, audience, hidden, conv_seq, mid
       FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      cursor, SYNC_LIMIT,
    ).toArray();
    const receipts = this.sql.exec(`SELECT conv, peer, delivered_id, read_id FROM receipts`).toArray();
    const convs = this.sql.exec(`SELECT conv, last_id, unread, peer, seq FROM conv_meta`).toArray();
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
    // [G2] Guardian safety-flag snapshot (owner's red-bubble state). Seeded on /sync
    // like reads/calls/hidden so red bubbles + "This is fine" dismissals survive a
    // reinstall and reach a fresh/2nd device. Small + capped; the client merges by
    // msg_id (server wins for dismissed). Table may predate this migration → guard.
    let safety_flags: unknown[] = [];
    try {
      safety_flags = this.sql.exec(
        `SELECT msg_id, conv, category, severity, dismissed FROM safety_flags ORDER BY ts DESC LIMIT 500`,
      ).toArray();
    } catch { /* table may predate this migration on an old DO */ }
    return { type: "sync", messages, receipts, convs, reads, calls, safety_flags, thread_clears: this.threadClearsSnapshot() };
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

  // [ONEBRAIN-B0-CONSUMERS] HARD-delete ONE conversation across every DO-local table
  // that keys on the conv id. Unlike threadClear() (a soft, per-account cursor that
  // KEEPS the rows for local re-materialization) this physically removes the rows —
  // the deletion contract the AvaBrain wipe job needs for the 'brain' AvaChat thread
  // (deleteInboxBrainConv in consumers/src/brain.ts posts {conv} and reads `deleted`).
  // Unlike /purge it touches only the named conversation, never the whole inbox.
  // Idempotent: a missing/unknown conv deletes nothing and returns deleted:0.
  // `deleted` = the number of `messages` rows removed (the meaningful "how much chat
  // history did we erase" count the deletion audit records); the ancillary per-conv
  // metadata/receipt/cursor rows are wiped too but not counted. Each table is guarded
  // so an older DO predating a given migration can't 500 the whole delete.
  private convDelete(b: { conv?: string }): Response {
    const conv = String(b.conv ?? "");
    if (!conv) return new Response(JSON.stringify({ ok: true, deleted: 0 }), { headers: { "content-type": "application/json" } });
    let deleted = 0;
    try { deleted = this.sql.exec(`DELETE FROM messages WHERE conv=?1`, conv).rowsWritten; } catch { /* table optional */ }
    // Ancillary per-conversation state (all key on conv). Best-effort per table so a
    // pre-migration DO missing one still deletes the rest.
    try { this.sql.exec(`DELETE FROM receipts WHERE conv=?1`, conv); } catch { /* optional */ }
    try { this.sql.exec(`DELETE FROM conv_meta WHERE conv=?1`, conv); } catch { /* optional */ }
    try { this.sql.exec(`DELETE FROM read_state WHERE conv=?1`, conv); } catch { /* optional */ }
    try { this.sql.exec(`DELETE FROM safety_flags WHERE conv=?1`, conv); } catch { /* table may predate this migration */ }
    try { this.sql.exec(`DELETE FROM thread_clears WHERE conv=?1`, conv); } catch { /* table may predate this migration */ }
    try { this.sql.exec(`DELETE FROM msg_receipts WHERE conv=?1`, conv); } catch { /* table may predate this migration */ }
    return new Response(JSON.stringify({ ok: true, deleted }), { headers: { "content-type": "application/json" } });
  }

  // [MSG-DELETE-1] The author (sender) of a message in THIS user's own copy, by
  // client_id. Used by the router to enforce author-only unsend. Empty string when
  // the message isn't found here (fail-closed at the router → reject the retract).
  private msgAuthor(conv: string, target: string): string {
    if (!conv || !target) return "";
    try {
      const r = this.sql.exec(`SELECT sender FROM messages WHERE conv=? AND client_id=? LIMIT 1`, conv, target).toArray();
      return r.length ? String((r[0] as { sender?: string }).sender ?? "") : "";
    } catch { return ""; }
  }

  // [MSG-DELETE-1] The current clear high-water (canonical mid) for a conversation,
  // or null if this account never cleared it. String-comparable (mid is
  // "<13-digit-ms>.<8hex>", lexicographically == chronologically sortable).
  private clearedThroughMid(conv: string): string | null {
    if (!conv) return null;
    try {
      const r = this.sql.exec(`SELECT cleared_through_mid FROM thread_clears WHERE conv=? LIMIT 1`, conv).toArray();
      if (!r.length) return null;
      const v = String((r[0] as { cleared_through_mid?: string }).cleared_through_mid ?? "");
      return v || null;
    } catch { return null; }
  }

  // [MSG-DELETE-1] SELF-SCOPED whole-thread clear (Issue 3, the frozen design). A
  // "clear/delete thread for me" is an append-only, monotonic-max cursor row in THIS
  // account's InboxDO. It deletes NOTHING and touches NO peer. The cursor is anchored
  // on the GLOBAL canonical mid (not the local autoincrement id), so two devices on
  // the same account converge and old messages never resurrect after a re-sync. The
  // server enforces cleared_through_mid = MAX(existing, incoming): a stale offline
  // device uploading an older cursor can NEVER move it backward.
  //   body: { conv, cursor_mid, cursor_seq?, op_id? }
  //     cursor_mid — hide every message with mid <= cursor_mid for this account.
  //     cursor_seq — the matching conv_seq (materialization high-water; optional).
  private threadClear(b: { conv?: string; cursor_mid?: string; cursor_seq?: number; op_id?: string }): Response {
    const conv = String(b.conv ?? "");
    const incoming = String(b.cursor_mid ?? "");
    const opId = b.op_id != null ? String(b.op_id) : null;
    if (!conv || !incoming) {
      return new Response(JSON.stringify({ ok: false, error: "conv + cursor_mid required" }), { headers: { "content-type": "application/json" } });
    }
    const before = this.clearedThroughMid(conv);
    // Idempotency / stale-device guard: if we already have this exact op, or the
    // incoming cursor is not newer, DO NOT move the cursor backward. Report it so the
    // stale-client detector (thread_clear_cursor_clamped) fires in the router.
    let clamped = false;
    if (before !== null && incoming <= before) {
      clamped = true;
    }
    const effective = clamped ? (before as string) : incoming;
    // Derive the effective conv_seq for the clamped/non-clamped case. When we accept
    // the incoming cursor use its seq (falls back to the max message conv_seq at/below
    // the mid); on a clamp keep whatever we had.
    let effectiveSeq = Math.max(0, Math.floor(Number(b.cursor_seq) || 0));
    if (!clamped) {
      if (effectiveSeq <= 0) {
        try {
          const r = this.sql.exec(
            `SELECT MAX(conv_seq) AS s FROM messages WHERE conv=? AND mid IS NOT NULL AND mid <= ?`, conv, effective,
          ).toArray();
          effectiveSeq = r.length ? Number((r[0] as { s?: number }).s ?? 0) || 0 : 0;
        } catch { /* best-effort */ }
      }
      this.sql.exec(
        `INSERT INTO thread_clears (conv, cleared_through_mid, cleared_through_seq, op_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(conv) DO UPDATE SET
           cleared_through_mid=MAX(cleared_through_mid, ?2),
           cleared_through_seq=MAX(cleared_through_seq, ?3),
           op_id=?4, updated_at=?5`,
        conv, effective, effectiveSeq, opId, Date.now(),
      );
      // The thread is now hidden up to the cursor → recompute its visible high-water
      // (O(1): the current conv seq if a newer message exists, else 0). This keeps the
      // chat-list render O(1) without an O(messages) scan on read.
      try {
        const vr = this.sql.exec(
          `SELECT COALESCE(MAX(conv_seq),0) AS s FROM messages WHERE conv=? AND (mid IS NULL OR mid > ?)`, conv, effective,
        ).toArray();
        const vis = vr.length ? Number((vr[0] as { s?: number }).s ?? 0) || 0 : 0;
        this.sql.exec(`UPDATE conv_meta SET visible_last_seq=?2 WHERE conv=?1`, conv, vis);
      } catch { /* best-effort */ }
    }
    // Broadcast to the owner's OTHER open sockets so a second device (Mac/PC) hides
    // the thread live too — same multi-device pattern as read/hide. SELF only.
    const live = this.broadcast(JSON.stringify({ type: "thread_clear", conv, cursor_mid: effective, cursor_seq: effectiveSeq }));
    return new Response(JSON.stringify({
      ok: true, conv, cursor_before: before ?? "", cursor_after: effective,
      cursor_seq: effectiveSeq, clamped, live,
    }), { headers: { "content-type": "application/json" } });
  }

  // [G2] Guardian safety flag — store-and-forward. Upserts the OWNER's red-bubble
  // state for a flagged message (keyed by the flagged message's client_id), then
  // broadcasts a live frame so an open thread paints/clears the bubble now AND a
  // second device reflects it. A dismissed:true write records "This is fine" (it
  // wins over an existing red flag and survives reinstall via /sync seeding). A
  // fresh flag write must not clobber a prior dismissal — MAX(dismissed) keeps the
  // owner's choice sticky (mirrors the client's put() preserve-dismiss rule).
  private safetyFlag(b: { msg_id?: string; conv?: string; category?: string; severity?: number; dismissed?: boolean | number }): Response {
    const msgId = String(b.msg_id ?? "").trim();
    const conv = String(b.conv ?? "");
    if (!msgId) return new Response(JSON.stringify({ ok: false, error: "msg_id required" }), { headers: { "content-type": "application/json" } });
    const dismissed = (b.dismissed === true || b.dismissed === 1) ? 1 : 0;
    const category = b.category != null ? String(b.category) : null;
    const severity = b.severity != null ? Math.floor(Number(b.severity)) || 0 : null;
    // Upsert: keep the first non-null conv/category/severity if a later frame omits
    // them (a dismiss-only write carries just msg_id+dismissed). dismissed is sticky
    // via MAX so a re-pushed flag never un-dismisses the owner's choice.
    this.sql.exec(
      `INSERT INTO safety_flags (msg_id, conv, category, severity, dismissed, ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(msg_id) DO UPDATE SET
         conv=COALESCE(NULLIF(?2,''), conv),
         category=COALESCE(?3, category),
         severity=COALESCE(?4, severity),
         dismissed=MAX(dismissed, ?5),
         ts=?6`,
      msgId, conv, category, severity, dismissed, Date.now(),
    );
    const live = this.broadcast(JSON.stringify({
      type: "safety_flag", conv, msg_id: msgId, category, dismissed: dismissed === 1,
    }));
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

  // ---- STREAM B: stranger safety gate (thread-level acceptance) --------------
  /** The OWNER's accept_state for a conversation: 'accepted' | 'pending' |
   *  'blocked'. Unknown/absent conversations read as 'accepted' (never gated —
   *  the migration default + this fallback both fail OPEN so nobody is locked out). */
  private acceptState(conv: string): "accepted" | "pending" | "blocked" {
    if (!conv) return "accepted";
    try {
      const r = this.sql.exec(`SELECT accept_state FROM conv_meta WHERE conv=?1`, conv).toArray();
      const s = r.length ? String((r[0] as { accept_state?: string }).accept_state ?? "accepted") : "accepted";
      return (s === "pending" || s === "blocked") ? s : "accepted";
    } catch { return "accepted"; }
  }

  /**
   * STREAM F DEPENDENCY — reusable helper. True when the OWNER has NOT yet
   * accepted this conversation (accept_state === 'pending'), so the read-receipt
   * fan-out to the sender MUST be dropped (the stranger must not learn the
   * recipient has opened/read the pending thread). The auto-responder path
   * (Stream F) reuses this same check before emitting any receipt/typing signal.
   * Fails OPEN (returns false) on any error, matching the fail-open gate policy.
   */
  shouldSuppressReceipt(conv: string): boolean {
    return this.acceptState(conv) === "pending";
  }

  /** Set the OWNER's accept_state for a conversation. Ensures a conv_meta row
   *  exists so a brand-new pending thread (first inbound before any /append quirk)
   *  is still gated. On Accept we do NOT retroactively emit old receipts — the
   *  client simply resumes normal receipt sending from now on. */
  private setAcceptState(b: { conv: string; state?: string; peer?: string }): Response {
    const conv = String(b.conv ?? "");
    const raw = String(b.state ?? "");
    const state = (raw === "pending" || raw === "blocked" || raw === "accepted") ? raw : "accepted";
    if (!conv) return new Response(JSON.stringify({ ok: false, error: "conv required" }), { headers: { "content-type": "application/json" } });
    this.sql.exec(
      `INSERT INTO conv_meta (conv, unread, peer, accept_state, updated_at)
       VALUES (?1, 0, ?2, ?3, ?4)
       ON CONFLICT(conv) DO UPDATE SET accept_state=?3, updated_at=?4`,
      conv, b.peer ?? null, state, Date.now(),
    );
    // Fan out to the owner's OTHER open sockets so a second device reflects the
    // Accept/Block instantly (mirrors the read/hide multi-device pattern).
    const live = this.broadcast(JSON.stringify({ type: "accept_state", conv, accept_state: state }));
    return new Response(JSON.stringify({ ok: true, conv, accept_state: state, live }), { headers: { "content-type": "application/json" } });
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

  // [AVAGRP-SEENBY-1] Batch upsert of per-message receipts, called ONLY on the
  // ORIGINAL AUTHOR's own InboxDO (the router resolves that target — see
  // msgReceiptBatch() in routes/messaging.ts). `status` is 'delivered' | 'read'
  // for the WHOLE batch (one reader, one status per call — matches how the client
  // actually acks: "these N messages just rendered" or "I just opened the thread
  // up to here"). Idempotent + monotonic: 'read' always wins over 'delivered' for
  // the same (conv,msg_id,peer), and ts only advances forward, so an out-of-order
  // retry or a stale duplicate can never downgrade or rewind a receipt.
  private msgReceipt(b: { conv?: string; peer?: string; status?: string; msg_ids?: string[] }): Response {
    const conv = String(b.conv ?? "");
    const peer = String(b.peer ?? "");
    const status = b.status === "read" ? "read" : "delivered";
    const msgIds = Array.isArray(b.msg_ids) ? b.msg_ids.map(String).filter(Boolean).slice(0, 300) : [];
    if (!conv || !peer || !msgIds.length) {
      return new Response(JSON.stringify({ ok: false, error: "conv, peer, msg_ids required" }), { headers: { "content-type": "application/json" } });
    }
    const now = Date.now();
    for (const msgId of msgIds) {
      this.sql.exec(
        `INSERT INTO msg_receipts (conv, msg_id, peer, status, ts) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(conv, msg_id, peer) DO UPDATE SET
           status = CASE WHEN status='read' OR ?4='read' THEN 'read' ELSE ?4 END,
           ts = MAX(ts, ?5)`,
        conv, msgId, peer, status, now,
      );
    }
    // One live frame for the whole batch — an open thread (the sender's own device)
    // applies all N message updates from a single broadcast instead of N frames.
    const live = this.broadcast(JSON.stringify({ type: "msg_receipt", conv, peer, status, msg_ids: msgIds, ts: now }));
    return new Response(JSON.stringify({ ok: true, live }), { headers: { "content-type": "application/json" } });
  }

  // [AVAGRP-SEENBY-1] Batch read-back for the "Info → seen by" sheet (on-demand —
  // NOT part of /sync, to keep the ordinary snapshot payload from growing with
  // every group's message history). Bounded by the caller's mids list (routes
  // cap it to 200) and by this DO's own per-conv,msg index.
  private msgReceiptsFor(conv: string, mids: string[]): unknown[] {
    if (!conv || !mids.length) return [];
    const placeholders = mids.map((_, i) => `?${i + 2}`).join(",");
    try {
      return this.sql.exec(
        `SELECT msg_id, peer, status, ts FROM msg_receipts WHERE conv=?1 AND msg_id IN (${placeholders})`,
        conv, ...mids,
      ).toArray();
    } catch { return []; }
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
      // [SYNC-CURSOR-3] Phase 1 switch-over (dark): when the client reports per-conv
      // positions (`cc`) AND SYNC_CONV_CURSOR_V2 is on, reply with the HYBRID payload
      // — the complete global sweep PLUS a per-conversation backfill. The hybrid is a
      // strict SUPERSET of the plain global sweep, so it can NEVER deliver fewer
      // messages (no message loss, ever); the client de-dupes the extras. Flag off, or
      // no `cc` → identical legacy behaviour.
      const convCursorOn = (this.env as unknown as Record<string, unknown>).SYNC_CONV_CURSOR_V2 === "1";
      // [AVA-SYNC-SKIP] Empty-catch-up short-circuit. A skip-capable client (the only
      // clients that set m.skip; old clients never do) that reconnects/resumes with a
      // persisted cursor ALREADY AT the server head does NOT need a full replay — a
      // socket flap under Android doze fires ~15x/user/day and 97.6% of those returned
      // 0 messages, each waking DO-SQLite + rebuilding a payload for nothing. The check
      // is a single indexed MAX(id) read (no message scan) and is SERVER-AUTHORITATIVE:
      // we only skip when the client's cursor is >= the true head, so a client can never
      // wrongly skip past a message it is missing. Purely additive — the `sync_skip`
      // frame is a new type old clients would ignore, and an old worker that doesn't
      // understand m.skip just falls through to the normal full sync below.
      // NOTE: the client gates m.skip so it is NEVER set on 'login' or 'push' and only
      // when its local state is non-empty (cursor > 0); this path additionally requires
      // head > 0. A skip omits the small cross-device snapshots (reads/calls/safety/
      // thread-clears) that a full sync also carries — those are re-delivered live while
      // connected and reconciled on the next non-at-head sync / login / push, so a
      // message is never lost. `syncSkipEnabled` (config.ts) is the kill switch: the
      // client stops setting m.skip when it is false, so this branch goes dormant.
      if (m.skip === true) {
        try {
          const clientCursor = Number(m.cursor || 0);
          const row = this.sql.exec(`SELECT MAX(id) AS h FROM messages`).one() as { h: number | null };
          const head = Number(row?.h ?? 0);
          if (head > 0 && clientCursor >= head) {
            ws.send(JSON.stringify({ type: "sync_skip", head, cursor: clientCursor }));
            return;
          }
        } catch { /* fall through to a normal full sync on any error */ }
      }
      try {
        if (convCursorOn && m.cc && typeof m.cc === "object") {
          ws.send(JSON.stringify(this.syncPayloadHybrid(Number(m.cursor || 0), m.cc as Record<string, number>)));
        } else {
          ws.send(JSON.stringify(this.syncPayload(Number(m.cursor || 0))));
        }
      } catch { /* */ }
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
    // [LASTSEEN-SERVER-1] The moment of disconnect IS the honest "last seen".
    void this.state.storage.put("last_active_at", Date.now());
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* */ }
  }
  webSocketError(ws: WebSocket): void {
    void this.state.storage.put("last_active_at", Date.now());
    try { ws.close(1011); } catch { /* */ }
  }
}
