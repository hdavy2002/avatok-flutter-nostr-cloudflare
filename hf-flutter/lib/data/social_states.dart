/// [HF-SOCIAL-STATES] Social media verification has THREE states (rulebook HF-INTRO-3 amendment, 2026-10-29):
///   verified       at least one proven account meets the minimum: green tick, counts as "social or video KYC".
///   belowMinimum   she PROVED she owns an account (Log in with Facebook / Instagram / YouTube, or the bio code) but it is under the
///                  minimum. Shown by name with its numbers. It does NOT count (no tick, does not satisfy "social or KYC").
///   none           nothing proven yet.
/// Worker: `social` in `GET /api/hf/spaces/me` and `GET /api/hf/onboarding/me` (routes/hf_channels.ts socialSummary).
/// The words are kept in step with the website (web/src/lib/hfSocialStates.ts).
library;

enum SocialState {
  verified,
  belowMinimum,
  none;

  static SocialState parse(Object? v) => switch ((v ?? '').toString()) {
        'verified' => SocialState.verified,
        'below_minimum' => SocialState.belowMinimum,
        _ => SocialState.none,
      };
}

/// One proven account: approved, or below the minimum (with what it still needs).
class SocialAccount {
  const SocialAccount({
    required this.id,
    required this.platform,
    this.handle = '',
    this.displayHandle,
    this.url,
    this.followers = 0,
    this.views = 0,
    this.approved = false,
    this.need,
    this.viaLogin = false,
  });

  final String id;

  /// `youtube | instagram | facebook`.
  final String platform;
  final String handle;

  /// The handle without a numeric Page id (null when the server only had the id).
  final String? displayHandle;
  final String? url;
  final int followers;
  final int views;
  final bool approved;

  /// `followers | views | hidden_count`, or null when approved.
  final String? need;
  final bool viaLogin;

  factory SocialAccount.fromJson(Map<String, dynamic> j) => SocialAccount(
        id: (j['id'] ?? '').toString(),
        platform: (j['platform'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        displayHandle: _s(j['displayHandle']),
        url: _s(j['url']),
        followers: _i(j['followers']),
        views: _i(j['views']),
        approved: j['state'] == 'approved',
        need: _s(j['need']),
        viaLogin: j['viaLogin'] == true,
      );
}

/// The whole summary: state + the proven accounts (approved first) + the minimums.
class SocialSummary {
  const SocialSummary({this.state = SocialState.none, this.accounts = const <SocialAccount>[], this.minFollowers = 20, this.minViews = 1000});

  final SocialState state;
  final List<SocialAccount> accounts;
  final int minFollowers;
  final int minViews;

  static const SocialSummary empty = SocialSummary();

  /// The account for [platform] (approved first), or null.
  SocialAccount? forPlatform(String platform) {
    for (final a in accounts) {
      if (a.platform == platform) return a;
    }
    return null;
  }

  /// The first account below the minimum, or null.
  SocialAccount? get firstBelow {
    for (final a in accounts) {
      if (!a.approved) return a;
    }
    return null;
  }

  factory SocialSummary.fromJson(Object? v) {
    if (v is! Map) return empty;
    final j = Map<String, dynamic>.from(v);
    final raw = j['accounts'];
    return SocialSummary(
      state: SocialState.parse(j['state']),
      accounts: raw is List ? [for (final e in raw) if (e is Map) SocialAccount.fromJson(Map<String, dynamic>.from(e))].where((a) => a.platform.isNotEmpty).toList() : const [],
      minFollowers: j['minFollowers'] is num ? (j['minFollowers'] as num).toInt() : 20,
      minViews: j['minViews'] is num ? (j['minViews'] as num).toInt() : 1000,
    );
  }
}

// ------------------------------------------------------------------------------------------------- words (same as the website)

String socialPlatformName(String p) => switch (p) {
      'facebook' => 'Facebook',
      'instagram' => 'Instagram',
      'youtube' => 'YouTube',
      _ => 'Social media',
    };

/// "Facebook Page" / "YouTube channel" / "Instagram account".
String socialAccountNoun(String p) => switch (p) {
      'facebook' => 'Facebook Page',
      'youtube' => 'YouTube channel',
      'instagram' => 'Instagram account',
      _ => 'social media account',
    };

final RegExp _digits = RegExp(r'^\d+$');

/// The name to show. A numeric handle (an old Facebook save kept the Page id) becomes "your Facebook Page".
String socialAccountName(String platform, String handle, [String? displayHandle]) {
  final raw = (displayHandle ?? (_digits.hasMatch(handle.trim()) ? '' : handle)).trim();
  if (raw.isEmpty) return 'your ${socialAccountNoun(platform)}';
  if (platform == 'instagram' || platform == 'youtube') return raw.startsWith('@') ? raw : '@$raw';
  return raw;
}

String _fmt(int n) {
  final s = (n < 0 ? 0 : n).toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

String _plural(int n, String one, String many) => '${_fmt(n)} ${n == 1 ? one : many}';

String _followersText(String platform, int n) => platform == 'youtube' ? _plural(n, 'subscriber', 'subscribers') : _plural(n, 'follower', 'followers');

/// Approved: "Verified ✓ Instagram · @priya.reels · 900 followers".
String socialVerifiedLine(SocialAccount a) =>
    'Verified ✓ ${socialPlatformName(a.platform)} · ${socialAccountName(a.platform, a.handle, a.displayHandle)} · ${_followersText(a.platform, a.followers)}';

/// Below minimum, first line: "Facebook Page connected: Priya Vlogs · 0 followers".
String socialBelowTitle(SocialAccount a) {
  final noun = socialAccountNoun(a.platform);
  final cap = noun.isEmpty ? noun : noun[0].toUpperCase() + noun.substring(1);
  final views = a.platform == 'youtube' ? ' · ${_plural(a.views, 'view', 'views')}' : '';
  return '$cap connected: ${socialAccountName(a.platform, a.handle, a.displayHandle)} · ${_followersText(a.platform, a.followers)}$views';
}

/// Below minimum, second line: what it needs to count, and the other ways forward.
String socialBelowNeed(SocialAccount a, int minFollowers, int minViews) {
  final unit = a.platform == 'youtube' ? 'subscribers' : 'followers';
  final String need;
  if (a.need == 'views') {
    need = 'It needs ${_fmt(minViews)} total views to count.';
  } else if (a.need == 'hidden_count') {
    need = 'Your subscriber count is hidden. Show it in YouTube settings so it can count.';
  } else if (a.platform == 'youtube') {
    need = 'It needs ${_fmt(minFollowers)} $unit and ${_fmt(minViews)} views to count.';
  } else {
    need = 'It needs ${_fmt(minFollowers)} $unit to count.';
  }
  final others = ['youtube', 'instagram', 'facebook'].where((p) => p != a.platform).map(socialPlatformName).join(' or ');
  return '$need Add $others, or do the Aadhaar check / video KYC.';
}

/// Short status for a badge row.
String socialStatusText(SocialState s) => switch (s) {
      SocialState.verified => 'Social media verified',
      SocialState.belowMinimum => 'Connected, not enough followers',
      SocialState.none => 'None verified yet',
    };

/// What to say after a social login sends her back (`<scheme>://channels?fb|ig=connected&result=...`).
String socialConnectedText(String platform, String? result) {
  final name = socialPlatformName(platform);
  if (result == 'needs_followers' || result == 'needs_views' || result == 'hidden_count') {
    final noun = socialAccountNoun(platform);
    final others = ['youtube', 'instagram', 'facebook'].where((p) => p != platform).map(socialPlatformName).join(' or ');
    return 'Your $noun is connected, but it does not have enough ${result == 'needs_views' ? 'views' : 'followers'} yet to count. Add $others, or do the Aadhaar check / video KYC.';
  }
  return '$name is connected. Your social media verification is updated.';
}

/// What to say when a Facebook / Instagram login did not finish (`reason=`).
String socialReasonText(String platform, String? reason) {
  final name = socialPlatformName(platform);
  switch (reason) {
    case 'cancelled':
      return 'You closed the $name login before it finished. Tap Log in to try again.';
    case 'no_page':
      return 'We could not find a Facebook Page on that login. Log in with the account that manages your Page, or create a free Page first.';
    case 'claimed':
      return 'That account is already linked to another person.';
    case 'limit_reached':
      return 'You can connect up to 5 social accounts. Remove one first.';
    case 'bad_state':
      return 'That login link expired. Please try again.';
    case 'not_enabled':
    case 'not_configured':
      return '$name login is not open yet. You can do the Aadhaar check instead.';
    default:
      return 'We could not connect $name. Please try again.';
  }
}

String? _s(Object? v) {
  final s = (v ?? '').toString().trim();
  return s.isEmpty ? null : s;
}

int _i(Object? v) => v is num ? v.toInt() : int.tryParse((v ?? '').toString()) ?? 0;
