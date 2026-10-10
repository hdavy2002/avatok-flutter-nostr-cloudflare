/* [HF-APP-3] Small shared bits for the web <-> Android app split (spec HF-APP-D8 / D11, HF-TOK-D7).
 * On the plain web, tokens are bought and token-paid calls are started in the app only. */
import { capture } from './analytics';
import { BRAND } from './brand';

/** Play package id of the Android app (from Specs/brand.json). */
export const HF_PLAY_PACKAGE_ID: string = BRAND.hfPlayPackageId;

/** "Get the app" link (Google Play listing). */
export const HF_PLAY_URL = `https://play.google.com/store/apps/details?id=${HF_PLAY_PACKAGE_ID}`;

/** The plain web showed a "use the app" blocker and the person tapped it. Catalog: hf_token_web_blocked. */
export function trackWebBlocked(reason: 'topup' | 'call'): void {
  capture('hf_token_web_blocked', { reason });
}
