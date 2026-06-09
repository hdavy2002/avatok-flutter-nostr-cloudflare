// Push producers. Per Rulebook, the Worker NEVER calls FCM/APNs inline — it
// enqueues to Q_PUSH and returns immediately. The push consumer Worker (Phase 4)
// resolves device tokens from D1 push_tokens_v2 and delivers via FCM/APNs.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";

// POST /call  { to: uid, type?: 'voice'|'video', room?, sdp? }  → wake callee
export async function postCall(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.to) return json({ error: "to (uid) required" }, 400);
  await env.Q_PUSH.send({
    kind: "call", to: String(b.to), from: ctx.uid,
    callType: b.type || "voice", room: b.room ?? null, ts: Date.now(),
  });
  return json({ ok: true, queued: true });
}

// POST /notify  { to: uid, title?, body?, data? }
export async function postNotify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.to) return json({ error: "to (uid) required" }, 400);
  await env.Q_PUSH.send({
    kind: "notify", to: String(b.to), from: ctx.uid,
    title: b.title ?? null, body: b.body ?? null, data: b.data ?? null, ts: Date.now(),
  });
  return json({ ok: true, queued: true });
}

// POST /call-status  { to: uid, status: 'declined'|'missed'|'ended' }
export async function postCallStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.to || !b.status) return json({ error: "to + status required" }, 400);
  await env.Q_PUSH.send({ kind: "call-status", to: String(b.to), from: ctx.uid, status: b.status, ts: Date.now() });
  return json({ ok: true, queued: true });
}
