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

/** Redact secrets from free-text error strings BEFORE they go into telemetry.
 *  The Gemini Live URL carries `?key=AIza…` / `?access_token=auth_tokens/…`, so a
 *  raw `String(e)` on a connect failure would otherwise leak GEMINI_API_KEY into
 *  PostHog (observed 2026-06-24). Scrub first, then truncate — never the reverse,
 *  so a cut can't leave a partial key behind. */
function scrubSecrets(s: string): string {
  return s
    // querystring secrets: ?key= / &access_token= / token= / api_key=
    .replace(/([?&](?:key|access_token|token|api_key)=)[^&\s"']+/gi, "$1[redacted]")
    // Google API keys (AIza…) anywhere in the text
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[redacted-key]")
    // ephemeral Gemini token names (auth_tokens/…)
    .replace(/auth_tokens\/[^&\s"']+/g, "auth_tokens/[redacted]")
    // any remaining long opaque token (bearer/JWT-ish)
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]");
}

interface InitBlob {
  sid: string; owner_uid: string; caller_uid: string;
  caller_phone: string | null; caller_name: string | null; call_id: string | null;
  rtc_token: string; voice_name: string; file_search_store: string | null;
  system_prompt: string; model: string;
  soft_cap_ms: number; hard_cap_ms: number; started_at: number;
  // v2
  language_code?: string | null; activation_mode?: string | null;
  owner_name?: string | null; // owner's display name, for the caller-side ack
  ava_name?: string | null;   // Ava's persona name, for transcript speaker labels
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

  private inText: string[] = [];   // caller transcript fragments (char counts)
  private outText: string[] = [];  // Ava transcript fragments (char counts)
  // Interleaved, turn-by-turn dialogue (the human-readable transcript): each
  // entry is one speaker's contiguous turn, in the order it actually happened.
  private dialog: Array<{ who: "ava" | "caller"; text: string }> = [];
  // 2-way recording as tagged segments in turn order; caller segments get a
  // PER-CALL normalization gain at finalize (not a fixed boost) so every user's
  // mic — soft or loud — lands at a consistent level without clipping.
  private pcmOut: Array<{ caller: boolean; pcm: Uint8Array }> = [];
  private pcmBytes = 0;  // total recording bytes (Ava + caller)
  private avaBytes = 0;  // Ava-only audio bytes (telemetry; distinct from the 2-way total)
  private callerRecBytes = 0; // caller speech actually captured into the 2-way recording
  private callerPeak = 0; // peak |sample| of caller audio → drives adaptive normalization
  private inBytes = 0;   // caller audio bytes received (mic throughput / dead-mic)
  private turnCount = 0; // completed conversational turns
  // Goodbye backstop: end the call after a stretch of total silence (covers the
  // case where Ava says "have a great day" but the model doesn't hang up).
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static IDLE_MS = 10_000;
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

    // Open Gemini Live (through AI Gateway when configured). A dedicated event
    // captures the connect failure WITH via_gateway — this is the signature of
    // the AI-Gateway-401 case (gateway authenticated but AI_GATEWAY_TOKEN unset).
    this.connectGemini().catch((e) => {
      this.ev("ava_recept_gemini_connect_failed", {
        via_gateway: false,
        error_scrubbed: scrubSecrets(String(e)).slice(0, 200),
        ms: Date.now() - this.startedAt,
      });
      this.failHard("gemini_connect_failed");
    });

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
    // DIRECT to Gemini Live — no AI Gateway hop (owner decision 2026-06-24).
    // CRITICAL: a Cloudflare Worker opens an OUTBOUND WebSocket via fetch() with
    // an `Upgrade: websocket` header, and the runtime ONLY accepts the http(s)
    // scheme — a `wss://` URL throws "Fetch API cannot load: wss://…" and the
    // connection never opens (this is exactly why Ava produced no audio). So we
    // use `https://`; Cloudflare performs the WS handshake and returns
    // resp.webSocket. Per-call usage is observed via our ava_recept_* telemetry.
    return {
      url: `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
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

    // Telemetry: upstream connected — connect latency. Direct path (no gateway).
    this.ev("ava_recept_gemini_connect", {
      latency_ms: Date.now() - this.startedAt,
      via_gateway: false,
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
    // Tools: an end_call function so Ava can hang up after her goodbye, plus the
    // owner's knowledge base (File Search) when configured.
    const tools: any[] = [{
      functionDeclarations: [{
        name: "end_call",
        description: "End the phone call. Invoke this right AFTER you have said goodbye and the caller has nothing more to add.",
      }],
    }];
    if (init.file_search_store) {
      tools.push({ fileSearch: { fileSearchStoreNames: [init.file_search_store] } });
    }
    setup.tools = tools;
    this.sendGem({ setup });
    this.ev("ava_recept_session_started", {
      setup_latency_ms: Date.now() - this.startedAt, has_kb: !!init.file_search_store,
    });
    // GREET FIRST. Without this, Gemini's automatic VAD waits for the caller to
    // speak-and-pause before the model says anything — which showed up as a ~19s
    // dead-air gap before Ava's first word. A one-shot user turn makes her open
    // the call immediately; the caller's streamed mic audio drives the rest.
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[The caller has just connected and is on the line. Greet them now, by name if you have it, state the status, then offer to take a message. Keep it to one or two short sentences.]" }] }],
        turnComplete: true,
      },
    });
    this.bumpIdle(); // arm the silence backstop
  }

  // caller → Gemini : binary = PCM16 16k; (control JSON tolerated but ignored)
  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized || !this.gem) return;
    const d = ev.data as any;
    if (typeof d === "string") return; // no client-supplied control honored
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes) return;
    this.inBytes += bytes.byteLength; // server-truth mic throughput (vs client mic_bytes)
    // 2-WAY RECORDING: capture the CALLER's side too, so the voicemail isn't just
    // Ava. Only frames with real speech energy (skip silence/echo gaps so Ava's
    // turns aren't fragmented), upsampled 16k→24k to match Ava's stream. Arrival
    // order ≈ turn order (Ava bursts, then caller replies), giving a clean
    // turn-by-turn recording.
    if (this.pcmBytes < ReceptionRoom.MAX_REC_BYTES && callerHasSpeech(bytes)) {
      // Record at native level (no fixed boost) + track the caller's peak; the
      // actual gain is computed per-call at finalize and applied then.
      const up = upsample16to24(bytes);
      const pk = peakOf(up);
      if (pk > this.callerPeak) this.callerPeak = pk;
      this.pcmOut.push({ caller: true, pcm: up }); this.pcmBytes += up.byteLength; this.callerRecBytes += up.byteLength;
      this.bumpIdle();
    }
    this.sendGem({
      realtimeInput: { audio: { data: b64encode(bytes), mimeType: "audio/pcm;rate=16000" } },
    });
  }

  /** Reset the silence backstop on any real audio activity (either side). */
  private bumpIdle(): void {
    if (this.finalized) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalize("inactivity"), ReceptionRoom.IDLE_MS);
  }

  // Gemini → caller : audio out (binary) + transcript accumulation
  private onGeminiMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    let msg: any;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data)
        : JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch { return; }

    // Ava decided the call is done (she invoked the end_call tool after her
    // goodbye) → hang up immediately instead of leaving the line open.
    if (msg.toolCall) {
      const calls = msg.toolCall.functionCalls;
      if (Array.isArray(calls) && calls.some((c: any) => c?.name === "end_call")) {
        this.ev("ava_recept_ended_by_agent", { ms: Date.now() - this.startedAt });
        this.finalize("ava_ended");
        return;
      }
    }

    const sc = msg.serverContent;
    if (sc) {
      // Barge-in: Gemini's VAD heard the caller speak over Ava → the model halts
      // its own generation AND we tell the client to drop any buffered audio so
      // Ava goes silent INSTANTLY (otherwise the client keeps playing her queue
      // and she "talks over" the caller — the exact bug reported).
      if (sc.interrupted === true) {
        try { this.client?.send(JSON.stringify({ t: "flush" })); } catch { /* caller gone */ }
        this.ev("ava_recept_barge_in", { route: "gemini_vad", ms: Date.now() - this.startedAt });
      }
      const inT = sc.inputTranscription?.text;
      if (inT) { this.inText.push(String(inT)); this.pushDialog("caller", String(inT)); }
      const outT = sc.outputTranscription?.text;
      if (outT) { this.outText.push(String(outT)); this.pushDialog("ava", String(outT)); }
      // Per-turn observability: each completed exchange, with server-truth audio
      // throughput both ways. in_bytes≈0 across turns ⇒ the caller wasn't heard.
      if (sc.turnComplete === true) {
        this.turnCount++;
        this.ev("ava_recept_turn", {
          turn: this.turnCount,
          in_chars: this.inText.join("").length,
          out_chars: this.outText.join("").length,
          in_bytes: this.inBytes,
          ava_bytes: this.pcmBytes,
          ms: Date.now() - this.startedAt,
        });
      }
      const parts = sc.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const data = p?.inlineData?.data;
          if (typeof data === "string") {
            const pcm = b64decode(data);
            if (this.pcmBytes < ReceptionRoom.MAX_REC_BYTES) {
              this.pcmOut.push({ caller: false, pcm }); this.pcmBytes += pcm.byteLength;
            }
            this.avaBytes += pcm.byteLength;
            this.bumpIdle(); // Ava is speaking → reset the silence backstop
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
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
        const recT0 = Date.now();
        // Adaptive per-call normalization: scale the caller's audio toward a
        // target peak so it's audible for EVERY user regardless of their mic,
        // capped so we never over-amplify noise. Loud callers ≈ 1x, soft ≈ up to 8x.
        const callerGain = this.callerPeak > 0
          ? Math.min(8, Math.max(1, 22000 / this.callerPeak)) : 1;
        const wav = pcm16ToWav(this.pcmOut, this.pcmBytes, 24000, callerGain);
        const phoneKey = (init.caller_phone || "unknown").replace(/[^\d+]/g, "") || "unknown";
        const key = `receptionist/${init.owner_uid}/${phoneKey}/${init.sid}.wav`;
        await this.env.BLOBS.put(key, wav, { httpMetadata: { contentType: "audio/wav" } });
        recordingUrl = key;
        this.ev("ava_recept_recording_stored", {
          bytes: wav.byteLength, ok: true, latency_ms: Date.now() - recT0,
          two_way: this.callerRecBytes > 0, ava_rec_bytes: this.avaBytes, caller_rec_bytes: this.callerRecBytes,
          caller_gain: Math.round(callerGain * 100) / 100, caller_peak: this.callerPeak,
        });
      }
    } catch (e) {
      this.ev("ava_recept_delivery_failed", { stage: "r2", error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
    }

    const sumT0 = Date.now();
    const summary = await this.summarize(transcript, init).catch(() => null);
    const summaryJson = summary ? JSON.stringify(summary) : null;
    this.ev("ava_recept_summary_generated", {
      ok: !!summary, latency_ms: Date.now() - sumT0, urgency: summary?.urgency ?? null,
    });

    // Persist session.
    try {
      await this.env.DB_META.prepare(
        `UPDATE receptionist_sessions SET status='ended', ended_at=?2, duration_s=?3, cutoff_reason=?4,
           summary_json=?5, transcript=?6, recording_url=?7, ai_gateway_request_id=?8, updated_at=?2
         WHERE id=?1`,
      ).bind(init.sid, now, durationS, reason, summaryJson, transcript || null, recordingUrl,
        (this as any)._aigId ?? null).run();
    } catch { /* ignore */ }

    // A real exchange happened only if Ava spoke or the caller said something.
    // A 0-duration hang-up must NOT dump a misleading "I've taken your message".
    const hadConversation = this.firstAudioSent || this.inText.length > 0 || this.pcmBytes > 0;
    // Deliver: message + recording under the caller's phone number, then push.
    try { await this.postMessage(init, summary, transcript, recordingUrl, durationS, hadConversation); } catch { /* best-effort */ }

    this.ev("ava_recept_message_posted", {
      caller_phone: init.caller_phone, duration_s: durationS, cutoff_reason: reason,
      has_recording: !!recordingUrl, has_transcript: !!transcript,
      in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
    });
    // Session lifecycle close — the funnel tail (started → first_audio → ended).
    this.ev("ava_recept_session_ended", {
      cutoff_reason: reason, duration_s: durationS, got_audio: this.firstAudioSent,
      ava_audio_bytes: this.avaBytes, recording_bytes: this.pcmBytes,
      caller_rec_bytes: this.callerRecBytes,
      caller_audio_bytes: this.inBytes, two_way_recording: this.callerRecBytes > 0,
      turns: this.turnCount,
      in_chars: this.inText.join("").length,
      out_chars: this.outText.join("").length, has_recording: !!recordingUrl,
    });
    metric(this.env, reason === "hard_cap" ? "ava_recept_hardcap" : "ava_recept_completed", [1, durationS]);
  }

  /** Append a transcript fragment to the running turn-by-turn dialogue, merging
   *  consecutive fragments from the same speaker into one turn. */
  private pushDialog(who: "ava" | "caller", text: string): void {
    const t = text.trim();
    if (!t) return;
    const last = this.dialog[this.dialog.length - 1];
    if (last && last.who === who) last.text = (last.text + " " + t).replace(/\s+/g, " ").trim();
    else this.dialog.push({ who, text: t });
  }

  /** Human-readable transcript: real turn order with speaker names, e.g.
   *  "Ava: Hi Humphrey, …\nHumphrey: Yes, tell her I'll call back…\nAva: …". */
  private buildTranscript(): string {
    const avaName = (this.init?.ava_name || "Ava").trim() || "Ava";
    const callerName = (this.init?.caller_name || "Caller").trim() || "Caller";
    if (this.dialog.length > 0) {
      return this.dialog.map((d) => `${d.who === "ava" ? avaName : callerName}: ${d.text}`).join("\n");
    }
    // Fallback (no interleaved data): two blocks.
    const lines: string[] = [];
    if (this.inText.length) lines.push(callerName + ": " + this.inText.join(" ").trim());
    if (this.outText.length) lines.push(avaName + ": " + this.outText.join(" ").trim());
    return lines.join("\n");
  }

  /** Quick non-streaming summary of the message (best-effort, via AI Gateway). */
  private async summarize(transcript: string, init: InitBlob):
      Promise<{ caller_name: string | null; reason: string; callback: string | null; urgency: string } | null> {
    if (!transcript || !this.env.GEMINI_API_KEY) return null;
    const model = "gemini-2.5-flash";
    // Direct to Gemini (no AI Gateway hop) — same rationale as the live socket.
    const sysUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const headers: Record<string, string> = { "content-type": "application/json", "x-goog-api-key": this.env.GEMINI_API_KEY };
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

  /** Append the receptionist card to the OWNER's inbox under the caller's phone.
   *  [hadConversation] gates the caller-side ack so we never tell a caller "I've
   *  taken your message" when they hung up before saying anything. */
  private async postMessage(
    init: InitBlob, summary: any, transcript: string, recordingUrl: string | null,
    durationS: number, hadConversation: boolean,
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
      : hadConversation
        ? `📞 ${callerLabel} called — Ava answered.`
        : `📞 Missed call from ${callerLabel} — they hung up before leaving a message.`;
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
      scope: `to:${init.owner_uid}`, // owner-private within the dm_ thread
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
      this.ev("ava_recept_push_sent", { ok: true });
    } catch (e) {
      this.ev("ava_recept_delivery_failed", { stage: "push", error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
    }
    // v2 telemetry: did the message reach the caller's real DM thread?
    this.ev("ava_recept_delivered_inthread", {
      in_thread: inThread, conv_kind: inThread ? "dm" : "recept_fallback",
      has_recording: !!recordingUrl,
    });

    // Caller-side acknowledgment: drop a normal TEXT message into the CALLER's
    // Messenger thread, appearing to come from the owner's assistant, so the
    // caller (e.g. Satish) opens Messenger and sees a new message from the owner
    // (Humphrey) confirming the message was taken — with the SAME push + unread
    // badge as any incoming chat. Only when the caller is a known AvaTOK user
    // (phone-only callers have no inbox). `{t:'text'}` renders as a plain bubble.
    if (init.caller_uid && init.caller_uid !== init.owner_uid && hadConversation) {
      const ownerLabel = (init.owner_name || "your contact").trim();
      const greet = init.caller_name ? `Hi ${init.caller_name}` : "Hi there";
      const ackText = summary
        ? `${greet} — this is ${ownerLabel}'s assistant. I've passed your message on to ${ownerLabel}${summary.reason ? ` (“${summary.reason}”)` : ""}. They'll get back to you soon.`
        : `${greet} — this is ${ownerLabel}'s assistant. I've taken your message and ${ownerLabel} will get back to you soon.`;
      try {
        const ackStub = this.env.INBOX.get(this.env.INBOX.idFromName(init.caller_uid));
        await ackStub.fetch("https://inbox/append", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conv,                              // same deterministic dm_ thread
            sender: init.owner_uid,            // looks like a message FROM the owner
            kind: "text",
            body: JSON.stringify({ t: "text", body: ackText }),
            scope: `to:${init.caller_uid}`,    // the caller's view
            created_at: Date.now(),
            owner: init.caller_uid,
          }),
        });
        // Same push path as a normal message → notification + unread app badge.
        await this.env.Q_PUSH.send({ kind: "notify", to: init.caller_uid, fromName: ownerLabel });
        this.ev("ava_recept_caller_ack_sent", { ok: true });
      } catch (e) {
        this.ev("ava_recept_caller_ack_sent", { ok: false, error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
      }
    }
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

/** True when a caller PCM16 frame carries real speech (RMS above a silence
 *  floor) — gates out silence/echo so the 2-way recording isn't fragmented. */
function callerHasSpeech(pcm: Uint8Array): boolean {
  const n = pcm.byteLength >> 1;
  if (n === 0) return false;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sumSq += s * s; }
  return Math.sqrt(sumSq / n) > 600; // ~speech threshold for PCM16
}

/** Upsample mono PCM16 16kHz → 24kHz (linear interpolation, 3:2) so the caller's
 *  audio matches Ava's 24k stream in the merged recording. [gain] amplifies the
 *  (typically softer) caller signal, with hard clipping to avoid overflow. */
function upsample16to24(pcm16: Uint8Array, gain = 1): Uint8Array {
  const inN = pcm16.byteLength >> 1;
  if (inN === 0) return new Uint8Array(0);
  const inView = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const outN = Math.floor((inN * 3) / 2);
  const out = new Uint8Array(outN * 2);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < outN; i++) {
    const srcPos = (i * 2) / 3;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inN - 1);
    const frac = srcPos - i0;
    const s0 = inView.getInt16(i0 * 2, true);
    const s1 = inView.getInt16(i1 * 2, true);
    let v = Math.round((s0 + (s1 - s0) * frac) * gain);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    outView.setInt16(i * 2, v, true);
  }
  return out;
}

/** Peak absolute PCM16 sample value of a buffer (for adaptive normalization). */
function peakOf(pcm: Uint8Array): number {
  const n = pcm.byteLength >> 1;
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let pk = 0;
  for (let i = 0; i < n; i++) { const s = Math.abs(v.getInt16(i * 2, true)); if (s > pk) pk = s; }
  return pk;
}

/** Wrap tagged PCM16/24k mono segments in a minimal WAV, applying [callerGain]
 *  to the caller's segments only (per-call loudness normalization, clipped). */
function pcm16ToWav(
  segments: Array<{ caller: boolean; pcm: Uint8Array }>,
  dataLen: number, sampleRate: number, callerGain = 1,
): Uint8Array {
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const wr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); wr(8, "WAVE");
  wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, "data"); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (const seg of segments) {
    if (seg.caller && callerGain !== 1) {
      const n = seg.pcm.byteLength >> 1;
      const sv = new DataView(seg.pcm.buffer, seg.pcm.byteOffset, seg.pcm.byteLength);
      for (let i = 0; i < n; i++) {
        let v = Math.round(sv.getInt16(i * 2, true) * callerGain);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        dv.setInt16(off + i * 2, v, true);
      }
      off += seg.pcm.byteLength;
    } else {
      out.set(seg.pcm, off); off += seg.pcm.byteLength;
    }
  }
  return out;
}
