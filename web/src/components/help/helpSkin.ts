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
  // [HELLO-FRAANDS-HELP-RESTORE-1] Current-brand photos/art replace the puja tiles.
  'getting-started': '/assets/callvaal/scrapbook/neha-conversation.png',
  calling: '/assets/callvaal/scrapbook/women-photo-young.png',
  'safety-and-privacy': '/assets/safety/safety-2.jpg',
  'for-women': '/assets/callvaal/scrapbook/sana-conversation.png',
  hosts: '/assets/callvaal/scrapbook/priya-practice.png',
  'wallet-and-payments': '/assets/callvaal/scrapbook/earn-art-moods.png',
  'account-and-help': '/assets/callvaal/scrapbook/sana-notes.png',
};

export const HERO_ART = '/assets/callvaal/scrapbook/hero-collage-friendship.jpg';

/** FAQ-card pill modifier, as the mockup colours them. */
export const SECTION_PILL: Record<HelpSectionId, string> = {
  'getting-started': '',
  calling: 'hs-pill--rose',
  'safety-and-privacy': 'hs-pill--sky',
  'for-women': 'hs-pill--rose',
  hosts: 'hs-pill--gold',
  'wallet-and-payments': 'hs-pill--sky',
  'account-and-help': 'hs-pill--gold',
};

/** The mockup's folk "marks" (inner strokes only; the medallion is shared). */
const MARK_INNER: Record<HelpSectionId, string> = {
  'getting-started': '<path d="M50 74C25 70 18 55 19 43c16 0 27 13 31 26 4-13 15-26 31-26 1 12-6 27-31 31Z" fill="#e79b9a"/><path d="M50 28v40"/>',
  calling: '<path d="M33 25h12l4 14-8 5c4 9 9 14 18 18l5-8 14 4v12c0 4-3 6-7 6-26-2-42-18-44-44 0-4 2-7 6-7Z" fill="#fff6e6"/>',
  'safety-and-privacy': '<path d="M50 22 74 31v17c0 16-10 25-24 30-14-5-24-14-24-30V31Z" fill="#fff6e6"/><path d="m39 50 8 8 15-17"/>',
  'for-women': '<path d="M50 76C30 62 20 52 20 40a14 14 0 0 1 30-6 14 14 0 0 1 30 6c0 12-10 22-30 36Z" fill="#e79b9a"/>',
  hosts: '<circle cx="50" cy="50" r="13" fill="#ef9e25"/><path d="M50 23v8m0 38v8M23 50h8m38 0h8M31 31l6 6m26 26 6 6m0-38-6 6M37 63l-6 6"/>',
  'wallet-and-payments': '<path d="M23 33h54v12c-11 0-11 14 0 14v12H23V59c11 0 11-14 0-14Z" fill="#fff6e6"/><path d="M60 35v6m0 7v6m0 7v7m-24-17 6 6 10-13"/>',
  'account-and-help': '<path d="M20 77h60M28 74V47h44v27M24 47h52L50 27Z" fill="#d87332"/><path d="M42 76V58a8 8 0 0 1 16 0v18" fill="#fff6e6"/>',
};
export const MARK_TICKET = MARK_INNER['wallet-and-payments'];
export const MARK_SCREEN = MARK_INNER.calling;
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
  buyer: 'For callers',
  creator: 'For hosts',
  both: 'For everyone',
};

export function countLabel(n: number): string {
  return `${n} article${n === 1 ? '' : 's'}`;
}
