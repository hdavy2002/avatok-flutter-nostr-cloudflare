// [SAATHUM-PREETI-1 2026-09-30] Public API for Preeti, the site AI agent (spec: Specs/SPEC-2026-09-30-PREETI-AI-AGENT.md).
//   GET  /api/preeti/config            -> PreetiPublicConfig (cache 60s)
//   POST /api/preeti/session           -> PreetiSession   (optional Clerk bearer: signed-in = cross-device memory)
//   POST /api/preeti/identify          -> {ok,e164,email} (visitor gives email + WhatsApp [+ name]; never returns history)
//   POST /api/preeti/chat              -> text/event-stream of PreetiStreamEvent
//   POST /api/preeti/internal/sync     -> token-guarded knowledge sync (called from the web deploy workflow)
// CORS comes from util.json()/CORS like every other public /api route. Auth is OPTIONAL everywhere: a bad or
// missing token simply means "anonymous", never a 401.
import type { Env } from "../types";
import { CORS, json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { normalizeE164, INVALID_PHONE_MESSAGE } from "../lib/phone_e164";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { emailFor } from "../lib/identity";
import { normalizeEmail } from "../lib/preeti/leadgate";
import { readConfig } from "./config";
import { currentBrand, fillPlaceholders } from "../lib/preeti/brand_runtime";
import { streamPreetiTurn, MAX_MESSAGE_CHARS } from "../lib/preeti/chat";
import type { PageCtx, PreetiPublicConfig, PreetiSession } from "../lib/preeti/contracts";
import { syncSiteKnowledge } from "../lib/preeti/knowledge";
import { budgetState } from "../lib/preeti/spend";
import {
  conversationForUser, createConversation, getAgentConfig, getConv, latestConvForVisitor, ownsConversation, publicHistory, setIdentity,
} from "../lib/preeti/store";

const APP = "saathum";
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CHAT_PER_VISITOR_HOUR = 30;
const CHAT_PER_IP_HOUR = 120;

async function enabled(env: Env): Promise<{ on: boolean; cfg: Awaited<ReturnType<typeof getAgentConfig>> }> {
  const [plat, cfg] = await Promise.all([readConfig(env), getAgentConfig(env)]);
  return { on: plat.preetiEnabled === true && cfg.enabled, cfg };
}

/** Optional auth: a valid Clerk bearer -> canonical uid, anything else -> null. Never fails the request. */
async function optionalUid(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("authorization")) return null;
  try {
    const a = await requireUser(req, env);
    return isFail(a) ? null : a.uid;
  } catch (e) {
    await trackException(env, e, { route: "preeti.auth", handled: true, app_name: APP });
    return null;
  }
}

function pageOf(raw: any): PageCtx {
  const kind = ["home", "article", "event", "other"].includes(raw?.kind) ? raw.kind : "other";
  return { path: String(raw?.path ?? "/").slice(0, 200), kind, ref: raw?.ref ? String(raw.ref).slice(0, 80) : undefined };
}

async function body(req: Request): Promise<any | null> {
  try { const j = await req.json(); return j && typeof j === "object" ? j : null; } catch { return null; }
}

async function profile(env: Env, uid: string): Promise<{ name: string | null; e164: string | null; email: string | null }> {
  const u = await env.DB_META.prepare("SELECT display_name FROM users WHERE uid=?1").bind(uid).first<{ display_name: string | null }>().catch(() => null);
  const e164 = await verifiedWhatsAppNumber(env, uid).catch(() => null);
  const email = normalizeEmail(await emailFor(env, uid).catch(() => null));
  return { name: u?.display_name?.trim() || null, e164, email };
}

async function ipLimited(env: Env, req: Request, bucket: string, max: number): Promise<boolean> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const hour = Math.floor(Date.now() / 3600_000);
  const k = `preeti_rl:${bucket}:${(await sha256Hex(ip)).slice(0, 16)}:${hour}`;
  try {
    const n = Number((await env.TOKENS.get(k)) ?? 0);
    if (n >= max) return true;
    // [SAATHUM-PREETI-FAST-2] The counter write need not block the reply.
    void env.TOKENS.put(k, String(n + 1), { expirationTtl: 3700 }).catch((e) => trackException(env, e, { route: "preeti.ratelimit.put", handled: true, app_name: APP }));
  } catch (e) {
    await trackException(env, e, { route: "preeti.ratelimit", handled: true, app_name: APP }); // fail open
  }
  return false;
}

async function getPublicConfig(env: Env): Promise<Response> {
  const [{ on, cfg }, brand] = await Promise.all([enabled(env), currentBrand(env)]);
  const f = (s: string) => fillPlaceholders(s, brand, cfg.name);
  const over = on ? (await budgetState(env)).over : false;
  const out: PreetiPublicConfig = {
    enabled: on, agent_name: cfg.name, avatar_url: cfg.avatar_url, welcome_text: f(cfg.welcome_text),
    quick_replies: { home: cfg.quick_replies.home.map(f), article: cfg.quick_replies.article.map(f), event: cfg.quick_replies.event.map(f) },
    support_whatsapp_e164: cfg.support_whatsapp, brand_name: brand.name, brand_domain: brand.domain, over_budget: over,
  };
  return json(out, 200, { "cache-control": "public, max-age=60" });
}

async function postSession(req: Request, env: Env): Promise<Response> {
  const { on } = await enabled(env);
  if (!on) return json({ error: "disabled" }, 503);
  const b = await body(req);
  const visitorId = String(b?.visitor_id ?? "");
  if (!VISITOR_RE.test(visitorId)) return json({ error: "invalid_visitor" }, 400);
  const page = pageOf(b?.page);
  const uid = await optionalUid(req, env);
  let conv;
  let needsIdentity = false;
  if (uid) {
    // Signed in: name, verified WhatsApp and email come from the profile; never asked.
    const p = await profile(env, uid);
    conv = await conversationForUser(env, { uid, visitorId, name: p.name, e164: p.e164, email: p.email, page: page.path });
    if (conv.identity_changed) await track(env, uid, "preeti_identified", APP, { signed_in: true, source: "profile" }); // never the number/email
  } else {
    const asked = b?.conversation_id ? await getConv(env, String(b.conversation_id)) : null;
    conv = asked && !asked.is_test && ownsConversation(asked, null, visitorId) ? asked : await latestConvForVisitor(env, visitorId);
    // [SAATHUM-PREETI-LEADGATE-1] No conversation row until the first message (no empty inbox rows).
    if (!conv) {
      const out: PreetiSession = { conversation_id: "", needs_identity: true, needs_signin: false, name: null, history: [] };
      await track(env, "anon", "preeti_session", APP, { signed_in: false, restored: false, needs_identity: true, page_kind: page.kind });
      return json(out);
    }
    needsIdentity = !(conv.email && conv.e164);
  }
  const out: PreetiSession = {
    conversation_id: conv.id, needs_identity: needsIdentity, needs_signin: false, name: conv.name, history: await publicHistory(env, conv.id, 30),
  };
  await track(env, uid ?? "anon", "preeti_session", APP, { signed_in: !!uid, restored: out.history.length > 0, needs_identity: needsIdentity, page_kind: page.kind });
  return json(out);
}

async function postIdentify(req: Request, env: Env): Promise<Response> {
  const { on } = await enabled(env);
  if (!on) return json({ error: "disabled" }, 503);
  if (await ipLimited(env, req, "identify", 30)) return json({ error: "rate_limited" }, 429);
  const b = await body(req);
  const visitorId = String(b?.visitor_id ?? "");
  const name = String(b?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!VISITOR_RE.test(visitorId) || !b?.conversation_id) return json({ error: "invalid_request" }, 400);
  const email = normalizeEmail(b?.email);
  if (!email) return json({ error: "invalid_email", message: "Please enter a valid email address.", field: "email" }, 400);
  const e164 = normalizeE164(b?.whatsapp);
  if (!e164) return json({ error: "invalid_phone", message: INVALID_PHONE_MESSAGE, field: "whatsapp" }, 400);
  const uid = await optionalUid(req, env);
  const conv = await getConv(env, String(b.conversation_id));
  if (!conv || conv.is_test) return json({ error: "not_found" }, 404);
  if (!ownsConversation(conv, uid, visitorId)) return json({ error: "forbidden" }, 403);
  await setIdentity(env, conv.id, { name: name || null, email, e164 });
  await track(env, uid ?? "anon", "preeti_identified", APP, { signed_in: !!uid, source: "form" }); // never the number/email
  return json({ ok: true, e164, email }); // deliberately NOT returning any other conversation
}

async function postChat(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const b = await body(req);
  const visitorId = String(b?.visitor_id ?? "");
  const message = typeof b?.message === "string" ? b.message : "";
  const answerPending = b?.answer_pending === true;
  const convId = typeof b?.conversation_id === "string" ? b.conversation_id : "";
  if (!VISITOR_RE.test(visitorId)) return json({ error: "invalid_request" }, 400);
  if (answerPending ? !convId : !message.trim()) return json({ error: "invalid_request" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) return json({ error: "too_long", max: MAX_MESSAGE_CHARS }, 400);

  // [SAATHUM-PREETI-FAST-2] Independent checks run together, not one round trip after another.
  const hourAgo = Date.now() - 3600_000;
  const [{ on }, uid, existing, cnt] = await Promise.all([
    enabled(env),
    optionalUid(req, env),
    convId ? getConv(env, convId) : Promise.resolve(null),
    env.DB_META.prepare(
      `SELECT COUNT(*) n FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id
        WHERE c.visitor_id=?1 AND m.role='visitor' AND m.created_at>?2`,
    ).bind(visitorId, hourAgo).first<{ n: number }>().catch(() => null),
  ]);
  if (!on) return json({ error: "disabled" }, 503);
  if (convId && (!existing || existing.is_test)) return json({ error: "not_found" }, 404);
  if (existing && !ownsConversation(existing, uid, visitorId)) return json({ error: "forbidden" }, 403);
  if (Number(cnt?.n ?? 0) >= CHAT_PER_VISITOR_HOUR || (await ipLimited(env, req, "chat", CHAT_PER_IP_HOUR))) {
    await track(env, uid ?? "anon", "preeti_rate_limited", APP, { signed_in: !!uid });
    return json({ error: "rate_limited" }, 429);
  }
  const page = pageOf(b?.page);
  let conv = existing;
  let created = false;
  if (!conv) {
    // [SAATHUM-PREETI-LEADGATE-1] Lazy creation on the first message (no empty inbox rows).
    if (uid) {
      const p = await profile(env, uid);
      conv = await conversationForUser(env, { uid, visitorId, name: p.name, e164: p.e164, email: p.email, page: page.path });
    } else {
      conv = (await latestConvForVisitor(env, visitorId)) ?? (await createConversation(env, { visitorId, page: page.path }));
    }
    created = true;
  }
  return await streamPreetiTurn(env, ctx, {
    conversationId: conv.id, message, page, uid, visitorId,
    requireIdentity: !uid, answerPending, announceSession: created,
  });
}

/** Constant-time compare so the token cannot be guessed byte by byte. */
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function syncToken(env: Env): Promise<string> {
  // The Worker is at Cloudflare's text-binding limit (see lib/saathum_upi3.ts), so KV is the fallback home.
  const e = String((env as any).PREETI_SYNC_TOKEN ?? "").trim();
  if (e) return e;
  try { return ((await env.TOKENS.get("preeti_sync_token:v1")) ?? "").trim(); } catch { return ""; }
}

async function postSync(req: Request, env: Env): Promise<Response> {
  const want = await syncToken(env);
  if (want.length < 16) return json({ error: "not_configured" }, 503);
  const got = req.headers.get("x-preeti-sync-token") ?? "";
  if (!safeEq(got, want)) return json({ error: "forbidden" }, 403);
  const b = (await body(req)) ?? {};
  try {
    const r = await syncSiteKnowledge(env, { full: b.full === true });
    await track(env, "system", "preeti_kb_sync", APP, { source: "deploy_hook", ...r });
    return json({ ok: true, result: r });
  } catch (e) {
    await trackException(env, e, { route: "preeti.internal.sync", handled: true, app_name: APP });
    return json({ error: "sync_failed" }, 500);
  }
}

export async function preetiRoute(req: Request, env: Env, ctx: ExecutionContext, p: string): Promise<Response> {
  const m = req.method;
  if (p === "/api/preeti/config" && m === "GET") return await getPublicConfig(env);
  if (p === "/api/preeti/session" && m === "POST") return await postSession(req, env);
  if (p === "/api/preeti/identify" && m === "POST") return await postIdentify(req, env);
  if (p === "/api/preeti/chat" && m === "POST") return await postChat(req, env, ctx);
  if (p === "/api/preeti/internal/sync" && m === "POST") return await postSync(req, env);
  return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", ...CORS } });
}
