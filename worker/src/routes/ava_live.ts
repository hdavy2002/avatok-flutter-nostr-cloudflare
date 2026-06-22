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
// All 30 prebuilt Gemini Live voices (verified accepted by gemini-3.1-flash-live).
const VOICES = new Set([
  "Aoede", "Kore", "Leda", "Zephyr", "Autonoe", "Callirrhoe", "Despina", "Erinome",
  "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat",
  "Achird", "Sadachbia",
  "Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Zubenelgenubi", "Sadaltager",
]);

// Call languages the client may request. Each BCP-47 code is verified to complete
// the Gemini Live handshake; '' (absent) = Auto (model detects the language).
const LANGS: Record<string, string> = {
  "en-US": "English", "en-GB": "English", "es-ES": "Spanish", "es-US": "Spanish",
  "fr-FR": "French", "de-DE": "German", "it-IT": "Italian", "pt-BR": "Portuguese",
  "nl-NL": "Dutch", "pl-PL": "Polish", "ru-RU": "Russian", "tr-TR": "Turkish",
  "ar-XA": "Arabic", "hi-IN": "Hindi", "bn-IN": "Bengali", "ta-IN": "Tamil",
  "te-IN": "Telugu", "mr-IN": "Marathi", "gu-IN": "Gujarati", "kn-IN": "Kannada",
  "ml-IN": "Malayalam", "id-ID": "Indonesian", "vi-VN": "Vietnamese", "th-TH": "Thai",
  "ja-JP": "Japanese", "ko-KR": "Korean", "cmn-CN": "Mandarin Chinese",
};

function systemPrompt(firstName: string, langName: string): string {
  const who = firstName ? ` You are speaking with ${firstName}; address them by name naturally.` : "";
  // When a language is chosen, pin Ava to it (belt-and-braces with speechConfig.languageCode).
  const lang = langName ? ` Always speak to the user in ${langName}.` : "";
  return (
    "You are Ava, a warm, friendly voice companion talking with the user hands-free." +
    who + lang +
    " Reply with ONE short, natural spoken sentence (about 20 words). No markdown, no" +
    " lists, no emojis. Be direct and conversational. You can role-play or give advice." +
    " If you didn't catch something, ask them to repeat briefly."
  );
}

async function mintToken(
  env: Env,
  voice: string,
  firstName: string,
  lang: string,
): Promise<{ token: string; model: string; expires_at: number } | { error: string }> {
  if (!env.GEMINI_API_KEY) return { error: "voice unavailable: GEMINI_API_KEY unset" };
  const voiceName = VOICES.has(voice) ? voice : DEFAULT_VOICE;
  // Validate the requested language; unknown/empty → Auto (no languageCode).
  const langCode = LANGS[lang] ? lang : "";
  const langName = langCode ? LANGS[langCode] : "";
  // 2h token lifetime so a long call can run in ONE session (sliding-window
  // compression keeps the running context — and tokens — bounded).
  const expireMs = Date.now() + 120 * 60_000;
  const body = {
    uses: 1,
    expireTime: new Date(expireMs).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          // Only set when the user picked a specific language; omit for Auto.
          ...(langCode ? { languageCode: langCode } : {}),
        },
      },
      systemInstruction: { parts: [{ text: systemPrompt(firstName, langName) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // COST CONTROL — the Live API re-feeds the whole growing session context each
      // turn, so a long chatty call costs super-linearly. Sliding-window compression
      // bounds the re-fed context → ~linear. Explicit trigger/target (int64 = string).
      contextWindowCompression: { triggerTokens: "16000", slidingWindow: { targetTokens: "8000" } },
      // Lets the client reconnect within the token lifetime without re-minting.
      sessionResumption: {},
      // TURN DETECTION / barge-in tuning. On loudspeaker, Ava's own audio can leak
      // into the mic and the model mistakes it for the user talking, cutting her
      // off mid-sentence. Make start-of-speech LESS trigger-happy — LOW start
      // sensitivity + a 300ms prefix so a brief echo blip doesn't count as speech —
      // while still allowing a genuine, sustained interruption. Gemini's native VAD
      // then handles natural turn-taking. (endOfSpeech HIGH keeps the user's turn
      // ending promptly; ~700ms silence tolerates natural pauses.)
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs: 300,
          silenceDurationMs: 700,
        },
      },
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

// POST /api/ava/live/token { voice?, name?, lang? } — auth required; returns { token, model }.
export async function avaLiveToken(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let voice = DEFAULT_VOICE;
  let firstName = "";
  let lang = "";
  try {
    const b: any = await req.json();
    if (typeof b?.voice === "string") voice = b.voice;
    if (typeof b?.name === "string") firstName = b.name.trim().split(/\s+/)[0].slice(0, 40);
    if (typeof b?.lang === "string") lang = b.lang.trim();
  } catch { /* no body */ }
  const t = await mintToken(env, voice, firstName, lang);
  if ("error" in t) return json({ error: t.error }, 502);
  return json(t);
}
