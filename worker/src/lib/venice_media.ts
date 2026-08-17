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
  veniceRoute, veniceQueueVideo, veniceQueueMusic, clampMusicSeconds, nearestVideoDuration,
  VENICE_VIDEO_MIN_SECONDS, VENICE_VIDEO_MAX_SECONDS, VENICE_VIDEO_DEFAULT_RESOLUTION,
  type VeniceIntent, type VeniceTier, type VeniceVideoResolution, classifyVeniceError,
  veniceVideoPreflight, recordVeniceVideoProviderFailure, recordVeniceVideoProviderSuccess,
} from "./venice";
import {
  createVeniceMediaJob, attachVeniceQueueId, failVeniceMediaJob,
} from "./venice_media_jobs";
import { enqueueVeniceMediaPoll } from "../queues/venice_media";
import { track } from "../hooks";
import { emailFor } from "./identity";
import { avaString, readVoiceStyle, type AvaVoiceStyle } from "./ava_persona";
import { postAvaMessage } from "../routes/ava_thread";
// [VENICE-PROMPT-1 / VENICE-SONG-1] Gemini-3.7-via-Venice prompt/lyrics
// crafting — see lib/media_prompt.ts's header for the fail-soft contract.
import { craftVideoPrompt, craftVideoCardMetadata, craftSongCardMetadata, draftLyrics } from "./media_prompt";

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
  /** Users may request any whole-second video from 8 through 15 seconds. */
  durationSeconds?: number;
  resolution?: VeniceVideoResolution;
  aspectRatio?: "9:16" | "16:9";
  private: boolean;
  /** [VENICE-TIER-1] Caller-supplied — do/ava_agent.ts's onVideo closure
   *  resolves this via lib/venice_tier.ts's veniceTier(env, uid) before
   *  calling in. */
  tier: VeniceTier;
}

export async function runVeniceVideo(env: Env, a: RunVeniceVideoArgs): Promise<RunVeniceMediaResult> {
  const rawPrompt = String(a.prompt ?? "").trim();
  if (!rawPrompt) return { ok: false, message: "Tell me what video to create." };
  if (rawPrompt.length > 2000) return { ok: false, message: "That prompt is too long." };

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

  const requestedDuration = Number(a.durationSeconds);
  if (Number.isFinite(requestedDuration)) {
    const rounded = Math.round(requestedDuration);
    if (rounded < VENICE_VIDEO_MIN_SECONDS) {
      return { ok: false, message: `Video length must be at least ${VENICE_VIDEO_MIN_SECONDS} seconds.` };
    }
    if (rounded > VENICE_VIDEO_MAX_SECONDS) {
      return { ok: false, message: `Videos longer than ${VENICE_VIDEO_MAX_SECONDS} seconds are not supported yet.` };
    }
  }
  // Preserve the user's requested whole-second duration for prompt pacing and
  // the durable job record; omitted duration defaults to 10 seconds.
  const durationStr = nearestVideoDuration(a.durationSeconds);
  const durationNum = parseInt(durationStr, 10);

  // [VENICE-PROMPT-1] Gemini-3.7 (via Venice) strengthens the user's raw ask
  // into a more detailed, duration-aware prompt before it ever reaches the
  // video model. Fails soft internally (see media_prompt.ts) — `prompt` is
  // always at least `rawPrompt` on any craft failure.
  const prompt = await craftVideoPrompt(env, rawPrompt, durationNum);
  // Derive the public card and thumbnail concept from the rich visual scene,
  // not from a conversational request such as "make me a video".
  const card = await craftVideoCardMetadata(env, prompt);

  // ── PROMPT GATE (mandatory, before any reservation/provider call) ────────
  // Gates the prompt actually sent to Venice (the crafted version), which is
  // a superset of the user's own ask — moderating it also covers the raw ask.
  const verdict = await moderate(env, { text: prompt, field: "venice_video_prompt" });
  if (!verdict.safe) {
    void track(env, a.uid, "venice_nsfw_blocked", "avaai", {
      stage: "prompt", media: "video", reason: verdict.reason, categories: verdict.categories, provider: "venice",
    });
    return { ok: false, blocked: true, message: verdict.reason || "I can't create that video. Let's keep things safe — try a different idea." };
  }

  const intent: VeniceIntent = a.sourceImageUrl ? "video_i2v" : "video_t2v";
  const route = veniceRoute(intent, a.tier);
  const preflight = await veniceVideoPreflight(env as any, route.model);
  if (!preflight.ok) {
    void track(env, a.uid, "venice_video_preflight_failed", "avaai", { model: route.model, provider: "venice", error_code: preflight.code });
    const message = preflight.code === "provider_circuit_open"
      ? "Video creation is temporarily paused while the AI video service recovers. Please try again shortly."
      : "The AI video service is not ready for this request yet. Please try again shortly.";
    return { ok: false, message };
  }
  const providerModel = preflight.model;
  const capability = "media_video_generate";
  const t0 = Date.now();
  const emitReason = (ok: boolean, error: string | null) => {
    void track(env, a.uid, "ava_reason_call", "avaai", {
      role: "ava_video", capability, trigger: intent,
      opportunity: null, feature: "ava_video", verb: "see", provider: "venice",
      model: providerModel, primary_model: null, ok, fallback_used: providerModel !== route.model, cache_hit: false,
      latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
    });
  };

  const created = await createVeniceMediaJob(env, {
    ownerUid: a.uid, convId: a.conv, kind: "venice_video_generate",
    capability, model: providerModel, isPrivate: a.private, tier: a.tier,
    hasSourceImage: !!a.sourceImageUrl, durationSeconds: durationNum,
    label: "Generating your video…", deadlineMs: Date.now() + VIDEO_DEADLINE_MS, email,
    // [VENICE-TOKENS-1] owner tariff: 45 Tokens per 10-second video clip.
    flatPriceTokens: cfg.veniceVideoTokens,
    // The existing card columns are deliberately reused for video metadata;
    // they are safe, generated copy and never contain the source prompt.
    songTitle: card.title, songDescription: card.description,
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

  let queueId: string;
  try {
    // env as any: VENICE_API_KEY is not (yet) declared on the shared Env
    // interface (worker/src/types.ts) — matches the existing cast at
    // routes/ava_image.ts's generateImageVenice() call site, not a new pattern.
    ({ queueId } = await veniceQueueVideo(
      env as any, providerModel, prompt,
      {
        duration: durationStr,
        resolution: a.resolution,
        aspectRatio: a.aspectRatio,
        ...(a.sourceImageUrl ? { imageUrl: a.sourceImageUrl } : {}),
      },
    ));
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "unknown").slice(0, 300);
    const errorCode = classifyVeniceError(e);
    await recordVeniceVideoProviderFailure(env as any);
    await failVeniceMediaJob(env, { jobId, errorCode, reason: "submit_failed" });
    void track(env, a.uid, "ava_video_error", "avaai", { stage: "submit", model: providerModel, provider: "venice", error: msg, job_id: jobId });
    emitReason(false, msg);
    return { ok: false, message: "I couldn't start that video right now — please try again." };
  }
  await recordVeniceVideoProviderSuccess(env as any);

  // Provider acceptance and our own durable handoff are different failure
  // domains. Do not trip Venice's circuit breaker or mislabel telemetry when
  // D1/Queues fail after Venice has already accepted the generation.
  const attached = await attachVeniceQueueId(env, jobId, queueId);
  if (!attached) {
    await failVeniceMediaJob(env, { jobId, errorCode: "pipeline_state_error", reason: "queue_id_attach_failed" });
    void track(env, a.uid, "ava_video_error", "avaai", {
      stage: "attach", model: providerModel, provider: "venice", error: "queue_id_attach_failed", job_id: jobId,
    });
    emitReason(false, "queue_id_attach_failed");
    return { ok: false, message: "I couldn't start that video right now — please try again." };
  }
  try {
    await enqueueVeniceMediaPoll(env, jobId, "venice_video_generate", INITIAL_POLL_DELAY_S);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "unknown").slice(0, 300);
    await failVeniceMediaJob(env, { jobId, errorCode: "pipeline_queue_error", reason: "poll_enqueue_failed" });
    void track(env, a.uid, "ava_video_error", "avaai", {
      stage: "enqueue", model: providerModel, provider: "venice", error: msg, job_id: jobId,
    });
    emitReason(false, msg);
    return { ok: false, message: "I couldn't start that video right now — please try again." };
  }
  emitReason(true, null);

  void track(env, a.uid, "venice_media_job_submitted", "avaai", {
    job_id: jobId, kind: "venice_video_generate", tier: a.tier, i2v: !!a.sourceImageUrl, model: providerModel,
    duration_seconds: durationNum, resolution: a.resolution ?? VENICE_VIDEO_DEFAULT_RESOLUTION,
    aspect_ratio: a.aspectRatio ?? "9:16", prompt_crafted: prompt !== rawPrompt,
  });
  await postAvaMessage(env, {
    ownerUid: a.uid, conv: a.conv,
    text: a.private ? "Ava is creating your video…" : "Ava is creating a video…",
    private: a.private, source: "video",
    meta: { job_id: jobId, media_job_kind: "venice_video_generate" },
  }).catch(() => {});
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
  /** [VENICE-SONG-1] Approved lyrics (from the draft_lyrics tool, after the
   *  user signed off). Sent to Venice's dedicated `lyrics_prompt` field;
   *  absent for a plain instrumental/music request. */
  lyrics?: string;
  musicMode?: "vocal" | "instrumental";
  private: boolean;
  /** [VENICE-TIER-1] see RunVeniceVideoArgs.tier doc — resolved via
   *  lib/venice_tier.ts's veniceTier(env, uid) at the do/ava_agent.ts onMusic
   *  call site. */
  tier: VeniceTier;
}

// [SONG-CONTRACT-1 2026-08-17] Per-model provider limits, discovered the hard
// way one production failure at a time (each was a live Venice 400):
//   minimax-music-v26 : prompt < 300 chars, lyrics_prompt < 1000 chars, no duration
//   elevenlabs-music  : NO lyrics support at all ("This model does not support lyrics")
// Encoding them here means a request is SHAPED to fit before it is sent, instead
// of being rejected in front of the user. An unknown model gets generous
// defaults plus the submit-time fallback below as its safety net.
interface MusicModelLimits {
  promptMaxChars: number;
  lyricsMaxChars: number;
  supportsLyrics: boolean;
}
const MUSIC_MODEL_LIMITS: Record<string, MusicModelLimits> = {
  "minimax-music-v26": { promptMaxChars: 290, lyricsMaxChars: 950, supportsLyrics: true },
  "elevenlabs-music": { promptMaxChars: 2000, lyricsMaxChars: 0, supportsLyrics: false },
  "ace-step-15": { promptMaxChars: 1000, lyricsMaxChars: 4000, supportsLyrics: true },
};
function musicLimitsFor(model: string): MusicModelLimits {
  return MUSIC_MODEL_LIMITS[model] ?? { promptMaxChars: 290, lyricsMaxChars: 950, supportsLyrics: true };
}

/**
 * Compress the structured production brief into a musical-direction prompt that
 * fits `maxChars`. The brief is multi-line and labelled ("Theme / intent: …\n
 * Genre: …"), which blew MiniMax's 300-char ceiling on every real song. Lines
 * are kept in the order a music model actually benefits from, and the whole
 * thing is truncated on a word boundary as a final guarantee.
 */
export function compactMusicPrompt(brief: string, maxChars: number): string {
  const raw = String(brief || "").trim();
  if (raw.length <= maxChars) return raw;
  const priority = [
    /^genre\s*:/i, /^mood/i, /^instruments\s*:/i, /^voice character\s*:/i,
    /^vocal arrangement\s*:/i, /^language\s*:/i, /^theme/i, /^intended use\s*:/i,
  ];
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    // Drop lines that describe our plumbing rather than the music.
    .filter((l) => !/^(?:audio model|length)\s*:/i.test(l));
  const ranked: string[] = [];
  for (const rx of priority) {
    const hit = lines.find((l) => rx.test(l) && !ranked.includes(l));
    if (hit) ranked.push(hit);
  }
  for (const l of lines) if (!ranked.includes(l)) ranked.push(l);
  let out = "";
  for (const line of ranked) {
    const next = out ? `${out}. ${line}` : line;
    if (next.length > maxChars) break;
    out = next;
  }
  if (!out) {
    const head = raw.slice(0, maxChars);
    const cut = head.lastIndexOf(" ");
    out = (cut > maxChars * 0.5 ? head.slice(0, cut) : head).trim();
  }
  return out.slice(0, maxChars).trim();
}

/** Trim lyrics to a model's cap on a section/line boundary, never mid-word. */
export function trimLyricsToCap(lyrics: string, maxChars: number): string {
  const raw = String(lyrics || "");
  if (raw.length <= maxChars) return raw;
  const head = raw.slice(0, maxChars);
  const cutAt = Math.max(head.lastIndexOf("\n["), head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
  return (cutAt > maxChars * 0.4 ? head.slice(0, cutAt) : head).trim();
}

export function songCardMetadata(stylePrompt: string, durationSeconds: number, hasLyrics: boolean): {
  title: string;
  description: string;
} {
  const cleaned = String(stylePrompt || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:please\s+)?(?:make|create|generate|write|compose)\s+(?:me\s+)?(?:an?\s+)?(?:song|track|music)\s*(?:about|for|with|in)?\s*/i, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 7);
  const rawTitle = words.join(" ").replace(/[.,;:!?\-]+$/g, "").trim();
  const title = rawTitle
    ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1)
    : "A New Story";
  const seconds = Math.max(1, Math.trunc(durationSeconds));
  const length = seconds >= 120 ? `${Math.round(seconds / 60)}-minute` : `${seconds}-second`;
  const description = hasLyrics
    ? `${length} song about ${rawTitle || "a feeling worth holding onto"}, carried by its requested story and sound.`
    : `${length} instrumental built around ${rawTitle || "a focused mood"}, with room for texture, rhythm and atmosphere.`;
  return { title: title.slice(0, 80), description: description.slice(0, 160) };
}

export async function runVeniceMusic(env: Env, a: RunVeniceMusicArgs): Promise<RunVeniceMediaResult> {
  const stylePrompt = String(a.prompt ?? "").trim();
  if (!stylePrompt) return { ok: false, message: "Tell me what kind of track to create." };
  if (stylePrompt.length > 2000) return { ok: false, message: "That prompt is too long." };
  const lyrics = String(a.lyrics ?? "").trim().slice(0, 4000);
  const musicMode = a.musicMode ?? (lyrics ? "vocal" : "instrumental");
  if (musicMode === "vocal" && !lyrics) return { ok: false, message: "I need approved lyrics before creating a vocal song." };
  if (musicMode === "instrumental" && lyrics) return { ok: false, message: "Instrumental tracks cannot include lyrics." };
  // [VENICE-SONG-1] Venice receives musical direction and approved lyrics in
  // distinct fields. Keep one combined string only for the mandatory safety
  // gate, so moderation still covers both the style and sung content.
  const moderationText = lyrics ? `${stylePrompt}\n\nLyrics:\n${lyrics}` : stylePrompt;
  if (moderationText.length > 6000) return { ok: false, message: "That's too long — trim the lyrics a little." };

  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return { ok: false, message: "Ava is currently turned off." };
  if (cfg.veniceMediaEnabled !== true) {
    return { ok: false, message: "Music generation is currently turned off." };
  }

  const email = await emailFor(env, a.uid).catch(() => null);

  const verdict = await moderate(env, { text: moderationText, field: "venice_music_prompt" });
  if (!verdict.safe) {
    void track(env, a.uid, "venice_nsfw_blocked", "avaai", {
      stage: "prompt", media: "music", reason: verdict.reason, categories: verdict.categories, provider: "venice",
    });
    return { ok: false, blocked: true, message: verdict.reason || "I can't create that track. Let's keep things safe — try a different idea." };
  }

  const route = veniceRoute("music", a.tier);
  const capability = "media_music_generate";
  const durationSeconds = clampMusicSeconds(a.durationSeconds);
  // [SONG-LEN-2] MiniMax Music 2.6 has no duration parameter AND rejects
  // lyrics_prompt >= 1000 chars (live 400, 2026-08-16), so it can only sing
  // roughly 60-90 seconds. Requests longer than 90s route to the configured
  // duration-capable Venice model when one is enabled; otherwise they stay on
  // MiniMax with the lyrics trimmed to fit — a shorter song beats a failed one.
  const longModel = String((cfg as any).veniceLongMusicModel ?? "").trim();
  // [SONG-FALLBACK-1] A long-song model is only usable for a VOCAL song if it
  // accepts lyrics. elevenlabs-music does not ("This model does not support
  // lyrics", live 400 2026-08-17) — routing a vocal there hard-failed the whole
  // request in front of the user. Vocal songs therefore only use the long model
  // when it is known to take lyrics; instrumentals can use any long model.
  const longModelUsable = !!longModel
    && (musicMode === "instrumental" || musicLimitsFor(longModel).supportsLyrics);
  const model = durationSeconds > 90 && longModelUsable ? longModel : route.model;
  // [SONG-CONTRACT-1] Shape BOTH fields to this model's real ceilings before
  // sending. A 1-minute song failed live on 2026-08-17 because the structured
  // brief ("Theme / intent: …\nGenre: …") is well over MiniMax's 300-char
  // prompt limit — the lyric cap alone was never enough.
  const limits = musicLimitsFor(model);
  const submitPrompt = compactMusicPrompt(stylePrompt, limits.promptMaxChars);
  const submitLyrics = limits.supportsLyrics ? trimLyricsToCap(lyrics, limits.lyricsMaxChars) : "";
  if (submitPrompt.length < stylePrompt.length || submitLyrics.length < lyrics.length) {
    void track(env, a.uid, "ava_music_request_shaped", "avaai", {
      model, prompt_before: stylePrompt.length, prompt_after: submitPrompt.length,
      lyrics_before: lyrics.length, lyrics_after: submitLyrics.length,
      requested_duration_seconds: durationSeconds,
    });
  }
  // Use the approved lyrics as the source of truth for public promotional copy;
  // the style brief alone produced generic titles that did not match the song.
  const card = await craftSongCardMetadata(env, stylePrompt, lyrics);
  const t0 = Date.now();
  const emitReason = (ok: boolean, error: string | null) => {
    void track(env, a.uid, "ava_reason_call", "avaai", {
      role: "ava_music", capability, trigger: "music_generate",
      opportunity: null, feature: "ava_music", verb: "hear", provider: "venice",
      model, primary_model: null, ok, fallback_used: false, cache_hit: false,
      latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
    });
  };

  const created = await createVeniceMediaJob(env, {
    ownerUid: a.uid, convId: a.conv, kind: "venice_music_generate",
    capability, model, isPrivate: a.private, tier: a.tier,
    hasSourceImage: false, durationSeconds,
    label: "Generating your track…", deadlineMs: Date.now() + MUSIC_DEADLINE_MS, email,
    songTitle: card.title, songDescription: card.description,
    musicMode,
    // [VENICE-TOKENS-1] owner tariff 2026-08-14: music = cfg.veniceMusicTokens (10).
    flatPriceTokens: cfg.veniceMusicTokens,
  });
  if (!created.ok) {
    void track(env, a.uid, "ava_music_error", "avaai", {
      stage: "job_create", model, provider: "venice", error: created.error,
    });
    emitReason(false, created.error);
    if (created.error === "AI_INSUFFICIENT_TOKENS") {
      const style: AvaVoiceStyle = await readVoiceStyle(env, a.uid).catch(() => "auto");
      return { ok: false, blocked: true, message: avaString("err_out_of_tokens", style, moderationText) };
    }
    return { ok: false, message: "I couldn't start that track right now — please try again." };
  }
  const jobId = created.job.job_id;

  // [SONG-FALLBACK-1] Submit with an automatic second chance. A provider that
  // refuses the request (unsupported field, lyric-length cap, model retired)
  // used to end the whole song in a red error card. Now the default per-
  // generation model gets one attempt with lyrics trimmed to its cap — a
  // shorter finished song always beats a failure in front of the user.
  let submittedModel = model;
  try {
    // Venice's audio queue accepts musical direction in `prompt` and approved
    // lyrics in `lyrics_prompt`; neither field repeats the other.
    let queueId: string;
    try {
      ({ queueId } = await veniceQueueMusic(env as any, model, submitPrompt, {
        durationSeconds,
        lyricsPrompt: submitLyrics || undefined,
      }));
    } catch (first: any) {
      const firstMsg = String(first?.message ?? first ?? "unknown").slice(0, 300);
      // Retry on the default per-generation model with ITS limits applied. When
      // we were already on that model, retry once with deliberately conservative
      // sizes — a provider that rejects a request for length must never be the
      // last word to the user.
      const retryModel = model === route.model ? route.model : route.model;
      const retryLimits = musicLimitsFor(retryModel);
      const tighter = model === route.model;
      const retryPrompt = compactMusicPrompt(
        stylePrompt, tighter ? Math.min(200, retryLimits.promptMaxChars) : retryLimits.promptMaxChars,
      );
      const retryLyrics = retryLimits.supportsLyrics
        ? trimLyricsToCap(lyrics, tighter ? Math.min(800, retryLimits.lyricsMaxChars) : retryLimits.lyricsMaxChars)
        : "";
      void track(env, a.uid, "ava_music_model_fallback", "avaai", {
        from_model: model, to_model: retryModel, error: firstMsg, tighter,
        prompt_chars: retryPrompt.length, lyrics_chars: retryLyrics.length,
        requested_duration_seconds: durationSeconds, job_id: jobId,
      });
      submittedModel = retryModel;
      ({ queueId } = await veniceQueueMusic(env as any, retryModel, retryPrompt, {
        durationSeconds,
        lyricsPrompt: retryLyrics || undefined,
      }));
    }
    await attachVeniceQueueId(env, jobId, queueId);
    await enqueueVeniceMediaPoll(env, jobId, "venice_music_generate", INITIAL_POLL_DELAY_S);
    emitReason(true, null);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "unknown").slice(0, 300);
    const errorCode = classifyVeniceError(e);
    await failVeniceMediaJob(env, { jobId, errorCode, reason: "submit_failed" });
    void track(env, a.uid, "ava_music_error", "avaai", { stage: "submit", model: submittedModel, provider: "venice", error: msg, job_id: jobId });
    emitReason(false, msg);
    return { ok: false, message: "I couldn't start that track right now — please try again." };
  }

  void track(env, a.uid, "venice_media_job_submitted", "avaai", {
    job_id: jobId, kind: "venice_music_generate", tier: a.tier, duration_seconds: durationSeconds,
    has_lyrics: !!lyrics,
  });
  await postAvaMessage(env, {
    ownerUid: a.uid, conv: a.conv,
    text: a.private ? "Ava is creating your song…" : "Ava is creating a song…",
    private: a.private, source: "music",
    meta: { job_id: jobId, media_job_kind: "venice_music_generate" },
  }).catch(() => {});
  return {
    ok: true, job_id: jobId,
    message: a.private
      ? "🎵 Working on your track — it can take a few minutes. It'll appear here privately when it's ready."
      : "🎵 Working on your track — it can take a few minutes. It'll appear in this chat when it's ready.",
  };
}

// ---------------------------------------------------------------------------
// [VENICE-SONG-1] LYRICS DRAFT — text-only, synchronous, no wallet charge.
// This is step (b) of the song flow (Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md
// owner requirement B): Ava asks the length, drafts lyrics here, shows them in
// chat, and ONLY generates the actual track (runVeniceMusic above) once the
// user explicitly approves. Called from do/ava_agent.ts's onDraftLyrics via
// composio.ts's draft_lyrics tool.
// ---------------------------------------------------------------------------
export interface RunVeniceDraftLyricsArgs {
  uid: string;
  theme: string;
  durationSeconds?: number;
}
export interface RunVeniceDraftLyricsResult {
  ok: boolean;
  blocked?: boolean;
  lyrics?: string;
  message: string;
}

export async function runVeniceDraftLyrics(env: Env, a: RunVeniceDraftLyricsArgs): Promise<RunVeniceDraftLyricsResult> {
  const theme = String(a.theme ?? "").trim();
  if (!theme) return { ok: false, message: "Tell me what the song should be about." };
  if (theme.length > 2000) return { ok: false, message: "That's too long — give me a shorter theme." };

  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return { ok: false, message: "Ava is currently turned off." };
  // Same kill switch as the rest of the Venice media lane — lyrics drafting
  // is a step INSIDE the song flow that ends at runVeniceMusic above, so it
  // stays behind the same switch rather than a flag of its own.
  if (cfg.veniceMediaEnabled !== true) {
    return { ok: false, message: "Song writing is currently turned off." };
  }

  // ── PROMPT GATE (mandatory) ── reuses the music prompt gate verbatim, same
  // rubric as runVeniceMusic above — lyrics are user-facing text a moment
  // after this call, so they must clear the same bar before drafting starts.
  const verdict = await moderate(env, { text: theme, field: "venice_music_prompt" });
  if (!verdict.safe) {
    void track(env, a.uid, "venice_nsfw_blocked", "avaai", {
      stage: "prompt", media: "lyrics", reason: verdict.reason, categories: verdict.categories, provider: "venice",
    });
    return { ok: false, blocked: true, message: verdict.reason || "I can't write lyrics about that. Let's keep things safe — try a different idea." };
  }

  const durationSeconds = clampMusicSeconds(a.durationSeconds);
  // [SONG-LEN-2] Draft to the limit of the model that will actually sing:
  // MiniMax caps lyrics_prompt under 1000 chars, so without a duration-capable
  // long-song model configured, the draft itself must fit — approving lyrics
  // the singer cannot be given in full is how a "3-minute song" came out 24s.
  const longMusicModel = String((cfg as any).veniceLongMusicModel ?? "").trim();
  const lyricsCharCap = durationSeconds > 90 && longMusicModel ? undefined : 940;
  const t0 = Date.now();
  let lyrics = "";
  let ok = true;
  let error: string | null = null;
  try {
    lyrics = await draftLyrics(env, theme, durationSeconds, lyricsCharCap);
  } catch (e: any) {
    ok = false;
    error = String(e?.message ?? e ?? "unknown").slice(0, 300);
  }
  // No wallet reservation — lyrics drafting is text-only and free (owner work
  // order §6) — but every Venice model call still gets an ava_reason_call row
  // so spend/latency is visible, same as the media calls above.
  void track(env, a.uid, "ava_reason_call", "avaai", {
    role: "ava_lyrics", capability: "media_lyrics_draft", trigger: "draft_lyrics",
    opportunity: null, feature: "ava_music", verb: "hear", provider: "venice",
    model: "gemini-3-7-flash", primary_model: null, ok, fallback_used: false, cache_hit: false,
    latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
  });
  if (!ok || !lyrics) {
    return { ok: false, message: "I couldn't draft lyrics right now — please try again." };
  }
  void track(env, a.uid, "venice_lyrics_drafted", "avaai", { duration_seconds: durationSeconds, chars: lyrics.length });
  return { ok: true, lyrics, message: lyrics };
}
