// [OG-AD-HOOK-1 2026-09-26, owner decision] The share card is an AD.
//
// When a Saathum link is shared on WhatsApp, the chat already prints og:title and
// og:description UNDER the image — so a card that repeats them wastes the one
// spot a person actually looks at. The owner asked for the text ON the image to
// be a one-or-two-line ad that "draws attention and touches religious sentiment",
// written by AI for every listing, e.g. "Join Saraswati Havan online for education".
//
// This module writes that line and stores it as `attrs.ad_hook`:
//   { text, source: 'ai' | 'rules' | 'admin', at }
// The web OG renderer (web/src/lib/seo/og/template.ts) reads it and prints it big,
// with the listing's REAL price beside it — the model never writes a price.
//
// Copy rules (same as the ritual guide, owner brief): devotional, warm, positive;
// NO guaranteed outcomes, NO fear selling, NO medical claims, NO invented facts
// (price, date, priest names). Anything the model returns that breaks a rule is
// discarded and the deterministic line is used instead — a missing AI never
// leaves a listing without a hook, and never publishes a bad one.
//
// Storage: `ad_hook` is a RESERVED attrs key (routes/listings.ts
// RESERVED_ATTRS_KEYS) — a creator PUT can neither forge nor erase it, and it is
// excluded from reviewedContentHash so writing it never makes a review stale.
// Writes use json_set on the stored row so they never clobber a concurrent
// poster/admin write to other attrs keys.
import type { Env } from "../types";
import { avaReason } from "./ava_reason";
import { guardInput, guardOutput } from "./ai_gate";
import { track, trackException } from "../hooks";
import { readConfig } from "../routes/config";

export type AdHook = { text: string; source: "ai" | "rules" | "admin"; at: number };

const MAX_CHARS = 80;
// Words that turn devotion into a promise or a threat. Case-insensitive, whole words.
const BANNED = /\b(guarantee[ds]?|guaranteed|100%|cure[ds]?|heal(?:s|ed)?|remove[sd]? (?:all )?(?:dosh|evil)|evil eye|curse[ds]?|black magic|danger|fear|disaster|miracle|instant(?:ly)?|assured|sure[- ]shot|money[- ]back)\b/i;

function clean(raw: string): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/^["'“”‘’\s-]+|["'“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A hook is acceptable only if it is short, has no digits (the price is printed
 *  separately from the real listing row), and makes no promise or threat. */
export function acceptableHook(text: string): boolean {
  const t = clean(text);
  return t.length >= 12 && t.length <= MAX_CHARS && !/\d|₹|rs\.?\s/i.test(t) && !BANNED.test(t) && !/https?:|www\./i.test(t);
}

/** Deterministic floor — always valid, never invents anything. */
export function rulesHook(row: Record<string, any>): string {
  const title = clean(String(row.title ?? "")).replace(/\s*[·|—-]\s*Saathum$/i, "");
  const short = title.length > 44 ? title.slice(0, 44).replace(/\s+\S*$/, "") : title;
  const hook = short ? `Join the ${short} live, from your home` : "Join a sacred havan live, from your home";
  return hook.length <= MAX_CHARS ? hook : "Join a sacred havan live, from your home";
}

function prompt(row: Record<string, any>): { system: string; user: string } {
  const system = [
    "You write the one-line headline printed on a WhatsApp share image for Saathum, an Indian service where temple priests perform havans and pujas that devotees join live online.",
    "Write ONE line, 5 to 11 words, max 70 characters, in warm devotional English (a single common Hindi word like 'ashirwad' or 'Maa' is fine).",
    "It must make a devotee want to join: name the deity or ritual, and the blessing people traditionally seek from it.",
    "Rules: no promises or guaranteed results, no fear or threats, no health cures, no numbers or prices, no dates, no emojis, no hashtags, no quotes.",
    "Only use facts present in the listing. Reply with the line only.",
  ].join(" ");
  const user = [
    `Title: ${clean(String(row.title ?? "")).slice(0, 120)}`,
    `Category: ${clean(String(row.category ?? "")).slice(0, 60)}`,
    `Summary: ${clean(String(row.blurb ?? "")).slice(0, 200)}`,
    `Description: ${clean(String(row.description ?? "")).slice(0, 700)}`,
  ].join("\n");
  return { system, user };
}

/** Writes (does not store) the hook for a listing row. Never throws. */
export async function writeAdHook(env: Env, uid: string, row: Record<string, any>): Promise<AdHook> {
  const now = Date.now();
  const floor: AdHook = { text: rulesHook(row), source: "rules", at: now };
  let status = "ok";
  try {
    const cfg = await readConfig(env);
    if (!(cfg.aiEnabled && (cfg as any).listingAiReviewEnabled !== false)) { status = "disabled"; return floor; }
    const { system, user } = prompt(row);
    const gate = await guardInput(env, user);
    if (!gate.ok) { status = "input_blocked"; return floor; }
    const raw = await avaReason(env, {
      role: "listing", capability: "listing_ad_hook", trigger: "listing_submit",
      feature: "listing_ad_hook", uid, system, user, temperature: 0.6, maxTokens: 80, timeoutMs: 12000,
    });
    const text = clean(String(raw ?? "").split("\n")[0] ?? "");
    if (!acceptableHook(text)) { status = text ? "rejected_rules" : "empty"; return floor; }
    const out = await guardOutput(env, text);
    if (!out.ok) { status = "output_blocked"; return floor; }
    return { text, source: "ai", at: now };
  } catch (e) {
    status = "error";
    try { void trackException(env, e, { uid, handled: true, app_name: "listings", extra: { feature: "listing_ad_hook", listing_id: row.id ?? null } }); } catch { /* best-effort */ }
    return floor;
  } finally {
    try { void track(env, uid, "listing_ad_hook_written", "listings", { listing_id: row.id ?? null, ai_status: status }); } catch { /* best-effort */ }
  }
}

/**
 * Re-reads the row, writes a hook and stores it — unless an admin set one by
 * hand (source 'admin'), which AI never overwrites. `force` regenerates an
 * existing AI/rules hook (used after the title/description change).
 */
export async function ensureListingAdHook(env: Env, listingId: string, uid: string, opts: { force?: boolean } = {}): Promise<void> {
  try {
    const db = env.DB_META;
    const row = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(listingId).first<any>();
    if (!row) return;
    let attrs: any = {};
    try { attrs = row.attrs ? JSON.parse(String(row.attrs)) : {}; } catch { attrs = {}; }
    const existing = attrs?.ad_hook as AdHook | undefined;
    if (existing?.source === "admin") return;
    if (existing?.text && !opts.force) return;
    const hook = await writeAdHook(env, uid, row);
    await db.prepare(
      "UPDATE listings SET attrs=json_set(COALESCE(NULLIF(attrs,''),'{}'),'$.ad_hook',json(?2)) WHERE id=?1",
    ).bind(listingId, JSON.stringify(hook)).run();
  } catch (e) {
    try { await trackException(env, e, { uid, handled: true, app_name: "listings", extra: { feature: "listing_ad_hook_store", listing_id: listingId } }); } catch { /* best-effort */ }
  }
}

/** Validates an admin-typed hook. Returns the stored shape, or an error message. */
export function adminHook(value: unknown): AdHook | { error: string } {
  const text = clean(String(value ?? ""));
  if (!text) return { error: "The ad line cannot be empty." };
  if (text.length > MAX_CHARS) return { error: `Keep the ad line under ${MAX_CHARS} characters.` };
  if (/\d|₹/.test(text)) return { error: "Leave the price out — the card prints the listing's real price next to the ad line." };
  if (BANNED.test(text)) return { error: "The ad line cannot promise results or use fear words." };
  return { text, source: "admin", at: Date.now() };
}
