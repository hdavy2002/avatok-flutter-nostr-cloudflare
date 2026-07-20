// worker/src/do/voicemail_stream_room.ts — [AVA-VM-SELFREC-1]
//
// SELF-RECORDED PSTN voicemail over a Vobiz bidirectional <Stream> WebSocket,
// instead of Vobiz's <Record> verb. Motivation (owner 2026-07-20): Vobiz bills
// a per-recording "Recording" line item (storage + retrieval) for every <Record>
// capture — see the dashboard Cost Analysis breakdown. We already re-download and
// re-store that WAV in our own R2 anyway (routes/pstn.ts handleRecordCb), so we
// were paying Vobiz to record something we immediately re-store. Streaming the
// caller's audio to THIS DO and encoding it ourselves moves the cost off the
// per-recording "Recording" meter (a <Stream> bills only "Stream CDR" streaming
// time) and gives us the raw audio directly — R2-owned, device-independent,
// DPDP-clean (delete = an R2 prefix delete on our infra, not a provider ticket).
//
// Codec: MP3 via @breezystack/lamejs — the SAME pure-JS LAME encoder already in
// production (do/party.ts pcmToMp3). ~10x smaller than raw WAV, plays on every
// device + WhatsApp/Telegram forwards, and Whisper reads it. Raw PCM is buffered
// in DO memory for the call (~2 MB max) and NEVER persisted; only the compressed
// MP3 lands in R2. Whisper STT is fed from an in-memory WAV built from the same
// PCM, so transcription is codec-independent and can't break on a decoder quirk.
//
// Delivery (R2 key, wallet charge, InboxDO envelope, pstn_delivered marker,
// Q_PUSH notify, telemetry, recordCallSummary) MIRRORS routes/pstn.ts
// handleRecordCb() byte-for-byte in shape so the existing client VoicemailCard
// renders it with NO client change. The only difference is the stored object is
// `…/<callId>.mp3` (audio/mpeg) instead of `.wav`; routes/voicemail_routes.ts
// serves the object's real stored content-type so both play.
//
// DARK behind pstnVoicemailSelfRecord (routes/config.ts). With the flag off,
// routes/pstn.ts emits the unchanged <Record> XML and this DO is never reached.
import type { Env } from "../types";
import { Mp3Encoder } from "@breezystack/lamejs";
import { contactFor } from "../lib/identity";
import { trackUserContact } from "../hooks";
import { avaReasonRaw } from "../lib/ava_reason";
import { aiRunOpts } from "../lib/ai_gate";
import { chargeFeature } from "../feature_pricing";
import { recordCallSummary } from "../lib/recept_stats";
import { e164Country } from "../lib/e164_country";
import { normalizePhone, sha256Hex } from "../util";
import { CallState, PlatformEvent } from "../lib/platform_types";

const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const SESSION_TTL_SEC = 3600;
const IN_RATE = 16000;                 // <Stream contentType="audio/x-l16;rate=16000"> inbound
const OUT_RATE = 24000;                // playAudio beep, matches the agent lane's outbound rate
const MAX_REC_BYTES = IN_RATE * 2 * 90; // ~90 s hard ceiling of 16-bit @16k
const SILENCE_STOP_MS = 3000;          // trailing-silence auto-stop (mirrors Vobiz <Record timeout="3">)
const SPEECH_RMS = 600;                // same VAD threshold do/vobiz_agent_room.ts uses

interface VmStreamKv {
  owner_uid: string;
  caller_e164: string | null;
  call_uuid: string | null;
  call_id: string;
  trace_id: string;
  record_sec: number;
}

export class VoicemailStreamRoom {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private kv: VmStreamKv | null = null;
  private streamId: string | null = null;

  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;

  private pcm: Uint8Array[] = [];        // captured inbound caller PCM16@16k
  private pcmBytes = 0;
  private heardSpeech = false;
  private lastSpeechAt = 0;

  private finalized = false;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // sid = trailing path segment of /api/pstn-vm/stream/<secret>/<sid>
    // (the route already verified the shared webhook secret before this DO).
    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);
    const sid = decodeURIComponent(segs[segs.length - 1] || "");
    if (!sid) return new Response("forbidden", { status: 403 });

    const kv = await this.env.TOKENS.get(`pstn_vm:${sid}`, "json").catch(() => null) as VmStreamKv | null;
    if (!kv || !kv.owner_uid) return new Response("forbidden", { status: 403 });
    // Single-use init record — burn it so the WS can't be re-opened.
    this.env.TOKENS.delete(`pstn_vm:${sid}`).catch(() => {});
    this.kv = kv;

    try {
      const c = await contactFor(this.env, kv.owner_uid);
      this.ownerEmail = c.email; this.ownerPhone = c.phone;
    } catch { /* best-effort */ }

    const pair = new WebSocketPair();
    const clientSock = pair[0], server = pair[1];
    server.accept();
    this.client = server;

    server.addEventListener("message", (ev) => this.onMessage(ev));
    // Vobiz sends no inbound "stop" JSON — the socket close IS end-of-call.
    server.addEventListener("close", () => void this.finalize("caller_hangup"));
    server.addEventListener("error", () => void this.finalize("error"));

    const recordSec = Math.max(5, Math.round(Number(kv.record_sec) || 25));
    // Hard cap: greeting already played in the XML before this <Stream>; give a
    // small head-room for the beep we play on `start`.
    this.hardTimer = setTimeout(() => void this.finalize("max_length"), recordSec * 1000 + 800);
    this.silenceTimer = setInterval(() => this.onSilenceTick(), 500);

    this.ev("pstn_voicemail_selfrec_open", { record_sec: recordSec });
    return new Response(null, { status: 101, webSocket: clientSock });
  }

  private ev(event: string, props: Record<string, unknown> = {}): void {
    const kv = this.kv;
    if (!kv) return;
    // Tagged with owner email/phone + trace so PostHog pulls are possible by
    // contact, exactly like the record-cb telemetry it replaces.
    trackUserContact(this.env, kv.owner_uid, this.ownerEmail, this.ownerPhone, event, "pstn",
      { ...props, transport: "vobiz", lane: "vm_selfrec", call_id: kv.call_id, trace_id: kv.trace_id },
      kv.trace_id);
  }

  // ── Vobiz JSON frame protocol (docs: xml/stream/stream-events) ────────────
  private onMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as unknown;
    let j: any;
    try {
      j = typeof d === "string" ? JSON.parse(d) : JSON.parse(new TextDecoder().decode(d as ArrayBuffer));
    } catch { return; }
    const event = String(j?.event || "");

    if (event === "start") {
      this.streamId = String(j.start?.streamId || j.streamId || "") || null;
      const mf = j.start?.mediaFormat || {};
      this.ev("pstn_voicemail_selfrec_start", {
        stream_id: this.streamId, encoding: mf.encoding ?? null, rate: mf.sampleRate ?? null,
      });
      // Prompt the caller: greeting ("…after the beep") played in the XML; we own
      // the beep now that Vobiz's <Record playBeep> is gone.
      this.playBeep();
      return;
    }
    if (event === "media") {
      const track = j.media?.track;
      if (track && track !== "inbound") return; // caller audio only
      const payload = j.media?.payload;
      if (typeof payload !== "string" || !payload) return;
      let bytes: Uint8Array;
      try { bytes = b64decode(payload); } catch { return; }
      this.onCallerAudio(bytes);
      return;
    }
    if (event === "stop") { void this.finalize("caller_hangup"); return; }
    // playedStream / clearedAudio — informational, ignored on the record-only lane.
  }

  private onCallerAudio(bytes: Uint8Array): void {
    if (this.finalized) return;
    if (this.pcmBytes + bytes.byteLength > MAX_REC_BYTES) { void this.finalize("max_bytes"); return; }
    this.pcm.push(bytes);
    this.pcmBytes += bytes.byteLength;
    if (rmsOf(bytes) >= SPEECH_RMS) { this.heardSpeech = true; this.lastSpeechAt = Date.now(); }
  }

  private onSilenceTick(): void {
    if (this.finalized || !this.heardSpeech) return;
    if (Date.now() - this.lastSpeechAt >= SILENCE_STOP_MS) void this.finalize("silence");
  }

  // A short 1 kHz beep so the caller knows when to speak. Outbound L16@24k RAW
  // mono (no WAV header), same playAudio shape the agent lane sends.
  private playBeep(): void {
    if (!this.client) return;
    const ms = 220, freq = 1000, n = Math.floor((OUT_RATE * ms) / 1000);
    const buf = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      // 8 ms cosine fade in/out to avoid clicks.
      const fade = Math.min(1, i / (OUT_RATE * 0.008), (n - i) / (OUT_RATE * 0.008));
      buf[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / OUT_RATE) * 0.3 * 32767 * fade);
    }
    const pcm = new Uint8Array(buf.buffer);
    try {
      this.client.send(JSON.stringify({
        event: "playAudio", streamId: this.streamId || "",
        media: { contentType: "audio/x-l16", sampleRate: OUT_RATE, payload: b64encode(pcm) },
      }));
    } catch { /* caller gone */ }
  }

  private sendStop(): void {
    try { this.client?.send(JSON.stringify({ event: "stop", streamId: this.streamId || "" })); } catch { /* gone */ }
  }

  // ── finalize: encode → R2 (mp3) → charge → Whisper → InboxDO → notify ─────
  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.hardTimer) { clearTimeout(this.hardTimer); this.hardTimer = null; }
    if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
    // End the stream so Vobiz plays the trailing "Goodbye" + <Hangup/> in the XML.
    this.sendStop();
    try { this.client?.close(); } catch { /* ignore */ }

    const kv = this.kv;
    if (!kv) return;
    const ownerUid = kv.owner_uid;
    const callId = kv.call_id;
    const traceId = kv.trace_id;
    const callUuid = kv.call_uuid || callId;
    const callerRaw = kv.caller_e164 || "unknown";
    const callerKey = sanitizeKey(callerRaw);
    const durationS = Math.round(this.pcmBytes / (IN_RATE * 2));

    // No audible message (caller bailed during/after the greeting): deliver
    // nothing. routes/pstn.ts handleHangup's missed-call fallback still posts a
    // text-only card for this CallUUID (pstn_delivered was never set), exactly
    // as when an empty Vobiz <Record> produced no RecordUrl.
    if (this.pcmBytes < IN_RATE * 2 * 1) { // < ~1 s of audio
      this.ev("pstn_voicemail_selfrec_empty", { reason, bytes: this.pcmBytes });
      return;
    }

    const pcm16 = concat(this.pcm, this.pcmBytes);
    this.pcm = [];

    // MP3 for storage (compressed at write — raw PCM never touches R2).
    let mp3: Uint8Array | null = null;
    try { mp3 = pcmToMp3(pcm16, IN_RATE); } catch { mp3 = null; }

    let recordingKey: string | null = null;
    let vmChargedTokens = 0;
    if (mp3) {
      try {
        recordingKey = `voicemail/${ownerUid}/${callerKey}/${callId}.mp3`;
        await this.env.BLOBS.put(recordingKey, mp3, { httpMetadata: { contentType: "audio/mpeg" } });
        // PAY-PER-USE (owner 2026-07-19): ₹1 per voicemail, idempotent per call.
        try {
          const r = await chargeFeature(this.env, ownerUid, "ava_voicemail", `pstnvm:${callUuid}`);
          vmChargedTokens = r.ok ? (r.charged ?? 0) : 0;
        } catch { /* best-effort */ }
      } catch { recordingKey = null; }
    }

    // Whisper STT from an in-memory WAV (codec-independent — never touches R2).
    let transcript = "";
    try {
      const wav = pcm16ToWavMono(pcm16, IN_RATE);
      const out: unknown = await avaReasonRaw(this.env, {
        role: "voicemail", capability: "stt", trigger: "transcribe", feature: "pstn_voicemail_stt",
        verb: "transcribe", model: STT_MODEL, uid: ownerUid,
        raw: { audio: b64encode(wav) }, aiRunOpts: aiRunOpts(this.env, ownerUid),
      });
      const o = out as { text?: string; transcription?: string } | null;
      transcript = String(o?.text ?? o?.transcription ?? "").trim();
    } catch { /* envelope still lands without a transcript */ }

    // InboxDO append — SAME envelope shape as routes/pstn.ts handleRecordCb so
    // the existing client VoicemailCard renders it unchanged.
    try {
      const callerLabel = callerRaw && callerRaw !== "unknown" ? callerRaw : "Unknown caller";
      const conv = `voicemail_${ownerUid}__${callerKey}`;
      const bodyText = transcript
        ? `📞 Voicemail from ${callerLabel}`
        : `📞 Voicemail from ${callerLabel} (no transcript available)`;
      const envelope = JSON.stringify({
        t: "voicemail", text: bodyText, session_id: callId,
        caller_uid: null, caller_name: null, caller_phone: kv.caller_e164,
        call_id: callId, duration_s: durationS, transcript, has_recording: !!recordingKey,
        media_ref: recordingKey,
      });
      const stub = this.env.INBOX.get(this.env.INBOX.idFromName(ownerUid));
      await stub.fetch("https://inbox/append", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conv, sender: "ava_pstn", kind: "voicemail", body: envelope,
          media_ref: recordingKey, scope: `to:${ownerUid}`, created_at: Date.now(),
          owner: ownerUid, client_id: `pstn:${callUuid}`,
        }),
      });

      try { await this.env.TOKENS.put(`pstn_delivered:${callUuid}`, "1", { expirationTtl: SESSION_TTL_SEC }); } catch { /* best-effort */ }

      try {
        await this.env.Q_PUSH.send({
          kind: "notify", to: ownerUid, fromName: callerLabel, title: "New voicemail",
          body: transcript ? transcript.slice(0, 140) : `${callerLabel} left you a voicemail`,
          data: { type: "voicemail", conv, caller_uid: null, caller_phone: kv.caller_e164 ?? null },
        });
      } catch { /* push is an accelerator; InboxDO append is the record of truth */ }

      this.ev("pstn_voicemail_transcribed", {
        transcript_source: transcript ? "whisper" : "none",
        whisper_skipped: false,
        transcript_length: transcript.length,
        has_recording: !!recordingKey,
        codec: "mp3",
        duration_s: durationS,
        end_reason: reason,
      });

      try {
        await recordCallSummary(this.env, {
          id: callUuid,
          owner_uid: ownerUid,
          ts: Date.now(),
          caller_key: callerRaw,
          caller_name: null,
          country: e164Country(kv.caller_e164),
          mode: "vm",
          transport: "vobiz",
          duration_s: durationS,
          tokens: vmChargedTokens,
          outcome: "completed",
          reason: "vm_complete",
          owner_email: this.ownerEmail,
          owner_phone: this.ownerPhone,
        });
      } catch { /* best-effort */ }

      try {
        const callerHash = kv.caller_e164 ? await sha256Hex(normalizePhone(kv.caller_e164)) : null;
        await this.env.Q_ANALYTICS.send({
          event: PlatformEvent.GuardianQueued, uid: ownerUid, ts: Date.now(),
          props: { pstn: true, trace_id: traceId, call_id: callId, caller_hash: callerHash, duration: durationS, state: CallState.GUARDIAN_QUEUED },
        });
      } catch { /* best-effort */ }
    } catch { /* InboxDO append is the source of truth — a failure here loses this one voicemail, but never throws */ }
  }
}

// ── self-contained helpers (each DO keeps its own, per this codebase's convention) ──

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sanitizeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_+.-]/g, "_");
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Root-mean-square amplitude of a PCM16 (LE) frame — cheap VAD. */
function rmsOf(pcm: Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2);
  if (n === 0) return 0;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = dv.getInt16(i * 2, true); sum += s * s; }
  return Math.sqrt(sum / n);
}

/** Encode PCM16 mono → MP3 via pure-JS LAME (same encoder as do/party.ts). */
function pcmToMp3(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const enc = new Mp3Encoder(1, sampleRate, 64); // mono, 64 kbps — ample for 16 kHz speech
  const chunks: Uint8Array[] = [];
  const block = 1152;
  for (let i = 0; i < samples.length; i += block) {
    const buf = enc.encodeBuffer(samples.subarray(i, i + block));
    if (buf.length) chunks.push(new Uint8Array(buf));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Wrap PCM16 mono as a playable WAV (in-memory only, for Whisper). */
function pcm16ToWavMono(pcm: Uint8Array, sampleRate: number): Uint8Array {
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
