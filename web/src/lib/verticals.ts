/**
 * [MARKET-BAZAAR-2 / MARKET-SECTION-1] The seven bazaar SECTIONS — the groups
 * the marketplace design organises listings into.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A SECTION IS NOT A `vertical`. `listing.vertical` is 'commerce' | 'connect' —
 * the top-level marketplace/Connect split. It scopes categories and picks the
 * listing fee key server-side. A section sits BELOW a vertical and ABOVE a
 * category. The file is still named verticals.ts for import stability; the
 * concept it exports is `section`.
 *
 * WHAT CHANGED, AND WHY THIS FILE SHRANK
 *
 * This used to derive a section in the browser from (kind, category), because
 * the API had no such field. That meant the marketplace could not filter, count
 * or sort by it server-side, so the sidebar only ever narrowed the page already
 * fetched — with pagination it looked like it was hiding results, and the counts
 * described "this page" while reading like "the catalogue".
 *
 * `listings.section` is now a real, indexed column (worker migration
 * 2026-08-31-listings-section.sql), resolved once at publish time by
 * worker/src/lib/listing_section.ts and returned on every card. So the
 * derivation is GONE and this file is presentation only: labels, section copy,
 * display order.
 *
 * The server is the authority on which section a listing is in. Do not
 * reintroduce a client-side guess — two answers that disagree is worse than one
 * that is occasionally stale.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Card } from './types';

export type VerticalId =
  | 'live_streaming'
  | 'live_friends'
  | 'adda_rooms'
  | 'astro_tarot'
  | 'ai_voice_agents'
  | 'consulting'
  | 'glow_up';

export interface Vertical {
  id: VerticalId;
  /** Sidebar + tile label. */
  label: string;
  /** Tile sub-line — the comp's "PAWRI ZONE" flavour. */
  zone: string;
  /** Section eyebrow, e.g. "GROUP SHOWS · TICKETED". */
  eyebrow: string;
  /** Section heading, split so the second half can take the coral. */
  title: string;
  title2: string;
  /** The comp's handwritten aside for this section. Optional. */
  punch?: string;
}

/** Display order — the comp's order, top to bottom. */
export const VERTICALS: Vertical[] = [
  {
    id: 'live_streaming',
    label: 'Live streaming',
    zone: 'Pawri zone',
    eyebrow: 'Group shows · ticketed',
    title: 'Live streaming',
    title2: '& shows.',
    punch: 'Ye hamari pawri ho rahi hai!',
  },
  {
    id: 'live_friends',
    label: 'Live friends',
    zone: 'Dil ka scene',
    eyebrow: 'One-on-one · company',
    title: 'Live',
    title2: 'friends.',
  },
  {
    id: 'adda_rooms',
    label: 'Adda rooms',
    zone: 'Ajnabi zone',
    eyebrow: 'Drop in · group rooms',
    title: 'Adda',
    title2: 'rooms.',
    punch: 'Chai pe charcha, all night.',
  },
  {
    id: 'astro_tarot',
    label: 'Astro & tarot',
    zone: 'Sitare bolte hain',
    eyebrow: 'Readings · 1:1',
    title: 'Astro',
    title2: '& tarot.',
    punch: 'Sitare sab jaante hain.',
  },
  {
    id: 'ai_voice_agents',
    label: 'AI voice agents',
    zone: 'Robot dost',
    eyebrow: 'Always on · instant',
    title: 'AI voice',
    title2: 'agents.',
  },
  {
    id: 'consulting',
    label: 'Consulting',
    zone: 'Gyaan desk',
    eyebrow: 'Experts · booked',
    title: 'Consulting',
    title2: '& gyaan.',
    punch: 'Jo dhoondoge, wahi milega.',
  },
  {
    id: 'glow_up',
    label: 'Glow-up studio',
    zone: 'Full makeover',
    eyebrow: 'Style · coaching',
    title: 'Glow-up',
    title2: 'studio.',
  },
];

const BY_ID = new Map(VERTICALS.map((v) => [v.id, v]));

/**
 * Sections no listing can currently be published into — nothing in the (kind,
 * category) space resolves to them, so their count is permanently 0 until the
 * product exists. Mirrors SECTIONS_WITHOUT_A_SOURCE in the worker; keep the two
 * in step, and delete an entry from BOTH when the product ships.
 *
 * The point of naming them is that "empty because nobody has published one" and
 * "empty because it is unreachable by construction" look identical on screen,
 * and only one of them is a bug.
 */
export const VERTICALS_WITHOUT_A_SOURCE: ReadonlySet<VerticalId> = new Set([
  'live_friends',
  'adda_rooms',
  'glow_up',
]);

/** The section the SERVER assigned to this listing. Never a client-side guess. */
export function verticalOf(listing: Card): VerticalId | null {
  const s = listing.section;
  return s && BY_ID.has(s as VerticalId) ? (s as VerticalId) : null;
}

/**
 * Group listings into the display order above, skipping empty sections.
 *
 * Order comes from VERTICALS, not from the API's row order, so the page reads
 * the same way every time regardless of how the server happened to sort.
 */
export function groupByVertical(listings: Card[]): { vertical: Vertical; listings: Card[] }[] {
  const buckets = new Map<VerticalId, Card[]>();
  for (const l of listings) {
    const v = verticalOf(l);
    if (!v) continue;
    const arr = buckets.get(v);
    if (arr) arr.push(l);
    else buckets.set(v, [l]);
  }
  return VERTICALS.filter((v) => (buckets.get(v.id)?.length ?? 0) > 0).map((v) => ({
    vertical: v,
    listings: buckets.get(v.id) ?? [],
  }));
}
