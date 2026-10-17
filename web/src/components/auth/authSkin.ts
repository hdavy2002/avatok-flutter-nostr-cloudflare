// [HF-AUTH-GHAR-1 2026-10-17] "Gaon ka Ghar" sign-in / create-account skin (owner: Indian treatment, no site header or
// footer, same layout on both pages, new button artwork and graphics from a prompt pack — SaatHum project doc
// claude/hello-fraands-auth-artwork-prompts.md). Art lives in /assets/hf-auth/. Every slot falls back so the pages look
// finished before the owner's files land: heroes and village ornaments fall back to the help-centre set
// (/assets/hf-help/), buttons and stickers fall back to CSS / nothing. Build runs from web/.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const has = (p: string): boolean => existsSync(PUBLIC + p);
const pick = (fresh: string, fallback: string): string => (has(fresh) ? fresh : fallback);
const opt = (p: string): string => (has(p) ? p : '');
const A = '/assets/hf-auth';
const H = '/assets/hf-help';

export const AUTH_ART = {
  signInHero: pick(`${A}/hero/signin-hero.png`, `${H}/hero/hero-help.png`),
  signUpHero: pick(`${A}/hero/signup-hero.png`, `${H}/aangan/still-stuck.png`),
  heroRing: pick(`${A}/frames/hero-ring.png`, `${H}/frames/ring-medallion.png`),
  roof: pick(`${A}/ghar/roof-door.png`, `${H}/ghar/roof-khaprail.png`),
  stickerSignIn: opt(`${A}/stickers/sticker-wapas-aa-gaye.png`),
  stickerSignUp: opt(`${A}/stickers/sticker-swagat-hai.png`),
  stickerPrivate: opt(`${A}/stickers/sticker-number-private.png`),
} as const;

/** Background art → --au-<key> custom properties. [key, path, width] */
const BG: [string, string, number][] = [
  ['sky', pick(`${A}/ghar/sky-auth.png`, `${H}/ghar/sky-kites-strip.png`), 2400],
  ['rangoli', pick(`${A}/ghar/rangoli-doorstep.png`, `${H}/ghar/rangoli-strip.png`), 1600],
  ['wall', pick(`${A}/ghar/wall-auth.png`, `${H}/ghar/wall-mandana.png`), 640],
  ['mandana', `${H}/ghar/mandana-strip.png`, 1600],
];
/** Button skins switch on per file (data-skins on the root); until then help-desi CSS buttons stay. [key, path, width] */
const SKINS: [string, string, number][] = [
  ['primary', `${A}/buttons/btn-auth-primary.png`, 900],
  ['dark', `${A}/buttons/btn-auth-dark.png`, 900],
  ['light', `${A}/buttons/btn-auth-light.png`, 900],
  ['small', `${A}/buttons/btn-auth-small.png`, 500],
];
export const AUTH_BG = BG.filter(([, p]) => has(p)).map(([key, path, width]) => ({ key, path, width }));
export const AUTH_SKINS = SKINS.filter(([, p]) => has(p)).map(([key, path, width]) => ({ key, path, width }));
