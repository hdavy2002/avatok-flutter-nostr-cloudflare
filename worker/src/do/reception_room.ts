// ReceptionRoom — Ava Receptionist call bridge (Specs/PROPOSAL-AI-RECEPTIONIST.md).
// One instance per session id. NOT hibernated: it holds a live outbound Gemini
// Live WebSocket for the duration of a (≤70 s) call.
//
// Why a server-side relay (not client→Gemini directly): it lets us route through
// Cloudflare AI Gateway for METERING, keep GEMINI_API_KEY + the hidden system
// prompt + the 70-second cap SERVER-SIDE (the caller can't tamper), and capture
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
import { chargeFeature } from "../feature_pricing"; // Ava minute billing (CALL-OUTCOME-MENU §6)

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

// Gemini 3.1 Flash Live audio pricing — PAID tier, per minute of audio
// (Google AI pricing, https://ai.google.dev/gemini-api/docs/pricing, 2026-06-15):
//   input audio  $3.00 / 1M tokens  ≈ $0.005/min
//   output audio $12.00 / 1M tokens ≈ $0.018/min
// Audio dominates a receptionist call; text I/O (system prompt + transcripts) is
// negligible, so the cost estimate is audio-seconds × per-second rate. Tunable via
// env so a model/price change needs no redeploy.
const LIVE_AUDIO_IN_USD_PER_MIN = 0.005;
const LIVE_AUDIO_OUT_USD_PER_MIN = 0.018;

// Gemini 3.1 Flash Live PER-TOKEN pricing (paid tier, per 1M tokens) — used for
// the EXACT cost when the model reports usageMetadata (audio AND text I/O). Text
// is tiny per call but real, so we account for it rather than ignore it:
//   input:  text $0.75/1M,  audio $3.00/1M
//   output: text $4.50/1M,  audio $12.00/1M
const LIVE_TEXT_IN_USD_PER_M = 0.75;
const LIVE_TEXT_OUT_USD_PER_M = 4.50;
const LIVE_AUDIO_IN_USD_PER_M = 3.00;
const LIVE_AUDIO_OUT_USD_PER_M = 12.00;
// Gemini 2.5 Flash pricing for the one-shot summary call (paid tier, per 1M):
//   input text $0.30/1M, output $2.50/1M.
const SUM_TEXT_IN_USD_PER_M = 0.30;
const SUM_TEXT_OUT_USD_PER_M = 2.50;

// Voice → gender, mirroring app/lib/core/voice/google_voice.dart (the 30 prebuilt
// Gemini Live voices). Stamped on every telemetry event ("woman"/"man") so PostHog
// can break usage + cost down by the voice the owner picked. Unknown → "".
const VOICE_GENDER: Record<string, "woman" | "man"> = {
  // female / woman
  Aoede: "woman", Kore: "woman", Leda: "woman", Zephyr: "woman", Autonoe: "woman",
  Callirrhoe: "woman", Despina: "woman", Erinome: "woman", Laomedeia: "woman",
  Achernar: "woman", Gacrux: "woman", Pulcherrima: "woman", Vindemiatrix: "woman",
  Sulafat: "woman", Achird: "woman", Sadachbia: "woman",
  // male / man
  Puck: "man", Charon: "man", Fenrir: "man", Orus: "man", Enceladus: "man",
  Iapetus: "man", Umbriel: "man", Algieba: "man", Algenib: "man", Rasalgethi: "man",
  Alnilam: "man", Schedar: "man", Zubenelgenubi: "man", Sadaltager: "man",
};
function voiceGender(name: string | null | undefined): string {
  return (name && VOICE_GENDER[name]) || "";
}

interface InitBlob {
  sid: string; owner_uid: string; caller_uid: string;
  caller_phone: string | null; caller_name: string | null; call_id: string | null;
  rtc_token: string; voice_name: string; file_search_store: string | null;
  system_prompt: string; model: string;
  soft_cap_ms: number; hard_cap_ms: number; wrap_cue_ms?: number; wrap_soft?: boolean; started_at: number;
  // v2
  language_code?: string | null; activation_mode?: string | null;
  owner_name?: string | null; // owner's display name, for the caller-side ack
  ava_name?: string | null;   // Ava's persona name, for transcript speaker labels
}

// P2: ultra-cheap language guess from Unicode script ranges (no model call). Feeds
// ONLY the detected_lang telemetry dimension — it never drives call behavior (the
// model detects language itself from the caller's first words per the system prompt).
function guessLangFromText(s: string): string {
  if (!s) return "und";
  if (/[ऀ-ॿ]/.test(s)) return "hi";  // Devanagari (Hindi/Marathi/…)
  if (/[؀-ۿ]/.test(s)) return "ar";  // Arabic
  if (/[֐-׿]/.test(s)) return "he";  // Hebrew
  if (/[぀-ヿ]/.test(s)) return "ja";  // Hiragana/Katakana
  if (/[가-힯]/.test(s)) return "ko";  // Hangul
  if (/[一-鿿]/.test(s)) return "zh";  // CJK Han
  if (/[Ѐ-ӿ]/.test(s)) return "ru";  // Cyrillic
  if (/[฀-๿]/.test(s)) return "th";  // Thai
  if (/[a-zA-Z]/.test(s)) return "und-latn";   // Latin script (specific language unknown)
  return "und";
}

export class ReceptionRoom {
  private state: DurableObjectState;
  private env: Env;

  private client: WebSocket | null = null;
  private gem: WebSocket | null = null;
  private init: InitBlob | null = null;
  private startedAt = 0;
  private wrapCueTimer: ReturnType<typeof setTimeout> | null = null; // P2: 40s wrap cue
  private closeTimer: ReturnType<typeof setTimeout> | null = null;    // P2: 60s session close
  private hardTimer: ReturnType<typeof setTimeout> | null = null;     // P2: 90s stall backstop
  private finalized = false;
  // P2 wrap/close state.
  private wrapCueInjected = false; // the 40s wrap cue is injected exactly once
  private idleNudges = 0; // silence escalation: 1st = spoken check-in, 2nd = spoken close
  private closePending = false;    // 60s reached while Ava was mid-utterance → close on her next turnComplete
  // [AVA-NATURAL-CLOSE-1] (owner decision 2026-07-09): caller SPEECH budget —
  // steer at 20s of caller speaking time, close at 25s. Measured from streaming
  // inputTranscription arrival gaps (a chunk means the caller is talking), NOT
  // wall clock, so a slow-to-start caller isn't robbed of message time.
  private callerSpeechMs = 0;      // cumulative caller speaking time
  private lastInTAt = 0;           // last inputTranscription chunk arrival
  private steerInjected = false;   // the silent 20s "wind it down" hint (once)
  private avaSpeaking = false;     // true between an Ava audio chunk and her turnComplete
  private selfClosed = false;      // AVA-VM-CLOSE-1: Ava ended via the end_call tool (healthy close, not a cap)

  // Owner contact, resolved once so EVERY event carries email/phone (support
  // pulls a user's receptionist calls by email/phone). v2 telemetry spec.
  private ownerEmail: string | null = null;
  private ownerPhone: string | null = null;
  private firstAudioSent = false;
  // Set at the soft cap: stop feeding caller audio to Gemini so Ava can barge in
  // and speak the wrap-up uninterrupted (see onWrapCue / onClientMessage).
  private wrapping = false;

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
  // Latest cumulative token usage reported by Gemini Live (usageMetadata). Lets us
  // bill the EXACT audio + text I/O instead of estimating from audio bytes alone.
  private liveTokIn = { audio: 0, text: 0 };
  private liveTokOut = { audio: 0, text: 0 };
  private haveLiveUsage = false;
  // Tokens spent by the one-shot summary call (Gemini 2.5 Flash), tracked so the
  // cost telemetry covers ALL Gemini spend on a receptionist call, not just live.
  private sumTokIn = 0;
  private sumTokOut = 0;
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

    // P2 timeline (authoritative, server-side — THE RELAY KEEPS TIME, not the
    // model): inject the wrap cue at ~40s, close after the current turn at ~60s,
    // and keep the 90s hard cap as a pure stall backstop.
    this.wrapCueTimer = setTimeout(() => this.onWrapCue(), init.wrap_cue_ms ?? 40_000);
    this.closeTimer = setTimeout(() => this.onSessionClose(), init.soft_cap_ms);
    this.hardTimer = setTimeout(() => this.finalize("hard_cap"), init.hard_cap_ms);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Emit a receptionist telemetry event stamped with owner email/phone +
   *  one-call trace (trace_id=sid, call_id, activation_mode). v2 spec. */
  private ev(event: string, props: Record<string, unknown> = {}): void {
    const i = this.init;
    if (!i) return;
    // Every event carries the model + chosen voice and its gender (woman/man) so
    // PostHog can slice usage and cost by voice. v2 cost telemetry.
    trackUserContact(this.env, i.owner_uid, this.ownerEmail, this.ownerPhone, event, "receptionist",
      { ...props, call_id: i.call_id, activation_mode: i.activation_mode ?? null,
        model: i.model, voice: i.voice_name, voice_gender: voiceGender(i.voice_name) }, i.sid);
  }

  // -------------------------------------------------------------------------
  // Gemini Live (via Cloudflare AI Gateway for metering)
  // -------------------------------------------------------------------------
  /** The Gemini key for receptionist calls: the dedicated receptionist key when
   *  set (isolates spend to its own Google project), else the global key. */
  private receptKey(): string | undefined {
    return this.env.RECEPTIONIST_GEMINI_API_KEY || this.env.GEMINI_API_KEY;
  }

  private geminiWsUrl(): { url: string; protocols: string[] } {
    const key = this.receptKey()!;
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
    // One Brain B1 §5 — live-session attribution: the receptionist's Gemini Live
    // cloud session is now open. Unified event across all live features (the ev()
    // helper already stamps feature="receptionist", owner uid/email/phone + model).
    this.ev("live_session_open", { feature: "receptionist", verb: "speak", language: init.language_code ?? "auto" });

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
    // Tools: ONLY an end_call function (so Ava can hang up after her goodbye) and
    // the owner's knowledge base (File Search) when configured + not disabled.
    //
    // COST GUARD — we deliberately NEVER attach Google Search grounding
    // ({ googleSearch: {} }). A message-taker has no need to search the web, and
    // grounding is billed beyond a free monthly quota ($14 / 1,000 queries). If a
    // future change wants it, it must be a separate, explicitly-gated decision.
    const tools: any[] = [{
      functionDeclarations: [{
        name: "end_call",
        description: "End the phone call. Invoke this the moment you have finished saying your ONE short goodbye line, once the caller's message is complete and they have nothing more to add. Do NOT wait for a timer — end the call yourself.",
        parameters: {
          type: "OBJECT",
          properties: {
            reason: {
              type: "STRING",
              description: "Why the call is ending: 'message_complete' (caller finished their message and fell silent), 'caller_bye' (caller said goodbye / that's all).",
              enum: ["message_complete", "caller_bye"],
            },
          },
        },
      }],
    }];
    // File Search (RAG) is optional and also billable; gate it behind a kill
    // switch so it can be turned off fleet-wide without a redeploy.
    const kbDisabled = String((this.env as any).RECEPT_KB_DISABLED || "") === "1";
    if (init.file_search_store && !kbDisabled) {
      tools.push({ fileSearch: { fileSearchStoreNames: [init.file_search_store] } });
    }
    setup.tools = tools;
    this.sendGem({ setup });
    this.ev("ava_recept_session_started", {
      setup_latency_ms: Date.now() - this.startedAt,
      has_kb: !!init.file_search_store && !kbDisabled,
    });
    // GREET FIRST (lean nudge to keep text-input tokens minimal). Without it,
    // Gemini's VAD waits for the caller to speak before Ava says anything (a long
    // dead-air gap). One short one-shot user turn makes her open immediately.
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[Caller connected — say your STEP 1 opening greeting now, exactly as instructed, then stop and listen.]" }] }],
        turnComplete: true,
      },
    });
    this.bumpIdle(); // arm the silence backstop
  }

  // caller → Gemini : binary = PCM16 16k; (control JSON tolerated but ignored)
  private onClientMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    const d = ev.data as any;
    if (typeof d === "string") {
      // [CALL-EXCL-1] Single-audio-authority yield. The ONLY client control we
      // honor: the caller's device owner accepted a real incoming call, so this
      // receptionist leg must end WITHOUT posting a voicemail or a caller ack
      // (there is no message to take — the owner is now on the line directly).
      // Finalize with reason `owner_answered`; postMessage() skips delivery for it.
      try {
        const j = JSON.parse(d);
        if (j && j.t === "yield") {
          void this.finalize("owner_answered");
        }
      } catch { /* ignore malformed control */ }
      return;
    }
    if (!this.gem) return;
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!bytes) return;
    // Wrap-up barge-in: once the time cap hits we STOP relaying the caller to
    // Gemini so the model isn't held in "listening" mode by a caller who keeps
    // talking — that's what let the old 80s call hard-cap in silence. With the mic
    // gated, Gemini takes the floor and speaks the templated close. The message
    // window is already over, so dropping these frames loses nothing.
    if (this.wrapping) return;
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
      this.idleNudges = 0; // caller is engaged again → reset the silence escalation
      this.bumpIdle();
    }
    this.sendGem({
      realtimeInput: { audio: { data: b64encode(bytes), mimeType: "audio/pcm;rate=16000" } },
    });
  }

  /** Capture Gemini Live token usage (cumulative) split by modality, so we can
   *  bill the exact audio + text I/O. Tolerant of field-name variants (prompt vs
   *  response vs candidates token details). */
  private captureLiveUsage(u: any): void {
    try {
      const split = (details: any): { audio: number; text: number } => {
        const out = { audio: 0, text: 0 };
        if (Array.isArray(details)) {
          for (const d of details) {
            const n = Number(d?.tokenCount) || 0;
            if (String(d?.modality).toUpperCase() === "AUDIO") out.audio += n;
            else out.text += n; // TEXT (and anything non-audio) billed at text rate
          }
        }
        return out;
      };
      const inD = split(u.promptTokensDetails);
      const outD = split(u.responseTokensDetails ?? u.candidatesTokensDetails);
      // Fall back to the flat totals when the modality breakdown is absent (treat
      // as text — the conservative direction for input; output audio dominates so
      // we keep the byte estimate as a floor in finalize()).
      if (inD.audio === 0 && inD.text === 0 && Number(u.promptTokenCount)) inD.text = Number(u.promptTokenCount);
      this.liveTokIn = inD;
      this.liveTokOut = outD;
      this.haveLiveUsage = true;
    } catch { /* best-effort — fall back to byte-based estimate */ }
  }

  /** Reset the silence backstop on any real audio activity (either side). */
  private bumpIdle(): void {
    if (this.finalized) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle(), ReceptionRoom.IDLE_MS);
  }

  // Silence backstop. Instead of cutting the call dead (the "Ava silently wraps"
  // bug — caller goes quiet, 10s later the line just drops with no goodbye), the
  // FIRST unbroken silence makes Ava gently check in ("still there? anything I can
  // pass on?"), and the SECOND makes her say a warm goodbye via the wrap cue. The
  // call therefore ALWAYS ends on Ava's voice, never a silent drop.
  private onIdle(): void {
    if (this.finalized) return;
    // Wrap already spoken (goodbye said/requested) and STILL silent → close.
    // ONE goodbye, ever — the "Ava said goodbye then woke up asking if there's
    // anything else" bug (owner report 2026-07-09) came from nudging after wrap.
    if (this.wrapCueInjected) { void this.finalize("inactivity"); return; }
    // [AVA-NATURAL-CLOSE-1] If the caller already left message content and went
    // quiet, the message is DONE — go straight to the natural close (brief ack
    // + one goodbye). No "anything else?" wake-ups after a delivered message;
    // silence after content IS the completion signal.
    if (this.inText.join("").trim().length > 0) { this.onWrapCue(); return; }
    // Second unbroken silence with NO message at all → spoken close.
    if (this.idleNudges >= 1) { this.onWrapCue(); return; }
    // First silence with nothing captured yet → ONE warm check-in ("still
    // there?"). This is the only nudge that can ever happen, and only before
    // any message content exists.
    this.idleNudges++;
    this.ev("ava_recept_idle_nudge", { at_ms: Date.now() - this.startedAt });
    // End the caller's still-open (silent) turn so the model actually answers.
    this.sendGem({ realtimeInput: { audioStreamEnd: true } });
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[SYSTEM: The caller has gone quiet without leaving a message. In ONE short, warm sentence, check if they're still there and ask if there's anything you can pass on. Do NOT say goodbye yet.]" }] }],
        turnComplete: true,
      },
    });
    this.bumpIdle(); // re-arm; the next unbroken silence escalates to the goodbye
  }

  // Gemini → caller : audio out (binary) + transcript accumulation
  private onGeminiMessage(ev: MessageEvent): void {
    if (this.finalized) return;
    let msg: any;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data)
        : JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch { return; }

    // Token accounting — the Live API reports cumulative usageMetadata; keep the
    // latest so finalize() can bill exact audio + text I/O (cost hardening).
    if (msg.usageMetadata) this.captureLiveUsage(msg.usageMetadata);

    // Ava decided the call is done (she invoked the end_call tool after her
    // goodbye) → hang up immediately instead of leaving the line open.
    if (msg.toolCall) {
      const calls = msg.toolCall.functionCalls;
      const endCall = Array.isArray(calls) ? calls.find((c: any) => c?.name === "end_call") : null;
      if (endCall) {
        // AVA-VM-CLOSE-1: Ava ended the call herself (event-driven close, not a
        // timer). Record WHY she closed so we can distinguish a healthy self-close
        // from a cap-fired GC close. Reason comes from her tool args; default to
        // message_complete when she omits it.
        const rawReason = String(endCall?.args?.reason || "").trim();
        const reason = (rawReason === "caller_bye" || rawReason === "message_complete")
          ? rawReason : "message_complete";
        this.selfClosed = true;
        this.ev("ava_recept_self_closed", {
          reason,
          turns: this.turnCount,
          session_s: Math.round((Date.now() - this.startedAt) / 1000),
        });
        this.ev("ava_recept_ended_by_agent", { ms: Date.now() - this.startedAt, reason });
        // Gemini emits end_call right after the goodbye audio chunks; finalize()
        // closes the caller socket, so hanging up instantly clips the tail of her
        // line. Give the audio ~1.6s to drain to the caller, then end. The hard cap
        // is the backstop if anything stalls.
        setTimeout(() => { void this.finalize("ava_ended"); }, 1600);
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
      if (inT) {
        this.inText.push(String(inT)); this.pushDialog("caller", String(inT));
        // [AVA-NATURAL-CLOSE-1] Caller speech budget. Consecutive transcription
        // chunks ≤1.5s apart count as continuous speech; a first/isolated chunk
        // counts a nominal 300ms. At 20s: ONE silent hint so Ava winds the
        // caller down in her own words on her next turn. At 25s: close the
        // message — mic gated, Ava says her one short goodbye and end_call.
        const now = Date.now();
        const gap = this.lastInTAt > 0 ? now - this.lastInTAt : 0;
        this.callerSpeechMs += gap > 0 && gap <= 1500 ? gap : 300;
        this.lastInTAt = now;
        if (!this.steerInjected && this.callerSpeechMs >= 20_000) {
          this.steerInjected = true;
          // turnComplete:false — pure context, no forced reply: she must NOT
          // interrupt the caller mid-sentence, just steer her NEXT turn.
          this.sendGem({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "[SYSTEM: The message is getting long. On your NEXT turn, gently wind the caller down in your own words and move to your one short goodbye. Never mention time limits or that time is up.]" }] }],
              turnComplete: false,
            },
          });
          this.ev("ava_recept_steer_cue", { at_ms: now - this.startedAt, speech_ms: this.callerSpeechMs });
        } else if (this.callerSpeechMs >= 25_000 && !this.wrapCueInjected) {
          this.ev("ava_recept_speech_cap", { at_ms: now - this.startedAt, speech_ms: this.callerSpeechMs });
          this.onWrapCue(); // budget spent → graceful close (her words, one goodbye)
        }
      }
      const outT = sc.outputTranscription?.text;
      if (outT) { this.outText.push(String(outT)); this.pushDialog("ava", String(outT)); }
      // Per-turn observability: each completed exchange, with server-truth audio
      // throughput both ways. in_bytes≈0 across turns ⇒ the caller wasn't heard.
      if (sc.turnComplete === true) {
        this.turnCount++;
        this.avaSpeaking = false; // P2: Ava's turn is done
        this.ev("ava_recept_turn", {
          turn: this.turnCount,
          in_chars: this.inText.join("").length,
          out_chars: this.outText.join("").length,
          in_bytes: this.inBytes,
          ava_bytes: this.pcmBytes,
          ms: Date.now() - this.startedAt,
        });
        // P2: the 60s session close arrived mid-utterance and waited — her turn is
        // now complete, so close cleanly without clipping her last word.
        if (this.closePending) { void this.finalize("time_up_wrap"); return; }
      }
      const parts = sc.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const data = p?.inlineData?.data;
          if (typeof data === "string") {
            const pcm = b64decode(data);
            this.avaSpeaking = true; // P2: Ava is mid-utterance until turnComplete
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

  // P2 WRAP CUE (fires at wrap_cue_ms ≈ 40s, ONCE). BARGE IN: set wrapping so
  // onClientMessage stops feeding the caller's mic to Gemini, then inject the
  // self-describing wrap instruction so Ava warmly says time is nearly up, gives a
  // one-line summary and says goodbye — in the caller's own language. The relay
  // keeps time; the model is never asked to count seconds.
  private onWrapCue(): void {
    if (this.finalized || this.wrapCueInjected) return;
    this.wrapCueInjected = true;
    // CALL-OUTCOME-MENU soft wrap (owner 2026-07-09): with the 3-min budget the
    // wrap cue opens a graceful WIND-DOWN PHASE (2:00→~2:40) — Ava steers to a
    // close but the caller's mic stays open so they can finish their thought.
    // The firm close is the soft_cap timer; the hard cap remains the backstop.
    if (this.init?.wrap_soft === true) {
      this.sendGem({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[SYSTEM: Time is nearly up. Over your next turns, gently steer the conversation to a close: let the caller finish their current point, then briefly acknowledge what you'll pass on, say ONE short warm goodbye and invoke end_call. Never mention time or time limits, do not open new topics, and do not speak again after the goodbye.]" }] }],
          turnComplete: true,
        },
      });
      try { this.client?.send(JSON.stringify({ t: "softcap" })); } catch { /* ignore */ }
      metric(this.env, "ava_recept_softcap", [1]);
      this.ev("ava_recept_wrap_cue", { at_ms: Date.now() - this.startedAt, soft: true });
      return;
    }
    this.wrapping = true;
    // CRITICAL under automatic VAD: end the caller's still-open turn so the model
    // actually answers the wrap nudge (gating the mic alone leaves the turn open
    // forever → silence → hard cap without a spoken close, the 2026-06-30 bug).
    this.sendGem({ realtimeInput: { audioStreamEnd: true } });
    // [AVA-NATURAL-CLOSE-1] No template, no "that's all the time I have". She
    // closes in her own fresh words: brief acknowledgment that she has the
    // message, ONE short goodbye, then end_call. Never mention time limits,
    // never ask anything further, never speak again after the goodbye.
    this.sendGem({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "[SYSTEM: Close the call now, in your own words: briefly acknowledge you've got their message and will pass it on, then say ONE short warm goodbye and immediately invoke end_call. Vary your phrasing — never use a stock line, never mention time or time limits, do not ask any question, and do not speak again after the goodbye.]" }] }],
        turnComplete: true,
      },
    });
    try { this.client?.send(JSON.stringify({ t: "softcap" })); } catch { /* ignore */ }
    metric(this.env, "ava_recept_softcap", [1]);
    this.ev("ava_recept_wrap_cue", { at_ms: Date.now() - this.startedAt });
  }

  // P2 SESSION CLOSE (fires at soft_cap_ms ≈ 60s). Never hard-cut mid-word: if Ava
  // is mid-utterance, mark closePending and let onGeminiMessage close on her next
  // turnComplete; otherwise close now. Either way cutoff_reason = 'time_up_wrap'.
  private onSessionClose(): void {
    if (this.finalized) return;
    if (this.avaSpeaking) {
      this.closePending = true;
      this.ev("ava_recept_close_deferred", { at_ms: Date.now() - this.startedAt });
      return;
    }
    void this.finalize("time_up_wrap");
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
    if (this.wrapCueTimer) clearTimeout(this.wrapCueTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try { this.gem?.close(); } catch { /* ignore */ }
    try { this.client?.send(JSON.stringify({ t: "ended", reason })); this.client?.close(1000, reason); } catch { /* ignore */ }

    const init = this.init;
    if (!init) return;
    const now = Date.now();
    const durationS = Math.max(0, Math.round((now - this.startedAt) / 1000));
    // One Brain B1 §5 — live-session close (finalize is the natural close hook; runs
    // once for every end reason). ev() stamps feature="receptionist", uid + model.
    this.ev("live_session_close", { feature: "receptionist", verb: "speak", reason, duration_s: durationS, turns: this.turnCount });
    const transcript = this.buildTranscript();

    // [CALL-EXCL-1] owner_answered yield: the device owner picked up the real
    // incoming call, so this receptionist leg ends with NO voicemail message and
    // NO caller ack (nothing to take a message about). We still persist the
    // session row (status/duration/reason) for the record + telemetry, but we
    // SKIP the recording store, the owner message post, and the caller ack.
    if (reason === "owner_answered") {
      try {
        await this.env.DB_META.prepare(
          `UPDATE receptionist_sessions SET status='ended', ended_at=?2, duration_s=?3, cutoff_reason=?4,
             updated_at=?2 WHERE id=?1`,
        ).bind(init.sid, now, durationS, reason).run();
      } catch { /* ignore */ }
      this.ev("ava_recept_yielded", {
        reason: "owner_answered", duration_s: durationS, turns: this.turnCount,
      });
      this.ev("ava_recept_session_ended", {
        cutoff_reason: reason, duration_s: durationS, got_audio: this.firstAudioSent,
        yielded: true, turns: this.turnCount,
      });
      metric(this.env, "ava_recept_yielded", [1, durationS]);
      return;
    }

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

    // END-TO-END on gemini-3.1-flash-live (owner decision 2026-06-30): NO second
    // model. We dropped the separate gemini-2.5-flash "what they said" summary —
    // the owner gets the recording + the live transcript, with no LLM summary line.
    const summary: any = null;
    const summaryJson: string | null = null;

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

    // ── TOKEN BILLING (owner 2026-07-09, Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md
    // §6): Ava minutes cost the OWNER `ava_receptionist_minute` tokens (3/min =
    // 3¢/min) — ceil(duration/60), one idempotent charge unit per minute
    // (op_id = `<sid>:min<N>`, deduped by the WalletDO on retry). FREE while
    // betaFreePremium is on: chargeFeature short-circuits to charged:0, so this is
    // dormant wiring until billing turns on. Best-effort — a wallet error must
    // never break message delivery (which already happened above).
    if (hadConversation && durationS > 0) {
      try {
        const minutes = Math.min(10, Math.ceil(durationS / 60)); // sanity clamp
        for (let m = 1; m <= minutes; m++) {
          await chargeFeature(this.env, init.owner_uid, "ava_receptionist_minute", `${init.sid}:min${m}`);
        }
        this.ev("ava_recept_billed", { minutes, feature: "ava_receptionist_minute" });
      } catch { /* best-effort */ }
    }

    // ── COST telemetry (Gemini Live audio) ────────────────────────────────────
    // Estimate $ spent on this call from audio throughput both ways:
    //   caller mic  = PCM16 16k mono = 32000 bytes/s  (input audio)
    //   Ava output  = PCM16 24k mono = 48000 bytes/s  (output audio)
    // priced at the per-minute audio rates above. Per-min rates are tunable via
    // env (RECEPT_AUDIO_IN_USD_MIN / _OUT_) so a price change needs no redeploy.
    const inRate = Number((this.env as any).RECEPT_AUDIO_IN_USD_MIN) || LIVE_AUDIO_IN_USD_PER_MIN;
    const outRate = Number((this.env as any).RECEPT_AUDIO_OUT_USD_MIN) || LIVE_AUDIO_OUT_USD_PER_MIN;
    const inAudioS = this.inBytes / 32000;
    const outAudioS = this.avaBytes / 48000;
    const inAudioUsd = (inAudioS / 60) * inRate;
    const outAudioUsd = (outAudioS / 60) * outRate;
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

    // TEXT I/O — small per call but real. When the model reported usageMetadata we
    // bill the exact text tokens (and prefer its audio token count too); otherwise
    // text cost is 0 and we fall back to the byte-based audio estimate. The summary
    // call (Gemini 2.5 Flash) is billed separately and added in.
    const textInUsd = (this.liveTokIn.text / 1e6) * LIVE_TEXT_IN_USD_PER_M;
    const textOutUsd = (this.liveTokOut.text / 1e6) * LIVE_TEXT_OUT_USD_PER_M;
    const tokAudioInUsd = (this.liveTokIn.audio / 1e6) * LIVE_AUDIO_IN_USD_PER_M;
    const tokAudioOutUsd = (this.liveTokOut.audio / 1e6) * LIVE_AUDIO_OUT_USD_PER_M;
    // Prefer token-reported audio cost when available; else the byte estimate.
    const liveAudioUsd = this.haveLiveUsage ? (tokAudioInUsd + tokAudioOutUsd) : (inAudioUsd + outAudioUsd);
    const summaryUsd = (this.sumTokIn / 1e6) * SUM_TEXT_IN_USD_PER_M + (this.sumTokOut / 1e6) * SUM_TEXT_OUT_USD_PER_M;
    // Total = live audio + live text + summary. (in_audio_usd/out_audio_usd remain
    // the byte-based audio estimate for backward-compatible dashboards.)
    const estUsd = liveAudioUsd + textInUsd + textOutUsd + summaryUsd;

    this.ev("ava_recept_cost", {
      duration_s: durationS,
      in_audio_s: Math.round(inAudioS * 10) / 10,
      out_audio_s: Math.round(outAudioS * 10) / 10,
      in_audio_usd: round6(inAudioUsd),
      out_audio_usd: round6(outAudioUsd),
      // exact token usage (0 when the model didn't report it)
      have_token_usage: this.haveLiveUsage,
      tok_audio_in: this.liveTokIn.audio, tok_audio_out: this.liveTokOut.audio,
      tok_text_in: this.liveTokIn.text, tok_text_out: this.liveTokOut.text,
      text_in_usd: round6(textInUsd), text_out_usd: round6(textOutUsd),
      live_audio_usd: round6(liveAudioUsd),
      summary_tok_in: this.sumTokIn, summary_tok_out: this.sumTokOut, summary_usd: round6(summaryUsd),
      est_usd: round6(estUsd),
      in_rate_usd_min: inRate, out_rate_usd_min: outRate,
      cutoff_reason: reason, // 'ava_ended' (self-close) vs 'time_up_wrap' (cap-fired GC close)
      // AVA-VM-CLOSE-1: true only when Ava hung up herself via the end_call tool —
      // lets dashboards separate a healthy event-driven close from a cap backstop.
      self_closed: this.selfClosed,
      // P2: did the 40s wrap cue fire, and the caller's detected language (cheap
      // script heuristic over the transcript; owner language_code wins if set).
      wrap_cue_injected: this.wrapCueInjected,
      detected_lang: init.language_code || guessLangFromText(this.inText.join(" ")),
    });
    // Aggregate metric (USD micro-cents so the integer counter stays meaningful).
    metric(this.env, "ava_recept_cost_usd_micro", [Math.round(estUsd * 1e6)]);
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
    const key = this.receptKey();
    if (!transcript || !key) return null;
    const model = "gemini-2.5-flash";
    // Direct to Gemini (no AI Gateway hop) — same rationale as the live socket.
    const sysUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const headers: Record<string, string> = { "content-type": "application/json", "x-goog-api-key": key };
    const prompt = `From this phone-message transcript, return STRICT JSON {"caller_name":string|null,"reason":string,"callback":string|null,"urgency":"low"|"normal"|"high"}. Transcript:\n${transcript.slice(0, 4000)}`;
    const r = await fetch(sysUrl, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    // Account for the summary call's token spend (added into ava_recept_cost).
    try {
      const um = j?.usageMetadata;
      if (um) {
        this.sumTokIn = Number(um.promptTokenCount) || 0;
        this.sumTokOut = (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0);
      }
    } catch { /* best-effort */ }
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
