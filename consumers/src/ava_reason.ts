// ─────────────────────────────────────────────────────────────────────────────
// avaReason() — the ONE model-call gateway for the consumers package (AVA-CORE-4).
//
// Every LLM call in the async layer (AvaBrain fact extraction / vision captioning,
// away auto-reply generation + urgency, image moderation) routes through here so a
// single place owns model selection, fallback, telemetry, and (optional) response
// caching. Features never talk to a model binding directly — they describe INTENT
// via {role, capability, trigger} and let the reasoner pick the model.
//
// Design (matches Specs/AVA-COPILOT-FINAL-PLAN §0–§4 + the Phase-0 dispatch):
//   • Primary  → Workers AI (`env.AI.run`), model = req.model ?? env.AVA_REASONER
//     ?? DEFAULT_REASONER ("@cf/google/gemma-4-26b-a4b-it"). Passing req.model lets
//     the EXISTING per-call env overrides (BRAIN_EXTRACT_MODEL / BRAIN_VISION_MODEL /
//     MODERATION_MODEL) WIN over the reasoner default → behavior-preserving.
//   • Fallback → OpenRouter ALT (model = env.AVA_REASONER_ALT ?? DEFAULT_ALT
//     "google/gemini-2.5-flash-lite") ONLY when an OPENROUTER_API_KEY is present AND
//     the request is chat-shaped AND req.fallback !== false. When no OpenRouter key
//     is configured (current consumers state), the fallback is "retry the primary
//     once, then throw" — call sites keep their existing try/catch fail-open, so the
//     queue ack/retry semantics are unchanged.
//   • Required tags {role, capability, trigger}. Missing → throw in dev
//     ((env as any).DEV), else console.error + still run (never break user flows).
//   • Telemetry per call: `ava_reason_call`
//     {role, capability, trigger, opportunity, model, ok, fallback_used, latency_ms}
//     emitted through the SAME mechanisms the package already uses — Analytics Engine
//     (env.ANALYTICS.writeDataPoint, as in brain.ts/moderation.ts) plus the PostHog
//     queue (env.Q_ANALYTICS.send, as in auto_reply.ts) — both best-effort.
//   • Optional KV response cache when req.cacheKey is given, namespaced `gen:<cacheKey>`
//     on env.TOKENS (the package's only KV binding). Cache-key convention (shared
//     with the worker helper): `cls:<hash>` classification · `gen:<…>` generation ·
//     `doc:<conv|hash|op|lang>` derived content. No current consumer call site passes
//     a cacheKey, so caching is dormant (documented in the Phase-0 report).
//
// Returns the RAW Workers-AI / OpenRouter output object unchanged, so callers keep
// using aiText(out) / out.usage.completion_tokens / parseClassifier(out) exactly as
// before — response shapes are preserved.
// ─────────────────────────────────────────────────────────────────────────────
import type { Env } from "./types";
import { bumpAiSpend } from "./ai";

const DEFAULT_REASONER = "@cf/google/gemma-4-26b-a4b-it";
const DEFAULT_ALT = "google/gemini-2.5-flash-lite";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface AvaReasonReq {
  // REQUIRED intent tags.
  role: string;
  capability: string;
  trigger: string;
  opportunity?: string;
  // Optional owner identity for telemetry pullability (uid → PostHog person).
  uid?: string;
  // Chat inputs (either system/user OR a full messages array).
  system?: string;
  user?: string;
  messages?: Array<{ role: string; content: unknown }>;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  cacheKey?: string;
  // Escape hatches for the package's non-plain-chat shapes:
  //  • model:     explicit model override; WINS over the reasoner default (this is
  //               how BRAIN_EXTRACT_MODEL / BRAIN_VISION_MODEL / MODERATION_MODEL are
  //               kept authoritative). Pass the env override (may be undefined).
  //  • aiOptions: extra Workers-AI run params merged into the chat body
  //               (e.g. { chat_template_kwargs, max_completion_tokens }).
  //  • raw:       a full non-chat Workers-AI body (e.g. { image: [...] } classifier);
  //               bypasses message assembly. OpenRouter fallback is skipped for raw
  //               bodies unless they carry a `messages` array.
  //  • bumpSpend: when true, avaReason records the AI spend counter itself; leave
  //               false (default) if the call site already calls bumpAiSpend.
  model?: string;
  aiOptions?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  fallback?: boolean;
  bumpSpend?: boolean;
}

function orHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://avatok.ai",
    "X-Title": "AvaTOK consumers avaReason",
  };
}

function buildBody(req: AvaReasonReq): Record<string, unknown> {
  if (req.raw) return { ...req.raw };
  const messages = req.messages ?? [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    { role: "user", content: req.user ?? "" },
  ];
  const body: Record<string, unknown> = { messages };
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.json) body.response_format = { type: "json_object" };
  if (req.aiOptions) Object.assign(body, req.aiOptions);
  return body;
}

// Extract a chat messages array if this request is OpenRouter-eligible.
function chatMessages(req: AvaReasonReq, body: Record<string, unknown>): Array<{ role: string; content: unknown }> | null {
  const m = (body.messages ?? req.messages) as Array<{ role: string; content: unknown }> | undefined;
  if (Array.isArray(m) && m.length) return m;
  if (req.system || req.user) {
    return [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.user ?? "" },
    ];
  }
  return null;
}

async function runOpenRouter(env: Env, key: string, model: string, req: AvaReasonReq, messages: Array<{ role: string; content: unknown }>): Promise<any> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: orHeaders(key),
    body: JSON.stringify({
      model,
      messages,
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${String(out?.error?.message ?? out?.error ?? "").slice(0, 160)}`);
  }
  return out;
}

async function emitTelemetry(env: Env, req: AvaReasonReq, model: string, ok: boolean, fallbackUsed: boolean, latencyMs: number): Promise<void> {
  // Analytics Engine (matches brain.ts / moderation.ts operational metrics).
  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: ["ava_reason_call", req.role, req.capability, req.trigger, req.opportunity ?? "", model, ok ? "ok" : "err", fallbackUsed ? "alt" : "primary"],
      doubles: [latencyMs, ok ? 1 : 0, fallbackUsed ? 1 : 0],
      indexes: ["ava_reason"],
    });
  } catch { /* metrics best-effort */ }
  // PostHog via the analytics queue (matches auto_reply.ts track()). uid carries the
  // person identity so events are pullable by the user's email.
  try {
    await env.Q_ANALYTICS?.send({
      event: "ava_reason_call",
      uid: req.uid,
      ts: Date.now(),
      props: {
        role: req.role, capability: req.capability, trigger: req.trigger,
        opportunity: req.opportunity ?? null, model, ok, fallback_used: fallbackUsed,
        latency_ms: latencyMs, app_name: "avatok", service_name: "avatok-consumers",
        worker: true, account_id: req.uid ?? null,
      },
    });
  } catch { /* best-effort */ }
}

/**
 * Route a single model call. Returns the raw provider output (unchanged shape);
 * throws only if BOTH the primary and the fallback/retry fail. Never swallows —
 * call sites keep their own try/catch so queue ack/retry behavior is unchanged.
 */
export async function avaReason(env: Env, req: AvaReasonReq): Promise<any> {
  // Required-tag guardrail (spec §2). Missing tags are a wiring bug.
  if (!req.role || !req.capability || !req.trigger) {
    const miss = `avaReason: missing required tag(s) role/capability/trigger (got role=${req.role} capability=${req.capability} trigger=${req.trigger})`;
    if ((env as any).DEV) throw new Error(miss);
    console.error(miss); // prod: log + still run (never break user flows this phase)
  }

  const model = req.model || (env as any).AVA_REASONER || DEFAULT_REASONER;
  const altModel = (env as any).AVA_REASONER_ALT || DEFAULT_ALT;
  const orKey = (env as any).OPENROUTER_API_KEY as string | undefined;
  const body = buildBody(req);
  const cacheK = req.cacheKey ? `gen:${req.cacheKey}` : null;

  // Optional KV response cache (dormant — no current consumer call site sets cacheKey).
  if (cacheK && env.TOKENS) {
    try {
      const hit = await env.TOKENS.get(cacheK);
      if (hit) return JSON.parse(hit);
    } catch { /* cache best-effort */ }
  }

  const started = Date.now();
  let fallbackUsed = false;
  let out: any;
  try {
    out = await env.AI.run(model as any, body as any);
  } catch (primaryErr) {
    const messages = chatMessages(req, body);
    const canOR = req.fallback !== false && !!orKey && !!messages;
    if (canOR) {
      // OpenRouter ALT fallback (chat-shaped only).
      out = await runOpenRouter(env, orKey!, altModel, req, messages!);
      fallbackUsed = true;
    } else {
      // No OpenRouter path → retry the primary ONCE, then propagate.
      try {
        out = await env.AI.run(model as any, body as any);
      } catch (retryErr) {
        await emitTelemetry(env, req, model, false, false, Date.now() - started);
        throw retryErr;
      }
    }
  }

  const latency = Date.now() - started;
  await emitTelemetry(env, req, fallbackUsed ? altModel : model, true, fallbackUsed, latency);
  if (req.bumpSpend) await bumpAiSpend(env, latency);

  if (cacheK && env.TOKENS) {
    try { await env.TOKENS.put(cacheK, JSON.stringify(out), { expirationTtl: 86_400 }); } catch { /* best-effort */ }
  }
  return out;
}
