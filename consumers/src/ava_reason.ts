// ava_reason.ts — CONSUMERS SHIM over the shared AvaReason gateway (One Brain B1).
//
// ┌── SHARING RULE (SPEC §4: "One shared module. Consumers import the same core.") ──┐
// │ The gateway (policy + routing + adapters) lives ONCE at                          │
// │   worker/src/lib/ava_reason/ (core.ts, policy.ts, types.ts, adapters/*)          │
// │ and is imported DIRECTLY from here via a relative cross-package path. wrangler's │
// │ esbuild bundler follows relative imports outside consumers/src (tsconfig         │
// │ `include` only scopes type-checking, not bundling), and the shared module is     │
// │ package-agnostic (structural env, no worker `Env`/`hooks` imports; the only      │
// │ package seam is the injected ReasonHost below). So there is ONE core, not two    │
// │ drifted copies — do NOT re-fork this file's logic into worker/consumers.         │
// └──────────────────────────────────────────────────────────────────────────────────┘
//
// This shim wires the consumers package's telemetry (Analytics Engine +
// Q_ANALYTICS) and the AI-spend counter into the gateway, and returns the RAW
// provider output unchanged — so every existing call site (brain.ts extract/vision,
// moderation.ts image/text scan, auto_reply.ts reply/urgency) keeps using
// aiText(out) / out.usage / parseClassifier(out) exactly as before.
import type { Env } from "./types";
import { bumpAiSpend } from "./ai";
import { runReason } from "../../worker/src/lib/ava_reason/core";
import type { ReasonReq, ReasonHost, ReasonCallEvent } from "../../worker/src/lib/ava_reason/types";

/** Backward-compatible request type (superset lives in the shared types module). */
export type AvaReasonReq = ReasonReq;

const host: ReasonHost = {
  emit(env, req, ev: ReasonCallEvent) {
    // Analytics Engine (matches brain.ts / moderation.ts operational metrics; the
    // original 8 blobs / 3 doubles are unchanged, verb/provider + tokens appended).
    try {
      (env as any).ANALYTICS?.writeDataPoint({
        blobs: ["ava_reason_call", ev.role, ev.capability, ev.trigger, ev.opportunity ?? "", ev.model, ev.ok ? "ok" : "err", ev.fallback_used ? "alt" : "primary", ev.verb, ev.provider],
        doubles: [ev.latency_ms, ev.ok ? 1 : 0, ev.fallback_used ? 1 : 0, ev.tokens_in ?? 0, ev.tokens_out ?? 0],
        indexes: ["ava_reason"],
      });
    } catch { /* metrics best-effort */ }
    // PostHog via the analytics queue (matches auto_reply.ts track()).
    try {
      void (env as any).Q_ANALYTICS?.send({
        event: "ava_reason_call", uid: req.uid, ts: Date.now(),
        props: {
          role: ev.role, capability: ev.capability, trigger: ev.trigger,
          opportunity: ev.opportunity, model: ev.model, ok: ev.ok,
          fallback_used: ev.fallback_used, latency_ms: ev.latency_ms,
          feature: ev.feature, verb: ev.verb, provider: ev.provider,
          cache_hit: ev.cache_hit, tokens_in: ev.tokens_in, tokens_out: ev.tokens_out,
          primary_model: ev.primary_model, error: ev.error,
          app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: req.uid ?? null,
        },
      });
      // DEPRECATED: converged into ava_reason_call; still emitted on a fallback so the
      // legacy avaapps_model_fallback dashboards do not go dark.
      if (ev.fallback_used) {
        void (env as any).Q_ANALYTICS?.send({
          event: "avaapps_model_fallback", uid: req.uid, ts: Date.now(),
          props: { primary_model: ev.primary_model ?? ev.model, error: ev.error, deprecated: true, app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: req.uid ?? null },
        });
      }
    } catch { /* best-effort */ }
  },
  bumpSpend(env, ms) { return bumpAiSpend(env as any, ms); },
};

/**
 * Route a single model call. Returns the RAW provider output (unchanged shape);
 * throws only when every eligible attempt fails — call sites keep their own
 * try/catch so queue ack/retry behaviour is unchanged.
 */
export async function avaReason(env: Env, req: AvaReasonReq): Promise<any> {
  const r = await runReason(env as any, req, host, "consumers");
  return r.raw;
}
