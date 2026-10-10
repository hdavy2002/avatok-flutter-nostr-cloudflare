import '../../../core/widgets/status_pill.dart';

/// `GET /api/hosts/public/:slug` (worker/src/routes/hf_hosts_public.ts): the card fields plus
/// `reviews[]`, `aboutPolished`, `quote` and `gallery[]`. Parsing is tolerant: a missing key is a safe
/// default, so a server that adds or drops a field never crashes the screen.
class HostProfile {
  const HostProfile({
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
    this.ratingBreakdown = const <int, int>{},
    this.talkedTo = 0,
    this.regulars = 0,
    this.lgbtqFriendly = false,
    this.womenOnly = false,
    this.introAudioUrl,
    this.introSeconds,
    this.status = HostPresence.offline,
    this.aboutPolished,
    this.quote,
    this.gallery = const <GalleryImage>[],
    this.reviews = const <HostReview>[],
  });

  final String slug;
  final String displayName;
  final String? tagline;
  final String? avatarUrl;
  final List<String> languages;

  /// Conversation style key (`warm`, `calm`, ...). Show with [styleLabel].
  final String? style;

  /// Topic slugs. Labels come from `GET /api/hf/options`.
  final List<String> topics;

  /// Whole rupees per minute.
  final int pricePerMin;
  final double? rating;
  final int reviewCount;

  /// Stars (1-5) to number of reviews.
  final Map<int, int> ratingBreakdown;
  final int talkedTo;
  final int regulars;
  final bool lgbtqFriendly;
  final bool womenOnly;
  final String? introAudioUrl;
  final int? introSeconds;
  final HostPresence status;
  final String? aboutPolished;
  final String? quote;
  final List<GalleryImage> gallery;
  final List<HostReview> reviews;

  bool get hasIntro => (introAudioUrl ?? '').isNotEmpty;

  /// Same labels as the website's profile page.
  static const Map<String, String> _styleLabels = <String, String>{
    'warm': 'Steady & encouraging',
    'energetic': 'Cheerful & chatty',
    'calm': 'Calm listener',
    'playful': 'Funny & light',
    'straightforward': 'Straight-talking',
    'thoughtful': 'Gentle & patient',
  };

  String? get styleLabel {
    final s = style;
    if (s == null || s.isEmpty) return null;
    return _styleLabels[s] ?? s;
  }

  factory HostProfile.fromJson(Map<String, dynamic> j) {
    final breakdown = <int, int>{};
    final rawBreakdown = j['ratingBreakdown'];
    if (rawBreakdown is Map) {
      rawBreakdown.forEach((k, v) {
        final star = int.tryParse('$k');
        if (star != null && v is num) breakdown[star] = v.toInt();
      });
    }
    final rawReviews = j['reviews'];
    final rawGallery = j['gallery'];
    return HostProfile(
      slug: _s(j['slug']) ?? '',
      displayName: _s(j['displayName']) ?? '',
      tagline: _s(j['tagline']),
      avatarUrl: _s(j['avatarUrl']),
      languages: _strings(j['languages']),
      style: _s(j['style']),
      topics: _strings(j['topics']),
      pricePerMin: _i(j['pricePerMin']) ?? 0,
      rating: j['rating'] is num ? (j['rating'] as num).toDouble() : null,
      reviewCount: _i(j['reviewCount']) ?? 0,
      ratingBreakdown: breakdown,
      talkedTo: _i(j['talkedTo']) ?? 0,
      regulars: _i(j['regulars']) ?? 0,
      lgbtqFriendly: j['lgbtqFriendly'] == true,
      womenOnly: j['womenOnly'] == true,
      introAudioUrl: _s(j['introAudioUrl']),
      introSeconds: _i(j['introSeconds']),
      status: HostPresence.parse(j['status']),
      aboutPolished: _s(j['aboutPolished']),
      quote: _s(j['quote']),
      gallery: rawGallery is List
          ? rawGallery
              .whereType<Map>()
              .map((m) => GalleryImage.fromJson(Map<String, dynamic>.from(m)))
              .where((g) => g.url.isNotEmpty)
              .toList()
          : const <GalleryImage>[],
      reviews: rawReviews is List
          ? rawReviews.whereType<Map>().map((m) => HostReview.fromJson(Map<String, dynamic>.from(m))).toList()
          : const <HostReview>[],
    );
  }

  static String? _s(Object? v) {
    final s = (v ?? '').toString().trim();
    return s.isEmpty ? null : s;
  }

  static int? _i(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}');

  static List<String> _strings(Object? v) =>
      v is List ? v.map((e) => '$e'.trim()).where((e) => e.isNotEmpty).toList() : const <String>[];
}

class GalleryImage {
  const GalleryImage({required this.url, this.caption});

  final String url;
  final String? caption;

  factory GalleryImage.fromJson(Map<String, dynamic> j) {
    final c = (j['caption'] ?? '').toString().trim();
    return GalleryImage(url: (j['url'] ?? '').toString(), caption: c.isEmpty ? null : c);
  }
}

class HostReview {
  const HostReview({
    required this.firstName,
    required this.stars,
    this.text = '',
    this.topic,
    this.minutes,
    this.regular = false,
    this.date,
  });

  /// First name only: the worker never sends a surname.
  final String firstName;
  final int stars;
  final String text;
  final String? topic;
  final int? minutes;
  final bool regular;

  /// ISO text or epoch milliseconds, as the worker sent it.
  final Object? date;

  factory HostReview.fromJson(Map<String, dynamic> j) {
    final stars = j['stars'] is num ? (j['stars'] as num).toInt() : 0;
    final name = (j['firstName'] ?? '').toString().trim();
    final topic = (j['topic'] ?? '').toString().trim();
    final minutes = j['minutes'] is num ? (j['minutes'] as num).toInt() : null;
    return HostReview(
      firstName: name.isEmpty ? 'A caller' : name,
      stars: stars.clamp(0, 5),
      text: (j['text'] ?? '').toString().trim(),
      topic: topic.isEmpty ? null : topic,
      minutes: (minutes != null && minutes > 0) ? minutes : null,
      regular: j['regular'] == true,
      date: j['date'],
    );
  }

  /// `12 Oct 2026`, or an empty string when the date cannot be read.
  String get dateLabel => formatReviewDate(date);
}

const List<String> _months = <String>['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String formatReviewDate(Object? date) {
  DateTime? d;
  if (date is num) {
    d = DateTime.fromMillisecondsSinceEpoch(date.toInt(), isUtc: true);
  } else if (date is String && date.isNotEmpty) {
    final asNumber = int.tryParse(date);
    d = asNumber != null ? DateTime.fromMillisecondsSinceEpoch(asNumber, isUtc: true) : DateTime.tryParse(date);
  }
  if (d == null) return '';
  final local = d.toLocal();
  return '${local.day} ${_months[local.month - 1]} ${local.year}';
}

/// `GET /api/hf/wallet/estimate?host=<slug>` (signed in). Token mode adds `tokensPerMinute` and `aboutText`
/// ("about 8 min 12 s", or "add tokens to call" with an empty balance). Old mode is rupees only.
class HostEstimate {
  const HostEstimate({required this.isTokens, this.tokensPerMinute, this.aboutText});

  final bool isTokens;
  final String? tokensPerMinute;
  final String? aboutText;

  factory HostEstimate.fromJson(Map<String, dynamic> j) {
    String? s(Object? v) {
      final t = (v ?? '').toString().trim();
      return t.isEmpty ? null : t;
    }

    return HostEstimate(
      isTokens: j['mode'] == 'tokens',
      tokensPerMinute: s(j['tokensPerMinute']),
      aboutText: s(j['aboutText']),
    );
  }
}

/// A loaded profile, and whether it came from the saved copy because the network failed.
class HostProfileResult {
  const HostProfileResult({required this.profile, this.fromCache = false});

  final HostProfile profile;
  final bool fromCache;
}
