/**
 * [MARKET-BAZAAR-2 2026-08-31] The seven bazaar VERTICALS — the taxonomy the
 * marketplace comp is built around (design/marketplace/avaTOK Marketplace.dc.html).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE USING IT: THIS IS A STOPGAP, AND IT IS DELIBERATELY VISIBLE.
 *
 * A vertical is NOT a field the API has. `/api/explore` returns a `kind`
 * (`live_event`, `consult_1to1`, …) and a `category` from a 25-entry CLASSIFIEDS
 * taxonomy (teachers, cars, property_rent, mobiles, jobs_hiring …). The comp's
 * verticals are a LIVE-CREATOR taxonomy (adda rooms, glow-up studio, astro &
 * tarot). The two were designed for different products and they barely overlap:
 * the classifieds list has no word for an adda room, and the vertical list has
 * no word for a second-hand scooter.
 *
 * So this table derives a vertical from (kind, category) on the client. That is
 * the wrong place for it — two clients would drift, and the server cannot filter
 * or count by something only the browser knows. It belongs in the worker as a
 * real `vertical` column on `listings`, set at publish time. Until then:
 *
 *   - the counts here are computed from the page's own fetched listings, so they
 *     are honest but only ever describe the CURRENT page, not the catalogue;
 *   - `VERTICALS_WITHOUT_A_SOURCE` names the three that no listing can currently
 *     land in, so nobody mistakes an empty section for a bug.
 *
 * When the API grows the field, delete `verticalOf` and read `listing.vertical`.
 * Everything else here (labels, eyebrows, section copy) survives that change.
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

/**
 * The three verticals NO listing can currently be assigned to, because nothing
 * in the API's (kind, category) space means "adda room", "live friend" or
 * "glow-up". Their sections and tiles will always be empty until either the
 * worker gains a `vertical` field or these products start publishing under a
 * kind of their own.
 *
 * Exported so a future reader can tell "empty because nobody has published one"
 * from "empty because it is unreachable by construction" — those look identical
 * on screen and only one of them is a bug.
 */
export const VERTICALS_WITHOUT_A_SOURCE: ReadonlySet<VerticalId> = new Set([
  'live_friends',
  'adda_rooms',
  'glow_up',
]);

/** Categories that read as a reading/divination practice rather than a subject. */
const ASTRO_CATEGORIES = new Set(['astrologers']);

/**
 * Best-effort vertical for one listing. Returns null when nothing fits — the
 * caller drops it into no section rather than guessing, because a listing shown
 * under the wrong heading is worse than one not shown twice.
 */
export function verticalOf(listing: Card): VerticalId | null {
  const kind = String(listing.kind ?? '').toLowerCase();
  const category = String(listing.category ?? '').toLowerCase();

  // Astro outranks kind: a tarot reading sold as a 1:1 is still astro, and the
  // comp gives it its own section.
  if (ASTRO_CATEGORIES.has(category)) return 'astro_tarot';

  if (kind.startsWith('agent') || kind === 'ai_agent') return 'ai_voice_agents';
  if (kind.startsWith('consult')) return 'consulting';
  if (kind === 'live_event' || kind === 'live' || kind === 'event') return 'live_streaming';

  return null;
}

/** Count listings per vertical. Describes the listings passed in, nothing more. */
export function countByVertical(listings: Card[]): Record<VerticalId, number> {
  const out = Object.fromEntries(VERTICALS.map((v) => [v.id, 0])) as Record<VerticalId, number>;
  for (const l of listings) {
    const v = verticalOf(l);
    if (v) out[v] += 1;
  }
  return out;
}

/** Group listings into the display order above, skipping empty verticals. */
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
