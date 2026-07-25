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

// ── Additive feature-model overrides (One Brain B1 fetch migration) ───────────
// Env-overridable model ids for feature paths that are NOT chat/vision-shaped and
// therefore do not dispatch through an adapter/verb (e.g. the OpenRouter *image*
// generation endpoint). Kept here so "which model does feature X use" has ONE home
// and is flippable via [vars] without a code deploy. Additive only — no existing
// routing changes shape.
const DEFAULT_IMAGE_MODEL = "x-ai/grok-imagine-image-quality";

/** OpenRouter image-generation model for ava_image (env override → default). */
export function imageModel(env: ReasonEnv): string {
  return ((env as any).OPENROUTER_IMAGE_MODEL as string) || DEFAULT_IMAGE_MODEL;
}

// ── gemini_direct feature route (One Brain B1 Gemini-direct migration) ─────────
// Direct Google Gemini via the generativelanguage REST API — the path util.geminiRun
// and the genui_planner Gemini fallback used to hit with a raw fetch. Same-provider
// two-model ladder: primary gemini-3-flash-preview → alt gemini-2.5-flash-lite (both
// env-overridable). gemini-3-flash-preview is NOT a valid Workers-AI partner id
// (7003), so this stays on the direct API rather than the cf_ai reasoner ladder.
const DEFAULT_GEMINI_DIRECT = "gemini-3-flash-preview";
const DEFAULT_GEMINI_DIRECT_ALT = "gemini-2.5-flash-lite";

/** gemini_direct primary model (env override → default). */
export function geminiDirectModel(env: ReasonEnv): string {
  return ((env as any).GEMINI_DIRECT_MODEL as string) || DEFAULT_GEMINI_DIRECT;
}
/** gemini_direct ALT model — the same-provider ladder's second rung. */
export function geminiDirectAltModel(env: ReasonEnv): string {
  return ((env as any).GEMINI_DIRECT_ALT_MODEL as string) || DEFAULT_GEMINI_DIRECT_ALT;
}

// ── [AVA-DOC-ARTIFACT-1 / AVA-AUDIO-ARTIFACT-1] Media-job capability models ──
// Pinned model ids + latency profiles for the ai_media_jobs queue's document
// and audio capabilities (Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md
// §46: "pin model ids and latency profiles here; do not scatter model strings
// through routes"). worker/src/queues/ai_media.ts and worker/src/routes/
// ava_copilot.ts / stt.ts call these — no capability below hardcodes a model
// id of its own.
const DEFAULT_MEDIA_TEXT_MODEL = "mistralai/mistral-nemo"; // catalogued in ai_billing.ts's AI_PRICE_CATALOG
const DEFAULT_AUDIO_TRANSCRIBE_MODEL = "openai/whisper-large-v3"; // billed per-audio-second, not per token — see AI_PRICE_CATALOG
const DEFAULT_IMAGE_UNDERSTANDING_MODEL = "google/gemma-3-12b-it"; // vision-capable, catalogued

/** mistral-nemo — doc_summarize/doc_translate/the audio_translate transcript-
 *  translation sub-step. Env-overridable via AVA_MEDIA_TEXT_MODEL. */
export function mediaTextModel(env: ReasonEnv): string {
  return ((env as any).AVA_MEDIA_TEXT_MODEL as string) || DEFAULT_MEDIA_TEXT_MODEL;
}
export function docSummarizeModel(env: ReasonEnv): string { return mediaTextModel(env); }
export function docTranslateModel(env: ReasonEnv): string { return mediaTextModel(env); }
export function audioTranslateTextModel(env: ReasonEnv): string { return mediaTextModel(env); }

/** openai/whisper-large-v3 — the default multilingual STT model (worker/src/
 *  routes/stt.ts). Env-overridable via OPENROUTER_STT_MODEL (existing var). */
export function audioTranscribeModel(env: ReasonEnv): string {
  return ((env as any).OPENROUTER_STT_MODEL as string) || DEFAULT_AUDIO_TRANSCRIBE_MODEL;
}

/** Vision-capable model reserved for a future image_understanding capability
 *  (not wired to a call site by [AVA-DOC-ARTIFACT-1]/[AVA-AUDIO-ARTIFACT-1] —
 *  pinned here per §46 so whoever builds it doesn't hardcode a model string
 *  in a route). Env-overridable via AVA_IMAGE_UNDERSTANDING_MODEL. */
export function imageUnderstandingModel(env: ReasonEnv): string {
  return ((env as any).AVA_IMAGE_UNDERSTANDING_MODEL as string) || DEFAULT_IMAGE_UNDERSTANDING_MODEL;
}

/** Rough p95 latency budget per media-job capability, ms — informational (not
 *  yet enforced anywhere); a future per-job deadline/ETA can read this instead
 *  of a second hardcoded table. */
export const MEDIA_LATENCY_PROFILE_MS: Record<string, number> = {
  audio_transcribe: 15_000,
  audio_translate: 30_000,
  doc_summarize: 12_000,
  doc_translate: 25_000,
  image_understanding: 8_000,
};

// [AVA-DOC-ARTIFACT-1 / AVA-AUDIO-ARTIFACT-1] `feature` routing for the media-
// job text capabilities above. A PRIOR attempt at this routing (parked on
// wave3-media-ux-parked, blocked in review) pinned mistral-nemo via
// req.legacyModel — the worker dialect's "legacy pin" branch below forces
// noFallback:true (single call, no ALT), which review flagged as removing the
// graceful cf_ai/OpenRouter degradation every OTHER reasoner-ladder call site
// gets: a mistral-nemo/OpenRouter blip would fail the entire media job outright
// instead of degrading. This feature branch keeps the SAME pinned primary model
// but gives it a real ALT via core.ts's EXISTING primary->alt fallback (no
// adapter change needed — see runReason() in ./core.ts), so a mistral-nemo
// outage degrades to the reasoner ALT instead of failing the job.
const MEDIA_TEXT_FEATURES = new Set(["media_doc_summarize", "media_doc_translate", "media_audio_translate"]);

function step(provider: Step["provider"], model: string, body: BodyOpts): Step {
  return { provider, model, body };
}

/** Build the routing plan for a request. */
export function plan(env: ReasonEnv, req: ReasonReq, dialect: Dialect): Plan {
  const verb = req.verb ?? "reason";

  // ADDITIVE (One Brain B1 step 2b): a caller that PINS a Workers-AI model
  // (`@cf/…`) routes straight to cf_ai — no ladder, no ALT, no retry — so it is
  // byte-identical to a bare `env.AI.run(model, body)` for that exact model,
  // gaining only aiRunOpts (AI Gateway cost logging) + unified telemetry. This is
  // how the migrated TTS/STT/embed/vision sites and the pinned `@cf` reception
  // LLM call reach cf_ai regardless of verb (e.g. `transcribe` would otherwise
  // prefer the OpenAI adapter, `speak` the Google adapter). SAFE: no existing
  // avaReason() caller pins an `@cf` model — the reasoner default `@cf/…` is
  // applied only when `req.model` is ABSENT — so the reasoner ladder and the
  // dormant verb routes below are untouched. CF_C honours `req.raw` as the full
  // body, reproducing the original call byte-for-byte.
  const pinnedCf = String(req.model ?? "").trim();
  if (pinnedCf.startsWith("@cf/")) {
    return {
      verb, primary: step("cf_ai", pinnedCf, CF_C), alt: null,
      noFallback: true, retryPrimaryIfNoAlt: false, altRequiresKey: false, altChatOnly: false,
    };
  }

  // One Brain B1: `gemini_direct` feature → direct Google Gemini (systemInstruction
  // + per-model thinking-off + same-provider ladder), replacing util.geminiRun and
  // the genui_planner Gemini fallback's raw generativelanguage fetches. A caller that
  // PINS req.model (genui fallback: gemini-2.5-flash) gets a SINGLE google call with
  // that model; otherwise the two-model ladder (gemini-3-flash-preview → gemini-2.5-
  // flash-lite) that geminiRun used. The ladder + empty-text fallthrough + soft "" on
  // total failure all live IN the google adapter (Step.models), so core dispatches ONE
  // step and never throws for this route. Takes precedence over verb routing.
  if (req.feature === "gemini_direct") {
    const pinned = String(req.model ?? "").trim();
    const primaryModel = pinned || geminiDirectModel(env);
    const models = pinned ? [primaryModel] : [primaryModel, geminiDirectAltModel(env)];
    return {
      verb,
      primary: { provider: "google", model: primaryModel, body: CF_C, models },
      alt: null,
      noFallback: true, retryPrimaryIfNoAlt: false, altRequiresKey: false, altChatOnly: false,
    };
  }

  // [AVA-DOC-ARTIFACT-1 / AVA-AUDIO-ARTIFACT-1] media-job text capabilities —
  // see MEDIA_TEXT_FEATURES's doc comment above. Checked before the
  // dialect/verb branches below since it applies regardless of legacyModel
  // (the job consumer never sets one).
  if (MEDIA_TEXT_FEATURES.has(String(req.feature ?? ""))) {
    return {
      verb,
      primary: step("openrouter", mediaTextModel(env), OR_W),
      alt: step("openrouter", reasonerAltModel(env), OR_W),
      noFallback: false, retryPrimaryIfNoAlt: false, altRequiresKey: false, altChatOnly: false,
    };
  }

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
