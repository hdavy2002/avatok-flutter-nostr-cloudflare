// ava_reason.ts — AVA CORE Phase 0 (AVA-CORE-1). The ONE reasoning entry point
// for the worker package. Every feature that wants an LLM completion goes through
// avaReason() instead of calling a model provider directly (the "sacred rule":
// ODL → Governor → Registry → avaReason; see Specs/AVA-COPILOT-FINAL-PLAN §13).
//
// MODEL SELECTION
//   AVA_REASONER      default "@cf/google/gemma-4-26b-a4b-it" — runs on the Workers
//                     AI binding env.AI (primary).
//   AVA_REASONER_ALT  default "google/gemini-2.5-flash-lite" — runs via OpenRouter
//                     (OPENROUTER_API_KEY) as the error/429 fallback.
//
// BEHAVIOUR PRESERVATION (Phase 0 is behaviour-neutral). A caller may pin the
// EXACT model+provider it used before the migration via `legacyModel`. When set,
// avaReason calls that model on OpenRouter DIRECTLY (no Workers-AI attempt, no ALT
// fallback) — i.e. identical wire behaviour to the pre-Phase-0 code. This is how
// ai_chat (flash-lite), ava_guardian (Opus) and ava_gemini/ChatAVA (glm-5.2) keep
// their exact current models with NO new env vars set. Clearing the legacy default
// later (config-only) flips a route onto the shared reasoner + fallback ladder.
//
// CACHE KEY CONVENTION (documented for all callers):
//   cls:<hash>                 — classification result
//   gen:<…>                    — generation (this helper's optional KV cache slot)
//   doc:<conv|hash|op|lang>    — derived content
// The optional KV response cache (when `cacheKey` is given) is namespaced
// `gen:<cacheKey>` in the same KV binding ai_chat uses (env.TOKENS).
//
// TELEMETRY: one PostHog `ava_reason_call` event per call via the existing track
// hook: { role, capability, trigger, opportunity, model, ok, fallback_used,
// latency_ms }. When uid/email are in scope they are stamped (project convention).
import type { Env } from "../types";
import { track, trackUser } from "../hooks";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Default reasoner (Workers AI, env.AI) and ALT (OpenRouter) — overridable via [vars]. */
export function reasonerModel(env: Env): string {
  return ((env as any).AVA_REASONER as string) || "@cf/google/gemma-4-26b-a4b-it";
}
export function reasonerAltModel(env: Env): string {
  return ((env as any).AVA_REASONER_ALT as string) || "google/gemini-2.5-flash-lite";
}

export type ChatMessage = { role: string; content: unknown };

export interface AvaReasonReq {
  // REQUIRED capability tags (governance + telemetry). Missing → dev-throw / prod-warn.
  role: string;
  capability: string;
  trigger: string;
  opportunity?: string;

  // Prompt: EITHER a full messages array OR a system+user pair.
  system?: string;
  user?: string;
  messages?: ChatMessage[];

  // Generation params.
  maxTokens?: number;
  temperature?: number;
  json?: boolean;        // request strict JSON output (OpenRouter response_format)
  timeoutMs?: number;    // optional abort timeout for the provider fetch

  // Optional KV response cache (namespaced gen:<cacheKey> in env.TOKENS).
  cacheKey?: string;
  cacheTtl?: number;     // seconds; default 24h

  // Behaviour-preservation: pin this exact OpenRouter model as the primary call
  // (no Workers-AI attempt, no ALT fallback → identical to pre-Phase-0 code).
  legacyModel?: string;

  // OpenRouter-only streaming passthrough (returns the raw fetch Response).
  stream?: boolean;

  // Telemetry identity (best-effort; stamped when present).
  uid?: string;
  email?: string | null;
  appName?: string;      // PostHog app_name; defaults to "ava_core"
}

function orHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://avatok.ai",
    "X-Title": "AvaTOK avaReason",
  };
}

function buildMessages(req: AvaReasonReq): ChatMessage[] {
  if (req.messages && req.messages.length) return req.messages;
  const out: ChatMessage[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  out.push({ role: "user", content: req.user ?? "" });
  return out;
}

/** Validate the required capability tags. Dev → throw; prod → console.error + continue. */
function checkTags(env: Env, req: AvaReasonReq): void {
  const missing = (["role", "capability", "trigger"] as const).filter((k) => !String((req as any)[k] ?? "").trim());
  if (!missing.length) return;
  const msg = `avaReason: missing required tag(s): ${missing.join(", ")}`;
  if ((env as any).DEV) throw new Error(msg);
  console.error(msg); // prod: never break the user flow in Phase 0
}

/** One OpenRouter chat completion. Returns trimmed text; throws on hard failure. */
async function openRouterCall(env: Env, model: string, req: AvaReasonReq): Promise<string> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("openrouter key missing");
  const body: Record<string, unknown> = {
    model,
    messages: buildMessages(req),
    max_tokens: req.maxTokens ?? 400,
    temperature: req.temperature ?? 0.3,
  };
  if (req.json) body.response_format = { type: "json_object" };
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: orHeaders(key),
    body: JSON.stringify(body),
    ...(req.timeoutMs ? { signal: AbortSignal.timeout(req.timeoutMs) } : {}),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${String(out?.error?.message ?? out?.error ?? "").slice(0, 160)}`);
  }
  return String(out?.choices?.[0]?.message?.content ?? "").trim();
}

/** One Workers-AI (env.AI) chat completion. Returns trimmed text; throws on failure. */
async function workersAiCall(env: Env, model: string, req: AvaReasonReq): Promise<string> {
  const ai: any = (env as any).AI;
  if (!ai || typeof ai.run !== "function") throw new Error("workers-ai binding missing");
  const r: any = await ai.run(model, {
    messages: buildMessages(req),
    max_tokens: req.maxTokens ?? 400,
    temperature: req.temperature ?? 0.3,
  });
  return String(r?.response ?? r?.result?.response ?? "").trim();
}

function emitCall(
  env: Env, req: AvaReasonReq,
  info: { model: string; ok: boolean; fallback_used: boolean; latency_ms: number },
): void {
  const props = {
    role: req.role, capability: req.capability, trigger: req.trigger,
    opportunity: req.opportunity ?? null, ...info,
  };
  try {
    if (req.email) void trackUser(env, req.uid ?? "", req.email, "ava_reason_call", req.appName ?? "ava_core", props);
    else void track(env, req.uid ?? "", "ava_reason_call", req.appName ?? "ava_core", props);
  } catch { /* telemetry best-effort */ }
}

// Overloads: stream:true returns the raw OpenRouter Response; otherwise text.
export function avaReason(env: Env, req: AvaReasonReq & { stream: true }): Promise<Response>;
export function avaReason(env: Env, req: AvaReasonReq): Promise<string>;
export async function avaReason(env: Env, req: AvaReasonReq): Promise<string | Response> {
  checkTags(env, req);

  // Streaming passthrough (OpenRouter-only). Returns the raw fetch Response so the
  // caller drives its own SSE plumbing — we do not buffer or transform tokens.
  if (req.stream) return openRouterStream(env, req);

  // Optional KV response cache (gen:<cacheKey>). Cache holds the plain text result.
  const cacheKey = req.cacheKey ? `gen:${req.cacheKey}` : null;
  if (cacheKey) {
    try {
      const hit = await (env as any).TOKENS?.get(cacheKey);
      if (typeof hit === "string" && hit.length) return hit;
    } catch { /* cache miss */ }
  }

  const t0 = Date.now();
  const legacy = String(req.legacyModel ?? "").trim();

  // Behaviour-preserving path: pinned OpenRouter model, single call, no fallback.
  if (legacy) {
    try {
      const text = await openRouterCall(env, legacy, req);
      emitCall(env, req, { model: legacy, ok: true, fallback_used: false, latency_ms: Date.now() - t0 });
      if (cacheKey) { try { await (env as any).TOKENS?.put(cacheKey, text, { expirationTtl: req.cacheTtl ?? 86400 }); } catch { /* best-effort */ } }
      return text;
    } catch (e) {
      emitCall(env, req, { model: legacy, ok: false, fallback_used: false, latency_ms: Date.now() - t0 });
      throw e;
    }
  }

  // Reasoner ladder: Workers AI primary → OpenRouter ALT on error/429.
  const primary = reasonerModel(env);
  const alt = reasonerAltModel(env);
  try {
    const text = await workersAiCall(env, primary, req);
    emitCall(env, req, { model: primary, ok: true, fallback_used: false, latency_ms: Date.now() - t0 });
    if (cacheKey) { try { await (env as any).TOKENS?.put(cacheKey, text, { expirationTtl: req.cacheTtl ?? 86400 }); } catch { /* best-effort */ } }
    return text;
  } catch (primaryErr) {
    // Fallback to OpenRouter ALT (covers Workers-AI error / 429 / capacity).
    try {
      const text = await openRouterCall(env, alt, req);
      emitCall(env, req, { model: alt, ok: true, fallback_used: true, latency_ms: Date.now() - t0 });
      if (cacheKey) { try { await (env as any).TOKENS?.put(cacheKey, text, { expirationTtl: req.cacheTtl ?? 86400 }); } catch { /* best-effort */ } }
      return text;
    } catch (altErr) {
      emitCall(env, req, { model: alt, ok: false, fallback_used: true, latency_ms: Date.now() - t0 });
      throw altErr instanceof Error ? altErr : new Error(String(altErr ?? primaryErr));
    }
  }
}

/** OpenRouter streaming passthrough — returns the raw fetch Response (SSE body). */
async function openRouterStream(env: Env, req: AvaReasonReq): Promise<Response> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("openrouter key missing");
  const model = String(req.legacyModel ?? "").trim() || reasonerAltModel(env);
  const body: Record<string, unknown> = {
    model,
    messages: buildMessages(req),
    max_tokens: req.maxTokens ?? 400,
    temperature: req.temperature ?? 0.3,
    stream: true,
  };
  if (req.json) body.response_format = { type: "json_object" };
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: orHeaders(key),
    body: JSON.stringify(body),
  });
  // Telemetry: a streaming call was opened (ok reflects the HTTP handshake only).
  emitCall(env, req, { model, ok: res.ok, fallback_used: false, latency_ms: 0 });
  return res;
}
