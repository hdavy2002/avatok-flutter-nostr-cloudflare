// POST /api/voicemail/start — WP3 (plan §3 step 4 / §7 item 5 / §15.5 of
// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Mirrors routes/receptionist.ts's receptionistStart() validation + WS URL
// return shape, but MUCH thinner — VoicemailRoom (do/voicemail_room.ts) has no
// dialog loop, no LLM, no allowance/tier gating (voicemail is the free
// fallback everyone gets, never a paid feature). Flag-gated on `voicemailBot`
// (paid business bot, per-owner prompt) OR `avatokVoicemailFree` (the FREE
// AvaTOK↔AvaTOK auto-voicemail with a generic system greeting — [AVACALL-VMFREE-3]).
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
  const b = (await req.json().catch(() => ({}))) as { to?: string; call_id?: string; caller_name?: string; caller_phone?: string; trace_id?: string; free?: boolean };
  // [AVACALL-VMFREE-3] TWO ways in: the paid business voicemail bot
  // (`voicemailBot`, per-owner prompt) and the FREE AvaTOK↔AvaTOK auto-voicemail
  // (`avatokVoicemailFree`, generic system greeting — owner decision, Phase WS2).
  // The free path must NOT be gated by the paid flag, so accept the request when
  // EITHER switch is on. `wantFree` selects the generic greeting below.
  const wantFree = b.free === true;
  // [VM-KILL-1] GLOBAL master kill (owner 2026-07-21): when voicemail is disabled
  // platform-wide, NO new voicemail session may start on EITHER lane, regardless of
  // the paid/free per-surface flags. Already-recorded voicemails stay playable
  // (voicemailRecording below is intentionally NOT gated on this switch).
  if (cfg.voicemailEnabled === false) {
    return json({ error: "disabled", flag: "voicemailEnabled" }, 503);
  }
  if (cfg.voicemailBot !== true && cfg.avatokVoicemailFree !== true) {
    return json({ error: "disabled", flags: ["voicemailBot", "avatokVoicemailFree"] }, 503);
  }
  // A free-marked request is only honoured when the free switch is on; likewise a
  // business request needs the paid switch. This stops a client flipping `free`
  // to route around a disabled paid bot, or vice-versa.
  if (wantFree && cfg.avatokVoicemailFree !== true) return json({ error: "disabled", flag: "avatokVoicemailFree" }, 503);
  if (!wantFree && cfg.voicemailBot !== true) return json({ error: "disabled", flag: "voicemailBot" }, 503);

  const to = String(b.to || "");
  if (!to) return json({ error: "to required" }, 400);

  const caller = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  const callerPhone = (b.caller_phone ? normalizePhone(String(b.caller_phone)) : null) || caller.phone || null;
  const callerName = (b.caller_name == null ? null : String(b.caller_name).slice(0, 80)) || await nameFor(env, ctx.uid).catch(() => null);
  const ownerName = (await nameFor(env, to).catch(() => null)) || "your contact";
  const callId = b.call_id == null ? null : String(b.call_id).slice(0, 64);

  const recordSec = Math.max(5, Math.round(Number(cfg.voicemailRecordSec) || 25));
  const graceSec = 3;
  // Fixed prompt — composed server-side, never client-editable, so the wording is
  // consistent for every voicemail. Two variants:
  //   • FREE AvaTOK↔AvaTOK path ([AVACALL-VMFREE-3]): ONE generic system greeting
  //     that names nobody, keeping v1 simple (no per-user recording UI). This is
  //     the greeting used whenever there is no custom per-callee greeting.
  //   • Paid business bot: the per-owner carrier-style prompt (plan §3 step 4).
  // Both cache in R2 keyed by the greeting TEXT hash (voicemail_room.greetingPcm),
  // so the generic free greeting is synthesized once and replayed for everyone.
  const greeting = wantFree
    ? `The person you're calling isn't available right now. Please leave a message after the beep.`
    : `Hi, ${ownerName} isn't available. Please leave a ${recordSec}-second voicemail after the tone.`;

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
  // [AVACALL-VMFREE-3] A voicemail recording exists whenever EITHER the paid
  // business bot OR the free AvaTOK↔AvaTOK path is enabled, so playback must be
  // reachable under either switch (a free voicemail the callee couldn't play back
  // would be the same silent dead-end this phase exists to remove).
  if (cfg.voicemailBot !== true && cfg.avatokVoicemailFree !== true) {
    return json({ error: "disabled", flags: ["voicemailBot", "avatokVoicemailFree"] }, 503);
  }
  const key = String(new URL(req.url).searchParams.get("key") || "");
  if (!key) return json({ error: "key required" }, 400);
  const parts = key.split("/");
  if (parts.length < 3 || parts[0] !== "voicemail" || parts[1] !== ctx.uid) {
    return json({ error: "not found" }, 404); // never confirm/deny another owner's key
  }
  const obj = await env.BLOBS.get(key);
  if (!obj) return json({ error: "gone" }, 404);
  // [AVA-VM-SELFREC-1] Serve the object's STORED content-type so both the legacy
  // Vobiz <Record> WAVs (audio/wav) and the new self-recorded MP3s (audio/mpeg,
  // do/voicemail_stream_room.ts) play correctly. Fall back to audio/wav for any
  // older object written without httpMetadata.contentType.
  const ct = obj.httpMetadata?.contentType
    || (key.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
  return new Response(obj.body, {
    headers: {
      "content-type": ct,
      "cache-control": "private, max-age=86400",
      "accept-ranges": "bytes",
    },
  });
}
