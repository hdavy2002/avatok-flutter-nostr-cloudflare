import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { json } from "../util";

function room(env: Env, roomId: string) {
  return env.CONFERENCE_ROOMS.get(env.CONFERENCE_ROOMS.idFromName(roomId));
}

export async function conferenceRoomRoute(req: Request, env: Env, roomId: string, action: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  const allowed = new Set(["state", "start", "participant/reserve", "participant/join", "participant/leave", "migration/reserve", "migration/prepare", "migration/commit", "migration/abort", "billing/start", "billing/sponsor/accept", "billing/tick", "host/transfer", "end"]);
  if (!allowed.has(action)) return json({ error: "not found" }, 404);
  // Owner decision 2026-08-02: human audio/video conferences are permanently
  // free. Keep legacy billing actions as harmless success responses so an older
  // installed client cannot fail a call, but never hold, settle, or transfer
  // wallet funds. These actions deliberately do not reach the DO.
  if (action === "billing/start" || action === "billing/sponsor/accept") {
    return json({ ok: true, free: true, tariff_per_hour: 0, billing_disabled: true });
  }
  if (action === "billing/tick") {
    return json({ ok: true, free: true, settled: false, billing_disabled: true });
  }
  if (action === "start") {
    const groupId = String((body as any)?.group_id ?? "").trim();
    if (!groupId) return json({ error: "group_id required" }, 400);
    const member = await env.DB_META.prepare("SELECT 1 AS ok FROM conversation_members WHERE conv_id=?1 AND uid=?2 LIMIT 1").bind(groupId, ctx.uid).first<{ ok: number }>();
    if (!member) return json({ error: "not a group participant" }, 403);
  }
  const payload: Record<string, unknown> = { ...(body as Record<string, unknown>), uid: ctx.uid };
  return room(env, roomId).fetch(`https://conference-room/${action}`, {
    method: req.method === "GET" ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: req.method === "GET" ? undefined : JSON.stringify(payload),
  });
}
