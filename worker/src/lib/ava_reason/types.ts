// ava_reason/types.ts — the ONE shared, package-agnostic contract for the AvaReason
// gateway (One Brain B1, SPEC §4). This file (and everything under ava_reason/) is
// imported by BOTH the worker package (via ../ava_reason.ts) and the consumers
// package (via ../../worker/src/lib/ava_reason/*). It therefore MUST NOT import any
// package-specific module (no worker `../../types`, no `../hooks`, no consumers
// `./ai`). Only structural types + pure helpers live here so the bundler in either
// package can pull it in cleanly.
//
// The gateway is policy + routing only (see core.ts / policy.ts). Everything
// provider-shaped lives in adapters/. Verbs are routing keys, not code paths.

// ── Verbs & providers ───────────────────────────────────────────────────────

/** A verb is a routing key (SPEC §4), NOT a separate code path in core. */
export type Verb = "reason" | "embed" | "transcribe" | "speak" | "see";

/** One adapter per provider. `reason` today only ever routes to cf_ai/openrouter. */
export type Provider = "openrouter" | "cf_ai" | "google" | "openai" | "xai";

/** Which package is calling — selects the fallback/body dialect (see policy.ts). */
export type Dialect = "worker" | "consumers";

export type ChatMessage = { role: string; content: unknown };

/**
 * Structural env — deliberately loose. Both packages have DIFFERENT concrete `Env`
 * types; the gateway only touches these bindings/vars and casts through `any`, so a
 * minimal structural shape keeps the module portable without importing either Env.
 */
export interface ReasonEnv {
  AI?: any;
  TOKENS?: any;
  OPENROUTER_API_KEY?: string;
  [k: string]: any;
}

// ── The request ─────────────────────────────────────────────────────────────

/**
 * Superset of the worker's and consumers' historical `AvaReasonReq`. Every field
 * either package ever passed is here so the shims can alias `AvaReasonReq = ReasonReq`
 * and no call site needs to change.
 */
export interface ReasonReq {
  // REQUIRED capability/intent tags (governance + telemetry).
  role: string;
  capability: string;
  trigger: string;
  opportunity?: string;

  // Routing.
  verb?: Verb;            // default "reason"
  feature?: string;      // policy lookup key; defaults to capability, then role

  // Prompt: EITHER a full messages array OR a system+user pair.
  system?: string;
  user?: string;
  messages?: ChatMessage[];

  // Generation params.
  maxTokens?: number;
  temperature?: number;
  json?: boolean;        // strict JSON output (response_format)
  timeoutMs?: number;    // worker capability: abort the provider fetch

  // Provider/model overrides.
  model?: string;        // consumers: explicit model; WINS over the reasoner default
  legacyModel?: string;  // worker: pin exact OpenRouter model — single call, no fallback

  // Non-chat / provider-specific shapes.
  raw?: Record<string, unknown>;        // full Workers-AI body (classifier/vision)
  aiOptions?: Record<string, unknown>;  // extra Workers-AI run params merged into body
  aiRunOpts?: any;       // AI Gateway opts (see ai_gate.aiRunOpts) — passed to env.AI.run
  input?: unknown;       // verb payload (embed text / audio bytes / etc.)

  // Google/Gemini-direct extras (One Brain B1 `gemini_direct` route — additive).
  // `generationConfig` is a Gemini `generationConfig` fragment merged verbatim into
  // the body (responseMimeType, static thinkingConfig, topP, …) — the "generationConfig
  // extras via a request field" seam. `geminiThinkingOff` is the PER-MODEL latency
  // mechanism: the google adapter derives thinking-off from the model name
  // (gemini-3 → thinkingLevel "low", gemini-2.x → thinkingBudget 0 — the two must
  // never be mixed or Google 400s), so a two-model ladder gets the right config for
  // EACH rung. A static `generationConfig.thinkingConfig` cannot do that.
  generationConfig?: Record<string, unknown>;
  geminiThinkingOff?: boolean;

  // Control.
  fallback?: boolean;    // consumers: allow the OpenRouter ALT fallback (default true)
  stream?: boolean;      // worker: OpenRouter streaming passthrough (returns Response)
  bumpSpend?: boolean;   // consumers: record the AI spend counter itself

  // Optional KV response cache (namespaced gen:<cacheKey> in env.TOKENS).
  cacheKey?: string;
  cacheTtl?: number;     // seconds; default 24h

  // Telemetry identity (best-effort; stamped when present).
  uid?: string;
  email?: string | null;
  appName?: string;      // PostHog app_name; defaults to "ava_core"
}

// ── Body-shape options (per provider × dialect) ─────────────────────────────
// The worker and consumers historical helpers built request bodies DIFFERENTLY
// (worker applied 400/0.3 defaults and ignored raw/aiOptions; consumers set params
// only when present and honoured raw/aiOptions). These flags reproduce each exactly
// so no live request changes shape. policy.ts attaches the right set per step.

export interface BodyOpts {
  applyDefaults: boolean;   // max_tokens ?? 400, temperature ?? 0.3 (worker style)
  allowRaw: boolean;        // honour req.raw as a full body
  allowJson: boolean;       // add response_format when req.json
  allowAiOptions: boolean;  // Object.assign req.aiOptions
}

// ── Routing plan ────────────────────────────────────────────────────────────

export interface Step {
  provider: Provider;
  model: string;
  body: BodyOpts;
  /** google: same-provider model ladder (primary → alt on empty text), tried
   *  IN-ADAPTER (not via core's exception-driven alt). Set by policy for the
   *  `gemini_direct` route; when present the google adapter iterates it and returns
   *  the first non-empty answer, soft-failing to "" if every rung comes back empty
   *  or errors — reproducing util.geminiRun's historical swallow. */
  models?: string[];
}

export interface Plan {
  verb: Verb;
  primary: Step;
  alt: Step | null;
  /** legacy pin / forced single call — no fallback, no retry. */
  noFallback: boolean;
  /** consumers: if no eligible ALT, retry the primary once before throwing. */
  retryPrimaryIfNoAlt: boolean;
  /** consumers: the ALT (OpenRouter) is only eligible when an API key is present. */
  altRequiresKey: boolean;
  /** consumers: the ALT is only eligible for chat-shaped requests. */
  altChatOnly: boolean;
}

// ── Adapter contract ────────────────────────────────────────────────────────

export interface AdapterCtx {
  model: string;
  models?: string[];   // same-provider ladder (google); see Step.models
  req: ReasonReq;
  body: BodyOpts;
  aiRunOpts?: any;
  title?: string;   // OpenRouter X-Title (per-dialect label)
}

export interface AdapterOut {
  raw: any;
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** Every adapter exports `run(env, ctx)`. openrouter additionally exports `stream`. */
export interface ReasonAdapter {
  run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut>;
}

// ── Telemetry ───────────────────────────────────────────────────────────────

/**
 * The ONE converged event (SPEC §4). Absorbs the fields of the deprecated
 * `avaapps_model_fallback` (primary_model + error) so both schemas converge; the
 * shims still emit the legacy event too, where it fired before, marked deprecated.
 */
export interface ReasonCallEvent {
  role: string;
  capability: string;
  trigger: string;
  opportunity: string | null;
  feature: string;
  verb: Verb;
  provider: Provider;
  model: string;
  primary_model: string | null;  // the failed primary when fallback_used
  ok: boolean;
  fallback_used: boolean;
  cache_hit: boolean;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
}

/**
 * The host is the ONE package-specific seam. The worker shim routes emit()
 * through PostHog (track/trackUser); the consumers shim routes it through
 * Analytics Engine + the analytics queue; consumers also provides bumpSpend.
 */
export interface ReasonHost {
  emit(env: ReasonEnv, req: ReasonReq, ev: ReasonCallEvent): void;
  bumpSpend?(env: ReasonEnv, ms: number): Promise<void> | void;
}

export interface ReasonResult {
  text: string;
  raw: any;
  response?: Response;   // set only for stream:true (worker OpenRouter passthrough)
  model: string;
  provider: Provider;
  verb: Verb;
  ok: boolean;
  fallbackUsed: boolean;
  cacheHit: boolean;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
}

// ── Pure helpers (shared by core + adapters) ────────────────────────────────

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function hasOrKey(env: ReasonEnv): boolean {
  return !!(env as any).OPENROUTER_API_KEY;
}

/** A request is "chat-shaped" (OpenRouter-eligible) when it carries messages or a
 *  system/user pair — i.e. NOT a bare `raw` classifier/vision body. */
export function isChatShaped(req: ReasonReq): boolean {
  if (Array.isArray(req.messages) && req.messages.length) return true;
  if (req.raw) {
    const m = (req.raw as any).messages;
    return Array.isArray(m) && m.length > 0;
  }
  return !!(req.system || req.user);
}

export function buildChatMessages(req: ReasonReq): ChatMessage[] {
  if (req.messages && req.messages.length) return req.messages;
  const out: ChatMessage[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  out.push({ role: "user", content: req.user ?? "" });
  return out;
}

/** Build a chat body honouring the per-step BodyOpts (reproduces worker/consumers). */
export function buildChatBody(req: ReasonReq, opts: BodyOpts): Record<string, unknown> {
  if (opts.allowRaw && req.raw) return { ...req.raw };
  const body: Record<string, unknown> = { messages: buildChatMessages(req) };
  if (opts.applyDefaults) {
    body.max_tokens = req.maxTokens ?? 400;
    body.temperature = req.temperature ?? 0.3;
  } else {
    if (req.maxTokens != null) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;
  }
  if (opts.allowJson && req.json) body.response_format = { type: "json_object" };
  if (opts.allowAiOptions && req.aiOptions) Object.assign(body, req.aiOptions);
  return body;
}

/** Workers-AI text extraction — EXACTLY the worker's historical workersAiCall shape
 *  (`response` only). Do NOT widen to choices here: the worker reason path returned
 *  "" for choices-style output before, and changing that would alter behaviour. */
export function cfText(out: any): string {
  return String(out?.response ?? out?.result?.response ?? "").trim();
}

/** OpenRouter text extraction (choices[0].message.content). */
export function orText(out: any): string {
  return String(out?.choices?.[0]?.message?.content ?? "").trim();
}

/** Best-effort {prompt,completion} token counts from either provider shape. */
export function usageTokens(out: any): [number | null, number | null] {
  const u = out?.usage ?? out?.result?.usage;
  if (!u) return [null, null];
  const tin = u.prompt_tokens ?? u.input_tokens ?? null;
  const tout = u.completion_tokens ?? u.output_tokens ?? null;
  return [tin ?? null, tout ?? null];
}
