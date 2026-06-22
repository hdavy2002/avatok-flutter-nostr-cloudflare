// ReceptionRoom — Ava Receptionist call bridge (Specs/PROPOSAL-AI-RECEPTIONIST.md).
// One instance per session id. NOT hibernated: it holds a live outbound Gemini
// Live WebSocket for the duration of a (≤2 min) call.
//
// Why a server-side relay (not client→Gemini directly): it lets us route through
// Cloudflare AI Gateway for METERING, keep GEMINI_API_KEY + the hidden system
// prompt + the 2-minute cap SERVER-SIDE (the caller can't tamper), and capture
// the transcript + voicemail recording. This is the AvaVoice pipeline foundation.
//
// Pipe:  caller app  <--WS (PCM16 16k in / PCM16 24k out)-->  ReceptionRoom DO
//                    <--WS (Gemini Live bidi via AI Gateway)-->  Gemini Live
//
// On close it writes the message + recording under the caller's phone number into
// the owner's InboxDO and pushes the owner.
//
// ⚠️ The exact Gemini Live realtime frame shapes (realtimeInput / serverContent)
// and the AI Gateway "google" WS URL are wired per Cloudflare + Google docs but
// MUST be verified against a live session on first deploy (cannot be unit-tested
// here). All paths are guarded; failures finalize gracefully with a text message.
import type { Env } from "../types";
import { trackUserContact, metric } from "../hooks";
import { dmConvId } from "../authz";
import { contactFor } from "../lib/identity";

interface InitBlob {
  sid: string; owner_uid: string; caller_uid: string;
  caller_phone: string | null; caller_name: string | null; call_id: string | null;
  rtc_token: string; voice_name: string; file_search_store: string | null;
  system_prompt: string; model: string;
  soft_cap_ms: number; hard_cap_ms: number; started_at: number;
  // v2
  language_code?: string | null; activation_mode?: string | null;
}

export class ReceptionRoom {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private gem: WebSocket | null = null;
  private init: InitBlob | null = null;
  private startedAt = 0;
  private softTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;

  // Owner contact, resolved once so EVERY event carries email/phone (support
  // pulls a user's receptionist calls by email/phone). v2 telemetry spec.
  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;
  private firstAudioSent = false;

  private inText: string[] = [];   // caller transcript
  private outText: string[] = [];  // Ava transcript
  private pcmOut: Uint8Array[] = []; // Ava audio (24k PCM16) → WAV recording
  private pcmBytes = 0;
  private static MAX_REC_BYTES = 12 * 1024 * 1024; // safety cap (~4 min @24k)

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const sid = url.searchParams.get("session") || "";
    const token = url.searchParams.get("t") || "";

    const raw = await this.env.TOKENS.get(`recept_rtc:${sid}`, "json").catch(() => null);
    const init = raw as InitBlob | null;
    if (!init || init.rtc_token !== token) {
      return new Response("forbidden", { status: 403 });
    }
    this.init = init;
    this.startedAt = Date.now();
    // Resolve owner contact once (best-effort) so all events are pullable by
    // email/phone. The caller's app emits its own client-side voice_live_* +
    // ava_recept_* events (already stamped with email/phone by Analytics).
    try {
      const c = await contactFor(this.env, init.owner_uid);
      this.ownerEmail = c.email; this.ownerPhone = c.phone;
    } catch { /* best-effort */ }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.client = server;

    server.addEventListener("message", (ev) => this.onClientMessage(ev));
    server.addEventListener("close", () => this.finalize("caller_hangup"));
    server.addEventListener("error", () => this.finalize("error"));

    // Single-use init blob — burn it so the WS can't be re-opened.
    this.env.TOKENS.delete(`recept_rtc:${sid}`).catch(() => {});

    // Open Gemini Live (through AI Gateway when configured).
    this.connectGemini().catch(() => this.failHard("gemini_connect_failed"));

    // 2-minute cap (authoritative, server-side).
    this.softTimer = setTimeout(() => this.onSoftCap(), init.soft_cap_ms);
    this.hardTimer = setTimeout(() => this.finalize("hard_cap"), init.hard_cap_ms);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Emit a receptionist telemetry event stamped with owner email/phone +
   *  one-call trace (trace_id=sid, call_id, activation_mode). v2 spec. */
  private ev(event: string, props: Record<string, unknown> = {}): void {
    const i = this.init;
    if (!i) return;
    trackUserContact(this.env, i.owner_uid, this.ownerEmail, this.ownerPhone, event, "receptionist",
      { ...props, call_id: i.call_id, activation_mode: i.activation_mode ?? null }, i.sid);
  }

  // -------------------------------------------------------------------------
  // Gemini Live (via Cloudflare AI Gateway for metering)
  // -------------------------------------------------------------------------
  private geminiWsUrl(): { url: string; protocols: string[] } {
    const key = this.env.GEMINI_API_KEY!;
    if (this.env.AI_GATEWAY_ID && this.env.CF_ACCOUNT_ID) {
      // Cloudflare AI Gateway "google" realtime WebSocket — gives us per-call
      // usage logging (metering) + an AI Gateway request id.
      const base = `wss://gateway.ai.cloudflare.com/v1/${this.env.CF_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/google`;
      const protocols = this.env.AI_GATEWAY_TOKEN
        ? [`cf-aig-authorization.${this.env.AI_GATEWAY_TOKEN}`] : [];
      return { url: `${base}?api_key=${encodeURIComponent(key)}`, protocols };
    }
    // Fallback: direct Gemini Live (no AI Gateway metering).
    return {
      url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
      protocols: [],
    };
  }

  private async connectGemini(): Promise<void> {
    const init = this.init!;
    const { url, protocols } = this.geminiWsUrl();
    const headers: Record<string, string> = { Upgrade: "websocket" };
    if (protocols.length) headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
    const resp = await fetch(url, { headers });
    const gem = (resp as any).webSocket as WebSocket | undefined;
    if (!gem) throw new Error("no upstream websocket");
    gem.accept();
    this.gem = gem;
    (this as any)._aigId = resp.headers.get("cf-aig-log-id") || resp.headers.get("cf-ray") || null;

    gem.addEventListener("message", (ev) => this.onGeminiMessage(ev));
    gem.addEventListener("close", () => this.finalize("model_closed"));
    gem.addEventListener("error", () => this.failHard("gemini_error"));

    // Telemetry: upstream connected — connect latency + AI Gateway join key.
    this.ev("ava_recept_gemini_connect", {
      latency_ms: Date.now() - this.startedAt,
      via_gateway: !!(this.env.AI_GATEWAY_ID && this.env.CF_ACCOUNT_ID),
      aig_id: (this as any)._aigId ?? null,
      model: init.model, voice: init.voice_name, language: init.language_code ?? "auto",
    });

    // setup — model, voice, locked system prompt, transcription on, optional RAG.
    const speechConfig: any = { voiceConfig: { prebuiltVoiceConfig: { voiceName: init.voice_name } } };
    // v2: pin the spoken language when the owner chose one (NULL = auto-detect).
    if (init.language_code) speechConfig.languageCode = init.language_code;
    const setup: any = {
      model: `models/${init.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig,
      },
      systemInstruction: { parts: [{ text: init.system_prompt }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (init.file_search_store) {
      setup.tools = [{ fileSearch: { fileSearchStoreNames: [init.file_search_store] } }];
    }
    this.sendGem({ setup });
    this.ev("ava_recept_session_started", {
      setup_latency_ms: Date.now() - this.startedAt, has_kb: !!init.file_search_store,
    });
  }

  // caller → Gemini : binary = PCM16 16k; (control JSON tolerated but ignored)
  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized || !this.gem) return;
    const d = ev.data as any;
    if (typeof d === "string") return; // no client-supplied control honored
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes) return;
    this.sendGem({
      realtimeInput: { audio: { data: b64encode(bytes), mimeType: "audio/pcm;rate=16000" } },
    });
  }

  // Gemini → caller : audio out (binary) + transcript accumulation
  private onGeminiMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    let msg: any;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data)
        : JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch { return; }

    const sc = msg.serverContent;
    if (sc) {
      const inT = sc.inputTranscription?.text;
      if (inT) this.inText.push(String(inT));
      const outT = sc.outputTranscription?.text;
      if (outT) this.outText.push(String(outT));
      const parts = sc.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const data = p?.inlineData?.data;
          if (typeof data === "string") {
            const pcm = b64decode(data);
            if (this.pcmBytes < ReceptionRoom.MAX_REC_BYTES) {
              this.pcmOut.push(pcm); this.pcmBytes += pcm.byteLength;
            }
            // Telemetry: time-to-first-audio (perceived latency — the headline UX
            // metric: trigger → Ava's first audible word).
            if (!this.firstAudioSent) {
              this.firstAudioSent = true;
              this.ev("ava_recept_first_audio", { ms: Date.now() - this.startedAt });
            }
            try { this.client?.send(pcm); } catch { /* caller gone */ }
          }
        }
      }
    }
  }

  private onSoftCap(): void {
    // Nudge Ava to wrap up (the system prompt also knows the limit).
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[SYSTEM: ~40 seconds left — confirm the message and say goodbye now.]" }] }],
        turnComplete: true,
      },
    });
    try { this.client?.send(JSON.stringify({ t: "softcap" })); } catch { /* ignore */ }
    metric(this.env, "ava_recept_softcap", [1]);
    this.ev("ava_recept_softcap", { at_ms: Date.now() - this.startedAt });
  }

  private sendGem(obj: unknown): void {
    try { this.gem?.send(JSON.stringify(obj)); } catch { /* upstream gone */ }
  }

  private failHard(reason: string): void {
    this.ev("ava_recept_error", { stage: reason, fatal: true, ms: Date.now() - this.startedAt });
    try { this.client?.send(JSON.stringify({ t: "error", reason })); } catch { /* ignore */ }
    this.finalize(reason);
  }

  // -------------------------------------------------------------------------
  // finalize once: persist session, post message + recording, push owner
  // -------------------------------------------------------------------------
  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.softTimer) clearTimeout(this.softTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    try { this.gem?.close(); } catch { /* ignore */ }
    try { this.client?.send(JSON.stringify({ t: "ended", reason })); this.client?.close(1000, reason); } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    const now = Date.now();
    const durationS = Math.max(0, Math.round((now - this.startedAt) / 1000));
    const transcript = this.buildTranscript();

    // Recording → R2 (WAV, 24 kHz mono PCM16). Best-effort.
    let recordingUrl: string | null = null;
    try {
      if (this.pcmBytes > 0) {
        const wav = pcm16ToWav(this.pcmOut, this.pcmBytes, 24000);
        const phoneKey = (init.caller_phone || "unknown").replace(/[^\d+]/g, "") || "unknown";
        const key = `receptionist/${init.owner_uid}/${phoneKey}/${init.sid}.wav`;
        await this.env.BLOBS.put(key, wav, { httpMetadata: { contentType: "audio/wav" } });
        recordingUrl = key;
      }
    } catch { /* recording is best-effort */ }

    const summary = await this.summarize(transcript, init).catch(() => null);
    const summaryJson = summary ? JSON.stringify(summary) : null;

    // Persist session.
    try {
      await this.env.DB_META.prepare(
        `UPDATE receptionist_sessions SET status='ended', ended_at=?2, duration_s=?3, cutoff_reason=?4,
           summary_json=?5, transcript=?6, recording_url=?7, ai_gateway_request_id=?8, updated_at=?2
         WHERE id=?1`,
      ).bind(init.sid, now, durationS, reason, summaryJson, transcript || null, recordingUrl,
        (this as any)._aigId ?? null).run();
    } catch { /* ignore */ }

    // Deliver: message + recording under the caller's phone number, then push.
    try { await this.postMessage(init, summary, transcript, recordingUrl, durationS); } catch { /* best-effort */ }

    this.ev("ava_recept_message_posted", {
      caller_phone: init.caller_phone, duration_s: durationS, cutoff_reason: reason,
      has_recording: !!recordingUrl, has_transcript: !!transcript,
      in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
    });
    metric(this.env, reason === "hard_cap" ? "ava_recept_hardcap" : "ava_recept_completed", [1, durationS]);
  }

  private buildTranscript(): string {
    const lines: string[] = [];
    // Interleave roughly by collection order (per-turn ordering is approximate).
    if (this.inText.length) lines.push("Caller: " + this.inText.join(" ").trim());
    if (this.outText.length) lines.push("Ava: " + this.outText.join(" ").trim());
    return lines.join("\n");
  }

  /** Quick non-streaming summary of the message (best-effort, via AI Gateway). */
  private async summarize(transcript: string, init: InitBlob):
      Promise<{ caller_name: string | null; reason: string; callback: string | null; urgency: string } | null> {
    if (!transcript || !this.env.GEMINI_API_KEY) return null;
    const model = "gemini-2.5-flash";
    const sysUrl = (this.env.AI_GATEWAY_ID && this.env.CF_ACCOUNT_ID)
      ? `https://gateway.ai.cloudflare.com/v1/${this.env.CF_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/google-ai-studio/v1beta/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const headers: Record<string, string> = { "content-type": "application/json", "x-goog-api-key": this.env.GEMINI_API_KEY };
    if (this.env.AI_GATEWAY_TOKEN && this.env.AI_GATEWAY_ID) headers["cf-aig-authorization"] = `Bearer ${this.env.AI_GATEWAY_TOKEN}`;
    const prompt = `From this phone-message transcript, return STRICT JSON {"caller_name":string|null,"reason":string,"callback":string|null,"urgency":"low"|"normal"|"high"}. Transcript:\n${transcript.slice(0, 4000)}`;
    const r = await fetch(sysUrl, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) return null;
    try {
      const o = JSON.parse(txt);
      return {
        caller_name: o.caller_name ?? init.caller_name ?? null,
        reason: String(o.reason ?? "Message taken"),
        callback: o.callback ?? null,
        urgency: ["low", "normal", "high"].includes(o.urgency) ? o.urgency : "normal",
      };
    } catch { return null; }
  }

  /** Append the receptionist card to the OWNER's inbox under the caller's phone. */
  private async postMessage(
    init: InitBlob, summary: any, transcript: string, recordingUrl: string | null, durationS: number,
  ): Promise<void> {
    const callerLabel = init.caller_name || init.caller_phone || "Unknown caller";
    // v2: deliver into the caller's REAL DM thread (dm_<lo>__<hi>) so the owner
    // sees an agent bubble where they'd expect it — not an isolated recept_ conv.
    // Fall back to the recept_ id only when the caller has no AvaTOK uid (phone-
    // only / unknown caller) and we can't resolve a deterministic DM thread.
    const conv = init.caller_uid
      ? dmConvId(init.owner_uid, init.caller_uid)
      : (init.caller_phone
          ? `recept_${init.owner_uid}__tel:${init.caller_phone}`
          : `recept_${init.owner_uid}__unknown`);
    const inThread = !!init.caller_uid;
    const bodyText = summary
      ? `📞 ${summary.caller_name || callerLabel} called and left a message: ${summary.reason}`
      : `📞 ${callerLabel} called — Ava answered.`;
    // Body is an app envelope {t:'recept', …} so the FROZEN chat_thread renderer
    // shows a dedicated receptionist card (summary + transcript + play). Scoped
    // to:<owner> so it's the owner's private voicemail record — the caller, even
    // though they share the dm_ thread, never sees it (only the owner's InboxDO
    // is written, and the audience scope enforces it).
    const envelope = JSON.stringify({
      t: "recept",
      text: bodyText,                       // fallback caption for old clients
      session_id: init.sid,                 // client uses this to stream the recording
      caller_name: init.caller_name, caller_phone: init.caller_phone,
      call_id: init.call_id, duration_s: durationS,
      activation_mode: init.activation_mode ?? null,
      summary, transcript, has_recording: !!recordingUrl,
    });
    const payload = {
      conv,
      sender: init.caller_uid || `tel:${init.caller_phone}`,
      kind: "receptionist",
      body: envelope,
      media_ref: recordingUrl,              // voicemail recording (R2 key)
      scope: `to:${init.owner_uid}` as const, // owner-private within the dm_ thread
      created_at: Date.now(),
    };
    const stub = this.env.INBOX.get(this.env.INBOX.idFromName(init.owner_uid));
    await stub.fetch("https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, owner: init.owner_uid }),
    });
    try {
      await this.env.Q_PUSH.send({
        kind: "notify", to: init.owner_uid, fromName: "Ava",
        title: "Ava took a message", body: bodyText.replace(/^📞\s*/, ""),
        data: { type: "receptionist", conv, caller_phone: init.caller_phone },
      });
    } catch { /* best-effort */ }
    // v2 telemetry: did the message reach the caller's real DM thread?
    this.ev("ava_recept_delivered_inthread", {
      in_thread: inThread, conv_kind: inThread ? "dm" : "recept_fallback",
      has_recording: !!recordingUrl,
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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

/** Wrap raw PCM16 mono chunks in a minimal WAV container. */
function pcm16ToWav(chunks: Uint8Array[], dataLen: number, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const wr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); wr(8, "WAVE");
  wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, "data"); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
