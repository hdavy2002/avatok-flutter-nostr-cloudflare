// [HF-AUTH-PCO-1 2026-10-17] "STD-PCO booth" sign-in / create-account skin (owner-chosen concept; owner rule: these
// pages use ONLY their own fresh artwork — never art from any other page). Prompt pack: SaatHum project doc
// claude/hello-fraands-auth-artwork-prompts.md. Files live in /assets/hf-auth/; a slot with no file renders nothing and
// the CSS-drawn booth stands in. Build runs from web/.
// /sign-in and /sign-up are PRERENDERED ([HF-AUTH-PCO-3]) so this filesystem check runs at build time only.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(process.cwd(), 'public');
const has = (p: string): boolean => existsSync(PUBLIC + p);
const opt = (p: string): string => (has(p) ? p : '');
const A = '/assets/hf-auth';

export const AUTH_ART = {
  signInHero: opt(`${A}/hero/pco-signin.png`),
  signUpHero: opt(`${A}/hero/pco-signup.png`),
  board: opt(`${A}/booth/pco-board.png`),
  stickerSignIn: opt(`${A}/stickers/sticker-hello-kaun.png`),
  stickerSignUp: opt(`${A}/stickers/sticker-pehli-call.png`),
  stickerPrivate: opt(`${A}/stickers/sticker-number-private.png`),
} as const;

/** Background art → --au-<key> custom properties. [key, path, width] */
const BG: [string, string, number][] = [
  ['wall', `${A}/booth/booth-wall.png`, 800],
  ['coins', `${A}/booth/coin-strip.png`, 1600],
  ['tiles', `${A}/booth/floor-tiles.png`, 800],
];
/** Button skins (keypad keys) switch on per file via data-skins on the root. [key, path, width] */
const SKINS: [string, string, number][] = [
  ['primary', `${A}/buttons/key-primary.png`, 900],
  ['dark', `${A}/buttons/key-dark.png`, 900],
  ['light', `${A}/buttons/key-light.png`, 900],
  ['small', `${A}/buttons/key-small.png`, 500],
  ['field', `${A}/fields/field-frame.png`, 600],
  ['fieldfocus', `${A}/fields/field-frame-focus.png`, 600],
  ['tick', `${A}/fields/field-tick.png`, 600],
];
export const AUTH_BG = BG.filter(([, p]) => has(p)).map(([key, path, width]) => ({ key, path, width }));
export const AUTH_SKINS = SKINS.filter(([, p]) => has(p)).map(([key, path, width]) => ({ key, path, width }));
