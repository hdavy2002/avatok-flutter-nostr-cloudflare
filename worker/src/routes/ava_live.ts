// ava_live.ts — the FAST "Voice call Ava" path: Gemini Live native-audio.
//
//   POST /api/ava/live/token  → a short-lived ephemeral token whose config
//   (native-audio model + Ava's companion persona + prebuilt voice + input/output
//   transcription) is LOCKED server-side, so a tampered client can't change the
//   model or persona. The client connects DIRECTLY to the Gemini Live websocket
//   with this token (audio in/out streamed) for ~sub-second latency.
//
// This is the online counterpart to the on-device VAD→Whisper→Gemini→Supertonic
// pipeline; the user picks "Fast (online)" vs "Private (on-device)" per the
// VoiceCallMode toggle. Mirrors routes/translate.ts mintToken.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackUserContact, trackException } from "../hooks";
import { contactFor } from "../lib/identity";
// [AVABRAIN-VOICE-BILL-1] Server-side billing lifecycle for this DIRECT-to-
// Gemini voice path — see worker/src/lib/voice_billing.ts's header for the
// full design (lease/heartbeat/settle-once-at-close-or-reap, dark behind
// `avaBrainVoiceBillingEnabled`; real-during-beta escape hatch is the
// separate `avaBrainVoiceBillingLive` flag — neither is declared here, both
// are read via readConfig() inside voice_billing.ts).
import { startVoiceLease, heartbeatVoiceLease, closeVoiceLease, HEARTBEAT_INTERVAL_HINT_MS } from "../lib/voice_billing";

// Gemini 3.1 Flash Live — Google's flagship low-latency audio-to-audio model.
// Verified working on generativelanguage.googleapis.com (Developer API) via a live
// BidiGenerateContent test (setupComplete + audio greeting). NOTE: the Vertex name
// "gemini-live-2.5-flash-native-audio" does NOT exist on this endpoint (close 1008).
const LIVE_MODEL = "gemini-3.1-flash-live-preview";
// Default prebuilt Gemini voice; the client may request another from this allowlist.
const DEFAULT_VOICE = "Aoede";
// All 30 prebuilt Gemini Live voices (verified accepted by gemini-3.1-flash-live).
const VOICES = new Set([
  "Aoede", "Kore", "Leda", "Zephyr", "Autonoe", "Callirrhoe", "Despina", "Erinome",
  "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat",
  "Achird", "Sadachbia",
  "Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Zubenelgenubi", "Sadaltager",
]);

// Call languages the client may request. Each BCP-47 code is verified to complete
// the Gemini Live handshake; '' (absent) = Auto (model detects the language).
const LANGS: Record<string, string> = {
  "en-US": "English", "en-GB": "English", "es-ES": "Spanish", "es-US": "Spanish",
  "fr-FR": "French", "de-DE": "German", "it-IT": "Italian", "pt-BR": "Portuguese",
  "nl-NL": "Dutch", "pl-PL": "Polish", "ru-RU": "Russian", "tr-TR": "Turkish",
  "ar-XA": "Arabic", "hi-IN": "Hindi", "bn-IN": "Bengali", "ta-IN": "Tamil",
  "te-IN": "Telugu", "mr-IN": "Marathi", "gu-IN": "Gujarati", "kn-IN": "Kannada",
  "ml-IN": "Malayalam", "id-ID": "Indonesian", "vi-VN": "Vietnamese", "th-TH": "Thai",
  "ja-JP": "Japanese", "ko-KR": "Korean", "cmn-CN": "Mandarin Chinese",
};

function systemPrompt(firstName: string, langName: string): string {
  const who = firstName ? ` You are speaking with ${firstName}; address them by name naturally.` : "";
  // When a language is chosen, pin Ava to it (belt-and-braces with speechConfig.languageCode).
  const lang = langName ? ` Always speak to the user in ${langName}.` : "";
  return (
    "You are Ava, a warm, friendly voice companion talking with the user hands-free." +
    who + lang +
    " Reply with ONE short, natural spoken sentence (about 20 words). No markdown, no" +
    " lists, no emojis. Be direct and conversational. You can role-play or give advice." +
    " If you didn't catch something, ask them to repeat briefly."
  );
}

async function mintToken(
  env: Env,
  voice: string,
  firstName: string,
  lang: string,
): Promise<{ token: string; model: string; expires_at: number } | { error: string }> {
  if (!env.GEMINI_API_KEY) return { error: "voice unavailable: GEMINI_API_KEY unset" };
  const voiceName = VOICES.has(voice) ? voice : DEFAULT_VOICE;
  // Validate the requested language; unknown/empty → Auto (no languageCode).
  const langCode = LANGS[lang] ? lang : "";
  const langName = langCode ? LANGS[langCode] : "";
  // 2h token lifetime so a long call can run in ONE session (sliding-window
  // compression keeps the running context — and tokens — bounded).
  const expireMs = Date.now() + 120 * 60_000;
  const body = {
    uses: 1,
    expireTime: new Date(expireMs).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          // Only set when the user picked a specific language; omit for Auto.
          ...(langCode ? { languageCode: langCode } : {}),
        },
      },
      systemInstruction: { parts: [{ text: systemPrompt(firstName, langName) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // COST CONTROL — the Live API re-feeds the whole growing session context each
      // turn, so a long chatty call costs super-linearly. Sliding-window compression
      // bounds the re-fed context → ~linear. Explicit trigger/target (int64 = string).
      contextWindowCompression: { triggerTokens: "16000", slidingWindow: { targetTokens: "8000" } },
      // Lets the client reconnect within the token lifetime without re-minting.
      sessionResumption: {},
      // TURN DETECTION / barge-in tuning. On loudspeaker, Ava's own audio can leak
      // into the mic and the model mistakes it for the user talking, cutting her
      // off mid-sentence. Make start-of-speech LESS trigger-happy — LOW start
      // sensitivity + a 300ms prefix so a brief echo blip doesn't count as speech —
      // while still allowing a genuine, sustained interruption. Gemini's native VAD
      // then handles natural turn-taking. (endOfSpeech HIGH keeps the user's turn
      // ending promptly; ~700ms silence tolerates natural pauses.)
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs: 300,
          silenceDurationMs: 700,
        },
      },
    },
  };
  const r = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j?.name) return { error: `token mint failed (${r.status}): ${j?.error?.message ?? "unknown"}` };
  return { token: String(j.name), model: LIVE_MODEL, expires_at: expireMs };
}

// POST /api/ava/live/token { voice?, name?, lang? } — auth required; returns { token, model }.
export async function avaLiveToken(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let voice = DEFAULT_VOICE;
  let firstName = "";
  let lang = "";
  try {
    const b: any = await req.json();
    if (typeof b?.voice === "string") voice = b.voice;
    if (typeof b?.name === "string") firstName = b.name.trim().split(/\s+/)[0].slice(0, 40);
    if (typeof b?.lang === "string") lang = b.lang.trim();
  } catch { /* no body */ }

  // [AVABRAIN-VOICE-BILL-1] Wallet runway check + session lease BEFORE minting
  // any Gemini token — a blocked wallet must never mint a token the caller
  // can't pay for. Best-effort contact lookup so the block/telemetry events
  // are pullable by email even if this uid has no cached identity yet.
  const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  const lease = await startVoiceLease(env, { uid: ctx.uid, email: contact.email }).catch((e) => {
    void trackException(env, e, { uid: ctx.uid, route: "ava_live.avaLiveToken", method: "startVoiceLease", handled: true });
    // Fail OPEN on an unexpected lease-plumbing error (not a wallet decline) —
    // mirrors ai_billing.ts's fail-closed-into-unmetered philosophy: a billing
    // outage must never silently brick the whole voice feature. The session
    // proceeds unmetered/untracked for this one call; the exception above is
    // what makes that visible in PostHog Error Tracking.
    return { ok: true, metered: false, sessionId: crypto.randomUUID() } as const;
  });

  if (!lease.ok) {
    void trackUserContact(env, ctx.uid, contact.email, contact.phone, "avabrain_voice_wallet_blocked", "avabrain_voice", {
      session_id: lease.sessionId, stage: "session_start", balance: lease.balance, needed: lease.needed,
    });
    return json({
      error: "insufficient_balance",
      action: "top_up",
      balance: lease.balance,
      needed: lease.needed,
    }, 402);
  }

  const t = await mintToken(env, voice, firstName, lang);
  if ("error" in t) {
    // Token mint failed AFTER the lease was admitted — release the hold
    // immediately rather than leaving an unbilled reservation open for the
    // full LEASE_TIMEOUT_MS with no call ever having started.
    if (lease.metered) await closeVoiceLease(env, { uid: ctx.uid, sessionId: lease.sessionId, reason: "mint_failed" }).catch(() => {});
    return json({ error: t.error }, 502);
  }

  // One Brain B1 §5 — live-session attribution: a Gemini Live ephemeral token was
  // minted (a cloud reasoning session opens). No natural server-side close hook here
  // (the client connects DIRECTLY to Gemini) — that's exactly why the lease/heartbeat/
  // close/reap contract above exists; the client MUST call heartbeat + close (or the
  // reaper settles it) for billing to be accurate.
  void track(env, ctx.uid, "ava_live_session_open", "ava_live", { feature: "ava_live", model: t.model, verb: "speak" });
  void trackUserContact(env, ctx.uid, contact.email, contact.phone, "avabrain_voice_session_started", "avabrain_voice", {
    session_id: lease.sessionId, metered: lease.metered, model: t.model, voice: VOICES.has(voice) ? voice : DEFAULT_VOICE,
  });

  return json({
    ...t,
    session_id: lease.sessionId,
    billing_metered: lease.metered,
    // Advisory contract for the client's voice controller (see this file's
    // report to the coordinator for the exact Flutter wiring TODO): call
    // /api/ava/live/heartbeat roughly this often while the call is live, and
    // ALWAYS call /api/ava/live/close exactly once when the call ends for any
    // reason. Neither call has any effect while billing is dark.
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_HINT_MS,
  });
}

// POST /api/ava/live/heartbeat { session_id } — auth required. The client's
// voice controller MUST call this on a steady interval (~HEARTBEAT_INTERVAL_HINT_MS,
// returned by /token above) for the ENTIRE duration of a live Gemini Live call.
// Each call is proof-of-life: it extends the server-side lease and tops up the
// wallet runway reservation. It does NOT charge — the one and only real
// charge happens once, at /close or the reaper, via voice_billing.ts's
// settleOnce() (see that file's header, BLOCKER 1). Stopping heartbeats
// (disconnect, app kill, crash) is exactly what the reaper is for — no
// explicit error handling is required client-side beyond "if this call fails
// with insufficient_balance, end the Gemini Live call now" (a signal, not a
// charge failure — nothing was charged here either way).
export async function avaLiveHeartbeat(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let sessionId = "";
  try {
    const b: any = await req.json();
    if (typeof b?.session_id === "string") sessionId = b.session_id.trim();
  } catch { /* no body */ }
  if (!sessionId) return json({ error: "missing session_id" }, 400);

  const r = await heartbeatVoiceLease(env, { uid: ctx.uid, sessionId }).catch(async (e) => {
    void trackException(env, e, { uid: ctx.uid, route: "ava_live.avaLiveHeartbeat", method: "heartbeatVoiceLease", handled: true, extra: { session_id: sessionId } });
    // Fail open: a heartbeat-plumbing error must never itself terminate a
    // live call the user is actively paying attention to.
    return { ok: true, metered: false, found: true, tokensCharged: 0, chargedNow: 0, elapsedSec: 0 } as const;
  });

  if (r.chargedNow > 0) {
    const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
    void trackUserContact(env, ctx.uid, contact.email, contact.phone, "avabrain_voice_minute_settled", "avabrain_voice", {
      session_id: sessionId, tokens_charged_now: r.chargedNow, tokens_charged_total: r.tokensCharged,
      elapsed_sec: r.elapsedSec, rate_per_min: 3,
    });
  }
  if (!r.ok && r.error === "insufficient_balance") {
    const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
    void trackUserContact(env, ctx.uid, contact.email, contact.phone, "avabrain_voice_wallet_blocked", "avabrain_voice", {
      session_id: sessionId, stage: "mid_call", tokens_charged_total: r.tokensCharged, elapsed_sec: r.elapsedSec,
    });
    return json({ error: "insufficient_balance", action: "top_up" }, 402);
  }
  // [NIT 13] A genuine ownership mismatch is still a real 404; a lease row
  // simply not existing (billing off, or start failed open) is NOT an error —
  // heartbeatVoiceLease already reports that as {ok:true, metered:false,
  // found:false} below, so the client just keeps calling (harmlessly) or
  // stops per `metered` from /token.
  if (!r.ok && r.error === "not_owner") return json({ error: r.error }, 404);

  return json({ ok: true, metered: r.metered, found: r.found, tokens_charged: r.tokensCharged, elapsed_sec: r.elapsedSec, lease_timeout_ms: "leaseTimeoutMs" in r ? r.leaseTimeoutMs : undefined });
}

// POST /api/ava/live/close { session_id, reason? } — auth required. The client
// MUST call this exactly once whenever a live call ends for ANY reason (user
// hangs up, navigates away, token nears expiry, client-side error). Final
// exact settle + full release of the wallet runway hold. Safe to call more
// than once for the same session_id (idempotent no-op replay).
export async function avaLiveClose(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let sessionId = "";
  let reason = "client_close";
  try {
    const b: any = await req.json();
    if (typeof b?.session_id === "string") sessionId = b.session_id.trim();
    if (typeof b?.reason === "string") reason = b.reason.trim().slice(0, 60) || "client_close";
  } catch { /* no body */ }
  if (!sessionId) return json({ error: "missing session_id" }, 400);

  const r = await closeVoiceLease(env, { uid: ctx.uid, sessionId, reason }).catch((e) => {
    void trackException(env, e, { uid: ctx.uid, route: "ava_live.avaLiveClose", method: "closeVoiceLease", handled: true, extra: { session_id: sessionId } });
    return { ok: true, metered: false, found: true, tokensCharged: 0, chargedNow: 0, elapsedSec: 0 } as const;
  });

  const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  void trackUserContact(env, ctx.uid, contact.email, contact.phone, "avabrain_voice_session_closed", "avabrain_voice", {
    session_id: sessionId, reason, minutes: Math.ceil(r.elapsedSec / 60), elapsed_sec: r.elapsedSec,
    wallet_tokens_charged: r.tokensCharged,
  });

  return json({ ok: true, metered: r.metered, found: r.found, tokens_charged: r.tokensCharged, elapsed_sec: r.elapsedSec });
}
