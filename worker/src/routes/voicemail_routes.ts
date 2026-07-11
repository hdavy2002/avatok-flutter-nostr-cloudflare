// POST /api/voicemail/start — WP3 (plan §3 step 4 / §7 item 5 / §15.5 of
// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Mirrors routes/receptionist.ts's receptionistStart() validation + WS URL
// return shape, but MUCH thinner — VoicemailRoom (do/voicemail_room.ts) has no
// dialog loop, no LLM, no allowance/tier gating (voicemail is the free
// fallback everyone gets, never a paid feature). Flag-gated on `voicemailBot`.
import type { Env } from "../types";
import { json, normalizePhone } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { contactFor, nameFor } from "../lib/identity";
import { trackUserContact } from "../hooks";

const INIT_TTL_SEC = 300; // caller must connect the WS within 5 min, same as receptionist

export async function voicemailStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.voicemailBot !== true) return json({ error: "disabled", flag: "voicemailBot" }, 503);

  const b = (await req.json().catch(() => ({}))) as { to?: string; call_id?: string; caller_name?: string; caller_phone?: string; trace_id?: string };
  const to = String(b.to || "");
  if (!to) return json({ error: "to required" }, 400);

  const caller = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  const callerPhone = (b.caller_phone ? normalizePhone(String(b.caller_phone)) : null) || caller.phone || null;
  const callerName = (b.caller_name == null ? null : String(b.caller_name).slice(0, 80)) || await nameFor(env, ctx.uid).catch(() => null);
  const ownerName = (await nameFor(env, to).catch(() => null)) || "your contact";
  const callId = b.call_id == null ? null : String(b.call_id).slice(0, 64);

  const recordSec = Math.max(5, Math.round(Number(cfg.voicemailRecordSec) || 25));
  const graceSec = 3;
  // Fixed carrier-style prompt (plan §3 step 4) — composed server-side, never
  // client-editable, so the wording is consistent for every voicemail.
  const greeting = `Hi, ${ownerName} isn't available. Please leave a ${recordSec}-second voicemail after the tone.`;

  const sid = crypto.randomUUID();
  const rtcToken = crypto.randomUUID();
  const init = {
    sid, owner_uid: to, caller_uid: ctx.uid, caller_name: callerName, caller_phone: callerPhone,
    call_id: callId, rtc_token: rtcToken, greeting, owner_name: ownerName,
    record_sec: recordSec, grace_sec: graceSec, trace_id: b.trace_id || null,
  };
  await env.TOKENS.put(`voicemail_rtc:${sid}`, JSON.stringify(init), { expirationTtl: INIT_TTL_SEC });

  trackUserContact(env, ctx.uid, caller.email, caller.phone, "voicemail_triggered", "voicemail",
    { owner: to, has_phone: !!callerPhone, call_id: callId }, sid);

  return json({
    ok: true, session_id: sid,
    rtc_url: `/api/voicemail/rtc?session=${sid}&t=${rtcToken}`,
    rtc_token: rtcToken, record_sec: recordSec, grace_sec: graceSec,
  });
}

// ---------------------------------------------------------------------------
// GET /api/voicemail/recording?key=<R2 key> — the CALLEE (voicemail owner)
// streams their own recording for the in-thread bubble's play button. Mirrors
// routes/receptionist.ts's receptionistRecording() shape, but voicemail has no
// sessions TABLE to look the owner up in (VoicemailRoom never writes one — it
// goes straight from the init blob to the callee's InboxDO), so auth here is
// the R2 key's OWNER PREFIX itself: do/voicemail_room.ts's finalize() always
// writes recordings under `voicemail/<owner_uid>/...` — never trust a key
// whose second segment isn't the authenticated caller's own uid.
// ---------------------------------------------------------------------------
export async function voicemailRecording(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.voicemailBot !== true) return json({ error: "disabled", flag: "voicemailBot" }, 503);
  const key = String(new URL(req.url).searchParams.get("key") || "");
  if (!key) return json({ error: "key required" }, 400);
  const parts = key.split("/");
  if (parts.length < 3 || parts[0] !== "voicemail" || parts[1] !== ctx.uid) {
    return json({ error: "not found" }, 404); // never confirm/deny another owner's key
  }
  const obj = await env.BLOBS.get(key);
  if (!obj) return json({ error: "gone" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "audio/wav",
      "cache-control": "private, max-age=86400",
      "accept-ranges": "bytes",
    },
  });
}
