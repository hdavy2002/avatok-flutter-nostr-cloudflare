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
 * Sections nothing can be published into.
 *
 * [MARKET-SECTION-2 2026-08-31, owner decision] Live friends, adda rooms and
 * glow-up now have categories of their own (migration
 * 2026-08-31-bazaar-session-categories.sql) and resolve in `sectionFor`, so the
 * set is EMPTY and the client stops marking them "SOON".
 *
 * It is kept rather than deleted because it is the honest place to record a
 * section that exists in the design but cannot be reached — that state is
 * indistinguishable on screen from "nobody has published one yet", and only one
 * of the two is a bug.
 */
export const SECTIONS_WITHOUT_A_SOURCE: ReadonlySet<string> = new Set([]);

/**
 * Sections whose delivery depends on a platform flag being on.
 *
 * ⚠️ ADDA ROOMS NEED GROUP CALLING, AND `conferenceEnabled` IS `false` IN
 * PRODUCTION (read from the live config on 2026-08-31, not from DEFAULTS). A
 * booked adda room is a room nobody can join, which is a money bug the moment
 * `billingEnabled` and `walletRealMoney` are turned on.
 *
 * So the CATEGORY exists — a creator can see it, and the section fills the
 * instant the flag flips — but `publishBlockedReason` refuses to publish into it
 * while the flag is off, with a message rather than a silent failure at session
 * time. Do not "simplify" this away to make the category work; the flag is the
 * only thing standing between a listing and an undeliverable sale.
 */
export const SECTION_REQUIRES_FLAG: Readonly<Record<string, string>> = {
  adda_rooms: "conferenceEnabled",
};

/**
 * Why this section cannot be published into right now, or null if it can.
 * `flags` is the platform config the caller already read — this helper does no
 * I/O of its own so it cannot become a per-publish config fetch.
 */
export function publishBlockedReason(
  section: string,
  // `unknown` rather than a mapped type: PlatformConfig is a closed interface
  // with no index signature, so it is not assignable to Record<string, unknown>.
  // Importing PlatformConfig here would make the taxonomy module depend on the
  // config route's shape just to read one boolean, so the cast stays local.
  flags: unknown,
): string | null {
  const needs = SECTION_REQUIRES_FLAG[section];
  if (!needs) return null;
  if ((flags as Record<string, unknown> | null)?.[needs] === true) return null;
  return section === "adda_rooms"
    ? "Adda rooms need group calling, which is currently switched off. Your listing can be saved as a draft and published when it is back on."
    : `This section needs ${needs}, which is currently switched off.`;
}

/** Categories that read as a divination practice rather than a subject. */
const ASTRO_CATEGORIES = new Set(["astrologers"]);

/** Categories that ARE a section — the bazaar session types [MARKET-SECTION-2]. */
const SECTION_CATEGORIES: Record<string, Section> = {
  live_friends: "live_friends",
  adda_rooms: "adda_rooms",
  glow_up: "glow_up",
};

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

  // [MARKET-SECTION-2] A session category names its section outright and wins
  // over kind — a glow-up sold as a 1:1 consult is a glow-up, not Consulting.
  if (c in SECTION_CATEGORIES) return SECTION_CATEGORIES[c];
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
