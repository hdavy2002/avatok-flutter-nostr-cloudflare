// DeepInfra providers for the CF receptionist (RECEPT-DEEPINFRA, owner 2026-07-21).
// A THIRD, switchable set of STT/LLM/TTS providers for the Cloudflare-native
// receptionist engine (do/reception_room_cf.ts) — used ONLY when the
// RECEPT_CF_*_PROVIDER switches are set to "deepinfra". The Gemini engine
// (do/reception_room.ts) is NOT touched by any of this.
//
//   STT  Voxtral-Mini-3B-2507  POST /v1/inference/mistralai/Voxtral-Mini-3B-2507
//   LLM  Qwen3-32B             POST /v1/openai/chat/completions  (OpenAI-compatible)
//   TTS  Kokoro-82M            POST /v1/inference/hexgrad/Kokoro-82M
//
// One bearer token for all three: env.DEEPINFRA_TOKEN. Every function is
// best-effort and returns null on ANY failure so the CF engine falls back to its
// existing provider chain (Whisper / Workers-AI Llama / Google), i.e. a DeepInfra
// outage never silences Ava. Disable the whole set by unsetting the provider
// switches — no redeploy.
//
// ⚠️ VERIFY ON FIRST LIVE CALL (cannot be unit-tested here):
//  1. Voxtral ASR request shape (multipart `audio`) + transcript field name.
//  2. Kokoro `output_format:"pcm"` returns 24 kHz mono S16LE (matches the client);
//     confirm the response carries base64 PCM (data-URI or raw) and NOT mp3.
//  3. Qwen3-32B thinking is OFF (chat_template_kwargs.enable_thinking=false) so no
//     <think> block reaches TTS.

const DEEPINFRA_BASE = "https://api.deepinfra.com";
const VOXTRAL_MODEL = "mistralai/Voxtral-Mini-3B-2507";
const KOKORO_MODEL = "hexgrad/Kokoro-82M";

function token(env: unknown): string | undefined {
  return (env as { DEEPINFRA_TOKEN?: string }).DEEPINFRA_TOKEN;
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64; // strip a data: URI prefix
  const bin = atob(clean);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Strip a leading RIFF/WAVE header if the model returned a WAV instead of raw PCM. */
function stripWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    for (let i = 12; i + 8 <= bytes.length; ) {
      const id = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
      if (id === "data") return bytes.subarray(i + 8, Math.min(i + 8 + size, bytes.length));
      i += 8 + size + (size & 1);
    }
    return bytes.subarray(44);
  }
  return bytes;
}

/** Voxtral-Mini STT: transcribe a WAV clip (the post-VAD endpointed segment).
 *  Returns { transcript, lang } or null on any failure. Never throws. */
export async function deepInfraStt(
  env: unknown, wav: Uint8Array,
): Promise<{ transcript: string; lang: string } | null> {
  try {
    const key = token(env);
    if (!key || !wav?.byteLength) return null;
    const fd = new FormData();
    fd.append("audio", new Blob([wav as unknown as BlobPart], { type: "audio/wav" }), "turn.wav");
    const r = await fetch(`${DEEPINFRA_BASE}/v1/inference/${VOXTRAL_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!r.ok) return null;
    const j = await r.json() as {
      text?: string; transcription?: string;
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      language?: string | null; detected_language?: string | null;
    };
    const t = String(
      j.text ?? j.transcription ?? j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "",
    ).trim();
    return t ? { transcript: t, lang: String(j.language ?? j.detected_language ?? "").trim() } : null;
  } catch { return null; }
}

export interface DeepInfraTtsReq {
  text: string;
  voices?: string[];     // Kokoro preset voice(s); default ["af_bella"] (warm female)
  outputFormat?: string; // "pcm" (default, streamable to the call) | "mp3"
}

/** Kokoro-82M → PCM16 @24 kHz mono (output_format "pcm"), or null on any failure.
 *  Kokoro natively renders at 24 kHz, which matches the caller's 24 kHz-out contract,
 *  so no resampling is needed. Never throws. */
export async function deepInfraTtsPcm(env: unknown, opts: DeepInfraTtsReq): Promise<Uint8Array | null> {
  try {
    const key = token(env);
    if (!key || !opts.text) return null;
    const body = {
      text: opts.text.slice(0, 2000),
      output_format: opts.outputFormat || "pcm",
      preset_voice: opts.voices && opts.voices.length ? opts.voices : ["af_bella"],
    };
    const r = await fetch(`${DEEPINFRA_BASE}/v1/inference/${KOKORO_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    // Kokoro may return raw audio bytes OR a JSON envelope carrying base64 audio.
    if (ct.includes("application/json")) {
      const j = await r.json() as { audio?: string; output?: string; audios?: string[] };
      const b64 = j.audio ?? j.output ?? (Array.isArray(j.audios) ? j.audios.join("") : undefined);
      if (!b64) return null;
      const pcm = stripWav(b64ToBytes(b64));
      return pcm.length ? pcm : null;
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    const pcm = stripWav(buf);
    return pcm.length ? pcm : null;
  } catch { return null; }
}
