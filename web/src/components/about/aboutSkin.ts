// [HF-ABOUT-GULLY-1 2026-10-18] "Gully ka Scorecard" art slots for /about. Owner pick from the 3-idea "Indianize it"
// pitch: a Sunday street-cricket match explains who we are. Bunty (fan, Kanpur) bats against a sky-blue lime-washed
// wall with chalk stumps; Meher (a cricket-commentary creator) calls the match from a balcony; one over = six facts;
// a painted tin scoreboard says who runs the site; the umpire's board says what this is not. Artwork made only for this
// page (prompt pack: SaatHum project doc claude/hello-fraands-about-artwork-prompts.md), never reused elsewhere. Files
// live in /assets/hf-about/; a slot with no file renders the CSS-drawn stand-in. Prerendered, so the checks run at build.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const opt = (p: string): string => (existsSync(PUBLIC + p) ? p : '');
const F = '/assets/hf-about';

export const ABOUT_ART = {
  hero: opt(`${F}/hero/hero-bunty-batting.png`),
  over: opt(`${F}/panels/panel-gully-over.png`),
  ball: opt(`${F}/badges/badge-tennis-ball.png`),
  six: opt(`${F}/badges/badge-sixer.png`),
  commentator: opt(`${F}/hero/cutout-meher-commentator.png`),
  umpire: opt(`${F}/panels/panel-umpire.png`),
  close: opt(`${F}/close/close-gully-evening.png`),
} as const;

/** Background/skin art → --gc-<key>: a full background layer (url + position/size/repeat). [key, path, width, tail] */
const BAND = 'center / clamp(560px, 52vw, 880px) 100% repeat-x';
const BG: [string, string, number, string][] = [
  ['chalk', `${F}/borders/border-chalk-runs.png`, 1600, BAND],
  ['grip', `${F}/borders/border-bat-grip.png`, 1600, BAND],
  ['bricks', `${F}/borders/border-brick-wall.png`, 1600, BAND],
  ['twall', `${F}/tiles/tile-limewash-wall.png`, 600, 'center / 300px repeat'],
  ['tpitch', `${F}/tiles/tile-cement-pitch.png`, 600, 'center / 300px repeat'],
  ['tslate', `${F}/tiles/tile-tin-slate.png`, 600, 'center / 300px repeat'],
];
const SKINS: [string, string, number][] = [
  ['btn', `${F}/buttons/btn-willow-bat.png`, 900],
  ['btn2', `${F}/buttons/btn-tin-plate.png`, 900],
];
export const ABOUT_BG = BG.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width, tail]) => ({ key, path, width, tail }));
export const ABOUT_SKINS = SKINS.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width]) => ({ key, path, width }));
