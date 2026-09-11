// [WEB-HELP-1 2026-09-11] Shared API for the help centre: the section
// registry, the tree the landing page and sidebar render from, URL helpers,
// prev/next navigation within a section, and the zero-dependency search
// index consumed by src/pages/help/search.json.ts. Other in-flight agents
// (Help.astro, the help pages, check-help.mjs) code against these exact
// exports — do not rename or reshape them without updating this comment and
// every caller.
import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export type HelpSectionId =
  | 'getting-started'
  | 'booking-and-paying'
  | 'creators'
  | 'billing'
  | 'account-and-safety';

export type HelpEntry = CollectionEntry<'help'>;

/**
 * Section labels, ordering and intro copy in one place, per the plan (§4).
 * Tones are picked from the four the site already has — see Content.astro's
 * `.tone-*` rules — never invented here.
 */
export const SECTIONS: Record<
  HelpSectionId,
  { label: string; order: number; blurb: string; tone: 'cream' | 'sky' | 'lime' | 'pink' }
> = {
  'getting-started': {
    label: 'Getting started',
    order: 1,
    blurb: 'What avaTOK is, how to sign up, and what happens on web versus in the app.',
    tone: 'cream',
  },
  'booking-and-paying': {
    label: 'Booking & paying',
    order: 2,
    blurb: 'Finding a creator, booking a session or show, and how tokens and payments work.',
    tone: 'cream',
  },
  creators: {
    label: 'For creators',
    order: 3,
    blurb: 'Building a listing, getting it approved, pricing it, and running a live session.',
    tone: 'lime',
  },
  billing: {
    label: 'Billing & payouts',
    order: 4,
    blurb: 'The platform fee, refunds, withdrawing your earnings, and tax basics.',
    tone: 'sky',
  },
  'account-and-safety': {
    label: 'Account & safety',
    order: 5,
    blurb: 'Verification, recording and consent, reporting a problem, and deleting your account.',
    tone: 'pink',
  },
};

export const SECTION_ORDER: HelpSectionId[] = (Object.keys(SECTIONS) as HelpSectionId[]).sort(
  (a, b) => SECTIONS[a].order - SECTIONS[b].order,
);

/** Non-draft help entries, sorted by section order, then in-section order, then title. */
export async function getHelpEntries(): Promise<HelpEntry[]> {
  const entries = await getCollection('help', (entry) => !entry.data.draft);
  return entries.sort((a, b) => {
    const sectionDiff = SECTIONS[a.data.section as HelpSectionId].order - SECTIONS[b.data.section as HelpSectionId].order;
    if (sectionDiff !== 0) return sectionDiff;
    const orderDiff = a.data.order - b.data.order;
    if (orderDiff !== 0) return orderDiff;
    return a.data.title.localeCompare(b.data.title);
  });
}

export interface HelpTreeSection {
  id: HelpSectionId;
  label: string;
  blurb: string;
  order: number;
  tone: string;
  entries: HelpEntry[];
}

/** Sections in display order, each with its (non-draft) entries; empty sections are omitted. */
export async function getHelpTree(): Promise<HelpTreeSection[]> {
  const entries = await getHelpEntries();
  return SECTION_ORDER.map((id) => ({
    id,
    label: SECTIONS[id].label,
    blurb: SECTIONS[id].blurb,
    order: SECTIONS[id].order,
    tone: SECTIONS[id].tone,
    entries: entries.filter((entry) => entry.data.section === id),
  })).filter((section) => section.entries.length > 0);
}

/** entry.id is the glob-loader path relative to content/help, e.g. "billing/platform-fee". */
export function helpUrl(entry: HelpEntry): string {
  return `/help/${entry.id}`;
}

export function sectionUrl(id: HelpSectionId): string {
  return `/help#${id}`;
}

/** Previous/next article within the same section, given an already-sorted entry list. */
export function getPrevNext(
  entries: HelpEntry[],
  entry: HelpEntry,
): { prev?: HelpEntry; next?: HelpEntry } {
  const siblings = entries.filter((e) => e.data.section === entry.data.section);
  const index = siblings.findIndex((e) => e.id === entry.id);
  if (index === -1) return {};
  return {
    prev: index > 0 ? siblings[index - 1] : undefined,
    next: index < siblings.length - 1 ? siblings[index + 1] : undefined,
  };
}

export type SearchDoc = {
  url: string;
  title: string;
  section: string;
  sectionId: HelpSectionId;
  description: string;
  keywords: string[];
  headings: string[];
  body: string;
};

const SEARCH_BODY_LIMIT = 1500;

/**
 * Strip markdown to plain text with regex only (no library, per the plan's
 * "zero new dependencies" rule): drop frontmatter, code fences, turn links
 * into their link text, drop emphasis/heading markers and HTML tags, then
 * collapse whitespace.
 */
export function stripMarkdown(md: string): string {
  let text = md;
  // Frontmatter block, if present (glob-loaded entry.body should already
  // exclude it, but strip defensively in case a caller passes a raw file).
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Fenced code blocks.
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // Inline code.
  text = text.replace(/`([^`]*)`/g, '$1');
  // Images: drop entirely (alt text is not article prose).
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // Links: keep the link text only.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // HTML tags.
  text = text.replace(/<[^>]+>/g, ' ');
  // Heading markers.
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Blockquote / list markers.
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^[-*+]\s+/gm, '');
  text = text.replace(/^\d+\.\s+/gm, '');
  // Emphasis markers.
  text = text.replace(/(\*\*\*|\*\*|\*|___|__|_)/g, '');
  // Collapse whitespace.
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** The `##`/`###` heading lines of a markdown body, as plain text. */
function extractHeadings(md: string): string[] {
  const headings: string[] = [];
  const lines = md.split('\n');
  for (const line of lines) {
    const match = line.match(/^#{2,3}\s+(.+?)\s*#*$/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

/** Builds the static search index shipped at /help/search.json. */
export async function buildSearchIndex(): Promise<SearchDoc[]> {
  const entries = await getHelpEntries();
  return entries.map((entry) => {
    const sectionId = entry.data.section as HelpSectionId;
    return {
      url: helpUrl(entry),
      title: entry.data.title,
      section: SECTIONS[sectionId].label,
      sectionId,
      description: entry.data.description,
      keywords: entry.data.keywords,
      headings: extractHeadings(entry.body ?? ''),
      body: stripMarkdown(entry.body ?? '').slice(0, SEARCH_BODY_LIMIT),
    };
  });
}
