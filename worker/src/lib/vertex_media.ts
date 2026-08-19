// In-thread Google Vertex video/music generation. The public entry points keep
// their existing names because queued jobs and deployed clients still use the
// original compatibility contract; the provider call itself is Vertex-only.
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
// (worker/src/queues/media.ts), which re-polls itself with backoff
// until Venice reports done or the job's deadline passes. No detach/
// keepAlive plumbing is needed here as a result — unlike image generation,
// nothing long-running happens inside this module's own call stack.
//
// PRIVACY (§41/§42): the prompt is used only inline to submit the provider
// request; it is never written to the media job row. Only the provider
// operation id (or staged audio key) is persisted.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { moderate } from "./moderation";
import {
  createMediaJob, attachProviderOperationId, failMediaJob,
} from "./media_jobs";
import { enqueueMediaPoll } from "../queues/media";
import { track } from "../hooks";
import { emailFor } from "./identity";
import { avaString, readVoiceStyle, type AvaVoiceStyle } from "./ava_persona";
import { postAvaMessage } from "../routes/ava_thread";
// [VENICE-PROMPT-1 / VENICE-SONG-1] Gemini-3.7-via-Venice prompt/lyrics
// crafting — see lib/media_prompt.ts's header for the fail-soft contract.
import { craftVideoPrompt, craftVideoCardMetadata, craftSongCardMetadata, draftLyrics } from "./media_prompt";
import { vertexInteraction, vertexPredictLongRunning } from "./vertex";

const VIDEO_DEADLINE_MS = 10 * 60_000; // ~10 min hard ceiling, per the work order
const MUSIC_DEADLINE_MS = 5 * 60_000;  // ~5 min hard ceiling
const INITIAL_POLL_DELAY_S = 10;       // first poll fires ~10s after submit — Venice's queue is never instant

type MediaTier = "free" | "paid";
type VertexVideoResolution = string;

function clampMusicSeconds(value?: number): number {
  return Math.max(30, Math.min(184, Math.round(Number(value) || 60)));
}

export interface RunVertexMediaResult {
  ok: boolean;
  blocked?: boolean;
  message: string;
  job_id?: string | null;
}

const VERTEX_VIDEO_MODEL = "veo-3.1-generate-preview";
const VERTEX_MUSIC_MODEL = "lyria-3-pro-preview";

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

function audioFromInteraction(out: any): Uint8Array | null {
  const item = (out?.outputs ?? []).find((x: any) => x?.type === "audio" || x?.mime_type?.startsWith("audio/"));
  return decodeBase64(item?.data ?? item?.audioContent);
}

async function imageInstance(url?: string): Promise<any | undefined> {
  if (!url) return undefined;
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma <= 5) throw new Error("unsupported_format: source image data is invalid");
    const header = url.slice(5, comma);
    const mimeType = header.split(";")[0] || "image/png";
    return { bytesBase64Encoded: url.slice(comma + 1), mimeType };
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error("unsupported_format: source image could not be read");
  const mimeType = r.headers.get("content-type")?.split(";")[0] || "image/png";
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("input_too_large: source image is too large");
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return { bytesBase64Encoded: btoa(binary), mimeType };
}

export async function runVertexVideo(env: Env, a: RunVertexVideoArgs): Promise<RunVertexMediaResult> {
  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false || cfg.generativeEnabled === false) return { ok: false, message: "Video generation is currently turned off." };
  const prompt = await craftVideoPrompt(env, a.prompt, a.durationSeconds);
  if (!prompt) return { ok: false, message: "Tell me what video to create." };
  const card = await craftVideoCardMetadata(env, prompt);
  const verdict = await moderate(env, { text: prompt, field: "vertex_video_prompt" });
  if (!verdict.safe) return { ok: false, blocked: true, message: verdict.reason || "I can't create that video." };
  const requestedDuration = Math.round(Number(a.durationSeconds) || 8);
  const duration = [4, 6, 8].reduce((closest, candidate) =>
    Math.abs(candidate - requestedDuration) < Math.abs(closest - requestedDuration) ? candidate : closest, 8);
  const created = await createMediaJob(env, {
    ownerUid: a.uid, convId: a.conv, kind: "video_generate", capability: "media_video_generate",
    model: VERTEX_VIDEO_MODEL, isPrivate: a.private, tier: a.tier, hasSourceImage: !!a.sourceImageUrl,
    durationSeconds: duration, label: "Generating your video…", deadlineMs: Date.now() + VIDEO_DEADLINE_MS,
    email: await emailFor(env, a.uid).catch(() => null), songTitle: card.title, songDescription: card.description,
    flatPriceTokens: undefined,
  });
  if (!created.ok) return { ok: false, message: "I couldn't start that video right now — please try again." };
  try {
    const image = await imageInstance(a.sourceImageUrl);
    const r = await vertexPredictLongRunning(env, VERTEX_VIDEO_MODEL, [{ prompt, ...(image ? { image } : {}) }], {
      aspectRatio: a.aspectRatio || "16:9", durationSeconds: duration, sampleCount: 1,
      ...(a.resolution ? { resolution: a.resolution } : {}),
    });
    const operationName = String(r.out?.name || "");
    if (!r.ok || !operationName) throw new Error("provider_unavailable: Vertex did not return a video operation");
    await attachProviderOperationId(env, created.job.job_id, `vertex-op:${operationName}`);
    await enqueueMediaPoll(env, created.job.job_id, "video_generate", INITIAL_POLL_DELAY_S);
    await postAvaMessage(env, { ownerUid: a.uid, conv: a.conv, text: a.private ? "Ava is creating your video…" : "Ava is creating a video…", private: a.private, source: "video", meta: { job_id: created.job.job_id, media_job_kind: "video_generate" } }).catch(() => {});
    return { ok: true, job_id: created.job.job_id, message: a.private ? "🎬 Working on your video — it'll appear here privately when it's ready." : "🎬 Working on your video — it'll appear in this chat when it's ready." };
  } catch (e) {
    await failMediaJob(env, { jobId: created.job.job_id, errorCode: "provider_unavailable", reason: "vertex_submit_failed" });
    return { ok: false, message: "I couldn't start that video right now — please try again." };
  }
}

export async function runVertexMusic(env: Env, a: RunVertexMusicArgs): Promise<RunVertexMediaResult> {
  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false || cfg.generativeEnabled === false) return { ok: false, message: "Music generation is currently turned off." };
  const prompt = String(a.prompt || "").trim();
  if (!prompt) return { ok: false, message: "Tell me what music to create." };
  const duration = Math.max(30, Math.min(184, Math.round(Number(a.durationSeconds) || 60)));
  const lyrics = String(a.lyrics || "").trim();
  const verdict = await moderate(env, { text: `${prompt}\n${lyrics}`, field: "vertex_music_prompt" });
  if (!verdict.safe) return { ok: false, blocked: true, message: verdict.reason || "I can't create that track." };
  const card = await craftSongCardMetadata(env, prompt, lyrics);
  const created = await createMediaJob(env, {
    ownerUid: a.uid, convId: a.conv, kind: "music_generate", capability: "media_music_generate",
    model: VERTEX_MUSIC_MODEL, isPrivate: a.private, tier: a.tier, hasSourceImage: false,
    durationSeconds: duration, label: "Generating your track…", deadlineMs: Date.now() + MUSIC_DEADLINE_MS,
    email: await emailFor(env, a.uid).catch(() => null), songTitle: card.title, songDescription: card.description,
    musicMode: a.musicMode, flatPriceTokens: undefined,
  });
  if (!created.ok) return { ok: false, message: "I couldn't start that track right now — please try again." };
  try {
    const modeInstruction = a.musicMode === "instrumental" || !lyrics
      ? "Instrumental only; no vocals."
      : "Sing the approved lyrics exactly; do not invent or omit lyric lines.";
    const input: any[] = [{ type: "text", text: `${prompt}\n\nTarget length: ${duration} seconds.\n${modeInstruction}${lyrics ? `\n\nApproved lyrics:\n${lyrics}` : ""}` }];
    const r = await vertexInteraction(env, VERTEX_MUSIC_MODEL, input, 120_000);
    const bytes = audioFromInteraction(r.out);
    if (!r.ok || !bytes) throw new Error("provider_unavailable: Vertex returned no audio");
    const tempKey = `ai-media/pending/${created.job.job_id}`;
    await env.DIGITAL.put(tempKey, bytes, { httpMetadata: { contentType: "audio/mpeg" } });
    await attachProviderOperationId(env, created.job.job_id, `vertex-inline:${tempKey}`);
    await enqueueMediaPoll(env, created.job.job_id, "music_generate", 0);
    await postAvaMessage(env, { ownerUid: a.uid, conv: a.conv, text: a.private ? "Ava is creating your song…" : "Ava is creating a song…", private: a.private, source: "music", meta: { job_id: created.job.job_id, media_job_kind: "music_generate" } }).catch(() => {});
    return { ok: true, job_id: created.job.job_id, message: a.private ? "🎵 Working on your track — it'll appear here privately when it's ready." : "🎵 Working on your track — it'll appear in this chat when it's ready." };
  } catch {
    await failMediaJob(env, { jobId: created.job.job_id, errorCode: "provider_unavailable", reason: "vertex_music_failed" });
    return { ok: false, message: "I couldn't start that track right now — please try again." };
  }
}

// ---------------------------------------------------------------------------
// VIDEO
// ---------------------------------------------------------------------------
export interface RunVertexVideoArgs {
  uid: string;
  conv: string;
  prompt: string;
  /** Public URL (or base64 data: URL) of an existing image to animate —
   *  presence alone selects image-to-video over text-to-video. */
  sourceImageUrl?: string;
  /** Users may request any whole-second video from 8 through 15 seconds. */
  durationSeconds?: number;
  resolution?: VertexVideoResolution;
  aspectRatio?: "9:16" | "16:9";
  private: boolean;
  /** [VENICE-TIER-1] Caller-supplied — do/ava_agent.ts's onVideo closure
   *  resolves this via the shared account tier helper before
   *  calling in. */
  tier: MediaTier;
}

// MUSIC
// ---------------------------------------------------------------------------
export type MusicMode = "vocal" | "instrumental" | "engine_written";

export interface RunVertexMusicArgs {
  uid: string;
  conv: string;
  prompt: string;
  durationSeconds?: number;
  /** [VENICE-SONG-1] Approved lyrics (from the draft_lyrics tool, after the
   *  user signed off). Sent to Venice's dedicated `lyrics_prompt` field;
   *  absent for a plain instrumental/music request. */
  lyrics?: string;
  /** [SONG-QUICK-1] "engine_written" = the quick song: no lyrics are sent at
   *  all and the music engine writes AND sings its own words from `prompt`. */
  musicMode?: MusicMode;
  private: boolean;
  /** [VENICE-TIER-1] see RunVertexVideoArgs.tier doc — resolved via
   *  the shared account tier helper at the do/ava_agent.ts onMusic
   *  call site. */
  tier: MediaTier;
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
 * [SONG-QUICK-1] The lyric contract for each mode, as one pure decision.
 *  - vocal          : lyrics are MANDATORY (Ava drafted them, the person approved).
 *  - instrumental   : lyrics are FORBIDDEN.
 *  - engine_written : lyrics are FORBIDDEN HERE TOO, and that is the feature —
 *                     the engine invents and sings its own words from the brief.
 *                     Accepting lyrics in this mode would silently reintroduce
 *                     the approval step this mode exists to remove.
 */
export function validateMusicModeRequest(
  musicMode: MusicMode, lyrics: string,
): { ok: true } | { ok: false; message: string } {
  if (musicMode === "vocal" && !lyrics) {
    return { ok: false, message: "I need approved lyrics before creating a vocal song." };
  }
  if (musicMode === "instrumental" && lyrics) {
    return { ok: false, message: "Instrumental tracks cannot include lyrics." };
  }
  if (musicMode === "engine_written" && lyrics) {
    return { ok: false, message: "A quick song is written by the music engine — it can't take approved lyrics." };
  }
  return { ok: true };
}

export interface MusicModelRouteInput {
  musicMode: MusicMode;
  durationSeconds: number;
  /** The per-generation default for the selected music tier. */
  defaultModel: string;
  /** cfg.veniceLongMusicModel — "" when no long-song model is enabled. */
  longModel: string;
  /** cfg.veniceQuickSongModel — "" falls back to defaultModel. */
  quickModel: string;
}

/**
 * [SONG-QUICK-1] Pick the model that can actually perform this request.
 *
 * The quick mode inverts the [SONG-FALLBACK-1] rule above: a model with
 * supportsLyrics:false is the RIGHT answer here, because no lyrics_prompt is
 * sent and the engine has to write the words itself. elevenlabs-music is that
 * model — the same 400 that made it unusable for an approved-lyrics song is
 * irrelevant when nothing is submitted in that field.
 */
export function resolveMusicModel(a: MusicModelRouteInput): string {
  if (a.musicMode === "engine_written") {
    return String(a.quickModel || "").trim() || a.defaultModel;
  }
  const longModel = String(a.longModel || "").trim();
  const longModelUsable = !!longModel
    && (a.musicMode === "instrumental" || musicLimitsFor(longModel).supportsLyrics);
  return a.durationSeconds > 90 && longModelUsable ? longModel : a.defaultModel;
}

/**
 * [SONG-QUICK-1] Which model gets the one automatic second chance after a
 * provider refusal. An engine-written song must NOT retry on the default
 * per-generation model when it is already on a purpose-picked quick model:
 * that model was chosen because it writes its own words, and the fallback
 * would hand a wordless brief to a model that expects a lyrics_prompt —
 * turning a quick song into an accidental instrumental.
 */
export function musicRetryModel(musicMode: MusicMode, model: string, defaultModel: string): string {
  return musicMode === "engine_written" ? model : defaultModel;
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

export interface RunVertexDraftLyricsArgs {
  uid: string;
  theme: string;
  durationSeconds?: number;
}
export interface RunVertexDraftLyricsResult {
  ok: boolean;
  blocked?: boolean;
  lyrics?: string;
  message: string;
}

export async function runVertexDraftLyrics(env: Env, a: RunVertexDraftLyricsArgs): Promise<RunVertexDraftLyricsResult> {
  const theme = String(a.theme ?? "").trim();
  if (!theme) return { ok: false, message: "Tell me what the song should be about." };
  if (theme.length > 2000) return { ok: false, message: "That's too long — give me a shorter theme." };

  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return { ok: false, message: "Ava is currently turned off." };
  // Same generative-media kill switch as the rest of the Vertex media lane — lyrics drafting
  // is a step INSIDE the song flow that ends at runVertexMusic above, so it
  // stays behind the same switch rather than a flag of its own.
  if (cfg.generativeEnabled === false) {
    return { ok: false, message: "Song writing is currently turned off." };
  }

  // ── PROMPT GATE (mandatory) ── reuses the music prompt gate verbatim, same
  // rubric as runVertexMusic above — lyrics are user-facing text a moment
  // after this call, so they must clear the same bar before drafting starts.
  const verdict = await moderate(env, { text: theme, field: "vertex_music_prompt" });
  if (!verdict.safe) {
    void track(env, a.uid, "media_content_blocked", "avaai", {
      stage: "prompt", media: "lyrics", reason: verdict.reason, categories: verdict.categories, provider: "vertex",
    });
    return { ok: false, blocked: true, message: verdict.reason || "I can't write lyrics about that. Let's keep things safe — try a different idea." };
  }

  const durationSeconds = clampMusicSeconds(a.durationSeconds);
  // Lyria accepts the approved custom lyrics directly. Do not apply the old
  // provider's short lyric cap; the draft should match the requested duration.
  const lyricsCharCap = undefined;
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
  // order §6) — but every Vertex model call still gets an ava_reason_call row
  // so spend/latency is visible, same as the media calls above.
  void track(env, a.uid, "ava_reason_call", "avaai", {
    role: "ava_lyrics", capability: "media_lyrics_draft", trigger: "draft_lyrics",
    opportunity: null, feature: "ava_music", verb: "hear", provider: "vertex",
    model: "gemini-3-7-flash", primary_model: null, ok, fallback_used: false, cache_hit: false,
    latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
  });
  if (!ok || !lyrics) {
    return { ok: false, message: "I couldn't draft lyrics right now — please try again." };
  }
  void track(env, a.uid, "media_lyrics_drafted", "avaai", { duration_seconds: durationSeconds, chars: lyrics.length });
  return { ok: true, lyrics, message: lyrics };
}
