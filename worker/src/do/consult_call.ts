// [AUMFE-CONSULT-W3-1 2026-10-02] ConsultCallDO — one per booking (idFromName(bookingId)). Signalling relay + presence clock for
// plain-WebRTC 1:1 audio (Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md §W3). Hibernatable: all state is in DO storage and
// socket attachments, nothing important lives only in memory.
//   * admits the booking's customer and consultant only (headers are set by routes/consultants/ws.ts from a single-use ticket,
//     and re-checked here against D1); one socket per role, a reconnect replaces the old one.
//   * the consultant is the offerer; offer/answer/ice/reveal are relayed, never inspected.
//   * presence intervals are kept in storage; overlap time (both present) is written to D1 customer_seconds/consultant_seconds.
//   * the call ends on consultant `end` or at slot_end + GRACE_AFTER (alarm; cron can also poke /finalize), then settleBooking runs.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { track, trackException } from "../hooks";
import { GRACE_AFTER_MS, JOIN_EARLY_MS } from "../lib/consultants/slots";
import { overlapSeconds, settleBooking, type Interval } from "../lib/consultants/settle";
import type { CallClientMsg, CallServerMsg } from "../lib/consultants/types";

const APP = "aumfe_consult";
const HDR_UID = "x-consult-uid", HDR_ROLE = "x-consult-role", HDR_BOOKING = "x-consult-booking";
const MAX_FRAME = 64 * 1024;

type Role = "customer" | "consultant";
type EndReason = "ended_by_consultant" | "slot_over" | "admin";
type Presence = Record<Role, Interval[]>;
interface Meta { id: string; customer_uid: string; consultant_uid: string; slot_start_ms: number; slot_end_ms: number }
interface Att { role: Role; sid: string }

const other = (r: Role): Role => (r === "customer" ? "consultant" : "customer");

export class ConsultCallDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  // ------------------------------------------------------------ storage helpers
  private async meta(bookingId?: string): Promise<Meta | null> {
    const cached = await this.state.storage.get<Meta>("meta");
    if (cached) return cached;
    if (!bookingId) return null;
    const r = await metaDb(this.env).prepare(
      `SELECT b.id, b.uid AS customer_uid, c.uid AS consultant_uid, b.slot_start_ms, b.slot_end_ms, b.status
         FROM consult_bookings b JOIN consultants c ON c.id = b.consultant_id WHERE b.id = ?1`,
    ).bind(bookingId).first<Meta & { status: string }>();
    if (!r || !r.consultant_uid || (r.status !== "confirmed" && r.status !== "in_call")) return null;
    const m: Meta = { id: r.id, customer_uid: r.customer_uid, consultant_uid: r.consultant_uid, slot_start_ms: r.slot_start_ms, slot_end_ms: r.slot_end_ms };
    await this.state.storage.put("meta", m);
    return m;
  }
  private async pres(): Promise<Presence> { return (await this.state.storage.get<Presence>("pres")) ?? { customer: [], consultant: [] }; }
  private async cur(): Promise<Partial<Record<Role, string>>> { return (await this.state.storage.get<Partial<Record<Role, string>>>("cur")) ?? {}; }
  private isPresent(p: Presence, role: Role): boolean { const l = p[role][p[role].length - 1]; return !!l && l.e === null; }
  private closeOpen(list: Interval[], at: number): void { const l = list[list.length - 1]; if (l && l.e === null) l.e = Math.max(l.s, at); }

  private async send(role: Role, msg: CallServerMsg): Promise<void> {
    const cur = (await this.cur())[role];
    if (!cur) return;
    for (const ws of this.state.getWebSockets(role)) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a?.sid === cur) { try { ws.send(JSON.stringify(msg)); } catch { /* socket gone; close handler cleans up */ } }
    }
  }
  private async stateMsg(role: Role, meta: Meta, p: Presence): Promise<CallServerMsg> {
    const started = (await this.state.storage.get<number>("started_at")) ?? null;
    const otherPresent = this.isPresent(p, other(role));
    return { t: "state", me: role, other_present: otherPresent, started_at: started, slot_end_ms: meta.slot_end_ms, you_offer: role === "consultant" && otherPresent };
  }
  private async broadcastState(meta: Meta, p: Presence): Promise<void> {
    for (const r of ["customer", "consultant"] as Role[]) if (this.isPresent(p, r)) await this.send(r, await this.stateMsg(r, meta, p));
  }
  private async writeSeconds(meta: Meta, p: Presence, now: number): Promise<number> {
    const sec = overlapSeconds(p.customer, p.consultant, now);
    try {
      await metaDb(this.env).prepare("UPDATE consult_bookings SET customer_seconds=?2, consultant_seconds=?2, updated_at=?3 WHERE id=?1").bind(meta.id, sec, now).run();
    } catch (e) { await trackException(this.env, e, { route: "consult_call.writeSeconds", handled: true, app_name: APP }); }
    return sec;
  }

  // ------------------------------------------------------------ entry
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/finalize") {
      const id = url.searchParams.get("id") || "";
      if (id) await this.state.storage.put("bid", id);
      await this.endCall("slot_over");
      return new Response("ok");
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket required", { status: 426 });
    const uid = req.headers.get(HDR_UID) || "", role = req.headers.get(HDR_ROLE) as Role | null, bid = req.headers.get(HDR_BOOKING) || "";
    if (!uid || !bid || (role !== "customer" && role !== "consultant")) return new Response("bad session", { status: 400 });
    if (await this.state.storage.get("ended")) return new Response("call ended", { status: 410 });
    let meta: Meta | null;
    try { meta = await this.meta(bid); } catch (e) { await trackException(this.env, e, { uid, route: "consult_call.fetch", handled: true, app_name: APP }); return new Response("unavailable", { status: 503 }); }
    if (!meta || meta.id !== bid) return new Response("not joinable", { status: 409 });
    if ((role === "customer" ? meta.customer_uid : meta.consultant_uid) !== uid) return new Response("forbidden", { status: 403 });
    const now = Date.now();
    if (now < meta.slot_start_ms - JOIN_EARLY_MS) return new Response("too early", { status: 425 });
    if (now > meta.slot_end_ms + GRACE_AFTER_MS) return new Response("session over", { status: 410 });
    await this.state.storage.put("bid", bid);

    for (const old of this.state.getWebSockets(role)) { try { old.close(4000, "replaced"); } catch { /* already closed */ } }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const sid = crypto.randomUUID();
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, sid } satisfies Att);
    const cur = await this.cur(); cur[role] = sid; await this.state.storage.put("cur", cur);

    // presence
    const p = await this.pres();
    this.closeOpen(p[role], now);
    p[role].push({ s: now, e: null });
    await this.state.storage.put("pres", p);
    const col = role === "consultant" ? "consultant_joined_at" : "customer_joined_at";
    try {
      await metaDb(this.env).prepare(`UPDATE consult_bookings SET ${col} = COALESCE(${col}, ?2), updated_at = ?2 WHERE id = ?1`).bind(meta.id, now).run();
      if (this.isPresent(p, other(role)) && !(await this.state.storage.get("started_at"))) {
        await this.state.storage.put("started_at", now);
        await metaDb(this.env).prepare(
          "UPDATE consult_bookings SET call_started_at = COALESCE(call_started_at, ?2), status = CASE WHEN status='confirmed' THEN 'in_call' ELSE status END, updated_at=?2 WHERE id=?1",
        ).bind(meta.id, now).run();
      }
    } catch (e) { await trackException(this.env, e, { uid, route: "consult_call.join", handled: true, app_name: APP }); }
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(meta.slot_end_ms + GRACE_AFTER_MS);
    await this.writeSeconds(meta, p, now);
    void track(this.env, uid, "consult_call_joined", APP, { role });
    await this.broadcastState(meta, p);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------ sockets
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Att | null;
    if (!att) return;
    const role = att.role;
    if ((await this.cur())[role] !== att.sid) return; // a replaced socket
    if (typeof message !== "string" || message.length > MAX_FRAME) { ws.send(JSON.stringify({ t: "error", error: "bad_frame" } satisfies CallServerMsg)); return; }
    let m: CallClientMsg;
    try { m = JSON.parse(message) as CallClientMsg; } catch { ws.send(JSON.stringify({ t: "error", error: "bad_json" } satisfies CallServerMsg)); return; }
    const meta = await this.meta((await this.state.storage.get<string>("bid")) ?? undefined);
    if (!meta) return;
    const p = await this.pres();
    const err = (error: string) => ws.send(JSON.stringify({ t: "error", error } satisfies CallServerMsg));
    switch (m?.t) {
      case "ping": ws.send(JSON.stringify({ t: "pong" } satisfies CallServerMsg)); return;
      case "hello": ws.send(JSON.stringify(await this.stateMsg(role, meta, p))); return;
      case "offer":
        if (role !== "consultant") return err("only_consultant_offers");
        if (typeof m.sdp !== "string") return err("bad_sdp");
        if (!this.isPresent(p, "customer")) return err("peer_absent");
        await this.send("customer", { t: "offer", sdp: m.sdp }); return;
      case "answer":
        if (role !== "customer") return err("only_customer_answers");
        if (typeof m.sdp !== "string") return err("bad_sdp");
        if (!this.isPresent(p, "consultant")) return err("peer_absent");
        await this.send("consultant", { t: "answer", sdp: m.sdp }); return;
      case "ice":
        if (this.isPresent(p, other(role))) await this.send(other(role), { t: "ice", candidate: m.candidate });
        return;
      case "reveal": {
        if (role !== "consultant") return err("only_consultant_reveals");
        const c = m.card;
        if (!c || !Number.isInteger(c.id) || typeof c.reversed !== "boolean" || typeof c.position !== "string" || c.position.length > 40) return err("bad_card");
        await this.send("customer", { t: "reveal", card: { id: c.id, reversed: c.reversed, position: c.position } }); return;
      }
      case "end":
        if (role !== "consultant") return err("only_consultant_ends");
        // Ending before the customer ever arrived would forfeit the customer's slot; keep the call open for them.
        if (!p.customer.length) return err("customer_not_here_yet");
        await this.endCall("ended_by_consultant"); return;
      default: err("unknown_message");
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.onLeave(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.onLeave(ws); }

  private async onLeave(ws: WebSocket): Promise<void> {
    try { ws.close(1000, "bye"); } catch { /* already closed */ }
    const att = ws.deserializeAttachment() as Att | null;
    if (!att) return;
    const cur = await this.cur();
    if (cur[att.role] !== att.sid) return; // replaced by a newer socket: presence continues
    delete cur[att.role]; await this.state.storage.put("cur", cur);
    if (await this.state.storage.get("ended")) return;
    const meta = await this.meta((await this.state.storage.get<string>("bid")) ?? undefined);
    if (!meta) return;
    const now = Date.now();
    const p = await this.pres();
    this.closeOpen(p[att.role], now);
    await this.state.storage.put("pres", p);
    await this.writeSeconds(meta, p, now);
    await this.send(other(att.role), { t: "peer_left" });
  }

  async alarm(): Promise<void> {
    const meta = await this.meta((await this.state.storage.get<string>("bid")) ?? undefined);
    if (!meta) return;
    if (Date.now() >= meta.slot_end_ms + GRACE_AFTER_MS) await this.endCall("slot_over");
    else await this.state.storage.setAlarm(meta.slot_end_ms + GRACE_AFTER_MS);
  }

  // ------------------------------------------------------------ end of call
  private async endCall(reason: EndReason): Promise<void> {
    if (await this.state.storage.get("ended")) return;
    await this.state.storage.put("ended", reason);
    const bid = await this.state.storage.get<string>("bid");
    const meta = await this.meta(bid ?? undefined);
    if (!meta) return;
    const now = Date.now();
    const p = await this.pres();
    this.closeOpen(p.customer, now); this.closeOpen(p.consultant, now);
    await this.state.storage.put("pres", p);
    const seconds = await this.writeSeconds(meta, p, now);
    try {
      await metaDb(this.env).prepare("UPDATE consult_bookings SET call_ended_at = COALESCE(call_ended_at, ?2), updated_at = ?2 WHERE id = ?1").bind(meta.id, now).run();
    } catch (e) { await trackException(this.env, e, { route: "consult_call.end", handled: true, app_name: APP }); }
    const msg = JSON.stringify({ t: "ended", reason } satisfies CallServerMsg);
    for (const ws of this.state.getWebSockets()) { try { ws.send(msg); ws.close(1000, "ended"); } catch { /* gone */ } }
    try { await this.state.storage.deleteAlarm(); } catch { /* none set */ }
    void track(this.env, meta.consultant_uid, "consult_call_ended", APP, { reason, seconds });
    await settleBooking(this.env, meta.id); // never throws; logs its own failures
  }
}
