// ─────────────────────────────────────────────────────────────────────────────
// venice.ts — Venice AI (api.venice.ai) client + the ONE routing map.
// Spec: Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md  ([VENICE-CLIENT-1])
//
// RULES THAT LIVE IN THIS FILE (do not weaken in a "small" edit):
//
// 1. SFW ONLY. There is NO NSFW media lane. The model IDs `lustify-*` and any
//    `*-uncensored-*` VIDEO/IMAGE model are BANNED from this map (owner decision
//    2026-08-14, Play-policy driven). Adding one is a policy violation, not a
//    feature.
// 2. `safe_mode` is ALWAYS true and `hide_watermark` is ALWAYS false on image
//    calls. Venice's watermark is part of the [VENICE-LABEL-1] "AI-generated ·
//    avatok.ai" disclosure obligation.
// 3. The LTX 2.0 19B Distilled IDs below are the Venice private-model catalog
//    entries for text-to-video and image-to-video. If you change an ID,
//    re-verify against /models first — do not trust docs or memory.
// 4. Auth is the worker secret VENICE_API_KEY (staging + prod). Never a
//    hardcoded key, never a client-side key.
// ─────────────────────────────────────────────────────────────────────────────

export interface VeniceEnv {
  VENICE_API_KEY?: string;
}

export const VENICE_BASE = "https://api.venice.ai/api/v1";

export type VeniceIntent = "image" | "video_t2v" | "video_i2v" | "music";
export type VeniceTier = "free" | "paid";

export interface VeniceRoute {
  model: string;
  /** Path under VENICE_BASE. Sync endpoints return media; queue endpoints return an id to poll. */
  endpoint: string;
  kind: "sync_image" | "queue_video" | "queue_audio";
}

// The single (intent, tier) → model+endpoint map. Media is one SFW lane for
// everyone; tier only upgrades the MUSIC model (and, elsewhere, the text chat
// lane — see [VENICE-CHAT-1]; chat is not media and is not in this map).
const ROUTES: Record<VeniceIntent, Record<VeniceTier, VeniceRoute>> = {
  image: {
    free: { model: "venice-sd35", endpoint: "/image/generate", kind: "sync_image" },
    paid: { model: "venice-sd35", endpoint: "/image/generate", kind: "sync_image" },
  },
  video_t2v: {
    free: { model: "ltx-2-19b-distilled-text-to-video", endpoint: "/video/queue", kind: "queue_video" },
    paid: { model: "ltx-2-19b-distilled-text-to-video", endpoint: "/video/queue", kind: "queue_video" },
  },
  video_i2v: {
    free: { model: "ltx-2-19b-distilled-image-to-video", endpoint: "/video/queue", kind: "queue_video" },
    paid: { model: "ltx-2-19b-distilled-image-to-video", endpoint: "/video/queue", kind: "queue_video" },
  },
  music: {
    free: { model: "ace-step-15", endpoint: "/audio/queue", kind: "queue_audio" },
    paid: { model: "minimax-music-v25", endpoint: "/audio/queue", kind: "queue_audio" },
  },
};

/** Chat model for the uncensored-TEXT lane (18+ toggle AND paid balance; text only). */
export const VENICE_UNCENSORED_CHAT_MODEL = "venice-uncensored-1-2";

export function veniceRoute(intent: VeniceIntent, tier: VeniceTier): VeniceRoute {
  return ROUTES[intent][tier];
}

function veniceKey(env: VeniceEnv): string {
  const k = env.VENICE_API_KEY;
  if (!k) throw new Error("venice_key_missing: VENICE_API_KEY secret not set on this worker");
  return k;
}

async function venicePost(env: VeniceEnv, path: string, body: unknown, timeoutMs: number): Promise<any> {
  const r = await fetch(`${VENICE_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${veniceKey(env)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) {
    const msg = String(j?.error ?? j?.message ?? "unknown").slice(0, 300);
    const err: any = new Error(`venice ${r.status}: ${msg}`);
    err.status = r.status;
    err.venice = j;
    throw err;
  }
  return j;
}

// ── Image (sync) ─────────────────────────────────────────────────────────────

export interface VeniceImageOptions {
  width?: number;
  height?: number;
  aspectRatio?: string;
  format?: "webp" | "png";
  negativePrompt?: string;
}

/** Returns base64 image bytes. safe_mode/hide_watermark are pinned — see header. */
export async function veniceGenerateImage(
  env: VeniceEnv, model: string, prompt: string, opts: VeniceImageOptions = {},
): Promise<{ b64: string; requestId: string }> {
  const body: any = {
    model,
    prompt,
    safe_mode: true,        // pinned — NEVER make this an option
    hide_watermark: false,  // pinned — [VENICE-LABEL-1] disclosure
    format: opts.format || "webp",
  };
  if (opts.width) body.width = opts.width;
  if (opts.height) body.height = opts.height;
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;
  const j = await venicePost(env, "/image/generate", body, 60000);
  const b64 = Array.isArray(j?.images) ? String(j.images[0] ?? "") : "";
  if (!b64) throw new Error("venice image: empty images[] in response");
  return { b64, requestId: String(j?.id ?? "") };
}

// ── Video (queue + poll) ─────────────────────────────────────────────────────
// Product tariff: 45 Tokens buys one 10-second clip.
export const VENICE_VIDEO_DEFAULT_DURATION = "10s";
export const VENICE_VIDEO_DEFAULT_RESOLUTION = "1080p";
// [VENICE-VID-DURATION-1] The messaging product sells one fixed 10-second
// clip. Any legacy/client duration is normalized to that product duration.
export const VENICE_VIDEO_DURATIONS_S = [10] as const;
export function nearestVideoDuration(seconds: number | undefined): string {
  if (!Number.isFinite(seconds as number) || (seconds as number) <= 0) return VENICE_VIDEO_DEFAULT_DURATION;
  const n = seconds as number;
  let best: number = VENICE_VIDEO_DURATIONS_S[0];
  let bestDiff = Infinity;
  for (const d of VENICE_VIDEO_DURATIONS_S) {
    const diff = Math.abs(d - n);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return `${best}s`;
}

// [VENICE-API-SHAPE-1 2026-08-14] The LIVE /video/queue schema (verified by a
// real paid call, NOT the docs — the docs were wrong on three counts):
//   - `safe_mode` is REJECTED ("Unrecognized key") on /video/queue — it is an
//     image-endpoint param only. Video NSFW enforcement is therefore the
//     prompt gate (lib/moderation.ts) — documented in queues/venice_media.ts.
//   - `aspect_ratio` is REQUIRED: '16:9' | '9:16'. Default '9:16' (phones).
//   - The response field is `queue_id`, not `id`.
export const VENICE_VIDEO_DEFAULT_ASPECT = "9:16";

export interface VeniceVideoOptions {
  duration?: string;
  resolution?: string;
  aspectRatio?: "16:9" | "9:16";
  negativePrompt?: string;
  /** https URL or base64 data: URL of the source image (i2v only). */
  imageUrl?: string;
}

export async function veniceQueueVideo(
  env: VeniceEnv, model: string, prompt: string, opts: VeniceVideoOptions = {},
): Promise<{ queueId: string }> {
  const body: any = {
    model,
    prompt,
    duration: opts.duration || VENICE_VIDEO_DEFAULT_DURATION,
    resolution: opts.resolution || VENICE_VIDEO_DEFAULT_RESOLUTION,
    aspect_ratio: opts.aspectRatio || VENICE_VIDEO_DEFAULT_ASPECT, // REQUIRED — see header
  };
  if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;
  if (opts.imageUrl) body.image_url = opts.imageUrl;
  const j = await venicePost(env, "/video/queue", body, 30000);
  const queueId = String(j?.queue_id ?? j?.id ?? "");
  if (!queueId) throw new Error("venice video: no queue id in response");
  return { queueId };
}

// [VENICE-API-SHAPE-1] Live /video|audio/retrieve behaviour (verified with a
// real completed job): the request REQUIRES { queue_id, model } (model missing
// → "Model is required"), and the response is DUAL-SHAPE — JSON
// { status: "PROCESSING"|... } while pending, but the RAW MEDIA BYTES
// (video/mp4, audio/flac, …) once complete. There is no { status, url } shape
// at all; the docs' url-polling example does not match production.
export interface VeniceRetrieveResult {
  status: string;
  bytes?: Uint8Array;
  mime?: string;
}

async function veniceRetrieveMedia(
  env: VeniceEnv, path: string, queueId: string, model: string,
): Promise<VeniceRetrieveResult> {
  const r = await fetch(`${VENICE_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${veniceKey(env)}` },
    body: JSON.stringify({ queue_id: queueId, model }),
    signal: AbortSignal.timeout(120000),
  });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) {
      const msg = String(j?.error ?? j?.message ?? "unknown").slice(0, 300);
      const err: any = new Error(`venice ${r.status}: ${msg}`);
      err.status = r.status;
      throw err;
    }
    return { status: String(j?.status ?? "unknown") };
  }
  if (!r.ok) throw new Error(`venice retrieve ${r.status} (non-json)`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: "completed", bytes, mime: ct || undefined };
}

export async function veniceRetrieveVideo(
  env: VeniceEnv, queueId: string, model: string,
): Promise<VeniceRetrieveResult> {
  return veniceRetrieveMedia(env, "/video/retrieve", queueId, model);
}

// ── Music (queue + poll) ─────────────────────────────────────────────────────
// ace-step-15 is duration-priced in bands 60/90/120/150/180/210s (verified in
// /models pricing 2026-08-14); minimax-music-v25 is flat and takes no duration.
export const VENICE_MUSIC_MIN_SECONDS = 60;
export const VENICE_MUSIC_MAX_SECONDS = 210;
export const VENICE_MUSIC_DEFAULT_SECONDS = 60;

export function clampMusicSeconds(requested: number | undefined): number {
  const n = Number.isFinite(requested as number) ? Math.round(requested as number) : VENICE_MUSIC_DEFAULT_SECONDS;
  return Math.min(VENICE_MUSIC_MAX_SECONDS, Math.max(VENICE_MUSIC_MIN_SECONDS, n));
}

export interface VeniceMusicOptions {
  /** Only sent for duration-priced models (ace-step-15). Clamped 60–210. */
  durationSeconds?: number;
}

// [VENICE-MUS-1] No `safe_mode` sent here: the spec's NSFW-enforcement layer 1
// ("send the API-level safety param on every image/video call") is scoped to
// image/video only, and Venice's /audio/queue docs (checked 2026-08-14) don't
// document an equivalent field for the music models. The prompt gate
// (moderate(..., field:"venice_music_prompt"), lib/venice_media.ts) is still
// mandatory and unconditional for every music request regardless.
export async function veniceQueueMusic(
  env: VeniceEnv, model: string, prompt: string, opts: VeniceMusicOptions = {},
): Promise<{ queueId: string }> {
  const body: any = { model, prompt };
  // [VENICE-API-SHAPE-1 2026-08-14] Live schema: the field is
  // `duration_seconds` — `duration` is REJECTED ("Unrecognized key"). Verified
  // with a real queued job; /audio/quote accepts { model, duration_seconds }
  // (no prompt) and priced 60s at $0.03 as catalogued.
  if (model === "ace-step-15") body.duration_seconds = clampMusicSeconds(opts.durationSeconds);
  const j = await venicePost(env, "/audio/queue", body, 30000);
  const queueId = String(j?.queue_id ?? j?.id ?? "");
  if (!queueId) throw new Error("venice music: no queue id in response");
  return { queueId };
}

/** [VENICE-API-SHAPE-1] Same dual-shape retrieve as video — JSON while
 *  pending, raw media bytes (audio/flac observed live) once complete. */
export async function veniceRetrieveAudio(
  env: VeniceEnv, queueId: string, model: string,
): Promise<VeniceRetrieveResult> {
  return veniceRetrieveMedia(env, "/audio/retrieve", queueId, model);
}

// ── Chat (sync, OpenAI-compatible) ───────────────────────────────────────────
// [VENICE-CHAT-1] The uncensored-TEXT chat lane only (VENICE_UNCENSORED_CHAT_MODEL
// above) — gated by lib/venice_tier.ts's veniceTier() === "paid" AND the
// veniceUncensoredChatEnabled remote-config flag (routes/config.ts). Everyone
// else stays on the existing Gemma/Gemini ladder untouched. Non-streamed only
// for v1 (do/ava_agent.ts's callThreadModel calls this before its own
// streamed/non-streamed OpenRouter ladder, and only when the Venice branch
// applies) — Venice's /chat/completions is OpenAI-compatible SSE too, so a
// streamed variant can be added later by mirroring composio.ts's orStreamStep
// parser against VENICE_BASE instead of OR_URL.

export interface VeniceChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VeniceChatResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export async function veniceChatComplete(
  env: VeniceEnv, model: string, messages: VeniceChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<VeniceChatResult> {
  const body: any = { model, messages };
  // [AVA-FAST-1 2026-08-14] Owner: gemini-3-7-flash (and every chat call on
  // this lane) must be FAST — no thinking/reasoning pass. Venice-level toggle
  // per docs (guides/features/reasoning-models.mdx): reasoning.enabled=false
  // stops reasoning params from reaching the provider entirely. Pinned for
  // ALL veniceChatComplete callers (lyrics/prompt crafting, uncensored chat) —
  // none of them wants a thinking delay.
  body.reasoning = { enabled: false };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.temperature != null) body.temperature = opts.temperature;
  const j = await venicePost(env, "/chat/completions", body, opts.timeoutMs ?? 30000);
  const content = j?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  const usage = j?.usage ?? {};
  return {
    text,
    tokensIn: Number.isFinite(usage?.prompt_tokens) ? Number(usage.prompt_tokens) : null,
    tokensOut: Number.isFinite(usage?.completion_tokens) ? Number(usage.completion_tokens) : null,
  };
}
