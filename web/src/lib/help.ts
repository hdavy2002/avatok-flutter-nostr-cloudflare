// rebrand: reviewed — [HELLO-FRAANDS-HELP-1 2026-10-08] current-brand help topics.
// [WEB-HELP-1 2026-09-11] Shared API for the help centre: the section
// registry, the tree the landing page and sidebar render from, URL helpers,
// prev/next navigation within a section, and the zero-dependency search
// index consumed by src/pages/help/search.json.ts. Other in-flight agents
// (Help.astro, the help pages, check-help.mjs) code against these exact
// exports — do not rename or reshape them without updating this comment and
// every caller.
import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import { BRAND } from './brand';
import { fillBrandTokens, fillBrandTokensDeep } from './brandTokens';

export type HelpSectionId =
  | 'getting-started'
  | 'calling'
  | 'safety-and-privacy'
  | 'for-women'
  | 'hosts'
  | 'wallet-and-payments'
  | 'account-and-help';

export type HelpEntry = CollectionEntry<'help'>;

export type HelpTone = 'cream' | 'pink' | 'lilac' | 'paper' | 'peach';

/**
 * [HELLO-FRAANDS-HELP-1 2026-10-08] Section labels, ordering, intro copy, the
 * Hinglish sub-line and the notebook tone/icon used by pages/help/index.astro
 * and layouts/Help.astro. Tones are the home page mood-card colours. Never green.
 */
export const SECTIONS: Record<
  HelpSectionId,
  { label: string; hindi: string; icon: string; order: number; blurb: string; tone: HelpTone }
> = {
  'getting-started': {
    label: 'Getting started', hindi: 'Shuruaat yahan se', icon: '❋', order: 1, tone: 'cream',
    blurb: `What ${BRAND.name} is, how a call works, signing up and finding someone to talk to.`,
  },
  calling: {
    label: 'Making calls', hindi: 'Call kaise karein', icon: '✳', order: 2, tone: 'pink',
    blurb: 'Your first call, price per minute, ending a call, calling a friend again and call problems.',
  },
  'safety-and-privacy': {
    label: 'Safety & privacy', hindi: 'Number private, baat safe', icon: '✦', order: 3, tone: 'peach',
    blurb: 'Your private number, how AI keeps calls safe, no recordings, OTP scams, strikes and bans.',
  },
  'for-women': {
    label: 'For women', hindi: 'Mahilaon ke liye', icon: '♥', order: 4, tone: 'lilac',
    blurb: 'Staying safe as a woman, the women-only space and talking about health.',
  },
  hosts: {
    label: 'For hosts', hindi: 'Baatein karo, paise kamao', icon: '☀', order: 5, tone: 'cream',
    blurb: 'Becoming a host, what you earn, taking calls, handling bad callers and getting paid.',
  },
  'wallet-and-payments': {
    label: 'Wallet & payments', hindi: 'Paisa aur wallet', icon: '₹', order: 6, tone: 'paper',
    blurb: 'Adding money, why calls are not refunded, taking your balance out and billing mistakes.',
  },
  'account-and-help': {
    label: 'Account & help', hindi: 'Report, block aur madad', icon: '☎', order: 7, tone: 'lilac',
    blurb: 'Reporting or blocking someone, deleting your account, complaints and urgent help.',
  },
};

export const SECTION_ORDER: HelpSectionId[] = (Object.keys(SECTIONS) as HelpSectionId[]).sort(
  (a, b) => SECTIONS[a].order - SECTIONS[b].order,
);

/** Non-draft help entries, sorted by section order, then in-section order, then title. */
export async function getHelpEntries(): Promise<HelpEntry[]> {
  // [SAATHUM-BRAND-CENTRAL-WEB-3] The single reader of the help collection: fill
  // {{brand.*}} tokens in frontmatter and body so titles, descriptions, FAQ JSON-LD
  // and the search index all show the current brand. (The rendered body is filled by
  // lib/remarkBrand.mjs at markdown time.)
  const entries = (await getCollection('help', (entry) => !entry.data.draft)).map((entry) => ({
    ...entry,
    data: fillBrandTokensDeep(entry.data),
    body: entry.body === undefined ? entry.body : fillBrandTokens(entry.body),
  }));
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
  tone: HelpTone;
  hindi: string;
  icon: string;
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
    hindi: SECTIONS[id].hindi,
    icon: SECTIONS[id].icon,
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
