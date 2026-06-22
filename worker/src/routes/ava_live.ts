// ava_live.ts — the FAST "Voice call Ava" path: Gemini Live native-audio.
//
//   POST /api/ava/live/token  → a short-lived ephemeral token whose config
//   (native-audio model + Ava's companion persona + prebuilt voice + input/output
//   transcription) is LOCKED server-side, so a tampered client can't change the
//   model or persona. The client connects DIRECTLY to the Gemini Live websocket
//   with this token (audio in/out streamed) for ~sub-second latency.
//
// This is the online counterpart to the on-device VAD→Whisper→Gemini→Supertonic
// pipeline; the user picks "Fast (online)" vs "Private (on-device)" per the
// VoiceCallMode toggle. Mirrors routes/translate.ts mintToken.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";

const LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
// Warm, natural prebuilt Gemini voice. (Swap if a different timbre is preferred.)
const VOICE_NAME = "Aoede";

const SYSTEM =
  "You are Ava, a warm, friendly voice companion talking with the user hands-free. " +
  "Reply with ONE short, natural spoken sentence (about 20 words). No markdown, no " +
  "lists, no emojis. Be direct and conversational. You can role-play characters or " +
  "give advice when asked. If you didn't catch something, ask them to repeat briefly.";

async function mintToken(
  env: Env,
): Promise<{ token: string; model: string; expires_at: number } | { error: string }> {
  if (!env.GEMINI_API_KEY) return { error: "voice unavailable: GEMINI_API_KEY unset" };
  const expireMs = Date.now() + 30 * 60_000;
  const body = {
    uses: 1,
    expireTime: new Date(expireMs).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
      },
      systemInstruction: { parts: [{ text: SYSTEM }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
  const r = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j?.name) return { error: `token mint failed (${r.status}): ${j?.error?.message ?? "unknown"}` };
  return { token: String(j.name), model: LIVE_MODEL, expires_at: expireMs };
}

// POST /api/ava/live/token — auth required; returns { token, model, expires_at }.
export async function avaLiveToken(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const t = await mintToken(env);
  if ("error" in t) return json({ error: t.error }, 502);
  return json(t);
}
