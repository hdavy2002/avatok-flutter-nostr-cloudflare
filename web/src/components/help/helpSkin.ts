// [WEB-HELP-SKIN-2 2026-09-27] Shared presentation data for the help skin v2
// (design/help-centre/saathum-help-skin-v2.src.html): per-section artwork,
// FAQ-card pill colour + mark, reading time and the date label. Used by
// pages/help/index.astro and layouts/Help.astro so the landing page and the
// article rail can never show a section with two different pictures.
// Section labels/ordering stay in lib/help.ts (SECTIONS) — never here.
import type { HelpEntry, HelpSectionId } from '../../lib/help';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// [HF-HELP-GHAR-1 2026-10-17] "Gaon ka Ghar" help centre: a happy village home at Sankranti (owner-approved design
// canvas "Help Centre"). All art is owner-generated from the prompt pack (SaatHum project doc
// claude/hello-fraands-help-artwork-prompts.md) and lives in /assets/hf-help/. Replaces the rejected Dak Ghar / Angan /
// Haveli treatments. Raw paths: always serve through publicImage().
const PUBLIC = resolve(process.cwd(), 'public');
export const hasArt = (path: string): boolean => existsSync(PUBLIC + path);
const HELP = '/assets/hf-help';

/** One kite per topic (1024×1280, transparent, tail included). */
export const SECTION_ART: Record<HelpSectionId, string> = {
  'getting-started': `${HELP}/kites/kite-getting-started.png`,
  calling: `${HELP}/kites/kite-calling.png`,
  'safety-and-privacy': `${HELP}/kites/kite-safety-and-privacy.png`,
  'for-women': `${HELP}/kites/kite-for-women.png`,
  hosts: `${HELP}/kites/kite-hosts.png`,
  'wallet-and-payments': `${HELP}/kites/kite-wallet-and-payments.png`,
  'account-and-help': `${HELP}/kites/kite-account-and-help.png`,
};
export const CONTACT_KITE = `${HELP}/kites/kite-contact.png`;
/** Each topic's colour (kite paper) — tags, ledger dots and FAQ pills use it. [fill, text] */
export const SECTION_TONE: Record<HelpSectionId, [string, string]> = {
  'getting-started': ['#ff8c1a', '#2a1f5c'],
  calling: ['#e0338a', '#fff4dc'],
  'safety-and-privacy': ['#1565c0', '#fff4dc'],
  'for-women': ['#6a3fc4', '#fff4dc'],
  hosts: ['#ffc93c', '#2a1f5c'],
  'wallet-and-payments': ['#d62839', '#fff4dc'],
  'account-and-help': ['#19a7ce', '#2a1f5c'],
};

export const HELP_ART = {
  hero: `${HELP}/hero/hero-help.png`,
  heroRing: `${HELP}/frames/ring-medallion.png`,
  roof: `${HELP}/ghar/roof-khaprail.png`,
  stillStuck: `${HELP}/aangan/still-stuck.png`,
  aanganRing: `${HELP}/aangan/aangan-rangoli-ring.png`,
  articleCta: `${HELP}/aangan/article-cta.png`,
  ribbons: `${HELP}/book/ribbon-bookmarks.png`,
  rosette: `${HELP}/frames/badge-rosette.png`,
} as const;

export const HELP_STICKERS = {
  hero: { src: `${HELP}/stickers/sticker-pucho-sharmao-mat.png`, alt: 'Pucho, sharmao mat!' },
  kites: { src: `${HELP}/stickers/sticker-kai-po-che.png`, alt: 'Kai po che!' },
  faq: { src: `${HELP}/stickers/sticker-seedhi-baat.png`, alt: 'Seedhi baat, no bakwaas' },
  book: { src: `${HELP}/stickers/sticker-sab-likha-hai.png`, alt: 'Sab likha hai, padh lo' },
  stuck: { src: `${HELP}/stickers/sticker-tension-mat-lo.png`, alt: 'Tension mat lo, hum hain na' },
  article: { src: `${HELP}/stickers/sticker-ek-call-door.png`, alt: 'Bas ek call door!' },
} as const;

// [HF-HELP-SQUASH-1 2026-10-19] 'cover' is bahikhata-frame.png: the owner's bahikhata-cover.png with its left half
// mirrored (tassels dropped) so the 9-slice frame is symmetric and its sides can repeat whole instead of stretching.
/** Background art → --gh-* custom properties on the page root (each a url()). [key, file, width] */
const BG_FILES: [string, string, number][] = [
  ['sky', 'ghar/sky-kites-strip.png', 2400], ['wall', 'ghar/wall-mandana.png', 640], ['mandana', 'ghar/mandana-strip.png', 1600],
  ['rangoli', 'ghar/rangoli-strip.png', 1600], ['paper', 'book/bahikhata-paper.png', 800], ['cover', 'book/bahikhata-frame.png', 1474],
  ['leaf', 'book/pothi-leaf.png', 2400], ['btn', 'buttons/btn-primary-skin.png', 900], ['btn2', 'buttons/btn-secondary-skin.png', 900],
  ['chip', 'buttons/chip-skin.png', 600], ['rosette', 'frames/badge-rosette.png', 256], ['ringsm', 'frames/ring-small.png', 256],
];
export const HELP_BG = BG_FILES.map(([key, f, width]) => ({ key, path: `${HELP}/${f}`, width }));

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
  creator: 'For influencers',
  both: 'For everyone',
};

export function countLabel(n: number): string {
  return `${n} article${n === 1 ? '' : 's'}`;
}
