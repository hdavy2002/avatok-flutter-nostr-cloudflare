// AI listing composition — the server-owned conversational compose state machine.
// Spec: Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md §3.1–§3.7, §7.1.
// Tables in DB_META (avatok-meta): listing_compose_sessions, listing_compose_turns,
// listings, listing_categories. user_media lives in DB_MEDIA.
//
// ROUTES TO REGISTER (index.ts — I do not wire these; the owner does):
//
//   POST /api/marketplace/compose/session   → composeSession(req, env)
//     Opens a compose session and, separately, OFFERS a resume of the newest session
//     the user actually said something to. NOT cached — it is per-user state and
//     reports the caller's identity gate state.
//
//   POST /api/marketplace/compose/turn      → composeTurn(req, env)
//     SSE (text/event-stream). One conversational turn. Follows the ava_gemini
//     precedent (ava_gemini.ts:342) — `data: {...}` frames, terminated `data: [DONE]`.
//
//   POST /api/marketplace/compose/publish   → composePublish(req, env)
//     The ONLY path that creates a live listing. An explicit USER action.
//
// All three are gated on `aiComposeEnabled` (default false) → 503 {reason:"flag_off"},
// matching liveness_v3.ts:243.
//
// ── THE ONE ARCHITECTURAL RULE (§3.3) ────────────────────────────────────────
// **The LLM never holds the draft. The server does.** The model may only PROPOSE
// tool calls; this file validates every one against the category's pinned
// field_schema, writes the draft, and computes what is still missing. A malformed
// model turn loses a turn, never the user's work.
//
// **There is deliberately NO publish tool.** The model can only ask "shall I?".
// Publishing is a separate, explicit user action on a review card (composePublish).
// Do not add a publish tool — an LLM with one will eventually publish something
// nobody approved.
//
// ── HOW never_disclose IS KEPT FROM THE MODEL (§3.6b) ────────────────────────
// `never_disclose` is NEVER placed in any prompt. The only reliable way to stop a
// model saying something is to not tell it. Enforcement here is STRUCTURAL, not a
// polite instruction:
//   • it is stored in `draft.vault`, a sub-object no prompt builder reads;
//   • `promptView()` is an explicit WHITELIST — it constructs a fresh object and
//     copies named keys in. A blacklist would leak the next field someone adds;
//     a whitelist cannot. `vault` is simply never named there.
//   • `assertNoVaultLeak()` is a cheap last-resort tripwire before the gateway call.
// Constraints (floor_price, ask_before_commit) are enforced in CODE at the point
// they matter, not in prose — the marketplace.ts:551-555 precedent (a sub-floor
// "deal" is downgraded in SQL after the model has spoken).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession, mediaSession } from "../db/shard";
import { track, trackUser } from "../hooks";
import { readConfig } from "./config";
import { avaReason } from "../lib/ava_reason";
import { moderate } from "../lib/moderation";
import { guardWrite } from "./moderate";
import { brainIngest } from "../lib/brain_ingest";
// [AVA-MKT-ENTITLEMENTS-1] §5 quota + §1.3 token charge, consumed inside the publish
// keyed on listing_id (§3.3c). Same helper the classic publish path calls.
import { consumeListingEntitlement } from "../lib/listing_billing";
// [AVA-MKT-COMPOSE-ENRICH] §1.2/§6.1 — brain enrichment for the /session greeting. All
// four §6.1 gates + the "return null when there's nothing useful" degrade live INSIDE
// this helper; we only call it and warm the greeting when it returns non-null.
import { listingEnrichment, type ListingEnrichment } from "../lib/listing_enrichment";
import { gatePublicAction, livenessState, emailOf } from "../lib/identity_gate";
import {
  DEFAULT_VERTICAL, resolveCategoryVersion, validateAttrs,
  type FieldSchema, type ResolvedCategory,
} from "./categories";

const APP = "avamarketplace";
const SESSION_TTL_MS = 72 * 3_600_000;   // §3.3b — 72h, then the transcript is scratch
const MAX_TRANSCRIPT_TURNS = 20;         // §3.3
const COMPARABLE_WINDOW_MS = 180 * 86_400_000; // §3.5 — last 180 days
const MAX_TAGS = 8;
const CORS = { "access-control-allow-origin": "*" };

// ---------------------------------------------------------------------------
// §3.1 — the approved, version-pinned verification copy
// ---------------------------------------------------------------------------

/**
 * The APPROVED answer to "why should I verify my face", verbatim from §3.1.
 *
 * This is a CANNED, server-side response keyed on intent — NOT free LLM
 * improvisation. An LLM riffing on biometric consent will eventually say something
 * legally wrong, and BIPA §15(b) consent copy is version-pinned for exactly this
 * reason (`biometricConsentVersion`, config.ts). Localisation TRANSLATES this text;
 * it never regenerates it (see `localiseApproved`).
 *
 * Do not edit this string to "improve the tone". It is legal copy.
 */
const APPROVED_WHY_VERIFY =
  "Fair question. Anyone can type a name into a box — a face check means there's a " +
  "real person behind this listing. It's what stops the scam and fake-ad problem that " +
  "wrecks every open marketplace, and it's what our payment and safety obligations " +
  "require of us. It takes about 20 seconds, we don't post it anywhere, and it's " +
  "handled by Didit, not stored by us. Want to do it now?";

/**
 * Cheap, deterministic intent classifier for the pushback case (§3.1).
 *
 * Deliberately a regex and not a model call: this decides whether to emit
 * VERSION-PINNED LEGAL COPY, so it must be inspectable, testable and free of the
 * failure mode it exists to prevent. A false negative is harmless (the normal loop
 * answers); a false positive just shows the approved paragraph.
 */
function isWhyVerifyQuestion(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const aboutVerification =
    /\b(verif\w*|liveness|face\s*(check|scan|id)?|selfie|kyc|id\s*check|didit|biometric\w*)\b/.test(t);
  if (!aboutVerification) return false;
  const isChallenge =
    /\b(why|whats?\s+the\s+point|what\s+for|how\s+come|do\s+i\s+(have|need)|must\s+i|refuse|won'?t|not\s+doing|no\s+way|creepy|privacy|safe|secure|store|storing|sell(ing)?\s+my)\b/.test(t) ||
    /\?/.test(t);
  return isChallenge;
}

/**
 * Localise the APPROVED text by TRANSLATING it — never by regenerating it (§3.1).
 * The system prompt forbids adding, removing or rephrasing; on any failure we
 * return the English approved text rather than a model's improvisation.
 */
async function localiseApproved(env: Env, uid: string, text: string, lang: string): Promise<string> {
  const l = String(lang || "en").toLowerCase();
  if (!l || l === "en" || l.startsWith("en-")) return text;
  try {
    const out = await avaReason(env, {
      role: "marketplace", capability: "compose_localise_legal_copy", trigger: "compose_turn",
      verb: "reason", feature: "compose", uid,
      system:
        "You are a translator. Translate the user's text into the target language EXACTLY. " +
        "Do NOT add, remove, soften, summarise, explain or rephrase anything. Preserve every " +
        "claim and the meaning precisely. Output ONLY the translated text, no commentary.",
      user: `Target language code: ${l}\n\nText:\n${text}`,
      maxTokens: 400, temperature: 0,
    });
    const s = String(out ?? "").trim();
    return s.length ? s : text;
  } catch {
    return text; // approved English beats an improvised localisation
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface ComposeMandate {
  /** Reaches the model, reaches the buyer freely (§3.6b). */
  public_agent_brief?: string;
  /** Reaches the model; never shown to the buyer. Keep this THIN. */
  seller_private_rules?: string;
  agent_lang?: string;
  tone?: string;
  must_haves?: string;
}

/**
 * Fields the model must NEVER see. Structurally separated — see the file header.
 * `promptView()` never names this key, so nothing added here can reach a prompt.
 */
export interface ComposeVault {
  /** §3.6b — stripped before the prompt. Not "asked nicely"; simply not sent. */
  never_disclose?: string;
}

/** Server-enforced constraints — CODE, not prose (§3.6b). */
export interface ComposeConstraints {
  floor_price?: number;
  ask_before_commit?: boolean;
}

export interface ComposeCore {
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
  country?: string;
  location?: string;
}

export interface ComposeVideo {
  video_id: string;
  video_url: string;
  title: string | null;
  thumbnail: string | null;
}

/** The accumulating listing. Persisted as `draft_json`; owned by the SERVER. */
export interface ComposeDraft {
  core: ComposeCore;
  attrs: Record<string, unknown>;
  tags: string[];
  media: string[];              // user_media ids (content-addressed → idempotent)
  cover_media: string | null;
  video: ComposeVideo | null;
  mandate: ComposeMandate;
  constraints: ComposeConstraints;
  vault: ComposeVault;          // NEVER read by any prompt builder
  expiry_days: number | null;
  proposed_category: string | null;
  lang: string;
  /**
   * §2.0 — the vertical this session is composing into. It lives in the draft rather
   * than in a column because `listing_compose_sessions` has no `vertical` column and
   * this file does not own the migration. It is server-written (from the session-open
   * request, validated against the taxonomy), never model-writable: `set_category`
   * validates the chosen id against THIS vertical, and publish files the listing into
   * it — "a listing never crosses verticals".
   */
  vertical: string;
}

interface SessionRow {
  session_id: string;
  uid: string;
  listing_id: string | null;
  category: string | null;
  cat_version: number;
  lang: string | null;
  draft_json: string;
  transcript: string;
  turn_seq: number;
  rev: number;
  status: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

type TranscriptTurn = { role: "user" | "ava"; text: string };

/**
 * One SSE frame on the wire.
 *
 * The `draft` frame carries the server's authoritative post-turn state: `rev` and
 * `turn_seq` so the client knows what to send next, and — on a 409 `stale_session` —
 * `card`, so the client re-renders the current draft instead of clobbering it
 * (§3.3c: "a mismatch returns 409 stale_session WITH THE CURRENT DRAFT").
 */
type Event =
  | { t: "say"; text: string }
  | {
      t: "draft"; progress: number; missing: string[];
      rev?: number; turn_seq?: number; card?: Record<string, unknown>;
    }
  | { t: "chips"; chips: string[] }
  | { t: "review"; card: Record<string, unknown> }
  | { t: "error"; error: string; message?: string };

function emptyDraft(lang: string, vertical: string = DEFAULT_VERTICAL): ComposeDraft {
  return {
    core: {}, attrs: {}, tags: [], media: [], cover_media: null, video: null,
    mandate: {}, constraints: {}, vault: {},
    expiry_days: null, proposed_category: null, lang, vertical,
  };
}

function parseDraft(s: unknown, lang = "en"): ComposeDraft {
  const base = emptyDraft(lang);
  if (typeof s !== "string" || !s) return base;
  try {
    const p = JSON.parse(s) as Partial<ComposeDraft>;
    return {
      ...base, ...p,
      core: { ...base.core, ...(p.core ?? {}) },
      attrs: { ...(p.attrs ?? {}) },
      tags: Array.isArray(p.tags) ? p.tags : [],
      media: Array.isArray(p.media) ? p.media : [],
      mandate: { ...(p.mandate ?? {}) },
      constraints: { ...(p.constraints ?? {}) },
      vault: { ...(p.vault ?? {}) },
      // Sessions written before `vertical` existed in the draft parse as commerce —
      // which is what they were, since publish hard-coded DEFAULT_VERTICAL.
      vertical: typeof p.vertical === "string" && p.vertical.trim() ? p.vertical.trim() : base.vertical,
    };
  } catch { return base; }
}

function parseTranscript(s: unknown): TranscriptTurn[] {
  if (typeof s !== "string" || !s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? (p as TranscriptTurn[]).filter((t) => t && typeof t.text === "string") : [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// flag gate (§ plan table — `aiComposeEnabled`, default false)
// ---------------------------------------------------------------------------

/**
 * `aiComposeEnabled` is declared in DEFAULTS in routes/config.ts by the config owner.
 * Read through `any`: a flag the client reads but config.ts does not declare is a
 * FAKE flag (it can never be flipped — putConfig 400s on unknown keys), so this
 * MUST be paired with a real DEFAULTS entry. Unreadable config ⇒ OFF: this surface
 * writes durable public content, so the safe default is closed.
 */
async function composeEnabled(env: Env): Promise<boolean> {
  try {
    return (await readConfig(env) as any).aiComposeEnabled === true;
  } catch {
    return false;
  }
}

function flagOff(): Response {
  return json({ error: "compose disabled", reason: "flag_off" }, 503);
}

// ---------------------------------------------------------------------------
// PII redaction on write (§3.3b — "redaction on write, not on read")
// ---------------------------------------------------------------------------

/**
 * Regex-only contact strip for the TRANSCRIPT. Deliberately not a model call: this
 * runs on every persisted turn, and a 72-hour scratch buffer does not justify a
 * round-trip per turn. The publish path additionally runs the LLM redactor over the
 * description (`redactContact`), which is where obfuscated forms actually matter.
 */
function stripPiiFast(s: string): string {
  return String(s ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[removed]")
    .replace(/(?:\+?\d[\s().-]?){7,}\d/g, "[removed]");
}

/**
 * The publish-time PII strip — mirrors marketplacePrecheck (marketplace.ts:737) but
 * routed through the gateway (`avaReason`), not `callSonnet`. LLM beats regex on
 * "nine-eight-seven…" / "name [at] gmail dot com"; the regex backstop still runs, so
 * a slow or unavailable model degrades rather than blocks.
 */
async function redactContact(env: Env, uid: string, description: string): Promise<string> {
  const d = String(description ?? "");
  if (!d.trim()) return d;
  let cleaned = d;
  try {
    const out = await avaReason(env, {
      role: "marketplace", capability: "compose_pii_strip", trigger: "compose_publish",
      verb: "reason", feature: "compose", uid,
      system:
        "You redact contact details from marketplace text. Remove ALL phone numbers and email addresses, " +
        "including obfuscated forms (spelled-out digits, 'at'/'dot', spaces or unicode look-alikes). Keep " +
        "everything else exactly as written. Output ONLY the cleaned text, no commentary.",
      user: d, maxTokens: 400, timeoutMs: 8000, temperature: 0,
    });
    if (out && String(out).length > 0) cleaned = String(out);
  } catch { /* regex backstop below still runs */ }
  return stripPiiFast(cleaned);
}

// ---------------------------------------------------------------------------
// prompt construction — the never_disclose firewall (§3.6b)
// ---------------------------------------------------------------------------

/**
 * The ONLY view of the draft a prompt may see.
 *
 * An explicit WHITELIST: a fresh object with named keys copied in. This is the
 * enforcement mechanism for §3.6b — `vault` (never_disclose) is not named here, and
 * because this builds UP rather than deletes DOWN, a field added to ComposeDraft
 * tomorrow is excluded by default rather than leaked by default.
 *
 * `constraints` are included as VALUES the agent may know about (so it doesn't waste
 * the buyer's time) — they are separately enforced in code, which is what actually
 * makes them true.
 */
function promptView(d: ComposeDraft): Record<string, unknown> {
  return {
    core: {
      title: d.core.title ?? null,
      description: d.core.description ?? null,
      price: d.core.price ?? null,
      currency: d.core.currency ?? null,
      country: d.core.country ?? null,
      location: d.core.location ?? null,
    },
    attrs: d.attrs,
    tags: d.tags,
    photo_count: d.media.length,
    video: d.video ? { video_id: d.video.video_id, title: d.video.title } : null,
    mandate: {
      public_agent_brief: d.mandate.public_agent_brief ?? null,
      seller_private_rules: d.mandate.seller_private_rules ?? null,
      agent_lang: d.mandate.agent_lang ?? null,
      tone: d.mandate.tone ?? null,
      must_haves: d.mandate.must_haves ?? null,
    },
    constraints: {
      floor_price: d.constraints.floor_price ?? null,
      ask_before_commit: d.constraints.ask_before_commit ?? null,
    },
    expiry_days: d.expiry_days,
    proposed_category: d.proposed_category,
  };
}

/**
 * Last-resort tripwire. `promptView` already makes a leak structurally impossible;
 * this catches the case where someone later hand-rolls a prompt string. Cheap, and
 * the failure it guards is unrecoverable (a stranger reads the seller's secret).
 */
function assertNoVaultLeak(prompt: string, vault: ComposeVault): void {
  const nd = String(vault.never_disclose ?? "").trim();
  if (nd.length >= 8 && prompt.includes(nd)) {
    throw new Error("compose: never_disclose leaked into prompt — refusing to call the model");
  }
}

// ---------------------------------------------------------------------------
// §2.2/§2.3 — the taxonomy, read server-side. The model never invents a category.
// ---------------------------------------------------------------------------

export interface CategoryChoice {
  id: string;
  label: string | null;
  emoji: string | null;
  intent: string;
}

/**
 * Active categories for a vertical — the turn-0 chips (§3.2) AND the set of ids
 * `set_category` will accept. One function so the list the user is offered and the
 * list the server validates against can never drift apart.
 *
 * Never throws: pre-migration (no vertical/intent columns) it falls back to the legacy
 * taxonomy, which is entirely commerce — so a `connect` request correctly returns
 * nothing rather than leaking commerce rows across a vertical boundary (§2.0), and the
 * chat still opens either way.
 */
async function listCategories(env: Env, vertical: string): Promise<CategoryChoice[]> {
  try {
    const rs = await metaSession(env).prepare(
      "SELECT id, label, emoji, intent FROM listing_categories WHERE active=1 AND vertical=?1 ORDER BY sort, id",
    ).bind(vertical).all();
    return ((rs.results ?? []) as any[]).map((r) => ({
      id: String(r.id), label: r.label ?? null, emoji: r.emoji ?? null, intent: String(r.intent ?? "SELL"),
    }));
  } catch {
    if (vertical !== DEFAULT_VERTICAL) return [];
    try {
      const rs = await metaSession(env).prepare(
        "SELECT id, label, emoji FROM listing_categories WHERE active=1 ORDER BY sort, id",
      ).all();
      return ((rs.results ?? []) as any[]).map((r) => ({
        id: String(r.id), label: r.label ?? null, emoji: r.emoji ?? null, intent: "SELL",
      }));
    } catch { return []; }
  }
}

/**
 * Resolve ONE category id the model proposed, IN THIS VERTICAL, and read the version
 * to pin (§2.4).
 *
 * Returns null for anything that is not a real, active category of this vertical — the
 * model's word that "cars" exists is worth nothing, and a hallucinated id written to
 * `listing_compose_sessions.category` would produce a listing filed under a category
 * that does not exist, invisible to every category filter in the product.
 *
 * `cat_version` is read HERE, at the moment of choosing, because that is the moment
 * the pin is taken (§2.4 — "a listing renders and negotiates at its pinned version,
 * always"). Reading it later would pin whatever an admin had done in the meantime,
 * which is precisely the drift the pin exists to stop.
 */
async function lookupCategory(
  env: Env, id: unknown, vertical: string,
): Promise<{ id: string; cat_version: number } | null> {
  const raw = String(id ?? "").trim();
  // A category id is a row key, never free text. Anything else is not worth a query.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)) return null;
  const pin = (v: unknown) => Math.max(1, Math.trunc(Number(v ?? 1)) || 1);
  try {
    const r = await metaSession(env).prepare(
      "SELECT id, cat_version FROM listing_categories WHERE LOWER(id)=LOWER(?1) AND active=1 AND vertical=?2",
    ).bind(raw, vertical).first<any>();
    return r ? { id: String(r.id), cat_version: pin(r.cat_version) } : null;
  } catch {
    // Pre-migration: no vertical/cat_version columns. Legacy rows are all commerce,
    // and cat_version 1 is exactly what the migration back-fills — so the fallback and
    // the migration agree rather than inventing a third answer.
    if (vertical !== DEFAULT_VERTICAL) return null;
    try {
      const r = await metaSession(env).prepare(
        "SELECT id FROM listing_categories WHERE LOWER(id)=LOWER(?1) AND active=1",
      ).bind(raw).first<any>();
      return r ? { id: String(r.id), cat_version: 1 } : null;
    } catch { return null; }
  }
}

const PLAYBOOK =
  "You are Ava, helping someone write ONE marketplace listing by talking to them. " +
  "You do NOT hold the listing — the server does. You propose changes; the server validates and stores them.\n\n" +
  "HOW TO REPLY. Output ONLY a JSON object, no prose outside it:\n" +
  '{"say":"<what you say to the user, in their language>","chips":["<=4 short tappable replies"],' +
  '"tool_calls":[{"tool":"<name>","args":{...}}]}\n\n' +
  "TOOLS (the server validates every one; an invalid call is reported back to you):\n" +
  "- set_category {id} — MUST be an id from CATEGORIES below. Do this FIRST: until a category " +
  "is set there is no field schema, so you don't yet know what to ask. If the user changes their " +
  "mind later ('it's a bike, not a car') just call set_category again — the server re-pins the " +
  "schema and clears the answers that belonged to the old category, and will tell you which.\n" +
  "- set_fields {<key>:<value>} — category attributes. Only keys from the FIELD SCHEMA.\n" +
  "- set_core {title,description,price,currency,country,location}\n" +
  "- set_tags {tags:[...]} — up to 8, feeds search\n" +
  "- suggest_price {} — returns real comparable-listing statistics for you to talk about\n" +
  "- attach_media {hashes:[...]} — photos the user already uploaded\n" +
  "- attach_video {url} — YouTube ONLY; the server verifies the link really exists\n" +
  "- set_mandate {public_agent_brief,seller_private_rules,never_disclose,floor_price,ask_before_commit,must_haves,agent_lang,tone}\n" +
  "- set_expiry {days} — 1..90\n" +
  "- propose_category {name,intent} — ONLY when nothing in the taxonomy fits\n" +
  "- ready_to_publish {} — when you believe nothing required is missing\n\n" +
  "THERE IS NO PUBLISH TOOL. You can never publish. When the listing looks complete, call " +
  "ready_to_publish and ASK the user — they publish it themselves from the review card.\n\n" +
  "THE MANDATE (this is the part people get wrong):\n" +
  "- public_agent_brief: selling points. Public.\n" +
  "- seller_private_rules: tone/strategy only, and keep it SHORT. It goes into the negotiating " +
  "agent's prompt, so a determined buyer may extract a paraphrase of it.\n" +
  "- never_disclose: anything that would DAMAGE the user if a buyer learned it (divorce, " +
  "relocation, desperation, debt, a deadline). Route it here. It is never given to the agent at all.\n" +
  "- floor_price / ask_before_commit: enforced by the server in code, not by asking the agent nicely.\n" +
  "When someone volunteers something damaging (\"I'm relocating in March, I'll take 45\"), do NOT " +
  "put it in seller_private_rules. Put it in never_disclose, set floor_price, and tell them you've " +
  "done so — e.g. \"I'll keep that out of what the agent knows; I'll just set your floor and it " +
  "won't go below, without saying why.\"\n\n" +
  "PRICE: only discuss market rates using numbers suggest_price actually returned. If it returns " +
  "no statistics, say NOTHING about what the market pays — ask what they think it's worth and move on. " +
  "Never block someone over price; a bad price is their right.\n\n" +
  "STYLE: one question at a time, warm, brief, never a form. Speak the user's language. " +
  "Never ask for a phone number or email — contact stays in AvaTOK.";

// ---------------------------------------------------------------------------
// §3.5 price coaching — an AGGREGATE over other people's listings
// ---------------------------------------------------------------------------

export interface Comparables {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  currency: string | null;
  scope: "location" | "country" | "none";
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

async function pricesFor(
  env: Env, category: string, country: string, location: string | null,
): Promise<number[]> {
  const since = Date.now() - COMPARABLE_WINDOW_MS;
  const sql = location
    ? `SELECT price FROM listings
        WHERE category=?1 AND country=?2 AND location=?4 AND status IN ('published','live')
          AND price > 0 AND created_at > ?3 ORDER BY price`
    : `SELECT price FROM listings
        WHERE category=?1 AND country=?2 AND status IN ('published','live')
          AND price > 0 AND created_at > ?3 ORDER BY price`;
  const st = metaSession(env).prepare(sql);
  const bound = location ? st.bind(category, country, since, location) : st.bind(category, country, since);
  const rs = await bound.all();
  return ((rs.results ?? []) as any[])
    .map((r) => Math.trunc(Number(r.price) || 0))
    .filter((n) => n > 0);
}

/**
 * §3.5 — median/p25/p75/n over COMPARABLE listings.
 *
 * ⚠️ CROSS-USER AGGREGATE — this must NEVER touch `brainRecall` (§1.2b-a).
 * brainRecall is uid-scoped personal memory; these are other people's listings.
 * Reaching for the brain here would turn a market statistic into a privacy breach.
 * It is a plain aggregate SQL query and must stay one.
 *
 * COLD START IS DESIGNED FOR, NOT DISCOVERED. On day one every category is n=0:
 *   n >= 8  → narrow by location, quote the range
 *   3..7    → quote it, but the caller MUST say the sample size
 *   n < 3   → returns NO numbers at all. Not "numbers the model is asked not to
 *             use" — the model cannot cite what it was never given. That is the
 *             difference between a rule and a wish.
 */
export async function comparablesFor(
  env: Env, category: string, country: string, location: string | null, currency: string | null,
): Promise<Comparables> {
  const none: Comparables = { n: 0, median: null, p25: null, p75: null, currency, scope: "none" };
  if (!category || !country) return none;
  try {
    let scope: Comparables["scope"] = "country";
    let prices: number[] = [];
    if (location) {
      const narrow = await pricesFor(env, category, country, location);
      if (narrow.length >= 8) { prices = narrow; scope = "location"; }
    }
    if (!prices.length) prices = await pricesFor(env, category, country, null);
    const n = prices.length;
    // n < 3 → say nothing about price. Withhold the numbers, not just the advice.
    if (n < 3) return { ...none, n };
    prices.sort((a, b) => a - b);
    return {
      n, scope,
      median: quantile(prices, 0.5), p25: quantile(prices, 0.25), p75: quantile(prices, 0.75),
      currency,
    };
  } catch {
    return none; // no comparables table yet ⇒ say nothing, never block
  }
}

/** What the model is allowed to know about price. Shaped by the cold-start rules. */
function comparablesForModel(c: Comparables): Record<string, unknown> {
  if (c.n < 3) {
    return { n: c.n, guidance: "Not enough comparable listings. Say NOTHING about market price. Ask what they think it's worth." };
  }
  const base = { n: c.n, scope: c.scope, median: c.median, p25: c.p25, p75: c.p75, currency: c.currency };
  if (c.n < 8) {
    return { ...base, guidance: "Only a few comparables. You MUST state the sample size. Never present this as market truth." };
  }
  return { ...base, guidance: "Enough comparables to quote a range. Advice only — never block the user over price." };
}

// ---------------------------------------------------------------------------
// §3.4 YouTube — validated SERVER-SIDE, never trusted from the model
// ---------------------------------------------------------------------------

/**
 * Extract a YouTube id from watch / youtu.be / shorts / embed forms. Returns null
 * for everything else — including every other video host. YouTube-only is the rule.
 */
export function youtubeIdFrom(url: string): string | null {
  const u = String(url ?? "").trim();
  if (!u) return null;
  const pats = [
    /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com|youtube-nocookie\.com)\/shorts\/([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com|youtube-nocookie\.com)\/embed\/([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com|youtube-nocookie\.com)\/live\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const p of pats) {
    const m = u.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * §3.4 — confirm the video exists via oEmbed. A 404 means dead/private → reject.
 * The model's word that "this is a valid YouTube link" is worth nothing; a listing
 * hero that plays nothing is a broken listing.
 *
 * Stores `youtube-nocookie` + rel=0 per the M-D5 recommendation — the embed is a
 * third-party ad/tracking surface inside a product with a child-safety posture.
 */
export async function validateYouTube(url: string): Promise<
  { ok: true; video: ComposeVideo } | { ok: false; message: string }
> {
  const id = youtubeIdFrom(url);
  if (!id) {
    return { ok: false, message: "That needs to be a YouTube link — it's the only video site we can show here." };
  }
  const watch = `https://www.youtube.com/watch?v=${id}`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return { ok: false, message: "I couldn't open that video — it looks private or deleted. Can you check the link?" };
    }
    if (!res.ok) {
      return { ok: false, message: "I couldn't check that video just now. Try again in a moment?" };
    }
    const meta: any = await res.json().catch(() => ({}));
    return {
      ok: true,
      video: {
        video_id: id,
        video_url: `https://www.youtube-nocookie.com/embed/${id}?rel=0`,
        title: meta?.title ? String(meta.title).slice(0, 300) : null,
        thumbnail: meta?.thumbnail_url ? String(meta.thumbnail_url) : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      },
    };
  } catch {
    return { ok: false, message: "I couldn't check that video just now. Try again in a moment?" };
  }
}

// ---------------------------------------------------------------------------
// tool execution — EVERY tool validated server-side (§3.3)
// ---------------------------------------------------------------------------

interface ToolCall { tool: string; args: Record<string, unknown> }

interface ToolOutcome {
  /** Fed back to the model on the NEXT turn (and used for the review card). */
  note: string;
  ok: boolean;
  /** suggest_price returns data the model may talk about. */
  data?: Record<string, unknown>;
  ready?: boolean;
}

function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Resolve the user's photos by CONTENT HASH → their own user_media rows.
 * Ownership is asserted in SQL (`uid=?`): a model that hallucinates a hash, or
 * echoes one it saw elsewhere, cannot attach a stranger's image.
 * Idempotent by construction (§3.3c) — the hash IS the key, so a retried attach is
 * a no-op rather than a duplicate cover.
 */
async function resolveMedia(
  env: Env, uid: string, hashes: string[],
): Promise<{ ids: string[]; urls: string[]; missing: string[] }> {
  const ids: string[] = [], urls: string[] = [], missing: string[] = [];
  for (const h of hashes) {
    const hash = String(h ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) { missing.push(String(h)); continue; }
    try {
      const row = await mediaSession(env).prepare(
        "SELECT id, display_url FROM user_media WHERE uid=?1 AND key=?2 AND deleted_at IS NULL",
      ).bind(uid, `u/${uid}/public/${hash}`).first<any>();
      if (!row) { missing.push(hash); continue; }
      ids.push(String(row.id));
      if (row.display_url) urls.push(String(row.display_url));
    } catch { missing.push(hash); }
  }
  return { ids, urls, missing };
}

/**
 * The resolved category, held in a MUTABLE box.
 *
 * `set_category` can land in the middle of a turn — a model that says "a bike, got it"
 * will happily emit `set_category` and `set_fields` in the SAME tool_calls array. If
 * the resolved category were passed by value, every tool after `set_category` in that
 * array (and the end-of-turn `validateAttrs`) would still be running against the OLD
 * schema, i.e. against null on the very first turn. The box makes the re-pin visible
 * to the rest of the turn.
 */
interface CatRef { cat: ResolvedCategory | null }

/**
 * Execute ONE proposed tool call against the draft, in place.
 *
 * The model proposes; this decides. Every branch either writes a validated value or
 * returns a note explaining the refusal — which the model reads next turn and can
 * act on. Nothing here trusts an argument's shape.
 *
 * `session.category` / `session.cat_version` are mutated in place by `set_category`;
 * `persistTurn` writes them to their columns inside the same rev-guarded UPDATE that
 * writes the draft, so the category and the answers collected under it can never be
 * committed apart.
 */
async function runTool(
  env: Env, uid: string, call: ToolCall, draft: ComposeDraft,
  catRef: CatRef, session: SessionRow,
): Promise<ToolOutcome> {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const schema: FieldSchema | null = catRef.cat?.field_schema ?? null;

  switch (call.tool) {
    case "set_category": {
      // §2.3 — validated against the taxonomy, in this session's vertical. The model
      // does not get to invent a category; when nothing fits it calls propose_category
      // and the listing files under `other` (the escape hatch, not the default).
      const hit = await lookupCategory(env, a.id ?? a.category, draft.vertical);
      if (!hit) {
        const valid = (await listCategories(env, draft.vertical)).map((c) => c.id);
        return {
          ok: false,
          note: `set_category rejected: "${String(a.id ?? a.category ?? "")}" is not a category in this marketplace. ` +
            `Valid ids: ${valid.join(", ") || "(none configured)"}. If none of them fit, call propose_category instead.`,
        };
      }

      // Idempotent: re-asserting the SAME category must not wipe the user's answers. A
      // model that repeats itself is common; a model that repeats itself and destroys
      // twelve turns of work is not survivable.
      if (session.category === hit.id) {
        return { ok: true, note: `category already ${hit.id} (nothing changed)` };
      }

      const prev = session.category;
      session.category = hit.id;
      // §2.4 — PIN NOW, at the real version of the chosen category. Note this always
      // re-pins on a change: cat_version is per-category, so carrying `cars` v3 across
      // to `bicycles` would pin a version of bicycles that has nothing to do with the
      // one the seller is actually being asked about.
      session.cat_version = hit.cat_version;
      catRef.cat = await resolveCategoryVersion(env, hit.id, hit.cat_version).catch(() => null);

      // A category CHANGE invalidates `attrs`. attrs are category-specific by
      // definition, and §2.4's "a schema bump must not orphan data" is about a
      // PUBLISHED listing surviving an admin's edit — it is not a licence to smuggle a
      // car's mileage into a bicycle. Nothing is published yet, so the honest move is
      // to drop them and re-ask; carrying them would produce junk attrs that pass
      // validation only because unknown keys aren't violations. Everything
      // category-independent (core, price, photos, tags, mandate, vault) survives — the
      // user changed their mind about the category, not about the thing.
      const dropped = prev ? Object.keys(draft.attrs) : [];
      if (prev) draft.attrs = {};

      // A real category supersedes any earlier proposal, whether or not a category was
      // set before it: §2.3's queue is "what are people trying to list that we have no
      // category for", and a proposal from a listing that then found a real home is
      // noise in the one signal an admin uses to grow the taxonomy.
      const hadProposal = !!draft.proposed_category;
      draft.proposed_category = null;
      const proposalNote = hadProposal ? "; your earlier category proposal is dropped" : "";

      return {
        ok: true,
        note: prev
          ? `category changed ${prev} → ${hit.id} (pinned v${hit.cat_version}). ` +
            `The FIELD SCHEMA has changed and I cleared the answers that belonged to ${prev}` +
            `${dropped.length ? ` (${dropped.join(", ")})` : ""}${proposalNote}. ` +
            "Everything else — title, price, photos, tags, mandate — is intact. Tell the user " +
            "plainly and ask again for anything the new schema needs."
          : `category set: ${hit.id} (pinned v${hit.cat_version})${proposalNote}`,
      };
    }

    case "set_fields": {
      // Validate the MERGED attrs against the PINNED schema (§2.4) — validating
      // against "latest" would re-introduce the drift the pin exists to stop.
      const next = { ...draft.attrs, ...a };
      const v = validateAttrs(schema, next);
      if (v.violations.length) {
        return { ok: false, note: `set_fields rejected: ${v.violations.map((x) => x.detail).join("; ")}` };
      }
      draft.attrs = next;
      return { ok: true, note: `fields set: ${Object.keys(a).join(", ") || "(none)"}` };
    }

    case "set_core": {
      const title = clampStr(a.title, 200);
      const description = clampStr(a.description, 4000);
      // Moderation on the way IN, so the user hears about it while they can still
      // fix it — rather than at publish, after 20 turns of work. This is advisory
      // here; publish re-checks and fails CLOSED (§7.1).
      const [tm, dm] = await Promise.all([
        title ? moderate(env, { text: title, field: "listing_title" }) : Promise.resolve({ safe: true, ok: true } as any),
        description ? moderate(env, { text: description, field: "listing_desc" }) : Promise.resolve({ safe: true, ok: true } as any),
      ]);
      if (!tm.safe) return { ok: false, note: `title rejected by safety: ${tm.reason || "not allowed"}` };
      if (!dm.safe) return { ok: false, note: `description rejected by safety: ${dm.reason || "not allowed"}` };

      if (title !== undefined) draft.core.title = title;
      if (description !== undefined) draft.core.description = description;
      const price = toInt(a.price);
      if (price !== null && price >= 0) draft.core.price = price;
      const currency = clampStr(a.currency, 8);
      if (currency) draft.core.currency = currency.toUpperCase();
      const country = clampStr(a.country, 64);
      if (country) draft.core.country = country;
      const location = clampStr(a.location, 200);
      if (location) draft.core.location = location;
      return { ok: true, note: "core set" };
    }

    case "set_tags": {
      const raw: unknown[] = Array.isArray(a.tags) ? a.tags : [];
      const tags = raw
        .map((t) => clampStr(t, 40))
        .filter((t): t is string => !!t)
        .slice(0, MAX_TAGS);
      draft.tags = tags;
      return { ok: true, note: `tags set (${tags.length})` };
    }

    case "suggest_price": {
      const c = await comparablesFor(
        env, session.category ?? "", draft.core.country ?? "",
        draft.core.location ?? null, draft.core.currency ?? null,
      );
      return { ok: true, note: `comparables: n=${c.n}`, data: { comparables: comparablesForModel(c) } };
    }

    case "attach_media": {
      const hashes = (Array.isArray(a.hashes) ? a.hashes : []).map((h) => String(h)).slice(0, 20);
      if (!hashes.length) return { ok: false, note: "attach_media needs hashes" };
      const { ids, urls, missing } = await resolveMedia(env, uid, hashes);
      if (!ids.length) {
        // §3.4 — the upload failure must be TOLD to the AI so it can say so, rather
        // than swallowed (the sell_listing_flow.dart:115 bug).
        return { ok: false, note: `none of those photos are on the server yet (${missing.length} missing) — tell the user the upload didn't land and ask them to try again` };
      }
      for (const id of ids) if (!draft.media.includes(id)) draft.media.push(id);
      if (!draft.cover_media && urls.length) draft.cover_media = urls[0];
      return {
        ok: true,
        note: `${ids.length} photo(s) attached${missing.length ? `; ${missing.length} did NOT upload — tell the user` : ""}`,
      };
    }

    case "attach_video": {
      const r = await validateYouTube(String(a.url ?? ""));
      if (!r.ok) return { ok: false, note: `video rejected — say this to the user, plainly: ${r.message}` };
      draft.video = r.video;
      return { ok: true, note: `video attached: ${r.video.title ?? r.video.video_id}` };
    }

    case "set_mandate": {
      // §3.6b — route each answer to the field with the RIGHT exposure rule.
      const pub = clampStr(a.public_agent_brief, 2000);
      if (pub !== undefined) draft.mandate.public_agent_brief = pub;
      const priv = clampStr(a.seller_private_rules, 1200);
      if (priv !== undefined) draft.mandate.seller_private_rules = priv;
      // Into the VAULT. Written here, read by nothing that builds a prompt.
      const nd = clampStr(a.never_disclose, 2000);
      if (nd !== undefined) draft.vault.never_disclose = nd;
      const must = clampStr(a.must_haves, 1000);
      if (must !== undefined) draft.mandate.must_haves = must;
      const lang = clampStr(a.agent_lang, 16);
      if (lang) draft.mandate.agent_lang = lang.toLowerCase();
      const tone = clampStr(a.tone, 40);
      if (tone) draft.mandate.tone = tone;
      // Constraints are CODE, not prose. Stored typed so they are SQL-checkable.
      const floor = toInt(a.floor_price);
      if (floor !== null && floor >= 0) draft.constraints.floor_price = floor;
      if (typeof a.ask_before_commit === "boolean") draft.constraints.ask_before_commit = a.ask_before_commit;
      const parts = [
        pub !== undefined ? "public brief" : null,
        priv !== undefined ? "private rules" : null,
        nd !== undefined ? "kept-back note (the agent will never be told this)" : null,
        floor !== null ? `floor ${floor}` : null,
      ].filter(Boolean);
      return { ok: true, note: `mandate set: ${parts.join(", ") || "(nothing)"}` };
    }

    case "set_expiry": {
      const d = toInt(a.days);
      if (d === null) return { ok: false, note: "set_expiry needs a number of days" };
      draft.expiry_days = Math.max(1, Math.min(90, d));
      return { ok: true, note: `expiry ${draft.expiry_days} days` };
    }

    case "propose_category": {
      // §2.3 — the AI proposes, an admin approves, the user is NEVER blocked. The
      // listing files under `other` and publishes normally.
      const name = clampStr(a.name, 80);
      if (!name) return { ok: false, note: "propose_category needs a name" };
      draft.proposed_category = name;
      return { ok: true, note: `filed under "other" with your suggestion "${name}" — the user is not blocked by this` };
    }

    case "ready_to_publish": {
      // Re-read the schema from the box: set_category may have re-pinned it earlier in
      // THIS turn, and `schema` was captured at entry.
      const v = validateAttrs(catRef.cat?.field_schema ?? null, draft.attrs);
      const gaps = missingFor(draft, v.missing, session);
      if (gaps.length) return { ok: true, ready: false, note: `not ready — still missing: ${gaps.join(", ")}` };
      return { ok: true, ready: true, note: "ready — show the review card and ASK. You cannot publish; only the user can." };
    }

    default:
      return { ok: false, note: `unknown tool "${call.tool}" — ignored` };
  }
}

/**
 * What still blocks a publish: schema min_required + the non-negotiable core.
 *
 * `category` is one of them. A session with neither a chosen category nor a
 * `proposed_category` is a listing nobody has classified, and publishing it under
 * `other` would be a silent misfile — §2.3 makes `other` the ESCAPE HATCH for
 * "nothing in the taxonomy fits", reached deliberately via propose_category, not the
 * quiet default for everyone. Either arm satisfies this, so the escape hatch still
 * never blocks the user.
 */
function missingFor(d: ComposeDraft, schemaMissing: string[], s: SessionRow): string[] {
  const out = [...schemaMissing];
  if (!s.category && !d.proposed_category) out.push("category");
  if (!d.core.title) out.push("title");
  if (!d.core.description) out.push("description");
  if (d.core.price == null) out.push("price");
  if (!d.core.country) out.push("country");
  return Array.from(new Set(out));
}

/** 0..1 — a coarse completeness signal for the client's progress bar. */
function progressOf(d: ComposeDraft, missing: string[]): number {
  const have = [
    !!d.core.title, !!d.core.description, d.core.price != null, !!d.core.country,
    d.media.length > 0 || !!d.video, d.tags.length > 0,
    !!(d.mandate.public_agent_brief || d.constraints.floor_price != null),
  ].filter(Boolean).length;
  const base = have / 7;
  const penalty = Math.min(0.4, missing.length * 0.1);
  return Math.max(0, Math.min(1, Number((base - penalty).toFixed(2))));
}

function reviewCard(d: ComposeDraft, session: SessionRow): Record<string, unknown> {
  // NOTE: never_disclose is absent by construction — the card is built from named
  // fields, and `vault` is not one of them. The user's own kept-back note is shown
  // back to them as a COUNT only; it is their secret, and the card is screenshot bait.
  return {
    session_id: session.session_id,
    rev: session.rev,
    category: session.category,
    cat_version: session.cat_version,
    title: d.core.title ?? null,
    description: d.core.description ?? null,
    price: d.core.price ?? null,
    currency: d.core.currency ?? null,
    country: d.core.country ?? null,
    location: d.core.location ?? null,
    tags: d.tags,
    photo_count: d.media.length,
    cover_media: d.cover_media,
    video: d.video,
    attrs: d.attrs,
    expiry_days: d.expiry_days,
    proposed_category: d.proposed_category,
    mandate: {
      public_agent_brief: d.mandate.public_agent_brief ?? null,
      floor_price: d.constraints.floor_price ?? null,
      ask_before_commit: d.constraints.ask_before_commit ?? false,
      has_private_note: !!d.vault.never_disclose,
    },
  };
}

/**
 * The server's current truth for a session, in the shape a client re-renders from.
 *
 * §3.3c: "a mismatch returns 409 stale_session WITH THE CURRENT DRAFT, and the client
 * re-renders rather than clobbering. Two devices in the same session converge instead
 * of racing." A 409 carrying only `rev` cannot deliver that — the loser knows it lost
 * and knows nothing else, so its only move is to guess or to overwrite. This is the
 * payload that lets it converge.
 *
 * Re-READ from D1 rather than derived from the caller's stale row: the whole reason we
 * are here is that the caller's copy is out of date. Includes `turn_seq`, because every
 * turn must send `server.turn_seq + 1` and a client that cannot learn the server's
 * sequence can never send an acceptable turn again.
 *
 * Safe to hand back: it is built from `reviewCard`, which is a named-field whitelist —
 * `vault` is not one of them — and the caller is uid-scoped to the author.
 */
interface ComposeState {
  rev: number;
  turn_seq: number;
  progress: number;
  missing: string[];
  card: Record<string, unknown>;
}

async function currentState(env: Env, sessionId: string, uid: string): Promise<ComposeState | null> {
  try {
    const cur = await metaDb(env).prepare(
      `SELECT session_id, uid, listing_id, category, cat_version, lang, draft_json, transcript,
              turn_seq, rev, status, created_at, updated_at, expires_at
         FROM listing_compose_sessions WHERE session_id=?1 AND uid=?2`,
    ).bind(sessionId, uid).first<SessionRow>();
    if (!cur) return null;
    const d = parseDraft(cur.draft_json, cur.lang ?? "en");
    const rc = cur.category
      ? await resolveCategoryVersion(env, cur.category, cur.cat_version).catch(() => null)
      : null;
    const v = validateAttrs(rc?.field_schema ?? null, d.attrs);
    const missing = missingFor(d, v.missing, cur);
    return {
      rev: cur.rev, turn_seq: cur.turn_seq,
      progress: progressOf(d, missing), missing, card: reviewCard(d, cur),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. POST /api/marketplace/compose/session
// ---------------------------------------------------------------------------

/**
 * Open (or resume) a compose session.
 *
 * §3.1 — reports identity state; does NOT hard-block. The client renders a button
 * that runs the liveness flow INLINE and resumes the chat in place; sending someone
 * to a settings page is a drop-off cliff. The 403 identity_required contract is
 * enforced at the WRITE (composePublish), which is the moment that matters.
 *
 * Body: { vertical?, lang? }
 * → 200 { session_id, identity:{ok,reason?}, greeting, categories[],
 *         resume?:{ session_id, summary, turn_seq, rev } }
 *
 * `session_id` is ALWAYS a fresh, empty session. `resume`, when present, is a separate
 * offer pointing at a DIFFERENT session — and it carries `turn_seq`/`rev` because a
 * resumed draft past turn 0 is unusable without them (§3.3c: every turn must send
 * `server.turn_seq + 1`, and a client that resumes at 0 is refused forever).
 */
export async function composeSession(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await composeEnabled(env))) {
    void track(env, ctx.uid, "compose_blocked", APP, { reason: "flag_off", status: 503 });
    return flagOff();
  }

  const b = (await req.json().catch(() => ({}))) as any;
  // A vertical is a row id, never free text from a client — mirrors normVertical in
  // categories.ts. It is bound into SQL and stored in the draft for the life of the
  // session, so an unrecognisable value falls back to commerce rather than opening a
  // session that composes into a vertical that does not exist.
  const rawVertical = String(b.vertical ?? DEFAULT_VERTICAL).trim().toLowerCase();
  const vertical = /^[a-z][a-z0-9_]{0,31}$/.test(rawVertical) ? rawVertical : DEFAULT_VERTICAL;
  const lang = String(b.lang ?? "en").trim().toLowerCase() || "en";
  const email = await emailOf(env, ctx.uid).catch(() => null);

  // §3.1 — state, not a gate.
  let identity: { ok: boolean; reason?: string } = { ok: false, reason: "never_passed" };
  try {
    const st = await livenessState(env, ctx.uid);
    identity = st.valid ? { ok: true } : { ok: false, reason: st.reason };
  } catch { /* reported as not-passed; publish is where it is enforced */ }

  // §3.2 — turn 0 chips come from the taxonomy, not a hard-coded list. The same list
  // set_category validates against, so what we offer and what we accept cannot drift.
  const categories = await listCategories(env, vertical);

  // §3.3 — resume the newest active session: "You were listing a 3-bed in Bandra."
  //
  // `turn_seq > 0` IS LOAD-BEARING, not a tidy-up. Every open creates a session (see
  // below), so without it the empty session created by THIS open is the newest `active`
  // row and becomes the next open's resume candidate — offering the user "You were
  // listing a listing. Carry on?", pointing at a draft that does not exist. A turn-0
  // session has no draft, no transcript and no category: there is, definitionally,
  // nothing to resume, so the truthful predicate is "sessions the user actually said
  // something to". They expire on the 72h TTL like any other (§3.3b).
  //
  // The alternative — skip the INSERT when a resume is on offer — was rejected: the
  // response's `session_id` would then mean two different things (a fresh session, or
  // the old one) depending on a field the client may ignore, and the server would be
  // deciding "resume vs start fresh" before the user has been asked. Here `session_id`
  // is always a new empty session and `resume` is always a separate, optional offer.
  let resume: { session_id: string; summary: string; turn_seq: number; rev: number } | undefined;
  try {
    const prev = await metaSession(env).prepare(
      `SELECT session_id, draft_json, category, transcript, turn_seq, rev
         FROM listing_compose_sessions
        WHERE uid=?1 AND status='active' AND expires_at > ?2 AND turn_seq > 0
        ORDER BY updated_at DESC LIMIT 1`,
    ).bind(ctx.uid, Date.now()).first<any>();
    if (prev) {
      const d = parseDraft(prev.draft_json);
      // Ladder down to something the user will actually recognise. The transcript rung
      // matters: a seller three turns in who hasn't been asked for a title yet still
      // said what they were selling, and their own words beat a category id.
      const firstSaid = parseTranscript(prev.transcript).find((t) => t.role === "user")?.text ?? "";
      const summary = d.core.title
        ? `${d.core.title}${d.core.location ? ` in ${d.core.location}` : ""}`
        : (String(prev.category ?? "").trim()
          || (firstSaid.trim() ? `"${firstSaid.trim().slice(0, 60)}"` : "")
          || "a listing");
      resume = {
        session_id: String(prev.session_id),
        summary,
        // §3.3c — a turn must send server.turn_seq + 1, and a resume that reports no
        // sequence leaves the client refused with nothing to resync from.
        turn_seq: Number(prev.turn_seq ?? 0),
        rev: Number(prev.rev ?? 0),
      };
    }
  } catch { /* table not migrated yet — open a fresh session */ }

  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const draft = emptyDraft(lang, vertical);
  try {
    // cat_version is 1 at birth only as a NOT NULL placeholder — it is NOT a pin. The
    // real pin is taken by set_category, from the chosen category's own version (§2.4),
    // and nothing reads cat_version while `category` is still NULL.
    await metaDb(env).prepare(
      `INSERT INTO listing_compose_sessions
         (session_id, uid, listing_id, category, cat_version, lang, draft_json, transcript,
          turn_seq, rev, status, created_at, updated_at, expires_at)
       VALUES (?1,?2,NULL,NULL,?3,?4,?5,'[]',0,0,'active',?6,?6,?7)`,
    ).bind(sessionId, ctx.uid, 1, lang, JSON.stringify(draft), now, now + SESSION_TTL_MS).run();
  } catch (e: any) {
    return json({ error: "compose_unavailable", detail: String(e?.message ?? e).slice(0, 200) }, 503);
  }

  const name = await displayName(env, ctx.uid);
  // §1.2 — enrichment is a Phase-6 NICETY. The flow MUST be complete without it: an off
  // flag (or an absent brain, or nothing worth saying) degrades to the same one extra
  // question, not a broken flow. The helper enforces all four §6.1 gates and returns
  // null in every degrade case; it is wrapped so it can't throw, but we still `.catch`
  // defensively so a surprise here can never take the session open with it.
  const enrich = await listingEnrichment(env, ctx.uid, vertical).catch(() => null);
  // Warm the greeting only when enrichment is present; otherwise TODAY's greeting, verbatim.
  // NOTE (lang hint): `lang` is already baked into the D1 INSERT and emptyDraft() above,
  // so overriding it here from `enrich.lang` would desync the persisted session lang from
  // the effective one (and the return contract doesn't expose lang anyway). Per §1.2's
  // "risky → skip", we do NOT touch lang and only warm the greeting text.
  const greeting = enrich
    ? warmGreeting(name, enrich)
    : `Hey ${name} 👋  What are you listing today?`;
  void trackUser(env, ctx.uid, email, "compose_session_opened", APP, {
    session_id: sessionId, vertical, lang, identity_ok: identity.ok,
    identity_reason: identity.reason ?? null, resumable: !!resume, categories: categories.length,
    // §6.1 measurement — did enrichment fire, and how much history it saw. Extends the
    // existing event; NOT a new event.
    enriched: !!enrich, prior_count: enrich?.priorCount ?? 0,
  });
  return json({ session_id: sessionId, identity, greeting, categories, ...(resume ? { resume } : {}) });
}

/**
 * §1.2/§6.1 — turn a non-null ListingEnrichment into a SHORT, natural greeting.
 *
 * Deliberately conservative about what it surfaces: `priorCount` and, at most, one
 * brain-derived note that already reads as a full sentence. It never dumps
 * `recentCategories` verbatim and never echoes the raw `note` as a fragment — the two
 * ways this could start feeling creepy. When enrichment is useful only via a soft hint
 * (a lang/location the greeting can't naturally say), it falls back to today's ask.
 */
function warmGreeting(name: string, e: ListingEnrichment): string {
  const base = `Hey ${name} 👋`;
  const ask = "What are you listing today?";

  // A brain-derived note, but ONLY if it already reads as a self-contained, natural
  // sentence (the helper trims/sanitises it) — never a bare fragment we'd have to glue.
  const note = (e.note ?? "").trim();
  if (note && note.length <= 140 && /[.!?]$/.test(note)) {
    return `${base}  ${note} ${ask}`;
  }

  // A returning seller: a soft nod to their history — count only, no category dump.
  if (e.priorCount > 0) {
    const cnt = e.priorCount === 1
      ? "You've listed one before."
      : `You've posted ${e.priorCount} before.`;
    return `${base}  Back to list something? ${cnt}`;
  }

  // Useful only via a hint we can't voice naturally → today's greeting, unchanged.
  return `${base}  ${ask}`;
}

async function displayName(env: Env, uid: string): Promise<string> {
  try {
    const r = await metaSession(env).prepare("SELECT display_name FROM users WHERE uid=?1")
      .bind(uid).first<{ display_name: string | null }>();
    const n = String(r?.display_name ?? "").trim();
    return n ? n.split(/\s+/)[0] : "there";
  } catch { return "there"; }
}

// ---------------------------------------------------------------------------
// 2. POST /api/marketplace/compose/turn — SSE
// ---------------------------------------------------------------------------

function sse(events: Event[]): Response {
  const enc = new TextEncoder();
  const out = new ReadableStream({
    start(controller) {
      for (const e of events) {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* closed */ }
      }
      try { controller.enqueue(enc.encode("data: [DONE]\n\n")); } catch { /* ignore */ }
      controller.close();
    },
  });
  return new Response(out, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...CORS },
  });
}

function sseError(error: string, message?: string): Response {
  return sse([{ t: "error", error, ...(message ? { message } : {}) } as Event]);
}

/**
 * A 409-equivalent on the SSE path, carrying the CURRENT draft (§3.3c).
 *
 * The error frame tells the client it lost; the draft frame tells it what it lost to,
 * so it can re-render `rev`/`turn_seq`/the card and carry on. A bare error frame here
 * was the SSE half of the same bug as the JSON 409 that returned only `rev`.
 */
function sseStale(message: string, state: ComposeState | null): Response {
  const events: Event[] = [{ t: "error", error: "stale_session", message }];
  if (state) {
    events.push({
      t: "draft", progress: state.progress, missing: state.missing,
      rev: state.rev, turn_seq: state.turn_seq, card: state.card,
    });
  }
  return sse(events);
}

/** Strip fences / prose and parse the model's JSON turn. */
function parseModelTurn(raw: string): { say: string; chips: string[]; tool_calls: ToolCall[] } {
  const fallback = { say: "", chips: [] as string[], tool_calls: [] as ToolCall[] };
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const body = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return { ...fallback, say: body.slice(0, 2000) };
  try {
    const j = JSON.parse(m[0]);
    return {
      say: String(j.say ?? "").slice(0, 2000),
      chips: Array.isArray(j.chips) ? j.chips.map((c: unknown) => String(c).slice(0, 60)).slice(0, 4) : [],
      tool_calls: Array.isArray(j.tool_calls)
        ? j.tool_calls
            .filter((t: any) => t && typeof t.tool === "string")
            .map((t: any) => ({ tool: String(t.tool), args: (t.args ?? {}) as Record<string, unknown> }))
            .slice(0, 8)
        : [],
    };
  } catch {
    return { ...fallback, say: body.slice(0, 2000) };
  }
}

/**
 * One conversational turn.
 *
 * Body: { session_id, turn_seq, idem_key, text?, media?:[hash] }
 * → SSE: say | draft | chips | review | error, terminated by `data: [DONE]`.
 *
 * §3.3c CONCURRENCY. Three separate mechanisms, because they guard three different
 * failures:
 *   • `idem_key` (unique on (session_id, idem_key)) — a REPLAY returns the STORED
 *     response and does not re-run the model. A flaky connection must not cost a
 *     model call or double-apply a tool.
 *   • `turn_seq` — ORDERING. A turn from a second device that is behind is refused
 *     rather than applied out of order.
 *   • `rev` — OPTIMISTIC VERSION. Asserted in the WHERE of the write, so a session
 *     mutated between our read and our write loses the race and the client re-renders
 *     instead of clobbering.
 */
export async function composeTurn(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await composeEnabled(env))) {
    void track(env, ctx.uid, "compose_blocked", APP, { reason: "flag_off", status: 503 });
    return flagOff();
  }

  const b = (await req.json().catch(() => ({}))) as any;
  const sessionId = String(b.session_id ?? "").trim();
  const turnSeq = toInt(b.turn_seq);
  const idemKey = String(b.idem_key ?? "").trim().slice(0, 128);
  const text = String(b.text ?? "").slice(0, 4000);
  const mediaHashes = (Array.isArray(b.media) ? b.media : []).map((h: unknown) => String(h)).slice(0, 20);
  if (!sessionId || turnSeq === null || !idemKey) {
    return sseError("bad_request", "session_id, turn_seq and idem_key are required.");
  }

  const db = metaDb(env);
  const email = await emailOf(env, ctx.uid).catch(() => null);

  // ── Replay: return the STORED response, do not re-run the model (§3.3c) ──────
  try {
    const prior = await db.prepare(
      "SELECT response FROM listing_compose_turns WHERE session_id=?1 AND idem_key=?2",
    ).bind(sessionId, idemKey).first<{ response: string }>();
    if (prior?.response) {
      void trackUser(env, ctx.uid, email, "compose_turn_replayed", APP, { session_id: sessionId, turn_seq: turnSeq });
      const events = JSON.parse(prior.response) as Event[];
      return sse(Array.isArray(events) ? events : []);
    }
  } catch { /* table not migrated / unparseable — fall through and run the turn */ }

  // ── Load the session. uid-scoped: the author, and nobody else (§3.3b) ────────
  let s: SessionRow | null = null;
  try {
    s = await db.prepare(
      `SELECT session_id, uid, listing_id, category, cat_version, lang, draft_json, transcript,
              turn_seq, rev, status, created_at, updated_at, expires_at
         FROM listing_compose_sessions WHERE session_id=?1 AND uid=?2`,
    ).bind(sessionId, ctx.uid).first<SessionRow>();
  } catch (e: any) {
    return sseError("compose_unavailable", String(e?.message ?? e).slice(0, 200));
  }
  if (!s) return sseError("not_found", "That conversation has gone. Start a new one?");
  if (s.status !== "active") return sseError("stale_session", "This listing is already finished.");
  if (s.expires_at <= Date.now()) return sseError("stale_session", "This draft expired. Start a new one?");

  // Ordering: the client increments. Anything but the next turn is a stale device.
  if (turnSeq !== s.turn_seq + 1) {
    void trackUser(env, ctx.uid, email, "compose_turn_stale", APP, {
      session_id: sessionId, sent_turn_seq: turnSeq, server_turn_seq: s.turn_seq,
    });
    // Hand back the current draft AND turn_seq — otherwise the client is told "no"
    // forever, with nothing to resync to (§3.3c).
    return sseStale(
      "Another device moved this draft on. Reloading…",
      await currentState(env, sessionId, ctx.uid),
    );
  }

  const draft = parseDraft(s.draft_json, s.lang ?? "en");
  const transcript = parseTranscript(s.transcript);
  // Mutable: set_category may re-pin this mid-turn (see CatRef).
  const catRef: CatRef = {
    cat: s.category ? await resolveCategoryVersion(env, s.category, s.cat_version).catch(() => null) : null,
  };

  // ── §3.1 pushback → the APPROVED paragraph, verbatim. No model improvisation ──
  let identityOk = true;
  try { identityOk = (await livenessState(env, ctx.uid)).valid; } catch { identityOk = false; }
  if (!identityOk && isWhyVerifyQuestion(text)) {
    const say = await localiseApproved(env, ctx.uid, APPROVED_WHY_VERIFY, s.lang ?? "en");
    const events: Event[] = [
      { t: "say", text: say },
      { t: "chips", chips: ["Verify now", "How does it work?", "Later"] },
    ];
    await persistTurn(env, s, draft, [
      ...transcript,
      { role: "user" as const, text: stripPiiFast(text) },
      { role: "ava" as const, text: say },
    ], idemKey, events);
    void trackUser(env, ctx.uid, email, "compose_identity_explained", APP, {
      session_id: sessionId, canned: true, lang: s.lang ?? "en",
    });
    return sse(events);
  }

  // ── Photos the user attached with this turn (idempotent by content hash) ─────
  const outcomes: ToolOutcome[] = [];
  if (mediaHashes.length) {
    outcomes.push(await runTool(env, ctx.uid, { tool: "attach_media", args: { hashes: mediaHashes } }, draft, catRef, s));
  }

  // ── Build the prompt. promptView() is the never_disclose firewall (§3.6b) ────
  const recent = transcript.slice(-MAX_TRANSCRIPT_TURNS);
  // Only while unchosen: the model cannot call set_category with an id it was never
  // shown, and a model guessing ids is a model calling propose_category for "cars".
  // Once a category is pinned the list is dead weight in every subsequent prompt.
  const choices = s.category ? [] : await listCategories(env, draft.vertical);
  const context = [
    `CATEGORY: ${s.category ?? "(not chosen yet — call set_category with one of the CATEGORIES ids below)"}`,
    choices.length
      ? `CATEGORIES (the only valid set_category ids, vertical "${draft.vertical}"):\n` +
        choices.map((c) => `- ${c.id}${c.label ? ` — ${c.label}` : ""} [${c.intent}]`).join("\n") +
        "\nIf the user's thing genuinely fits none of these, call propose_category — never invent an id."
      : "",
    catRef.cat?.field_schema ? `FIELD SCHEMA (the only valid set_fields keys):\n${JSON.stringify(catRef.cat.field_schema)}` : "",
    `CURRENT DRAFT (the server's copy — the truth):\n${JSON.stringify(promptView(draft))}`,
    outcomes.length ? `RESULTS OF WHAT YOU JUST DID:\n${outcomes.map((o) => `- ${o.note}`).join("\n")}` : "",
    recent.length ? `RECENT CONVERSATION:\n${recent.map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`).join("\n")}` : "",
    `USER SAYS: ${text || "(they sent media only)"}`,
    `Reply in this language: ${s.lang ?? "en"}`,
  ].filter(Boolean).join("\n\n");

  // Tripwire. If this ever fires we do NOT call the model — a lost turn is trivial
  // next to a leaked secret — and it is reported loudly, because a silent leak here
  // is the one failure in this file that cannot be walked back.
  try {
    assertNoVaultLeak(PLAYBOOK + context, draft.vault);
  } catch {
    void trackUser(env, ctx.uid, email, "compose_vault_leak_blocked", APP, { session_id: sessionId });
    return sseError("internal", "Something went wrong on my side — say that again?");
  }

  // ── The gateway. verb:"reason". NEVER callSonnet, never a raw provider fetch ──
  // FAST MODEL PIN + TIMEOUT (owner decision 2026-07-18: "use a fast model like groq,
  // forget gemma"). Without a pin the "reason" ladder routes to the Workers-AI
  // reasoner (@cf/google/gemma-4-26b, 26B) as PRIMARY and only falls back on
  // error/429, NOT on slowness — so on this large compose prompt gemma-4 hung as
  // "Ava is thinking…" with no timeout. Pin a FAST Groq-served model via OpenRouter
  // (Groq runs Llama-3.3-70b at ~1s; OpenRouter routes this id to Groq/the fastest
  // provider — no new key or adapter, the marketplace already uses OpenRouter).
  // legacyModel → a single OpenRouter call, no ladder. Env-overridable via
  // COMPOSE_MODEL so the model can be tuned in wrangler vars without a code change.
  // timeoutMs caps a slow provider to a graceful "say that again?" instead of an
  // infinite spinner; parseModelTurn() has a regex JSON backstop for imperfect output.
  const composeModel = String((env as any).COMPOSE_MODEL ?? "").trim() || "meta-llama/llama-3.3-70b-instruct";
  let raw = "";
  try {
    raw = await avaReason(env, {
      role: "marketplace", capability: "compose_listing", trigger: "compose_turn",
      verb: "reason", feature: "compose", uid: ctx.uid, email,
      legacyModel: composeModel, timeoutMs: 30000,
      system: PLAYBOOK, user: context,
      // maxTokens 900→420 (2026-07-18 latency): a compose turn is a short question
      // + a small tool_calls array; 900 let the model run far longer than it ever
      // needs and generation time scales with tokens produced. 420 covers even a
      // set_core turn that writes a title+description. Faster total, no truncation.
      json: true, maxTokens: 420, temperature: 0.4, appName: APP,
    });
  } catch (e: any) {
    void trackUser(env, ctx.uid, email, "compose_turn_model_error", APP, {
      session_id: sessionId, error: String(e?.message ?? e).slice(0, 200),
    });
    // The draft is untouched — the server holds it, so a failed turn costs a turn,
    // not the user's work. That is the whole point of §3.3.
    return sseError("model_unavailable", "I lost my train of thought there — say that again?");
  }

  const turn = parseModelTurn(raw);

  // ── Execute the proposed tools. The model proposed; the SERVER decides ───────
  let ready = false;
  let priceData: Record<string, unknown> | null = null;
  for (const call of turn.tool_calls) {
    const r = await runTool(env, ctx.uid, call, draft, catRef, s);
    outcomes.push(r);
    if (call.tool === "ready_to_publish" && r.ready) ready = true;
    if (r.data?.comparables) priceData = r.data;
  }

  // catRef, not `cat`: if set_category landed in this turn, THIS is the schema the
  // answers must be judged against.
  const v = validateAttrs(catRef.cat?.field_schema ?? null, draft.attrs);
  const missing = missingFor(draft, v.missing, s);
  if (missing.length) ready = false; // the model does not get the last word on this

  const say = turn.say || "Got it.";
  const events: Event[] = [{ t: "say", text: say }];
  // rev/turn_seq are the values persistTurn is about to write — the same predicted-rev
  // convention the review card already uses. If the write loses its race the client
  // gets a stale_session carrying the real numbers instead, so it is never left
  // believing these.
  events.push({
    t: "draft", progress: progressOf(draft, missing), missing,
    rev: s.rev + 1, turn_seq: s.turn_seq + 1,
  });
  if (turn.chips.length) events.push({ t: "chips", chips: turn.chips });
  if (ready) events.push({ t: "review", card: reviewCard(draft, { ...s, rev: s.rev + 1 }) });

  const nextTranscript = [
    ...transcript,
    { role: "user" as const, text: stripPiiFast(text) },
    { role: "ava" as const, text: stripPiiFast(say) },
  ].slice(-MAX_TRANSCRIPT_TURNS * 2);

  const wrote = await persistTurn(env, s, draft, nextTranscript, idemKey, events);
  if (!wrote) {
    // rev moved under us — a second device wrote first. Converge, don't clobber: this
    // turn's work is discarded (the server holds the draft, so nothing is corrupted)
    // and the client re-renders from the winner's state. No idem row was written, so a
    // retry of this same idem_key re-runs honestly rather than replaying a "success"
    // for a draft that never advanced.
    void trackUser(env, ctx.uid, email, "compose_turn_conflict", APP, { session_id: sessionId, rev: s.rev });
    return sseStale(
      "Another device moved this draft on. Reloading…",
      await currentState(env, sessionId, ctx.uid),
    );
  }

  void trackUser(env, ctx.uid, email, "compose_turn", APP, {
    session_id: sessionId, turn_seq: turnSeq, category: s.category,
    tools: turn.tool_calls.map((t) => t.tool), tool_failures: outcomes.filter((o) => !o.ok).length,
    cat_version: s.category ? s.cat_version : null, vertical: draft.vertical,
    missing_count: missing.length, ready, has_media: mediaHashes.length > 0,
    priced: !!priceData, comparables_n: (priceData?.comparables as any)?.n ?? null,
    identity_ok: identityOk, lang: s.lang ?? "en",
  });
  return sse(events);
}

/**
 * Persist the turn: draft + category pin + transcript + the stored response, under an
 * optimistic `rev` assertion. Returns false when the rev moved (409 territory).
 *
 * ORDER MATTERS, AND IT IS THE REV-GUARDED UPDATE FIRST.
 *
 * The idem row is the answer to "what happened when you ran this turn?", so it may only
 * be written once that question has an answer. Writing it first — as this did — stores
 * "here are your say/draft/review events" and only *then* discovers the UPDATE lost the
 * race: the live caller correctly gets `stale_session`, but a retry of the same
 * idem_key replays a fabricated success for a draft that never advanced, and the client
 * renders a turn that does not exist on the server. §3.3c's requirement is that a
 * replay be indistinguishable from the original; a replay of a turn that never happened
 * is indistinguishable from nothing at all.
 *
 * Writing it second makes both failure directions safe:
 *   • UPDATE loses → no idem row → a retry re-runs and honestly loses again (or, if the
 *     winner has since moved on, returns the current state). Costs a model call; never
 *     lies.
 *   • UPDATE wins, idem INSERT is lost (crash/outage) → a retry re-runs, then fails the
 *     rev guard (rev has moved past `s.rev`) → `stale_session` + the current draft. The
 *     turn is NOT applied twice. Failing toward "converge on the truth" is the only
 *     direction worth failing in here.
 *
 * `category`/`cat_version` ride the same statement as the draft — set_category mutated
 * `s` in place — so the pin and the answers collected under it commit atomically or not
 * at all. A category written outside the rev guard could survive a turn that lost.
 */
async function persistTurn(
  env: Env, s: SessionRow, draft: ComposeDraft, transcript: TranscriptTurn[],
  idemKey: string, events: Event[],
): Promise<boolean> {
  const now = Date.now();
  let wrote = false;
  try {
    const r = await metaDb(env).prepare(
      `UPDATE listing_compose_sessions
          SET draft_json=?3, transcript=?4, category=?6, cat_version=?7,
              turn_seq=turn_seq+1, rev=rev+1, updated_at=?5
        WHERE session_id=?1 AND rev=?2 AND status='active'`,
    ).bind(
      s.session_id, s.rev, JSON.stringify(draft), JSON.stringify(transcript), now,
      s.category ?? null, s.cat_version,
    ).run();
    wrote = Number((r as any)?.meta?.changes ?? 0) > 0;
  } catch {
    return false;
  }
  if (!wrote) return false;

  try {
    await metaDb(env).prepare(
      "INSERT OR IGNORE INTO listing_compose_turns (session_id, idem_key, response, created_at) VALUES (?1,?2,?3,?4)",
    ).bind(s.session_id, idemKey, JSON.stringify(events), now).run();
  } catch { /* the turn IS applied; a lost idem row only costs a retry a model call */ }
  return true;
}

// ---------------------------------------------------------------------------
// 3. POST /api/marketplace/compose/publish
// ---------------------------------------------------------------------------

/**
 * The ONLY path that creates a live listing. An explicit USER action on the review
 * card — never a model decision (§3.3).
 *
 * Body: { session_id, rev? }
 * → 200 { listing_id }
 * → 403 { error:"identity_required", reason, action }
 * → 422 { field, reason, message }
 * → 503 { error:"moderation_unavailable" }
 * → 409 { error:"stale_session" }
 *
 * §7.1 — MODERATION FAILS CLOSED HERE. This is a DELIBERATE divergence from
 * lib/moderation.ts's fail-open posture (`ok:false` ⇒ safe:true), and the divergence
 * is the point: a listing is durable public content produced at machine speed, so a
 * classifier outage must not become a publishing window. `moderate()` reports
 * `ok:false` on a missing key / non-2xx / timeout — we return 503 and the user
 * retries. The cost of failing closed is a retry; the cost of failing open is
 * whatever got published while the classifier was down.
 */
export async function composePublish(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await composeEnabled(env))) {
    void track(env, ctx.uid, "compose_blocked", APP, { reason: "flag_off", status: 503 });
    return flagOff();
  }

  const b = (await req.json().catch(() => ({}))) as any;
  const sessionId = String(b.session_id ?? "").trim();
  if (!sessionId) return json({ error: "bad_request", message: "session_id is required" }, 400);
  const clientRev = toInt(b.rev);
  const db = metaDb(env);
  const email = await emailOf(env, ctx.uid).catch(() => null);

  let s: SessionRow | null = null;
  try {
    s = await db.prepare(
      `SELECT session_id, uid, listing_id, category, cat_version, lang, draft_json, transcript,
              turn_seq, rev, status, created_at, updated_at, expires_at
         FROM listing_compose_sessions WHERE session_id=?1 AND uid=?2`,
    ).bind(sessionId, ctx.uid).first<SessionRow>();
  } catch (e: any) {
    return json({ error: "compose_unavailable", detail: String(e?.message ?? e).slice(0, 200) }, 503);
  }
  if (!s) return json({ error: "not_found" }, 404);
  if (s.status !== "active") {
    return json({ error: "stale_session", reason: s.status, listing_id: s.listing_id }, 409);
  }
  if (clientRev !== null && clientRev !== s.rev) {
    void trackUser(env, ctx.uid, email, "compose_publish_stale", APP, {
      session_id: sessionId, client_rev: clientRev, server_rev: s.rev,
    });
    // §3.3c — WITH the current draft. A user who taps Publish on a card another device
    // has moved on from must be shown what the listing now says, not just told "no":
    // the whole point of the review card is informed consent to publish, and `rev`
    // alone gives them nothing to re-consent to.
    const st = await currentState(env, sessionId, ctx.uid);
    return json({
      error: "stale_session", rev: s.rev,
      ...(st ? { turn_seq: st.turn_seq, progress: st.progress, missing: st.missing, draft: st.card } : {}),
    }, 409);
  }

  // ── The gate, at the WRITE. 403 identity_required — the client's contract ────
  const gate = await gatePublicAction(env, ctx.uid, email, "listing");
  if (gate) {
    void trackUser(env, ctx.uid, email, "compose_publish_gated", APP, { session_id: sessionId });
    return gate;
  }

  const draft = parseDraft(s.draft_json, s.lang ?? "en");
  const cat = s.category ? await resolveCategoryVersion(env, s.category, s.cat_version).catch(() => null) : null;

  // ── 422: completeness, against the PINNED schema ─────────────────────────────
  const v = validateAttrs(cat?.field_schema ?? null, draft.attrs);
  if (v.violations.length) {
    const bad = v.violations[0];
    return json({ field: bad.k, reason: bad.code, message: bad.detail }, 422);
  }
  const missing = missingFor(draft, v.missing, s);
  if (missing.length) {
    return json({ field: missing[0], reason: "required", message: `${missing[0]} is still missing.` }, 422);
  }

  const title = String(draft.core.title ?? "").slice(0, 200);
  const description = String(draft.core.description ?? "").slice(0, 4000);

  // ── §7.1 FAIL-CLOSED moderation ─────────────────────────────────────────────
  // 1) Classify. `ok:false` = the classifier could not answer (no key / non-2xx /
  //    timeout). We do NOT fall through to publish on that.
  const [tm, dm] = await Promise.all([
    moderate(env, { text: title, field: "listing_title" }),
    description.trim() ? moderate(env, { text: description, field: "listing_desc" }) : Promise.resolve({ safe: true, ok: true, categories: [], reason: "", ms: 0 } as any),
  ]);
  if (!tm.ok || !dm.ok) {
    void trackUser(env, ctx.uid, email, "compose_publish_moderation_unavailable", APP, {
      session_id: sessionId, title_ok: tm.ok, desc_ok: dm.ok,
    });
    return json({
      error: "moderation_unavailable",
      message: "I can't run the safety check right now, so I won't publish yet. Try again in a minute.",
    }, 503);
  }
  if (!tm.safe) return json({ field: "title", reason: "moderation", message: tm.reason || "That title isn't allowed." }, 422);
  if (!dm.safe) return json({ field: "description", reason: "moderation", message: dm.reason || "That description isn't allowed." }, 422);

  // 2) guardWrite — the same save-time gate every other public write uses. Both are
  //    mandatory: the precheck above is ours, this is the shared contract.
  const blocked = await guardWrite(req, env, ctx.uid, APP, [
    { text: title, field: "listing_title" },
    { text: description, field: "listing_desc" },
  ]);
  if (blocked) return blocked;

  // 3) PII strip (§3.3b — contact stays in AvaTOK).
  const cleanDesc = await redactContact(env, ctx.uid, description);

  // ── ATOMIC PUBLISH (§3.3c) ──────────────────────────────────────────────────
  // Claim the session with a single conditional write. A double-tapped publish
  // button loses the race on the second tap and publishes ONCE. The transcript is
  // nulled in the same statement — §3.3b: the listing is the artifact, the
  // conversation is packaging, and it does not outlive the draft.
  const listingId = crypto.randomUUID();
  const now = Date.now();
  let claimed = false;
  try {
    const r = await db.prepare(
      `UPDATE listing_compose_sessions
          SET status='published', listing_id=?3, transcript='[]', rev=rev+1, updated_at=?4
        WHERE session_id=?1 AND status='active' AND rev=?2`,
    ).bind(sessionId, s.rev, listingId, now).run();
    claimed = Number((r as any)?.meta?.changes ?? 0) > 0;
  } catch (e: any) {
    return json({ error: "compose_unavailable", detail: String(e?.message ?? e).slice(0, 200) }, 503);
  }
  if (!claimed) {
    const cur = await db.prepare("SELECT listing_id, rev FROM listing_compose_sessions WHERE session_id=?1")
      .bind(sessionId).first<any>();
    // If the loser lost to a PUBLISH, `listing_id` is the answer it needs and there is
    // no draft to converge on. If it lost to a concurrent turn, hand back the draft
    // (§3.3c) so it re-renders instead of re-tapping into the same race.
    const st = cur?.listing_id ? null : await currentState(env, sessionId, ctx.uid);
    return json({
      error: "stale_session", rev: cur?.rev ?? null, listing_id: cur?.listing_id ?? null,
      ...(st ? { turn_seq: st.turn_seq, progress: st.progress, missing: st.missing, draft: st.card } : {}),
    }, 409);
  }

  // [AVA-MKT-ENTITLEMENTS-1] §5 quota + §1.3 charge — AFTER moderation passed (the
  // fail-closed 422/503 gates above already returned), and AFTER the atomic claim, so we
  // only ever charge the WINNING publish of this session (a double-tapped Publish loses
  // the claim on the second tap and never reaches here). Keyed on the fresh listingId
  // with period=1 (§3.3c): the wallet debit dedupes on op_id `${listingId}:1` and the
  // entitlement row dedupes on the (listing_id, 1) PK.
  //
  // On failure we ROLL THE CLAIM BACK to 'active' (same posture as the listings-INSERT
  // failure path below) so the draft is not stranded in 'published' with no listing, then
  // return 402/503 without publishing — the draft stays safe, exactly like the 503
  // moderation path. Nothing charged, nothing published.
  const ent = await consumeListingEntitlement(env, {
    uid: ctx.uid, listingId, vertical: draft.vertical, period: 1,
  });
  if (!ent.ok) {
    try {
      await db.prepare(
        "UPDATE listing_compose_sessions SET status='active', listing_id=NULL, updated_at=?2 WHERE session_id=?1 AND status='published'",
      ).bind(sessionId, Date.now()).run();
    } catch { /* best-effort — the listing was never inserted regardless */ }
    if (ent.error === "insufficient_funds") {
      void trackUser(env, ctx.uid, email, "compose_publish_insufficient_funds", APP, {
        session_id: sessionId, needed: ent.needed,
      });
      return json({ error: "insufficient_funds", needed: ent.needed, feature: "listing_post" }, 402);
    }
    void trackUser(env, ctx.uid, email, "compose_publish_charge_failed", APP, { session_id: sessionId });
    return json({
      error: "billing_unavailable",
      message: "I can't complete the listing charge right now, so I won't publish yet. Try again in a minute.",
    }, 503);
  }

  // §2.3 — `other` is the ESCAPE HATCH, reached only when the model found nothing in
  // the taxonomy and said so via propose_category. It is not the default: a session
  // with neither a category nor a proposal was rejected as `missing: ["category"]`
  // above, rather than silently misfiled here. (Before set_category existed,
  // `s.category` was structurally always NULL and EVERY compose listing published as
  // "other" — the taxonomy, the field schemas and the version pins all quietly unused.)
  const category = s.category ?? "other";
  const currency = String(draft.core.currency ?? "USD").toUpperCase();
  const attrsJson = JSON.stringify({
    ...draft.attrs,
    // §3.6b — the mandate's model-visible halves live in attrs.mandate.
    mandate: {
      public_agent_brief: draft.mandate.public_agent_brief ?? null,
      seller_private_rules: draft.mandate.seller_private_rules ?? null,
      must_haves: draft.mandate.must_haves ?? null,
    },
    // §3.7 — English-canonical + the original, so buyers whose locale matches read
    // what the seller actually wrote.
    orig_lang: draft.lang,
    ...(draft.video ? { video_id: draft.video.video_id, video_title: draft.video.title, video_thumbnail: draft.video.thumbnail } : {}),
  });

  // §2.4 — cat_version was PINNED WHEN THE CATEGORY WAS CHOSEN (set_category), which is
  // the earliest moment it can mean anything: at session start there is no category, so
  // there is no version of it to pin. From that moment the field_schema cannot shift
  // under the conversation, and this is the version the listing is born with.
  // playbook/template are not used while composing, so they pin at BIRTH — which is
  // now — exactly as createListing does. Unresolvable ⇒ 1, which
  // is the DEFAULT the migration back-fills, so the fallback and the migration agree
  // rather than inventing a third answer.
  let pbV = 1, tplV = 1;
  try {
    const cv = await metaSession(env).prepare(
      "SELECT playbook_version, template_version FROM listing_categories WHERE id=?1",
    ).bind(category).first<any>();
    pbV = Number(cv?.playbook_version ?? 1) || 1;
    tplV = Number(cv?.template_version ?? 1) || 1;
  } catch { /* pre-migration columns — 1/1 matches the back-fill */ }

  try {
    await db.prepare(
      `INSERT INTO listings (id, creator_id, kind, title, description, category, price, currency_display,
         country, location, cover_media, status, created_at, updated_at,
         agent_lang, market_type, expiry_days, vertical, attrs, video_url, proposed_category,
         cat_version, playbook_version, template_version,
         public_agent_brief, seller_private_rules, never_disclose, floor_price, ask_before_commit)
       VALUES (?1,?2,'sell',?3,?4,?5,?6,?7,?8,?9,?10,'published',?11,?11,?12,'sell',?13,?14,?15,?16,?17,
               ?18,?19,?20,?21,?22,?23,?24,?25)`,
    ).bind(
      listingId, ctx.uid, title || "Untitled", cleanDesc || null, category,
      draft.core.price ?? 0, currency, draft.core.country ?? null, draft.core.location ?? null,
      draft.cover_media ?? null, now,
      draft.mandate.agent_lang ?? draft.lang, draft.expiry_days ?? null,
      // §2.0 — the vertical the session was opened in, not a constant: set_category
      // already refused any id outside it, so the listing cannot cross verticals.
      draft.vertical, attrsJson, draft.video?.video_url ?? null, draft.proposed_category ?? null,
      s.cat_version, pbV, tplV,
      draft.mandate.public_agent_brief ?? null,
      draft.mandate.seller_private_rules ?? null,
      // The vault reaches D1 in its OWN column so it is trivially auditable that no
      // code path reads it into a prompt (§3.6b). Nothing in this file, and nothing
      // in the agent runtime's context builder, selects it.
      draft.vault.never_disclose ?? null,
      draft.constraints.floor_price ?? null,
      draft.constraints.ask_before_commit ? 1 : 0,
    ).run();
  } catch (e: any) {
    // The claim succeeded but the listing did not land. Release the session back to
    // active so the user can retry, rather than stranding them with a 'published'
    // session and no listing.
    try {
      await db.prepare(
        "UPDATE listing_compose_sessions SET status='active', listing_id=NULL, updated_at=?2 WHERE session_id=?1 AND status='published'",
      ).bind(sessionId, Date.now()).run();
    } catch { /* best-effort */ }
    void trackUser(env, ctx.uid, email, "compose_publish_failed", APP, {
      session_id: sessionId, error: String(e?.message ?? e).slice(0, 200),
    });
    return json({ error: "publish_failed", message: "I couldn't publish that — try again?" }, 503);
  }

  // Index it for search. listings.ts owns `ftsSync`, but it is module-private and
  // that file belongs to another agent, so the row is written here directly — the
  // same two statements, against the same columns. WITHOUT this a compose-published
  // listing is invisible to /api/explore/search: it exists, the seller can see it,
  // and no buyer can ever find it. Best-effort: a listing that published must not be
  // un-published by an index wobble.
  try {
    await db.prepare("DELETE FROM listings_fts WHERE listing_id=?1").bind(listingId).run();
    const who = await metaSession(env).prepare("SELECT display_name, handle FROM users WHERE uid=?1")
      .bind(ctx.uid).first<any>();
    await db.prepare(
      "INSERT INTO listings_fts (listing_id, title, description, creator_name, category) VALUES (?1,?2,?3,?4,?5)",
    ).bind(listingId, title, cleanDesc ?? "", `${who?.display_name ?? ""} ${who?.handle ?? ""}`.trim(), category).run();
  } catch { /* search index is rebuildable; the listing is the artifact */ }

  // §3.3b — ONLY the finished listing is ingested (domain `listings`). The
  // transcript is NEVER passed to brainIngest and compose is NOT a brain domain.
  // The scratch never becomes memory.
  void brainIngest(env, {
    uid: ctx.uid, domain: "listings", kind: "listing_published", sourceId: listingId,
    text: `Published listing "${title}"`,
    meta: { category, price: draft.core.price ?? 0, currency, country: draft.core.country ?? null, via: "compose" },
  });

  void trackUser(env, ctx.uid, email, "listing_published", APP, {
    listing_id: listingId, session_id: sessionId, via: "compose", category,
    cat_version: s.cat_version, price: draft.core.price ?? 0, currency,
    photo_count: draft.media.length, has_video: !!draft.video,
    has_floor: draft.constraints.floor_price != null,
    has_never_disclose: !!draft.vault.never_disclose,
    proposed_category: draft.proposed_category ?? null, turns: s.turn_seq, lang: draft.lang,
  });
  return json({ listing_id: listingId });
}
