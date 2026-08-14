// [VENICE-VID-1 / VENICE-MUS-1] In-thread Venice AI video/music generation —
// Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md. THE entry points
// (runVeniceVideo/runVeniceMusic) are called from do/ava_agent.ts's onVideo/
// onMusic callbacks (mirrors runAvaImage's role for onImage, routes/ava_image.ts),
// which lib/composio.ts's runAgentLoop invokes when the model calls the
// generate_video/generate_music tools.
//
// SHAPE, and why it differs from routes/ava_image.ts's fully-detached fulfil():
// image generation is ONE synchronous provider call (10-25s) that the route
// detaches behind ctx.waitUntil/DurableObjectState.waitUntil. Venice video/
// music are asynchronous at the PROVIDER level too (POST /video|audio/queue
// returns a queue id in well under a second; the actual generation is minutes
// later, discovered only by polling /video|audio/retrieve). So the split here
// is different: job-create + moderate + the fast "submit to Venice's queue"
// call all run INLINE, synchronously, within the agent tool-call turn (a few
// hundred ms — same budget an app-connector tool call already costs); only
// the multi-minute wait is pushed onto the async queue consumer
// (worker/src/queues/venice_media.ts), which re-polls itself with backoff
// until Venice reports done or the job's deadline passes. No detach/
// keepAlive plumbing is needed here as a result — unlike image generation,
// nothing long-running happens inside this module's own call stack.
//
// PRIVACY (§41/§42): the prompt is used ONLY inline here, to call Venice's
// queue endpoint once — it is never written to venice_media_jobs (see that
// file's header). Only the returned Venice queue id is persisted.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { moderate } from "./moderation";
import {
  veniceRoute, veniceQueueVideo, veniceQueueMusic, clampMusicSeconds,
  type VeniceIntent, type VeniceTier,
} from "./venice";
import {
  createVeniceMediaJob, attachVeniceQueueId, failVeniceMediaJob,
} from "./venice_media_jobs";
import { enqueueVeniceMediaPoll } from "../queues/venice_media";
import { track } from "../hooks";
import { emailFor } from "./identity";
import { avaString, readVoiceStyle, type AvaVoiceStyle } from "./ava_persona";

const VIDEO_DEADLINE_MS = 10 * 60_000; // ~10 min hard ceiling, per the work order
const MUSIC_DEADLINE_MS = 5 * 60_000;  // ~5 min hard ceiling
const INITIAL_POLL_DELAY_S = 10;       // first poll fires ~10s after submit — Venice's queue is never instant

export interface RunVeniceMediaResult {
  ok: boolean;
  blocked?: boolean;
  message: string;
  job_id?: string | null;
}

// ---------------------------------------------------------------------------
// VIDEO
// ---------------------------------------------------------------------------
export interface RunVeniceVideoArgs {
  uid: string;
  conv: string;
  prompt: string;
  /** Public URL (or base64 data: URL) of an existing image to animate —
   *  presence alone selects video_i2v over video_t2v (veniceRoute). */
  sourceImageUrl?: string;
  private: boolean;
  /** [VENICE-TIER-1] Caller-supplied — do/ava_agent.ts's onVideo closure
   *  resolves this via lib/venice_tier.ts's veniceTier(env, uid) before
   *  calling in. */
  tier: VeniceTier;
}

export async function runVeniceVideo(env: Env, a: RunVeniceVideoArgs): Promise<RunVeniceMediaResult> {
  const prompt = String(a.prompt ?? "").trim();
  if (!prompt) return { ok: false, message: "Tell me what video to create." };
  if (prompt.length > 2000) return { ok: false, message: "That prompt is too long." };

  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return { ok: false, message: "Ava is currently turned off." };
  // Reuses the SAME kill switch as the Venice image path (routes/ava_image.ts's
  // generateImageVenice, [VENICE-IMG-1]) rather than inventing a second one —
  // Venice video/music are not live until that flag is, by design (one switch
  // for "is Venice media live", per Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md).
  if (cfg.veniceMediaEnabled !== true) {
    return { ok: false, message: "Video generation is currently turned off." };
  }

  const email = await emailFor(env, a.uid).catch(() => null);

  // ── PROMPT GATE (mandatory, before any reservation/provider call) ────────
  const verdict = await moderate(env, { text: prompt, field: "venice_video_prompt" });
  if (!verdict.safe) {
    void track(env, a.uid, "venice_nsfw_blocked", "avaai", {
      stage: "prompt", media: "video", reason: verdict.reason, categories: verdict.categories, provider: "venice",
    });
    return { ok: false, blocked: true, message: verdict.reason || "I can't create that video. Let's keep things safe — try a different idea." };
  }

  const intent: VeniceIntent = a.sourceImageUrl ? "video_i2v" : "video_t2v";
  const route = veniceRoute(intent, a.tier);
  const capability = "media_video_generate";
  const t0 = Date.now();
  const emitReason = (ok: boolean, error: string | null) => {
    void track(env, a.uid, "ava_reason_call", "avaai", {
      role: "ava_video", capability, trigger: intent,
      opportunity: null, feature: "ava_video", verb: "see", provider: "venice",
      model: route.model, primary_model: null, ok, fallback_used: false, cache_hit: false,
      latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
    });
  };

  const created = await createVeniceMediaJob(env, {
    ownerUid: a.uid, convId: a.conv, kind: "venice_video_generate",
    capability, model: route.model, isPrivate: a.private, tier: a.tier,
    hasSourceImage: !!a.sourceImageUrl, durationSeconds: null,
    label: "Generating your video…", deadlineMs: Date.now() + VIDEO_DEADLINE_MS, email,
    // [VENICE-TOKENS-1] owner tariff 2026-08-14: video = cfg.veniceVideoTokens (50).
    flatPriceTokens: cfg.veniceVideoTokens,
  });
  if (!created.ok) {
    emitReason(false, created.error);
    if (created.error === "AI_INSUFFICIENT_TOKENS") {
      const style: AvaVoiceStyle = await readVoiceStyle(env, a.uid).catch(() => "auto");
      return { ok: false, blocked: true, message: avaString("err_out_of_tokens", style, prompt) };
    }
    return { ok: false, message: "I couldn't start that video right now — please try again." };
  }
  const jobId = created.job.job_id;

  try {
    // env as any: VENICE_API_KEY is not (yet) declared on the shared Env
    // interface (worker/src/types.ts) — matches the existing cast at
    // routes/ava_image.ts's generateImageVenice() call site, not a new pattern.
    const { queueId } = await veniceQueueVideo(
      env as any, route.model, prompt, a.sourceImageUrl ? { imageUrl: a.sourceImageUrl } : {},
    );
    await attachVeniceQueueId(env, jobId, queueId);
    await enqueueVeniceMediaPoll(env, jobId, "venice_video_generate", INITIAL_POLL_DELAY_S);
    emitReason(true, null);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "unknown").slice(0, 300);
    await failVeniceMediaJob(env, { jobId, errorCode: "provider_unavailable", reason: "submit_failed" });
    void track(env, a.uid, "ava_video_error", "avaai", { stage: "submit", model: route.model, provider: "venice", error: msg, job_id: jobId });
    emitReason(false, msg);
    return { ok: false, message: "I couldn't start that video right now — please try again." };
  }

  void track(env, a.uid, "venice_media_job_submitted", "avaai", {
    job_id: jobId, kind: "venice_video_generate", tier: a.tier, i2v: !!a.sourceImageUrl,
  });
  return {
    ok: true, job_id: jobId,
    message: a.private
      ? "🎬 Working on your video — it can take a few minutes. It'll appear here privately when it's ready."
      : "🎬 Working on your video — it can take a few minutes. It'll appear in this chat when it's ready.",
  };
}

// ---------------------------------------------------------------------------
// MUSIC
// ---------------------------------------------------------------------------
export interface RunVeniceMusicArgs {
  uid: string;
  conv: string;
  prompt: string;
  durationSeconds?: number;
  private: boolean;
  /** [VENICE-TIER-1] see RunVeniceVideoArgs.tier doc — resolved via
   *  lib/venice_tier.ts's veniceTier(env, uid) at the do/ava_agent.ts onMusic
   *  call site. */
  tier: VeniceTier;
}

export async function runVeniceMusic(env: Env, a: RunVeniceMusicArgs): Promise<RunVeniceMediaResult> {
  const prompt = String(a.prompt ?? "").trim();
  if (!prompt) return { ok: false, message: "Tell me what kind of track to create." };
  if (prompt.length > 2000) return { ok: false, message: "That prompt is too long." };

  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return { ok: false, message: "Ava is currently turned off." };
  if (cfg.veniceMediaEnabled !== true) {
    return { ok: false, message: "Music generation is currently turned off." };
  }

  const email = await emailFor(env, a.uid).catch(() => null);

  const verdict = await moderate(env, { text: prompt, field: "venice_music_prompt" });
  if (!verdict.safe) {
    void track(env, a.uid, "venice_nsfw_blocked", "avaai", {
      stage: "prompt", media: "music", reason: verdict.reason, categories: verdict.categories, provider: "venice",
    });
    return { ok: false, blocked: true, message: verdict.reason || "I can't create that track. Let's keep things safe — try a different idea." };
  }

  const route = veniceRoute("music", a.tier);
  const capability = "media_music_generate";
  // Duration only applies to the free-tier duration-priced model (ace-step-15,
  // clamped 60-210s per lib/venice.ts). The paid model (minimax-music-v25) is
  // flat and takes no duration — clampMusicSeconds still returns a number for
  // the job row/telemetry, but veniceQueueMusic only SENDS it when the model
  // is ace-step-15 (see that function).
  const durationSeconds = clampMusicSeconds(a.durationSeconds);
  const t0 = Date.now();
  const emitReason = (ok: boolean, error: string | null) => {
    void track(env, a.uid, "ava_reason_call", "avaai", {
      role: "ava_music", capability, trigger: "music_generate",
      opportunity: null, feature: "ava_music", verb: "hear", provider: "venice",
      model: route.model, primary_model: null, ok, fallback_used: false, cache_hit: false,
      latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
    });
  };

  const created = await createVeniceMediaJob(env, {
    ownerUid: a.uid, convId: a.conv, kind: "venice_music_generate",
    capability, model: route.model, isPrivate: a.private, tier: a.tier,
    hasSourceImage: false, durationSeconds,
    label: "Generating your track…", deadlineMs: Date.now() + MUSIC_DEADLINE_MS, email,
    // [VENICE-TOKENS-1] owner tariff 2026-08-14: music = cfg.veniceMusicTokens (10).
    flatPriceTokens: cfg.veniceMusicTokens,
  });
  if (!created.ok) {
    emitReason(false, created.error);
    if (created.error === "AI_INSUFFICIENT_TOKENS") {
      const style: AvaVoiceStyle = await readVoiceStyle(env, a.uid).catch(() => "auto");
      return { ok: false, blocked: true, message: avaString("err_out_of_tokens", style, prompt) };
    }
    return { ok: false, message: "I couldn't start that track right now — please try again." };
  }
  const jobId = created.job.job_id;

  try {
    const { queueId } = await veniceQueueMusic(env as any, route.model, prompt, { durationSeconds });
    await attachVeniceQueueId(env, jobId, queueId);
    await enqueueVeniceMediaPoll(env, jobId, "venice_music_generate", INITIAL_POLL_DELAY_S);
    emitReason(true, null);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "unknown").slice(0, 300);
    await failVeniceMediaJob(env, { jobId, errorCode: "provider_unavailable", reason: "submit_failed" });
    void track(env, a.uid, "ava_music_error", "avaai", { stage: "submit", model: route.model, provider: "venice", error: msg, job_id: jobId });
    emitReason(false, msg);
    return { ok: false, message: "I couldn't start that track right now — please try again." };
  }

  void track(env, a.uid, "venice_media_job_submitted", "avaai", {
    job_id: jobId, kind: "venice_music_generate", tier: a.tier, duration_seconds: durationSeconds,
  });
  return {
    ok: true, job_id: jobId,
    message: a.private
      ? "🎵 Working on your track — it can take a few minutes. It'll appear here privately when it's ready."
      : "🎵 Working on your track — it can take a few minutes. It'll appear in this chat when it's ready.",
  };
}
