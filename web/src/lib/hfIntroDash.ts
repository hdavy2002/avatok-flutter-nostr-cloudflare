/* [HF-INTRO-B4] Web dashboard client for the intro-video project: call option (A/B), the intro banner state and Log in with Facebook.
 * Specs/HF-INTRO-VIDEO-1-API.md (W1 /api/hf/me fields, W2 /api/hosts/me/call-option), Specs/HF-FACEBOOK-LOGIN-1.md (W3 start route).
 * Every piece is gated on a public flag from /api/config; any failure = flag off = today's dashboard. */
import { request } from './apiClient';
import { hfCall, type HfResult } from './hfCallsApi';

export type CallOption = 'A' | 'B';
export interface IntroFlags { callOption: boolean; intro: boolean; facebook: boolean }
export const NO_INTRO_FLAGS: IntroFlags = { callOption: false, intro: false, facebook: false };
let flagsP: Promise<IntroFlags> | null = null;
export function introFlags(): Promise<IntroFlags> {
  if (!flagsP) {
    flagsP = request<{ hfCallOptionEnabled?: boolean; hfIntroOnboardingEnabled?: boolean; hfFacebookLoginEnabled?: boolean }>('/api/config', { timeoutMs: 8000 })
      .then(c => ({ callOption: c?.hfCallOptionEnabled === true, intro: c?.hfIntroOnboardingEnabled === true, facebook: c?.hfFacebookLoginEnabled === true }))
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
export const getIntroMe = (): Promise<HfResult<IntroMe>> => hfCall<IntroMe>('GET', '/api/hf/me');

export const reasonText = (r: { code?: string; text?: string } | string): string => (typeof r === 'string' ? r : r.text || r.code || '');

/** GET /api/hf/channels/facebook/start?client=web -> { url }. */
export const facebookStart = (): Promise<HfResult<{ ok: true; url: string }>> => hfCall('GET', '/api/hf/channels/facebook/start?client=web');

export const FB_ERROR_TEXT: Record<string, string> = {
  cancelled: 'You cancelled the Facebook login. You can try again any time.',
  no_page: 'We could not find a Facebook Page on that account. Log in with the account that manages your Page.',
  claimed: 'That Facebook Page is already linked to another Hello Fraands account.',
  limit_reached: 'You have reached the most social accounts you can connect. Remove one first.',
  bad_state: 'That login link expired. Please try again.',
  not_enabled: 'Facebook login is not open yet.',
  not_configured: 'Facebook login is not available right now. Please try again later.',
  provider_error: 'Facebook did not answer. Please try again in a moment.',
};
