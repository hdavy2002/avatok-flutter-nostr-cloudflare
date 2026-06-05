// Lazy TTS for agent conversations (Phase 8, §20.5). Audio is synthesized ONLY when
// a user taps "Listen" — never ahead of time (~90% fewer TTS calls). Each message is
// voiced with its speaker's stable per-npub voice (Aura-2, 40 voices from Phase 0),
// the per-message MP3s are concatenated, and the result is cached in R2
// avatok-agent-audio keyed by conversation_id — so BOTH parties reuse one render.
//   POST /api/agent/tts            { conversation_id } → synthesize-or-cache, returns audio path
//   GET  /api/agent/audio/:cid     → stream the cached render (must be a party)
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr } from "../auth";
import { metaDb } from "../db/shard";
import { track, metric } from "../hooks";

const TTS_MODEL = "@cf/deepgram/aura-2-en";
// 40 valid Aura-2 voice IDs (captured in Phase 0 probe).
const VOICES = ["amalthea","andromeda","apollo","arcas","aries","asteria","athena","atlas","aurora","callista","cora","cordelia","delia","draco","electra","harmonia","helena","hera","hermes","hyperion","iris","janus","juno","jupiter","luna","mars","minerva","neptune","odysseus","ophelia","orion","orpheus","pandora","phoebe","pluto","saturn","thalia","theia","vesta","zeus"];

function voiceFor(npub: string): string {
  let h = 0; for (let i = 0; i < npub.length; i++) h = (h * 31 + npub.charCodeAt(i)) >>> 0;
  return VOICES[h % VOICES.length];
}
const audioKey = (cid: string) => `conv/${cid}.mp3`;

// Workers AI TTS output is flexible across runtimes: a base64 string, { audio:
// base64 }, an ArrayBuffer, or a ReadableStream. Normalize to bytes.
async function toBytes(out: any): Promise<Uint8Array | null> {
  if (!out) return null;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out instanceof Uint8Array) return out;
  if (typeof out.getReader === "function") { // ReadableStream
    const reader = out.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } return all;
  }
  const b64 = typeof out === "string" ? out : (typeof out.audio === "string" ? out.audio : null);
  if (b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return null;
}

async function loadConversation(env: Env, cid: string) {
  return metaDb(env).prepare("SELECT npub, peer_npub, transcript, status FROM agent_conversations WHERE id=?1").bind(cid).first<any>();
}
function isParty(c: any, npub: string): boolean { return c && (c.npub === npub || c.peer_npub === npub); }

// POST /api/agent/tts { conversation_id }
export async function agentTts(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const cid = String(b.conversation_id || "");
  const c = await loadConversation(env, cid);
  if (!isParty(c, auth.npub)) return json({ error: "not found" }, 404);

  const key = audioKey(cid);
  // Cached? Reuse (the whole point of lazy TTS — synthesize once, reuse for both).
  if (await env.AGENT_AUDIO.head(key)) {
    track(env, auth.npub, "agent_tts_cache_hit", "avabrain", { conversation_id: cid });
    return json({ ready: true, cached: true, audio_path: `/api/agent/audio/${cid}` });
  }

  const transcript: { speaker: string; content: string }[] = c.transcript ? JSON.parse(c.transcript) : [];
  if (!transcript.length) return json({ error: "no transcript to voice" }, 409);

  // Voices are tied to the npub, not the relative speaker, so the render is identical
  // for both parties. transcript speaker 'you' = conversation owner (c.npub).
  const voiceYou = voiceFor(c.npub), voiceThem = voiceFor(c.peer_npub);
  const parts: Uint8Array[] = [];
  let calls = 0;
  for (const m of transcript) {
    const speaker = m.speaker === "you" ? voiceYou : voiceThem;
    try {
      const out: any = await env.AI.run(TTS_MODEL, { text: m.content.slice(0, 600), speaker } as any);
      const buf = await toBytes(out);
      if (buf && buf.length) { parts.push(buf); calls++; }
    } catch { /* skip a failed segment */ }
  }
  if (!parts.length) return json({ error: "tts failed" }, 502);

  // Concatenate the per-message MP3 frames (MP3 is frame-delimited; concat plays back).
  const total = parts.reduce((n, p) => n + p.length, 0);
  const stitched = new Uint8Array(total);
  let off = 0; for (const p of parts) { stitched.set(p, off); off += p.length; }

  await env.AGENT_AUDIO.put(key, stitched, { httpMetadata: { contentType: "audio/mpeg" } });
  track(env, auth.npub, "agent_tts_synthesized", "avabrain", { conversation_id: cid, segments: calls });
  metric(env, "agent_tts", [calls, total]);
  return json({ ready: true, cached: false, segments: calls, audio_path: `/api/agent/audio/${cid}` });
}

// GET /api/agent/audio/:cid — stream the cached render (party-only).
export async function agentAudio(req: Request, env: Env, cid: string): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const c = await loadConversation(env, cid);
  if (!isParty(c, auth.npub)) return json({ error: "not found" }, 404);
  const obj = await env.AGENT_AUDIO.get(audioKey(cid));
  if (!obj) return json({ error: "not synthesized yet", hint: "POST /api/agent/tts first" }, 404);
  return new Response(obj.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" } });
}
