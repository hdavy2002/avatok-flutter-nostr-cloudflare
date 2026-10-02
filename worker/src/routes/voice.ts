// [AUMFE-VOICE-RUNTIME-1 2026-10-01] voice guides — HTTP surface.
//   GET  /api/voice/agents          public list of guides (+ enabled / can_use for a signed-in caller)
//   POST /api/voice/ticket {agent}  Clerk auth -> single-use 60 s ticket in KV TOKENS + the wss URL
//   GET  /api/voice/ws?ticket=      WebSocket upgrade -> consumes the ticket -> VoiceSessionDO
// The DO is only reachable through this route, and the uid/agent it trusts come from headers THIS worker sets from
// the ticket — never from the client. Wire protocol: lib/voice_agents/types.ts. Spec: Specs/SPEC-2026-10-01-VOICE-AGENTS.md.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { contactFor } from "../lib/identity";
import { readConfig } from "./config";
import { getAgent, listAgentsPublic, toPublic } from "../lib/voice_agents/registry";
import { canUseVoice, parseTicket } from "../lib/voice_agents/session_logic";
import { previewerUidsRaw } from "../lib/preview"; // [AUMFE-PREVIEW-GATE-1]
import { priceTokensPerMin } from "../lib/voice_agents/billing";
import { readSpendable, resolvePayer } from "../lib/voice_agents/billing_wallet";

const APP = "aumfe_voice";
const TICKET_PREFIX = "voice_ticket:";
const TICKET_TTL_S = 60; // KV's minimum expirationTtl

export const VOICE_HDR_UID = "x-voice-uid";
export const VOICE_HDR_AGENT = "x-voice-agent";
export const VOICE_HDR_EMAIL = "x-voice-email";

function newTicket(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** GET /api/voice/agents — auth is optional; a bad/absent token just means a signed-out view. */
export async function voiceAgentsList(req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env);
  let uid = "";
  if (req.headers.get("authorization")) {
    const u = await requireUser(req, env);
    if (!isFail(u)) uid = u.uid;
  }
  return json({
    agents: listAgentsPublic(),
    enabled: cfg.voiceAgentsEnabled === true,
    can_use: uid ? canUseVoice(cfg.voiceAgentsEnabled === true, uid, previewerUidsRaw(env), cfg.guidesPublic === true) : false,
    signed_in: !!uid,
    price_per_min_paise: cfg.voiceAgentPricePerMinPaise,
    free_seconds: cfg.voiceAgentFreeSeconds,
  });
}

/** POST /api/voice/ticket {agent} */
export async function voiceTicket(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  let body: { agent?: unknown } = {};
  try { body = (await req.json()) as { agent?: unknown }; } catch { return json({ error: "bad_json" }, 400); }
  const agent = getAgent(body.agent);
  if (!agent) return json({ error: "unknown_agent" }, 404);

  const cfg = await readConfig(env);
  if (!canUseVoice(cfg.voiceAgentsEnabled === true, u.uid, previewerUidsRaw(env), cfg.guidesPublic === true)) {
    void track(env, u.uid, "voice_ticket_denied", APP, { agent: agent.id, reason: "disabled" });
    return json({ error: "voice_agents_disabled" }, 403);
  }

  // [AUMFE-VOICE-BILLING-1] Voice is paid (1 token = Rs 1): no ticket unless the wallet covers at least one minute.
  const priceTokens = priceTokensPerMin(cfg.voiceAgentPricePerMinPaise);
  if (priceTokens > 0) {
    const spendable = await readSpendable(env, await resolvePayer(env, u.uid));
    if (spendable === null) return json({ error: "wallet_unavailable" }, 503);
    if (spendable < priceTokens) {
      void track(env, u.uid, "voice_ticket_denied", APP, { agent: agent.id, reason: "insufficient_balance", balance_tokens: spendable, price_per_min_tokens: priceTokens });
      return json({ error: "insufficient_balance", balance_tokens: spendable, price_per_min_tokens: priceTokens }, 402);
    }
  }

  let email: string | null = null;
  try { email = (await contactFor(env, u.uid)).email; } catch (e) {
    void trackException(env, e, { uid: u.uid, route: "/api/voice/ticket", handled: true, app_name: APP });
  }

  const ticket = newTicket();
  await env.TOKENS.put(
    TICKET_PREFIX + ticket,
    JSON.stringify({ uid: u.uid, agent: agent.id, email, ts: Date.now() }),
    { expirationTtl: TICKET_TTL_S },
  );
  void track(env, u.uid, "voice_ticket_issued", APP, { agent: agent.id });
  const host = new URL(req.url).host;
  return json({
    ticket,
    ws_url: `wss://${host}/api/voice/ws?ticket=${encodeURIComponent(ticket)}`,
    agent: toPublic(agent),
  });
}

/** GET /api/voice/ws?ticket= (Upgrade: websocket). `hint` is the continent location hint for the DO. */
export async function voiceWs(req: Request, env: Env, hint?: DurableObjectLocationHint): Promise<Response> {
  const ticket = new URL(req.url).searchParams.get("ticket") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) return new Response("ticket required", { status: 400 });
  const key = TICKET_PREFIX + ticket;
  let rec;
  try {
    rec = parseTicket(await env.TOKENS.get(key, "json"), Date.now());
    await env.TOKENS.delete(key); // single use, whether or not it was valid
  } catch (e) {
    void trackException(env, e, { route: "/api/voice/ws", handled: true, app_name: APP });
    return new Response("ticket check failed", { status: 503 });
  }
  if (!rec) return new Response("ticket invalid or expired", { status: 401 });
  const agent = getAgent(rec.agent);
  if (!agent) return new Response("unknown agent", { status: 404 });

  // Re-check the gate: the flag may have been switched off since the ticket was minted.
  const cfg = await readConfig(env);
  if (!canUseVoice(cfg.voiceAgentsEnabled === true, rec.uid, previewerUidsRaw(env), cfg.guidesPublic === true)) {
    return new Response("voice agents disabled", { status: 403 });
  }

  // Headers are set here from the ticket; anything the client sent under these names is discarded.
  const headers = new Headers(req.headers);
  headers.delete(VOICE_HDR_UID); headers.delete(VOICE_HDR_AGENT); headers.delete(VOICE_HDR_EMAIL);
  headers.set(VOICE_HDR_UID, rec.uid);
  headers.set(VOICE_HDR_AGENT, agent.id);
  if (rec.email) headers.set(VOICE_HDR_EMAIL, encodeURIComponent(rec.email));

  const sid = crypto.randomUUID();
  const stub = env.VOICE_SESSION.get(env.VOICE_SESSION.idFromName(sid), hint ? { locationHint: hint } : undefined);
  return stub.fetch(new Request(req, { headers }));
}
