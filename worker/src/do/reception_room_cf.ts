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
import { avaReasonRaw } from "../lib/ava_reason"; // One Brain B1: gateway for STT/LLM/TTS
import { aiRunOpts } from "../lib/ai_gate";       // AI Gateway cost-logging opts
import { googleSynthesizeForLang } from "../lib/google_tts"; // WaveNet voice, any language (RECEPT-TTS-GOOGLE)
import { sarvamTtsPcm } from "../lib/sarvam"; // Bulbul v3 India voice (RECEPT-TTS-SARVAM)

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
const CF_LLM_IN_USD_PER_M = 1;      // Claude Haiku 4.5 via OpenRouter (≈; env-overridable)
const CF_LLM_OUT_USD_PER_M = 5;     // (≈)
const CF_TTS_USD_PER_MIN = 0.030;
const CF_STT_MODEL_DEFAULT = "@cf/openai/whisper-large-v3-turbo";
// LLM via OpenRouter (RECEPT_CF_LLM_MODEL overrides). Default = Claude Haiku 4.5,
// chosen for LOW LATENCY (owner: "latency is everything") while still smart enough
// for message-taking. Switch to anthropic/claude-sonnet-4.6 / claude-opus-4.8 for
// more intelligence at higher latency. Falls back to Workers AI Llama only if
// OPENROUTER_API_KEY is unset or the call errors.
const CF_LLM_MODEL_DEFAULT = "anthropic/claude-haiku-4.5";
const CF_TTS_MODEL_DEFAULT = "@cf/deepgram/aura-2-en";
// Aura-2 female voices (subset of the 40 from the Phase-0 probe) — guards the
// configured voice so a bad value can't break TTS.
const AURA_FEMALE = new Set([
  "asteria", "athena", "aurora", "hera", "luna", "cora", "cordelia", "delia",
  "harmonia", "helena", "iris", "juno", "minerva", "ophelia", "pandora", "phoebe",
  "thalia", "theia", "vesta", "amalthea", "andromeda", "callista", "electra",
]);

// ── LANGUAGE (RECEPT-1) ───────────────────────────────────────────────────────
// The owner's language MUST flow end-to-end: STT, TTS, and the composed prompt.
// `language_code` in the init blob is a BCP-47 tag (e.g. "hi-IN", "en-US"); we
// reduce it to a base ISO-639 language ("hi", "en") for the model params below.
function baseLang(code?: string | null): string {
  const c = (code || "").trim().toLowerCase();
  if (!c) return "";
  // "cmn-CN" (Gemini's Mandarin tag) → "zh" for Deepgram/Aura naming.
  if (c.startsWith("cmn")) return "zh";
  return c.split(/[-_]/)[0];
}
function isEnglish(code?: string | null): boolean {
  const b = baseLang(code);
  return b === "" || b === "en";
}
// Deepgram Nova-3 STT: multilingual model handles most launch languages; feed the
// specific BCP-47 tag when we have one so recognition is tuned. English keeps the
// exact prior behaviour (en-US). Empty/unknown → "multi" (Nova auto language).
function sttLangParam(code?: string | null): string {
  const c = (code || "").trim();
  if (!c) return "multi";
  if (isEnglish(c)) return "en-US";
  return c; // e.g. "hi", "hi-IN", "es-ES" — Nova accepts BCP-47/ISO codes
}
// Deepgram Aura-2 TTS is per-language (aura-2-en is ENGLISH ONLY). For a
// non-English owner we must NOT force an English Aura voice or output is English
// phonemes ("Hindi accent"). Map base language → the best available multilingual/
// language-specific TTS path. Aura-2 currently ships strong ES; everything else
// routes to the multilingual model. English is left 100% unchanged.
//   returns { model, voice } — voice "" lets the model pick its default speaker.
function ttsForLang(code: string | null | undefined, englishVoice: string,
                    envTtsModel: string): { model: string; voice: string; fallback: boolean } {
  const b = baseLang(code);
  if (b === "" || b === "en") return { model: envTtsModel, voice: englishVoice, fallback: false };
  // Spanish → Aura-2 Spanish model with a female speaker.
  if (b === "es") return { model: "@cf/deepgram/aura-2-es", voice: "celeste", fallback: false };
  // Everything else Aura-2 can't cover → multilingual TTS. If the deployment has a
  // dedicated multilingual model configured, prefer it; else fall back to the
  // multilingual MeloTTS on Workers AI. `fallback:true` flags "best-effort path".
  return { model: "@cf/myshell-ai/melotts", voice: "", fallback: true };
}
// VOICEMAIL: a long endpoint so natural pauses don't cut the caller off mid-message;
// a big max so a continuous monologue is still captured in one shot; a 50s window.
const CF_ENDPOINT_MS = 2500;                // ~2.5s trailing silence ends a caller turn. Was 1000ms, which
                                            // cut callers off at the first natural mid-message pause (PostHog
                                            // 2026-06-30: ~20 chars captured from ~18s of audio → "message was
                                            // cut off"). Voicemail callers pause to think; 2.5s tolerates that.
const CF_MIN_TURN_BYTES = 8000;             // ~0.25s @16k PCM16 — below = noise, ignore
const CF_MAX_TURN_BYTES = 16000 * 2 * 55;   // ~55s @16k PCM16 — force-process a long message
const CF_MSG_WINDOW_MS = 25_000;            // ~25s caller message window (after the greeting); whole call wrapped in ~35s (matches SOFT/HARD_CAP_MS)
// Barge-in (greeting only): sustained caller speech (~300ms) over Ava's greeting lets
// them start their message early. Relies on client-side echo cancellation.
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
  greeting?: string | null; // deterministic greeting, spoken immediately (no LLM)
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
  private readyAckSent = false; // RECEPT-1: "ava_live" control frame fired at most once

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
  // Set when /api/call signals a live takeover (the owner dialed the caller who is
  // being screened): finalize() then CANCELS the voicemail (no recording, summary,
  // card or ack) and feedCfAudio stops processing — Ava just bows out.
  private takenOver = false;

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
  // Voicemail flow: listen → confirm. The confirmation is interruptible (the caller
  // may resume) until cfTimeUp — the 50s window (cfMsgTimer) elapses, after which the
  // close is final and input is ignored.
  private cfMsgTimer: ReturnType<typeof setTimeout> | null = null;
  private cfTimeUp = false;
  // DOUBLE SIGN-OFF latch (RECEPT-1): both onMsgCap (timer) and the endpoint path can
  // each trigger a FINAL closing turn → Ava says goodbye twice. `cfClosing` is set the
  // instant a final close turn STARTS; `saidGoodbye` once it has fully run. After a
  // final close no second closing/LLM turn may run — a later time-up just finalizes.
  private cfClosing = false;
  private saidGoodbye = false;
  // Streaming STT (Deepgram Nova over WebSocket): transcribe the caller live so the
  // transcript is ready the instant they stop (no post-speech STT round-trip).
  private stt: WebSocket | null = null;
  private sttFinals: string[] = []; // final transcript segments accumulated live
  private langMismatchEmitted = false; // RECEPT-1: fire ava_language_mismatch at most once

  private static IDLE_MS = 10_000;
  private static MAX_REC_BYTES = 12 * 1024 * 1024;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      // Control plane (not a WS): live-takeover signal from /api/call, acting on
      // this DO's already-running in-memory session (same idFromName(sid)).
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/takeover")) {
        return this.handleTakeover(req);
      }
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const sid = url.searchParams.get("session") || "";
    const token = url.searchParams.get("t") || "";

    const raw = await this.env.TOKENS.get(`recept_rtc:${sid}`, "json").catch(() => null);
    const init = raw as (InitBlob & { rtc_uses?: number }) | null;
    if (!init || init.rtc_token !== token) return new Response("forbidden", { status: 403 });
    // If THIS DO instance already ran and finalized (the reconnect raced the close of a
    // completed session), don't re-run the engine — the voicemail was already taken.
    if (this.finalized) return new Response("gone", { status: 410 });
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

    // AVA-LIVE ACK (RECEPT-1): tolerate ONE reconnect. A strictly single-use token
    // makes the app's reconnect-grace retry 403 (Issue 1). Instead of deleting the
    // token outright, we allow up to 2 uses within a short grace window: on the FIRST
    // connect we re-put it with a bumped use-count and a 20s TTL; the SECOND connect
    // (reconnect) still validates, then the token is finally removed. A 3rd use 403s.
    const uses = Number(init.rtc_uses || 0) + 1;
    if (uses >= 2) {
      // This is the tolerated reconnect (2nd use) — allow it, then remove the token
      // so a 3rd use 403s.
      this.env.TOKENS.delete(`recept_rtc:${sid}`).catch(() => {});
      this.ev("ava_live_retry", { attempt: uses, reason: "ws_reconnect" });
    } else {
      // First use — keep the token alive briefly so ONE reconnect can re-validate.
      this.env.TOKENS.put(`recept_rtc:${sid}`, JSON.stringify({ ...init, rtc_uses: uses }), { expirationTtl: 20 }).catch(() => {});
    }

    void this.connectStt(); // live transcription in parallel with the greeting
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

  // English (or unset) → the configured Aura female voice, EXACTLY as before. For a
  // non-English owner, ttsForLang() picks a language-appropriate speaker (or "" to
  // let a multilingual model use its default), so we never force asteria onto Hindi.
  private cfVoice(): string {
    const englishVoice = this.cfEnglishVoice();
    if (isEnglish(this.langCode())) return englishVoice;
    return ttsForLang(this.langCode(), englishVoice, this.cfEnvTtsModel()).voice;
  }
  private cfEnglishVoice(): string {
    const v = (this.init?.cf_voice || "").trim().toLowerCase();
    return AURA_FEMALE.has(v) ? v : "asteria";
  }
  /** Owner's chosen language (BCP-47) or "" for auto. */
  private langCode(): string { return (this.init?.language_code || "").trim(); }
  private cfSttModel(): string { return String((this.env as any).RECEPT_CF_STT_MODEL || CF_STT_MODEL_DEFAULT); }
  private cfLlmModel(): string { return String((this.env as any).RECEPT_CF_LLM_MODEL || CF_LLM_MODEL_DEFAULT); }
  private cfEnvTtsModel(): string { return String((this.env as any).RECEPT_CF_TTS_MODEL || CF_TTS_MODEL_DEFAULT); }
  // VAD / turn-taking knobs — env-tunable at RUNTIME (secrets apply without a redeploy)
  // so we can adjust live. Lower RMS = more sensitive to quiet speech; higher idle =
  // more patience before an "inactivity" close. Defaults loosened 2026-07-18 after a
  // live call closed on inactivity (caller speech never crossed the old 600 RMS gate).
  private vadRms(): number { const v = Number((this.env as any).RECEPT_CF_VAD_RMS); return Number.isFinite(v) && v > 0 ? v : 300; }
  private idleMs(): number { const v = Number((this.env as any).RECEPT_CF_IDLE_MS); return Number.isFinite(v) && v > 0 ? v : 18_000; }
  private endpointMs(): number { const v = Number((this.env as any).RECEPT_CF_ENDPOINT_MS); return Number.isFinite(v) && v > 0 ? v : CF_ENDPOINT_MS; }
  // English uses the configured (English) Aura model unchanged; non-English routes
  // to a language-appropriate / multilingual model so output isn't English phonemes.
  private cfTtsModel(): string {
    const env = this.cfEnvTtsModel();
    if (isEnglish(this.langCode())) return env;
    return ttsForLang(this.langCode(), this.cfEnglishVoice(), env).model;
  }

  private async startCfEngine(): Promise<void> {
    const init = this.init!;
    // LANGUAGE (RECEPT-1): record what language we actually resolved end-to-end so a
    // Hindi-spoke-English regression is visible in one event.
    const requestedLang = this.langCode() || "auto";
    const ttsSel = ttsForLang(this.langCode(), this.cfEnglishVoice(), this.cfEnvTtsModel());
    this.ev("ava_language_selected", {
      requested: requestedLang,
      effective: isEnglish(this.langCode()) ? "en" : baseLang(this.langCode()),
      stt: sttLangParam(this.langCode()),
      tts: this.cfTtsModel(),
      tts_voice: this.cfVoice(),
      fallback: ttsSel.fallback,
    });
    this.ev("ava_recept_cf_started", {
      latency_ms: Date.now() - this.startedAt,
      language_code: this.langCode() || null,
      voice: this.cfVoice(), stt_model: this.cfSttModel(), llm_model: this.cfLlmModel(), tts_model: this.cfTtsModel(),
    });
    this.cfHistory = [{ role: "system", content: init.system_prompt }];
    const greeting = (init.greeting || "").trim();
    this.cfBusy = true;
    try {
      if (greeting) {
        // INSTANT greeting: speak the server-composed line DIRECTLY — no LLM round
        // trip (that was the ~5s of dead air). Seed it into history for context.
        this.outText.push(greeting); this.pushDialog("ava", greeting);
        this.cfHistory.push({ role: "assistant", content: greeting });
        await this.cfSpeak(greeting);
      } else {
        await this.cfAssistantTurn("[Caller connected — give your one-sentence voicemail greeting now, then stop and listen.]");
      }
    } finally { this.cfBusy = false; }
    // Caller now has ~50s to leave their message; when it elapses Ava cuts in.
    this.cfMsgTimer = setTimeout(() => this.onMsgCap(), CF_MSG_WINDOW_MS);
    this.bumpIdle();
  }

  /** The caller's ~50s window elapsed → from here the close is FINAL (no resuming). */
  private onMsgCap(): void {
    if (this.finalized) return;
    this.cfTimeUp = true;
    // DOUBLE SIGN-OFF: if a final close already ran (or is running), do NOT start a
    // second closing turn — just finalize. This is the timer-vs-endpoint race that
    // produced two goodbyes.
    if (this.saidGoodbye || this.cfClosing) {
      this.ev("ava_double_closing_blocked", { duplicate_source: "timer" });
      void this.finalize("time_up");
      return;
    }
    if (this.cfSpeaking || this.cfBusy) return; // a turn/close is already running → it will finalize
    void this.processCfTurn();
  }

  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as any;
    if (typeof d === "string") return; // no client control honored
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes) return;
    this.inBytes += bytes.byteLength;
    // 2-way recording: capture caller speech (upsampled to match Ava's 24k).
    if (this.pcmBytes < ReceptionRoomCf.MAX_REC_BYTES && callerHasSpeech(bytes, this.vadRms())) {
      const up = upsample16to24(bytes);
      const pk = peakOf(up); if (pk > this.callerPeak) this.callerPeak = pk;
      this.pcmOut.push({ caller: true, pcm: up }); this.pcmBytes += up.byteLength; this.callerRecBytes += up.byteLength;
      this.bumpIdle();
    }
    try { this.stt?.send(bytes); } catch { /* stt socket gone */ } // live transcription
    this.feedCfAudio(bytes);
  }

  /** Full-duplex endpointing + barge-in detection. */
  private feedCfAudio(bytes: Uint8Array): void {
    if (this.finalized || this.cfTimeUp || this.takenOver) return; // close/takeover in progress → ignore input
    const speech = callerHasSpeech(bytes, this.vadRms());
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
      // Active speech keeps the call alive: reset the inactivity timer so a long
      // continuous message (after the first turn re-armed it via bumpIdle) is
      // never finalized as "inactivity" mid-sentence. Only true trailing silence
      // for IDLE_MS ends the call.
      this.bumpIdle();
      if (this.cfEndpointTimer) { clearTimeout(this.cfEndpointTimer); this.cfEndpointTimer = null; }
      if (this.cfTurnBytes > CF_MAX_TURN_BYTES) void this.processCfTurn();
    } else if (this.cfHadSpeech && !this.cfEndpointTimer) {
      this.cfEndpointTimer = setTimeout(() => void this.processCfTurn(), this.endpointMs());
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

  /** VOICEMAIL: transcribe the caller's message and give ONE confirmation. The close
   *  is INTERRUPTIBLE until the 50s mark — if the caller starts talking again during
   *  it, we keep listening instead of ending. Only time-up (or no interruption) ends. */
  private async processCfTurn(): Promise<void> {
    if (this.finalized || this.cfBusy) return;
    // DOUBLE SIGN-OFF: once a FINAL close has run (or is running), never start another
    // closing/LLM turn. A time-up that lands after a completed close just finalizes.
    if (this.saidGoodbye || this.cfClosing) {
      this.ev("ava_double_closing_blocked", { duplicate_source: this.cfTimeUp ? "timer" : "endpoint" });
      if (this.saidGoodbye && !this.finalized) void this.finalize("time_up");
      return;
    }
    // A close is FINAL when the message window has elapsed — latch it up-front so a
    // racing endpoint/timer can't sneak a second closing turn in behind it.
    const isFinalClose = this.cfTimeUp;
    if (isFinalClose) { this.cfClosing = true; this.ev("ava_closing_started", { closing_reason: "time_up" }); }
    if (this.cfEndpointTimer) { clearTimeout(this.cfEndpointTimer); this.cfEndpointTimer = null; }
    if (this.cfTimeUp && this.cfMsgTimer) { clearTimeout(this.cfMsgTimer); this.cfMsgTimer = null; }
    const frames = this.cfTurnBuf; const total = this.cfTurnBytes;
    this.cfTurnBuf = []; this.cfTurnBytes = 0; this.cfHadSpeech = false;
    this.cfBusy = true;
    try {
      // Prefer the LIVE streamed transcript (ready instantly — no post-speech STT
      // round-trip). Fall back to whole-clip Whisper only if streaming gave nothing.
      this.cfSttSeconds += total / 32000;
      let heard = this.sttFinals.join(" ").replace(/\s+/g, " ").trim();
      this.sttFinals = [];
      if (!heard && total >= CF_MIN_TURN_BYTES) {
        heard = await this.cfStt(pcm16ToWavMono(concatFrames(frames, total), 16000));
      }
      if (heard) { this.inText.push(heard); this.pushDialog("caller", heard); }
      this.turnCount++;
      this.ev("ava_recept_turn", {
        turn: this.turnCount, engine: "cf", time_up: this.cfTimeUp,
        in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
        in_bytes: this.inBytes, ava_bytes: this.pcmBytes, ms: Date.now() - this.startedAt,
      });
      this.cfBarged = false; // did the caller interrupt THIS close?
      // At TIME-UP the current turn's buffer is often empty (the caller already
      // paused), but EARLIER turns captured the real message into inText. Passing
      // "[no message]" here made Ava close with "no message" even though the caller
      // DID leave one (owner report 2026-07-01: "I left a message… then she said no
      // message and exited"). Fall back to the ACCUMULATED transcript so her close
      // references what was actually said. (inText already includes `heard`.)
      const priorMsg = this.inText.join(" ").replace(/\s+/g, " ").trim();
      const closeMsg = heard || priorMsg;
      await this.cfAssistantTurn(closeMsg ? `Caller's message: "${closeMsg.slice(0, 500)}"` : "[the caller left no message]");
    } catch (e) {
      this.ev("ava_recept_cf_turn_error", { error_scrubbed: scrubSecrets(String(e)).slice(0, 160) });
    } finally {
      this.cfBusy = false;
    }
    if (isFinalClose) { this.saidGoodbye = true; this.ev("ava_closing_completed", { duration: Date.now() - this.startedAt }); }
    if (this.finalized) return;
    if (this.cfTimeUp) { void this.finalize("time_up"); }              // 50s up → final close → end
    else {
      // VOICEMAIL FIX (2026-06-30): do NOT hang up after the caller's first
      // endpointed turn. The old `finalize("ava_ended")` here ended the call the
      // moment the caller paused, after a single Ava confirmation — so only the
      // first phrase was ever transcribed (PostHog: in_chars≈20 from ~18s of
      // audio, turns=1, cutoff=ava_ended → summary "message was cut off"). The
      // close was meant to be interruptible only via barge-in, which a caller who
      // politely waits for Ava never triggers. Now, after Ava's brief
      // acknowledgement we ALWAYS return to listening so the caller can finish
      // their message across natural pauses. The call still ends deterministically
      // on the 50s time cap (above) or IDLE_MS of true trailing silence
      // (bumpIdle → finalize("inactivity")). This matches the documented intent.
      this.cfBarged = false;
      this.bumpIdle();
    }
  }

  private async cfAssistantTurn(userContent: string): Promise<void> {
    if (this.finalized) return;
    if (this.cfTimeUp) this.cfHistory.push({ role: "user", content: "[SYSTEM: time is up]" });
    this.cfHistory.push({ role: "user", content: userContent });
    const raw = (await this.cfLlm()).trim();
    // CLOSE-ON-GOODBYE (owner 2026-07-19): end the call the moment Ava signs off,
    // instead of holding the line open until the hard timer (which made her wake up
    // again after "have a great day"). Honor the model's <END_CALL> marker AND detect
    // a spoken goodbye, because a small model often drops the marker. She still speaks
    // her FULL closing line first (cfSpeak awaits playback), THEN we finalize.
    const wantsEnd = /<END_CALL>/i.test(raw) || (!this.cfTimeUp && isGoodbyeLine(raw));
    const text = raw.replace(/<END_CALL>/gi, "").trim();
    this.cfHistory.push({ role: "assistant", content: text || "..." });
    if (text) { this.outText.push(text); this.pushDialog("ava", text); await this.cfSpeak(text); }
    if (wantsEnd && !this.finalized) { this.saidGoodbye = true; this.cfClosing = true; this.ev("ava_recept_cf_goodbye_close", {}); void this.finalize("ava_goodbye"); }
  }

  private async cfStt(wav: Uint8Array): Promise<string> {
    try {
      // whisper-large-v3-turbo wants audio as a base64 STRING (verified against the
      // live model 2026-06-29 — array/binary inputs are rejected with AiError 5006).
      const out: any = await avaReasonRaw(this.env, {
        role: "receptionist", capability: "stt", trigger: "caller_turn", feature: "receptionist_stt",
        verb: "transcribe", model: this.cfSttModel(), uid: this.init?.owner_uid,
        raw: { audio: b64encode(wav) }, aiRunOpts: aiRunOpts(this.env, this.init?.owner_uid),
      });
      return String(out?.text ?? out?.transcription ?? out?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
    } catch (e) { this.ev("ava_recept_cf_stt_error", { error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); return ""; }
  }

  /** Open Deepgram Nova streaming STT so the caller is transcribed AS THEY TALK —
   *  transcript ready the instant they stop, plus a clean `speech_final` end-of-turn
   *  signal. Best-effort: if it can't connect, the whole-clip Whisper fallback in
   *  processCfTurn keeps the receptionist working (just at higher latency). */
  private async connectStt(): Promise<void> {
    // STT provider switch (RECEPT_CF_STT_STREAM, owner 2026-07-18): set to "off"/
    // "whisper" to SKIP Deepgram Nova streaming and transcribe each turn with the
    // cheaper whole-clip Whisper in processCfTurn (~18× cheaper: $0.0005 vs $0.0092
    // per audio-min; trades a small post-turn latency). Turn-ending then relies on
    // the energy-VAD endpointer (CF_ENDPOINT_MS), which is what we tune. Runtime-
    // toggleable via secret — a new call reads the current value.
    const sttMode = String((this.env as any).RECEPT_CF_STT_STREAM ?? "").toLowerCase();
    if (sttMode === "off" || sttMode === "0" || sttMode === "false" || sttMode === "whisper") {
      this.ev("ava_recept_cf_stt_stream", { ms: -1, mode: "whisper_only" });
      return;
    }
    const token = (this.env as any).AI_WS_TOKEN as string | undefined;
    const acc = (this.env as any).CF_ACCOUNT_ID as string | undefined;
    if (!token || !acc) return; // no token → Whisper fallback path stays in effect
    // LANGUAGE (RECEPT-1): thread the owner's chosen language into Deepgram Nova so a
    // Hindi/Spanish/etc caller isn't transcribed as garbled English. English is
    // unchanged (en-US); unset → "multi" (Nova auto-detect).
    const sttLang = sttLangParam(this.langCode());
    const url = `https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/@cf/deepgram/nova-3?encoding=linear16&sample_rate=16000&interim_results=true&endpointing=1000&punctuate=true&language=${encodeURIComponent(sttLang)}`;
    try {
      const resp = await fetch(url, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
      const ws = (resp as any).webSocket as WebSocket | undefined;
      if (!ws) { this.ev("ava_recept_cf_stt_error", { stage: "ws_no_socket" }); return; }
      ws.accept();
      this.stt = ws;
      ws.addEventListener("message", (e) => this.onSttMessage(e));
      ws.addEventListener("close", () => { this.stt = null; });
      ws.addEventListener("error", () => { this.stt = null; });
      this.ev("ava_recept_cf_stt_stream", { ms: Date.now() - this.startedAt });
    } catch (e) {
      this.ev("ava_recept_cf_stt_error", { stage: "ws_connect", error_scrubbed: scrubSecrets(String(e)).slice(0, 160) });
    }
  }

  /** Nova transcript events: accumulate finals; `speech_final` = end-of-turn → close. */
  private onSttMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    let m: any;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)); } catch { return; }
    if (m?.type !== "Results") return;
    // LANGUAGE (RECEPT-1): if Nova reports a detected language that differs from the
    // owner's requested language, surface it once so we can catch mis-config / a
    // caller speaking a different language than the owner set.
    if (!this.langMismatchEmitted) {
      const detected = String(
        m.channel?.detected_language ?? m.channel?.alternatives?.[0]?.languages?.[0] ?? m.language ?? "",
      ).trim();
      const requested = baseLang(this.langCode());
      if (detected && requested && baseLang(detected) !== requested) {
        this.langMismatchEmitted = true;
        this.ev("ava_language_mismatch", { requested, detected: baseLang(detected), reason: "stt_detected" });
      }
    }
    const t = m.channel?.alternatives?.[0]?.transcript;
    if (m.is_final && typeof t === "string" && t.trim()) this.sttFinals.push(t.trim());
    // Deepgram detected end-of-turn (caller paused) → close now; transcript is ready.
    if (m.speech_final && !this.cfSpeaking && !this.cfBusy && !this.cfTimeUp) void this.processCfTurn();
  }

  /** Chat completion via OpenRouter (Claude); falls back to Workers AI Llama only
   *  if OPENROUTER_API_KEY is unset or the OpenRouter call fails. */
  private async cfChat(messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<string> {
    // Sarvam-M brain (RECEPT_CF_LLM_PROVIDER=sarvam, owner 2026-07-19): India-tuned,
    // strong Hindi. OpenAI-compatible /v1/chat/completions with the api-subscription-key
    // header. On failure we fall through to the OpenRouter/Llama path below.
    if (String((this.env as any).RECEPT_CF_LLM_PROVIDER || "").toLowerCase() === "sarvam") {
      const skey = (this.env as any).SARVAM_API_KEY as string | undefined;
      if (skey) {
        try {
          const r = await fetch("https://api.sarvam.ai/v1/chat/completions", {
            method: "POST",
            headers: { "api-subscription-key": skey, "Content-Type": "application/json" },
            // Sarvam chat is a REASONING model: it spends tokens in reasoning_content
            // before content. reasoning_effort "low" minimizes the think budget, and we
            // give headroom (+220) so the actual answer completes instead of truncating.
            body: JSON.stringify({ model: this.cfLlmModel(), messages, max_tokens: Math.max(maxTokens + 220, 320), temperature: 0.4, reasoning_effort: "low" }),
          });
          const j: any = await r.json().catch(() => ({}));
          const u = j?.usage; if (u) { this.cfLlmTokIn += Number(u.prompt_tokens) || 0; this.cfLlmTokOut += Number(u.completion_tokens) || 0; }
          const txt = String(j?.choices?.[0]?.message?.content ?? "").trim();
          if (txt) return txt;
          this.ev("ava_recept_cf_llm_error", { via: "sarvam", error_scrubbed: scrubSecrets(JSON.stringify(j?.error ?? j)).slice(0, 160) });
        } catch (e) { this.ev("ava_recept_cf_llm_error", { via: "sarvam", error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); }
      }
    }
    const key = (this.env as any).OPENROUTER_API_KEY as string | undefined;
    if (key) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://avatok.ai", "X-Title": "AvaTok Receptionist" },
          body: JSON.stringify({ model: this.cfLlmModel(), messages, max_tokens: maxTokens, temperature: 0.4,
            // Pin the OpenRouter upstream provider (RECEPT_CF_LLM_PROVIDER, e.g. "Groq")
            // for speed; allow_fallbacks keeps the call working if that provider is down.
            ...(String((this.env as any).RECEPT_CF_LLM_PROVIDER || "").trim()
              ? { provider: { order: [String((this.env as any).RECEPT_CF_LLM_PROVIDER).trim()], allow_fallbacks: true } } : {}) }),
        });
        const j: any = await r.json().catch(() => ({}));
        const u = j?.usage; if (u) { this.cfLlmTokIn += Number(u.prompt_tokens) || 0; this.cfLlmTokOut += Number(u.completion_tokens) || 0; }
        const txt = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (txt) return txt;
        this.ev("ava_recept_cf_llm_error", { via: "openrouter", error_scrubbed: scrubSecrets(JSON.stringify(j?.error ?? j)).slice(0, 160) });
      } catch (e) { this.ev("ava_recept_cf_llm_error", { via: "openrouter", error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); }
    }
    try {
      const out: any = await avaReasonRaw(this.env, {
        role: "receptionist", capability: "chat", trigger: "assistant_turn", feature: "receptionist_llm",
        verb: "reason", model: "@cf/meta/llama-3.1-8b-instruct-fast", uid: this.init?.owner_uid,
        raw: { messages, max_tokens: maxTokens, temperature: 0.4 }, aiRunOpts: aiRunOpts(this.env, this.init?.owner_uid),
      });
      const u = out?.usage; if (u) { this.cfLlmTokIn += Number(u.prompt_tokens) || 0; this.cfLlmTokOut += Number(u.completion_tokens) || 0; }
      return String(out?.response ?? out?.result?.response ?? "").trim();
    } catch (e) { this.ev("ava_recept_cf_llm_error", { via: "workers_ai", error_scrubbed: scrubSecrets(String(e)).slice(0, 160) }); return ""; }
  }

  private async cfLlm(): Promise<string> {
    return this.cfChat(this.cfHistory, 120); // short replies → faster LLM + TTS
  }

  /** STREAMING TTS: request raw PCM (encoding linear16, container none) with
   *  returnRawResponse so we get a ReadableStream, and forward each chunk to the
   *  client AS IT GENERATES — first audio in ~0.5s instead of waiting for the whole
   *  synthesis (~3s). Barge-in still works throughout playback. */
  private async cfSpeak(text: string): Promise<void> {
    if (this.finalized || !text) return;
    this.cfTtsChars += text.length;
    this.cfBarged = false; this.cfBargeBytes = 0; this.cfSpeaking = true;
    let bytesSent = 0;
    let firstChunkAt = 0;
    let firstChunk = true;
    let carry: Uint8Array | null = null; // odd trailing byte held for 16-bit alignment
    try {
      // Google WaveNet is the DEFAULT voice for EVERY language (RECEPT-TTS-GOOGLE,
      // owner decision 2026-07-18: "disable aura, wavenet default, any language").
      // googleSynthesizeForLang resolves the session language to a WaveNet-first
      // voice for that language. Non-streaming REST; on null (secret unset or error)
      // we fall through to the legacy Deepgram/melotts path below, so a Google outage
      // never silences Ava and the whole thing is disabled by unsetting
      // GOOGLE_TTS_SA_JSON — no redeploy.
      let gPcm: Uint8Array | null = null;
      const ttsProvider = String((this.env as any).RECEPT_CF_TTS_PROVIDER || "").toLowerCase();
      if (ttsProvider === "sarvam" && (this.env as any).SARVAM_API_KEY) {
        gPcm = await sarvamTtsPcm(this.env, {
          text: text.slice(0, 2000), langCode: this.langCode(),
          speaker: String((this.env as any).RECEPT_CF_SARVAM_SPEAKER || "priya"),
          defaultLang: String((this.env as any).RECEPT_CF_SARVAM_LANG || "en-IN"),
          sampleRate: 24000,
        });
        this.ev("ava_recept_cf_tts_provider", { provider: gPcm ? "sarvam" : "fallback", lang: this.langCode() || "auto" });
      } else if ((this.env as any).GOOGLE_TTS_SA_JSON) {
        gPcm = await googleSynthesizeForLang(this.env, {
          text: text.slice(0, 800),
          langCode: this.langCode(),
          preferVoice: String((this.env as any).RECEPT_CF_GOOGLE_VOICE || "hi-IN-Wavenet-E"),
          defaultLang: String((this.env as any).RECEPT_CF_GOOGLE_LANG || "en-IN"),
          tier: String((this.env as any).RECEPT_CF_GOOGLE_TIER || "wavenet"),
          sampleRate: 24000,
        });
        this.ev("ava_recept_cf_tts_provider", { provider: gPcm ? "google" : "fallback", lang: this.langCode() || "auto" });
      }
      const resp: any = gPcm ? null : await avaReasonRaw(this.env, {
        role: "receptionist", capability: "tts", trigger: "speak", feature: "receptionist_tts",
        verb: "speak", model: this.cfTtsModel(), uid: this.init?.owner_uid,
        raw: { text: text.slice(0, 800), speaker: this.cfVoice(), encoding: "linear16", sample_rate: 24000, container: "none" },
        // returnRawResponse keeps the streaming ReadableStream contract; gateway
        // opts (when configured) merge into the same env.AI.run options object.
        aiRunOpts: { returnRawResponse: true, ...(aiRunOpts(this.env, this.init?.owner_uid) || {}) },
      });
      const body: any = resp?.body ?? null;
      if (gPcm && gPcm.byteLength) {
        // Buffered send of the Google PCM (already full LINEAR16 @24kHz). Same
        // record + chunked-send + first-audio-ack shape as the fallback branch below.
        if (this.pcmBytes < ReceptionRoomCf.MAX_REC_BYTES) { this.pcmOut.push({ caller: false, pcm: gPcm }); this.pcmBytes += gPcm.byteLength; }
        this.avaBytes += gPcm.byteLength; bytesSent = gPcm.byteLength; firstChunkAt = Date.now();
        if (!this.firstAudioSent) { this.firstAudioSent = true; this.sendReadyAck(); this.ev("ava_recept_first_audio", { engine: "cf", ms: Date.now() - this.startedAt }); }
        for (let o = 0; o < gPcm.byteLength && !this.cfBarged && !this.finalized; o += 24000) { try { this.client?.send(gPcm.subarray(o, Math.min(o + 24000, gPcm.byteLength))); } catch { /* caller gone */ } }
      } else if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        for (;;) {
          if (this.cfBarged || this.finalized) { try { await reader.cancel(); } catch { /* ignore */ } break; }
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          let chunk: Uint8Array = value;
          if (firstChunk) { chunk = stripWavHeader(value); firstChunk = false; } // strip a leading WAV header if container:none wasn't honored
          // 16-BIT ALIGNMENT: Deepgram streams arbitrary byte lengths. An odd-length
          // PCM16 chunk shifts every later sample by a byte → pure noise. So prepend
          // any carried byte and hold back a trailing odd byte for the next chunk.
          if (carry) { const m = new Uint8Array(carry.length + chunk.length); m.set(carry, 0); m.set(chunk, carry.length); chunk = m; carry = null; }
          if (chunk.length % 2 === 1) { carry = new Uint8Array([chunk[chunk.length - 1]]); chunk = chunk.subarray(0, chunk.length - 1); }
          if (chunk.length === 0) continue;
          if (this.pcmBytes < ReceptionRoomCf.MAX_REC_BYTES) { this.pcmOut.push({ caller: false, pcm: chunk }); this.pcmBytes += chunk.byteLength; }
          this.avaBytes += chunk.byteLength; bytesSent += chunk.byteLength;
          if (!firstChunkAt) firstChunkAt = Date.now();
          if (!this.firstAudioSent) { this.firstAudioSent = true; this.sendReadyAck(); this.ev("ava_recept_first_audio", { engine: "cf", ms: Date.now() - this.startedAt }); }
          try { this.client?.send(chunk); } catch { /* caller gone */ }
        }
      } else {
        // Fallback: buffered path (binding didn't give a streamable body).
        const pcm = await ttsToPcm(resp);
        if (pcm && pcm.byteLength) {
          if (this.pcmBytes < ReceptionRoomCf.MAX_REC_BYTES) { this.pcmOut.push({ caller: false, pcm }); this.pcmBytes += pcm.byteLength; }
          this.avaBytes += pcm.byteLength; bytesSent = pcm.byteLength; firstChunkAt = Date.now();
          if (!this.firstAudioSent) { this.firstAudioSent = true; this.sendReadyAck(); this.ev("ava_recept_first_audio", { engine: "cf", ms: Date.now() - this.startedAt }); }
          for (let o = 0; o < pcm.byteLength; o += 24000) { try { this.client?.send(pcm.subarray(o, Math.min(o + 24000, pcm.byteLength))); } catch { /* caller gone */ } }
        }
      }
      this.cfTtsSeconds += bytesSent / 48000;
      this.bumpIdle();
      // Keep the barge-in window open for the REMAINING playback time (the client
      // buffers what we streamed). Interruptible — triggerBargeIn resolves it early.
      if (!this.cfBarged && !this.finalized && bytesSent > 0 && firstChunkAt) {
        const residual = (firstChunkAt + Math.ceil((bytesSent / 48000) * 1000)) - Date.now();
        if (residual > 0) {
          await new Promise<void>((resolve) => {
            this.cfSpeakResolve = resolve;
            this.cfSpeakTimer = setTimeout(() => { this.cfSpeakResolve = null; resolve(); }, residual);
          });
          if (this.cfSpeakTimer) { clearTimeout(this.cfSpeakTimer); this.cfSpeakTimer = null; }
        }
      }
    } catch (e) {
      this.ev("ava_recept_cf_tts_error", { error_scrubbed: scrubSecrets(String(e)).slice(0, 160) });
    } finally {
      this.cfSpeaking = false;
    }
  }

  private onSoftCap(): void {
    if (this.finalized || this.cfTimeUp) return;
    try { this.client?.send(JSON.stringify({ t: "softcap" })); } catch { /* ignore */ }
    metric(this.env, "ava_recept_softcap", [1]);
    this.ev("ava_recept_softcap", { engine: "cf", at_ms: Date.now() - this.startedAt });
    this.onMsgCap(); // backstop for the 50s message timer — force the time's-up close
  }

  private bumpIdle(): void {
    if (this.finalized) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalize("inactivity"), this.idleMs());
  }

  /** AVA-LIVE ACK (RECEPT-1): tell the client the instant Ava is truly live — sent
   *  the moment her first greeting audio starts streaming. The client gates its
   *  "Ava is taking your call" text on this frame, so it never shows over dead air
   *  when the engine failed to start. Fires exactly once. */
  private sendReadyAck(): void {
    if (this.readyAckSent) return;
    this.readyAckSent = true;
    const ms = Date.now() - this.startedAt;
    try { this.client?.send(JSON.stringify({ t: "ready", type: "ready", ava_live: true, ms })); } catch { /* caller gone */ }
    this.ev("ava_live_ack_received", { ack_latency_ms: ms, ms });
  }

  private failHard(reason: string): void {
    this.ev("ava_recept_error", { stage: reason, fatal: true, ms: Date.now() - this.startedAt });
    try { this.client?.send(JSON.stringify({ t: "error", reason })); } catch { /* ignore */ }
    this.finalize(reason);
  }

  /** Live takeover: the owner dialed the caller who is mid-message. Ava bows out
   *  with one short line and the voicemail is cancelled; /api/call rings the
   *  owner's call through in parallel so they connect live. Acts on the in-memory
   *  active session (this DO already holds the caller's WS). */
  private async handleTakeover(req: Request): Promise<Response> {
    if (!this.init || this.finalized) return new Response("no_active_session", { status: 409 });
    if (this.takenOver) return new Response("ok"); // idempotent
    this.takenOver = true;
    let body: any = {};
    try { body = await req.json(); } catch { /* tolerate empty body */ }
    const ownerLabel = String(body.owner_name || this.init.owner_name || "your contact").trim();
    // Stop the voicemail machinery so it can't race the bow-out.
    if (this.softTimer) { clearTimeout(this.softTimer); this.softTimer = null; }
    if (this.hardTimer) { clearTimeout(this.hardTimer); this.hardTimer = null; }
    if (this.cfMsgTimer) { clearTimeout(this.cfMsgTimer); this.cfMsgTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.cfEndpointTimer) { clearTimeout(this.cfEndpointTimer); this.cfEndpointTimer = null; }
    this.ev("ava_recept_takeover", { owner_uid: this.init.owner_uid, caller_uid: this.init.caller_uid, ms: Date.now() - this.startedAt });
    // Forward hook for a seamless client auto-accept (harmless on current clients).
    try { this.client?.send(JSON.stringify({ t: "takeover", peer: this.init.owner_uid, peer_name: ownerLabel, call_id: body.call_id ?? null })); } catch { /* caller gone */ }
    // Speak one short bow-out line, THEN end. Async so /api/call isn't blocked on
    // the ~3s of TTS; the DO isolate stays alive via the open caller WS.
    void (async () => {
      try { await this.cfSpeak(`Oh — here's ${ownerLabel} now. Connecting you!`); } catch { /* best-effort */ }
      void this.finalize("owner_takeover");
    })();
    return new Response("ok");
  }

  // -------------------------------------------------------------------------
  private async finalize(reason: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.softTimer) clearTimeout(this.softTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfEndpointTimer) clearTimeout(this.cfEndpointTimer);
    if (this.cfMsgTimer) clearTimeout(this.cfMsgTimer);
    if (this.cfSpeakTimer) clearTimeout(this.cfSpeakTimer);
    if (this.cfSpeakResolve) { const r = this.cfSpeakResolve; this.cfSpeakResolve = null; r(); } // unblock any speaking wait
    try { this.stt?.close(); } catch { /* ignore */ }
    try { this.client?.send(JSON.stringify({ t: "ended", reason })); this.client?.close(1000, reason); } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    const now = Date.now();
    const durationS = Math.max(0, Math.round((now - this.startedAt) / 1000));
    const transcript = this.buildTranscript();

    let recordingUrl: string | null = null;
    try {
      if (!this.takenOver && this.pcmBytes > 0) {
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

    // Live takeover → voicemail CANCELLED: no summary, no card, no ack.
    const summary = this.takenOver ? null : await this.cfSummarize(transcript).catch(() => null);
    const summaryJson = summary ? JSON.stringify(summary) : null;
    if (!this.takenOver) this.ev("ava_recept_summary_generated", { ok: !!summary, urgency: summary?.urgency ?? null });

    try {
      await this.env.DB_META.prepare(
        `UPDATE receptionist_sessions SET status='ended', ended_at=?2, duration_s=?3, cutoff_reason=?4,
           summary_json=?5, transcript=?6, recording_url=?7, updated_at=?2 WHERE id=?1`,
      ).bind(init.sid, now, durationS, reason, summaryJson, transcript || null, recordingUrl).run();
    } catch { /* ignore */ }

    const hadConversation = this.firstAudioSent || this.inText.length > 0 || this.pcmBytes > 0;
    // On a live takeover the owner & caller are now talking directly, so we post
    // NO voicemail card and send NO caller ack — the call is not a message.
    if (!this.takenOver) {
      try { await this.postMessage(init, summary, transcript, recordingUrl, durationS, hadConversation); } catch { /* best-effort */ }
      this.ev("ava_recept_message_posted", {
        caller_phone: init.caller_phone, duration_s: durationS, cutoff_reason: reason,
        has_recording: !!recordingUrl, has_transcript: !!transcript,
        in_chars: this.inText.join("").length, out_chars: this.outText.join("").length,
      });
    }
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
      // [AVANOTIF-VM-2] `caller_uid` added alongside the existing `caller_phone`.
      // consumers/src/fcm.ts buildPayload's "notify" branch reads
      // `msg.data.caller_uid` FIRST (highest priority) to resolve `data.fromUid`
      // for the recipient's push_service.dart resolver — without it, an in-app
      // AvaTOK caller who reaches this owner's receptionist could only ever be
      // matched by phone, never by the owner's own AvaTOK-contact-by-uid entry
      // (priority tier 2 in _resolveDisplayName), even when the caller IS an
      // AvaTOK contact. PSTN callers legitimately have no uid — `caller_uid` is
      // simply omitted for them, same as `caller_phone` today for uid-only paths.
      await this.env.Q_PUSH.send({ kind: "notify", to: init.owner_uid, fromName: "Ava", title: "Ava took a message", body: bodyText.replace(/^📞\s*/, ""), data: { type: "receptionist", conv, caller_uid: init.caller_uid || undefined, caller_phone: init.caller_phone } });
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
        // [AVANOTIF-VM-2] `from: init.owner_uid` — the caller-ack push had no
        // sender identity at all, same gap class as the messaging.ts producers.
        // Lets the caller's device resolve the OWNER's name from the caller's
        // own contacts instead of trusting `fromName` (which here is already the
        // owner's server-resolved name, so this is a belt-and-suspenders forward
        // for consistency with every other notify producer, not a behavior fix).
        await this.env.Q_PUSH.send({ kind: "notify", to: init.caller_uid, from: init.owner_uid, fromName: ownerLabel });
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
// Ava's sign-off detector (CLOSE-ON-GOODBYE): when her reply is a clear farewell we
// end the call right after she says it. Conservative + multilingual so a mid-call line
// never trips it. Checks Ava's OWN reply text, never the caller's.
function isGoodbyeLine(t: string): boolean {
  const s = t.toLowerCase();
  return /\bhave a (great|good|wonderful|nice|lovely|blessed) (day|evening|morning|afternoon|night|one|rest of your \w+)\b/.test(s)
    || /\b(take care|good ?bye|bye now|bye bye|talk soon|speak soon|talk to you soon|catch you later)\b/.test(s)
    || /(अलविदा|फिर मिलेंगे|ध्यान रखना|ध्यान रखिए|शुभ दिन|आपका दिन शुभ हो|दिन अच्छा बीते)/.test(t)
    || /\b(adiós|hasta luego|que tengas un buen día|cuídate)\b/i.test(s)
    || /\b(au revoir|bonne journée)\b/i.test(s);
}
function callerHasSpeech(pcm: Uint8Array, threshold = 600): boolean {
  const n = pcm.byteLength >> 1;
  if (n === 0) return false;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sumSq += s * s; }
  return Math.sqrt(sumSq / n) > threshold;
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
