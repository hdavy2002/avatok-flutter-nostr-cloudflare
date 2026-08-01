import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { json } from "../util";
import { readConfig } from "./config";
import { holdForConference } from "../lib/call_billing";

function room(env: Env, roomId: string) {
  return env.CONFERENCE_ROOMS.get(env.CONFERENCE_ROOMS.idFromName(roomId));
}

export async function conferenceRoomRoute(req: Request, env: Env, roomId: string, action: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  const allowed = new Set(["state", "start", "participant/reserve", "participant/join", "participant/leave", "migration/reserve", "migration/prepare", "migration/commit", "migration/abort", "billing/start", "billing/sponsor/accept", "billing/tick", "host/transfer", "end"]);
  if (!allowed.has(action)) return json({ error: "not found" }, 404);
  if (action === "start") {
    const groupId = String((body as any)?.group_id ?? "").trim();
    if (!groupId) return json({ error: "group_id required" }, 400);
    const member = await env.DB_META.prepare("SELECT 1 AS ok FROM conversation_members WHERE conv_id=?1 AND uid=?2 LIMIT 1").bind(groupId, ctx.uid).first<{ ok: number }>();
    if (!member) return json({ error: "not a group participant" }, 403);
  }
  const payload = { ...(body as Record<string, unknown>), uid: ctx.uid };
  if (action === "billing/start") {
    const cfg = await readConfig(env);
    if (!cfg.conferenceBillingEnabled) return json({ error: "conference billing disabled" }, 503);
    const minutes = Math.trunc(Number((body as any)?.reserved_minutes));
    const stateResponse = await room(env, roomId).fetch("https://conference-room/state");
    const state = await stateResponse.json() as { call_id?: string; sponsor_uid?: string; media_kind?: string };
    if (state.sponsor_uid !== ctx.uid) return json({ error: "only the persisted sponsor may authorize billing" }, 403);
    if (state.media_kind === "audio") return json({ ok: true, free: true, tariff_per_hour: 0 });
    if (!(cfg.conferenceVideoTokensPerHour > 0)) return json({ error: "video conference tariff is not configured" }, 503);
    const callId = String(state.call_id ?? roomId);
    const held = await holdForConference(env, { call_id: callId, sponsor_id: ctx.uid, minutes, tariff_per_hour: cfg.conferenceVideoTokensPerHour });
    if (!held.ok) return json({ error: "sponsor authorization failed", reason: held.reason }, held.reason === "WALLET_INSUFFICIENT" ? 402 : 400);
    payload.tariff_per_hour = cfg.conferenceVideoTokensPerHour;
    payload.call_id = callId;
  }
  if (action === "billing/sponsor/accept") {
    const cfg = await readConfig(env);
    if (!cfg.conferenceBillingEnabled || !(cfg.conferenceVideoTokensPerHour > 0)) return json({ error: "video conference tariff is not configured" }, 503);
    const minutes = Math.trunc(Number((body as any)?.reserved_minutes));
    const stateResponse = await room(env, roomId).fetch("https://conference-room/state");
    const state = await stateResponse.json() as { call_id?: string; media_kind?: string; participants?: Array<{ uid?: string; provisional?: boolean }> };
    if (state.media_kind === "audio") return json({ error: "audio conferences are free and do not transfer sponsorship" }, 409);
    if (!state.participants?.some((participant) => participant.uid === ctx.uid && participant.provisional === false)) return json({ error: "not a committed participant" }, 403);
    const held = await holdForConference(env, { call_id: String(state.call_id ?? roomId), sponsor_id: ctx.uid, minutes, tariff_per_hour: cfg.conferenceVideoTokensPerHour });
    if (!held.ok) return json({ error: "sponsor authorization failed", reason: held.reason }, held.reason === "WALLET_INSUFFICIENT" ? 402 : 400);
    payload.tariff_per_hour = cfg.conferenceVideoTokensPerHour;
  }
  return room(env, roomId).fetch(`https://conference-room/${action}`, {
    method: req.method === "GET" ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: req.method === "GET" ? undefined : JSON.stringify(payload),
  });
}
