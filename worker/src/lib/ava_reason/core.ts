// ava_reason/core.ts — the gateway (One Brain B1, SPEC §4). POLICY + ROUTING ONLY,
// deliberately small: kill-switch/consent hook → policy lookup → budget/token caps
// → adapter dispatch → telemetry emit → KV cache. Everything provider-shaped lives
// in adapters/. Verbs are routing keys, not code paths. Stays under ~400 lines
// (god-module tripwire); anything provider-specific that creeps in moves to an adapter.
//
// This module is SHARED by both packages. It never imports a package-specific module:
// the package seam is the injected `ReasonHost` (telemetry + spend) and `Dialect`.
// The worker shim (../ava_reason.ts) returns result.text/response; the consumers
// shim (../../worker/src/lib/ava_reason/core via consumers/src/ava_reason.ts) returns
// result.raw — so both packages' existing call sites keep their exact contracts.
import type {
  AdapterCtx, AdapterOut, Dialect, Plan, ReasonCallEvent, ReasonEnv,
  ReasonHost, ReasonReq, ReasonResult, Step,
} from "./types";
import { hasOrKey, isChatShaped } from "./types";
import { plan as buildPlan, streamModel } from "./policy";
import * as openrouter from "./adapters/openrouter";
import * as cf_ai from "./adapters/cf_ai";
import * as google from "./adapters/google";
import * as openai from "./adapters/openai";
import * as xai from "./adapters/xai";

const ADAPTERS: Record<Step["provider"], { run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> }> = {
  openrouter, cf_ai, google, openai, xai,
};

const OR_TITLE: Record<Dialect, string> = {
  worker: "AvaTOK avaReason",
  consumers: "AvaTOK consumers avaReason",
};

/** Validate the required capability tags. Dev → throw; prod → console.error + continue. */
function checkTags(env: ReasonEnv, req: ReasonReq): void {
  const missing = (["role", "capability", "trigger"] as const).filter((k) => !String((req as any)[k] ?? "").trim());
  if (!missing.length) return;
  const msg = `avaReason: missing required tag(s): ${missing.join(", ")}`;
  if ((env as any).DEV) throw new Error(msg);
  console.error(msg); // prod: never break the user flow
}

/**
 * OPTIONAL kill-switch / consent gate. Off by default so the existing 14 call sites
 * behave IDENTICALLY (the historical avaReason performed no such check, and Guardian
 * MUST bypass — Constitution law 12). A host may pass `env.__reasonKillSwitch` as a
 * boolean to hard-disable, or a caller-side gate stays where it is. Wired here as the
 * SPEC §4 seam without changing today's behaviour. Returns an error string when blocked.
 */
function killSwitchBlocked(env: ReasonEnv, _req: ReasonReq): string | null {
  const ks = (env as any).__reasonKillSwitch;
  return ks === true ? "reason_disabled" : null;
}

function mkEvent(
  req: ReasonReq, provider: Step["provider"], model: string,
  info: { ok: boolean; fallback_used: boolean; cache_hit: boolean; latency_ms: number;
    tokens_in: number | null; tokens_out: number | null; error: string | null; primary_model?: string | null },
): ReasonCallEvent {
  return {
    role: req.role, capability: req.capability, trigger: req.trigger,
    opportunity: req.opportunity ?? null,
    feature: req.feature || req.capability || req.role,
    verb: req.verb ?? "reason",
    provider, model, primary_model: info.primary_model ?? null,
    ok: info.ok, fallback_used: info.fallback_used, cache_hit: info.cache_hit,
    latency_ms: info.latency_ms, tokens_in: info.tokens_in, tokens_out: info.tokens_out,
    error: info.error,
  };
}

function runStep(env: ReasonEnv, s: Step, req: ReasonReq, dialect: Dialect): Promise<AdapterOut> {
  return ADAPTERS[s.provider].run(env, {
    model: s.model, models: s.models, req, body: s.body, aiRunOpts: req.aiRunOpts, title: OR_TITLE[dialect],
  });
}

async function cacheGet(env: ReasonEnv, key: string | null): Promise<{ text: string; raw: any } | null> {
  if (!key) return null;
  try {
    const hit = await (env as any).TOKENS?.get(key);
    if (typeof hit !== "string" || !hit.length) return null;
    try { const p = JSON.parse(hit); return { text: String(p.text ?? ""), raw: p.raw }; }
    catch { return { text: hit, raw: hit }; } // legacy plain-text cache tolerated
  } catch { return null; }
}

async function cachePut(env: ReasonEnv, key: string | null, out: AdapterOut, ttl?: number): Promise<void> {
  if (!key) return;
  try {
    await (env as any).TOKENS?.put(key, JSON.stringify({ text: out.text, raw: out.raw }), { expirationTtl: ttl ?? 86400 });
  } catch { /* best-effort */ }
}

/**
 * The ONE gateway entry. Returns a structured ReasonResult; the package shims adapt
 * it to their historical return type. Throws (propagating the last provider error)
 * only when every eligible attempt fails — preserving each call site's try/catch.
 */
export async function runReason(env: ReasonEnv, req: ReasonReq, host: ReasonHost, dialect: Dialect): Promise<ReasonResult> {
  checkTags(env, req);

  // SPEC §4 kill-switch/consent seam (no-op by default; preserves today's behaviour).
  const blocked = killSwitchBlocked(env, req);
  if (blocked) {
    host.emit(env, req, mkEvent(req, "cf_ai", "", { ok: false, fallback_used: false, cache_hit: false, latency_ms: 0, tokens_in: null, tokens_out: null, error: blocked }));
    throw new Error(`avaReason: ${blocked}`);
  }

  // Streaming passthrough (OpenRouter-only, worker). Returns the raw Response so the
  // caller drives its own SSE plumbing — we do not buffer or transform tokens.
  if (req.stream) {
    const model = streamModel(env, req);
    const res = await openrouter.stream(env, {
      model, req,
      body: { applyDefaults: true, allowRaw: false, allowJson: true, allowAiOptions: false },
      title: OR_TITLE[dialect],
    });
    host.emit(env, req, mkEvent(req, "openrouter", model, { ok: res.ok, fallback_used: false, cache_hit: false, latency_ms: 0, tokens_in: null, tokens_out: null, error: res.ok ? null : `http ${res.status}` }));
    return { text: "", raw: null, response: res, model, provider: "openrouter", verb: req.verb ?? "reason", ok: res.ok, fallbackUsed: false, cacheHit: false, latencyMs: 0, tokensIn: null, tokensOut: null, error: res.ok ? null : `http ${res.status}` };
  }

  const cacheKey = req.cacheKey ? `gen:${req.cacheKey}` : null;
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    const p0 = buildPlan(env, req, dialect);
    host.emit(env, req, mkEvent(req, p0.primary.provider, p0.primary.model, { ok: true, fallback_used: false, cache_hit: true, latency_ms: 0, tokens_in: null, tokens_out: null, error: null }));
    return { text: cached.text, raw: cached.raw, model: p0.primary.model, provider: p0.primary.provider, verb: p0.verb, ok: true, fallbackUsed: false, cacheHit: true, latencyMs: 0, tokensIn: null, tokensOut: null, error: null };
  }

  const p = buildPlan(env, req, dialect);
  const t0 = Date.now();

  const finish = (out: AdapterOut, s: Step, fb: boolean): Promise<ReasonResult> => {
    const latency = Date.now() - t0;
    host.emit(env, req, mkEvent(req, s.provider, s.model, {
      ok: true, fallback_used: fb, cache_hit: false, latency_ms: latency,
      tokens_in: out.tokensIn ?? null, tokens_out: out.tokensOut ?? null, error: null,
      primary_model: fb ? p.primary.model : null,
    }));
    return (async () => {
      if (req.bumpSpend && host.bumpSpend) { try { await host.bumpSpend(env, latency); } catch { /* best-effort */ } }
      await cachePut(env, cacheKey, out, req.cacheTtl);
      return { text: out.text, raw: out.raw, model: s.model, provider: s.provider, verb: p.verb, ok: true, fallbackUsed: fb, cacheHit: false, latencyMs: latency, tokensIn: out.tokensIn ?? null, tokensOut: out.tokensOut ?? null, error: null };
    })();
  };

  const emitErr = (s: Step, e: unknown, fb: boolean): void => {
    host.emit(env, req, mkEvent(req, s.provider, s.model, {
      ok: false, fallback_used: fb, cache_hit: false, latency_ms: Date.now() - t0,
      tokens_in: null, tokens_out: null, error: String((e as any)?.message ?? e).slice(0, 200),
      primary_model: fb ? p.primary.model : null,
    }));
  };

  try {
    const out = await runStep(env, p.primary, req, dialect);
    return await finish(out, p.primary, false);
  } catch (e1) {
    if (p.noFallback) { emitErr(p.primary, e1, false); throw e1; }
    const altOk = !!p.alt && (!p.altRequiresKey || hasOrKey(env)) && (!p.altChatOnly || isChatShaped(req));
    if (altOk && p.alt) {
      try {
        const out = await runStep(env, p.alt, req, dialect);
        return await finish(out, p.alt, true);
      } catch (e2) { emitErr(p.alt, e2, true); throw e2; }
    }
    if (p.retryPrimaryIfNoAlt) {
      try {
        const out = await runStep(env, p.primary, req, dialect);
        return await finish(out, p.primary, false);
      } catch (e3) { emitErr(p.primary, e3, false); throw e3; }
    }
    emitErr(p.primary, e1, false);
    throw e1;
  }
}
