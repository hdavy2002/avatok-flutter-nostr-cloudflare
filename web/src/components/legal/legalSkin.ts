// [HF-LEGAL-GHAT-1 2026-10-18] "Ghat ki Seedhiyan" art slots for the shared policy layout (HelloFraandsPage.astro).
// Owner pick from the 3-idea "Indianize it" pitch: every rule page is a walk down a Varanasi ghat. Bholu the boatman
// leans on his oar beside the title, the "On this page" bar is a row of bamboo ghat umbrellas (chhatris), each `##`
// section is one sandstone step with a brass-lota number, and the boat at the river (the close) carries the related
// pages. One template, three colour flavours by footer group (influencer / safety / legal). Artwork made only for these
// pages (prompt pack: SaatHum project doc claude/hello-fraands-legal-artwork-prompts.md), never reused elsewhere. Files
// live in /assets/hf-legal/; a slot with no file renders the CSS-drawn stand-in. Pages are static (output: 'static'),
// so existsSync runs at build time — never mark a page using this layout `prerender = false`.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const opt = (p: string): string => (existsSync(PUBLIC + p) ? p : '');
const F = '/assets/hf-legal';

export const LEGAL_ART = {
  scene: opt(`${F}/hero/hero-ghat-steps.png`),
  bholu: opt(`${F}/hero/cutout-bholu-oar.png`),
  lota: opt(`${F}/medallions/medallion-lota.png`),
  chhatri: opt(`${F}/badges/badge-chhatri.png`),
  close: opt(`${F}/close/close-naav-diyas.png`),
} as const;

/** v2 borders (1600×160, whole motifs) are shown at their true shape (HF-DESIGN-SYSTEM §6.1). */
const BAND = 'center / auto 100% repeat-x';
/** Background/skin art → --lg-<key>: a full background layer. [key, path, width, tail] */
const BG: [string, string, number, string][] = [
  ['diya', `${F}/borders/border-diya-row.png`, 1600, BAND],
  ['garland', `${F}/borders/border-marigold-garland.png`, 1600, BAND],
  ['baluster', `${F}/borders/border-sandstone-balusters.png`, 1600, BAND],
  ['tstone', `${F}/tiles/tile-sandstone.png`, 600, 'center / 320px repeat'],
  ['tsteps', `${F}/tiles/tile-ghat-stone.png`, 600, 'center / 320px repeat'],
  ['tganga', `${F}/tiles/tile-ganga-ripples.png`, 600, 'center / 320px repeat'],
];
const SKINS: [string, string, number][] = [
  ['oar', `${F}/buttons/btn-oar.png`, 900],
];
export const LEGAL_BG = BG.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width, tail]) => ({ key, path, width, tail }));
export const LEGAL_SKINS = SKINS.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width]) => ({ key, path, width }));

/** Footer group → colour flavour. Same layout and art; the accent pair and the giant outline word change. */
export type LegalFlavour = 'niyam' | 'suraksha' | 'kaanoon';
const SAFETY = new Set(['/safety', '/community-guidelines', '/report', '/grievance', '/emergency', '/women-only', '/lgbtq', '/age-policy', '/wellbeing', '/rules-of-engagement', '/talk-safely']);
export function legalFlavour(pathname: string): LegalFlavour {
  if (pathname.startsWith('/hosts/')) return 'niyam';
  if (SAFETY.has(pathname)) return 'suraksha';
  return 'kaanoon';
}
export const FLAVOUR_COPY: Record<LegalFlavour, { kicker: string; word: string; group: string }> = {
  niyam: { kicker: 'Influencer ghat', word: 'NIYAM', group: 'Influencers' },
  suraksha: { kicker: 'Suraksha ghat', word: 'SURAKSHA', group: 'Trust & Safety' },
  kaanoon: { kicker: 'Kaanooni ghat', word: 'KAANOON', group: 'Legal & Payments' },
};
