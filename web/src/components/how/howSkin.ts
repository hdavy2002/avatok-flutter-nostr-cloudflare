// [HF-HOW-KALA-1 2026-10-18] "Teen Kadam, Teen Kala" art slots for /how-it-works: each step is painted in a different
// Indian folk art (Warli, Rajasthani Phad, Kashmiri papier-mache), stitched together with Ajrakh / Sozni / Phulkari
// borders. Owner rule: artwork made only for this page (prompt pack: SaatHum project doc
// claude/hello-fraands-how-it-works-artwork-prompts.md), never reused from another page. Files live in /assets/hf-how/;
// a slot with no file renders the CSS-drawn stand-in. Prerendered page → this file check runs at build time.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const opt = (p: string): string => (existsSync(PUBLIC + p) ? p : '');
const H = '/assets/hf-how';

export const HOW_ART = {
  cover: opt(`${H}/hero/cover-teen-kala.png`),
  warli: opt(`${H}/panels/step-1-warli.png`),
  phad: opt(`${H}/panels/step-2-phad.png`),
  kashmir: opt(`${H}/panels/step-3-kashmiri.png`),
  call1: opt(`${H}/panels/call-1-warli.png`),
  call2: opt(`${H}/panels/call-2-phad.png`),
  call3: opt(`${H}/panels/call-3-kashmiri.png`),
  cta: opt(`${H}/panels/cta-phulkari.png`),
  medal1: opt(`${H}/medallions/medal-warli.png`),
  medal2: opt(`${H}/medallions/medal-phad.png`),
  medal3: opt(`${H}/medallions/medal-kashmiri.png`),
} as const;

/** Background/skin art → --hw-<key>: a full background layer (url + position/size/repeat). [key, path, width, tail] */
const BG: [string, string, number, string][] = [
  ['ajrakh', `${H}/borders/border-ajrakh.png`, 1600, 'center / clamp(280px, 26vw, 440px) 100% repeat-x'],
  ['warliband', `${H}/borders/border-warli.png`, 1600, 'center / clamp(280px, 26vw, 440px) 100% repeat-x'],
  ['phadband', `${H}/borders/border-phad.png`, 1600, 'center / clamp(280px, 26vw, 440px) 100% repeat-x'],
  ['sozni', `${H}/borders/border-sozni.png`, 1600, 'center / clamp(280px, 26vw, 440px) 100% repeat-x'],
  ['phulkari', `${H}/borders/border-phulkari.png`, 1600, 'center / clamp(280px, 26vw, 440px) 100% repeat-x'],
  ['mud', `${H}/tiles/tile-warli-mud.png`, 600, 'center / 320px repeat'],
  ['leheriya', `${H}/tiles/tile-leheriya.png`, 600, 'center / 320px repeat'],
  ['lacquer', `${H}/tiles/tile-kashmiri-lacquer.png`, 600, 'center / 320px repeat'],
  ['dabu', `${H}/tiles/tile-dabu-indigo.png`, 600, 'center / 320px repeat'],
  ['sanganeri', `${H}/tiles/tile-sanganeri.png`, 600, 'center / 320px repeat'],
];
const SKINS: [string, string, number][] = [
  ['btn', `${H}/buttons/btn-mirror.png`, 900],
  ['btn2', `${H}/buttons/btn-sozni.png`, 900],
];
export const HOW_BG = BG.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width, tail]) => ({ key, path, width, tail }));
export const HOW_SKINS = SKINS.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width]) => ({ key, path, width }));
