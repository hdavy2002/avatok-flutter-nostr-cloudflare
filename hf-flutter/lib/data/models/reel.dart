/// Reels models (HF-WIRE-4). Match worker/src/routes/hf_reels.ts. Parsing is tolerant: a missing key is a safe default.
library;

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
String? _str(Object? v) {
  final s = v?.toString();
  return (s == null || s.isEmpty) ? null : s;
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
  });

  final String slug;
  final String name;

  /// With the leading "@", or null.
  final String? handle;
  final String? avatar;
  final int ratePaise;
  final int followers;

  /// `online`, `busy` or `offline`.
  final String presence;

  bool get online => presence == 'online' || presence == 'busy';

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
    this.videoUrl,
    this.thumbUrl,
    this.caption = '',
    this.likes = 0,
    this.comments = 0,
    this.views = 0,
  });

  final String id;
  final ReelHost host;
  final String platform;
  final String? url;
  final String? embedUrl;

  /// A direct file when the provider gave one. It can EXPIRE: the player falls back to [embedUrl] when it fails.
  final String? videoUrl;
  final String? thumbUrl;
  final String caption;
  final int likes;
  final int comments;
  final int views;

  bool get playable => videoUrl != null || embedUrl != null;

  FeedReel withHost(ReelHost h) => FeedReel(
      id: id, host: h, platform: platform, url: url, embedUrl: embedUrl, videoUrl: videoUrl, thumbUrl: thumbUrl, caption: caption, likes: likes, comments: comments, views: views);

  factory FeedReel.fromJson(Map<String, dynamic> j, {ReelHost? host}) => FeedReel(
        id: _str(j['id']) ?? '',
        host: host ?? ReelHost.fromJson(j['host'] is Map ? Map<String, dynamic>.from(j['host'] as Map) : const {}),
        platform: _str(j['platform']) ?? 'youtube',
        url: _str(j['url']),
        embedUrl: _str(j['embedUrl']),
        videoUrl: _str(j['videoUrl']),
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
class PublicProfile {
  const PublicProfile({required this.host, this.about = '', this.reels = const [], this.likes = 0});

  final ReelHost host;
  final String about;
  final List<FeedReel> reels;

  /// Sum of the likes of her visible reels.
  final int likes;

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
    );
    final reels = [
      for (final e in (j['reels'] is List ? j['reels'] as List : const []))
        if (e is Map) FeedReel.fromJson(Map<String, dynamic>.from(e), host: host),
    ];
    return PublicProfile(
      host: host,
      about: _str(j['aboutPolished']) ?? _str(j['tagline']) ?? '',
      reels: reels,
      likes: reels.fold<int>(0, (a, r) => a + r.likes),
    );
  }
}
