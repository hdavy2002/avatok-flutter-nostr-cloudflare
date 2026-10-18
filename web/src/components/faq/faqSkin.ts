// [HF-FAQ-IRANI-1 2026-10-18] "Irani Café Dabba" art slots for /faq. Owner pick from the 3-idea "Indianize it" pitch:
// a Bombay Irani café (Farokh-uncle at the counter, bun-maska, cutting chai, the café rules board) with a dabbawala
// crate at the door. The 11 FAQ topics are 11 painted tiffin dabbas with dabbawala codes; the questions read like the
// café menu. Artwork made only for this page (prompt pack: SaatHum project doc
// claude/hello-fraands-faq-artwork-prompts.md), never reused elsewhere. Files live in /assets/hf-faq/; a slot with no
// file renders the CSS-drawn stand-in. The page is prerendered, so these file checks run at build time.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const opt = (p: string): string => (existsSync(PUBLIC + p) ? p : '');
const F = '/assets/hf-faq';

export const FAQ_ART = {
  hero: opt(`${F}/hero/hero-irani-cafe.png`),
  pooja: opt(`${F}/example/pooja-bill.png`),
  rules: opt(`${F}/rules/rules-chai-waiter.png`),
  close: opt(`${F}/close/close-dabbawala.png`),
} as const;

export type Tone = 'taxi' | 'maroon' | 'cream' | 'blue' | 'rose';
/** Per-topic dabba: colour, dabbawala code and the band tone its section sits on. Keyed by faqData section id. */
export const DABBAS: Record<string, { code: string; colour: string; tone: Tone }> = {
  about:         { code: 'HF-1-DDR',  colour: '#ff7a2f', tone: 'taxi' },
  start:         { code: 'HF-2-CST',  colour: '#e8577e', tone: 'cream' },
  callers:       { code: 'HF-3-BND',  colour: '#1f5fa8', tone: 'maroon' },
  privacy:       { code: 'HF-4-CHG',  colour: '#8c1d2c', tone: 'rose' },
  'ai-safety':   { code: 'HF-5-FRT',  colour: '#ffc928', tone: 'blue' },
  women:         { code: 'HF-6-MHM',  colour: '#c2338f', tone: 'taxi' },
  conduct:       { code: 'HF-7-GRG',  colour: '#ff7a2f', tone: 'cream' },
  influencers:   { code: 'HF-8-ANH',  colour: '#6a3fc4', tone: 'maroon' },
  payments:      { code: 'HF-9-BYC',  colour: '#1f5fa8', tone: 'rose' },
  partners:      { code: 'HF-10-NRM', colour: '#8c1d2c', tone: 'blue' },
  tech:          { code: 'HF-11-CLB', colour: '#e8577e', tone: 'taxi' },
};
export const dabbaFor = (id: string): { code: string; colour: string; tone: Tone } => DABBAS[id] ?? { code: 'HF', colour: '#ff7a2f', tone: 'cream' };
export const dabbaArt = (id: string): string => opt(`${F}/dabbas/dabba-${id}.png`);

/** Background/skin art → --ic-<key>: a full background layer (url + position/size/repeat). [key, path, width, tail] */
const BAND = 'center / clamp(560px, 52vw, 880px) 100% repeat-x';
const BG: [string, string, number, string][] = [
  ['taxi', `${F}/borders/border-kaali-peeli.png`, 1600, BAND],
  ['awning', `${F}/borders/border-awning.png`, 1600, BAND],
  ['minton', `${F}/borders/border-minton-tiles.png`, 1600, BAND],
  ['tiffins', `${F}/borders/border-tiffin-row.png`, 1600, BAND],
  ['tcheck', `${F}/tiles/tile-checked-cloth.png`, 600, 'center / 300px repeat'],
  ['tminton', `${F}/tiles/tile-minton-floor.png`, 600, 'center / 300px repeat'],
  ['tbent', `${F}/tiles/tile-bentwood.png`, 600, 'center / 300px repeat'],
  ['tjars', `${F}/tiles/tile-glass-jars.png`, 600, 'center / 300px repeat'],
  ['tcrate', `${F}/tiles/tile-dabba-crate.png`, 600, 'center / 300px repeat'],
  ['tmarble', `${F}/tiles/tile-marble.png`, 600, 'center / 300px repeat'],
];
const SKINS: [string, string, number][] = [
  ['btn', `${F}/buttons/btn-menu-board.png`, 900],
  ['btn2', `${F}/buttons/btn-chalk.png`, 900],
];
export const FAQ_BG = BG.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width, tail]) => ({ key, path, width, tail }));
export const FAQ_SKINS = SKINS.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width]) => ({ key, path, width }));
