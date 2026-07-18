// Sarvam AI TTS (Bulbul v3) for the CF receptionist (RECEPT-TTS-SARVAM, owner
// 2026-07-19). POST /text-to-speech returns base64-encoded WAV in an `audios`
// array; we join → decode → strip the WAV header → raw PCM16, the shape cfSpeak()
// streams to the caller. Returns null on ANY failure so cfSpeak falls back to the
// existing Google/Deepgram path (an outage never silences Ava; disable by unsetting
// RECEPT_CF_TTS_PROVIDER). Auth header: api-subscription-key (sk_… key).
// Docs (via Context7): https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert

// base 22-language → BCP-47 region default (Bulbul only speaks Indian langs + en-IN).
const SARVAM_REGION: Record<string, string> = {
  en: "en-IN", hi: "hi-IN", bn: "bn-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN",
  mr: "mr-IN", od: "od-IN", or: "od-IN", pa: "pa-IN", ta: "ta-IN", te: "te-IN",
  as: "as-IN", ur: "ur-IN", ne: "ne-IN", sa: "sa-IN",
};
function sarvamLang(code: string | null | undefined, def: string): string {
  const c = (code || "").trim();
  if (!c) return def;
  if (c.includes("-") || c.includes("_")) return c.replace("_", "-");
  return SARVAM_REGION[c.toLowerCase()] || def;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
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

export interface SarvamTtsReq {
  text: string;
  langCode?: string | null;
  speaker?: string;      // female speaker (v2: anushka/manisha/…, v3: priya/…)
  model?: string;        // "bulbul:v2" (cheaper) | "bulbul:v3"
  defaultLang?: string;  // BCP-47 when langCode empty (default en-IN)
  sampleRate?: number;   // default 24000
}

/** Saarika v2.5 STT: transcribe a WAV clip with AUTO language detection (handles
 *  code-mixed Hindi/English natively). Returns { transcript, lang } or null on any
 *  failure so the caller falls back to Workers AI Whisper. Never throws. */
export async function sarvamSttTranscribe(env: unknown, wav: Uint8Array): Promise<{ transcript: string; lang: string } | null> {
  try {
    const key = (env as { SARVAM_API_KEY?: string }).SARVAM_API_KEY;
    if (!key || !wav?.byteLength) return null;
    const fd = new FormData();
    fd.append("model", "saarika:v2.5");
    fd.append("language_code", "unknown"); // auto-detect, incl. code-mixed speech
    fd.append("file", new Blob([wav as unknown as BlobPart], { type: "audio/wav" }), "turn.wav");
    const r = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST", headers: { "api-subscription-key": key }, body: fd,
    });
    if (!r.ok) return null;
    const j = await r.json() as { transcript?: string; language_code?: string | null };
    const t = String(j.transcript ?? "").trim();
    return t ? { transcript: t, lang: String(j.language_code ?? "").trim() } : null;
  } catch { return null; }
}

/** Bulbul v3 → PCM16 @sampleRate mono, or null on any failure. Never throws. */
export async function sarvamTtsPcm(env: unknown, opts: SarvamTtsReq): Promise<Uint8Array | null> {
  try {
    const key = (env as { SARVAM_API_KEY?: string }).SARVAM_API_KEY;
    if (!key || !opts.text) return null;
    const sr = opts.sampleRate || 24000;
    const body = {
      text: opts.text.slice(0, 2400),
      target_language_code: sarvamLang(opts.langCode, opts.defaultLang || "en-IN"),
      model: opts.model || "bulbul:v2",
      speaker: (opts.speaker || "anushka").toLowerCase(),
      speech_sample_rate: sr,
      output_audio_codec: "wav",
    };
    const r = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "api-subscription-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = await r.json() as { audios?: string[] };
    if (!Array.isArray(j.audios) || !j.audios.length) return null;
    const pcm = stripWav(b64ToBytes(j.audios.join("")));  // join base64 chunks → one WAV → PCM16
    return pcm.length ? pcm : null;
  } catch {
    return null;
  }
}
