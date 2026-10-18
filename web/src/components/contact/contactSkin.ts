// [HF-CONTACT-FARMAISH-1 2026-10-18] "Aapki Farmaish" art slots for /contact. Owner pick from the 3-idea "Indianize it"
// pitch: a 70s radio request show. Kamla (listener) writes her farmaish, Rafiq-bhai (the announcer) reads it out and the
// station replies. Transistor radio, Bakelite knobs, vinyl, 70s wallpaper, terrazzo floor, a scooter outside the
// studio. Artwork made only for this page (prompt pack: SaatHum project doc
// claude/hello-fraands-contact-artwork-prompts.md), never reused elsewhere. Files live in /assets/hf-contact/; a slot
// with no file renders the CSS-drawn stand-in. The page is prerendered, so these file checks run at build time.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const opt = (p: string): string => (existsSync(PUBLIC + p) ? p : '');
const F = '/assets/hf-contact';

export const CONTACT_ART = {
  hero: opt(`${F}/hero/hero-transistor-studio.png`),
  step1: opt(`${F}/steps/step-1-likho.png`),
  step2: opt(`${F}/steps/step-2-bhejo.png`),
  step3: opt(`${F}/steps/step-3-jawaab.png`),
  yes: opt(`${F}/badges/badge-zaroor.png`),
  no: opt(`${F}/badges/badge-kabhi-nahi.png`),
  grievance: opt(`${F}/stations/station-grievance.png`),
  report: opt(`${F}/stations/station-report.png`),
  sos: opt(`${F}/stations/station-sos.png`),
  close: opt(`${F}/close/close-scooter-listener.png`),
} as const;

/** Background/skin art → --af-<key>: a full background layer (url + position/size/repeat). [key, path, width, tail] */
const BAND = 'center / clamp(560px, 52vw, 880px) 100% repeat-x';
const BG: [string, string, number, string][] = [
  ['grille', `${F}/borders/border-speaker-grille.png`, 1600, BAND],
  ['waves', `${F}/borders/border-70s-waves.png`, 1600, BAND],
  ['records', `${F}/borders/border-record-row.png`, 1600, BAND],
  ['dial', `${F}/borders/border-dial-scale.png`, 1600, BAND],
  ['tterrazzo', `${F}/tiles/tile-terrazzo.png`, 600, 'center / 300px repeat'],
  ['tcurtain', `${F}/tiles/tile-70s-curtain.png`, 600, 'center / 300px repeat'],
  ['twall', `${F}/tiles/tile-wallpaper-circles.png`, 600, 'center / 300px repeat'],
  ['tveneer', `${F}/tiles/tile-radio-veneer.png`, 600, 'center / 300px repeat'],
  ['tpostcard', `${F}/tiles/tile-postcard-paper.png`, 600, 'center / 300px repeat'],
];
const SKINS: [string, string, number][] = [
  ['btn', `${F}/buttons/btn-bakelite.png`, 900],
  ['btn2', `${F}/buttons/btn-dial-cream.png`, 900],
];
export const CONTACT_BG = BG.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width, tail]) => ({ key, path, width, tail }));
export const CONTACT_SKINS = SKINS.filter(([, p]) => existsSync(PUBLIC + p)).map(([key, path, width]) => ({ key, path, width }));
