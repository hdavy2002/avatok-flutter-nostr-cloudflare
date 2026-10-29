/* [HF-INTRO-B1] HF-INTRO-22 / spec D22: influencer onboarding happens in the app only. While /api/config hfIntroOnboardingEnabled is true, every
 * web "Become an influencer" entry lands on the "Download our app" panel at /hosts/onboarding. Off (or any failure) = the site behaves as before. */
import { request } from './apiClient';
import { capture } from './analytics';
import { BRAND } from './brand';
import { HF_PLAY_URL } from './hfApp';

/** The one page every web "Become an influencer" entry points at. */
export const INTRO_APP_PANEL_PATH = '/hosts/onboarding';

let flag: Promise<boolean> | null = null;
/** hfIntroOnboardingEnabled from /api/config (one request per page). Any failure counts as off. */
export function introAppOnlyEnabled(): Promise<boolean> {
  if (!flag) flag = request<{ hfIntroOnboardingEnabled?: boolean }>('/api/config', { query: { _: Date.now() }, timeoutMs: 8000 }).then((c) => c?.hfIntroOnboardingEnabled === true).catch(() => false);
  return flag;
}

// [HF-VERIFY-WEB-FLOW] isMaintenanceLink was removed: ?step= / ?add= links no longer reopen the old wizard while this flag is on (see OnboardingGate).

export function isAndroidPhone(ua: string): boolean {
  return /Android/i.test(ua) && /Mobile/i.test(ua);
}

/** Opens the installed app (its launcher activity, via the app's custom scheme + package); Chrome falls back to the Play listing when it is not installed. */
export function openAppIntentUrl(): string {
  const scheme = BRAND.domain.split('.')[0];
  return `intent://open#Intent;scheme=${scheme};package=${BRAND.hfPlayPackageId};S.browser_fallback_url=${encodeURIComponent(HF_PLAY_URL)};end`;
}

/** Catalog: hf_onb_web_download_app. source = which button: 'play' | 'open_app' | 'panel_view'. */
export function trackDownloadApp(source: string): void {
  capture('hf_onb_web_download_app', { source });
}
