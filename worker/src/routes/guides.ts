// [AUMFE-GUIDE-BRAIN-1 2026-10-01] Pandit ji, the text guide — HTTP surface. Clerk auth like routes/voice.ts.
//   GET  /api/guides/pandit/state   -> screen state (flag, profile, consent, chart, memories, last conversation)
//   POST /api/guides/pandit/chat    {conversation_id?, text} -> text/event-stream (one JSON per `data:` line, see lib/guides/types.ts)
//   POST /api/guides/pandit/close   {conversation_id} -> {ok, closed, saved}  [AUMFE-PANDIT-COST-1] summarise + save to memory + resolve
// Profile, consent and memories are edited through the EXISTING /api/me/astro-profile, /api/me/memory-consent and
// /api/me/memories routes (routes/agent_memory.ts); nothing is duplicated here.
import type { Env } from "../types";
import { CORS, json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { contactFor } from "../lib/identity";
import { chatLang } from "../lib/guides/personas";
import { getProfile, listMemories } from "../lib/agent_memory";
import { readConfig } from "./config";
import { canUsePandit } from "../lib/guides/access";
import { loadChartSummary } from "../lib/guides/chart";
import { countCustomerMessages, getOwnedConversation, latestConversation, loadMessages } from "../lib/guides/store";
import { limitsFromConfig, type PanditLimits } from "../lib/guides/cost";
import { closeTopic } from "../lib/guides/topic";
import { MAX_USER_CHARS, runPanditTurn } from "../lib/guides/text_chat";
import type { ChatEvent } from "../lib/guides/types";

const APP = BRAND.slug;
const BASE = "/api/guides/pandit";

/** Returns null when the path is not ours. */
export async function guidesRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const isState = p === `${BASE}/state`;
  const isChat = p === `${BASE}/chat`;
  const isClose = p === `${BASE}/close`;
  if (!isState && !isChat && !isClose) return null;
  if (isState && req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if ((isChat || isClose) && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.status === 401 ? "unauthorized" : u.error }, u.status);
  const uid = u.uid;
  const cfg = await readConfig(env);
  const enabled = cfg.panditChatEnabled === true;
  const canUse = canUsePandit(enabled, uid, env.AGENT_ADMIN_UIDS);

  if (isState) return stateResponse(env, uid, enabled, canUse);

  if (!canUse) {
    void track(env, uid, "pandit_chat_blocked", APP, { reason: "disabled" });
    return json({ error: "pandit_disabled" }, 403);
  }
  if (isClose) return closeResponse(req, env, uid);
  let body: { conversation_id?: unknown; text?: unknown; lang?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return json({ error: "bad_json" }, 400); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "text_required" }, 400);
  if (text.length > MAX_USER_CHARS) return json({ error: "text_too_long" }, 400);
  const conversationId = typeof body.conversation_id === "string" && body.conversation_id ? body.conversation_id : null;
  return sseResponse(env, uid, conversationId, text, chatLang(body.lang), limitsFromConfig(cfg)); // [AUMFE-PANDIT-LANG-1]
}

async function stateResponse(env: Env, uid: string, enabled: boolean, canUse: boolean): Promise<Response> {
  try {
    const [profile, contact, conv] = await Promise.all([
      getProfile(env, uid),
      contactFor(env, uid).catch((e) => { void trackException(env, e, { uid, route: `${BASE}/state`, handled: true, app_name: APP }); return { email: null, phone: null }; }),
      latestConversation(env, uid),
    ]);
    const consent = !!profile?.memory_consent;
    const [chart, memories, messages] = await Promise.all([
      profile?.dob ? loadChartSummary(env, uid) : Promise.resolve(null),
      consent ? listMemories(env, uid, { limit: 40 }) : Promise.resolve([]),
      conv ? loadMessages(env, conv.id) : Promise.resolve([]),
    ]);
    return json({
      enabled,
      can_use: canUse,
      needs_phone: !contact.phone,
      profile: profile && {
        name: profile.name, dob: profile.dob, tob: profile.tob, tob_unknown: !!profile.tob_unknown, place: profile.place, gender: profile.gender,
      },
      consent,
      chart,
      memories: memories.filter((m) => m.kind !== "summary").map((m) => ({ id: m.id, text: m.text })),
      conversation: conv ? { id: conv.id, messages } : null,
    });
  } catch (e) {
    await trackException(env, e, { uid, route: `${BASE}/state`, handled: true, app_name: APP });
    return json({ error: "server_error" }, 500);
  }
}

function sseResponse(env: Env, uid: string, conversationId: string | null, text: string, lang: string | null, limits: PanditLimits): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let chain: Promise<unknown> = Promise.resolve();
  const emit = (e: ChatEvent) => { chain = chain.then(() => writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`))).catch(() => undefined); };
  void (async () => {
    try { await runPanditTurn(env, { uid, conversationId, text, lang, limits, emit }); }
    finally { await chain; await writer.close().catch(() => undefined); } // client already gone: nothing left to tell it
  })();
  return new Response(readable, {
    // [AUMFE-GUIDE-BRAIN-2] A streamed Response does not go through util.json(), so it needs CORS itself or the browser
    // reports "Failed to fetch" on every chat turn.
    headers: { ...CORS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

/** The "New topic" button: close the current conversation the same way the turn cap does (summary + facts to memory, status resolved). */
async function closeResponse(req: Request, env: Env, uid: string): Promise<Response> {
  let body: { conversation_id?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return json({ error: "bad_json" }, 400); }
  const id = typeof body.conversation_id === "string" ? body.conversation_id : "";
  try {
    const conv = id ? await getOwnedConversation(env, uid, id) : null;
    if (!conv) return json({ error: "not_found" }, 404);
    const r = await closeTopic(env, uid, { conversationId: conv.id, reason: "manual", turns: await countCustomerMessages(env, conv.id) });
    return json({ ok: true, closed: r.closed, saved: r.saved });
  } catch (e) {
    await trackException(env, e, { uid, route: `${BASE}/close`, handled: true, app_name: APP });
    return json({ error: "server_error" }, 500);
  }
}
