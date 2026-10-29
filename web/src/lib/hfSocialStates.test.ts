// [HF-SOCIAL-STATES] the three social-verification states and their wording (kept in step with hf-flutter lib/data/social_states.dart).
// @ts-ignore vitest is installed in worker/node_modules only (same as hfPayoutApi.test.ts)
import { describe, it, expect } from 'vitest';
import { accountName, belowNeed, belowStepText, belowTitle, facebookConnectedText, socialChip, trustDone, verifiedLine, type SocialAccount, type SocialSummary } from './hfSocialStates';

const acct = (over: Partial<SocialAccount> = {}): SocialAccount => ({
  id: 'hfch_1', platform: 'facebook', handle: '1378608792005431', displayHandle: null, url: 'https://www.facebook.com/1378608792005431',
  followers: 0, views: 0, state: 'below_minimum', need: 'followers', viaLogin: true, ...over,
});

describe('below minimum (connected, does not count)', () => {
  it('the owner case: numeric Facebook handle -> "your Facebook Page", 0 followers, needs 20, other ways forward', () => {
    const a = acct();
    expect(`${belowTitle(a)}. ${belowNeed(a, 20, 1000)}`).toBe('Facebook Page connected: your Facebook Page · 0 followers. It needs 20 followers to count. Add YouTube or Instagram, or do the Aadhaar check / video KYC.');
  });
  it('a named Page shows its name', () => {
    expect(belowTitle(acct({ handle: 'Priya Vlogs', displayHandle: 'Priya Vlogs', followers: 3 }))).toBe('Facebook Page connected: Priya Vlogs · 3 followers');
  });
  it('YouTube: subscribers + views, and the views rule', () => {
    const a = acct({ platform: 'youtube', handle: 'priyatv', displayHandle: 'priyatv', followers: 50, views: 10, need: 'views' });
    expect(belowTitle(a)).toBe('YouTube channel connected: @priyatv · 50 subscribers · 10 views');
    expect(belowNeed(a, 20, 1000)).toBe('It needs 1,000 total views to count. Add Instagram or Facebook, or do the Aadhaar check / video KYC.');
    expect(belowNeed({ ...a, need: 'followers' }, 20, 1000)).toBe('It needs 20 subscribers and 1,000 views to count. Add Instagram or Facebook, or do the Aadhaar check / video KYC.');
  });
  it('Instagram', () => {
    const a = acct({ platform: 'instagram', handle: 'priya.reels', displayHandle: 'priya.reels', followers: 1 });
    expect(belowTitle(a)).toBe('Instagram account connected: @priya.reels · 1 follower');
    expect(belowNeed(a, 20, 1000)).toContain('Add YouTube or Facebook');
  });
  it('step text only when nothing counts yet', () => {
    const s: SocialSummary = { state: 'below_minimum', accounts: [acct()], minFollowers: 20, minViews: 1000 };
    expect(belowStepText(s)).toMatch(/^Facebook Page connected: your Facebook Page · 0 followers\. It needs 20 followers/);
    expect(belowStepText({ ...s, state: 'verified' })).toBeNull();
    expect(belowStepText({ ...s, state: 'none', accounts: [] })).toBeNull();
  });
});

describe('verified and none', () => {
  it('verified line', () => {
    expect(verifiedLine(acct({ platform: 'instagram', handle: 'priya.reels', displayHandle: 'priya.reels', followers: 900, state: 'approved', need: null }))).toBe('Verified ✓ Instagram · @priya.reels · 900 followers');
  });
  it('chips', () => {
    expect(socialChip('verified')).toBe('Verified');
    expect(socialChip('below_minimum')).toBe('Connected, not enough followers');
    expect(socialChip('none')).toBe('Not connected');
  });
  it('accountName never shows digits', () => {
    expect(accountName({ platform: 'facebook', handle: '12345', displayHandle: undefined as unknown as null })).toBe('your Facebook Page');
  });
});

describe('Become checklist: step 2 and step 4 share one rule', () => {
  it('approved social OR video KYC; nothing else (profile progress, below-minimum accounts) counts', () => {
    expect(trustDone(false, false)).toBe(false);
    expect(trustDone(true, false)).toBe(true);
    expect(trustDone(false, true)).toBe(true);
  });
  it('return from Facebook below the minimum says connected, not verified', () => {
    expect(facebookConnectedText('needs_followers')).toMatch(/connected, but it does not have enough followers/);
    expect(facebookConnectedText('approved')).toMatch(/updated/);
  });
});
