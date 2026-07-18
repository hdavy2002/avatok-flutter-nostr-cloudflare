// ava_reason/policy.ts — model selection per (verb, feature), env-overridable
// (SPEC §4). Produces a routing Plan that core.ts executes uniformly. The dialect
// argument reproduces the two packages' historical fallback/body semantics EXACTLY
// (worker: reasoner ladder + legacyModel pin; consumers: cf_ai primary + gated
// OpenRouter ALT + retry-primary-once). No live request changes shape or ladder.
import type { BodyOpts, Dialect, Plan, ReasonEnv, ReasonReq, Step, Verb } from "./types";

const DEFAULT_REASONER = "@cf/google/gemma-4-26b-a4b-it";
const DEFAULT_ALT = "google/gemini-2.5-flash-lite";

/** Default reasoner (Workers AI, env.AI) and ALT (OpenRouter) — overridable via [vars]. */
export function reasonerModel(env: ReasonEnv): string {
  return ((env as any).AVA_REASONER as string) || DEFAULT_REASONER;
}
export function reasonerAltModel(env: ReasonEnv): string {
  return ((env as any).AVA_REASONER_ALT as string) || DEFAULT_ALT;
}

// Body-shape presets (see types.BodyOpts). W = worker historical, C = consumers.
const CF_W: BodyOpts = { applyDefaults: true, allowRaw: false, allowJson: false, allowAiOptions: false };
const OR_W: BodyOpts = { applyDefaults: true, allowRaw: false, allowJson: true, allowAiOptions: false };
const CF_C: BodyOpts = { applyDefaults: false, allowRaw: true, allowJson: true, allowAiOptions: true };
const OR_C: BodyOpts = { applyDefaults: false, allowRaw: false, allowJson: true, allowAiOptions: false };

/** Streaming model (worker OpenRouter passthrough): legacyModel pin else ALT. */
export function streamModel(env: ReasonEnv, req: ReasonReq): string {
  return String(req.legacyModel ?? "").trim() || reasonerAltModel(env);
}

function step(provider: Step["provider"], model: string, body: BodyOpts): Step {
  return { provider, model, body };
}

/** Build the routing plan for a request. */
export function plan(env: ReasonEnv, req: ReasonReq, dialect: Dialect): Plan {
  const verb = req.verb ?? "reason";
  if (verb !== "reason") return verbPlan(env, req, verb);

  if (dialect === "worker") {
    const legacy = String(req.legacyModel ?? "").trim();
    if (legacy) {
      // Behaviour-preserving pin: single OpenRouter call, no ALT, no retry.
      return {
        verb, primary: step("openrouter", legacy, OR_W), alt: null,
        noFallback: true, retryPrimaryIfNoAlt: false, altRequiresKey: false, altChatOnly: false,
      };
    }
    // Reasoner ladder: Workers AI primary → OpenRouter ALT on error/429.
    return {
      verb,
      primary: step("cf_ai", reasonerModel(env), CF_W),
      alt: step("openrouter", reasonerAltModel(env), OR_W),
      noFallback: false, retryPrimaryIfNoAlt: false, altRequiresKey: false, altChatOnly: false,
    };
  }

  // consumers: cf_ai primary (req.model WINS over the reasoner default) → OpenRouter
  // ALT only when fallback !== false AND a key is present AND the request is chat-
  // shaped; otherwise retry the primary once, then throw.
  const model = req.model || (env as any).AVA_REASONER || DEFAULT_REASONER;
  const allowAlt = req.fallback !== false;
  return {
    verb,
    primary: step("cf_ai", model, CF_C),
    alt: allowAlt ? step("openrouter", reasonerAltModel(env), OR_C) : null,
    noFallback: false, retryPrimaryIfNoAlt: true, altRequiresKey: true, altChatOnly: true,
  };
}

/**
 * Non-`reason` verbs. Env-overridable, single-provider (no surprise cross-provider
 * fallback for a sense). No current call site uses these verbs, so they are dormant
 * routing targets for B2+; `model` still WINS when a caller pins one.
 */
function verbPlan(env: ReasonEnv, req: ReasonReq, verb: Verb): Plan {
  const e = env as any;
  let primary: Step;
  switch (verb) {
    case "embed":
      primary = step("cf_ai", req.model || e.BRAIN_EMBED_MODEL || "@cf/baai/bge-small-en-v1.5", CF_C);
      break;
    case "see":
      primary = step("cf_ai", req.model || e.BRAIN_VISION_MODEL || e.MODERATION_MODEL || DEFAULT_REASONER, CF_C);
      break;
    case "transcribe":
      primary = e.OPENAI_API_KEY
        ? step("openai", req.model || e.STT_MODEL || "whisper-1", CF_C)
        : step("cf_ai", req.model || e.STT_MODEL || "@cf/openai/whisper", CF_C);
      break;
    case "speak":
      primary = step("google", req.model || e.SPEAK_MODEL || "gemini-2.5-flash-preview-tts", CF_C);
      break;
    default:
      primary = step("cf_ai", req.model || reasonerModel(env), CF_C);
  }
  return {
    verb, primary, alt: null,
    noFallback: true, retryPrimaryIfNoAlt: false, altRequiresKey: false, altChatOnly: false,
  };
}
