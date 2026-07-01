// avatok-consumers — marketplace agent-negotiation VOICE render.
//
// The negotiation itself + the TEXT deal card are delivered synchronously by
// avatok-api. The voice note (Gemini multi-speaker TTS of the FULL transcript)
// is SLOW — 30-60s for a real multi-round negotiation — which does NOT fit inside
// the request/waitUntil budget of the API Worker (it was getting reaped → "No
// audio"). So avatok-api enqueues a `mkt-audio` message and THIS consumer renders
// it with the queue's own generous per-message budget, then appends the voice
// card to both parties' InboxDOs and nudges the live thread. Robust at scale:
// millions of renders fan out across the queue instead of hanging request paths.
import type { Env, MktAudioMsg } from "./types";

const TTS_MODEL = "gemini-2.5-flash-preview-tts";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wrap 24kHz mono 16-bit PCM as a playable WAV (chat voice notes are WAV). */
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

/** Render the FULL 2-voice negotiation transcript to a WAV via Gemini TTS. null on error. */
async function renderNegotiationWav(env: Env, transcript: Array<{ speaker: string; text: string }>, persona?: string): Promise<Uint8Array | null> {
  const key = env.RECEPTIONIST_GEMINI_API_KEY || env.GEMINI_API_KEY;
  if (!key || !transcript.length) return null;
  const styleHint = persona && persona.trim() ? ` Speak in this style/accent: ${persona.trim()}.` : "";
  const script = `TTS this marketplace negotiation between two agents, natural and businesslike.${styleHint}\n` +
    transcript.map((t) => `${t.speaker === "Buyer" ? "Buyer" : "Seller"}: ${t.text}`).join("\n");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: script }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
        { speaker: "Seller", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
        { speaker: "Buyer", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      ] } },
    },
  };
  // 90s: the consumer has its own per-message budget, so a full multi-round
  // render can take its time here (unlike the API Worker's request path).
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`tts ${res.status}: ${raw.slice(0, 200)}`);
  let j: any = null;
  try { j = JSON.parse(raw); } catch { /* non-JSON body */ }
  const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (typeof data !== "string") {
    console.error(`[mkt-audio] no audio in TTS 200: finishReason=${j?.candidates?.[0]?.finishReason} keys=${JSON.stringify(Object.keys(j || {}))} raw=${raw.slice(0, 300)}`);
    return null;
  }
  return pcmToWav(b64ToBytes(data));
}

/** Append a message to a user's InboxDO (cross-script DO binding to avatok-api). */
async function inboxAppend(env: Env, recipient: string, sender: string, conv: string, envelope: string, mediaRef: string | null): Promise<void> {
  const INBOX = env.INBOX!;
  const stub = INBOX.get(INBOX.idFromName(recipient));
  await stub.fetch("https://inbox/append", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv, sender, kind: "text", body: envelope, media_ref: mediaRef, created_at: Date.now(), owner: recipient }),
  });
}

/** Nudge the live thread room so an open chat pulls the new voice card instantly. */
async function partyEmit(env: Env, room: string, event: Record<string, unknown>): Promise<void> {
  const PARTY = env.PARTY;
  if (!PARTY) return;
  try {
    await PARTY.get(PARTY.idFromName(room)).fetch("https://party/emit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event),
    });
  } catch { /* best-effort */ }
}

// AWAIT the analytics send: in a queue consumer a fire-and-forget promise is
// dropped when the invocation ends, so the previous `void ...send()` telemetry
// never flushed (which is why the consumer looked silent). Returns the promise.
async function track(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await env.Q_ANALYTICS?.send({ event, uid, ts: Date.now(),
      props: { ...props, app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: uid } });
  } catch { /* best-effort */ }
}

export async function handleMktAudio(m: MktAudioMsg, env: Env): Promise<void> {
  const t0 = Date.now();
  console.log(`[mkt-audio] start listing=${m.listingId} conv=${m.conv} lines=${(m.transcript || []).length}`);
  await track(env, m.buyerUid, "mkt_audio_start", { listing_id: m.listingId, conv: m.conv, lines: (m.transcript || []).length });
  try {
    // ETA (owner ask): if this render sat in a BACKLOG before we picked it up,
    // post a reassuring interim note so the buyer doesn't give up. The message's
    // age in the queue is the backlog signal (deep queue → long wait).
    const waitedMs = m.enqueuedAt ? Date.now() - m.enqueuedAt : 0;
    if (waitedMs > 45000) {
      const etaMin = Math.max(1, Math.round(waitedMs / 60000));
      const note = JSON.stringify({ t: "text", body: `🕐 Your agents are busy right now — the voice conversation is taking a little longer than usual. It should arrive in about ${etaMin} minute${etaMin > 1 ? "s" : ""}. Feel free to leave and come back; it'll be waiting here.` });
      try { await inboxAppend(env, m.buyerUid, m.sellerUid, m.conv, note, null); } catch { /* best-effort */ }
      await partyEmit(env, `thread:${m.conv}`, { t: "deal_ready", kind: "eta", listing_id: m.listingId, conv: m.conv });
      await track(env, m.buyerUid, "mkt_audio_eta_sent", { listing_id: m.listingId, conv: m.conv, waited_ms: waitedMs });
    }
    // Render inside a US-PINNED PartyDO. Gemini's preview TTS returns audio from a
    // US egress but finishReason=OTHER (no audio) from Cloudflare's default egress;
    // a DO created with locationHint 'wnam' runs in the US so its request to Gemini
    // egresses from there. Fresh id per render → in-region + parallel at scale. The
    // DO renders AND uploads the WAV to R2, returning the key.
    const PARTY = env.PARTY!;
    const stub = PARTY.get(PARTY.idFromName("ttsr-" + crypto.randomUUID()), { locationHint: "wnam" });
    const rr = await stub.fetch("https://party/render-tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: m.transcript || [], persona: m.persona, listingId: m.listingId }),
    });
    const rj = (await rr.json().catch(() => ({}))) as { audio_key?: string | null; bytes?: number };
    if (!rj.audio_key) {
      console.log(`[mkt-audio] US-DO render returned no audio listing=${m.listingId} status=${rr.status}`);
      await track(env, m.buyerUid, "mkt_audio_render_failed", { listing_id: m.listingId, conv: m.conv, reason: "do_null", status: rr.status });
      return;
    }
    const audioKey = rj.audio_key;
    const envelope = JSON.stringify({
      t: "marketplace_deal", text: "🎙️ Voice replay of the negotiation", outcome: m.outcome, bubble: m.bubble,
      agreed_price: m.agreed, currency: m.currency, listing_id: m.listingId, transcript: m.transcript,
      has_audio: true, audio_key: audioKey,
    });
    // Buyer-only for now (owner decision 2026-07-01): only the initiator sees the
    // voice conversation. (Sender=seller so it renders as an incoming card.)
    await inboxAppend(env, m.buyerUid, m.sellerUid, m.conv, envelope, audioKey);
    await partyEmit(env, `thread:${m.conv}`, { t: "deal_ready", kind: "audio", listing_id: m.listingId, conv: m.conv });
    console.log(`[mkt-audio] delivered via US-DO listing=${m.listingId} bytes=${rj.bytes} ms=${Date.now() - t0}`);
    await track(env, m.buyerUid, "mkt_audio_delivered", { listing_id: m.listingId, conv: m.conv, bytes: rj.bytes ?? 0, ms: Date.now() - t0 });
  } catch (e) {
    console.error(`[mkt-audio] ERROR listing=${m.listingId}: ${String(e)}`);
    await track(env, m.buyerUid, "mkt_audio_error", { listing_id: m.listingId, conv: m.conv, error: String(e).slice(0, 300), ms: Date.now() - t0 });
  }
}
