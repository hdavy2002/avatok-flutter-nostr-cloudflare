import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/data/models/channel.dart';
import 'package:hf_app/data/models/intro_onboarding.dart';
import 'package:hf_app/data/models/spaces.dart';
import 'package:hf_app/data/social_states.dart';
import 'package:hf_app/demo/screens/onboarding/intro_onb_kit.dart';

// [HF-SOCIAL-STATES] Social media verification in three states: verified / connected-below-minimum / none. Same words as the website
// (web/src/lib/hfSocialStates.test.ts). The owner's case: a login-proven Facebook Page, numeric handle, 0 followers.

const _ownerFb = {
  'id': 'hfch_fb1',
  'platform': 'facebook',
  'handle': '1378608792005431',
  'displayHandle': null,
  'url': 'https://www.facebook.com/1378608792005431',
  'followers': 0,
  'views': 0,
  'state': 'below_minimum',
  'need': 'followers',
  'viaLogin': true,
};

void main() {
  group('SocialSummary parsing', () {
    test('below_minimum with the owner Facebook row', () {
      final s = SocialSummary.fromJson({'state': 'below_minimum', 'accounts': [_ownerFb], 'minFollowers': 20, 'minViews': 1000});
      expect(s.state, SocialState.belowMinimum);
      expect(s.accounts.single.approved, isFalse);
      expect(s.firstBelow?.platform, 'facebook');
      expect(s.forPlatform('facebook')?.need, 'followers');
      expect(s.forPlatform('youtube'), isNull);
    });
    test('missing or broken = none', () {
      expect(SocialSummary.fromJson(null).state, SocialState.none);
      expect(SocialSummary.fromJson({'state': 'weird', 'accounts': 'x'}).accounts, isEmpty);
    });
  });

  group('words (same as the website)', () {
    final fb = SocialAccount.fromJson(Map<String, dynamic>.from(_ownerFb));
    test('owner case: never the numeric id, needs 20, other ways forward', () {
      expect('${socialBelowTitle(fb)}. ${socialBelowNeed(fb, 20, 1000)}',
          'Facebook Page connected: your Facebook Page · 0 followers. It needs 20 followers to count. Add YouTube or Instagram, or do the Aadhaar check / video KYC.');
    });
    test('named Page, YouTube views rule, Instagram', () {
      expect(socialBelowTitle(const SocialAccount(id: 'a', platform: 'facebook', handle: 'Priya Vlogs', displayHandle: 'Priya Vlogs', followers: 3)), 'Facebook Page connected: Priya Vlogs · 3 followers');
      const yt = SocialAccount(id: 'b', platform: 'youtube', handle: 'priyatv', displayHandle: 'priyatv', followers: 50, views: 10, need: 'views');
      expect(socialBelowTitle(yt), 'YouTube channel connected: @priyatv · 50 subscribers · 10 views');
      expect(socialBelowNeed(yt, 20, 1000), 'It needs 1,000 total views to count. Add Instagram or Facebook, or do the Aadhaar check / video KYC.');
      expect(socialBelowNeed(const SocialAccount(id: 'c', platform: 'youtube', need: 'followers'), 20, 1000), startsWith('It needs 20 subscribers and 1,000 views to count.'));
      expect(socialBelowTitle(const SocialAccount(id: 'd', platform: 'instagram', handle: 'priya.reels', displayHandle: 'priya.reels', followers: 1)), 'Instagram account connected: @priya.reels · 1 follower');
    });
    test('verified line and status words', () {
      expect(socialVerifiedLine(const SocialAccount(id: 'e', platform: 'instagram', handle: 'priya.reels', displayHandle: 'priya.reels', followers: 900, approved: true)),
          'Verified ✓ Instagram · @priya.reels · 900 followers');
      expect(socialStatusText(SocialState.verified), 'Social media verified');
      expect(socialStatusText(SocialState.belowMinimum), 'Connected, not enough followers');
      expect(socialStatusText(SocialState.none), 'None verified yet');
    });
    test('return from Facebook: connected below the minimum is not "verified"; reasons are plain', () {
      expect(socialConnectedText('facebook', 'needs_followers'), 'Your Facebook Page is connected, but it does not have enough followers yet to count. Add YouTube or Instagram, or do the Aadhaar check / video KYC.');
      expect(socialConnectedText('facebook', 'approved'), 'Facebook is connected. Your social media verification is updated.');
      expect(socialReasonText('facebook', 'no_page'), contains('Facebook Page'));
      expect(socialReasonText('facebook', 'cancelled'), contains('closed the Facebook login'));
      expect(socialReasonText('facebook', 'limit_reached'), contains('up to 5'));
      expect(socialReasonText('facebook', null), 'We could not connect Facebook. Please try again.');
    });
  });

  group('the models carry it', () {
    test('GET /api/hf/spaces/me social; badges.channel stays false', () {
      final st = SpaceStatus.fromSpaces({
        'badges': {'phone': true, 'channel': false, 'videoKyc': false, 'space': null},
        'social': {'state': 'below_minimum', 'accounts': [_ownerFb], 'minFollowers': 20, 'minViews': 1000},
      });
      expect(st.badges.channel, isFalse);
      expect(st.social.state, SocialState.belowMinimum);
      expect(SpaceStatus.fromSpaces(const {}).social.state, SocialState.none);
    });
    test('GET /api/hf/onboarding/me social next to the approved-only socials', () {
      final me = OnbMe.fromJson({
        'socials': <Object>[],
        'social': {'state': 'below_minimum', 'accounts': [_ownerFb], 'minFollowers': 20, 'minViews': 1000},
      });
      expect(me.socials, isEmpty);
      expect(me.social('facebook'), isNull);
      expect(me.socialSummary.forPlatform('facebook')?.approved, isFalse);
    });
    test('a Facebook channel is Facebook (not YouTube), and need=views maps to needsViews', () {
      final c = Channel.fromJson({'id': 'x', 'platform': 'facebook', 'handle': '1378608792005431', 'displayHandle': null, 'state': 'needs_followers', 'verified': true, 'need': 'followers'});
      expect(c.platformName, 'Facebook');
      expect(c.followersWord, 'followers');
      expect(c.belowMinimum, isTrue);
      expect(socialAccountName(c.platform, c.handle, c.displayHandle), 'your Facebook Page');
      final y = Channel.fromJson({'id': 'y', 'platform': 'youtube', 'handle': 'tv', 'state': 'needs_followers', 'verified': true, 'need': 'views'});
      expect(y.state, ChannelState.needsViews);
      expect(y.platformName, 'YouTube');
    });
    test('the onboarding flow keeps result=needs_followers from the Facebook return', () {
      IntroOnbSession.active = true;
      addTearDown(() => IntroOnbSession.active = false);
      expect(IntroOnbSession.handleSocialReturn(Uri.parse('${Brand.scheme}://channels?fb=connected&result=needs_followers')), isTrue);
      expect(IntroOnbSession.lastPlatform, 'facebook');
      expect(IntroOnbSession.lastResult, 'connected');
      expect(IntroOnbSession.lastDetail, 'needs_followers');
      expect(IntroOnbSession.handleSocialReturn(Uri.parse('${Brand.scheme}://channels?fb=error&reason=no_page')), isTrue);
      expect(IntroOnbSession.lastResult, 'error');
      expect(IntroOnbSession.lastReason, 'no_page');
      expect(IntroOnbSession.lastDetail, isNull);
    });
  });
}
