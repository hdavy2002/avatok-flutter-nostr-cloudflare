// Shared zero-cost voicemail greeting engine (AVA-RECEPT-VM-4, owner 2026-07-19).
// ONE greeting store used by BOTH voicemail lanes:
//   • AvaTOK in-app calls  → ReceptionRoomCf VM mode (streams PCM over the client WS)
//   • Vobiz PSTN DID calls → routes/pstn.ts (serves the same audio via a <Play> URL)
// The owner picks ONE language in the voicemail settings; all scenario greetings are
// rendered in it (Bulbul v3 for Indian languages, Google Chirp 3 HD otherwise),
// cached in R2 (AGENT_AUDIO) under a content-hash key, and replayed free forever.
// A name/language change changes the text → new hash → auto re-render on next use.
import type { Env } from "../types";
import { sarvamTtsPcm } from "./sarvam";
import { googleSynthesizeForLang } from "./google_tts";

export type VmScenario = "rings" | "decline" | "busy" | "unreachable";

const INDIAN = new Set(["", "en", "hi", "bn", "gu", "kn", "ml", "mr", "od", "or", "pa", "ta", "te", "as", "ur", "ne", "sa"]);
function base(code: string | null | undefined): string {
  const c = (code || "").trim().toLowerCase();
  if (!c) return "";
  if (c.startsWith("cmn")) return "zh";
  return c.split(/[-_]/)[0];
}

/** Scenario greeting text (name-free of the CALLER; the OWNER's label only, so the
 *  cache is per-owner). Hindi templates when the owner's language is Hindi. */
export function vmGreetingText(ownerLabel: string, langCode: string | null | undefined, scenario: VmScenario): string {
  const hi = base(langCode) === "hi";
  const who = (ownerLabel || "").trim() || "the person you called";
  switch (scenario) {
    case "decline":
      return hi
        ? `नमस्ते! ${who} अभी व्यस्त हैं — कृपया बाद में कॉल करें, या बीप के बाद अपना संदेश छोड़ दीजिए।`
        : `Hi! ${who} is busy right now — please call later, or leave a voice mail after the beep.`;
    case "unreachable":
      return hi
        ? `नमस्ते! ${who} का फ़ोन अभी बंद है — कृपया बीप के बाद अपना संदेश छोड़ दीजिए।`
        : `Hi! ${who}'s phone is off — please leave a message after the beep.`;
    case "busy":
      return hi
        ? `नमस्ते! ${who} अभी दूसरी कॉल पर हैं — कृपया बीप के बाद अपना संदेश छोड़ दीजिए।`
        : `Hi! ${who} is on another call — please leave a message after the beep.`;
    default: // rings / no answer
      return hi
        ? `नमस्ते! लगता है ${who} अभी कॉल नहीं उठा पा रहे — शायद व्यस्त हों या फ़ोन साइलेंट पर हो। कृपया बीप के बाद अपना संदेश छोड़ दीजिए।`
        : `Hi! Seems like ${who} is not picking up the call — might be busy, or the phone is on silent. Kindly leave a message after the beep.`;
  }
}

async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VmGreetingResult { pcm: Uint8Array; hash: string; key: string; cached: boolean; engine: string; }

/** Get-or-render a greeting for exact `text` in `langCode`, cached per owner.
 *  Returns null only if BOTH TTS providers fail AND there is no cache. */
export async function getOrRenderVmGreeting(
  env: Env, ownerUid: string, text: string, langCode: string | null | undefined,
): Promise<VmGreetingResult | null> {
  const useSarvam = INDIAN.has(base(langCode));
  const voice = useSarvam ? String((env as any).RECEPT_CF_SARVAM_SPEAKER || "anushka") : "chirp3-hd-auto";
  const engine = useSarvam ? "bulbul:v3" : "google:chirp3";
  const hash = await sha1Hex(`${text}|${voice}|${engine}|24000`);
  const key = `recept_vm_greeting/${ownerUid}/${hash}.pcm`;
  try {
    const obj = await (env as any).AGENT_AUDIO?.get(key);
    if (obj) return { pcm: new Uint8Array(await obj.arrayBuffer()), hash, key, cached: true, engine };
  } catch { /* miss */ }
  let pcm = useSarvam
    ? await sarvamTtsPcm(env, { text, langCode, model: "bulbul:v3", speaker: voice, defaultLang: "en-IN", sampleRate: 24000 })
    : await googleSynthesizeForLang(env, { text, langCode, tier: "chirp3", defaultLang: "en-IN", sampleRate: 24000 });
  if (!pcm) pcm = useSarvam // cross-provider fallback: an outage never silences the caller
    ? await googleSynthesizeForLang(env, { text, langCode, tier: "chirp3", defaultLang: "en-IN", sampleRate: 24000 })
    : await sarvamTtsPcm(env, { text, langCode, model: "bulbul:v3", speaker: "anushka", defaultLang: "en-IN", sampleRate: 24000 });
  if (!pcm) return null;
  try { await (env as any).AGENT_AUDIO?.put(key, pcm, { httpMetadata: { contentType: "application/octet-stream" } }); } catch { /* best-effort */ }
  return { pcm, hash, key, cached: false, engine };
}

/** Pre-render ALL scenario greetings for an owner (called on settings save so the
 *  first real call never pays render latency). Best-effort; failures are silent —
 *  the call path lazily re-renders on miss anyway. */
export async function prerenderVmGreetings(env: Env, ownerUid: string, ownerLabel: string, langCode: string | null | undefined): Promise<void> {
  const scenarios: VmScenario[] = ["rings", "decline", "busy", "unreachable"];
  await Promise.all(scenarios.map(async (s) => {
    try { await getOrRenderVmGreeting(env, ownerUid, vmGreetingText(ownerLabel, langCode, s), langCode); } catch { /* best-effort */ }
  }));
}

/** Wrap cached raw PCM16 mono @24k in a WAV header (for the Vobiz <Play> URL). */
export function pcmToWavBytes(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const dataLen = pcm.byteLength;
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, dataLen, true);
  out.set(pcm, 44);
  return out;
}
