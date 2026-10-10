import '../../../core/widgets/status_pill.dart';

/// One host as the list endpoints answer it (`GET /api/hf/hosts` items, same shape as `/api/hosts/public`).
///
/// `{slug, displayName, tagline, avatarUrl, languages[], style, topics[], pricePerMin, rating, reviewCount,
///   talkedTo, regulars, lgbtqFriendly, womenOnly, introAudioUrl, introSeconds, status}`
///
/// Parsing is tolerant: a missing key is a safe default, so one odd row never breaks the list.
/// Topics are slugs; their labels come from `GET /api/hf/options` (see `HostOptions.topicLabel`).
class HostCard {
  const HostCard({
    required this.slug,
    required this.displayName,
    this.tagline,
    this.avatarUrl,
    this.languages = const <String>[],
    this.style,
    this.topics = const <String>[],
    this.pricePerMin = 0,
    this.rating,
    this.reviewCount = 0,
    this.talkedTo = 0,
    this.regulars = 0,
    this.lgbtqFriendly = false,
    this.womenOnly = false,
    this.introAudioUrl,
    this.introSeconds,
    this.status = HostPresence.offline,
  });

  final String slug;
  final String displayName;
  final String? tagline;
  final String? avatarUrl;
  final List<String> languages;
  final String? style;
  final List<String> topics;

  /// Whole rupees per minute.
  final int pricePerMin;

  /// Average of approved stars (1 decimal), or null when there are no reviews yet.
  final double? rating;
  final int reviewCount;
  final int talkedTo;
  final int regulars;
  final bool lgbtqFriendly;
  final bool womenOnly;
  final String? introAudioUrl;
  final int? introSeconds;
  final HostPresence status;

  bool get isOnline => status == HostPresence.online;
  bool get hasIntro => introAudioUrl != null && introAudioUrl!.isNotEmpty;

  /// "₹12/min".
  String get priceLabel => '₹$pricePerMin/min';

  /// Null when the row has no usable slug (it cannot open a profile, so the list drops it).
  static HostCard? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final j = Map<String, dynamic>.from(raw);
    final slug = _str(j['slug']);
    if (slug == null) return null;
    return HostCard(
      slug: slug,
      displayName: _str(j['displayName']) ?? '',
      tagline: _str(j['tagline']),
      avatarUrl: _str(j['avatarUrl']),
      languages: _strList(j['languages']),
      style: _str(j['style']),
      topics: _strList(j['topics']),
      pricePerMin: _int(j['pricePerMin']) ?? 0,
      rating: _num(j['rating'])?.toDouble(),
      reviewCount: _int(j['reviewCount']) ?? 0,
      talkedTo: _int(j['talkedTo']) ?? 0,
      regulars: _int(j['regulars']) ?? 0,
      lgbtqFriendly: j['lgbtqFriendly'] == true,
      womenOnly: j['womenOnly'] == true,
      introAudioUrl: _str(j['introAudioUrl']),
      introSeconds: _int(j['introSeconds']),
      status: HostPresence.parse(j['status']),
    );
  }

  /// For the offline cache.
  Map<String, Object?> toJson() => <String, Object?>{
        'slug': slug,
        'displayName': displayName,
        'tagline': tagline,
        'avatarUrl': avatarUrl,
        'languages': languages,
        'style': style,
        'topics': topics,
        'pricePerMin': pricePerMin,
        'rating': rating,
        'reviewCount': reviewCount,
        'talkedTo': talkedTo,
        'regulars': regulars,
        'lgbtqFriendly': lgbtqFriendly,
        'womenOnly': womenOnly,
        'introAudioUrl': introAudioUrl,
        'introSeconds': introSeconds,
        'status': status.name,
      };

  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  static List<String> _strList(Object? v) =>
      v is List ? v.map((e) => e.toString()).where((e) => e.isNotEmpty).toList() : const <String>[];

  static num? _num(Object? v) => v is num ? v : (v is String ? num.tryParse(v) : null);

  static int? _int(Object? v) => _num(v)?.round();
}

/// One page of hosts: `{items, nextOffset, total}`.
class HostsPage {
  const HostsPage({required this.items, this.nextOffset, required this.total});

  final List<HostCard> items;

  /// Where the next page starts, or null on the last page.
  final int? nextOffset;
  final int total;

  static const HostsPage empty = HostsPage(items: <HostCard>[], total: 0);

  factory HostsPage.fromJson(Object? raw) {
    if (raw is! Map) return empty;
    final j = Map<String, dynamic>.from(raw);
    final items = <HostCard>[];
    final rawItems = j['items'];
    if (rawItems is List) {
      for (final r in rawItems) {
        final c = HostCard.tryParse(r);
        if (c != null) items.add(c);
      }
    }
    final next = j['nextOffset'];
    final total = j['total'];
    return HostsPage(
      items: items,
      nextOffset: next is num ? next.toInt() : null,
      total: total is num ? total.toInt() : items.length,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'items': items.map((c) => c.toJson()).toList(),
        'nextOffset': nextOffset,
        'total': total,
      };
}
