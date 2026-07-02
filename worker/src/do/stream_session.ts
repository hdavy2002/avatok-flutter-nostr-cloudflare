// StreamSessionDO — ONE DO per delivered session (Phase 7). Extended from the
// original gift-aggregation DO (§10.1 — that path is kept intact) into the live
// interaction room + session timer:
//
//   • Hibernatable WebSocket room: reactions, flying messages, sticker drops,
//     viewer-count ticks, donation banners, pinned message, host overlays.
//     Ephemeral — never stored in InboxDO; broadcasts coalesce ≥250 ms
//     (perf budget §4). Auth happens in routes/live.ts / consult.ts (signed
//     session token) — the DO trusts the uid/role/order headers the Worker set.
//   • Moderation state (A1): muted_users / banned_users / slow_mode_sec /
//     pinned_message — in DO storage, survives hibernation. Server-enforced.
//   • Attendance: join/leave written to D1 session_attendance — the refund
//     engine's evidence. Rejoin <90 s is merged at evaluation time (A3).
//   • Refund-engine alarms: schedule() arms alarms at starts_at+wait (no-show
//     check) and ends_at+grace — each fires a Q_MONEY evaluate job exactly on
//     time, co-located with attendance state. The minute-cron sweep remains the
//     safety net.
//
// Instance naming: `live:<listingId>` (AvaLive) | `consult:<bookingId>`.
import type { Env } from "../types";
import { json } from "../util";

const FLUSH_MS = 5_000;
const GIFT_COMMISSION = 0.30;          // legacy gifts path (§10.1)
const COALESCE_MS = 250;               // perf budget §4 — broadcast batching
const FLY_RATE_MS = 2_000;             // flying messages: 1 per 2 s per user
const END_GRACE_MS = 2 * 60_000;       // session auto-end grace
const PROFANITY = /\b(fuck|shit|cunt|nigger|faggot|bitch)\b/i; // drop+warn hook (full pipeline = Q_MODERATION)

interface SockMeta { uid: string; role: string; name: string; orderId: string | null }

export class StreamSessionDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;
  private outbox: unknown[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFly = new Map<string, number>(); // per-uid flying-message limiter (in-memory is fine)

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k INTEGER PRIMARY KEY, creator_uid TEXT, pending INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, gifters INTEGER NOT NULL DEFAULT 0)",
    );
    // In-place migration for DOs created before the npub→uid rename (harmless no-op otherwise).
    try { this.sql.exec("ALTER TABLE meta RENAME COLUMN creator_npub TO creator_uid"); } catch { /* already migrated / fresh DO */ }
    this.sql.exec("INSERT OR IGNORE INTO meta (k, creator_uid, pending, total, gifters) VALUES (1, NULL, 0, 0, 0)");
    // Phase 7 session + room state (DO storage — survives hibernation).
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS session (k INTEGER PRIMARY KEY, sid TEXT, kind TEXT, starts_at INTEGER, ends_at INTEGER, host_id TEXT, wait_min INTEGER NOT NULL DEFAULT 20, slow_mode_sec INTEGER NOT NULL DEFAULT 0, pinned TEXT, donations_total INTEGER NOT NULL DEFAULT 0, donations_count INTEGER NOT NULL DEFAULT 0, host_live INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec("INSERT OR IGNORE INTO session (k) VALUES (1)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS modlist (uid TEXT PRIMARY KEY, state TEXT NOT NULL)"); // muted|banned
    this.sql.exec("CREATE TABLE IF NOT EXISTS alarms (t INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (t, kind))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS last_msg (uid TEXT PRIMARY KEY, t INTEGER NOT NULL)");
  }

  // ---------------------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") return this.handleWs(req);

    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    switch (body.op) {
      // ---- legacy gifts path (unchanged) ----
      case "init": {
        this.sql.exec("UPDATE meta SET creator_uid=?1 WHERE k=1", String(body.creator_uid || ""));
        return json({ ok: true });
      }
      case "gift": {
        const amount = Math.trunc(Number(body.amount));
        if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
        this.sql.exec("UPDATE meta SET pending=pending+?1, total=total+?1, gifters=gifters+1 WHERE k=1", amount);
        await this.armAlarm(Date.now() + FLUSH_MS, "gift_flush");
        return json({ ok: true });
      }
      case "flush": { await this.flushGifts(); return json({ ok: true }); }

      // ---- Phase 7 session lifecycle ----
      case "schedule": {
        // {sid, kind, starts_at, ends_at, host_id, wait_min?} — idempotent re-arm.
        this.sql.exec(
          "UPDATE session SET sid=?1, kind=?2, starts_at=?3, ends_at=?4, host_id=?5, wait_min=?6 WHERE k=1",
          String(body.sid), String(body.kind), Number(body.starts_at), Number(body.ends_at), String(body.host_id), Math.trunc(Number(body.wait_min ?? 20)) || 20,
        );
        this.sql.exec("UPDATE meta SET creator_uid=COALESCE(NULLIF(creator_uid,''),?1) WHERE k=1", String(body.host_id));
        const wait = (Math.trunc(Number(body.wait_min ?? 20)) || 20) * 60_000;
        await this.armAlarm(Number(body.starts_at) + wait, "money_noshow");
        await this.armAlarm(Number(body.ends_at) + END_GRACE_MS, "money_end");
        return json({ ok: true });
      }
      case "host-live": { // stream webhook: connected/disconnected (A4 overlay)
        const live = body.live === true;
        this.sql.exec("UPDATE session SET host_live=?1 WHERE k=1", live ? 1 : 0);
        this.queue({ type: live ? "host_connected" : "host_reconnecting" });
        return json({ ok: true });
      }
      case "donation": { // routes/live.ts already moved the money — broadcast + HUD
        const amount = Math.trunc(Number(body.amount));
        this.sql.exec("UPDATE session SET donations_total=donations_total+?1, donations_count=donations_count+1 WHERE k=1", amount);
        this.queue({ type: "donation", name: String(body.name || "Someone"), amount, net: Math.trunc(Number(body.net ?? amount)) });
        return json({ ok: true, ...this.donations() });
      }
      case "mod": {
        // {action: mute|unmute|ban|report_clear, target} | {action: slow, sec} | {action: pin, text}
        const act = String(body.action || "");
        if (act === "mute" || act === "ban") {
          this.sql.exec("INSERT INTO modlist (uid, state) VALUES (?1,?2) ON CONFLICT(uid) DO UPDATE SET state=?2", String(body.target), act === "ban" ? "banned" : "muted");
          if (act === "ban") this.kick(String(body.target));
          this.queue({ type: "mod", action: act, target: String(body.target) });
        } else if (act === "unmute") {
          this.sql.exec("DELETE FROM modlist WHERE uid=?1", String(body.target));
        } else if (act === "slow") {
          this.sql.exec("UPDATE session SET slow_mode_sec=?1 WHERE k=1", Math.max(0, Math.min(60, Math.trunc(Number(body.sec ?? 0)))));
          this.queue({ type: "slow_mode", sec: Math.max(0, Math.min(60, Math.trunc(Number(body.sec ?? 0)))) });
        } else if (act === "pin") {
          const text = String(body.text ?? "").slice(0, 200) || null;
          this.sql.exec("UPDATE session SET pinned=?1 WHERE k=1", text);
          this.queue({ type: "pinned", text });
        } else return json({ error: "unknown mod action" }, 400);
        return json({ ok: true });
      }
      case "is-banned": {
        const r = this.sql.exec("SELECT state FROM modlist WHERE uid=?1", String(body.uid)).toArray() as any[];
        return json({ banned: r.length > 0 && r[0].state === "banned" });
      }
      case "participants": { // capacity check for SFU joins
        return json({ count: this.state.getWebSockets().length, uids: this.roster() });
      }
      case "stats":
      case "state": {
        const m = this.sql.exec("SELECT creator_uid, pending, total, gifters FROM meta WHERE k=1").one() as any;
        const s = this.sess();
        return json({
          creator_uid: m.creator_uid, gifts_total: Number(m.total), gifters: Number(m.gifters),
          sid: s.sid, kind: s.kind, starts_at: s.starts_at, ends_at: s.ends_at, host_id: s.host_id,
          watching: this.state.getWebSockets().length, roster: this.roster(),
          slow_mode_sec: Number(s.slow_mode_sec), pinned: s.pinned, host_live: Number(s.host_live) === 1,
          ...this.donations(),
        });
      }
      default: return json({ error: "unknown op" }, 400);
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket room (hibernatable)
  // ---------------------------------------------------------------------------

  private handleWs(req: Request): Response {
    const u = new URL(req.url);
    const uid = (req.headers.get("x-session-uid") || u.searchParams.get("uid") || "").slice(0, 64);
    const role = (req.headers.get("x-session-role") || "viewer").slice(0, 16);
    const name = (req.headers.get("x-session-name") || "Someone").slice(0, 48);
    const orderId = req.headers.get("x-session-order");
    if (!uid) return new Response("uid required", { status: 400 });
    const banned = this.sql.exec("SELECT state FROM modlist WHERE uid=?1", uid).toArray() as any[];
    if (banned.length && banned[0].state === "banned") return new Response("banned", { status: 403 });

    const pair = new WebSocketPair();
    const meta: SockMeta = { uid, role, name, orderId: orderId || null };
    this.state.acceptWebSocket(pair[1], [JSON.stringify(meta)]);

    // Attendance evidence (refund engine). Host rows carry order_id NULL.
    this.attendance(uid, role === "host" ? "host" : "attendee", meta.orderId, "join");

    // Initial state straight to the new socket (not coalesced).
    const s = this.sess();
    try {
      pair[1].send(JSON.stringify({
        type: "welcome", watching: this.state.getWebSockets().length,
        slow_mode_sec: Number(s.slow_mode_sec), pinned: s.pinned,
        ends_at: s.ends_at, starts_at: s.starts_at, host_live: Number(s.host_live) === 1,
        ...this.donations(),
      }));
    } catch { /* ignore */ }
    this.queue({ type: "viewers", n: this.state.getWebSockets().length });
    if (role === "host" || role === "attendee") this.queue({ type: "presence", uid, name, role, joined: true });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 4096) return;
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    const meta = this.metaOf(ws); if (!meta) return;
    const mod = (this.sql.exec("SELECT state FROM modlist WHERE uid=?1", meta.uid).toArray() as any[])[0]?.state;
    if (mod) return; // muted/banned: nothing broadcasts (banned shouldn't be here at all)

    const t = String(m.type || "");
    if (t === "reaction" && typeof m.emoji === "string") {
      this.queue({ type: "reaction", emoji: String(m.emoji).slice(0, 8), from: meta.name });
      return;
    }
    if (t === "sticker" && typeof m.id === "string") {
      this.queue({ type: "sticker", id: String(m.id).slice(0, 32), from: meta.name });
      return;
    }
    if ((t === "fly" || t === "chat") && typeof m.text === "string") {
      const text = String(m.text).slice(0, 120).trim();
      if (!text) return;
      // Profanity hook: drop + warn (full async scan stays on the report path).
      if (PROFANITY.test(text)) { try { ws.send(JSON.stringify({ type: "warn", reason: "message blocked" })); } catch { /* ignore */ } return; }
      const now = Date.now();
      // Rate limits: flying 1/2s per user; chat honors slow mode (server-side).
      if (t === "fly") {
        if (now - (this.lastFly.get(meta.uid) ?? 0) < FLY_RATE_MS) return;
        this.lastFly.set(meta.uid, now);
      } else {
        const slow = Number(this.sess().slow_mode_sec) * 1000;
        if (slow > 0 && meta.role !== "host") {
          const last = (this.sql.exec("SELECT t FROM last_msg WHERE uid=?1", meta.uid).toArray() as any[])[0]?.t ?? 0;
          if (now - Number(last) < slow) { try { ws.send(JSON.stringify({ type: "warn", reason: `slow mode: 1 message per ${slow / 1000}s` })); } catch { /* ignore */ } return; }
          this.sql.exec("INSERT INTO last_msg (uid, t) VALUES (?1,?2) ON CONFLICT(uid) DO UPDATE SET t=?2", meta.uid, now);
        }
      }
      this.queue({ type: t, text, from: meta.name, uid: meta.uid });
      return;
    }
    if (t === "track" && typeof m.track === "string" && m.track.length < 256) {
      // SFU consult rooms: announce published track ids so peers can pull them.
      this.queue({ type: "track", uid: meta.uid, name: meta.name, track: m.track, session: typeof m.session === "string" ? m.session.slice(0, 128) : null });
      return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { this.dropped(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { this.dropped(ws); }

  private dropped(ws: WebSocket): void {
    const meta = this.metaOf(ws);
    if (meta) {
      this.attendance(meta.uid, meta.role === "host" ? "host" : "attendee", meta.orderId, "leave");
      if (meta.role === "host" || meta.role === "attendee") this.queue({ type: "presence", uid: meta.uid, name: meta.name, role: meta.role, joined: false });
    }
    this.queue({ type: "viewers", n: Math.max(0, this.state.getWebSockets().length - 1) });
  }

  // ---------------------------------------------------------------------------
  // Alarms — multiplexed: gift flush + refund-engine phases.
  // ---------------------------------------------------------------------------

  private async armAlarm(t: number, kind: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO alarms (t, kind) VALUES (?1,?2)", Math.trunc(t), kind);
    const next = this.sql.exec("SELECT MIN(t) AS t FROM alarms").one() as any;
    if (next?.t) await this.state.storage.setAlarm(Number(next.t));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec("SELECT t, kind FROM alarms WHERE t<=?1", now + 1000).toArray() as any[];
    this.sql.exec("DELETE FROM alarms WHERE t<=?1", now + 1000);
    const s = this.sess();
    for (const d of due) {
      try {
        if (d.kind === "gift_flush") await this.flushGifts();
        if ((d.kind === "money_noshow" || d.kind === "money_end") && s.sid) {
          await this.env.Q_MONEY.send({ type: "evaluate", sid: String(s.sid), kind: String(s.kind), phase: d.kind === "money_noshow" ? "noshow" : "end" });
          if (d.kind === "money_end") this.queue({ type: "session_ended" });
        }
      } catch (e) { console.error("StreamSessionDO alarm:", String(e)); /* sweep is the safety net */ }
    }
    const next = this.sql.exec("SELECT MIN(t) AS t FROM alarms").one() as any;
    if (next?.t) await this.state.storage.setAlarm(Number(next.t));
  }

  private async flushGifts(): Promise<void> {
    const m = this.sql.exec("SELECT creator_uid, pending FROM meta WHERE k=1").one() as any;
    const pending = Number(m.pending);
    const creator = m.creator_uid as string | null;
    if (!creator || pending <= 0) return;
    const commission = Math.round(pending * GIFT_COMMISSION);
    const net = pending - commission;
    const stub = this.env.WALLET_DO.get(this.env.WALLET_DO.idFromName(creator));
    await stub.fetch("https://wallet/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "earn", uid: creator, amount: net, commission, app_name: "avalive", ref: "stream-gifts" }),
    });
    this.sql.exec("UPDATE meta SET pending=0 WHERE k=1");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private sess(): any { return this.sql.exec("SELECT * FROM session WHERE k=1").one(); }
  private donations(): { donations_total: number; donations_count: number } {
    const s = this.sess();
    return { donations_total: Number(s.donations_total), donations_count: Number(s.donations_count) };
  }

  private metaOf(ws: WebSocket): SockMeta | null {
    try { return JSON.parse(this.state.getTags(ws)[0] ?? "") as SockMeta; } catch { return null; }
  }

  private roster(): Array<{ uid: string; role: string; name: string }> {
    const out: Array<{ uid: string; role: string; name: string }> = [];
    for (const ws of this.state.getWebSockets()) {
      const m = this.metaOf(ws);
      if (m) out.push({ uid: m.uid, role: m.role, name: m.name });
    }
    return out;
  }

  private kick(uid: string): void {
    for (const ws of this.state.getWebSockets()) {
      const m = this.metaOf(ws);
      if (m?.uid === uid) { try { ws.close(1008, "banned"); } catch { /* ignore */ } }
    }
  }

  /** Coalesced broadcast — one frame per ≥250 ms window (perf budget §4). */
  private queue(evt: unknown): void {
    this.outbox.push(evt);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.outbox.length) return;
      const frame = JSON.stringify({ type: "batch", events: this.outbox.splice(0, this.outbox.length) });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(frame); } catch { /* runtime reaps dead sockets */ }
      }
    }, COALESCE_MS);
  }

  /** D1 attendance evidence — best-effort (engine treats absence conservatively). */
  private attendance(uid: string, role: "host" | "attendee", orderId: string | null, evt: "join" | "leave"): void {
    const s = this.sess();
    if (!s.sid) return;
    const now = Date.now();
    const run = async () => {
      try {
        if (evt === "join") {
          await this.env.DB_META.prepare(
            "INSERT INTO session_attendance (session_id, order_id, user_id, role, joined_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
          ).bind(String(s.sid), orderId, uid, role, now).run();
        } else {
          await this.env.DB_META.prepare(
            "UPDATE session_attendance SET left_at=?3 WHERE session_id=?1 AND user_id=?2 AND left_at IS NULL",
          ).bind(String(s.sid), uid, now).run();
        }
      } catch (e) { console.warn("attendance write:", String(e)); }
    };
    this.state.waitUntil(run());
  }
}
