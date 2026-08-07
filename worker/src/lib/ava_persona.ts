// ava_persona.ts — [AVA-VOICE-STYLE-1] / WS-14. ONE place that decides how Ava
// SOUNDS, for every user-facing chat lane.
//
// Owner decision, 2026-08-07: Ava speaks fun Hinglish Gen-Z BY DEFAULT
// ("hold karo, mein 2K la raha hoon"), changeable in Ava's settings. India is
// the only market.
//
// WHY THIS FILE EXISTS
// Before this, every lane inlined its own system prompt (~10 of them:
// do/ava_agent.ts buildPrompt, composio.ts's two loops, ava_gemini.ts
// SYSTEM_BASE, ava_delegate.ts, receptionist, copilot, compose, user_brain).
// Changing Ava's voice meant editing ten prompts and missing three. Now every
// lane appends ONE styleClause().
//
// THE VOCABULARY IS SHARED, NOT NEW
// `AvaVoiceStyle` deliberately reuses ava_templates.ts's `TemplateLang`
// ("en" | "hi" | "hinglish") and adds one extra member, "auto". One vocabulary,
// two consumers: the LLM lanes (styleClause) and the zero-AI Reply Template
// Bank (templateLangFor → TEMPLATE_BANK). Do NOT invent a second enum.
//
// WHY THE CONFIG KEY IS A NUMBER
// `avaVoiceStyleDefault` is declared in routes/config.ts as a NUMBER
// (PlatformConfig + DEFAULTS + numericKeys) and is set to 2 in production KV.
// That is not a style choice — `putConfig` only accepts `number` and `boolean`,
// so a STRING config key is impossible today. The enum is therefore:
//
//     0 = en   1 = hi   2 = hinglish   3 = auto        (styleFromCode/styleToCode)
//
// The D1 row and the HTTP API use the readable STRING form; only the config
// default is numeric. Do not "tidy" the config key into a string — it will 400.

import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { guessLang, type TemplateLang } from "./ava_templates";

// ─────────────────────────────────────────────────────────────────────────────
// The enum
// ─────────────────────────────────────────────────────────────────────────────

/** How Ava speaks. Superset of ava_templates.ts's TemplateLang by exactly one
 *  member, "auto" (mirror whatever language the user just wrote in). */
export type AvaVoiceStyle = TemplateLang | "auto";

/** A style with "auto" already resolved — what the prompt/string layers see. */
export type ResolvedVoiceStyle = TemplateLang;

/** Canonical order. The index IS the numeric config code — see styleFromCode. */
export const AVA_VOICE_STYLES: readonly AvaVoiceStyle[] = ["en", "hi", "hinglish", "auto"] as const;

/** Ships-with default when neither the user nor prod KV has an opinion. */
export const AVA_VOICE_STYLE_FALLBACK: AvaVoiceStyle = "hinglish";

/** Human labels for the settings UI (the client may localise its own copy). */
export const AVA_VOICE_STYLE_LABELS: Record<AvaVoiceStyle, string> = {
  en: "English",
  hi: "हिंदी (Hindi)",
  hinglish: "Hinglish (Gen-Z)",
  auto: "Auto — match my language",
};

/** number code → style. Anything unrecognised → the fallback (never throws). */
export function styleFromCode(n: unknown): AvaVoiceStyle {
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i < AVA_VOICE_STYLES.length
    ? AVA_VOICE_STYLES[i]
    : AVA_VOICE_STYLE_FALLBACK;
}

/** style → number code (the form `avaVoiceStyleDefault` stores). */
export function styleToCode(s: AvaVoiceStyle): number {
  const i = AVA_VOICE_STYLES.indexOf(s);
  return i >= 0 ? i : AVA_VOICE_STYLES.indexOf(AVA_VOICE_STYLE_FALLBACK);
}

/** Accept either wire form (string "hinglish" or number 2). Returns null when
 *  the value is not a valid style — callers decide whether that is a 400 or a
 *  silent fallback. */
export function normalizeStyle(v: unknown): AvaVoiceStyle | null {
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()))) {
    const i = Number(v);
    return Number.isInteger(i) && i >= 0 && i < AVA_VOICE_STYLES.length ? AVA_VOICE_STYLES[i] : null;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return (AVA_VOICE_STYLES as readonly string[]).includes(s) ? (s as AvaVoiceStyle) : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt clause
// ─────────────────────────────────────────────────────────────────────────────

// One sentence-per-line so a diff shows exactly which rule changed. Pattern
// copied from routes/ava_live.ts's `Always speak to the user in ${langName}.`
// — a short, unambiguous, appended instruction rather than a rewritten persona.
const CLAUSES: Record<AvaVoiceStyle, string> = {
  en:
    "VOICE: Reply in natural, friendly English. Keep it warm and concise.",
  hi:
    "VOICE: Hindi mein hi reply karo — Devanagari script (हिंदी) use karo, Roman nahi. " +
    "Warm aur short rakho. Technical terms, app labels, names, brands aur numbers ko translate mat karo — " +
    "unhe waise hi rehne do.",
  hinglish:
    "VOICE: Speak fun, casual Hinglish the way young Indians actually text — Roman-script Hindi mixed " +
    "with English, e.g. \"hold karo, mein 2K la raha hoon\" or \"ho gaya! dekh lo\". " +
    "Be warm, playful and SHORT. " +
    "Rules: use Roman script only, never Devanagari. " +
    "Never translate names, brands, numbers, currency amounts, links, code, or app/UI labels — leave those exactly as they are. " +
    "One or two Hindi words per sentence is enough; do not force slang into every clause, and never sound like a caricature. " +
    "If the user writes to you in pure English or pure Hindi, you may follow their lead for that reply.",
  auto:
    "VOICE: Mirror the user's own language and script in your reply — if they write English, reply in " +
    "English; Hinglish, reply in Hinglish; Hindi in Devanagari, reply the same way. Keep it warm and concise.",
};
// CLAUSES intentionally carries the "auto" key too: styleClause accepts the full
// AvaVoiceStyle so a lane with no user text to sniff can pass "auto" straight to
// the model and let IT mirror the user, rather than guessing on the server.

/**
 * The single line every lane appends to its own system prompt.
 *
 * Deliberately additive: it never replaces a lane's persona (the delegate lane's
 * "do not pretend to be ${who}" safety rules, the tool lane's untrusted-data
 * boundary, etc. must all survive). Append it LAST so it is the most recent
 * instruction the model sees.
 */
export function styleClause(style: AvaVoiceStyle | null | undefined): string {
  const s = style ?? AVA_VOICE_STYLE_FALLBACK;
  return (CLAUSES as Record<string, string>)[s] ?? CLAUSES.en;
}

/** Resolve "auto" against the user's own text. Everything else passes through. */
export function resolveStyle(style: AvaVoiceStyle, userText?: string): ResolvedVoiceStyle {
  if (style !== "auto") return style;
  return guessLang(String(userText ?? ""));
}

/**
 * Which TEMPLATE_BANK language to use — the WS-14b "preference overrides
 * guessLang" rule, in one place.
 *
 * ⚠️ ava_odl.ts previously ALWAYS sniffed the incoming message. Now: an explicit
 * style wins; only "auto" falls back to guessLang(text). Because the prod
 * default is `hinglish`, a user who has never opened the setting gets Hinglish
 * templates — which IS the owner's intent, not a bug.
 */
export function templateLangFor(style: AvaVoiceStyle, text?: string): TemplateLang {
  return resolveStyle(style, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Canned strings — WS-14e
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ This is NOT an i18n framework and must not grow into one. The app has no
// flutter_localizations, no intl and no ARB files; building that is a much
// larger project (see WS-14e). This is a small table of the handful of strings
// a user sees on EVERY Ava turn, keyed by (id, style). Add an entry only when
// the string is high-frequency and user-visible. Long-tail copy stays inline.

export type AvaStringId =
  /** The status pill above an in-progress turn. do/ava_agent.ts posts this ~15×
   *  inline; that file is owned by another agent — it should call avaString()
   *  once and reuse the result for BOTH the 'start' and 'end' postStatus calls
   *  (the label must match, or the client cannot close its own chip). */
  | "chip_working"
  /** routes/ava_image.ts chipLabel (also another agent's file). This is the
   *  string that surfaces verbatim in the client's job card
   *  (ai_media_job_card.dart renders job.label) — i.e. the literal
   *  "hold karo, mein 2K la raha hoon" moment the owner asked for. */
  | "chip_image_generating"
  | "chip_image_editing"
  /** WS-10 rendition upgrade (preview → full). The owner's own example line. */
  | "chip_image_upscaling"
  | "chip_inbox"
  | "chip_schedule"
  | "err_generic"
  | "err_unavailable"
  | "err_image_start"
  | "err_out_of_tokens";

/** id → resolved style → copy. "auto" resolves to en (we cannot know the
 *  language of a string emitted before the user has said anything). */
export const AVA_STRINGS: Record<AvaStringId, Record<ResolvedVoiceStyle, string>> = {
  chip_working: {
    en: "Ava is working…",
    hi: "अवा काम कर रही है…",
    hinglish: "Ava kaam kar rahi hai…",
  },
  chip_image_generating: {
    en: "Ava is generating an image…",
    hi: "अवा इमेज बना रही है…",
    hinglish: "Hold karo, image bana rahi hoon…",
  },
  chip_image_editing: {
    en: "Ava is editing your image…",
    hi: "अवा आपकी इमेज एडिट कर रही है…",
    hinglish: "Hold karo, image edit kar rahi hoon…",
  },
  chip_image_upscaling: {
    en: "Ava is bringing the full-res version…",
    hi: "अवा फुल क्वालिटी वर्ज़न ला रही है…",
    hinglish: "Hold karo, mein 2K la rahi hoon…",
  },
  chip_inbox: {
    en: "Ava is checking your inbox…",
    hi: "अवा आपका इनबॉक्स देख रही है…",
    hinglish: "Ava inbox check kar rahi hai…",
  },
  chip_schedule: {
    en: "Ava is checking your schedule…",
    hi: "अवा आपका शेड्यूल देख रही है…",
    hinglish: "Ava schedule dekh rahi hai…",
  },
  err_generic: {
    en: "Something went wrong on my side. Please try again.",
    hi: "मेरी तरफ़ से कुछ गड़बड़ हो गई। दोबारा कोशिश करें।",
    hinglish: "Arre, meri side se kuch gadbad ho gayi. Ek baar phir try karo.",
  },
  err_unavailable: {
    en: "Ava is temporarily unavailable.",
    hi: "अवा अभी उपलब्ध नहीं है।",
    hinglish: "Ava abhi thodi der ke liye unavailable hai.",
  },
  err_image_start: {
    en: "I couldn't start that image right now.",
    hi: "अभी वह इमेज शुरू नहीं कर पाई।",
    hinglish: "Abhi wo image start nahi kar paayi.",
  },
  err_out_of_tokens: {
    // ⚠️ The unit is a TOKEN and the symbol is ₹ (owner decision 2026-08-05).
    // Never "coin", never "$" for a wallet amount.
    en: "You're out of tokens. Top up your wallet to keep using Ava.",
    hi: "आपके टोकन ख़त्म हो गए हैं। अवा चलाते रहने के लिए वॉलेट टॉप-अप करें।",
    hinglish: "Tokens khatam ho gaye. Wallet top-up karo, phir chalu karte hain.",
  },
};

/** Look up a canned string in the caller's style. Falls back to English for any
 *  unknown id/style combination — never returns undefined. */
export function avaString(id: AvaStringId, style: AvaVoiceStyle | null | undefined, userText?: string): string {
  const row = AVA_STRINGS[id];
  if (!row) return "";
  const s = resolveStyle(style ?? AVA_VOICE_STYLE_FALLBACK, userText);
  return row[s] ?? row.en;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the user's preference — the HOT PATH read
// ─────────────────────────────────────────────────────────────────────────────
//
// Storage lives here (not in the route file) so `lib/` code — composio.ts's two
// agent loops, ava_odl.ts, do/ava_agent.ts — can import it WITHOUT importing a
// route module. routes/ava_voice_style.ts is the thin HTTP wrapper on top.
//
// Shape copied verbatim from routes/auto_responder.ts's readAutoResponderConfig:
// KV mirror first (single fast get on the turn path), D1 fallback that warms the
// mirror, and a platform-config default underneath. Never throws.

/** KV mirror key. Namespaced per uid → parent and each child account on a shared
 *  phone are fully isolated (Rulebook per-account scoping). */
const KV_PREFIX = "avast:style:";

/** D1 table (DB_META) — see worker/migrations/2026-08-07-ava-voice-style.sql. */
const TABLE = "ava_voice_style_settings";

/** The platform default (prod KV override on `avaVoiceStyleDefault`, else
 *  DEFAULTS in routes/config.ts, which is 2 = hinglish).
 *
 *  ⚠️ Never state this value from reading config.ts — DEFAULTS is only the
 *  bottom layer and prod KV sits on top (CLAUDE.md). This function reads the
 *  layered value, which is the only correct one. */
export async function defaultVoiceStyle(env: Env): Promise<AvaVoiceStyle> {
  try {
    const cfg = await readConfig(env);
    return styleFromCode((cfg as any).avaVoiceStyleDefault);
  } catch {
    return AVA_VOICE_STYLE_FALLBACK;
  }
}

/**
 * The user's Ava voice style. **This is the function to fold into a turn's
 * `Promise.all`** — it takes only (env, uid), never throws, and costs one KV
 * get in the steady state.
 *
 *   const [style, …] = await Promise.all([readVoiceStyle(env, uid), …]);
 *   const sys = buildPrompt(…) + "\n\n" + styleClause(style);
 */
export async function readVoiceStyle(env: Env, uid: string): Promise<AvaVoiceStyle> {
  if (!uid) return await defaultVoiceStyle(env);
  try {
    const kv = await env.TOKENS.get(KV_PREFIX + uid);
    const s = normalizeStyle(kv);
    if (s) return s;
  } catch { /* fall through to D1 */ }
  try {
    const r = await env.DB_META.prepare(
      `SELECT style FROM ${TABLE} WHERE uid=?1`,
    ).bind(uid).first<{ style?: unknown }>();
    const s = r ? normalizeStyle(r.style) : null;
    if (s) {
      // Warm the mirror so the next hot-path read is a KV hit.
      try { await env.TOKENS.put(KV_PREFIX + uid, s); } catch { /* best-effort */ }
      return s;
    }
  } catch { /* no row / table not migrated yet → platform default */ }
  return await defaultVoiceStyle(env);
}

/** Convenience for a lane that only wants the prompt line. Same cost as
 *  readVoiceStyle — use readVoiceStyle directly if you also need the value. */
export async function readStyleClause(env: Env, uid: string): Promise<string> {
  return styleClause(await readVoiceStyle(env, uid));
}

/** Internal: used by routes/ava_voice_style.ts to write both stores. Exported
 *  from here so the KV key and table name have exactly ONE definition. */
export async function writeVoiceStyle(env: Env, uid: string, style: AvaVoiceStyle): Promise<void> {
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO ${TABLE} (uid, style, updated_at) VALUES (?1,?2,?3)
       ON CONFLICT(uid) DO UPDATE SET style=?2, updated_at=?3`,
  ).bind(uid, style, now).run();
  // Mirror AFTER D1 so a mirror failure degrades to a D1 read, never the reverse.
  try { await env.TOKENS.put(KV_PREFIX + uid, style); } catch { /* best-effort */ }
}

/** Internal: clear a user's preference so they follow the platform default
 *  again. Used by PUT with {style:"default"} and by the deletion sweep. */
export async function clearVoiceStyle(env: Env, uid: string): Promise<void> {
  try { await env.DB_META.prepare(`DELETE FROM ${TABLE} WHERE uid=?1`).bind(uid).run(); } catch { /* best-effort */ }
  try { await env.TOKENS.delete(KV_PREFIX + uid); } catch { /* best-effort */ }
}
