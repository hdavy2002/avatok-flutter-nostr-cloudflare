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

// Multilingual (99+ langs), supports transcription AND translation. Override per
// deploy with OPENROUTER_STT_MODEL (e.g. a Groq fast-whisper id for lower latency).
const STT_MODEL_DEFAULT = "openai/whisper-large-v3";
const APP = "avastt";
// Whisper's hard input cap is 25 MB of audio; base64 inflates ~33%, so guard at
// ~33 MB of base64 (~25 MB raw). Short dictation clips are a few hundred KB.
const MAX_B64 = 33 * 1024 * 1024;

export async function sttTranscribe(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return json({ error: "stt unavailable", reason: "OPENROUTER_API_KEY unset" }, 503);

  // Cheap abuse guard: 60 transcriptions / 10 min / user.
  const limited = await rateLimit(env, `stt:${ctx.uid}`, 60, 600);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const data = String(b.audio || "");
  const format = String(b.format || "wav").toLowerCase();
  const lang = String(b.lang || "").trim(); // "" => auto-detect
  const translate = b.translate === true; // Whisper translate task → English
  if (!data) return json({ error: "audio required (base64)" }, 400);
  if (data.length > MAX_B64) return json({ error: "audio too large", max_b64: MAX_B64 }, 413);

  const model = String(b.model || (env as any).OPENROUTER_STT_MODEL || STT_MODEL_DEFAULT);

  const body: Record<string, unknown> = {
    input_audio: { data, format },
    model,
  };
  // Whisper's translate task always targets English and auto-detects the source,
  // so only pass a language hint when we are NOT translating.
  if (translate) body.translate = true;
  else if (lang) body.language = lang;

  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://avatok.ai",
        "X-Title": "AvaTok STT",
      },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      metric(env, "stt_transcribe_fail", [ms, res.status], [model]);
      track(env, ctx.uid, "stt_transcribe", APP, { ok: false, status: res.status, ms, model, b64: data.length });
      return json({ error: "transcription failed", status: res.status, detail }, 502);
    }
    const out = (await res.json().catch(() => ({}))) as any;
    const text = String(out.text || "");
    const seconds = Number(out?.usage?.seconds ?? 0);
    const cost = Number(out?.usage?.cost ?? 0);
    metric(env, "stt_transcribe_ok", [ms, text.length, seconds], [model]);
    track(env, ctx.uid, "stt_transcribe", APP, {
      ok: true, ms, model, translate, lang: lang || "auto",
      chars: text.length, audio_seconds: seconds, cost, b64: data.length,
    });
    return json({ text, seconds, cost });
  } catch (e: any) {
    const ms = Date.now() - t0;
    metric(env, "stt_transcribe_error", [ms], [model]);
    track(env, ctx.uid, "stt_transcribe", APP, { ok: false, error: String(e), ms, model });
    return json({ error: "transcription error", detail: String(e).slice(0, 300) }, 502);
  }
}
