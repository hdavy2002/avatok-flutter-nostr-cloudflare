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

// POST /notify  { to: uid | uid[], fromName?, preview?, title?, body?, data? }
// The chat client (push_service.notifyMessage) sends { to: [uid,...], fromName,
// preview } — so we MUST forward fromName + preview (the consumer's buildPayload
// reads them to render the WhatsApp-style sender + expandable message banner) and
// fan out one push PER recipient. The old code dropped fromName/preview (banner
// fell back to a bare "AvaTOK / New message") and String([a,b]) collapsed a group
// into one bogus comma-joined uid, so group messages got no push at all. This
// regressed once the Ably migration made /api/notify the sole offline-wake path
// (the InboxDO append-push was skipped on mobile). Owner report 2026-06-28.
export async function postNotify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.to) return json({ error: "to (uid) required" }, 400);
  const recipients = (Array.isArray(b.to) ? b.to : [b.to])
    .map((x: unknown) => String(x).trim())
    .filter((x: string) => x.length > 0);
  if (!recipients.length) return json({ error: "to (uid) required" }, 400);
  const fromName = b.fromName ?? b.title ?? null;
  const preview = b.preview ?? b.body ?? null;
  // [AVANOTIF-VM-1] `from: ctx.uid` below is ALREADY the trustworthy sender
  // identity (Worker-authenticated via requireUser, unlike the client-supplied
  // `fromName`) — the consumer forwards it to the recipient's device as
  // `fromUid` so the RECIPIENT can resolve a name from their OWN contact book
  // instead of trusting the sender's self-declared display name. `fromPhone` is
  // an optional client hint (E.164) for phone-only flows; capped defensively.
  const fromPhone = typeof b.fromPhone === "string" ? b.fromPhone.slice(0, 32) : null;
  await Promise.all(recipients.map((to: string) => env.Q_PUSH.send({
    kind: "notify", to, from: ctx.uid,
    fromName, preview, ...(fromPhone ? { fromPhone } : {}), data: b.data ?? null, ts: Date.now(),
  })));
  return json({ ok: true, queued: recipients.length });
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
