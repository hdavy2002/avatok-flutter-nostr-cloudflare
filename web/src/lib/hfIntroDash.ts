/* [HF-INTRO-B4] Web dashboard client for the intro-video project: call option (A/B), the intro banner state and Log in with Facebook.
 * Specs/HF-INTRO-VIDEO-1-API.md (W1 /api/hf/me fields, W2 /api/hosts/me/call-option), Specs/HF-FACEBOOK-LOGIN-1.md (W3 start route).
 * Every piece is gated on a public flag from /api/config; any failure = flag off = today's dashboard. */
import { getMe, hfCall, type HfResult } from './hfCallsApi';
import { publicConfig } from './hfConfig'; // [HF-DASH-CACHE-1]

export type CallOption = 'A' | 'B';
// [HF-VERIFY-WEB-FLOW] channels (hfChannelsEnabled, YouTube with Google) and instagram (hfInstagramLoginEnabled) join the list for the My verifications buttons.
export interface IntroFlags { callOption: boolean; intro: boolean; facebook: boolean; instagram: boolean; channels: boolean }
export const NO_INTRO_FLAGS: IntroFlags = { callOption: false, intro: false, facebook: false, instagram: false, channels: false };
let flagsP: Promise<IntroFlags> | null = null;
export function introFlags(): Promise<IntroFlags> {
  if (!flagsP) {
    flagsP = publicConfig() // [HF-DASH-CACHE-1] shared /api/config request
      .then(c => ({
        callOption: c?.hfCallOptionEnabled === true, intro: c?.hfIntroOnboardingEnabled === true,
        channels: c?.hfChannelsEnabled === true,
        facebook: c?.hfChannelsEnabled === true && c?.hfFacebookLoginEnabled === true,
        instagram: c?.hfChannelsEnabled === true && c?.hfInstagramLoginEnabled === true,
      }))
      .catch(() => NO_INTRO_FLAGS);
  }
  return flagsP;
}

export const getCallOption = (): Promise<HfResult<{ ok: true; callOption: CallOption | null }>> => hfCall('GET', '/api/hosts/me/call-option');
export const putCallOption = (option: CallOption): Promise<HfResult<{ ok: true; callOption: CallOption; changed?: boolean }>> => hfCall('PUT', '/api/hosts/me/call-option', { option });

export type IntroStatus = 'none' | 'submitted' | 'approved' | 'rejected';
export interface IntroMe {
  needsIntroVideo?: boolean; introStatus?: IntroStatus; callOption?: CallOption | null;
  introRejectReasons?: Array<{ code?: string; text?: string } | string> | null; introRejectNote?: string | null;
}
export const getIntroMe = (): Promise<HfResult<IntroMe>> => getMe<IntroMe>(); // [HF-DASH-CACHE-1] shared /me

export const reasonText = (r: { code?: string; text?: string } | string): string => (typeof r === 'string' ? r : r.text || r.code || '');

/** [HF-VERIFY-WEB-FLOW] Which dashboard page a web login comes back to. The worker allow-lists the same two values (default become). */
export type WebReturn = 'verifications' | 'become';
/** GET /api/hf/channels/facebook/start?client=web&return=... -> { url }. */
export const facebookStart = (ret: WebReturn = 'verifications'): Promise<HfResult<{ ok: true; url: string }>> => hfCall('GET', `/api/hf/channels/facebook/start?client=web&return=${ret}`);
/** GET /api/hf/channels/instagram/start?client=web&return=... -> { url } (HF-IG-LOGIN-1). */
export const instagramStart = (ret: WebReturn = 'verifications'): Promise<HfResult<{ ok: true; url: string }>> => hfCall('GET', `/api/hf/channels/instagram/start?client=web&return=${ret}`);

/** Facebook adds "#_=_" to the address after its login. Remove it so the bar stays clean (and a later share/copy has no junk). */
export function stripFacebookHash(): void {
  try { if (window.location.hash === '#_=_') window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
}

export const IG_ERROR_TEXT: Record<string, string> = {
  cancelled: 'You cancelled the Instagram login. You can try again any time.',
  not_professional: 'That Instagram account is personal. Switch it to a Creator or Business account in Instagram settings, then try again.',
  claimed: 'That Instagram account is already linked to another account.',
  limit_reached: 'You have reached the most social accounts you can connect. Remove one first.',
  bad_state: 'That login link expired. Please try again.',
  not_enabled: 'Instagram login is not open yet.',
  not_configured: 'Instagram login is not available right now. Please try again later.',
  provider_error: 'Instagram did not answer. Please try again in a moment.',
};

export const FB_ERROR_TEXT: Record<string, string> = {
  cancelled: 'You cancelled the Facebook login. You can try again any time.',
  no_page: 'We could not find a Facebook Page on that account. Log in with the account that manages your Page.',
  claimed: 'That Facebook Page is already linked to another account.',
  limit_reached: 'You have reached the most social accounts you can connect. Remove one first.',
  bad_state: 'That login link expired. Please try again.',
  not_enabled: 'Facebook login is not open yet.',
  not_configured: 'Facebook login is not available right now. Please try again later.',
  provider_error: 'Facebook did not answer. Please try again in a moment.',
};
