// ReceptionRoomCf — Ava Receptionist call bridge, CLOUDFLARE-NATIVE engine.
// SEPARATE from the Gemini engine (do/reception_room.ts), which is left untouched.
// One instance per session id. Same client WS contract as the Gemini bridge
// (PCM16 16k in / PCM16 24k out + JSON control), so the EXISTING Flutter app uses
// it with no change — /start just routes the WS to this DO when the
// `receptionistUseCf` KV flag is on (flip it off → calls go back to Gemini).
//
// Pipe:  caller app  <--WS (PCM16 16k in / PCM16 24k out)-->  ReceptionRoomCf DO
//        per turn:   STT (Workers AI) → LLM (Workers AI) → TTS (Workers AI) → caller
//
// Full-duplex with BARGE-IN: caller audio is endpointed on trailing silence, AND
// while Ava is speaking we keep listening — if the caller talks over her, we stop
// her audio, tell the client to drop its buffer ({t:"flush"}), and start the new
// turn. This is the SAME mechanism the Gemini bridge uses on the SAME client
// (continuous mic + flush), so it needs no app change. It relies on the client's
// on-device echo cancellation (already required by the Gemini path) so Ava's own
// voice on speakerphone doesn't self-trigger the interruption.
//
// On close it writes the message + recording under the caller's phone number into
// the owner's InboxDO and pushes the owner — identical delivery to the Gemini path.
//
// ⚠️ Workers AI model I/O shapes (STT audio input, Aura encoding=linear16, LLM
// usage fields) are wired per Cloudflare docs but MUST be verified against a live
// call on first deploy (cannot be unit-tested here). All paths are guarded.
import type { Env } from "../types";
import { trackUserContact, metric } from "../hooks";
import { dmConvId } from "../authz";
import { contactFor } from "../lib/identity";

/** Redact secrets from free-text error strings before telemetry. */
function scrubSecrets(s: string): string {
  return s
    .replace(/([?&](?:key|access_token|token|api_key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[redacted-key]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]");
}

// ── Cost (env-tunable; raw usage is also emitted so the true cost can be
// recomputed if a default drifts). Whisper $0.0005/audio-min is exact; Llama +
// Aura partner rates are best-effort and MUST be reconciled on first runs. ──
const CF_STT_USD_PER_MIN = 0.0005;
const CF_LLM_IN_USD_PER_M = 15;     // Claude Opus 4.8 via OpenRouter (≈; env-overridable)
const CF_LLM_OUT_USD_PER_M = 75;    // (≈)
const CF_TTS_USD_PER_MIN = 0.030;
const CF_STT_MODEL_DEFAULT = "@cf/openai/whisper-large-v3-turbo";
// LLM via OpenRouter (RECEPT_CF_LLM_MODEL overrides). Default = Claude Opus 4.8
// for the smartest message-taking; switch to anthropic/claude-sonnet-4.6 or
// claude-haiku-4.5 for LOWER LATENCY if Opus feels slow. Falls back to Workers AI
// Llama only if OPENROUTER_API_KEY is unset or the call errors.
const CF_LLM_MODEL_DEFAULT = "anthropic/claude-opus-4.8";
const CF_TTS_MODEL_DEFAULT = "@cf/deepgram/aura-2-en";
// Aura-2 female voices (subset of the 40 from the Phase-0 probe) — guards the
// configured voice so a bad value can't break TTS.
const AURA_FEMALE = new Set([
  "asteria", "athena", "aurora", "hera", "luna", "cora", "cordelia", "delia",
  "harmonia", "helena", "iris", "juno", "minerva", "ophelia", "pandora", "phoebe",
  "thalia", "theia", "vesta", "amalthea", "andromeda", "callista", "electra",
]);
const CF_ENDPOINT_MS = 550;                 // trailing silence that ends a caller turn (lower = snappier)
const CF_MIN_TURN_BYTES = 8000;             // ~0.25s @16k PCM16 — below = noise, ignore
const CF_MAX_TURN_BYTES = 16000 * 2 * 20;   // ~20s @16k PCM16 — force-process
// Barge-in: this much sustained caller speech (~300ms @16k) DURING Ava's playback
// interrupts her. Relies on client-side echo cancellation (same as the Gemini
// path) so Ava's own voice doesn't self-trigger it.
const CF_BARGE_BYTES = 16000 * 2 * 0.3;     // ~300ms of real speech

interface InitBlob {
  sid: string; owner_uid: string; caller_uid: string;
  caller_phone: string | null; caller_name: string | null; call_id: string | null;
  rtc_token: string; voice_name: string; file_search_store: string | null;
  system_prompt: string; model: string;
  soft_cap_ms: number; hard_cap_ms: number; started_at: number;
  language_code?: string | null; activation_mode?: string | null;
  owner_name?: string | null; ava_name?: string | null;
  engine?: "gemini" | "cf" | null; cf_voice?: string | null;
}

export class ReceptionRoomCf {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private init: InitBlob | null = null;
  private startedAt = 0;
  private softTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;

  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;
  private firstAudioSent = false;

  private inText: string[] = [];
  private outText: string[] = [];
  private dialog: Array<{ who: "ava" | "caller"; text: string }> = [];
  private pcmOut: Array<{ caller: boolean; pcm: Uint8Array }> = [];
  private pcmBytes = 0;
  private avaBytes = 0;
  private callerRecBytes = 0;
  private callerPeak = 0;
  private inBytes = 0;
  private turnCount = 0;

  // CF pipeline state
  private cfHistory: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  private cfTurnBuf: Uint8Array[] = [];
  private cfTurnBytes = 0;
  private cfHadSpeech = false;
  private cfEndpointTimer: ReturnType<typeof setTimeout> | null = null;
  private cfBusy = false;
  private cfSttSeconds = 0;
  private cfLlmTokIn = 0;
  private cfLlmTokOut = 0;
  private cfTtsChars = 0;
  private cfTtsSeconds = 0;
  private cfSpeaking = false;     // true while Ava's audio is playing → barge-in window open
  private cfBarged = false;
  private cfBargeBytes = 0;       // accumulated caller speech bytes during Ava's speech
  private cfSpeakResolve: (() => void) | null = null;
  private cfSpeakTimer: ReturnType<typeof setTimeout> | null = null;

  private static IDLE_MS = 10_000;
  private static MAX_REC_BYTES = 12 * 1024 * 1024;

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
    if (!init || init.rtc_token !== token) return new Response("forbidden", { status: 403 });
    this.init = init;
    this.startedAt = Date.now();
    try { const c = await contactFor(this.env, init.owner_uid); this.ownerEmail = c.email; this.ownerPhone = c.phone; } catch { /* best-effort */ }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.client = server;
    server.addEventListener("message", (ev) => this.onClientMessage(ev));
    server.addEventListener("close", () => this.finalize("caller_hangup"));
    server.addEventListener("error", () => this.finalize("error"));

    this.env.TOKENS.delete(`recept_rtc:${sid}`).catch(() => {}); // single-use

    this.startCfEngine().catch((e) => {
      this.ev("ava_recept_cf_start_failed", { error_scrubbed: scrubSecrets(String(e)).slice(0, 200), ms: Date.now() - this.startedAt });
      this.failHard("cf_start_failed");
    });

    this.softTimer = setTimeout(() => this.onSoftCap(), init.soft_cap_ms);
    this.hardTimer = setTimeout(() => this.finalize("hard_cap"), init.hard_cap_ms);
    return new Response(null, { status: 101, webSocket: client });
  }

  private ev(event: string, props: Record<string, unknown> = {}): void {
    const i = this.init;
    if (!i) return;
    trackUserContact(this.env, i.owner_uid, this.ownerEmail, this.ownerPhone, event, "receptionist",
      { ...props, call_id: i.call_id, activation_mode: i.activation_mode ?? null,
        engine: "cf", model: i.model, voice: this.cfVoice() }, i.sid);
  }

  private cfVoice(): string {
    const v = (this.init?.cf_voice || "").trim().toLowerCase();
    return AURA_FEMALE.has(v) ? v : "asteria";
  }
  private cfSttModel(): string { return String((this.env as any).RECEPT_CF_STT_MODEL || CF_STT_MODEL_DEFAULT); }
  private cfLlmModel(): string { return String((this.env as any).RECEPT_CF_LLM_MODEL || CF_LLM_MODEL_DEFAULT); }
  private cfTtsModel(): string { return String((this.env as any).RECEPT_CF_TTS_MODEL || CF_TTS_MODEL_DEFAULT); }

  private async startCfEngine(): Promise<void> {
    const init = this.init!;
    this.ev("ava_recept_cf_started", {
      latency_ms: Date.now() - this.startedAt,
      voice: this.cfVoice(), stt_model: this.cfSttModel(), llm_model: this.cfLlmModel(), tts_model: this.cfTtsModel(),
    });
    // The system prompt already carries the <END_CALL> ending instruction for the
    // CF engine (composeReceptionistPrompt with engine:"cf").
    this.cfHistory = [{ role: "system", content: init.system_prompt }];
    // Guard the greet like a turn so an eager caller talking during greet
    // generation is buffered (not raced into a second turn); barge-in still works
    // during the greet's playback via the cfSpeaking check in feedCfAudio.
    this.cfBusy = true;
    try { await this.cfAssistantTurn("[Caller connected — greet and offer to take a message now, in one short sentence.]"); }
    finally { this.cfBusy = false; }
    this.bumpIdle();
  }

  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as any;
    if (typeof d === "string") return; // no client control honored
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes) return;
    this.inBytes += bytes.byteLength;
    // 2-way recording: capture caller speech (upsampled to match Ava's 24k).
    if (this.pcmBytes < ReceptionRoomCf.MAX_REC_BYTES && callerHasSpeech(bytes)) {
      const up = upsample16to24(bytes);
      const pk = peakOf(up); if (pk > this.callerPeak) this.callerPeak = pk;
      this.pcmOut.push({ caller: true, pcm: up }); this.pcmBytes += up.byteLength; this.callerRecBytes += up.byteLength;
      this.bumpIdle();
    }
    this.feedCfAudio(bytes);
  }

  /** Full-duplex endpointing + barge-in detection. */
  private feedCfAudio(bytes: Uint8Array): void {
    if (this.finalized) return;
    const speech = callerHasSpeech(bytes);
    // (1) Ava is speaking → watch for the caller talking over her (barge-in).
    if (this.cfSpeaking) {
      if (speech) {
        this.cfBargeBytes += bytes.byteLength;
        if (this.cfBargeBytes >= CF_BARGE_BYTES) this.triggerBargeIn(bytes);
      } else {
        this.cfBargeBytes = Math.max(0, this.cfBargeBytes - bytes.byteLength); // decay on silence
      }
      return;
    }
    // (2) Ava is thinking (STT/LLM/TTS generating) → buffer an early start so the
    // caller's first words aren't lost, but don't endpoint until she's idle.
    if (this.cfBusy) {
      if (speech) { this.cfHadSpeech = true; this.cfTurnBuf.push(bytes); this.cfTurnBytes += bytes.byteLength; }
      return;
    }
    // (3) Listening → accumulate the turn and endpoint on trailing silence.
    if (speech) {
      this.cfHadSpeech = true;
      this.cfTurnBuf.push(bytes); this.cfTurnBytes += bytes.byteLength;
      if (this.cfEndpointTimer) { clearTimeout(this.cfEndpointTimer); this.cfEndpointTimer = null; }
      if (this.cfTurnBytes > CF_MAX_TURN_BYTES) void this.processCfTurn();
    } else if (this.cfHadSpeech && !this.cfEndpointTimer) {
      this.cfEndpointTimer = setTimeout(() => void this.processCfTurn(), CF_ENDPOINT_MS);
    }
  }

  /** Caller talked over Ava → stop her audio, drop the client's playback buffer,
   *  and seed the interruption as the next turn. */
  private triggerBargeIn(bytes: Uint8Array): void {
    this.cfSpeaking = false;
    this.cfBarged = true;
    this.cfBargeBytes = 0;
    try { this.client?.send(JSON.stringify({ t: "flush" })); } catch { /* caller gone */ }
    this.ev("ava_recept_barge_in", { route: "cf_vad", ms: Date.now() - this.startedAt });
    if (this.cfSpeakResolve) { const r = this.cfSpeakResolve; this.cfSpeakResolve = null; r(); } // end the speaking wait now
    this.cfHadSpeech = true; this.cfTurnBuf = [bytes]; this.cfTurnBytes = bytes.byteLength; // start the new turn
  }

  private async processCfTurn(): Promise<void> {
    if (this.finalized || this.cfBusy) return;
    if (this.cfEndpointTimer) { clearTimeout(this.cfEndpointTimer); this.cfEndpointTimer = null; }
    const frames = this.cfTurnBuf; const total = this.cfTurnBytes;
    this.cfTurnBuf = []; this.cfTurnBytes = 0; this.cfHadSpeech = false;
    if (total < CF_MIN_TURN_BYTES) return;
    this.cfBusy = true;
    try {
      const wav = pcm16ToWavMono(concatFrames(frames, total), 16000);
      this.cfSttSeconds += total / 32000;
      const heard = await this.cfStt(wav);
      if (heard) { this.inText.push(heard); this.pushDialog("caller", heard); }
      this.turnCount++;
      this.ev("ava_recept_turn", {
        turn: this.turnCount, in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
        in_bytes: this.inBytes, ava_bytes: this.pcmBytes, ms: Date.now() - this.startedAt,
      });
      await this.cfAssistantTurn(heard || "[caller was silent]");
    } catch (e) {
      this.ev("ava_recept_cf_turn_error", { error_scrubbed: scrubSecrets(String(e)).slice(0, 160) });
    } finally {
      this.cfBusy = false; this.bumpIdle();
    }
  }

  private async cfAssistantTurn(userContent: string): Promise<void> {
    if (this.finalized) return;
    this.cfHistory.push({ role: "user", content: userContent });
    let text = (await this.cfLlm()).trim();
    let end = false;
    if (text.includes("<END_CALL>")) { end = true; text = text.replace(/<END_CALL>/gi, "").trim(); }
    this.cfHistory.push({ role: "assistant", content: text || "..." });
    if (text) { this.outText.push(text); this.pushDialog("ava", text); await this.cfSpeak(text); }
    if (end) { this.ev("ava_recept_ended_by_agent", { ms: Date.now() - this.startedAt }); void this.finalize("ava_ended"); }
  }

  private async cfStt(wav: Uint8Array): Promise<string> {
    try {
      // whisper-large-v3-turbo wants audio as a base64 STRING (verified against the
      // live model 2026-06-29 — array/binary inputs are rejected with AiError 5006).
      const out: any = await this.env.AI.run(this.cfSttModel(), { audio: b64encode(wav) } as any);
      return String(out?.text ?? out?.transcription ?? out?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
    } catch (e) { this.ev("ava_recept_cf_stt_error", { error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); return ""; }
  }

  /** Chat completion via OpenRouter (Claude); falls back to Workers AI Llama only
   *  if OPENROUTER_API_KEY is unset or the OpenRouter call fails. */
  private async cfChat(messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<string> {
    const key = (this.env as any).OPENROUTER_API_KEY as string | undefined;
    if (key) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://avatok.ai", "X-Title": "AvaTok Receptionist" },
          body: JSON.stringify({ model: this.cfLlmModel(), messages, max_tokens: maxTokens, temperature: 0.4 }),
        });
        const j: any = await r.json().catch(() => ({}));
        const u = j?.usage; if (u) { this.cfLlmTokIn += Number(u.prompt_tokens) || 0; this.cfLlmTokOut += Number(u.completion_tokens) || 0; }
        const txt = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (txt) return txt;
        this.ev("ava_recept_cf_llm_error", { via: "openrouter", error_scrubbed: scrubSecrets(JSON.stringify(j?.error ?? j)).slice(0, 160) });
      } catch (e) { this.ev("ava_recept_cf_llm_error", { via: "openrouter", error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); }
    }
    try {
      const out: any = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages, max_tokens: maxTokens, temperature: 0.4 } as any);
      const u = out?.usage; if (u) { this.cfLlmTokIn += Number(u.prompt_tokens) || 0; this.cfLlmTokOut += Number(u.completion_tokens) || 0; }
      return String(out?.response ?? out?.result?.response ?? "").trim();
    } catch (e) { this.ev("ava_recept_cf_llm_error", { via: "workers_ai", error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); return ""; }
  }

  private async cfLlm(): Promise<string> {
    return this.cfChat(this.cfHistory, 120); // short replies → faster LLM + TTS
  }

  private async cfSpeak(text: string): Promise<void> {
    if (this.finalized || !text) return;
    this.cfTtsChars += text.length;
    try {
      const out: any = await this.env.AI.run(this.cfTtsModel(),
        { text: text.slice(0, 800), speaker: this.cfVoice(), encoding: "linear16", sample_rate: 24000 } as any);
      const pcm = await ttsToPcm(out);
      if (!pcm || !pcm.byteLength) return;
      if (this.pcmBytes < ReceptionRoomCf.MAX_REC_BYTES) { this.pcmOut.push({ caller: false, pcm }); this.pcmBytes += pcm.byteLength; }
      this.avaBytes += pcm.byteLength;
      this.cfTtsSeconds += pcm.byteLength / 48000;
      if (!this.firstAudioSent) { this.firstAudioSent = true; this.ev("ava_recept_first_audio", { ms: Date.now() - this.startedAt }); }
      // Stream the audio to the client (it buffers + plays in real time).
      for (let o = 0; o < pcm.byteLength; o += 24000) {
        try { this.client?.send(pcm.subarray(o, Math.min(o + 24000, pcm.byteLength))); } catch { /* caller gone */ }
      }
      this.bumpIdle();
      // Open the barge-in window for ~the audio's play duration. If the caller
      // talks over her, triggerBargeIn() flushes the client + resolves this early.
      this.cfBarged = false; this.cfBargeBytes = 0; this.cfSpeaking = true;
      const durMs = Math.ceil((pcm.byteLength / 48000) * 1000);
      await new Promise<void>((resolve) => {
        this.cfSpeakResolve = resolve;
        this.cfSpeakTimer = setTimeout(() => { this.cfSpeakResolve = null; resolve(); }, durMs);
      });
      if (this.cfSpeakTimer) { clearTimeout(this.cfSpeakTimer); this.cfSpeakTimer = null; }
      this.cfSpeaking = false;
    } catch (e) {
      this.cfSpeaking = false;
      this.ev("ava_recept_cf_tts_error", { error_scrubbed: scrubSecrets(String(e)).slice(0, 160) });
    }
  }

  private onSoftCap(): void {
    if (this.finalized) return;
    try { this.client?.send(JSON.stringify({ t: "softcap" })); } catch { /* ignore */ }
    metric(this.env, "ava_recept_softcap", [1]);
    this.ev("ava_recept_softcap", { at_ms: Date.now() - this.startedAt });
    if (!this.cfBusy) {
      void this.cfAssistantTurn("[SYSTEM: time's almost up — confirm the message in one sentence, say a short goodbye, then end with <END_CALL>.]");
    }
  }

  private bumpIdle(): void {
    if (this.finalized) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalize("inactivity"), ReceptionRoomCf.IDLE_MS);
  }

  private failHard(reason: string): void {
    this.ev("ava_recept_error", { stage: reason, fatal: true, ms: Date.now() - this.startedAt });
    try { this.client?.send(JSON.stringify({ t: "error", reason })); } catch { /* ignore */ }
    this.finalize(reason);
  }

  // -------------------------------------------------------------------------
  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.softTimer) clearTimeout(this.softTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfEndpointTimer) clearTimeout(this.cfEndpointTimer);
    if (this.cfSpeakTimer) clearTimeout(this.cfSpeakTimer);
    if (this.cfSpeakResolve) { const r = this.cfSpeakResolve; this.cfSpeakResolve = null; r(); } // unblock any speaking wait
    try { this.client?.send(JSON.stringify({ t: "ended", reason })); this.client?.close(1000, reason); } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    const now = Date.now();
    const durationS = Math.max(0, Math.round((now - this.startedAt) / 1000));
    const transcript = this.buildTranscript();

    let recordingUrl: string | null = null;
    try {
      if (this.pcmBytes > 0) {
        const callerGain = this.callerPeak > 0 ? Math.min(8, Math.max(1, 22000 / this.callerPeak)) : 1;
        const wav = pcm16ToWav(this.pcmOut, this.pcmBytes, 24000, callerGain);
        const phoneKey = (init.caller_phone || "unknown").replace(/[^\d+]/g, "") || "unknown";
        const key = `receptionist/${init.owner_uid}/${phoneKey}/${init.sid}.wav`;
        await this.env.BLOBS.put(key, wav, { httpMetadata: { contentType: "audio/wav" } });
        recordingUrl = key;
        this.ev("ava_recept_recording_stored", { bytes: wav.byteLength, ok: true, two_way: this.callerRecBytes > 0, ava_rec_bytes: this.avaBytes, caller_rec_bytes: this.callerRecBytes });
      }
    } catch (e) {
      this.ev("ava_recept_delivery_failed", { stage: "r2", error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
    }

    const summary = await this.cfSummarize(transcript).catch(() => null);
    const summaryJson = summary ? JSON.stringify(summary) : null;
    this.ev("ava_recept_summary_generated", { ok: !!summary, urgency: summary?.urgency ?? null });

    try {
      await this.env.DB_META.prepare(
        `UPDATE receptionist_sessions SET status='ended', ended_at=?2, duration_s=?3, cutoff_reason=?4,
           summary_json=?5, transcript=?6, recording_url=?7, updated_at=?2 WHERE id=?1`,
      ).bind(init.sid, now, durationS, reason, summaryJson, transcript || null, recordingUrl).run();
    } catch { /* ignore */ }

    const hadConversation = this.firstAudioSent || this.inText.length > 0 || this.pcmBytes > 0;
    try { await this.postMessage(init, summary, transcript, recordingUrl, durationS, hadConversation); } catch { /* best-effort */ }

    this.ev("ava_recept_message_posted", {
      caller_phone: init.caller_phone, duration_s: durationS, cutoff_reason: reason,
      has_recording: !!recordingUrl, has_transcript: !!transcript,
      in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
    });
    this.ev("ava_recept_session_ended", {
      cutoff_reason: reason, duration_s: durationS, got_audio: this.firstAudioSent,
      ava_audio_bytes: this.avaBytes, recording_bytes: this.pcmBytes, caller_rec_bytes: this.callerRecBytes,
      caller_audio_bytes: this.inBytes, two_way_recording: this.callerRecBytes > 0, turns: this.turnCount,
      in_chars: this.inText.join("").length, out_chars: this.outText.join("").length, has_recording: !!recordingUrl,
    });
    metric(this.env, reason === "hard_cap" ? "ava_recept_hardcap" : "ava_recept_completed", [1, durationS]);

    // ── COST telemetry (CF engine) — same event name as the Gemini path with
    // engine:"cf", plus RAW usage so the true cost can be recomputed. ──
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    const sttUsd = (this.cfSttSeconds / 60) * (Number((this.env as any).RECEPT_CF_STT_USD_MIN) || CF_STT_USD_PER_MIN);
    const llmUsd = (this.cfLlmTokIn / 1e6) * (Number((this.env as any).RECEPT_CF_LLM_IN_USD_M) || CF_LLM_IN_USD_PER_M)
                 + (this.cfLlmTokOut / 1e6) * (Number((this.env as any).RECEPT_CF_LLM_OUT_USD_M) || CF_LLM_OUT_USD_PER_M);
    const ttsUsd = (this.cfTtsSeconds / 60) * (Number((this.env as any).RECEPT_CF_TTS_USD_MIN) || CF_TTS_USD_PER_MIN);
    const estUsd = sttUsd + llmUsd + ttsUsd;
    this.ev("ava_recept_cost", {
      engine: "cf", duration_s: durationS,
      stt_model: this.cfSttModel(), llm_model: this.cfLlmModel(), tts_model: this.cfTtsModel(),
      stt_seconds: Math.round(this.cfSttSeconds * 10) / 10, stt_usd: round6(sttUsd),
      llm_tok_in: this.cfLlmTokIn, llm_tok_out: this.cfLlmTokOut, llm_usd: round6(llmUsd),
      tts_chars: this.cfTtsChars, tts_seconds: Math.round(this.cfTtsSeconds * 10) / 10, tts_usd: round6(ttsUsd),
      est_usd: round6(estUsd), cutoff_reason: reason,
    });
    metric(this.env, "ava_recept_cost_usd_micro", [Math.round(estUsd * 1e6)]);
  }

  private pushDialog(who: "ava" | "caller", text: string): void {
    const t = text.trim();
    if (!t) return;
    const last = this.dialog[this.dialog.length - 1];
    if (last && last.who === who) last.text = (last.text + " " + t).replace(/\s+/g, " ").trim();
    else this.dialog.push({ who, text: t });
  }

  private buildTranscript(): string {
    const avaName = (this.init?.ava_name || "Ava").trim() || "Ava";
    const callerName = (this.init?.caller_name || "Caller").trim() || "Caller";
    if (this.dialog.length > 0) return this.dialog.map((d) => `${d.who === "ava" ? avaName : callerName}: ${d.text}`).join("\n");
    const lines: string[] = [];
    if (this.inText.length) lines.push(callerName + ": " + this.inText.join(" ").trim());
    if (this.outText.length) lines.push(avaName + ": " + this.outText.join(" ").trim());
    return lines.join("\n");
  }

  /** One-shot message summary via Workers AI LLM (keeps the call Gemini-free). */
  private async cfSummarize(transcript: string):
      Promise<{ caller_name: string | null; reason: string; callback: string | null; urgency: string } | null> {
    if (!transcript) return null;
    try {
      const prompt = `From this phone-message transcript, return STRICT JSON {"caller_name":string|null,"reason":string,"callback":string|null,"urgency":"low"|"normal"|"high"}. Only the JSON. Transcript:\n${transcript.slice(0, 4000)}`;
      const txt = await this.cfChat([{ role: "user", content: prompt }], 200);
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      return {
        caller_name: o.caller_name ?? this.init?.caller_name ?? null,
        reason: String(o.reason ?? "Message taken"),
        callback: o.callback ?? null,
        urgency: ["low", "normal", "high"].includes(o.urgency) ? o.urgency : "normal",
      };
    } catch { return null; }
  }

  /** Append the receptionist card to the OWNER's inbox + caller ack. Mirrors the
   *  Gemini bridge's delivery so messages/recordings/pushes are identical. */
  private async postMessage(
    init: InitBlob, summary: any, transcript: string, recordingUrl: string | null,
    durationS: number, hadConversation: boolean,
  ): Promise<void> {
    const callerLabel = init.caller_name || init.caller_phone || "Unknown caller";
    const conv = init.caller_uid
      ? dmConvId(init.owner_uid, init.caller_uid)
      : (init.caller_phone ? `recept_${init.owner_uid}__tel:${init.caller_phone}` : `recept_${init.owner_uid}__unknown`);
    const inThread = !!init.caller_uid;
    const bodyText = summary
      ? `📞 ${summary.caller_name || callerLabel} called and left a message: ${summary.reason}`
      : hadConversation ? `📞 ${callerLabel} called — Ava answered.`
        : `📞 Missed call from ${callerLabel} — they hung up before leaving a message.`;
    const envelope = JSON.stringify({
      t: "recept", text: bodyText, session_id: init.sid,
      caller_name: init.caller_name, caller_phone: init.caller_phone,
      call_id: init.call_id, duration_s: durationS, activation_mode: init.activation_mode ?? null,
      summary, transcript, has_recording: !!recordingUrl,
    });
    const payload = {
      conv, sender: init.caller_uid || `tel:${init.caller_phone}`, kind: "receptionist",
      body: envelope, media_ref: recordingUrl, scope: `to:${init.owner_uid}`, created_at: Date.now(),
    };
    const stub = this.env.INBOX.get(this.env.INBOX.idFromName(init.owner_uid));
    await stub.fetch("https://inbox/append", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, owner: init.owner_uid }) });
    try {
      await this.env.Q_PUSH.send({ kind: "notify", to: init.owner_uid, fromName: "Ava", title: "Ava took a message", body: bodyText.replace(/^📞\s*/, ""), data: { type: "receptionist", conv, caller_phone: init.caller_phone } });
      this.ev("ava_recept_push_sent", { ok: true });
    } catch (e) {
      this.ev("ava_recept_delivery_failed", { stage: "push", error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
    }
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
          body: JSON.stringify({ conv, sender: init.owner_uid, kind: "text", body: JSON.stringify({ t: "text", body: ackText }), scope: `to:${init.caller_uid}`, created_at: Date.now(), owner: init.caller_uid }),
        });
        await this.env.Q_PUSH.send({ kind: "notify", to: init.caller_uid, fromName: ownerLabel });
        this.ev("ava_recept_caller_ack_sent", { ok: true });
      } catch (e) {
        this.ev("ava_recept_caller_ack_sent", { ok: false, error_scrubbed: scrubSecrets(String(e)).slice(0, 200) });
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function concatFrames(frames: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0; for (const f of frames) { out.set(f, o); o += f.byteLength; }
  return out;
}
function callerHasSpeech(pcm: Uint8Array): boolean {
  const n = pcm.byteLength >> 1;
  if (n === 0) return false;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sumSq += s * s; }
  return Math.sqrt(sumSq / n) > 600;
}
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
function peakOf(pcm: Uint8Array): number {
  const n = pcm.byteLength >> 1;
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let pk = 0;
  for (let i = 0; i < n; i++) { const s = Math.abs(v.getInt16(i * 2, true)); if (s > pk) pk = s; }
  return pk;
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
function stripWavHeader(buf: Uint8Array): Uint8Array {
  if (buf.byteLength > 44 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return buf.subarray(44);
  return buf;
}
async function ttsToPcm(out: any): Promise<Uint8Array | null> {
  if (!out) return null;
  let bytes: Uint8Array | null = null;
  if (out instanceof ArrayBuffer) bytes = new Uint8Array(out);
  else if (out instanceof Uint8Array) bytes = out;
  else if (typeof out.getReader === "function") {
    const reader = out.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    bytes = new Uint8Array(n); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
  } else {
    const b64 = typeof out === "string" ? out : (typeof out.audio === "string" ? out.audio : null);
    if (b64) bytes = b64decode(b64);
  }
  return bytes ? stripWavHeader(bytes) : null;
}
function pcm16ToWav(segments: Array<{ caller: boolean; pcm: Uint8Array }>, dataLen: number, sampleRate: number, callerGain = 1): Uint8Array {
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
    } else { out.set(seg.pcm, off); off += seg.pcm.byteLength; }
  }
  return out;
}
