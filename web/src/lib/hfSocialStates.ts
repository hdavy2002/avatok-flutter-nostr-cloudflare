/* [HF-SOCIAL-STATES] Social media verification has THREE states (rulebook HF-INTRO-3 amendment, 2026-10-29):
 *   verified       - at least one proven account meets the minimum: green tick, counts as "social or video KYC".
 *   below_minimum  - she PROVED she owns an account (Log in with Facebook / Instagram / YouTube, or the bio code) but it is under the minimum.
 *                    Shown by name with its numbers and a Remove option. It does NOT count (no tick, does not satisfy "social or KYC").
 *   none           - nothing proven yet.
 * Worker: GET /api/hf/spaces/me -> social (routes/hf_spaces.ts). Kept word for word in step with the app (hf-flutter lib/data/social_states.dart). */

export type SocialNeed = 'followers' | 'views' | 'hidden_count';
export interface SocialAccount {
  id: string; platform: string; handle: string; displayHandle: string | null; url: string | null; followers: number; views: number;
  state: 'approved' | 'below_minimum'; need: SocialNeed | null; viaLogin: boolean;
}
export interface SocialSummary { state: 'verified' | 'below_minimum' | 'none'; accounts: SocialAccount[]; minFollowers: number; minViews: number }

const PLATFORM: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };
export const platformName = (p: string): string => PLATFORM[p] ?? 'Social media';
const fmt = (n: number): string => Math.max(0, Math.trunc(n || 0)).toLocaleString('en-IN');
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

/** "Facebook Page" / "YouTube channel" / "Instagram account". */
export const accountNoun = (p: string): string => (p === 'facebook' ? 'Facebook Page' : p === 'youtube' ? 'YouTube channel' : p === 'instagram' ? 'Instagram account' : 'social media account');

/** The name to show. A numeric handle (an old Facebook save kept the Page id) becomes "your Facebook Page". */
export function accountName(a: Pick<SocialAccount, 'platform' | 'handle' | 'displayHandle'>): string {
  const h = (a.displayHandle ?? (/^\d+$/.test(String(a.handle ?? '').trim()) ? '' : String(a.handle ?? ''))).trim();
  if (!h) return `your ${accountNoun(a.platform)}`;
  return a.platform === 'instagram' || a.platform === 'youtube' ? (h.startsWith('@') ? h : `@${h}`) : h;
}

/** Followers word per platform (YouTube calls them subscribers). */
const followersText = (a: Pick<SocialAccount, 'platform' | 'followers'>) => plural(a.followers, a.platform === 'youtube' ? 'subscriber' : 'follower', a.platform === 'youtube' ? 'subscribers' : 'followers');

/** Approved: "Verified ✓ Instagram · @priya.reels · 900 followers". */
export function verifiedLine(a: SocialAccount): string {
  return `Verified ✓ ${platformName(a.platform)} · ${accountName(a)} · ${followersText(a)}`;
}

/** Below minimum, first line: "Facebook Page connected: Priya Vlogs · 0 followers". */
export function belowTitle(a: SocialAccount): string {
  return `${accountNoun(a.platform).replace(/^./, c => c.toUpperCase())} connected: ${accountName(a)} · ${followersText(a)}${a.platform === 'youtube' ? ` · ${plural(a.views, 'view', 'views')}` : ''}`;
}

/** Below minimum, second line: what it needs to count, and the other ways forward. */
export function belowNeed(a: SocialAccount, minFollowers: number, minViews: number): string {
  const unit = a.platform === 'youtube' ? 'subscribers' : 'followers';
  const need = a.need === 'views' ? `It needs ${fmt(minViews)} total views to count.`
    : a.need === 'hidden_count' ? 'Your subscriber count is hidden. Show it in YouTube settings so it can count.'
    : a.platform === 'youtube' ? `It needs ${fmt(minFollowers)} ${unit} and ${fmt(minViews)} views to count.`
    : `It needs ${fmt(minFollowers)} ${unit} to count.`;
  const others = (['youtube', 'instagram', 'facebook'] as const).filter(p => p !== a.platform).map(platformName).join(' or ');
  return `${need} Add ${others}, or do the Aadhaar check / video KYC.`;
}

/** Short status chip text for the card header. */
export const socialChip = (s: SocialSummary['state']): string => (s === 'verified' ? 'Verified' : s === 'below_minimum' ? 'Connected, not enough followers' : 'Not connected');

/** Text for the "Build trust" checklist step when nothing counts yet but an account is below the minimum. */
export function belowStepText(s: SocialSummary): string | null {
  const a = s.accounts.find(x => x.state === 'below_minimum');
  if (!a || s.state !== 'below_minimum') return null;
  return `${belowTitle(a)}. ${belowNeed(a, s.minFollowers, s.minViews)}`;
}

/** One rule for the Become checklist step 2 AND step 4 (rulebook HF-INTRO-3): approved social OR video KYC done. Profile progress never counts. */
export const trustDone = (channelApproved: boolean, videoKycDone: boolean): boolean => channelApproved || videoKycDone;

/** Message after Facebook sends her back with ?fb=connected&result=... */
export function facebookConnectedText(result: string): string {
  return result === 'needs_followers'
    ? 'Your Facebook Page is connected, but it does not have enough followers yet to count. Add YouTube or Instagram, or do the Aadhaar check / video KYC.'
    : 'Facebook is connected. Your social media verification is updated.';
}
