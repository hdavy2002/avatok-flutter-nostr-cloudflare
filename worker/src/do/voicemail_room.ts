// VoicemailRoom — carrier-style "leave a 25s voicemail after the tone" bridge
// (WP3, plan §3 step 4 / §7 item 5 / §15.5 of
// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Forked from do/reception_room_cf.ts's Workers AI STT→TTS pipeline but
// deliberately SIMPLER — no dialog loop, no barge-in, no LLM turn. One
// instance per session id. Same client WS contract (PCM16 16k in / PCM16 24k
// out + JSON control), so the EXISTING call screen's audio pipe works
// unchanged — /api/voicemail/start just hands the caller this DO's WS URL.
//
// Flow: caller connects → speak the fixed prompt ("Hi, ‹Name› isn't available.
// Please leave a 25-second voicemail after the tone.") → play a tone → record
// up to `record_sec` (+`grace_sec` grace) of caller audio → disconnect →
// upload the recording to R2 → transcribe via Workers AI Whisper → write the
// voicemail into the CALLEE's InboxDO (kind 'voicemail', body=transcription,
// media_ref=R2 key) → push the callee. The caller sees NOTHING further (plan
// §6: voicemails are callee-side only).
//
// 2-peer cap preserved (§15.6): the bot occupies the SECOND peer slot (caller
// + bot); it never joins a call that already has two humans, and it never
// touches the CallRoom DO's cap.
import type { Env } from "../types";
import { trackUserContact } from "../hooks";
import { emitCallEvent, EVENT_SCHEMA_VERSION, newTraceId } from "../lib/call_events";
import { contactFor } from "../lib/identity";

const AURA_VOICE = "asteria"; // fixed warm female voice — mirrors reception_room_cf's Ava
const TTS_MODEL = "@cf/deepgram/aura-2-en";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const SAMPLE_RATE_OUT = 24000;
const SAMPLE_RATE_IN = 16000;
const TONE_MS = 700;
const TONE_HZ = 1000;
const MAX_REC_BYTES = 6 * 1024 * 1024; // ~ a few minutes of 16k PCM16 — generous safety cap

interface InitBlob {
  sid: string;
  owner_uid: string;     // callee — the voicemail's recipient
  caller_uid: string;
  caller_name: string | null;
  caller_phone: string | null;
  call_id: string | null;
  rtc_token: string;
  greeting: string;      // fixed prompt, composed server-side by /api/voicemail/start
  owner_name: string | null;
  record_sec: number;    // voicemailRecordSec (25)
  grace_sec: number;     // +3s grace
  trace_id?: string | null;
}

export class VoicemailRoom {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private init: InitBlob | null = null;
  private startedAt = 0;
  private finalized = false;
  private recordTimer: ReturnType<typeof setTimeout> | null = null;

  private recPcm: Uint8Array[] = [];
  private recBytes = 0;
  private gotAnyRecording = false;

  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const url = new URL(req.url);
    const sid = url.searchParams.get("session") || "";
    const token = url.searchParams.get("t") || "";

    const raw = await this.env.TOKENS.get(`voicemail_rtc:${sid}`, "json").catch(() => null);
    const init = raw as InitBlob | null;
    if (!init || init.rtc_token !== token) return new Response("forbidden", { status: 403 });
    if (this.finalized) return new Response("gone", { status: 410 });
    this.init = init;
    this.startedAt = Date.now();
    // Single-use token — remove it immediately so a replay can't reopen this session.
    this.env.TOKENS.delete(`voicemail_rtc:${sid}`).catch(() => {});
    try {
      const c = await contactFor(this.env, init.owner_uid);
      this.ownerEmail = c.email; this.ownerPhone = c.phone;
    } catch { /* best-effort */ }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.client = server;
    server.addEventListener("message", (ev) => this.onClientMessage(ev));
    server.addEventListener("close", () => void this.finalize("caller_hangup"));
    server.addEventListener("error", () => void this.finalize("error"));

    this.ev("voicemail_started");
    this.runSession().catch((e) => {
      this.ev("voicemail_start_failed", { error: String(e).slice(0, 200) });
      void this.finalize("start_failed");
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private ev(event: string, props: Record<string, unknown> = {}): void {
    const i = this.init;
    if (!i) return;
    trackUserContact(this.env, i.owner_uid, this.ownerEmail, this.ownerPhone, event, "voicemail",
      { ...props, call_id: i.call_id, caller_uid: i.caller_uid }, i.sid);
    if (i.call_id) {
      emitCallEvent(this.env, {
        event, call_id: i.call_id, trace_id: i.trace_id || newTraceId(),
        caller_id: i.caller_uid, callee_id: i.owner_uid, call_mode: "business",
        ts: Date.now(), event_schema_version: EVENT_SCHEMA_VERSION, props,
      }).catch(() => {});
    }
  }

  private async runSession(): Promise<void> {
    const init = this.init!;
    // 1. Speak the fixed prompt.
    await this.speak(init.greeting);
    if (this.finalized) return;
    // 2. Play the tone that tells the caller to start talking.
    this.sendTone();
    // 3. Arm the record window (+ grace). Recording itself is just "accept and
    //    buffer every incoming audio frame from here on" — see onClientMessage.
    const totalMs = (Math.max(1, init.record_sec) + Math.max(0, init.grace_sec)) * 1000;
    this.recordTimer = setTimeout(() => void this.finalize("record_window_elapsed"), totalMs);
  }

  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as unknown;
    if (typeof d === "string") return; // no client control honored on this simple bridge
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes || !bytes.byteLength) return;
    if (this.recBytes >= MAX_REC_BYTES) return; // safety cap — stop accumulating, timer still finalizes
    this.recPcm.push(bytes);
    this.recBytes += bytes.byteLength;
    this.gotAnyRecording = true;
  }

  /** Greeting PCM with an R2 cache in front of the TTS call (owner decision
   *  2026-07-12: a business getting 300 missed calls/day must not cost 300 TTS
   *  generations). The greeting text is DETERMINISTIC per owner ("Hi, ‹Name›
   *  isn't available. Please leave a ‹N›-second voicemail after the tone."),
   *  so we synthesize ONCE per unique (model, voice, rate, text) and replay
   *  the stored PCM for every later missed call. The owner's name is already
   *  baked into the text, so per-owner personalization comes free via the
   *  hash; a display-name or voicemailRecordSec change mints a new cache
   *  entry automatically (old ones are just orphaned ~300KB objects). Any
   *  cache read/write failure falls back to a live TTS call — never a silent
   *  greeting. */
  private async greetingPcm(text: string): Promise<Uint8Array | null> {
    let cacheKey: string | null = null;
    try {
      const digest = await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(`${TTS_MODEL}|${AURA_VOICE}|${SAMPLE_RATE_OUT}|${text.slice(0, 400)}`));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      cacheKey = `tts-cache/voicemail/${hex}.pcm`;
      const hit = await this.env.BLOBS.get(cacheKey);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.byteLength) {
          this.ev("voicemail_tts_cache", { hit: true, bytes: bytes.byteLength });
          return bytes;
        }
      }
    } catch { /* cache unavailable → live TTS below */ }
    const resp: unknown = await this.env.AI.run(TTS_MODEL,
      { text: text.slice(0, 400), speaker: AURA_VOICE, encoding: "linear16", sample_rate: SAMPLE_RATE_OUT, container: "none" } as unknown as Record<string, unknown>);
    const pcm = await ttsToPcm(resp);
    if (pcm && pcm.byteLength && cacheKey) {
      this.ev("voicemail_tts_cache", { hit: false, bytes: pcm.byteLength });
      try {
        await this.env.BLOBS.put(cacheKey, pcm, { httpMetadata: { contentType: "application/octet-stream" } });
      } catch { /* best-effort — next call just re-generates */ }
    }
    return pcm;
  }

  /** Buffered TTS (simpler than reception_room_cf's streaming path — a
   *  voicemail prompt is short, so the extra ~1-2s of buffering is fine). */
  private async speak(text: string): Promise<void> {
    if (!text) return;
    try {
      const pcm = await this.greetingPcm(text);
      if (pcm && pcm.byteLength && this.client) {
        for (let o = 0; o < pcm.byteLength; o += 24000) {
          try { this.client.send(pcm.subarray(o, Math.min(o + 24000, pcm.byteLength))); } catch { /* caller gone */ }
        }
        // Let the client finish playing before the tone — sleep roughly the
        // audio's own duration (24kHz, 16-bit mono → 48000 bytes/sec).
        const ms = Math.min(15000, Math.ceil((pcm.byteLength / 48000) * 1000));
        await sleep(ms);
      }
    } catch (e) { this.ev("voicemail_tts_error", { error: String(e).slice(0, 160) }); }
  }

  /** A short synthesized beep (no TTS round-trip needed) — tells the caller to start. */
  private sendTone(): void {
    if (!this.client) return;
    const n = Math.round(SAMPLE_RATE_OUT * (TONE_MS / 1000));
    const out = new Uint8Array(n * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < n; i++) {
      const s = Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE_OUT) * 0.4 * 32767;
      view.setInt16(i * 2, Math.round(s), true);
    }
    try { this.client.send(out); } catch { /* caller gone */ }
  }

  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.recordTimer) clearTimeout(this.recordTimer);
    try { this.client?.send(JSON.stringify({ t: "ended", reason })); this.client?.close(1000, reason); } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    const durationS = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));

    if (!this.gotAnyRecording || this.recBytes === 0) {
      this.ev("voicemail_empty", { cutoff_reason: reason, duration_s: durationS });
      return; // caller hung up before leaving anything — no card, no push (mirrors reception's "no message" behaviour but skips the summary path entirely)
    }

    let recordingKey: string | null = null;
    let transcript = "";
    try {
      const wav = pcm16ToWavMono(concatFrames(this.recPcm, this.recBytes), SAMPLE_RATE_IN);
      const callerKey = (init.caller_uid || init.caller_phone || "unknown").replace(/[^A-Za-z0-9_+.-]/g, "_");
      recordingKey = `voicemail/${init.owner_uid}/${callerKey}/${init.sid}.wav`;
      await this.env.BLOBS.put(recordingKey, wav, { httpMetadata: { contentType: "audio/wav" } });
      this.ev("voicemail_recording_stored", { bytes: wav.byteLength, ok: true });
      try {
        const out: unknown = await this.env.AI.run(STT_MODEL, { audio: b64encode(wav) } as unknown as Record<string, unknown>);
        const o = out as { text?: string; transcription?: string } | null;
        transcript = String(o?.text ?? o?.transcription ?? "").trim();
      } catch (e) { this.ev("voicemail_stt_error", { error: String(e).slice(0, 160) }); }
    } catch (e) {
      this.ev("voicemail_delivery_failed", { stage: "r2", error: String(e).slice(0, 200) });
    }

    try {
      await this.postVoicemail(init, transcript, recordingKey, durationS);
      this.ev("voicemail_posted", { has_recording: !!recordingKey, has_transcript: !!transcript, duration_s: durationS });
    } catch (e) {
      this.ev("voicemail_delivery_failed", { stage: "post", error: String(e).slice(0, 200) });
    }
  }

  /** Append the voicemail to the CALLEE's InboxDO — kind 'voicemail', body=
   *  transcription, media_ref=R2 key (plan §6/§7 item 6: voicemails are
   *  callee-side only; the caller sees nothing). Idempotent client_id = sid. */
  private async postVoicemail(init: InitBlob, transcript: string, recordingKey: string | null, durationS: number): Promise<void> {
    const callerLabel = init.caller_name || init.caller_phone || "Unknown caller";
    const conv = `voicemail_${init.owner_uid}__${init.caller_uid}`;
    const bodyText = transcript
      ? `📞 Voicemail from ${callerLabel}: ${transcript}`
      : `📞 Voicemail from ${callerLabel} (no transcript available).`;
    const envelope = JSON.stringify({
      t: "voicemail", text: bodyText, session_id: init.sid,
      caller_uid: init.caller_uid, caller_name: init.caller_name, caller_phone: init.caller_phone,
      call_id: init.call_id, duration_s: durationS, transcript, has_recording: !!recordingKey,
      // GAP-3: the R2 key ALSO rides inside the envelope body JSON (not just as
      // the /inbox/append top-level media_ref) — chat_thread.dart's `_Msg`
      // constructor builds `extra` straight from the decoded body and never
      // merges the separate media_ref column in, so without this the client-side
      // VoicemailCard could never learn the key to build a playback URL from.
      media_ref: recordingKey,
    });
    const stub = this.env.INBOX.get(this.env.INBOX.idFromName(init.owner_uid));
    await stub.fetch("https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conv, sender: init.caller_uid || "ava_system", kind: "voicemail", body: envelope,
        media_ref: recordingKey, scope: `to:${init.owner_uid}`, created_at: Date.now(),
        owner: init.owner_uid, client_id: `voicemail:${init.sid}`,
      }),
    });
    try {
      await this.env.Q_PUSH.send({
        kind: "notify", to: init.owner_uid, fromName: callerLabel, title: "New voicemail",
        body: transcript ? transcript.slice(0, 140) : `${callerLabel} left you a voicemail`,
        data: { type: "voicemail", conv, caller_uid: init.caller_uid },
      });
    } catch { /* best-effort — push is an accelerator, InboxDO append is the record of truth */ }
  }
}

// ── helpers (subset of reception_room_cf.ts's, no barge-in/VAD needed here) ──
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatFrames(frames: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0; for (const f of frames) { out.set(f, o); o += f.byteLength; }
  return out;
}
function stripWavHeader(buf: Uint8Array): Uint8Array {
  if (buf.byteLength > 44 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return buf.subarray(44);
  return buf;
}
function pcm16ToWavMono(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(out.buffer);
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); dv.setUint32(4, 36 + pcm.byteLength, true); wr(8, "WAVE");
  wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, "data"); dv.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
async function ttsToPcm(out: unknown): Promise<Uint8Array | null> {
  if (!out) return null;
  let bytes: Uint8Array | null = null;
  const o = out as { body?: ReadableStream<Uint8Array>; getReader?: unknown; audio?: string } | ArrayBuffer | Uint8Array;
  if (o instanceof ArrayBuffer) bytes = new Uint8Array(o);
  else if (o instanceof Uint8Array) bytes = o;
  else if (typeof (o as { getReader?: unknown }).getReader === "function") {
    const reader = (o as unknown as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) { chunks.push(value); n += value.length; } }
    bytes = new Uint8Array(n); let off = 0; for (const c of chunks) { bytes.set(c, off); off += c.length; }
  } else if ((o as { body?: ReadableStream<Uint8Array> }).body) {
    return ttsToPcm((o as { body?: unknown }).body);
  } else {
    const b64 = typeof o === "string" ? (o as unknown as string) : (typeof (o as { audio?: string }).audio === "string" ? (o as { audio?: string }).audio! : null);
    if (b64) bytes = b64decode(b64);
  }
  return bytes ? stripWavHeader(bytes) : null;
}
