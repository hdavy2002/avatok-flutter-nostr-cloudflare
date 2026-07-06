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
import {
  authorityEnabled,
  authorityAcquire,
  authorityTransition,
  authorityQuery,
  authorityPreemptForCallback,
  authorityAbandonReceptionist,
  authorityRelease,
  shadowRecord,
} from "../lib/call_authority"; // control-plane authority — fail-open, flag-gated (see file header)

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

// SITEWIDE VOICEMAIL TIMING RULE (owner decision 2026-07-01):
//   1. GREETING — deterministic, spoken immediately; the message timer only arms
//      AFTER it finishes, so the greeting is never counted against the message time.
//   2. MESSAGE  — the caller gets exactly 25s to leave a message (CF_MSG_WINDOW_MS
//      in do/reception_room_cf.ts), armed after the greeting.
//   3. CLOSE    — UNTIMED. When the 25s elapses Ava gives her closing line and the
//      DO ends the call only AFTER that close audio has fully streamed
//      (processCfTurn → finalize). Her exit is NOT time-bound, so she never sounds
//      cut off mid-sentence.
// Because the close is untimed, these absolute caps are pure STALL backstops (a
// dead session / stuck engine only) and are set FAR above any normal call so they
// can NEVER clip Ava's close. Real dead-air still ends early via IDLE_MS/inactivity.
// P2 receptionist timeline (Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02, Phase 2).
// THE RELAY KEEPS TIME, never the model — these are absolute, server-authoritative
// points measured from Gemini session open (see do/reception_room.ts):
//   0–5s   greet + invite a message      (GREETING_PHASE_MS)
//   5–25s  caller's message / Ava answers follow-ups (MESSAGE_WINDOW_MS)
//   40s    relay injects the "~20s left, wrap up" cue, ONCE (WRAP_CUE_AT_MS)
//   60s    relay closes after Ava's current turn finishes (SESSION_CLOSE_MS)
//   90s    hard STALL backstop only — must NEVER clip a normal close (HARD_CAP_MS)
export const GREETING_PHASE_MS = 5_000;
export const MESSAGE_WINDOW_MS = 25_000;
export const WRAP_CUE_AT_MS = 40_000;
export const SESSION_CLOSE_MS = 60_000;
export const HARD_CAP_MS = 90_000;
// Back-compat: the client + settings routes read soft_cap_ms/hard_cap_ms. soft_cap
// now carries the SESSION-CLOSE deadline (the wrap point the client can surface).
export const SOFT_CAP_MS = SESSION_CLOSE_MS;
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
const DEFAULT_VOICE = "Aoede"; // warm FEMALE default for "Ava"
// P12 (OWNER DECISION 2026-07-02): Ava's ONE canonical female voice, everywhere,
// forever. Any client-supplied voice on the settings save is ignored and existing
// rows with a custom voice are overridden by this constant at prompt/init build.
export const AVA_VOICE = DEFAULT_VOICE;

// Cloudflare-native engine (receptionistUseCf) voice: ONE fixed warm female
// Deepgram Aura-2 voice for "Ava" (no per-owner pick / no cloning on this engine
// yet). "asteria" is Aura-2's flagship female. The owner's stored Gemini
// voice_name is ignored while the CF engine is active.
const AVA_CF_VOICE = "asteria";

// --- v2: persona, language, availability status -----------------------------
const MAX_GREETING = 200;
const MAX_CUSTOM_PROMPT = 1000;
const MAX_STATUS_CUSTOM = 120;
// F1 (Phase 12 finish): owner status note + expiry + default answering language.
const MAX_STATUS_NOTE = 500;
const STATUS_MAX_TTL_MS = 366 * 86_400_000; // notes expire at most ~1 year out
// Country (ISO-3166 alpha-2) → primary BCP-47 language, used ONLY as the client's
// first-load default suggestion when the owner has never set answer_lang. ~40
// launch markets; anything unmapped falls back to auto-detect.
export const COUNTRY_LANG: Record<string, string> = {
  IN: "hi", PK: "ur", BD: "bn", LK: "si", NP: "ne", BR: "pt", PT: "pt", FR: "fr",
  BE: "fr", ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", DE: "de",
  AT: "de", IT: "it", NL: "nl", RU: "ru", UA: "uk", TR: "tr", SA: "ar", AE: "ar",
  EG: "ar", MA: "ar", IL: "he", IR: "fa", CN: "zh", TW: "zh", HK: "zh", JP: "ja",
  KR: "ko", TH: "th", VN: "vi", ID: "id", MY: "ms", PH: "en", NG: "en", KE: "sw",
  ZA: "en", US: "en", GB: "en", CA: "en", AU: "en",
};

// F1: self-migrating settings columns (this codebase's established D1 pattern —
// guarded ADD COLUMN, once per isolate). Additive + backward-compatible; a proper
// migration file also lives at worker/migrations/. loadSettings uses SELECT * so
// the new columns surface automatically; the save INSERT needs them to exist.
let _receptColsEnsured = false;
async function ensureStatusColumns(env: Env): Promise<void> {
  if (_receptColsEnsured) return;
  _receptColsEnsured = true;
  const db = metaDb(env);
  for (const ddl of [
    "ALTER TABLE receptionist_settings ADD COLUMN status_note TEXT",
    "ALTER TABLE receptionist_settings ADD COLUMN status_expires_at INTEGER",
    "ALTER TABLE receptionist_settings ADD COLUMN answer_lang TEXT",
    // F2 (customizable greeting): a preset id (GREETING_PRESETS) and a festival
    // auto-greeting toggle. Same guarded ADD-COLUMN self-migration pattern.
    "ALTER TABLE receptionist_settings ADD COLUMN greeting_style TEXT",
    "ALTER TABLE receptionist_settings ADD COLUMN festival_greeting INTEGER",
  ]) { try { await db.prepare(ddl).run(); } catch { /* column already present */ } }
}

// F2: fixed, validated greeting presets (id → the exact phrase Ava opens with,
// before the caller's name). Mirrors STATUS_PRESETS: a bad/unknown value can never
// break a call — resolveGreetingPhrase() falls back to "" (Ava opens plainly).
// "custom" resolves from the owner's free-text greeting_text. Keep the ids in sync
// with kReceptionistGreetingPresets in the Flutter settings section.
const GREETING_PRESETS: Record<string, string> = {
  none: "",
  namaste: "Namaste",
  jai_shree_ram: "Jai Shree Ram",
  radhe_radhe: "Radhe Radhe",
  ram_ram: "Ram Ram",
  sat_sri_akal: "Sat Sri Akal",
  assalam: "Assalam-o-Alaikum",
  vanakkam: "Vanakkam",
  khamma_ghani: "Khamma Ghani",
  namaskar: "Namaskar",
  hello: "Hello",
  custom: "", // resolved from greeting_text
};

// F2: festival auto-greeting. When festival_greeting=1 and today matches a known
// festival, the festival greeting REPLACES the preset (e.g. "Merry Christmas").
// Graceful: no match → the preset/custom greeting is used instead.
//
// UPDATE FESTIVAL DATES ANNUALLY — the movable Hindu/Islamic festivals below are
// per-year approximate dates (they follow lunar calendars). Christmas & New Year
// are fixed. Add the next year's rows each year; a year with no row simply yields
// no festival match (falls back to the preset), so a stale table never breaks.
// Dates are "MM-DD" strings compared against the caller's UTC date.
const FESTIVAL_FIXED: Record<string, string> = {
  "12-25": "Merry Christmas",
  "01-01": "Happy New Year",
};
// Per-year movable festivals (approximate). key = "YYYY-MM-DD".
const FESTIVAL_BY_YEAR: Record<string, string> = {
  // 2026 (approximate)
  "2026-11-08": "Happy Diwali",       // Diwali 2026 (~Nov 8)
  "2026-03-04": "Happy Holi",         // Holi 2026 (~Mar 4)
  "2026-03-20": "Eid Mubarak",        // Eid al-Fitr 2026 (~Mar 20)
  // 2027 (approximate)
  "2027-10-29": "Happy Diwali",       // Diwali 2027 (~Oct 29)
  "2027-03-22": "Happy Holi",         // Holi 2027 (~Mar 22)
  "2027-03-10": "Eid Mubarak",        // Eid al-Fitr 2027 (~Mar 10)
};

/** F2: today's festival greeting (UTC), or "" if today is not a known festival. */
function festivalGreetingToday(now = new Date()): string {
  const y = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return FESTIVAL_BY_YEAR[`${y}-${mm}-${dd}`] ?? FESTIVAL_FIXED[`${mm}-${dd}`] ?? "";
}

/** F2: resolve the greeting phrase (BEFORE the caller's name) from settings.
 *  Precedence: festival (if enabled & today matches) → preset → custom → "".
 *  Always safe: an unknown style yields "" so the call still opens cleanly. */
function resolveGreetingPhrase(s: SettingsRow, now = new Date()): string {
  if (Number(s.festival_greeting) === 1) {
    const fest = festivalGreetingToday(now);
    if (fest) return fest;
  }
  const style = (s.greeting_style || "").trim();
  if (!style || style === "none") return "";
  if (style === "custom") return (s.greeting_text || "").trim();
  return GREETING_PRESETS[style] ?? "";
}

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

// BCP-47 codes verified to complete the Gemini Live handshake (mirror of the
// Ava-voice language picker). NULL/empty = auto-detect. Pinned into speechConfig
// server-side via the init blob so a selection can never break the call.
//
// Indian regional languages (2026-07-03): the base language codes below (mr, gu,
// kn, ml, pa, ur, or) are ALL in Gemini's documented audio supported-languages
// table (ai.google.dev/gemini-api/docs/speech-generation#supported-languages, as
// of 2026-05-18), so their -IN regional tags are safe to offer. Assamese (as-IN)
// was DELIBERATELY LEFT OUT — Assamese is NOT in that supported-languages table,
// so we don't offer it until Google lists it (an unsupported code would silently
// fall back to auto-detect anyway; better to not surface a broken choice).
const LANG_CODES = new Set([
  "en-US", "en-GB", "en-IN", "en-AU", "es-ES", "es-US", "fr-FR", "de-DE", "it-IT",
  "pt-BR", "pt-PT", "nl-NL", "pl-PL", "ru-RU", "tr-TR", "ar-XA", "hi-IN", "bn-IN",
  "ta-IN", "te-IN", "ja-JP", "ko-KR", "cmn-CN", "vi-VN", "id-ID", "th-TH", "uk-UA",
  // Indian regional languages (Gemini audio supported-languages table).
  "mr-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "ur-IN", "or-IN",
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
  // F1 (Phase 12 finish)
  status_note?: string | null; status_expires_at?: number | null; answer_lang?: string | null;
  // F2 (customizable greeting)
  greeting_style?: string | null; festival_greeting?: number | null;
}

async function loadSettings(env: Env, uid: string): Promise<SettingsRow | null> {
  const r = await metaDb(env).prepare("SELECT * FROM receptionist_settings WHERE owner_uid=?1")
    .bind(uid).first<any>();
  if (!r) return null;
  // F1: lazily clear an expired status note on the next read, so a stale note can
  // never reach a call's prompt (the prompt builder also double-checks the ts).
  if (r.status_expires_at != null && Number(r.status_expires_at) <= Date.now() && r.status_note) {
    r.status_note = null; r.status_expires_at = null;
    try {
      await metaDb(env).prepare("UPDATE receptionist_settings SET status_note=NULL, status_expires_at=NULL, updated_at=?2 WHERE owner_uid=?1")
        .bind(uid, Date.now()).run();
      track(env, uid, "recept_status_expired_cleared", "receptionist", {});
    } catch { /* best-effort */ }
  }
  return r as SettingsRow;
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
          gender?: string | null; engine?: "gemini" | "cf" | null; timeOfDay?: string | null;
          greeting?: string | null },
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
  // F1: default answering language + a time-bound status note. The status note is
  // included ONLY while unexpired (the relay/DB also lazy-clears it). answer_lang is
  // the OPENING language; caller-adaptive switching (P2) still applies on top.
  const answerLang = (s.answer_lang || "").trim();
  const statusNote = (s.status_note && (s.status_expires_at == null || Number(s.status_expires_at) > Date.now()))
    ? String(s.status_note).trim().slice(0, MAX_STATUS_NOTE) : "";
  const statusUntil = statusNote && s.status_expires_at ? new Date(Number(s.status_expires_at)).toUTCString() : "";

  // CF engine: the greeting is spoken deterministically and the ENGINE decides
  // turn-taking, so the LLM is invoked ONLY to produce the closing line. Keep this
  // dead simple so a small/fast model (Haiku) can't wander into questions or stage
  // directions like "<silence>". (Gemini keeps the conversational prompt below.)
  if (ctx?.engine === "cf") {
    return [
      `You are ${me}, ${who}'s voicemail assistant. ${who} couldn't pick up; a greeting has already played and the caller has just left a voice message. You ALREADY KNOW the caller (${callerRef}) and ${poss} number — NEVER ask for a name, number, or callback.`,
      `Reply with EXACTLY ONE short spoken line and NOTHING else: no questions, no follow-ups, no narration, and NEVER output placeholders or stage directions such as "<silence>", "(listening)", or "…".`,
      `• Normal message → "Got it — <one short clause capturing what they said>. I'll pass it on to ${who}. Have a great ${tod}${firstSuffix}!"`,
      `• If you see "[SYSTEM: time is up]" → "That's all the time I have, but I've got your message and I'll pass it on to ${who}. Have a great ${tod}${firstSuffix}!"`,
      `• If the caller left no message → "No message? No problem — I'll let ${who} know you called. Have a great ${tod}${firstSuffix}!"`,
      note ? `Context (never read aloud): ${who}'s availability note — "${note}".` : ``,
      // F1: time-bound status note — use it to answer, never read verbatim.
      statusNote ? `${who} left this note for you${statusUntil ? ` (valid until ${statusUntil})` : ""}: "${statusNote}". Use it to answer the caller — but never read it out word-for-word.` : ``,
      // F1: answer_lang is the opening language; else fall back to language_code.
      (answerLang || lang) ? `Speak in ${answerLang || lang}.` : ``,
      // P12/F1: Ava is a woman in every language — feminine self-reference always.
      `You are a woman: always use feminine verb/adjective forms when referring to yourself (e.g. Spanish "encantada", French "désolée", Hindi feminine forms). Never masculine self-reference.`,
      `Refuse anything illegal or harmful.`,
    ].filter(Boolean).join("\n");
  }
  // End mechanism differs per engine: Gemini hangs up via the end_call tool; the
  // CF engine ends on a silent <END_CALL> marker. Keep the branch so Gemini is unchanged.
  const endWith = ctx?.engine === "cf"
    ? `end your reply with the marker <END_CALL> on its own line (never say it aloud)`
    : `immediately call the end_call function`;

  // CONVERSATIONAL receptionist (owner decision 2026-07-02): Ava is a warm, brief
  // conversationalist — NOT a silent voicemail box. She greets, tells the caller
  // WHY the owner can't talk (from the availability note/status), offers to take a
  // message OR answer a quick question, has a short natural back-and-forth, and
  // wraps the WHOLE call inside ~1 minute with a SPOKEN goodbye (never a silent cut).
  const greetLine = (ctx?.greeting || "").trim();
  const isBusy = ctx?.activationMode === "busy";
  const step1 = greetLine
    ? `OPEN by warmly saying this greeting, then KEEP the conversation going naturally (do not just stop and go silent): "${greetLine}"`
    : `OPEN warmly in one or two friendly sentences: say hello, that you're ${me} (${who}'s assistant), and that ${subj} can't take the call right now${isBusy ? ` — ${subj}'s on another call at the moment` : note ? ` — ${note}` : ""}.`;
  const lines: string[] = [
    `You are ${me}, ${who}'s warm, friendly phone assistant. You are having a SHORT, NATURAL CONVERSATION with the caller — you are NOT reading a script and NOT silently recording a voicemail. Sound like a real, kind person; never robotic, never templated.`,
    // P2: language-adaptive from the first words, whole call incl. wrap-up + goodbye.
    `Detect the caller's language from their FIRST utterance and conduct the ENTIRE call in that language — the greeting, everything in between, the wrap-up, and the goodbye. If they switch languages, follow them.`,
    // P12 (OWNER DECISION 2026-07-02): Ava is a woman, in every language, always.
    `You are a woman. In every language, use the vocabulary, grammatical gender, and phrasing a woman naturally uses when referring to yourself — feminine verb and adjective forms in languages that inflect by speaker gender (Hindi: "मैं बोलूंगी", not "बोलूंगा"; Spanish: "encantada", not "encantado"; French: "je suis désolée"; Arabic/Hebrew feminine first-person forms), and the natural feminine register where the culture distinguishes one. Never slip into masculine self-reference.`,
    `You ALREADY KNOW the caller is ${callerRef}, and ${who} already has ${poss} number — so NEVER ask for a name, number, or callback; you have all of it.`,
    note && !greetLine ? `Why ${who} can't talk (from ${poss} note): "${note}". Tell the caller this NATURALLY in your own words — e.g. "${subj}'s travelling right now" or "${subj}'s in a meeting at the moment" — never read the note out word-for-word.` : ``,
    step1,
    `THEN offer a warm choice and let the caller lead: would they like to leave a message for ${who}, or is there something quick you can help with or answer for them?`,
    `Have a brief, natural back-and-forth: if they ask something you can reasonably answer from what you know, answer kindly and concisely; if they want to leave a message, listen and acknowledge it warmly. Keep YOUR turns SHORT (a sentence or two) so the caller does most of the talking. Never interrogate, never stall, and never invent facts about ${who} or ${poss} plans.`,
    `Keep the WHOLE call to about a minute. If the caller goes quiet, gently check in ("Anything else, or shall I pass this along to ${who}?") instead of leaving dead air or hanging up in silence.`,
    `WRAP-UP: when you get a system note that time is nearly up (e.g. "[SYSTEM: 20 seconds remain …]"), OR the chat naturally winds down, warmly say that's about all the time you have, give a one-line summary of what you'll pass on, promise to tell ${who}, and say a warm goodbye (e.g. "have a great ${tod}${firstSuffix}") — in your OWN natural words. Then ${endWith}. NEVER end the call silently.`,
    `If the caller clearly has nothing to say, warmly offer to just let ${who} know they called, then wrap up and ${endWith}.`,
    // AVA-VM-CLOSE-1: event-driven close. The moment the caller's message is complete
    // AND they fall silent, OR they say goodbye / "that's all", END the call yourself —
    // do NOT wait for a timer or leave the line open hoping for more.
    `END THE CALL YOURSELF as soon as the message is done. When the caller has clearly finished — they have given their message and gone quiet for a few seconds, OR they say "that's all" / "bye" / anything meaning they're done — say ONE short, warm closing line and IMMEDIATELY ${endWith}${ctx?.engine === "cf" ? "" : " with reason 'caller_bye' if they said goodbye, otherwise 'message_complete'"}. Do NOT ask another question, do NOT wait, do NOT re-offer help after they are done.`,
    // Never surface the time cap in normal flow — the cap is a silent backstop, not the UX.
    `NEVER mention time, a time limit, or "that's all the time I have" on your own. Only speak about time if you receive an explicit "[SYSTEM: … time is nearly up …]" note. In a normal call you simply take the message and close warmly the moment it's complete.`,
    `If asked who you are, say you're ${who}'s assistant helping out while ${subj}'s away. Stay on topic, be kind, and refuse anything illegal or harmful. If asked, you may say the call is recorded.`,
  ].filter(Boolean);
  // F1: time-bound status note — Ava uses it naturally (e.g. "he's out at lunch,
  // back around five"), never verbatim. Only present while unexpired.
  if (statusNote) {
    lines.push(`${who} left you this note${statusUntil ? ` (valid until ${statusUntil})` : ""}: "${statusNote}". Use it to answer callers naturally — e.g. tell them when ${subj}'ll be back — but never read it out word-for-word.`);
  }
  // F1: answer_lang is the OPENING language; caller-adaptive switching still applies
  // (the P2 detect-and-follow line above). Falls back to the legacy language_code.
  if (answerLang) {
    lines.push(`Answer the call in ${answerLang}. If the caller clearly speaks a different language, switch to theirs and stay in it.`);
  } else if (lang) {
    lines.push(`Speak in ${lang}.`);
  }
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
    // F1: status note + expiry + default answering language. `answer_lang_default`
    // is the GeoIP-derived suggestion the client pre-selects (labeled "(detected)")
    // ONLY when the owner has never saved an answer_lang. The server never
    // re-detects once a value is saved.
    status_note: s?.status_note ?? "",
    status_expires_at: s?.status_expires_at ?? null,
    answer_lang: s?.answer_lang ?? "",
    answer_lang_default: COUNTRY_LANG[String((req as any).cf?.country ?? "").toUpperCase()] ?? "en",
    // F2: customizable greeting — preset id + festival auto-greeting toggle.
    greeting_style: s?.greeting_style ?? "",
    festival_greeting: !!(s?.festival_greeting),
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
  // P12 (OWNER DECISION 2026-07-02): Ava has exactly ONE canonical female voice,
  // for life. Users can NEVER choose it. Silently STRIP any client-supplied
  // voice_name (don't error an old client) and pin to AVA_VOICE.
  void VOICES; // retained as the canonical Gemini voice list; Ava's is pinned below
  const voice = AVA_VOICE;
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

  // F1: status note + expiry + default answering language.
  await ensureStatusColumns(env);
  const statusNote = b.status_note == null ? null : String(b.status_note).slice(0, MAX_STATUS_NOTE).trim() || null;
  let statusExpiresAt: number | null = null;
  if (b.status_expires_at != null && Number(b.status_expires_at) !== 0) {
    const t = Math.trunc(Number(b.status_expires_at));
    if (t > Date.now() + STATUS_MAX_TTL_MS) {
      return json({ error: "expiry_too_far", message: "A note can expire at most a year from now." }, 400);
    }
    if (t > 0) statusExpiresAt = t; // past/invalid → treated as no-expiry-set (null)
  }
  let answerLang: string | null = b.answer_lang == null ? null : String(b.answer_lang).trim();
  if (answerLang && !LANG_CODES.has(answerLang)) answerLang = null; // unknown → auto-detect

  // F2: greeting style (validated against GREETING_PRESETS) + festival toggle. An
  // unknown style is coerced to null so a bad value can never reach a live call.
  let greetingStyle: string | null = b.greeting_style == null ? null : String(b.greeting_style).trim();
  if (greetingStyle && !(greetingStyle in GREETING_PRESETS)) greetingStyle = null;
  const festivalGreeting = b.festival_greeting === true || b.festival_greeting === 1 ? 1 : 0;

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
        status_note, status_expires_at, answer_lang,
        greeting_style, festival_greeting,
        created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?15,?16,?17,?18,?19,?14,?14)
     ON CONFLICT(owner_uid) DO UPDATE SET
       enabled=?2, instructions_text=?3, voice_name=?4, display_name=?5,
       persona_name=?6, language_code=?7, greeting_text=?8, custom_prompt=?9,
       answer_all=?10, status_preset=?11, status_custom=?12, decline_to_ava=?13,
       status_note=?15, status_expires_at=?16, answer_lang=?17,
       greeting_style=?18, festival_greeting=?19,
       updated_at=?14`,
  ).bind(ctx.uid, enabled ? 1 : 0, instr, voice, display,
    persona, language, greeting, customPrompt,
    answerAll, statusPreset, statusCustom, declineToAva, now,
    statusNote, statusExpiresAt, answerLang,
    greetingStyle, festivalGreeting).run();
  // F1 telemetry.
  const ttlBucket = statusExpiresAt == null ? "never"
    : (() => { const d = statusExpiresAt - Date.now();
        return d <= 16 * 60_000 ? "15m" : d <= 31 * 60_000 ? "30m" : d <= 61 * 60_000 ? "1h" : d <= 4.1 * 3600_000 ? "4h" : "custom"; })();
  track(env, ctx.uid, "recept_status_saved", APP, { has_expiry: statusExpiresAt != null, ttl_bucket: ttlBucket, has_note: !!statusNote });
  if (answerLang) track(env, ctx.uid, "recept_lang_set", APP, { lang: answerLang, source: b.answer_lang_source === "detected" ? "detected" : "user" });
  // F2: greeting telemetry — stamped with the owner's email/phone so support can
  // pull it by contact. Emitted on every save so both set and cleared are visible.
  const greetContact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  trackUserContact(env, ctx.uid, greetContact.email, greetContact.phone, "receptionist_greeting_saved", APP,
    { style: greetingStyle ?? "none", festival: festivalGreeting === 1, answer_lang: answerLang ?? "auto" });

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
    voice_name: AVA_VOICE, // P12: pinned — stored custom voice is overridden
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

  // CALLFIX-8 / CALL-KV-STATE-1: check if the call was already answered by the
  // callee. The CallRoom DO is now the sole authority (strongly consistent) — ask
  // it first via GET /state. KV (`call_answered:<callId>`) is a transitional
  // read-fallback ONLY, kept for ONE release; REMOVE the KV branch once the Call
  // FSM (CALL-FSM-1) lands and this becomes a straight FSM-state check.
  const callId = b.call_id == null ? null : String(b.call_id).slice(0, 64);
  if (callId) {
    let answered = false;
    try {
      const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
      const r = await stub.fetch("https://call/state", { method: "GET" });
      if (r.ok) {
        const st = (await r.json()) as { answered?: boolean };
        answered = st.answered === true;
      }
    } catch { /* DO probe failed — fall through to KV fallback below */ }
    if (!answered) {
      // CALL-KV-STATE-1 dual-read fallback — delete with the KV dual-write.
      const kv = await env.TOKENS.get(`call_answered:${callId}`).catch(() => null);
      answered = kv === "true";
    }

    // CONTROL-PLANE AUTHORITY shadow check (§3, §8B): ask the OWNER's authority
    // whether it independently thinks this call is answered/preempted, and
    // record the legacy-vs-authority divergence. Best-effort, flag-gated,
    // fail-open — a slow/erroring authority NEVER blocks or changes this route
    // unless authorityEnforced is on AND the authority agrees a preempt/connect
    // happened, in which case we align with the EXISTING `answered` suppression
    // path below (no new suppression path is introduced).
    if (authorityEnabled(cfg)) {
      try {
        const [queryRes, preemptRes] = await Promise.all([
          authorityQuery(env, to),
          authorityPreemptForCallback(env, to, { caller: ctx.uid, call_id: callId }),
        ]);
        const authorityPhase = (queryRes?.phase as string | undefined) ?? null;
        const authorityDecision = (preemptRes?.decision as string | undefined) ?? null;
        const authoritySaysConnected =
          authorityPhase === "connected" || authorityPhase === "connecting";
        const authoritySaysPreempted =
          authorityDecision === "preempt" || authorityDecision === "busy";
        const authorityVerdict = authoritySaysConnected || authoritySaysPreempted;
        void shadowRecord(env, to, "authority_shadow_decision", {
          call_id: callId,
          owner: to,
          caller: ctx.uid,
          stage: "receptionist_start_answered_check",
          legacy_answered: answered,
          authority_phase: authorityPhase,
          authority_decision: authorityDecision,
          authority_verdict: authorityVerdict,
          diverged: answered !== authorityVerdict,
          enforced: cfg.authorityEnforced === true,
        });
        if (cfg.authorityEnforced === true && authorityVerdict && !answered) {
          // Authority is the enforced source of truth and disagrees with legacy
          // (legacy said "not answered" but authority says connected/preempted):
          // align by reusing the EXISTING answered-suppression path below.
          answered = true;
        }
      } catch { /* fail-open — legacy `answered` value stands unchanged */ }
    }

    if (answered) {
      trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_aborted_answered", APP,
        { owner: to, call_id: callId, stage: "scheduled" });
      return json({ error: "receptionist_unavailable", reason: "call_answered" }, 409);
    }
  }

  // RECEPT-REATTACH-1: idempotency — AT MOST ONE receptionist session per call_id.
  // Multiple caller-side triggers can hit /start for the SAME call (no-answer
  // timeout + a 'busy' status push + our own 'cancel' echo, all within a couple of
  // seconds). Before this guard, a second /start spawned a SECOND ReceptionRoom on
  // the same call — Ava restarted her greeting from scratch, producing two
  // recordings, two posted messages, and TWO ava_recept_cost billing events for one
  // call (PostHog avatok-14739b84, 2026-07-03 18:39). We claim the call_id in KV on
  // the first /start (first-write-wins via a compare-after-put race check); a second
  // /start for the same call_id is a NO-OP that emits ava_recept_reattach_blocked and
  // returns the already-active session so the caller stays on it (never restarts).
  // Keyed per (call_id, caller, owner) so an unrelated later call can't be blocked;
  // TTL bounds it to the ~90s call life so a crashed session never wedges the id.
  const REATTACH_LOCK_TTL = 120; // sec — covers the 90s hard cap + slack
  const reattachKey = callId ? `recept_call:${callId}:${ctx.uid}:${to}` : null;
  if (reattachKey) {
    const existing = await env.TOKENS.get(reattachKey).catch(() => null);
    if (existing) {
      trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_reattach_blocked", APP,
        { owner: to, call_id: callId, stage: "server", existing_sid: existing });
      // Not an error to the client: a session is already live for this exact call,
      // so the caller's app keeps talking to the FIRST session. Return the existing
      // session id (the RTC token/url are single-use and already consumed by the
      // first leg, so we do NOT hand out a second WS — the client treats a 409
      // no-op reattach as "stay on the session you have").
      return json({ error: "receptionist_unavailable", reason: "reattach_blocked", session_id: existing }, 409);
    }
  }

  // CONTROL-PLANE AUTHORITY (shadow/read/write, §3): the receptionist session
  // for `to` (the OWNER) IS going to start at this point — legacy logic has
  // already decided so above this line. Best-effort, flag-gated, fail-open:
  // move the OWNER's authority to RECEPTIONIST_ACTIVE with receptionist_target
  // = the CALLER's uid. On ANY failure/timeout/flag-off this is a pure no-op —
  // it can never block or alter the legacy start below.
  if (authorityEnabled(cfg)) {
    try {
      const acquireRes = await authorityAcquire(env, to, {
        peer: ctx.uid,
        call_id: callId || "",
        direction: "in",
        rtc_provider: "unknown",
      });
      await authorityTransition(env, to, {
        to: "receptionist_active",
        reason: "receptionist_start",
        // receptionist_target_uid: the DO's current /transition handler does not
        // persist this field yet (only /preempt-callback sets it) — passed here so
        // the DO can start honoring it once wired, without another call-site change.
        ...( { receptionist_target_uid: ctx.uid } as Record<string, unknown> ),
      });
      void acquireRes; // shadow-only for now; never read for a legacy decision here
    } catch { /* fail-open — legacy start proceeds unaffected */ }
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
  // F2: the owner's customizable opening phrase — a validated preset ("Namaste",
  // "Jai Shree Ram", …), the free-text custom greeting, or (when festival greetings
  // are on and today matches) a festival greeting like "Merry Christmas". Empty when
  // the owner hasn't set one — the call then opens plainly, exactly as before.
  // Composed here: "<phrase> <FirstName>, <owner> can't take the call…".
  const greetPhrase = resolveGreetingPhrase(s);
  const greetPrefix = greetPhrase
    ? (firstName ? `${greetPhrase} ${firstName}, ` : `${greetPhrase}, `)
    : (firstName ? `Hey ${firstName}, ` : `Hi, `);
  const greeting = `${greetPrefix}${ownerLabel} can't take the call right now — leave a message of about 25 seconds and ${gSubj}'ll get back to you.`;
  // (callId already declared above in the CALLFIX-8 answered-guard block)
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
    voice_name: useCf ? AVA_CF_VOICE : AVA_VOICE, // P12: Gemini path pinned to Ava's one voice
    language_code: s.language_code || null,       // v2: DO pins speechConfig.languageCode
    activation_mode: activationMode,              // v2: telemetry context for the DO
    file_search_store: s.file_search_store || null,
    // Caller-aware + status-aware system prompt: "Hi <caller>, <owner> is
    // travelling/busy. Can I take a message?" — composed server-side, locked.
    system_prompt: composeReceptionistPrompt(s, { callerName, activationMode, ownerName, gender: ownerGender, engine: useCf ? "cf" : "gemini", timeOfDay: timeOfDayWord((req as any)?.cf?.timezone), greeting }),
    owner_name: ownerName,
    ava_name: (s.persona_name || "Ava").trim() || "Ava", // transcript speaker label

    // engine: "cf" → the WS routes to ReceptionRoomCf (Workers AI); else Gemini.
    engine: useCf ? "cf" : "gemini",
    cf_voice: useCf ? AVA_CF_VOICE : null,
    greeting,                                     // CF engine speaks this immediately (no LLM)
    model: useCf ? "cf-workers-ai" : ((env as any).RECEPTIONIST_MODEL || RECEPTIONIST_MODEL_DEFAULT),
    soft_cap_ms: SOFT_CAP_MS, hard_cap_ms: HARD_CAP_MS,
    wrap_cue_ms: WRAP_CUE_AT_MS, // P2: relay injects the wrap cue here (once)
    started_at: now,
  };
  await env.TOKENS.put(`recept_rtc:${sid}`, JSON.stringify(init), { expirationTtl: INIT_TTL_SEC });

  // RECEPT-REATTACH-1: claim this call_id so any LATER /start for the same call is
  // rejected as a reattach (see the guard near the top of this handler). Best-effort
  // first-write-wins: KV isn't strongly consistent, so after writing we read back —
  // if another concurrent /start already claimed it with a DIFFERENT sid, we yield
  // to that one (mark our just-created session superseded) and let the caller reattach
  // to the winner rather than run two Ava sessions on one call.
  if (reattachKey) {
    try {
      const prior = await env.TOKENS.get(reattachKey);
      if (prior && prior !== sid) {
        // Lost the race — another /start claimed this call first. Tear down our
        // just-created (unused) session and hand the caller the winner.
        try {
          await metaDb(env).prepare(
            "UPDATE receptionist_sessions SET status='ended', ended_at=?2, cutoff_reason='reattach_superseded', updated_at=?2 WHERE id=?1",
          ).bind(sid, now).run();
        } catch { /* best-effort */ }
        await env.TOKENS.delete(`recept_rtc:${sid}`).catch(() => {});
        trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_reattach_blocked", APP,
          { owner: to, call_id: callId, stage: "server_race", existing_sid: prior });
        return json({ error: "receptionist_unavailable", reason: "reattach_blocked", session_id: prior }, 409);
      }
      if (!prior) await env.TOKENS.put(reattachKey, sid, { expirationTtl: REATTACH_LOCK_TTL });
    } catch { /* best-effort: the client-side _receptionistActive guard is the backstop */ }
  }

  // Stamp the caller's email/phone so support can pull a complainant's
  // receptionist calls by contact. trace_id = the session id (one-call trace).
  // (caller contact was resolved once above and reused here.)
  // F1: is a status note actually in force for this call, and in what language?
  const statusActive = !!(s.status_note && (s.status_expires_at == null || Number(s.status_expires_at) > now));
  trackUserContact(env, ctx.uid, caller.email, caller.phone, "ava_recept_triggered", APP,
    { owner: to, has_phone: !!callerPhone, call_id: callId, activation_mode: activationMode,
      answer_lang: s.answer_lang || null, status_note_active: statusActive }, sid);
  if (statusActive) track(env, to, "recept_status_used_in_call", APP, { call_id: callId });
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

  // CONTROL-PLANE AUTHORITY (§3): the receptionist session is finalizing —
  // best-effort return the OWNER's authority to idle. Flag-gated, fail-open:
  // never blocks or affects the response to the caller either way.
  try {
    const cfg = await readConfig(env);
    if (authorityEnabled(cfg) && s.owner_uid) {
      await authorityAbandonReceptionist(env, String(s.owner_uid), { reason: `receptionist_finish:${reason}` });
      await authorityRelease(env, String(s.owner_uid), { reason: `receptionist_finish:${reason}` });
    }
  } catch { /* fail-open — finalize response below is unaffected */ }

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
