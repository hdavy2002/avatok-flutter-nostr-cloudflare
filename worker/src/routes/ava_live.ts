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

// Gemini 3.1 Flash Live — Google's flagship low-latency audio-to-audio model.
// Verified working on generativelanguage.googleapis.com (Developer API) via a live
// BidiGenerateContent test (setupComplete + audio greeting). NOTE: the Vertex name
// "gemini-live-2.5-flash-native-audio" does NOT exist on this endpoint (close 1008).
const LIVE_MODEL = "gemini-3.1-flash-live-preview";
// Default prebuilt Gemini voice; the client may request another from this allowlist.
const DEFAULT_VOICE = "Aoede";
const VOICES = new Set([
  "Aoede", "Kore", "Leda", "Zephyr", "Callirrhoe", "Autonoe", // female
  "Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", // male
]);

function systemPrompt(firstName: string): string {
  const who = firstName ? ` You are speaking with ${firstName}; address them by name naturally.` : "";
  return (
    "You are Ava, a warm, friendly voice companion talking with the user hands-free." +
    who +
    " Reply with ONE short, natural spoken sentence (about 20 words). No markdown, no" +
    " lists, no emojis. Be direct and conversational. You can role-play or give advice." +
    " If you didn't catch something, ask them to repeat briefly."
  );
}

async function mintToken(
  env: Env,
  voice: string,
  firstName: string,
): Promise<{ token: string; model: string; expires_at: number } | { error: string }> {
  if (!env.GEMINI_API_KEY) return { error: "voice unavailable: GEMINI_API_KEY unset" };
  const voiceName = VOICES.has(voice) ? voice : DEFAULT_VOICE;
  const expireMs = Date.now() + 30 * 60_000;
  const body = {
    uses: 1,
    expireTime: new Date(expireMs).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
      systemInstruction: { parts: [{ text: systemPrompt(firstName) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // COST CONTROL — the Live API re-feeds the whole growing session context each
      // turn, so a long chatty call costs super-linearly. Sliding-window compression
      // bounds the re-fed context → ~linear. Explicit trigger/target (int64 = string).
      contextWindowCompression: { triggerTokens: "16000", slidingWindow: { targetTokens: "8000" } },
      // Lets the client reconnect within the token lifetime without re-minting.
      sessionResumption: {},
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

// POST /api/ava/live/token { voice?, name? } — auth required; returns { token, model }.
export async function avaLiveToken(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let voice = DEFAULT_VOICE;
  let firstName = "";
  try {
    const b: any = await req.json();
    if (typeof b?.voice === "string") voice = b.voice;
    if (typeof b?.name === "string") firstName = b.name.trim().split(/\s+/)[0].slice(0, 40);
  } catch { /* no body */ }
  const t = await mintToken(env, voice, firstName);
  if ("error" in t) return json({ error: t.error }, 502);
  return json(t);
}
