// worker/src/routes/campaign_voices.ts — [AVA-CAMP-Q-VOICES] AI-voice catalog +
// preview for outbound AI calling campaigns.
//
// SOURCE OF TRUTH FOR THE VOICE SET: the campaign agent's live engine is Gemini
// Live (do/vobiz_agent_room.ts's campaign-mode branch sets
// `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` in the BidiGenerateContent
// setup message — see connectGemini()). The 30 names below are EXACTLY the
// prebuilt-voice set routes/receptionist.ts (VOICES, ~L168) and routes/avavoice.ts
// (VOICES, ~L79) already use for that same API — verified to complete the Live
// handshake. A voice id returned here is therefore guaranteed to be a valid
// `voice_name` for the room.
//
// PREVIEW ENGINE: gemini-2.5-flash-preview-tts (Gemini's non-Live REST TTS,
// routes/marketplace.ts's renderNegotiationWav() already uses it for deal audio)
// accepts the SAME `prebuiltVoiceConfig.voiceName` catalog as Gemini Live — so the
// preview is a genuine 1:1 match of what the campaign will actually sound like on
// a call, NOT a closest-sounding substitute from a different voice engine (Deepgram
// Aura-2's `AVA_CF_VOICE` voices are a disjoint namespace and were considered but
// rejected for exactly this reason).
//
// CACHING: rendered previews are short (~3s) and identical for every caller, so
// they're cached in R2 AGENT_AUDIO (avatok-agent-audio — the same bucket
// routes/agent_tts.ts already uses for lazy-TTS caching) keyed by voice id. Repeat
// previews are then a single R2 GET, no Gemini call.
//
//   GET /api/campaigns/voices                 catalog (gate + requireUser)
//   GET /api/campaigns/voices/preview?voice=  short cached sample (gate + requireUser)
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { track } from "../hooks";

const APP = "campaign_voices";

// ---------------------------------------------------------------------------
// Gating — mirrors routes/campaigns.ts's gate() (campaignsEnabled + the beta
// allowlist). Replicated locally rather than imported: campaigns.ts doesn't
// export gate(), and routes/campaign_kb.ts already established this same
// local-copy pattern for sibling campaign route files.
// ---------------------------------------------------------------------------
function parseUidList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function gate(env: Env, uid: string): Promise<{ error: string; status: number } | null> {
  const cfg = await readConfig(env);
  if ((cfg as any).campaignsEnabled !== true) return { error: "disabled", status: 503 };
  if ((cfg as any).campaignOwnerAllowlist === true) {
    const admins = parseUidList(env.ADMIN_UIDS);
    if (!admins.includes(uid)) return { error: "beta access required", status: 403 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Voice catalog — EXACT mirror of receptionist.ts's VOICES set (30 prebuilt
// Gemini Live voices), labelled the same way routes/avavoice.ts's picker does,
// split male/woman the same way receptionist.ts's source comment does.
// ---------------------------------------------------------------------------
interface VoiceEntry { id: string; name: string; gender: "male" | "female"; description: string }

const VOICE_CATALOG: VoiceEntry[] = [
  // female / woman
  { id: "Aoede", name: "Aoede", gender: "female", description: "Breezy" },
  { id: "Kore", name: "Kore", gender: "female", description: "Firm" },
  { id: "Leda", name: "Leda", gender: "female", description: "Youthful" },
  { id: "Zephyr", name: "Zephyr", gender: "female", description: "Bright" },
  { id: "Autonoe", name: "Autonoe", gender: "female", description: "Bright" },
  { id: "Callirrhoe", name: "Callirrhoe", gender: "female", description: "Easy-going" },
  { id: "Despina", name: "Despina", gender: "female", description: "Smooth" },
  { id: "Erinome", name: "Erinome", gender: "female", description: "Clear" },
  { id: "Laomedeia", name: "Laomedeia", gender: "female", description: "Upbeat" },
  { id: "Achernar", name: "Achernar", gender: "female", description: "Soft" },
  { id: "Gacrux", name: "Gacrux", gender: "female", description: "Mature" },
  { id: "Pulcherrima", name: "Pulcherrima", gender: "female", description: "Forward" },
  { id: "Vindemiatrix", name: "Vindemiatrix", gender: "female", description: "Gentle" },
  { id: "Sulafat", name: "Sulafat", gender: "female", description: "Warm" },
  { id: "Achird", name: "Achird", gender: "female", description: "Friendly" },
  { id: "Sadachbia", name: "Sadachbia", gender: "female", description: "Lively" },
  // male / man
  { id: "Puck", name: "Puck", gender: "male", description: "Upbeat" },
  { id: "Charon", name: "Charon", gender: "male", description: "Informative" },
  { id: "Fenrir", name: "Fenrir", gender: "male", description: "Excitable" },
  { id: "Orus", name: "Orus", gender: "male", description: "Firm" },
  { id: "Enceladus", name: "Enceladus", gender: "male", description: "Breathy" },
  { id: "Iapetus", name: "Iapetus", gender: "male", description: "Clear" },
  { id: "Umbriel", name: "Umbriel", gender: "male", description: "Easy-going" },
  { id: "Algieba", name: "Algieba", gender: "male", description: "Smooth" },
  { id: "Algenib", name: "Algenib", gender: "male", description: "Gravelly" },
  { id: "Rasalgethi", name: "Rasalgethi", gender: "male", description: "Informative" },
  { id: "Alnilam", name: "Alnilam", gender: "male", description: "Firm" },
  { id: "Schedar", name: "Schedar", gender: "male", description: "Even" },
  { id: "Zubenelgenubi", name: "Zubenelgenubi", gender: "male", description: "Casual" },
  { id: "Sadaltager", name: "Sadaltager", gender: "male", description: "Knowledgeable" },
];
const VOICE_IDS = new Set(VOICE_CATALOG.map((v) => v.id));
// Exported so do/vobiz_agent_room.ts's campaign-mode init can validate
// campaigns.voice_persona (seeded via campaign_pstn.ts's KV blob) before
// trusting it as a Gemini Live `voice_name` — a bad/legacy value (e.g. a
// free-text persona string predating this catalog) must never reach the
// BidiGenerateContent setup message and break the call.
export const CAMPAIGN_VOICE_IDS = VOICE_IDS;
/** id -> gender lookup, so callers (do/vobiz_agent_room.ts telemetry) can stamp
 *  the correct voice_gender instead of assuming Ava's usual "woman" (campaigns
 *  can now pick a male voice too). */
export const CAMPAIGN_VOICE_GENDER: Record<string, "male" | "female"> =
  Object.fromEntries(VOICE_CATALOG.map((v) => [v.id, v.gender]));

// ---------------------------------------------------------------------------
// Preview TTS — gemini-2.5-flash-preview-tts, single-speaker prebuiltVoiceConfig
// (mirrors routes/marketplace.ts's renderNegotiationWav(), single-speaker instead
// of multiSpeaker). PCM24k -> WAV, same pcmToWav shape marketplace.ts uses for
// voice-note delivery (the app's audio player already plays that format).
// ---------------------------------------------------------------------------
const PREVIEW_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const PREVIEW_SCRIPT = "Hi, this is your AI assistant — here's how I sound.";
const previewKey = (voiceId: string) => `campaign-voice-preview/${voiceId}.wav`;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wrap 24kHz mono 16-bit PCM as a playable WAV. */
function pcmToWav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const ch = 1, bits = 16;
  const byteRate = (sampleRate * ch * bits) / 8, block = (ch * bits) / 8;
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, byteRate, true);
  v.setUint16(32, block, true); v.setUint16(34, bits, true); w(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(head), 0); out.set(pcm, 44);
  return out;
}

/** Synthesize the fixed preview line in one voice. null on any failure — the
 *  caller turns that into a 503, never a 500. */
async function renderPreviewWav(env: Env, voiceId: string): Promise<Uint8Array | null> {
  const key = (env as any).RECEPTIONIST_GEMINI_API_KEY || (env as any).GEMINI_API_KEY;
  if (!key) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${PREVIEW_TTS_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: PREVIEW_SCRIPT }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (typeof data !== "string") return null;
    return pcmToWav(b64ToBytes(data));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/voices
// ---------------------------------------------------------------------------
async function listVoices(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const g = await gate(env, ctx.uid);
  if (g) return json({ error: g.error }, g.status);
  return json({ voices: VOICE_CATALOG.map((v) => ({ id: v.id, name: v.name, gender: v.gender, description: v.description })) });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/voices/preview?voice=<id>
// ---------------------------------------------------------------------------
async function previewVoice(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const g = await gate(env, ctx.uid);
  if (g) return json({ error: g.error }, g.status);

  const voiceId = new URL(req.url).searchParams.get("voice") || "";
  if (!VOICE_IDS.has(voiceId)) return json({ error: "unknown voice" }, 400);

  const key = previewKey(voiceId);
  try {
    const cached = await env.AGENT_AUDIO.get(key);
    if (cached) {
      track(env, ctx.uid, "campaign_voice_preview_cache_hit", APP, { voice: voiceId });
      return new Response(cached.body, {
        headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" },
      });
    }
  } catch { /* R2 miss/error — fall through to synthesize */ }

  const wav = await renderPreviewWav(env, voiceId);
  if (!wav) {
    track(env, ctx.uid, "campaign_voice_preview_failed", APP, { voice: voiceId });
    return json({ error: "preview synthesis unavailable, try again" }, 503);
  }

  try {
    await env.AGENT_AUDIO.put(key, wav, { httpMetadata: { contentType: "audio/wav" } });
  } catch { /* cache best-effort — still serve the render below */ }

  track(env, ctx.uid, "campaign_voice_preview_synthesized", APP, { voice: voiceId, bytes: wav.length });
  return new Response(wav, {
    headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function campaignVoicesRoute(req: Request, env: Env, path: string): Promise<Response> {
  try {
    if (path === "/api/campaigns/voices" && req.method === "GET") return await listVoices(req, env);
    if (path === "/api/campaigns/voices/preview" && req.method === "GET") return await previewVoice(req, env);
    return json({ error: "not found" }, 404);
  } catch (e) {
    // Never 500 — the widest possible net around this route.
    return json({ error: "campaign voices unavailable", detail: String(e).slice(0, 200) }, 503);
  }
}
