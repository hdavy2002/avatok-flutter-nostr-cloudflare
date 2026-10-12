import '../../../core/format/money.dart';
import '../../../core/widgets/status_pill.dart';
import '../../explore/data/host_card.dart' show PriceTier;

/// `GET /api/hosts/public/:slug` (worker/src/routes/hf_hosts_public.ts): the card fields plus
/// `reviews[]`, `aboutPolished`, `quote` and `gallery[]`. Parsing is tolerant: a missing key is a safe
/// default, so a server that adds or drops a field never crashes the screen.
class HostProfile {
  const HostProfile({
    required this.slug,
    required this.displayName,
    this.tagline,
    this.avatarUrl,
    this.imageProvenance,
    this.languages = const <String>[],
    this.style,
    this.topics = const <String>[],
    this.pricePerMin = 0,
    this.pricePaisePerMin = 0,
    this.serverPriceLabel,
    this.priceTiers = const <PriceTier>[],
    this.plan,
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
  final String? imageProvenance;
  final List<String> languages;

  /// Conversation style key (`warm`, `calm`, ...). Show with [styleLabel].
  final String? style;

  /// Topic slugs. Labels come from `GET /api/hf/options`.
  final List<String> topics;

  final double pricePerMin;
  final int pricePaisePerMin;
  final String? serverPriceLabel;
  final List<PriceTier> priceTiers;
  final String? plan;
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
  bool get isAiAvatar => imageProvenance == 'ai';

  String get priceLabel {
    final fromServer = serverPriceLabel;
    if (fromServer != null) return fromServer;
    final paise = pricePaisePerMin > 0
        ? pricePaisePerMin
        : (pricePerMin * 100).round();
    return formatPaiseRate(paise);
  }

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
      imageProvenance: _s(j['imageProvenance']),
      languages: _strings(j['languages']),
      style: _s(j['style']),
      topics: _strings(j['topics']),
      pricePerMin: _d(j['pricePerMin']) ?? 0,
      pricePaisePerMin: _i(j['pricePaisePerMin']) ?? 0,
      serverPriceLabel: _s(j['priceLabel']),
      priceTiers: PriceTier.listFrom(j['priceTiers']),
      plan: _s(j['plan']),
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
          ? rawReviews
                .whereType<Map>()
                .map((m) => HostReview.fromJson(Map<String, dynamic>.from(m)))
                .toList()
          : const <HostReview>[],
    );
  }

  static String? _s(Object? v) {
    final s = (v ?? '').toString().trim();
    return s.isEmpty ? null : s;
  }

  static int? _i(Object? v) =>
      v is num ? v.round() : num.tryParse('${v ?? ''}')?.round();

  static double? _d(Object? v) =>
      v is num ? v.toDouble() : double.tryParse('${v ?? ''}');

  static List<String> _strings(Object? v) => v is List
      ? v.map((e) => '$e'.trim()).where((e) => e.isNotEmpty).toList()
      : const <String>[];
}

class GalleryImage {
  const GalleryImage({required this.url, this.caption, this.imageProvenance});

  final String url;
  final String? caption;
  final String? imageProvenance;
  bool get isAi => imageProvenance == 'ai';

  factory GalleryImage.fromJson(Map<String, dynamic> j) {
    final c = (j['caption'] ?? '').toString().trim();
    return GalleryImage(
      url: (j['url'] ?? '').toString(),
      caption: c.isEmpty ? null : c,
      imageProvenance: HostProfile._s(j['imageProvenance']),
    );
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

const List<String> _months = <String>[
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

String formatReviewDate(Object? date) {
  DateTime? d;
  if (date is num) {
    d = DateTime.fromMillisecondsSinceEpoch(date.toInt(), isUtc: true);
  } else if (date is String && date.isNotEmpty) {
    final asNumber = int.tryParse(date);
    d = asNumber != null
        ? DateTime.fromMillisecondsSinceEpoch(asNumber, isUtc: true)
        : DateTime.tryParse(date);
  }
  if (d == null) return '';
  final local = d.toLocal();
  return '${local.day} ${_months[local.month - 1]} ${local.year}';
}

/// `GET /api/hf/wallet/estimate?host=<slug>` (signed in). Token mode adds `tokensPerMinute` and `aboutText`
/// ("about 8 min 12 s", or "add tokens to call" with an empty balance). Old mode is rupees only.
class HostEstimate {
  const HostEstimate({required this.isMetered, this.aboutText});

  final bool isMetered;
  final String? aboutText;

  factory HostEstimate.fromJson(Map<String, dynamic> j) {
    String? s(Object? v) {
      final t = (v ?? '').toString().trim();
      return t.isEmpty ? null : t;
    }

    final mode = j['mode'];
    return HostEstimate(
      isMetered: mode == 'rupees' || mode == 'tokens',
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
