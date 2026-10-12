import '../../../core/format/money.dart';
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
    this.pricePaisePerMin = 0,
    this.serverPriceLabel,
    this.priceTiers = const <PriceTier>[],
    this.plan,
    this.rating,
    this.reviewCount = 0,
    this.talkedTo = 0,
    this.regulars = 0,
    this.lgbtqFriendly = false,
    this.womenOnly = false,
    this.introAudioUrl,
    this.introSeconds,
    this.status = HostPresence.offline,
    this.gender,
  });

  final String slug;
  final String displayName;
  final String? tagline;
  final String? avatarUrl;
  final List<String> languages;
  final String? style;
  final List<String> topics;

  /// Rupees per minute for the first band. May be fractional.
  final double pricePerMin;
  final int pricePaisePerMin;
  final String? serverPriceLabel;
  final List<PriceTier> priceTiers;
  final String? plan;

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

  /// `female`, `male` or null when the server does not say (the card then calls the clip "Voice intro").
  final String? gender;

  bool get isOnline => status == HostPresence.online;
  bool get hasIntro => introAudioUrl != null && introAudioUrl!.isNotEmpty;

  /// Marketplace previews are deliberately capped at twenty seconds. A shorter
  /// server clip keeps its honest duration; an unknown duration uses the cap.
  int get previewSeconds => (introSeconds ?? 20).clamp(1, 20).toInt();

  /// The words on the voice bar: "Her voice", "His voice", else "Voice intro". A women-only host is a woman.
  String get voiceTitle {
    final g = gender ?? (womenOnly ? 'female' : null);
    if (g == 'female') return 'Her voice';
    if (g == 'male') return 'His voice';
    return 'Voice intro';
  }

  String get priceLabel {
    final fromServer = serverPriceLabel;
    if (fromServer != null) return fromServer;
    final paise = pricePaisePerMin > 0
        ? pricePaisePerMin
        : (pricePerMin * 100).round();
    return formatPaiseRate(paise);
  }

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
      pricePerMin: _num(j['pricePerMin'])?.toDouble() ?? 0,
      pricePaisePerMin: _int(j['pricePaisePerMin']) ?? 0,
      serverPriceLabel: _str(j['priceLabel']),
      priceTiers: PriceTier.listFrom(j['priceTiers']),
      plan: _str(j['plan']),
      rating: _num(j['rating'])?.toDouble(),
      reviewCount: _int(j['reviewCount']) ?? 0,
      talkedTo: _int(j['talkedTo']) ?? 0,
      regulars: _int(j['regulars']) ?? 0,
      lgbtqFriendly: j['lgbtqFriendly'] == true,
      womenOnly: j['womenOnly'] == true,
      introAudioUrl: _str(j['introAudioUrl']),
      introSeconds: _int(j['introSeconds']),
      status: HostPresence.parse(j['status']),
      gender: _gender(j['gender']),
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
    'pricePaisePerMin': pricePaisePerMin,
    'priceLabel': serverPriceLabel,
    'priceTiers': priceTiers.map((t) => t.toJson()).toList(),
    'plan': plan,
    'rating': rating,
    'reviewCount': reviewCount,
    'talkedTo': talkedTo,
    'regulars': regulars,
    'lgbtqFriendly': lgbtqFriendly,
    'womenOnly': womenOnly,
    'introAudioUrl': introAudioUrl,
    'introSeconds': introSeconds,
    'status': status.name,
    'gender': gender,
  };

  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  static String? _gender(Object? v) {
    switch ('${v ?? ''}'.trim().toLowerCase()) {
      case 'f':
      case 'female':
      case 'woman':
      case 'she':
        return 'female';
      case 'm':
      case 'male':
      case 'man':
      case 'he':
        return 'male';
      default:
        return null;
    }
  }

  static List<String> _strList(Object? v) => v is List
      ? v.map((e) => e.toString()).where((e) => e.isNotEmpty).toList()
      : const <String>[];

  static num? _num(Object? v) =>
      v is num ? v : (v is String ? num.tryParse(v) : null);

  static int? _int(Object? v) => _num(v)?.round();
}

/// One band of the Standard plan rate card.
class PriceTier {
  const PriceTier({
    required this.fromMin,
    this.toMin,
    required this.paisePerMin,
  });

  final int fromMin;
  final int? toMin;
  final int paisePerMin;

  String get rateLabel => formatPaiseRate(paisePerMin);

  static PriceTier? tryParse(Object? raw) {
    if (raw is! Map) return null;
    num? n(Object? v) =>
        v is num ? v : (v is String ? num.tryParse(v) : null);
    final paise = n(raw['paisePerMin']);
    if (paise == null) return null;
    return PriceTier(
      fromMin: n(raw['fromMin'])?.round() ?? 0,
      toMin: n(raw['toMin'])?.round(),
      paisePerMin: paise.round(),
    );
  }

  static List<PriceTier> listFrom(Object? raw) {
    if (raw is! List) return const <PriceTier>[];
    final result = <PriceTier>[];
    for (final value in raw) {
      final tier = tryParse(value);
      if (tier != null) result.add(tier);
    }
    return result;
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'fromMin': fromMin,
    'toMin': toMin,
    'paisePerMin': paisePerMin,
  };
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
