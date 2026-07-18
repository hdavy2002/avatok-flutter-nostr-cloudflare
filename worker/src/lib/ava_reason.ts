// ava_reason.ts — WORKER SHIM over the shared AvaReason gateway (One Brain B1).
//
// The gateway itself now lives in ./ava_reason/ (core + policy + adapters) and is
// SHARED with the consumers package (consumers/src/ava_reason.ts imports the same
// core). This file is a thin, behaviour-preserving shim: it wires the worker's
// telemetry (PostHog track/trackUser) into the gateway and re-exports a
// backward-compatible `avaReason()` so all existing worker call sites — moderation,
// ava_gemini, ai_chat, ava_copilot — need no change (they still get `string`, or a
// `Response` for stream:true).
//
// MODEL SELECTION / BEHAVIOUR PRESERVATION are unchanged and now documented in
// ./ava_reason/policy.ts (reasoner ladder: Workers-AI @cf/google/gemma-4-26b-a4b-it
// primary → OpenRouter google/gemini-2.5-flash-lite ALT; `legacyModel` pins an exact
// OpenRouter model with no fallback). Verbs (reason/embed/transcribe/speak/see) route
// to per-provider adapters; today's callers all use the default `reason` verb.
//
// TELEMETRY: one converged `ava_reason_call` event per call (feature, verb, provider,
// model, tokens in/out, ms, cache_hit, fallback_used, error + the original role/
// capability/trigger/opportunity fields). The deprecated `avaapps_model_fallback`
// event is ALSO emitted on a fallback, so existing dashboards keep working.
import type { Env } from "../types";
import { track, trackUser } from "../hooks";
import { runReason } from "./ava_reason/core";
import type { ReasonReq, ReasonHost, ReasonCallEvent } from "./ava_reason/types";

export { reasonerModel, reasonerAltModel } from "./ava_reason/policy";
export type { ChatMessage } from "./ava_reason/types";

/** Backward-compatible request type (superset lives in ./ava_reason/types). */
export type AvaReasonReq = ReasonReq;

function eventProps(ev: ReasonCallEvent): Record<string, unknown> {
  return {
    // Original fields (unchanged — dashboards depending on these keep working).
    role: ev.role, capability: ev.capability, trigger: ev.trigger,
    opportunity: ev.opportunity, model: ev.model, ok: ev.ok,
    fallback_used: ev.fallback_used, latency_ms: ev.latency_ms,
    // Converged fields (SPEC §4 — absorbs avaapps_model_fallback).
    feature: ev.feature, verb: ev.verb, provider: ev.provider,
    cache_hit: ev.cache_hit, tokens_in: ev.tokens_in, tokens_out: ev.tokens_out,
    primary_model: ev.primary_model, error: ev.error,
  };
}

const host: ReasonHost = {
  emit(env, req, ev) {
    const props = eventProps(ev);
    const app = req.appName ?? "ava_core";
    try {
      if (req.email) void trackUser(env as any, req.uid ?? "", req.email, "ava_reason_call", app, props);
      else void track(env as any, req.uid ?? "", "ava_reason_call", app, props);
      // DEPRECATED: converged into ava_reason_call above; still emitted on a fallback
      // so the legacy avaapps_model_fallback dashboards do not go dark.
      if (ev.fallback_used) {
        const lp = { primary_model: ev.primary_model ?? ev.model, error: ev.error, deprecated: true };
        if (req.email) void trackUser(env as any, req.uid ?? "", req.email, "avaapps_model_fallback", app, lp);
        else void track(env as any, req.uid ?? "", "avaapps_model_fallback", app, lp);
      }
    } catch { /* telemetry best-effort */ }
  },
};

// Overloads: stream:true returns the raw OpenRouter Response; otherwise trimmed text.
export function avaReason(env: Env, req: AvaReasonReq & { stream: true }): Promise<Response>;
export function avaReason(env: Env, req: AvaReasonReq): Promise<string>;
export async function avaReason(env: Env, req: AvaReasonReq): Promise<string | Response> {
  const r = await runReason(env as any, req, host, "worker");
  if (r.response) return r.response;
  return r.text;
}

/**
 * RAW variant (One Brain B1 step 2b). Returns the UNSHAPED provider output — the
 * exact object `env.AI.run(...)` returned (audio bytes / base64, `{ text }`,
 * `{ data }` embeddings, LLaVA vision JSON, or a streaming `Response` when the
 * caller passes `aiRunOpts.returnRawResponse`). The `reason`-oriented `avaReason()`
 * above returns a trimmed string, which is wrong for the widened verbs
 * (embed/transcribe/speak/see) and the pinned `@cf` TTS/STT/vision/LLM sites that
 * were migrated off bare `env.AI.run`. Those pass their exact body as `req.raw`,
 * pin the model via `req.model`, and read the provider payload from here exactly as
 * they did from `env.AI.run`. Additive: the string/Response `avaReason()` is
 * unchanged, and this shares the same routing, telemetry, and kill-switch seam.
 */
export async function avaReasonRaw(env: Env, req: AvaReasonReq): Promise<any> {
  const r = await runReason(env as any, req, host, "worker");
  return r.raw;
}
