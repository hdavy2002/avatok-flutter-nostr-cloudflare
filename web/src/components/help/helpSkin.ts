// [WEB-HELP-SKIN-2 2026-09-27] Shared presentation data for the help skin v2
// (design/help-centre/saathum-help-skin-v2.src.html): per-section artwork,
// FAQ-card pill colour + mark, reading time and the date label. Used by
// pages/help/index.astro and layouts/Help.astro so the landing page and the
// article rail can never show a section with two different pictures.
// Section labels/ordering stay in lib/help.ts (SECTIONS) — never here.
import type { HelpEntry, HelpSectionId } from '../../lib/help';

/** Owner-approved tile art (web/public/help/art/help-tile-*.png). Raw paths —
 *  always serve through publicImage(). `creators` keeps the sankalp & prasad
 *  tile so the art is ready if that section is ever restored from draft. */
export const SECTION_ART: Record<HelpSectionId, string> = {
  'getting-started': '/help/art/help-tile-getting-started.png',
  'booking-and-paying': '/help/art/help-tile-booking-paying.png',
  creators: '/help/art/help-tile-sankalp-prasad.png',
  billing: '/help/art/help-tile-payments-refunds.png',
  'account-and-safety': '/help/art/help-tile-account-safety.png',
};

export const HERO_ART = '/help/art/help-hero-v2.png';

/** FAQ-card pill modifier, as the mockup colours them. */
export const SECTION_PILL: Record<HelpSectionId, string> = {
  'getting-started': '',
  'booking-and-paying': 'hs-pill--rose',
  creators: 'hs-pill--gold',
  billing: 'hs-pill--sky',
  'account-and-safety': 'hs-pill--gold',
};

/** The mockup's folk "marks" (inner strokes only; the medallion is shared). */
const MARK_INNER: Record<HelpSectionId, string> = {
  'getting-started': '<path d="M50 74C25 70 18 55 19 43c16 0 27 13 31 26 4-13 15-26 31-26 1 12-6 27-31 31Z" fill="#e79b9a"/><path d="M50 28v40"/>',
  'booking-and-paying': '<rect x="21" y="29" width="58" height="40" rx="6" fill="#fff6e6"/><path d="m44 39 17 10-17 10Z" fill="#ad3028"/><path d="M38 79h24m-12-9v9"/>',
  creators: '<path d="M24 56h52c-5 17-16 23-26 23S29 73 24 56Z" fill="#d87332"/><path d="M30 61h40M44 78h12M50 54c-18-7-6-21 3-33-1 11 14 23-3 33Z" fill="#ef9e25"/>',
  billing: '<path d="M23 33h54v12c-11 0-11 14 0 14v12H23V59c11 0 11-14 0-14Z" fill="#fff6e6"/><path d="M60 35v6m0 7v6m0 7v7m-24-17 6 6 10-13"/>',
  'account-and-safety': '<path d="M20 77h60M28 74V47h44v27M24 47h52L50 27Z" fill="#d87332"/><path d="M42 76V58a8 8 0 0 1 16 0v18" fill="#fff6e6"/>',
};
export const MARK_TICKET = MARK_INNER.billing;
export const MARK_SCREEN = MARK_INNER['booking-and-paying'];
export const MARK_SEARCH = '<circle cx="44" cy="44" r="19" fill="#fff6e6"/><path d="m59 59 18 18M34 40c2-6 5-8 11-8"/>';

export function markSvg(inner: string, cls = 'hs-card-mark'): string {
  return `<svg class="${cls}" viewBox="0 0 100 100" fill="none" aria-hidden="true"><circle cx="50" cy="50" r="44" fill="#ffe1a2" stroke="#fff" stroke-width="7"/><g stroke="#8c3327" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
}
export function sectionMark(id: HelpSectionId): string {
  return markSvg(MARK_INNER[id]);
}

/** Reading time from the markdown body, ~200 words a minute, never below 1. */
export function readMinutes(entry: HelpEntry): number {
  const words = (entry.body ?? '').replace(/<!--[\s\S]*?-->/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Hand-rolled (not toLocaleDateString) — ICU data varies across build images.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateLabel(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const AUDIENCE_LABEL: Record<'buyer' | 'creator' | 'both', string> = {
  buyer: 'For devotees',
  creator: 'For creators',
  both: 'For everyone',
};

export function countLabel(n: number): string {
  return `${n} article${n === 1 ? '' : 's'}`;
}
