// [HF-JOIN-PAT-1 2026-10-18] "Pat-Katha" art slots for /hosts/join: the page is a Bengal Patachitra story scroll that a
// patua (scroll singer) unrolls panel by panel — Neha's journey from sign-up to payout — wound on Channapatna lacquered
// rollers, with Kantha running-stitch borders, a Bidri silver-inlay earnings ledger, Gond dot-art medallions, a Bandhani
// hero ground, an Ikat privacy section and a Kalamkari closing panel. Owner rule: artwork made only for this page (prompt
// pack: SaatHum project doc claude/hello-fraands-join-artwork-prompts.md), never reused from another page. Files live in
// /assets/hf-join/; a slot with no file renders the CSS-drawn stand-in. Prerendered page → the file check runs at build.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const opt = (p: string): string => (existsSync(PUBLIC + p) ? p : '');
const J = '/assets/hf-join';

export const JOIN_ART = {
  hero: opt(`${J}/hero/patua-hero.png`),
  pat1: opt(`${J}/panels/pat-1-account.png`),
  pat2: opt(`${J}/panels/pat-2-upgrade.png`),
  pat3: opt(`${J}/panels/pat-3-rate.png`),
  pat4: opt(`${J}/panels/pat-4-call.png`),
  cta: opt(`${J}/panels/pat-cta-rollup.png`),
  roller: opt(`${J}/scroll/roller-channapatna.png`),
  medal1: opt(`${J}/medallions/gond-1-peacock.png`),
  medal2: opt(`${J}/medallions/gond-2-fish.png`),
  medal3: opt(`${J}/medallions/gond-3-deer.png`),
  medal4: opt(`${J}/medallions/gond-4-tree.png`),
  shield1: opt(`${J}/promise/promise-number.png`),
  shield2: opt(`${J}/promise/promise-avatar.png`),
  shield3: opt(`${J}/promise/promise-choice.png`),
} as const;

/** Background/skin art → --jp-<key>: a full background layer (url + position/size/repeat). [key, path, width, tail]
 *  Borders are drawn 20:1 and shown at height×20 so motifs keep their drawn proportions. */
const BAND = 'center / clamp(560px, 52vw, 880px) 100% repeat-x';
const BG: [string, string, number, string][] = [
  ['kantha', `${J}/borders/border-kantha.png`, 1600, BAND],
  ['patflower', `${J}/borders/border-pat-flower.png`, 1600, BAND],
  ['bidriband', `${J}/borders/border-bidri.png`, 1600, BAND],
  ['ikatband', `${J}/borders/border-ikat.png`, 1600, BAND],
  ['bandhani', `${J}/tiles/tile-bandhani.png`, 600, 'center / 300px repeat'],
  ['paper', `${J}/tiles/tile-pat-paper.png`, 600, 'center / 420px repeat'],
  ['bidri', `${J}/tiles/tile-bidri.png`, 600, 'center / 320px repeat'],
  ['ikat', `${J}/tiles/tile-ikat.png`, 600, 'center / 320px repeat'],
  ['kalamkari', `${J}/tiles/tile-kalamkari.png`, 600, 'center / 340px repeat'],
  ['gonddots', `${J}/tiles/tile-gond-dots.png`, 600, 'center / 300px repeat'],
];
const SKINS: [string, string, number][] = [
  ['btn', `${J}/buttons/btn-lacquer-red.png`, 900],
  ['btn2', `${J}/buttons/btn-lacquer-blue.png`, 900],
];
export const JOIN_BG = BG.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width, tail]) => ({ key, path, width, tail }));
export const JOIN_SKINS = SKINS.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width]) => ({ key, path, width }));
