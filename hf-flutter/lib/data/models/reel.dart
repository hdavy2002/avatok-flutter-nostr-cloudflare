/// Reels models (HF-WIRE-4). Match worker/src/routes/hf_reels.ts. Parsing is tolerant: a missing key is a safe default.
library;

import 'queue.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
String? _str(Object? v) {
  final s = v?.toString();
  return (s == null || s.isEmpty) ? null : s;
}

/// [HF-CREATOR-SPACES-1] `women` / `lgbtq`, anything else (or missing) is null.
String? _spaceOf(Object? v) {
  final s = v?.toString();
  return (s == 'women' || s == 'lgbtq') ? s : null;
}

/// The influencer shown on a reel or at the top of a profile.
class ReelHost {
  const ReelHost({
    required this.slug,
    required this.name,
    this.handle,
    this.avatar,
    this.ratePaise = 0,
    this.followers = 0,
    this.presence = 'offline',
    this.platforms = const [],
    this.callState,
    this.queueOpen = false,
    this.queueWaiting = 0,
    this.videoKycVerified = false,
    this.space,
    this.callerLevel = 'everyone',
    this.channelVerified = false,
  });

  final String slug;
  final String name;

  /// [HF-CREATOR-SPACES-1] Aadhaar verified and the selfie video approved: the green badge. False when the server does not send it.
  final bool videoKycVerified;

  /// [HF-CREATOR-SPACES-1] `women` or `lgbtq` for a space channel, else null.
  final String? space;

  /// [HF-CREATOR-BADGES-1] `everyone` or `video_kyc` (spaces are always `video_kyc`). `everyone` when the server does not send it.
  final String callerLevel;

  /// [HF-CREATOR-BADGES-1] An approved channel is connected.
  final bool channelVerified;

  /// Only customers with full video KYC may call this creator.
  bool get kycCallersOnly => callerLevel == 'video_kyc';

  /// With the leading "@", or null.
  final String? handle;
  final String? avatar;
  final int ratePaise;
  final int followers;

  /// `online`, `busy` or `offline`.
  final String presence;

  /// `youtube` / `instagram` channels of this influencer (search results show a small icon). Empty when the server did not say.
  final List<String> platforms;

  bool get online => presence == 'online' || presence == 'busy';

  /// [HF-CALL-MODES-E2] What a fan sees (spec 2.1). Null when the server does not send it: callers then use [presence] as before.
  final HostCallState? callState;
  final bool queueOpen;
  final int queueWaiting;

  /// Whole rupees a minute for the pill.
  int get rateRupees => (ratePaise / 100).round();

  factory ReelHost.fromJson(Map<String, dynamic> j) => ReelHost(
        slug: _str(j['slug']) ?? '',
        name: _str(j['name']) ?? '',
        handle: _str(j['handle']),
        avatar: _str(j['avatar']),
        ratePaise: _int(j['ratePaise']),
        followers: _int(j['followers']),
        presence: _str(j['presence']) ?? 'offline',
        callState: hostCallStateOf(j['callState']),
        queueOpen: j['queue'] is Map && (j['queue'] as Map)['open'] == true,
        queueWaiting: j['queue'] is Map ? _int((j['queue'] as Map)['waiting']) : 0,
        videoKycVerified: j['videoKycVerified'] == true,
        space: _spaceOf(j['space']),
        callerLevel: j['callerLevel'] == 'video_kyc' ? 'video_kyc' : 'everyone',
        channelVerified: j['channelVerified'] == true,
        platforms: [
          for (final p in (j['platforms'] is List ? j['platforms'] as List : const []))
            if (p is String && p.isNotEmpty) p,
        ],
      );
}

/// [HF-WIRE-22] HF-REEL-40: a creator who is NOT on the app yet. Their reels sit after the network reels with an INVITE button (a vote).
class InviteCreator {
  const InviteCreator({required this.platform, required this.handle, this.name = '', this.avatar, this.followers = 0, this.votes = 0});

  final String platform;

  /// With the leading "@".
  final String handle;
  final String name;
  final String? avatar;
  final int followers;
  final int votes;

  String get key => '$platform:${handle.toLowerCase()}';

  factory InviteCreator.fromJson(Map<String, dynamic> j) => InviteCreator(
        platform: _str(j['platform']) ?? 'youtube',
        handle: _str(j['handle']) ?? '',
        name: _str(j['name']) ?? '',
        avatar: _str(j['avatar']),
        followers: _int(j['followers']),
        votes: _int(j['votes']),
      );
}

/// One reel in the feed or on a profile.
class FeedReel {
  const FeedReel({
    required this.id,
    required this.host,
    this.platform = 'youtube',
    this.url,
    this.embedUrl,
    this.thumbUrl,
    this.caption = '',
    this.likes = 0,
    this.comments = 0,
    this.views = 0,
    this.invite,
  });

  final String id;
  final ReelHost host;
  final String platform;
  final String? url;
  final String? embedUrl;

  final String? thumbUrl;
  final String caption;
  final int likes;
  final int comments;
  final int views;

  /// Set for an invite reel (creator not on the app yet): the card shows INVITE instead of Call / Book.
  final InviteCreator? invite;

  bool get isInvite => invite != null;

  /// Embeds only (HF-REEL-32): a reel plays from its official YouTube / Instagram embed, never from a file we hold.
  bool get playable => embedUrl != null;

  FeedReel withHost(ReelHost h) => FeedReel(
      id: id, host: h, platform: platform, url: url, embedUrl: embedUrl, thumbUrl: thumbUrl, caption: caption, likes: likes, comments: comments, views: views, invite: invite);

  factory FeedReel.fromJson(Map<String, dynamic> j, {ReelHost? host}) {
    final inv = j['kind'] == 'invite' && j['creator'] is Map ? InviteCreator.fromJson(Map<String, dynamic>.from(j['creator'] as Map)) : null;
    return FeedReel._parse(j, host: host ?? (inv == null ? null : ReelHost(slug: '', name: inv.name, handle: inv.handle, avatar: inv.avatar, followers: inv.followers)), invite: inv);
  }

  factory FeedReel._parse(Map<String, dynamic> j, {ReelHost? host, InviteCreator? invite}) => FeedReel(
        id: _str(j['id']) ?? '',
        invite: invite,
        host: host ?? ReelHost.fromJson(j['host'] is Map ? Map<String, dynamic>.from(j['host'] as Map) : const {}),
        platform: _str(j['platform']) ?? 'youtube',
        url: _str(j['url']),
        embedUrl: _str(j['embedUrl']),
        thumbUrl: _str(j['thumbUrl']),
        caption: _str(j['caption']) ?? '',
        likes: _int(j['likes']),
        comments: _int(j['comments']),
        views: _int(j['views']),
      );
}

/// One page of `GET /api/hf/reels`.
class ReelsPage {
  const ReelsPage({this.items = const [], this.nextCursor});

  final List<FeedReel> items;
  final String? nextCursor;

  factory ReelsPage.fromJson(Map<String, dynamic> j) => ReelsPage(
        items: [
          for (final e in (j['items'] is List ? j['items'] as List : const []))
            if (e is Map) FeedReel.fromJson(Map<String, dynamic>.from(e)),
        ],
        nextCursor: _str(j['nextCursor']),
      );
}

/// One of the signed-in influencer's own reels (`GET /api/hf/hosts/me/reels`).
class MyReel {
  const MyReel({
    required this.id,
    this.platform = 'youtube',
    this.thumbUrl,
    this.caption = '',
    this.views = 0,
    this.visible = false,
  });

  final String id;
  final String platform;
  final String? thumbUrl;
  final String caption;
  final int views;

  /// On the feed.
  final bool visible;

  MyReel copyWith({bool? visible}) => MyReel(id: id, platform: platform, thumbUrl: thumbUrl, caption: caption, views: views, visible: visible ?? this.visible);

  factory MyReel.fromJson(Map<String, dynamic> j) => MyReel(
        id: _str(j['id']) ?? '',
        platform: _str(j['platform']) ?? 'youtube',
        thumbUrl: _str(j['thumbUrl']),
        caption: _str(j['caption']) ?? '',
        views: _int(j['views']),
        visible: j['visible'] == true,
      );
}

/// `GET /api/hosts/public/:slug` with the reels fields (HF-WIRE-4).
/// [HF-APP-CHANNEL-PARITY-1] One review shown on the profile (first name only, never a full name or number).
class ProfileReview {
  const ProfileReview({required this.firstName, required this.stars, this.text = '', this.topic, this.minutes, this.regular = false, this.date});

  final String firstName;
  final int stars;
  final String text;
  final String? topic;
  final int? minutes;
  final bool regular;
  final DateTime? date;

  factory ProfileReview.fromJson(Map<String, dynamic> j) {
    final d = j['date'];
    final date = d is num ? DateTime.fromMillisecondsSinceEpoch(d.toInt()) : (d is String ? DateTime.tryParse(d) : null);
    final m = j['minutes'];
    return ProfileReview(
      firstName: _str(j['firstName']) ?? 'Someone',
      stars: _int(j['stars']).clamp(0, 5),
      text: _str(j['text']) ?? '',
      topic: _str(j['topic']),
      minutes: m is num ? m.toInt() : null,
      regular: j['regular'] == true,
      date: date,
    );
  }
}

class PublicProfile {
  const PublicProfile({
    required this.host,
    this.about = '',
    this.reels = const [],
    this.likes = 0,
    this.tagline = '',
    this.languages = const [],
    this.topics = const [],
    this.rating,
    this.reviewCount = 0,
    this.ratingBreakdown = const {},
    this.talkedTo = 0,
    this.reviews = const [],
    this.introAudioUrl,
    this.introSeconds,
    this.identityVerified = false,
    this.callEligible = true,
  });

  final ReelHost host;
  final String about;
  final List<FeedReel> reels;

  /// Sum of the likes of her visible reels.
  final int likes;

  // [HF-APP-CHANNEL-PARITY-1] the same fields the website profile page (/h/<slug>) shows.
  final String tagline;

  /// Language codes or names as stored ("en", "hi", "Hindi").
  final List<String> languages;

  /// Topic slugs ("talk-about-my-channel").
  final List<String> topics;
  final double? rating;
  final int reviewCount;

  /// Stars (5..1) -> number of reviews.
  final Map<int, int> ratingBreakdown;
  final int talkedTo;
  final List<ProfileReview> reviews;

  /// The influencer's own recorded voice introduction (admin-approved), if any.
  final String? introAudioUrl;
  final int? introSeconds;

  /// WhatsApp number verified by OTP (HF-IDV-WHATSAPP-1).
  final bool identityVerified;

  /// Verified and live: calls and bookings are allowed. A missing key (older server) counts as allowed.
  final bool callEligible;

  factory PublicProfile.fromJson(Map<String, dynamic> j) {
    final status = _str(j['status']) ?? 'offline';
    final host = ReelHost(
      slug: _str(j['slug']) ?? '',
      name: _str(j['displayName']) ?? '',
      handle: _str(j['handle']),
      avatar: _str(j['avatarUrl']),
      ratePaise: _int(j['pricePaisePerMin']),
      followers: _int(j['followers']),
      presence: status,
      callState: hostCallStateOf(j['callState']),
      queueOpen: j['queue'] is Map && (j['queue'] as Map)['open'] == true,
      queueWaiting: j['queue'] is Map ? _int((j['queue'] as Map)['waiting']) : 0,
      videoKycVerified: j['videoKycVerified'] == true,
      space: _spaceOf(j['space']),
      callerLevel: j['callerLevel'] == 'video_kyc' ? 'video_kyc' : 'everyone',
      channelVerified: j['channelVerified'] == true,
    );
    final reels = [
      for (final e in (j['reels'] is List ? j['reels'] as List : const []))
        if (e is Map) FeedReel.fromJson(Map<String, dynamic>.from(e), host: host),
    ];
    List<String> strs(Object? v) => [for (final e in (v is List ? v : const [])) if (_str(e) != null) _str(e)!];
    final bd = <int, int>{};
    final rb = j['ratingBreakdown'];
    if (rb is Map) {
      for (final k in const [5, 4, 3, 2, 1]) {
        bd[k] = _int(rb['$k']);
      }
    }
    final r = j['rating'];
    final secs = j['introSeconds'];
    return PublicProfile(
      host: host,
      // Same as the website: the polished bio, else the influencer's own saved bio.
      about: _str(j['aboutPolished']) ?? _str(j['about']) ?? '',
      reels: reels,
      likes: reels.fold<int>(0, (a, r) => a + r.likes),
      tagline: _str(j['tagline']) ?? '',
      languages: strs(j['languages']),
      topics: strs(j['topics']),
      rating: r is num ? r.toDouble() : null,
      reviewCount: _int(j['reviewCount']),
      ratingBreakdown: bd,
      talkedTo: _int(j['talkedTo']),
      reviews: [
        for (final e in (j['reviews'] is List ? j['reviews'] as List : const []))
          if (e is Map) ProfileReview.fromJson(Map<String, dynamic>.from(e)),
      ],
      introAudioUrl: _str(j['introAudioUrl']),
      introSeconds: secs is num ? secs.toInt() : null,
      identityVerified: j['identityVerified'] == true,
      callEligible: j['callEligible'] != false,
    );
  }
}
