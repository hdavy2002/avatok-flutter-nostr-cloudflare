// [HF-HOST-PLATFORM-1] ElevenLabs client for host sample conversations.
// Endpoints (spike tool/hf_media_spike/spike.py): POST /v1/voices/add (Instant Voice Clone), DELETE /v1/voices/:id,
// POST /v1/text-to-dialogue (eleven_v3), GET /v2/voices (stock voice search).
// Never logs the key, audio bytes, or the host's text. Telemetry: PostHog `$ai_generation` (counts only).
import type { Env } from "../types";
import { track } from "../hooks";
import { BRAND } from "./brand";

const EL = "https://api.elevenlabs.io";
const APP = BRAND.slug;
export const DIALOGUE_MODEL = "eleven_v3";
export const DIALOGUE_FORMAT = "mp3_44100_128";
export const DIALOGUE_MAX_CHARS = 2000;

export type ElResult<T> = ({ ok: true } & T) | { ok: false; reason: string; status: number };
export interface ElTel { uid: string; jobId?: string }

export function elevenConfigured(env: Env): boolean {
  return !!(env.ELEVENLABS_API_KEY ?? "").trim();
}
const hdr = (env: Env, extra: Record<string, string> = {}) => ({ "xi-api-key": (env.ELEVENLABS_API_KEY ?? "").trim(), ...extra });

function reasonOf(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 422 || status === 400) return "invalid_input";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "provider_error" : "failed";
}

function ai(env: Env, tel: ElTel | undefined, span: string, p: Record<string, unknown>): void {
  if (!tel) return;
  void track(env, tel.uid, "$ai_generation", APP, {
    $ai_provider: "elevenlabs", $ai_span_name: span, $ai_trace_id: tel.jobId ?? null, area: "hf_host_media", ...p,
  });
}

const extFor = (mime: string) => (/webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : "mp3");

/** Create an Instant Voice Clone from one audio sample. Caller MUST voiceDelete() it afterwards. */
export async function ivcCreate(env: Env, name: string, audio: ArrayBuffer | Uint8Array, mime: string, tel?: ElTel): Promise<ElResult<{ voiceId: string }>> {
  if (!elevenConfigured(env)) return { ok: false, reason: "not_configured", status: 0 };
  const t0 = Date.now();
  const form = new FormData();
  form.set("name", name.slice(0, 60));
  form.set("description", "temporary clone - deleted after the sample is generated");
  form.append("files", new Blob([audio as any], { type: mime || "audio/mpeg" }), `sample.${extFor(mime)}`);
  try {
    const r = await fetch(`${EL}/v1/voices/add`, { method: "POST", headers: hdr(env), body: form, signal: AbortSignal.timeout(120_000) });
    const j: any = await r.json().catch(() => null);
    ai(env, tel, "hf_voice_clone", { $ai_model: "ivc", ok: r.ok, status: r.status, latency_ms: Date.now() - t0 });
    if (!r.ok || !j?.voice_id) return { ok: false, reason: reasonOf(r.status), status: r.status };
    return { ok: true, voiceId: String(j.voice_id) };
  } catch {
    return { ok: false, reason: "network", status: 0 };
  }
}

/** Delete a voice. 404 counts as success (already gone). */
export async function voiceDelete(env: Env, voiceId: string): Promise<ElResult<{ deleted?: boolean }>> {
  if (!elevenConfigured(env) || !voiceId) return { ok: true };
  try {
    const r = await fetch(`${EL}/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: hdr(env), signal: AbortSignal.timeout(30_000) });
    if (r.ok || r.status === 404) return { ok: true };
    return { ok: false, reason: reasonOf(r.status), status: r.status };
  } catch {
    return { ok: false, reason: "network", status: 0 };
  }
}

/** Two-speaker conversation. Returns mp3 bytes. Text may contain documented v3 audio tags. */
export async function textToDialogue(
  env: Env, inputs: { text: string; voice_id: string }[], languageCode: string | null, tel?: ElTel,
): Promise<ElResult<{ audio: ArrayBuffer; characters: number }>> {
  if (!elevenConfigured(env)) return { ok: false, reason: "not_configured", status: 0 };
  const characters = inputs.reduce((n, i) => n + i.text.length, 0);
  if (characters > DIALOGUE_MAX_CHARS) return { ok: false, reason: "too_long", status: 0 };
  const t0 = Date.now();
  const body: Record<string, unknown> = { inputs, model_id: DIALOGUE_MODEL };
  if (languageCode) body.language_code = languageCode;
  try {
    const r = await fetch(`${EL}/v1/text-to-dialogue?output_format=${DIALOGUE_FORMAT}`, {
      method: "POST", headers: hdr(env, { "content-type": "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(150_000),
    });
    ai(env, tel, "hf_sample_conversation", { $ai_model: DIALOGUE_MODEL, ok: r.ok, status: r.status, characters, latency_ms: Date.now() - t0 });
    if (!r.ok) return { ok: false, reason: reasonOf(r.status), status: r.status };
    const audio = await r.arrayBuffer();
    if (audio.byteLength < 2000) return { ok: false, reason: "empty_audio", status: r.status };
    return { ok: true, audio, characters };
  } catch {
    return { ok: false, reason: "network", status: 0 };
  }
}

// Premade ElevenLabs voices (Rachel / Adam) — last-resort fallback; override with ELEVENLABS_STOCK_VOICE_FEMALE / _MALE.
const FALLBACK = { female: "21m00Tcm4TlvDq8ikWAM", male: "pNInz6obpgDQGcFmaJgB" };

/** A stock (non-cloned) voice for the "caller". gender = 'woman'|'man'|'female'|'male'. Cached 1 day in KV TOKENS. */
export async function pickStockVoice(env: Env, gender: string, lang: string): Promise<string> {
  const g: "female" | "male" = /^(w|f)/i.test(gender) ? "female" : "male";
  const l = (lang || "hi").toLowerCase().slice(0, 2);
  const cfg = (env as any)[g === "female" ? "ELEVENLABS_STOCK_VOICE_FEMALE" : "ELEVENLABS_STOCK_VOICE_MALE"] as string | undefined;
  const fallback = (cfg ?? "").trim() || FALLBACK[g];
  const ck = `hf:el:stock:${g}:${l}`;
  try { const c = await env.TOKENS.get(ck); if (c) return c; } catch { /* no cache */ }
  let pick = "";
  try {
    const r = await fetch(`${EL}/v2/voices?page_size=100&include_total_count=false`, { headers: hdr(env), signal: AbortSignal.timeout(20_000) });
    if (r.ok) {
      const d: any = await r.json().catch(() => null);
      const voices: any[] = Array.isArray(d?.voices) ? d.voices : [];
      const score = (v: any): number => {
        const labels = v?.labels ?? {};
        if (String(labels.gender ?? "").toLowerCase() !== g) return -1;
        const vl: any[] = Array.isArray(v?.verified_languages) ? v.verified_languages : [];
        const langs = new Set(vl.map((x) => String(x?.language ?? "").toLowerCase()));
        let s = 0;
        if (langs.has(l)) s += 10;
        if (v?.category === "premade") s += 2;
        if (/conversation/i.test(String(labels.use_case ?? ""))) s += 1;
        return s;
      };
      const best = voices.map((v) => ({ id: String(v?.voice_id ?? ""), s: score(v) })).filter((x) => x.id && x.s >= 0).sort((a, b) => b.s - a.s)[0];
      if (best) pick = best.id;
    }
  } catch { /* fallback */ }
  const out = pick || fallback;
  try { await env.TOKENS.put(ck, out, { expirationTtl: 86_400 }); } catch { /* cache best-effort */ }
  return out;
}
