// Speech-to-text — OpenAI Whisper via OpenRouter.
//
// Replaces the REMOVED on-device sherpa-onnx voice stack (which shipped a ~30 MB
// native runtime — libonnxruntime/libsherpa — in the APK and downloaded ~130 MB
// of Whisper/VAD model files on first use). The device now records a short clip
// and POSTs it here; we forward it to OpenRouter's audio-transcription endpoint
// with the server's OPENROUTER_API_KEY and return the text.
//
//   POST /api/stt/transcribe  { audio: <base64>, format?: "wav", lang?, translate? }
//                             → { text, seconds, cost }
//
// Why server-side: the API key never ships in the app, and we can rate-limit /
// meter. No audio is persisted and no transcript text is logged — only counters
// (chars/seconds/cost) for observability. `translate:true` uses Whisper's
// translate task (source language → English); for an arbitrary target language
// transcribe here, then translate the text via the existing Gemini path.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, metric } from "../hooks";
import { audioTranscribeModel } from "../lib/ava_reason/policy";

// [ONEBRAIN-B0] Strict server-side allowlist of the STT models we actually use.
// The client may request a model (b.model), but only these are honoured — an
// unknown model is a 400, so a caller can't point our OPENROUTER_API_KEY at an
// arbitrary/expensive model. The env override (OPENROUTER_STT_MODEL, read via
// policy.ts's audioTranscribeModel()) is server-controlled and therefore
// always trusted, even if not in this set.
const STT_MODEL_ALLOWLIST = new Set<string>([
  "openai/whisper-large-v3",       // default (multilingual, transcribe + translate)
  "openai/whisper-1",              // OpenAI hosted whisper
  "groq/whisper-large-v3",         // faster hosted whisper
  "groq/whisper-large-v3-turbo",   // low-latency variant
]);
const APP = "avastt";
// Whisper's hard input cap is 25 MB of audio; base64 inflates ~33%, so guard at
// ~33 MB of base64 (~25 MB raw). Short dictation clips are a few hundred KB.
const MAX_B64 = 33 * 1024 * 1024;
// [AVA-AUDIO-ARTIFACT-1] Outage guard on the provider fetch itself — distinct
// from queues/ai_media.ts's overall PROVIDER_TIMEOUT_MS (which bounds the
// WHOLE handler, extraction+translation included); this bounds just the
// Whisper call so a hung fetch classifies as provider_timeout instead of
// silently outliving the request.
const FETCH_TIMEOUT_MS = 30_000;

const MIME_TO_STT_FORMAT: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "webm",
};
/** Best-effort mime -> Whisper input_audio.format. Unknown mimes default to
 *  "wav" (Whisper is lenient about container/format mismatches for common
 *  codecs) rather than failing — see queues/ai_media.ts's callers. */
export function sttFormatFor(mime: string): string {
  return MIME_TO_STT_FORMAT[String(mime || "").toLowerCase()] || "wav";
}

// Workers runtime has no Buffer — chunked to avoid a call-stack blowup on
// String.fromCharCode(...bigArray) for multi-MB audio files.
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export interface TranscribeAudioBufferOptions {
  format: string;
  lang?: string;
  translate?: boolean; // Whisper translate task → English
  model?: string;       // must be on STT_MODEL_ALLOWLIST when supplied
}
export interface TranscribeAudioBufferResult {
  text: string;
  seconds: number;
  /** Provider-reported cost (OpenRouter usage.cost, USD), converted to
   *  MICRO-USD — ground truth for ai_billing.ts's settleAiJob. null when the
   *  provider didn't report one (settleAiJob then falls back to the
   *  AI_PRICE_CATALOG avSecondMicroUsd estimate for this model). */
  costUsdMicro: number | null;
  model: string;
  language: string | null;
}

/**
 * [AVA-AUDIO-ARTIFACT-1 / §46] Worker-callable transcription core — the SAME
 * OpenRouter Whisper call the HTTP route below makes, factored out so
 * queues/ai_media.ts's job consumer calls it DIRECTLY (no internal HTTP
 * round-trip to this worker's own route, no requireUser/session context
 * needed — job authorization already happened at createAiMediaJob() time).
 * Throws `Error("<code>: detail")` using the SAFE lower_snake_case error-code
 * vocabulary queues/ai_media.ts's classifyJobError() recognises
 * (provider_timeout, provider_unavailable, unsupported_format,
 * input_too_large) — never a raw provider message as the code itself.
 */
export async function transcribeAudioBuffer(env: Env, base64: string, opts: TranscribeAudioBufferOptions): Promise<TranscribeAudioBufferResult> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("provider_unavailable: OPENROUTER_API_KEY unset");
  if (!base64) throw new Error("unsupported_format: audio required (base64)");
  if (base64.length > MAX_B64) throw new Error(`input_too_large: audio exceeds max size (${MAX_B64} base64 bytes)`);

  const requested = opts.model ? String(opts.model) : "";
  let model: string;
  if (requested) {
    if (!STT_MODEL_ALLOWLIST.has(requested)) throw new Error(`unsupported_format: model ${requested} not allowed`);
    model = requested;
  } else {
    model = audioTranscribeModel(env);
  }

  const body: Record<string, unknown> = { input_audio: { data: base64, format: opts.format }, model };
  // Whisper's translate task always targets English and auto-detects the source,
  // so only pass a language hint when we are NOT translating.
  if (opts.translate) body.translate = true;
  else if (opts.lang) body.language = opts.lang;

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://avatok.ai",
        "X-Title": "AvaTok STT",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new Error(`${timedOut ? "provider_timeout" : "provider_unavailable"}: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 413) throw new Error(`input_too_large: ${detail}`);
    throw new Error(`provider_unavailable: whisper ${res.status} ${detail}`);
  }
  const out = (await res.json().catch(() => ({}))) as any;
  const text = String(out.text || "");
  const seconds = Number(out?.usage?.seconds ?? 0);
  const costUsdMicro = typeof out?.usage?.cost === "number" ? Math.round(out.usage.cost * 1_000_000) : null;
  return { text, seconds, costUsdMicro, model, language: opts.translate ? "en" : (opts.lang || null) };
}

// POST /api/stt/transcribe { audio: <base64>, format?: "wav", lang?, translate? }
//                           → { text, seconds, cost }
// Short-clip HTTP path (in-app dictation) — delegates to transcribeAudioBuffer
// above. Durable FILE jobs (voice-note Transcribe/Translate context-menu
// actions) go through worker/src/lib/ai_media_jobs.ts + queues/ai_media.ts
// instead, which call transcribeAudioBuffer directly (§46).
export async function sttTranscribe(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  // Cheap abuse guard: 60 transcriptions / 10 min / user.
  const limited = await rateLimit(env, `stt:${ctx.uid}`, 60, 600);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const data = String(b.audio || "");
  const format = String(b.format || "wav").toLowerCase();
  const lang = String(b.lang || "").trim(); // "" => auto-detect
  const translate = b.translate === true; // Whisper translate task → English
  const requestedModel = b.model != null ? String(b.model) : undefined;

  const t0 = Date.now();
  try {
    const result = await transcribeAudioBuffer(env, data, { format, lang: lang || undefined, translate, model: requestedModel });
    const ms = Date.now() - t0;
    metric(env, "stt_transcribe_ok", [ms, result.text.length, result.seconds], [result.model]);
    track(env, ctx.uid, "stt_transcribe", APP, {
      ok: true, ms, model: result.model, translate, lang: lang || "auto",
      chars: result.text.length, audio_seconds: result.seconds,
      cost: result.costUsdMicro != null ? result.costUsdMicro / 1_000_000 : 0, b64: data.length,
    });
    return json({ text: result.text, seconds: result.seconds, cost: result.costUsdMicro != null ? result.costUsdMicro / 1_000_000 : 0 });
  } catch (e: any) {
    const ms = Date.now() - t0;
    const msg = String(e?.message ?? e);
    const code = /^([a-z_]+):/.exec(msg)?.[1] || "provider_unavailable";
    metric(env, "stt_transcribe_fail", [ms], [requestedModel || audioTranscribeModel(env)]);
    track(env, ctx.uid, "stt_transcribe", APP, { ok: false, error_code: code, ms, model: requestedModel || audioTranscribeModel(env) });
    if (code === "unsupported_format" && /model .* not allowed/.test(msg)) {
      return json({ error: "unsupported model", model: requestedModel }, 400);
    }
    if (code === "unsupported_format" && /audio required/.test(msg)) {
      return json({ error: "audio required (base64)" }, 400);
    }
    if (code === "input_too_large") return json({ error: "audio too large", max_b64: MAX_B64 }, 413);
    if (code === "provider_unavailable" && /OPENROUTER_API_KEY unset/.test(msg)) {
      return json({ error: "stt unavailable", reason: "OPENROUTER_API_KEY unset" }, 503);
    }
    return json({ error: "transcription error", error_code: code, detail: msg.replace(/^[a-z_]+:\s*/, "").slice(0, 300) }, 502);
  }
}
