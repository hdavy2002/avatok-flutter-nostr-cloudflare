// Ava Receptionist — premium "Ava answers after 5 rings".
// Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md. First real AvaVoice deployment.
//
// Flow:
//   1. Owner (premium) enables Ava + writes "Leave Instructions for Ava".
//   2. Caller's app rings owner; after ~5 rings with no answer, the caller's
//      client calls POST /api/receptionist/start.
//   3. We stash a short-lived init blob in KV and hand the caller a WS URL to the
//      ReceptionRoom DO (do/reception_room.ts). The DO opens Gemini Live THROUGH
//      Cloudflare AI Gateway (key + system prompt + 70s cap all server-side, so
//      the client can't tamper), relays audio, captures the transcript, and on
//      close posts a message + voicemail recording under the caller's phone number
//      and pushes the owner.
//
// Endpoints:
//   GET  /api/receptionist/settings            owner reads own config
//   PUT  /api/receptionist/settings            owner updates (enable = premium-gated)
//   GET  /api/receptionist/config?to=<uid>      caller: "should I route to Ava?"
//   POST /api/receptionist/start                caller opens an Ava session (returns DO WS)
//   POST /api/receptionist/finish               caller-side safety finalize (DO normally finalizes)
//   (WS) /api/receptionist/rtc?session=&t=       → ReceptionRoom DO (handled in index.ts)
import type { Env } from "../types";
import { json, normalizePhone } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { track, trackUserContact, metric } from "../hooks";
import { contactFor, nameFor } from "../lib/identity";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { enforceAllowance, planLimitBody } from "../lib/usage";
import { tierOf } from "./plans";
import { guardWrite } from "./moderate"; // save-time content validation (Nemotron)

// Receptionist gating is SUBSCRIPTION-DRIVEN (not a hard premium wall): it reads
// the OWNER's tier's daily `recept` allowance from plans.ts, which merges the KV
// `plan_config` override. So Free gets its allotment (default 3/day), and any
// admin change — "20 free", or unlimited — auto-applies with no redeploy. The
// receptionist always reflects the current subscription packages.
async function receptAllowance(env: Env, ownerUid: string, commit: boolean) {
  const tier = await tierOf(env, ownerUid);
  const res = await enforceAllowance(env, ownerUid, tier, "recept", 1, { commit });
  return { tier, res };
}

// FREE FOR NOW (owner decision 2026-06-29): the AI Receptionist is FREE for
// everyone — the paid-tier gate is OFF while the all-free beta flag
// `betaFreePremium` is on (its current state). When `betaFreePremium` is later
// turned off (billing enabled), the original premium gate below automatically
// returns: Free (tier 0) loses it, paid tiers (≥1) keep it. The gate is applied
// on every surface (settings read/write, dial-time probe, session start) and the
// daily `recept` allowance is also skipped while free (unlimited).
const RECEPT_MIN_TIER = 1;
function isPaidTier(tier: number): boolean {
  return tier >= RECEPT_MIN_TIER;
}

const APP = "receptionist";

// AI voice secretary → Gemini 3.1 Flash Live (verified working on the Developer
// API). The old "gemini-live-2.5-flash-native-audio" is a Vertex-only id and does
// not exist on generativelanguage.googleapis.com. Vision is irrelevant here (audio).
export const RECEPTIONIST_MODEL_DEFAULT = "gemini-3.1-flash-live-preview";

// 70-second cap (owner decision 2026-06-28): the call is ~1 minute. Ava begins
// wrapping up at 55s and the call is force-ended at 70s — enough to take a short
// message and say a graceful goodbye, no long introductions.
// Voicemail budget (owner decision 2026-06-29): ~10s greeting + 50s message + 20s
// wrap = ~80s total. The CF engine also runs a 50s message-window timer (starts
// after the greeting) that makes Ava cut in with a "time's up" close.
export const HARD_CAP_MS = 80_000; // force end
export const SOFT_CAP_MS = 60_000; // begin wrap-up (greet + message elapsed)
const MAX_INSTRUCTIONS = 2000;
const INIT_TTL_SEC = 300;           // caller must connect the WS within 5 min

// Voice picker — ALL 30 prebuilt Gemini Live voices (mirror of
// app/lib/core/voice/google_voice.dart). Each is verified to complete the Live
// handshake; the client labels them woman/man so the owner can pick by gender.
const VOICES = new Set([
  // female / woman
  "Aoede", "Kore", "Leda", "Zephyr", "Autonoe", "Callirrhoe", "Despina", "Erinome",
  "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat",
  "Achird", "Sadachbia",
  // male / man
  "Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Zubenelgenubi", "Sadaltager",
]);
const DEFAULT_VOICE = "Aoede"; // warm FEMALE default for "Ava" (owner can override in Settings)

// Cloudflare-native engine (receptionistUseCf) voice: ONE fixed warm female
// Deepgram Aura-2 voice for "Ava" (no per-owner pick / no cloning on this engine
// yet). "asteria" is Aura-2's flagship female. The owner's stored Gemini
// voice_name is ignored while the CF engine is active.
const AVA_CF_VOICE = "asteria";

// --- v2: persona, language, availability status -----------------------------
const MAX_GREETING = 200;
const MAX_CUSTOM_PROMPT = 1000;
const MAX_STATUS_CUSTOM = 120;

// Availability presets (Mode B). Maps a preset id → a natural phrase Ava speaks.
// Mirrors the 27-language picker decision: a fixed, validated set so a bad value
// can never break a call.
const STATUS_PRESETS: Record<string, string> = {
  busy: "is busy right now",
  travelling: "is travelling at the moment",
  meeting: "is in a meeting right now",
  driving: "is driving at the moment",
  holiday: "is on holiday right now",
  unavailable: "is unable to take calls right now",
  after_hours: "is unavailable after hours right now",
  custom: "", // resolved from status_custom (legacy; no longer offered in the UI)
};

// 27 BCP-47 codes verified to complete the Gemini Live handshake (mirror of the
// Ava-voice language picker). NULL/empty = auto-detect. Pinned into speechConfig
// server-side via the init blob so a selection can never break the call.
const LANG_CODES = new Set([
  "en-US", "en-GB", "en-IN", "en-AU", "es-ES", "es-US", "fr-FR", "de-DE", "it-IT",
  "pt-BR", "pt-PT", "nl-NL", "pl-PL", "ru-RU", "tr-TR", "ar-XA", "hi-IN", "bn-IN",
  "ta-IN", "te-IN", "ja-JP", "ko-KR", "cmn-CN", "vi-VN", "id-ID", "th-TH", "uk-UA",
]);

/** Resolve the spoken availability phrase from preset + custom text. */
function statusPhrase(s: SettingsRow): string {
  const preset = (s.status_preset || "").trim();
  if (!preset) return "";
  if (preset === "custom") return (s.status_custom || "").trim();
  return STATUS_PRESETS[preset] ?? "";
}

// ---------------------------------------------------------------------------
// kill switch
// ---------------------------------------------------------------------------
async function flagOff(env: Env): Promise<Response | null> {
  const cfg = await readConfig(env);
  return (cfg as any).receptionistEnabled === false
    ? json({ error: "receptionist disabled", flag: "receptionistEnabled" }, 503) : null;
}

interface SettingsRow {
  owner_uid: string; enabled: number; instructions_text: string | null;
  voice_name: string; display_name: string | null; file_search_store: string | null;
  created_at: number; updated_at: number;
  // v2
  persona_name?: string | null; language_code?: string | null;
  greeting_text?: string | null; custom_prompt?: string | null;
  answer_all?: number; status_preset?: string | null; status_custom?: string | null;
  decline_to_ava?: number;
}

async function loadSettings(env: Env, uid: string): Promise<SettingsRow | null> {
  const r = await metaDb(env).prepare("SELECT * FROM receptionist_settings WHERE owner_uid=?1")
    .bind(uid).first<any>();
  return r ? (r as SettingsRow) : null;
}

// DEFAULT-ON (owner decision 2026-06-29): a user who has NEVER configured the
// receptionist (no row) gets it ENABLED by default — Ava answers their unanswered
// calls out of the box. An explicit opt-out (a saved row with enabled=0) is still
// respected. Safe defaults so a never-configured account still composes a valid
// call (warm female voice, "Ava" persona, message-first prompt, rings mode).
function defaultSettings(uid: string): SettingsRow {
  return {
    owner_uid: uid, enabled: 1, instructions_text: null,
    voice_name: DEFAULT_VOICE, display_name: null, file_search_store: null,
    created_at: 0, updated_at: 0,
    persona_name: null, language_code: null, greeting_text: null, custom_prompt: null,
    answer_all: 0, status_preset: null, status_custom: null, decline_to_ava: 0,
  };
}

// ── Settings cache (KV) ──────────────────────────────────────────────────────
// Settings change rarely but are read on EVERY dial-time /config probe and every
// /start. Cache the row in KV, busted the instant the owner saves (PUT/KB), with
// a short TTL backstop. "" caches a known-absent row so we don't re-hit D1 for a
// user who never configured Ava. Reads stay correct: a save always re-warms it.
const SETTINGS_CACHE_TTL = 600; // 10 min safety net; explicit bust on save
const settingsCacheKey = (uid: string) => `recept_settings:${uid}`;

async function loadSettingsCached(env: Env, uid: string): Promise<SettingsRow | null> {
  try {
    const raw = await env.TOKENS.get(settingsCacheKey(uid));
    if (raw !== null) return raw === "" ? null : (JSON.parse(raw) as SettingsRow);
  } catch { /* fall through to D1 */ }
  const s = await loadSettings(env, uid);
  try {
    await env.TOKENS.put(settingsCacheKey(uid), s ? JSON.stringify(s) : "", { expirationTtl: SETTINGS_CACHE_TTL });
  } catch { /* best-effort */ }
  return s;
}

/** Re-warm the cache from D1 after a write (save / KB change), so the very next
 *  call sees fresh settings without a cold D1 read. */
async function refreshSettingsCache(env: Env, uid: string): Promise<void> {
  try {
    const s = await loadSettings(env, uid);
    await env.TOKENS.put(settingsCacheKey(uid), s ? JSON.stringify(s) : "", { expirationTtl: SETTINGS_CACHE_TTL });
  } catch { /* best-effort — a stale entry still self-evicts via TTL */ }
}

/** Caller's local time-of-day word from their request timezone (Cloudflare geo),
 *  for Ava's personalised sign-off ("have a great evening"). Falls back to "day". */
function timeOfDayWord(tz: string | undefined | null): string {
  try {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "numeric", hour12: false }).format(new Date()));
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 22) return "evening";
    return "day";
  } catch { return "day"; }
}

// ---------------------------------------------------------------------------
// Hidden system prompt — composed server-side, never exposed to the client.
// Scaffold (role + ~1-min timing + safety): a short, message-first script.
// ---------------------------------------------------------------------------
export function composeReceptionistPrompt(
  s: SettingsRow,
  ctx?: { callerName?: string | null; activationMode?: string | null; ownerName?: string | null;
          gender?: string | null; engine?: "gemini" | "cf" | null; timeOfDay?: string | null },
): string {
  const me = (s.persona_name || "Ava").trim() || "Ava";  // Ava's own name (default Ava)
  const who = ((ctx?.ownerName || s.display_name || "the person you're assisting")).trim();
  const lang = (s.language_code || "").trim();
  const caller = (ctx?.callerName || "").trim();
  const callerRef = caller || "the caller";
  // First name + caller's local time-of-day → personalised, mostly-templated lines.
  const firstName = caller.split(/\s+/)[0] || "";
  const firstSuffix = firstName ? `, ${firstName}` : "";
  const tod = (ctx?.timeOfDay || "day").trim();
  // Owner's gender → pronouns (from the profile). male|female → he/she; else neutral.
  const g = (ctx?.gender || "").toLowerCase();
  const subj = g === "male" ? "he" : g === "female" ? "she" : "they";
  const obj  = g === "male" ? "him" : g === "female" ? "her" : "them";
  const poss = g === "male" ? "his" : g === "female" ? "her" : "their";
  // The SINGLE owner note ("Let Ava know if you're busy…").
  const note = (s.instructions_text || "").trim();
  // End mechanism differs per engine: Gemini hangs up via the end_call tool; the
  // CF engine ends on a silent <END_CALL> marker. Keep the branch so Gemini is unchanged.
  const endWith = ctx?.engine === "cf"
    ? `end your reply with the marker <END_CALL> on its own line (never say it aloud)`
    : `immediately call the end_call function`;

  // VOICEMAIL behaviour (owner decision 2026-06-29): Ava is a voicemail-taker, NOT
  // a conversationalist. She already KNOWS the caller's name + number, so she never
  // asks for them; she greets once, lets them leave a ~50s message, confirms once,
  // and hangs up. No questions, no back-and-forth.
  const lines: string[] = [
    `You are ${me}, ${who}'s voicemail assistant. ${who} can't pick up, so you take a short voice message. THIS IS A VOICEMAIL, NOT A CONVERSATION.`,
    `You ALREADY KNOW the caller is ${callerRef}, and ${who} already has ${poss} number. So you must NEVER ask for the caller's name, their number, or how to reach them — you have all of it.`,
    note ? `${who} left a note about ${poss} availability: "${note}". Weave it into your greeting naturally if it fits.` : ``,
    `STEP 1 — GREET in ONE short, warm sentence: tell ${callerRef} that ${who} can't take the call right now and to please leave a short message — about 50 seconds — and ${subj}'ll get back to ${obj}. Then stop talking.`,
    `STEP 2 — STAY SILENT and let them speak. Do NOT interrupt, do NOT ask anything, do NOT make small talk. Just listen to their whole message.`,
    `STEP 3 — When they finish, close with ONE short line in EXACTLY this shape and nothing more: "Got it — <one short clause capturing what they said>. I'll pass it on to ${who}. Have a great ${tod}${firstSuffix}!" Then ${endWith}. The ONLY thing you fill in is the brief clause about their message; the rest is fixed.`,
    `If you receive "[SYSTEM: time is up]": close with ONE short line: "That's all the time I have, but I've got your message and I'll pass it on to ${who}. Have a great ${tod}${firstSuffix}!" Then ${endWith}. Do not ask for anything more.`,
    `If they leave no message: "No message? No problem — I'll let ${who} know you called. Have a great ${tod}${firstSuffix}!" Then ${endWith}.`,
    `If asked who you are, say only "I'm ${who}'s assistant" and steer back to taking the message. Never debate, never chat, never answer off-topic questions. Refuse anything illegal or harmful. If asked, you may say the call is recorded.`,
  ].filter(Boolean);
  if (lang) lines.push(`Speak in ${lang}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GET /api/receptionist/settings  — owner reads own config
// ---------------------------------------------------------------------------
export async function receptionistGetSettings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await loadSettings(env, ctx.uid);
  // "Can THIS user enable the receptionist?" = PREMIUM-ONLY: a paid subscription
  // tier (Plus/Pro/Max). Free (tier 0) sees the toggle greyed + the upsell.
  const cfg = await readConfig(env);
  const tier = await tierOf(env, ctx.uid);
  // FREE FOR NOW: betaFreePremium → receptionist available to everyone.
  const premium = (cfg as any).betaFreePremium === true || isPaidTier(tier);
  return json({
    enabled: s ? !!s.enabled : true, // DEFAULT-ON: unconfigured users get it by default
    instructions_text: s?.instructions_text ?? "",
    voice_name: s?.voice_name ?? DEFAULT_VOICE,
    display_name: s?.display_name ?? "",
    has_kb: !!s?.file_search_store,
    // v2
    persona_name: s?.persona_name ?? "",
    language_code: s?.language_code ?? "",
    greeting_text: s?.greeting_text ?? "",
    custom_prompt: s?.custom_prompt ?? "",
    answer_all: !!(s?.answer_all),
    status_preset: s?.status_preset ?? "",
    status_custom: s?.status_custom ?? "",
    decline_to_ava: !!(s?.decline_to_ava),
    premium, // client greys the toggle + shows upsell when false
    soft_cap_ms: SOFT_CAP_MS, hard_cap_ms: HARD_CAP_MS,
  });
}

// ---------------------------------------------------------------------------
// PUT /api/receptionist/settings  — owner updates (enable is premium-gated)
// ---------------------------------------------------------------------------
export async function receptionistPutSettings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const b = (await req.json().catch(() => ({}))) as any;

  const enabled = b.enabled === true;
  if (enabled) {
    // FREE FOR NOW: betaFreePremium lets anyone enable it. When off (billing on),
    // the paid-tier gate returns.
    const cfg = await readConfig(env);
    if ((cfg as any).betaFreePremium !== true) {
      const tier = await tierOf(env, ctx.uid);
      if (!isPaidTier(tier)) return premiumUpsell(env, ctx.uid, "receptionist");
    }
  }
  const instr = b.instructions_text == null ? "" : String(b.instructions_text).slice(0, MAX_INSTRUCTIONS);
  let voice = String(b.voice_name || DEFAULT_VOICE);
  if (!VOICES.has(voice)) voice = DEFAULT_VOICE;
  const display = b.display_name == null ? null : String(b.display_name).slice(0, 60).trim() || null;

  // v2 fields — each validated/capped against a fixed allow-list so a bad value
  // can never break a live call.
  const persona = b.persona_name == null ? null : String(b.persona_name).slice(0, 40).trim() || null;
  let language: string | null = b.language_code == null ? null : String(b.language_code).trim();
  if (language && !LANG_CODES.has(language)) language = null; // unknown → auto-detect
  const greeting = b.greeting_text == null ? null : String(b.greeting_text).slice(0, MAX_GREETING).trim() || null;
  const customPrompt = b.custom_prompt == null ? null : String(b.custom_prompt).slice(0, MAX_CUSTOM_PROMPT).trim() || null;
  const answerAll = b.answer_all === true ? 1 : 0;
  const declineToAva = b.decline_to_ava === true ? 1 : 0;
  let statusPreset: string | null = b.status_preset == null ? null : String(b.status_preset).trim();
  if (statusPreset && !(statusPreset in STATUS_PRESETS)) statusPreset = null;
  const statusCustom = b.status_custom == null ? null : String(b.status_custom).slice(0, MAX_STATUS_CUSTOM).trim() || null;

  // Save-time content validation (Nemotron). Reject before persisting so an
  // unsafe persona/instruction/greeting never reaches a live call.
  const blocked = await guardWrite(req, env, ctx.uid, "receptionist", [
    { text: instr, field: "prompt" },
    { text: customPrompt, field: "prompt" },
    { text: greeting, field: "greeting" },
    { text: statusCustom, field: "status" },
    { text: display, field: "name" },
    { text: persona, field: "persona_name" },
  ]);
  if (blocked) return blocked;

  const now = Date.now();

  await metaDb(env).prepare(
    `INSERT INTO receptionist_settings
       (owner_uid, enabled, instructions_text, voice_name, display_name,
        persona_name, language_code, greeting_text, custom_prompt,
        answer_all, status_preset, status_custom, decline_to_ava,
        created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)
     ON CONFLICT(owner_uid) DO UPDATE SET
       enabled=?2, instructions_text=?3, voice_name=?4, display_name=?5,
       persona_name=?6, language_code=?7, greeting_text=?8, custom_prompt=?9,
       answer_all=?10, status_preset=?11, status_custom=?12, decline_to_ava=?13,
       updated_at=?14`,
  ).bind(ctx.uid, enabled ? 1 : 0, instr, voice, display,
    persona, language, greeting, customPrompt,
    answerAll, statusPreset, statusCustom, declineToAva, now).run();

  await refreshSettingsCache(env, ctx.uid); // bust-on-save: next call sees fresh settings
  track(env, ctx.uid, enabled ? "ava_recept_enabled" : "ava_recept_disabled", APP,
    { has_instructions: instr.length > 0, voice, has_persona: !!persona,
      language: language ?? "auto", answer_all: !!answerAll,
      status_preset: statusPreset ?? "", decline_to_ava: !!declineToAva });
  return json({ ok: true, enabled, voice_name: voice, answer_all: !!answerAll, decline_to_ava: !!declineToAva });
}

// ---------------------------------------------------------------------------
// GET /api/receptionist/config?to=<uid>  — caller asks "is Ava available here?"
// Returns ONLY public bits (never the owner's private instructions).
// ---------------------------------------------------------------------------
export async function receptionistConfigFor(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const t0 = Date.now();
  const to = String(new URL(req.url).searchParams.get("to") || "");
  // "Should Ava answer here?" decision telemetry — one row per dial-time probe,
  // so we can see how often callers find Ava available vs off/not_premium.
  const checked = (available: boolean, reason: string, mode?: string) =>
    track(env, ctx.uid, "ava_recept_config_checked", APP,
      { to, available, reason, mode: mode ?? "", latency_ms: Date.now() - t0 });
  const cfg = await readConfig(env);
  if ((cfg as any).receptionistEnabled === false) { checked(false, "disabled"); return json({ available: false, reason: "disabled" }); }
  if (!to) return json({ error: "to required" }, 400);
  // FREE FOR NOW: default-ON for unconfigured owners; betaFreePremium skips the
  // paid-tier gate AND the daily allowance (free + unlimited). An explicit opt-out
  // (saved row with enabled=0) is still respected.
  const freeLaunch = (cfg as any).betaFreePremium === true;
  let s = await loadSettingsCached(env, to);
  if (s && !s.enabled) { checked(false, "off"); return json({ available: false, reason: "off" }); }
  if (!s) s = defaultSettings(to);
  const ownerTier = await tierOf(env, to);
  if (!freeLaunch && !isPaidTier(ownerTier)) { checked(false, "not_premium"); return json({ available: false, reason: "not_premium" }); }
  // Subscription allowance (peek — don't consume on a dial-time probe).
  const { res } = await receptAllowance(env, to, false);
  // v2: tell the caller HOW to hand off.
  //  - first_ring  → answer on ring 1 (owner is busy/away, Mode B)
  //  - rings       → wait for `rings` unanswered rings, then hand off (Mode A)
  // Manual hand-off (Mode C) and decline-to-Ava are owner-side and don't depend
  // on this; we surface decline_to_ava so the incoming UI knows its options.
  const rings = Math.max(1, Math.round(Number((cfg as any).receptionistRings ?? 5)));
  const mode = s.answer_all ? "first_ring" : "rings";
  if (!freeLaunch && !res.allowed) {
    checked(false, "plan_limit", mode);
    return json({ available: false, reason: "plan_limit", remaining: 0, cap: res.cap });
  }
  checked(true, "available", mode);
  return json({
    available: true, mode, rings,
    decline_to_ava: !!s.decline_to_ava,
    voice_name: s.voice_name || DEFAULT_VOICE,
    display_name: s.display_name ?? "",
    recept_remaining: res.remaining, recept_cap: res.cap,
    soft_cap_ms: SOFT_CAP_MS, hard_cap_ms: HARD_CAP_MS,
  });
}

// ---------------------------------------------------------------------------
// POST /api/receptionist/start  — caller opens an Ava session after 5 rings
// body: { to, call_id?, caller_phone?, caller_name? }
// ---------------------------------------------------------------------------
export async function receptionistStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const b = (await req.json().catch(() => ({}))) as any;
  const to = String(b.to || "");
  if (!to) return json({ error: "to required" }, 400);

  // Resolve the caller's contact once so EVERY start-path event (incl. the
  // "why Ava didn't answer" skips) is pullable by the caller's email/phone.
  const caller = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  const skip = (reason: string, extra: Record<string, unknown> = {}) =>
    trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_skipped", APP,
      { owner: to, reason, ...extra });

  // Engine switch (KV flag): CF-native pipeline (Workers AI) vs Gemini Live. Read
  // once so the init blob the DO consumes pins the engine for THIS call.
  const cfg = await readConfig(env);
  const useCf = (cfg as any).receptionistUseCf === true;

  // FREE FOR NOW + DEFAULT-ON: unconfigured owners get Ava by default; an explicit
  // opt-out (saved row with enabled=0) is respected. betaFreePremium skips the
  // paid-tier gate + allowance below.
  const freeLaunch = (cfg as any).betaFreePremium === true;
  let s = await loadSettingsCached(env, to);
  if (s && !s.enabled) { skip("off"); return json({ error: "receptionist_unavailable", reason: "off" }, 409); }
  if (!s) s = defaultSettings(to);
  // Gemini engine needs a Gemini key (dedicated, else global); the CF engine runs
  // entirely on the Workers AI binding and needs no Gemini key.
  if (!useCf && !env.RECEPTIONIST_GEMINI_API_KEY && !env.GEMINI_API_KEY) { skip("no_model_key"); return json({ error: "receptionist_unavailable", reason: "no_model_key" }, 503); }
  // PREMIUM-ONLY: the OWNER must be a paid subscriber (Plus/Pro/Max). A Free owner
  // never gets Ava → caller falls back to a plain missed call.
  const ownerTier = await tierOf(env, to);
  if (!freeLaunch && !isPaidTier(ownerTier)) {
    skip("not_premium", { tier: ownerTier });
    return json({ error: "receptionist_unavailable", reason: "not_premium" }, 409);
  }
  // Subscription allowance — consume one recept unit (only when NOT free; while
  // betaFreePremium is on it's unlimited and unmetered).
  const { tier, res } = await receptAllowance(env, to, !freeLaunch);
  if (!freeLaunch && !res.allowed) {
    skip("plan_limit", { tier, cap: res.cap, used: res.used });
    trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_plan_block", APP,
      { owner: to, tier, cap: res.cap, used: res.used });
    return json({ error: "receptionist_unavailable", reason: "plan_limit", ...planLimitBody(res) }, 402);
  }

  const sid = crypto.randomUUID();
  const rtcToken = crypto.randomUUID();
  const now = Date.now();
  // Caller's number for the owner's voicemail label — client value, else the
  // caller's own number resolved server-side (so the card isn't "Unknown caller").
  const callerPhone = (b.caller_phone ? normalizePhone(String(b.caller_phone)) : null) || caller.phone || null;
  // Caller name for Ava's "Hi <name>…" greeting: prefer a client-sent name, else
  // resolve the caller's own name SERVER-SIDE from Clerk (so no app change needed).
  const callerName = (b.caller_name == null ? null : String(b.caller_name).slice(0, 80))
    || await nameFor(env, ctx.uid).catch(() => null);
  // Owner's name for the greeting ("<owner> is travelling…") and the caller's ack
  // ("this is <owner>'s assistant"): the settings display_name, else resolved from
  // the owner's profile/Clerk — so it's never the awkward fallback "your contact".
  const ownerName = (s.display_name || "").trim() || (await nameFor(env, to).catch(() => null)) || null;
  // Owner gender → Ava's pronouns ("a message for him/her/them"). From the profile
  // (users.gender); null/unknown → neutral "them".
  let ownerGender: string | null = null;
  try {
    const gr = await metaDb(env).prepare("SELECT gender FROM users WHERE uid=?1").bind(to).first<{ gender: string | null }>();
    ownerGender = gr?.gender ?? null;
  } catch { /* column may be absent on an un-migrated env → neutral */ }

  // DETERMINISTIC GREETING (owner decision 2026-06-29): composed server-side and
  // spoken immediately by the CF engine — NO LLM round-trip — so there's no dead
  // air at the start (was ~5.5s). Uses the caller's FIRST name + owner pronoun.
  const firstName = (callerName || "").trim().split(/\s+/)[0] || "";
  const gSubj = ownerGender === "male" ? "he" : ownerGender === "female" ? "she" : "they";
  const ownerLabel = ownerName || "your contact";
  const greeting = firstName
    ? `Hey ${firstName}, ${ownerLabel} can't take your call right now. Please leave a short message — about 50 seconds — and ${gSubj}'ll get back to you.`
    : `Hi, ${ownerLabel} can't take your call right now. Please leave a short message — about 50 seconds — and ${gSubj}'ll get back to you.`;
  const callId = b.call_id == null ? null : String(b.call_id).slice(0, 64);
  // v2: how the call was handed off. Standard 2-button incoming UI, so the
  // triggers are: rings (no answer), first_ring (answer-all), decline (callee
  // hit Decline with decline-to-Ava on), busy (callee was on another call).
  const VALID_MODES = new Set(["rings", "first_ring", "decline", "busy"]);
  let activationMode = String(b.activation_mode || "rings");
  if (!VALID_MODES.has(activationMode)) activationMode = "rings";

  // Team Receptionist context (Specs/TEAM-RECEPTIONIST-IVR-SPEC.md): when this Ava
  // session is the no-answer fallback for a staffer dialed via a team IVR menu, the
  // caller passes the team id + the menu slot. Tagging the session lets the message
  // card fan out to the manager's team inbox and meters the team's recept pool.
  const teamId = b.team_id == null ? null : String(b.team_id).slice(0, 64);
  const teamSlot = b.team_slot == null ? null : (Number(b.team_slot) || null);

  // Session row (active). The DO finalizes it on close.
  await metaDb(env).prepare(
    `INSERT INTO receptionist_sessions
       (id, owner_uid, caller_uid, caller_phone, caller_name, call_id, activation_mode, team_id, team_slot, status, started_at, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?9,?10,'active',?8,?8,?8)`,
  ).bind(sid, to, ctx.uid, callerPhone, callerName, callId, activationMode, now, teamId, teamSlot).run();
  // Meter the team's monthly receptionist-minute pool (~1 min/session; the call is
  // capped at 70s). Best-effort; the per-owner daily allowance above is the hard gate.
  if (teamId) {
    try {
      await metaDb(env).prepare(
        "UPDATE teams SET recept_min_used = recept_min_used + 1, updated_at=?2 WHERE id=?1",
      ).bind(teamId, now).run();
    } catch { /* pool gauge is best-effort */ }
  }

  // Init blob the DO reads on connect (system prompt is composed here, locked
  // server-side, and handed to the DO — never sent to the client).
  const init = {
    sid, owner_uid: to, caller_uid: ctx.uid, caller_phone: callerPhone,
    caller_name: callerName, call_id: callId, rtc_token: rtcToken,
    // CF engine uses ONE fixed female Aura voice; Gemini uses the owner's pick.
    voice_name: useCf ? AVA_CF_VOICE : (s.voice_name || DEFAULT_VOICE),
    language_code: s.language_code || null,       // v2: DO pins speechConfig.languageCode
    activation_mode: activationMode,              // v2: telemetry context for the DO
    file_search_store: s.file_search_store || null,
    // Caller-aware + status-aware system prompt: "Hi <caller>, <owner> is
    // travelling/busy. Can I take a message?" — composed server-side, locked.
    system_prompt: composeReceptionistPrompt(s, { callerName, activationMode, ownerName, gender: ownerGender, engine: useCf ? "cf" : "gemini", timeOfDay: timeOfDayWord((req as any)?.cf?.timezone) }),
    owner_name: ownerName,
    ava_name: (s.persona_name || "Ava").trim() || "Ava", // transcript speaker label

    // engine: "cf" → the WS routes to ReceptionRoomCf (Workers AI); else Gemini.
    engine: useCf ? "cf" : "gemini",
    cf_voice: useCf ? AVA_CF_VOICE : null,
    greeting,                                     // CF engine speaks this immediately (no LLM)
    model: useCf ? "cf-workers-ai" : ((env as any).RECEPTIONIST_MODEL || RECEPTIONIST_MODEL_DEFAULT),
    soft_cap_ms: SOFT_CAP_MS, hard_cap_ms: HARD_CAP_MS,
    started_at: now,
  };
  await env.TOKENS.put(`recept_rtc:${sid}`, JSON.stringify(init), { expirationTtl: INIT_TTL_SEC });

  // Stamp the caller's email/phone so support can pull a complainant's
  // receptionist calls by contact. trace_id = the session id (one-call trace).
  // (caller contact was resolved once above and reused here.)
  trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_triggered", APP,
    { owner: to, has_phone: !!callerPhone, call_id: callId, activation_mode: activationMode }, sid);
  metric(env, "ava_recept_triggered", [1]);

  return json({
    ok: true, session_id: sid,
    // Same client, same route — `&engine=cf` makes index.ts hand the WS to the
    // Cloudflare-native DO. Omitted (Gemini) → the existing ReceptionRoom.
    rtc_url: `/api/receptionist/rtc?session=${sid}&t=${rtcToken}${useCf ? "&engine=cf" : ""}`,
    rtc_token: rtcToken,
    voice_name: init.voice_name, model: init.model,
    soft_cap_ms: SOFT_CAP_MS, hard_cap_ms: HARD_CAP_MS,
  });
}

// ---------------------------------------------------------------------------
// POST /api/receptionist/finish  — caller-side safety finalize.
// The DO normally finalizes (message + recording + push) on WS close; this marks
// a session ended when the client never managed to connect the WS.
// ---------------------------------------------------------------------------
export async function receptionistFinish(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const sid = String(b.session_id || "");
  const reason = String(b.cutoff_reason || "caller_hangup").slice(0, 32);
  const s = await metaDb(env).prepare("SELECT * FROM receptionist_sessions WHERE id=?1").bind(sid).first<any>();
  if (!s || s.caller_uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status !== "active") return json({ ok: true, already: true });
  const now = Date.now();
  await metaDb(env).prepare(
    "UPDATE receptionist_sessions SET status='ended', ended_at=?2, cutoff_reason=?3, duration_s=?4, updated_at=?2 WHERE id=?1",
  ).bind(sid, now, reason, Math.round((now - Number(s.started_at)) / 1000)).run();
  await env.TOKENS.delete(`recept_rtc:${sid}`).catch(() => {});
  track(env, ctx.uid, "ava_recept_session_failed", APP, { owner: s.owner_uid, reason });
  return json({ ok: true, ended: true });
}

// ---------------------------------------------------------------------------
// GET /api/receptionist/recording?sid=<session>  — owner streams the voicemail
// recording for the in-thread bubble's play button. Owner-only (the WAV is the
// owner's private record); the R2 key is never exposed to the client.
// ---------------------------------------------------------------------------
export async function receptionistRecording(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const sid = String(new URL(req.url).searchParams.get("sid") || "");
  if (!sid) return json({ error: "sid required" }, 400);
  const s = await metaDb(env).prepare(
    "SELECT owner_uid, recording_url, team_id FROM receptionist_sessions WHERE id=?1").bind(sid).first<any>();
  if (!s) return json({ error: "not found" }, 404);
  // Access: the staffer (session owner) always; for a team voicemail, the team
  // manager (Specs/TEAM-RECEPTIONIST-IVR-SPEC.md — card recipients = staffer + manager).
  let allowed = s.owner_uid === ctx.uid;
  if (!allowed && s.team_id) {
    const t = await metaDb(env).prepare("SELECT owner_uid FROM teams WHERE id=?1").bind(String(s.team_id)).first<{ owner_uid: string }>();
    allowed = !!t && t.owner_uid === ctx.uid;
  }
  if (!allowed) return json({ error: "not found" }, 404);
  if (!s.recording_url) return json({ error: "no recording" }, 404);
  const obj = await env.BLOBS.get(String(s.recording_url));
  if (!obj) return json({ error: "gone" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "audio/wav",
      "cache-control": "private, max-age=86400",
      "accept-ranges": "bytes",
    },
  });
}

// ---------------------------------------------------------------------------
// Knowledge base (Gemini File Search RAG) — Phase 7.
// Owner uploads files Ava can answer from. We keep the original in R2 and index
// it into the owner's Gemini File Search store (stored on receptionist_settings).
// The DO attaches { fileSearch: { fileSearchStoreNames:[store] } } when set.
// ---------------------------------------------------------------------------

/** Lazily create the owner's File Search store; returns its resource name. */
async function ensureReceptionistStore(env: Env, ownerUid: string, s: SettingsRow | null): Promise<string | null> {
  if (s?.file_search_store) return s.file_search_store;
  if (!env.GEMINI_API_KEY) return null;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/fileSearchStores", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ displayName: `receptionist-${ownerUid}` }),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j?.name) return null;
  await metaDb(env).prepare(
    "UPDATE receptionist_settings SET file_search_store=?2, updated_at=?3 WHERE owner_uid=?1",
  ).bind(ownerUid, String(j.name), Date.now()).run();
  return String(j.name);
}

/** Multipart upload one file into a File Search store (mirrors avavoice). */
async function indexToStore(env: Env, store: string, filename: string, bytes: ArrayBuffer): Promise<string | null> {
  const meta = JSON.stringify({ displayName: filename });
  const boundary = "recept" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.byteLength + tail.length);
  body.set(head, 0); body.set(new Uint8Array(bytes), head.length); body.set(tail, head.length + bytes.byteLength);
  const r = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/${store}:uploadToFileSearchStore`,
    { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}`, "x-goog-api-key": env.GEMINI_API_KEY! }, body },
  );
  const j = (await r.json().catch(() => ({}))) as any;
  return r.ok ? String(j?.name ?? j?.response?.document?.name ?? "pending") : null;
}

// POST /api/receptionist/kb?name=<filename>   (raw bytes body) — premium owner
export async function receptionistKbUpload(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "receptionist");
  const name = (new URL(req.url).searchParams.get("name") || "file").slice(0, 200);
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);
  if (bytes.byteLength > 25 * 1024 * 1024) return json({ error: "max 25 MB" }, 413);

  const s = await loadSettings(env, ctx.uid);
  const store = await ensureReceptionistStore(env, ctx.uid, s);
  if (!store) return json({ error: "kb_unavailable" }, 503);

  // Keep the original in R2 (account-scoped) + index into File Search.
  const fid = crypto.randomUUID();
  try { await env.BLOBS.put(`receptionist/${ctx.uid}/kb/${fid}/${name}`, bytes); } catch { /* best-effort */ }
  const doc = await indexToStore(env, store, name, bytes);
  await refreshSettingsCache(env, ctx.uid); // file_search_store changed → re-warm cache
  track(env, ctx.uid, "ava_recept_kb_uploaded", APP, { size: bytes.byteLength, indexed: !!doc });
  return json({ ok: true, indexed: !!doc, has_kb: true });
}

// DELETE /api/receptionist/kb — detach the store (Ava stops grounding on it)
export async function receptionistKbClear(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await loadSettings(env, ctx.uid);
  if (s?.file_search_store && env.GEMINI_API_KEY) {
    try {
      await fetch(`https://generativelanguage.googleapis.com/v1beta/${s.file_search_store}?force=true`, {
        method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY },
      });
    } catch { /* best-effort */ }
  }
  await metaDb(env).prepare("UPDATE receptionist_settings SET file_search_store=NULL, updated_at=?2 WHERE owner_uid=?1")
    .bind(ctx.uid, Date.now()).run();
  await refreshSettingsCache(env, ctx.uid); // KB detached → re-warm cache
  return json({ ok: true, has_kb: false });
}
