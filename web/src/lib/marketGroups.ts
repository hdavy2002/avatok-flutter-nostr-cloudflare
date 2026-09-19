/**
 * [MKT-3GROUP-WEB-1] Web-marketplace adapter over the shared taxonomy in
 * lib/listingTaxonomy.ts (generated — do not edit that file).
 *
 * The marketplace/front-page components used to group listings into the seven
 * bazaar SECTIONS (lib/verticals.ts). Per
 * Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md §1 they now show
 * THREE groups instead, each with its sub-category "blips" (§2). This file is
 * presentation glue specific to the web marketplace: display copy for each
 * group (heading/eyebrow/zone), which group a card belongs to, and which
 * blips a group shows.
 */
import { GROUPS, subCategoriesFor, type GroupId, type SubCategory } from './listingTaxonomy';
import type { Card } from './types';

export type { GroupId };

export interface GroupDisplay {
  id: GroupId;
  /** Short tile label, e.g. for the marketplace category tiles. */
  label: string;
  /** Section eyebrow line above the heading. */
  eyebrow: string;
  /** Heading, split so `title2` can take the coral — the bazaar comp's
   *  two-tone Anton treatment used throughout the marketplace. */
  title: string;
  title2: string;
  /** Short "zone" tag shown beside the section stub line. */
  zone: string;
  /** Optional handwritten aside (Kalam, rotated) under the heading. */
  punch?: string;
  blurb: string;
}

const TAXONOMY_BLURB: Record<GroupId, string> = Object.fromEntries(
  GROUPS.map((g) => [g.id, g.blurb]),
) as Record<GroupId, string>;

/** Display copy per group. Order matches GROUPS (the taxonomy's own order) —
 *  the order these render on the front page and the marketplace. */
export const GROUP_DISPLAY: Record<GroupId, GroupDisplay> = {
  india_goes_live: {
    id: 'india_goes_live',
    label: 'India goes live',
    eyebrow: 'Live streaming · लाइव अभी',
    title: 'India goes',
    title2: 'live.',
    zone: 'Pawri zone',
    punch: 'Ye hamari pawri ho rahi hai!',
    blurb: TAXONOMY_BLURB.india_goes_live,
  },
  find_your_people: {
    id: 'find_your_people',
    label: 'Find your people',
    eyebrow: 'One-on-one · real company',
    title: 'Find your',
    title2: 'people.',
    zone: 'Dil ka scene',
    blurb: TAXONOMY_BLURB.find_your_people,
  },
  book_their_time: {
    id: 'book_their_time',
    label: 'Book their time',
    eyebrow: 'Experts · booked',
    title: 'Book their',
    title2: 'time.',
    zone: 'Gyaan desk',
    punch: 'Jo dhoondoge, wahi milega.',
    blurb: TAXONOMY_BLURB.book_their_time,
  },
};

/** Same order the taxonomy declares the three groups in. */
export const GROUP_ORDER: GroupId[] = GROUPS.map((g) => g.id);

const KNOWN_GROUPS = new Set<string>(GROUP_ORDER);

function groupForCategoryFallback(category: string | null): GroupId | null {
  if (!category) return null;
  for (const g of GROUP_ORDER) {
    if (subCategoriesFor(g).some((c) => c.id === category)) return g;
  }
  return null;
}

/**
 * Which group a card belongs to. Prefers the SERVER's own answer
 * (`card.group_id`, added [MKT-3GROUP-1] to `shapeCard`) and only derives it
 * from the category mirror when talking to a worker that predates the field
 * (`group_id === undefined`). A server `null` (a section that renders nowhere,
 * today only `ai_voice_agents`) is trusted as-is — never overridden by a
 * client guess.
 */
export function groupIdOf(card: Card): GroupId | null {
  const g = card.group_id;
  if (g === undefined) return groupForCategoryFallback(card.category ?? null);
  if (g === null) return null;
  return KNOWN_GROUPS.has(g) ? (g as GroupId) : null;
}

/** Buckets cards into the three groups, in GROUP_ORDER, skipping empty groups
 *  entirely — an empty group section reads as "nothing here", not "broken". */
export function groupByGroupId(cards: Card[]): { group: GroupDisplay; listings: Card[] }[] {
  const buckets = new Map<GroupId, Card[]>();
  for (const c of cards) {
    const g = groupIdOf(c);
    if (!g) continue;
    const arr = buckets.get(g);
    if (arr) arr.push(c);
    else buckets.set(g, [c]);
  }
  return GROUP_ORDER.filter((g) => (buckets.get(g)?.length ?? 0) > 0).map((g) => ({
    group: GROUP_DISPLAY[g],
    listings: buckets.get(g) ?? [],
  }));
}

/**
 * Turns the worker's per-SECTION counts (`section_counts`, keyed by
 * `listings.section`) into per-GROUP counts, by summing each group's
 * `sections` list (lib/listingTaxonomy.ts GROUPS). Returns null when the
 * worker sent no counts — "0" and "we do not know" are different claims (see
 * FilterRail's `countsKnown`), so this must not manufacture zeroes.
 */
export function groupCountsFromSectionCounts(
  sectionCounts: Record<string, number> | null | undefined,
): Record<GroupId, number> | null {
  if (!sectionCounts) return null;
  const out = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<GroupId, number>;
  for (const g of GROUPS) {
    for (const s of g.sections) out[g.id] += sectionCounts[s] ?? 0;
  }
  return out;
}

export interface Blip {
  id: string;
  label: string;
  emoji?: string | null;
}

/**
 * The sub-category "blips" for one group (spec §2). The server's own answer —
 * GET /api/explore/categories, which now carries `group_id` [MKT-3GROUP-1] —
 * is the authority; the static SUB_CATEGORIES mirror is only the offline
 * fallback for when that fetch hasn't landed yet or failed.
 *
 * Either way, a blip whose sub-category is flag-gated (`adda_rooms` /
 * `conferenceEnabled`, false in production) is hidden while that flag reads
 * false. An always-empty blip is indistinguishable on screen from "nobody has
 * listed one yet", and only one of those is a bug.
 */
export function blipsForGroup(
  group: GroupId,
  categories: { id: string; label: string; emoji?: string | null; group_id?: string | null }[],
  conferenceEnabled: boolean,
): Blip[] {
  const gated = new Set(
    subCategoriesFor(group).filter((sc) => sc.requiresFlag && !conferenceEnabled).map((sc) => sc.id),
  );
  const fromServer = categories.filter((c) => c.group_id === group && !gated.has(c.id));
  if (fromServer.length) return fromServer;
  return subCategoriesFor(group).filter((sc) => !gated.has(sc.id));
}

export type { SubCategory };
