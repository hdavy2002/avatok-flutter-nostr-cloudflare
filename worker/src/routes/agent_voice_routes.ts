// POST /api/agent/call/start — WP4 (plan §4/§8/§15.1/§15.3 of Specs/PLAN-2026-
// 07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Mirrors voicemail_routes.ts's shape (validate → stash an init blob in TOKENS
// KV → hand back a WS URL), but does the Mode A wallet hold + concurrency
// reservation the DO itself can't safely do BEFORE a WS even exists (mirrors
// how holdForAgentModeA/reserveAgentSlot are meant to run at the routing/start
// boundary, not deep inside the DO). Called by the routing layer / client the
// instant decideRouting()/decideNoAnswerRouting() returns action:'agent'.
import type { Env } from "../types";
import { json, normalizePhone } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { contactFor, nameFor } from "../lib/identity";
import { trackUserContact } from "../hooks";
import { resolveNumberAndProfile } from "./agent_profiles";
import { concurrencyKeyFor, reserveAgentSlot, releaseAgentSlot } from "../lib/call_routing";
import { holdForAgentModeA } from "../lib/call_billing";
import { buildCallSnapshot } from "../lib/call_snapshot";
import { newTraceId } from "../lib/call_events";
import type { InitBlob } from "../do/agent_voice_room";

const INIT_TTL_SEC = 300;

export async function agentCallStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.voiceAgent !== true) return json({ error: "disabled", flag: "voiceAgent", fallback: "voicemail" }, 503);

  const b = (await req.json().catch(() => ({}))) as {
    to?: string; number_dialed?: string; call_id?: string; trace_id?: string;
    caller_name?: string; caller_phone?: string;
  };
  const to = String(b.to || "");
  if (!to) return json({ error: "to required" }, 400);

  const resolved = await resolveNumberAndProfile(env, to, b.number_dialed ?? null);
  if (resolved.retired) return json({ error: "number_retired", fallback: "voicemail" }, 410);
  if (!resolved.agent_profile) return json({ error: "agent_not_configured", fallback: "voicemail" }, 404);

  const callId = (b.call_id && String(b.call_id).slice(0, 64)) || crypto.randomUUID();
  const traceId = (b.trace_id && String(b.trace_id).slice(0, 64)) || newTraceId();
  const billingMode: "A" | "B" = resolved.is_service_number ? "B" : "A";
  const numberKey = concurrencyKeyFor(resolved);

  // Concurrency backstop (plan §15.1) — the routing layer already checked a
  // slot was free when it decided 'agent', but reserve here too so a race
  // between two simultaneous no-answer callers can never both claim it.
  await reserveAgentSlot(env, { call_id: callId, number_key: numberKey, mode: billingMode });

  if (billingMode === "A") {
    const hold = await holdForAgentModeA(env, { call_id: callId, caller_id: ctx.uid, callee_id: to, trace_id: traceId });
    if (!hold.ok) {
      await releaseAgentSlot(env, callId);
      return json({ error: "wallet_insufficient", reason: hold.reason, fallback: "voicemail" }, 402);
    }
  }
  // Mode B: escrow is already held by the caller flow (paid-call price/length
  // prompt → holdForCall) before routing ever reaches 'agent' — nothing to
  // hold here; this route only stashes the session + starts the DO's meter.

  const caller = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  const callerPhone = (b.caller_phone ? normalizePhone(String(b.caller_phone)) : null) || caller.phone || null;
  const callerName = (b.caller_name == null ? null : String(b.caller_name).slice(0, 80)) || await nameFor(env, ctx.uid).catch(() => null);
  const ownerName = (await nameFor(env, to).catch(() => null)) || "your contact";

  const snapshot = await buildCallSnapshot(env, {
    rate: resolved.agent_profile.rate ?? null,
    length_options: resolved.agent_profile.length_options ?? null,
    routing_mode: resolved.agent_profile.routing ?? null,
    business_hours_version: resolved.agent_profile.business_hours_version != null ? String(resolved.agent_profile.business_hours_version) : null,
    blocked: false, agent_enabled: true, voicemail_enabled: cfg.voicemailBot === true,
    booking_authority: resolved.agent_profile.booking_authority,
  });

  const sid = crypto.randomUUID();
  const rtcToken = crypto.randomUUID();
  const init: InitBlob = {
    sid, call_id: callId, trace_id: traceId,
    owner_uid: to, caller_uid: ctx.uid, caller_name: callerName, caller_phone: callerPhone,
    billing_mode: billingMode, is_service_number: resolved.is_service_number, number_key: numberKey,
    service_number: resolved.is_service_number ? resolved.number : null,
    agent_profile_id: resolved.agent_profile.id, agent_profile_version: resolved.agent_profile.version,
    instructions: resolved.agent_profile.instructions, collection_id: resolved.agent_profile.collection_id,
    tool_manifest: resolved.agent_profile.tool_manifest, booking_authority: resolved.agent_profile.booking_authority,
    business_name: ownerName, owner_name: ownerName,
    snapshot, rtc_token: rtcToken,
  };
  await env.TOKENS.put(`agent_rtc:${sid}`, JSON.stringify(init), { expirationTtl: INIT_TTL_SEC });

  trackUserContact(env, ctx.uid, caller.email, caller.phone, "agent_call_triggered", "agent_voice",
    { owner: to, billing_mode: billingMode, is_service_number: resolved.is_service_number, call_id: callId }, sid);

  return json({
    ok: true, session_id: sid, call_id: callId, trace_id: traceId,
    rtc_url: `/api/agent/call/rtc?session=${sid}&t=${rtcToken}`,
    rtc_token: rtcToken, billing_mode: billingMode,
    agent_profile_id: resolved.agent_profile.id, agent_profile_version: resolved.agent_profile.version,
  });
}
