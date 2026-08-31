/**
 * [MARKET-SECTION-1 2026-08-31] The bazaar SECTIONS — the seven groups the
 * marketplace design organises listings into.
 *
 * ⚠️ A SECTION IS NOT A `vertical`. `listings.vertical` is 'commerce' | 'connect'
 * (the top-level marketplace/Connect split from [AVA-MKT-VERTICALS-1]); it
 * scopes categories and picks the listing fee key in lib/listing_billing.ts.
 * A section sits BELOW a vertical and ABOVE a category. Do not merge the two.
 *
 * This module is the ONE place the (kind, category) → section rule lives. It is
 * called at publish time and its result is stored in `listings.section`, so the
 * rule is applied once per listing rather than re-derived on every read. If you
 * change the rule here, re-run the backfill UPDATEs in
 * migrations/2026-08-31-listings-section.sql or existing rows keep the old
 * answer.
 */

export const SECTIONS = [
  "live_streaming",
  "live_friends",
  "adda_rooms",
  "astro_tarot",
  "ai_voice_agents",
  "consulting",
  "glow_up",
] as const;

export type Section = (typeof SECTIONS)[number];

/** Default for anything the rule cannot place. Matches the column default. */
export const DEFAULT_SECTION: Section = "live_streaming";

/**
 * Sections with no way to be published into yet — nothing in the (kind,
 * category) space means "live friend", "adda room" or "glow-up". They are real
 * products with a tile on the marketplace, so the client marks them "SOON"
 * rather than showing a silent zero. Remove an entry here the moment a kind or
 * category can actually resolve to it in `sectionFor`.
 */
export const SECTIONS_WITHOUT_A_SOURCE: ReadonlySet<string> = new Set([
  "live_friends",
  "adda_rooms",
  "glow_up",
]);

/** Categories that read as a divination practice rather than a subject. */
const ASTRO_CATEGORIES = new Set(["astrologers"]);

/**
 * Resolve a listing's section. Mirrors the backfill in the migration exactly —
 * if you edit one, edit both.
 *
 * Precedence: astro beats kind, because a tarot reading sold as a 1:1 consult is
 * still astro and the design gives it its own section.
 */
export function sectionFor(kind: string | null | undefined, category: string | null | undefined): Section {
  const k = String(kind ?? "").toLowerCase();
  const c = String(category ?? "").toLowerCase();

  if (ASTRO_CATEGORIES.has(c)) return "astro_tarot";
  if (k.startsWith("agent") || k === "ai_agent") return "ai_voice_agents";
  if (k.startsWith("consult")) return "consulting";
  if (k === "live_event" || k === "live" || k === "event") return "live_streaming";

  return DEFAULT_SECTION;
}

/** True when `v` names a real section — use before binding it into SQL. */
export function isSection(v: string | null | undefined): v is Section {
  return !!v && (SECTIONS as readonly string[]).includes(v);
}
