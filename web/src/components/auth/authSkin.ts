// [HF-AUTH-GHAR-1 2026-10-17] "Gaon ka Ghar" sign-in / create-account skin (owner: Indian treatment, no site header or
// footer, same layout on both pages, new button artwork and graphics from a prompt pack — SaatHum project doc
// claude/hello-fraands-auth-artwork-prompts.md). Art lives ONLY in /assets/hf-auth/. Owner rule (2026-10-17): these
// pages must never reuse artwork from anywhere else on the site — a slot with no file simply renders nothing / CSS.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const has = (p: string): boolean => existsSync(PUBLIC + p);
const opt = (p: string): string => (has(p) ? p : '');
const A = '/assets/hf-auth';

export const AUTH_ART = {
  signInHero: opt(`${A}/hero/signin-hero.png`),
  signUpHero: opt(`${A}/hero/signup-hero.png`),
  heroRing: opt(`${A}/frames/hero-ring.png`),
  roof: opt(`${A}/ghar/roof-door.png`),
  stickerSignIn: opt(`${A}/stickers/sticker-wapas-aa-gaye.png`),
  stickerSignUp: opt(`${A}/stickers/sticker-swagat-hai.png`),
  stickerPrivate: opt(`${A}/stickers/sticker-number-private.png`),
} as const;

/** Background art → --au-<key> custom properties. [key, path, width] */
const BG: [string, string, number][] = [
  ['sky', opt(`${A}/ghar/sky-auth.png`), 2400],
  ['rangoli', opt(`${A}/ghar/rangoli-doorstep.png`), 1600],
  ['wall', opt(`${A}/ghar/wall-auth.png`), 640],
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
