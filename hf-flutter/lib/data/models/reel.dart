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

/// [HF-REEL-ENGAGE-APP-1] A like or comment number split by where it came from: [platform] is what YouTube / Instagram
/// say, [ours] is what people added here, [total] is the sum shown on the button.
class EngageCount {
  const EngageCount({this.platform = 0, this.ours = 0, int? total}) : total = total ?? platform + ours;

  final int platform;
  final int ours;
  final int total;

  Map<String, int> toJson() => {'platform': platform, 'ours': ours, 'total': total};

  EngageCount plusOurs(int d) {
    final o = (ours + d) < 0 ? 0 : ours + d;
    return EngageCount(platform: platform, ours: o);
  }

  /// Null when [v] is not a map (the server has the feature off).
  static EngageCount? tryParse(Object? v) {
    if (v is! Map) return null;
    final p = _int(v['platform']);
    final o = _int(v['ours']);
    return EngageCount(platform: p, ours: o, total: v['total'] is num ? _int(v['total']) : p + o);
  }

  @override
  bool operator ==(Object other) => other is EngageCount && other.platform == platform && other.ours == ours && other.total == total;

  @override
  int get hashCode => Object.hash(platform, ours, total);
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

/// [HF-INTRO-A2] One verified social account of an intro-video influencer (`socials[]` of a reel). [platform] is
/// `youtube`, `instagram` or `facebook`; [followers] is null when the server did not say.
class ReelSocial {
  const ReelSocial({required this.platform, required this.handle, required this.url, this.followers});

  final String platform;
  final String handle;
  final String url;
  final int? followers;

  /// Null when [v] is not a map or has no platform / address.
  static ReelSocial? tryParse(Object? v) {
    if (v is! Map) return null;
    final p = _str(v['platform'])?.toLowerCase();
    final u = _str(v['url']);
    if (p == null || u == null) return null;
    final f = v['followers'];
    return ReelSocial(platform: p, handle: _str(v['handle']) ?? '', url: u, followers: f is num ? f.toInt() : null);
  }
}

/// [HF-INTRO-A2] A category chip on an intro reel (`categories[]`).
class ReelCategory {
  const ReelCategory({required this.id, required this.label});

  final String id;
  final String label;

  static ReelCategory? tryParse(Object? v) {
    if (v is! Map) return null;
    final label = _str(v['label']);
    if (label == null) return null;
    return ReelCategory(id: _str(v['id']) ?? label, label: label);
  }
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
    this.likeCounts,
    this.commentCounts,
    this.likedByMe = false,
    this.kind = 'embed',
    this.videoUrl,
    this.posterUrl,
    this.description = '',
    this.ratePaise = 0,
    this.callOption,
    this.mainAction,
    this.womenOnly = false,
    this.socials = const [],
    this.categories = const [],
    this.shareUrl,
    this.greenTick = false,
  });

  final String id;
  final ReelHost host;

  /// [HF-INTRO-A2] `intro` for an approved intro video (our own MP4), else `embed` (a YouTube / Instagram reel).
  final String kind;

  /// Intro video: the vertical MP4 and its poster.
  final String? videoUrl;
  final String? posterUrl;

  /// Intro video: the one-line description and the rate (paise a minute) shown on the overlay.
  final String description;
  final int ratePaise;

  /// `A` (bookings only) / `B` (bookings + live) / null.
  final String? callOption;

  /// `call` / `queue_or_book` / `book` / `none` when the server sent it (flag `hfCallOptionEnabled`); null otherwise.
  final String? mainAction;

  /// Women-to-Women channel: pink tag and the Aadhaar gate on Call / Queue / Book.
  final bool womenOnly;
  final List<ReelSocial> socials;
  final List<ReelCategory> categories;

  /// The public link that plays this video (`https://<brand>/r/<id>`).
  final String? shareUrl;

  /// Approved by our team: the green tick.
  final bool greenTick;

  /// An approved intro video with a file to play.
  bool get isIntro => kind == 'intro' && videoUrl != null;

  /// What the one main button does. The server's `mainAction` wins; without it the plan's button rule is applied to
  /// [callOption] and the call state (A -> book; B available -> call; B busy -> queue_or_book; otherwise book).
  String get effectiveMainAction {
    final m = mainAction;
    if (m == 'call' || m == 'queue_or_book' || m == 'book' || m == 'none') return m!;
    if (callOption == 'A') return 'book';
    switch (host.callState) {
      case HostCallState.available:
        return 'call';
      case HostCallState.onCall:
      case HostCallState.connecting:
      case HostCallState.queueOnly:
        return 'queue_or_book';
      case HostCallState.appointments:
      case HostCallState.offline:
      case null:
        return 'book';
    }
  }

  /// [HF-REEL-ENGAGE-APP-1] Null when the server has likes and comments off: the Like and Comment buttons are then hidden.
  final EngageCount? likeCounts;
  final EngageCount? commentCounts;
  final bool likedByMe;

  /// The server sent the engagement numbers, so Like and Comment are shown.
  bool get engagementOn => likeCounts != null;
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
  bool get playable => embedUrl != null || isIntro;

  FeedReel withHost(ReelHost h) => FeedReel(
      id: id, host: h, platform: platform, url: url, embedUrl: embedUrl, thumbUrl: thumbUrl, caption: caption, likes: likes, comments: comments, views: views, invite: invite,
      likeCounts: likeCounts, commentCounts: commentCounts, likedByMe: likedByMe,
      kind: kind, videoUrl: videoUrl, posterUrl: posterUrl, description: description, ratePaise: ratePaise, callOption: callOption,
      mainAction: mainAction, womenOnly: womenOnly, socials: socials, categories: categories, shareUrl: shareUrl, greenTick: greenTick);

  factory FeedReel.fromJson(Map<String, dynamic> j, {ReelHost? host}) {
    final inv = j['kind'] == 'invite' && j['creator'] is Map ? InviteCreator.fromJson(Map<String, dynamic>.from(j['creator'] as Map)) : null;
    return FeedReel._parse(j, host: host ?? (inv == null ? null : ReelHost(slug: '', name: inv.name, handle: inv.handle, avatar: inv.avatar, followers: inv.followers)), invite: inv);
  }

  factory FeedReel._parse(Map<String, dynamic> j, {ReelHost? host, InviteCreator? invite}) {
    final intro = j['kind'] == 'intro' && _str(j['videoUrl']) != null;
    final socials = [
      for (final e in (j['socials'] is List ? j['socials'] as List : const []))
        if (ReelSocial.tryParse(e) != null) ReelSocial.tryParse(e)!,
    ];
    final categories = [
      for (final e in (j['categories'] is List ? j['categories'] as List : const []))
        if (ReelCategory.tryParse(e) != null) ReelCategory.tryParse(e)!,
    ];
    final hostJson = j['host'] is Map ? Map<String, dynamic>.from(j['host'] as Map) : <String, dynamic>{};
    if (intro) {
      // [HF-INTRO-A2] the reel's own rate, call state and queue are the live ones; the socials give the small platform icons
      if (hostJson['ratePaise'] == null && j['ratePaise'] != null) hostJson['ratePaise'] = j['ratePaise'];
      if (j['callState'] != null) hostJson['callState'] = j['callState'];
      if (j['queue'] is Map) hostJson['queue'] = j['queue'];
      if (hostJson['platforms'] is! List) hostJson['platforms'] = [for (final x in socials) x.platform];
    }
    final posterUrl = _str(j['posterUrl']);
    final description = _str(j['description']) ?? _str(j['caption']) ?? '';
    return FeedReel(
        id: _str(j['id']) ?? '',
        invite: invite,
        host: host ?? ReelHost.fromJson(hostJson),
        kind: intro ? 'intro' : 'embed',
        videoUrl: intro ? _str(j['videoUrl']) : null,
        posterUrl: posterUrl,
        description: description,
        ratePaise: _int(j['ratePaise'] ?? hostJson['ratePaise']),
        callOption: (j['callOption'] == 'A' || j['callOption'] == 'B') ? j['callOption'] as String : null,
        mainAction: _str(j['mainAction']),
        womenOnly: j['womenOnly'] == true,
        socials: socials,
        categories: categories,
        shareUrl: _str(j['shareUrl']),
        greenTick: j['greenTick'] == true || (hostJson['greenTick'] == true),
        platform: _str(j['platform']) ?? 'youtube',
        url: _str(j['url']),
        embedUrl: _str(j['embedUrl']),
        thumbUrl: _str(j['thumbUrl']) ?? posterUrl,
        caption: _str(j['caption']) ?? description,
        likes: _int(j['likes']),
        comments: _int(j['comments']),
        views: _int(j['views']),
        likeCounts: EngageCount.tryParse(j['likeCounts']),
        commentCounts: EngageCount.tryParse(j['commentCounts']) ?? (EngageCount.tryParse(j['likeCounts']) == null ? null : EngageCount(platform: _int(j['comments']))),
        likedByMe: j['likedByMe'] == true,
      );
  }
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
