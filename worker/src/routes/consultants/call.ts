// [AUMFE-CONSULT-W3-1 2026-10-02] POST /api/consultants/sessions/:id/ticket — single-use 60 s call ticket (KV TOKENS, same as
// routes/voice.ts) for the booking's customer or consultant, plus ICE servers (Cloudflare STUN + TURN when keys exist).
// The WebSocket itself is routed by index.ts -> routes/consultants/ws.ts -> ConsultCallDO.
import type { Env } from "../../types";
import { json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { track, trackException } from "../../hooks";
import { metaDb } from "../../db/shard";
import { consultVisible } from "../../lib/consultants/access";
import { GRACE_AFTER_MS, JOIN_EARLY_MS } from "../../lib/consultants/slots";
import type { CallTicketDTO, RTCIceServerLike } from "../../lib/consultants/types";
import { mintIceServersWithStatus } from "../media";

const APP = "aumfe_consult";
export const CONSULT_TICKET_PREFIX = "consult_ticket:";
const TICKET_TTL_S = 60; // KV's minimum
const ICE_TTL_S = 2 * 3600;

export interface ConsultTicketRec { booking_id: string; uid: string; role: "customer" | "consultant"; ts: number }

const newTicket = (): string => { const b = new Uint8Array(24); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };

export async function callRoutes(req: Request, env: Env, p: string, _ctx?: ExecutionContext): Promise<Response | null> {
  const m = /^\/api\/consultants\/sessions\/([A-Za-z0-9_-]{1,64})\/ticket$/.exec(p);
  if (!m) return null;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  try {
    if (!(await consultVisible(env, u.uid))) return json({ error: "not_found" }, 404);
    const b = await metaDb(env).prepare(
      `SELECT b.id, b.uid, b.status, b.slot_start_ms, b.slot_end_ms, b.call_ended_at, c.uid AS consultant_uid
         FROM consult_bookings b JOIN consultants c ON c.id = b.consultant_id WHERE b.id = ?1`,
    ).bind(m[1]).first<{ id: string; uid: string; status: string; slot_start_ms: number; slot_end_ms: number; call_ended_at: number | null; consultant_uid: string | null }>();
    const role: "customer" | "consultant" | null = !b ? null : b.uid === u.uid ? "customer" : (b.consultant_uid && b.consultant_uid === u.uid) ? "consultant" : null;
    if (!b || !role) return json({ error: "not_found" }, 404); // never reveal that someone else's booking exists
    if (b.status !== "confirmed" && b.status !== "in_call") return json({ error: "not_joinable", status: b.status }, 409);
    const now = Date.now();
    const opens = b.slot_start_ms - JOIN_EARLY_MS;
    if (now < opens) return json({ error: "too_early", join_opens_ms: opens }, 409);
    if (now > b.slot_end_ms + GRACE_AFTER_MS || b.call_ended_at) return json({ error: "session_over" }, 410);

    const ice = await mintIceServersWithStatus(env, ICE_TTL_S);
    const ticket = newTicket();
    const rec: ConsultTicketRec = { booking_id: b.id, uid: u.uid, role, ts: now };
    await env.TOKENS.put(CONSULT_TICKET_PREFIX + ticket, JSON.stringify(rec), { expirationTtl: TICKET_TTL_S });
    const host = new URL(req.url).host;
    const dto: CallTicketDTO = {
      ticket, role, slot_end_ms: b.slot_end_ms,
      ws_url: `wss://${host}/api/consultants/ws?ticket=${encodeURIComponent(ticket)}`,
      ice_servers: ice.iceServers as RTCIceServerLike[],
    };
    void track(env, u.uid, "consult_call_ticket", APP, { role, relay: !ice.relayDegraded, ok: true });
    return json(dto);
  } catch (e) {
    await trackException(env, e, { uid: u.uid, route: "/api/consultants/sessions/:id/ticket", handled: true, app_name: APP });
    void track(env, u.uid, "consult_call_ticket", APP, { ok: false });
    return json({ error: "server_error" }, 500);
  }
}
