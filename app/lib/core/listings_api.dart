import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// ListingsApi (Phase 6) — AvaExplore marketplace + creator listings pipeline.
/// Marketplace reads are public (guest browsing works signed-out); everything
/// else rides the authed contract.
const String _base = 'https://$kSignalingHost/api';

class ListingCreator {
  final String uid;
  final String? handle, name, avatarUrl, avatokNumber;
  final bool kycVerified;
  ListingCreator.fromJson(Map<String, dynamic> j)
      : uid = (j['uid'] ?? '').toString(),
        handle = j['handle']?.toString(),
        name = j['name']?.toString(),
        avatarUrl = j['avatar_url']?.toString(),
        avatokNumber = j['avatok_number']?.toString(),
        kycVerified = j['kyc_verified'] == true;
}

class ListingCard {
  final String id, kind, title, oneLiner, category, status;
  final int price, effectivePrice, promoPct, joinedCount, ratingCount;
  final String currency;
  final String? country;
  final bool adultsOnly;
  final List<dynamic> badges;
  final List<dynamic> coverMedia;
  final int? startsAt, durationMin, capacity;
  final double? ratingAvg;
  final ListingCreator creator;
  // Voice translation: creator offers it + their transmission language.
  final bool translationEnabled;
  final String? spokenLang;
  // AvaMarketplace: expiry + type + location.
  final int? expiresAt;
  final String? marketType, location;
  String? description; // only on the details endpoint

  ListingCard.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        kind = (j['kind'] ?? 'consult').toString(),
        title = (j['title'] ?? '').toString(),
        oneLiner = (j['one_liner'] ?? '').toString(),
        category = (j['category'] ?? '').toString(),
        status = (j['status'] ?? '').toString(),
        price = (j['price'] as num?)?.toInt() ?? 0,
        effectivePrice = (j['effective_price'] as num?)?.toInt() ?? 0,
        promoPct = (j['promo_pct'] as num?)?.toInt() ?? 0,
        joinedCount = (j['joined_count'] as num?)?.toInt() ?? 0,
        ratingCount = (j['rating_count'] as num?)?.toInt() ?? 0,
        currency = (j['currency_display'] ?? 'USD').toString(),
        country = j['country']?.toString(),
        adultsOnly = j['adults_only'] == true,
        badges = (j['badges'] as List?) ?? const [],
        coverMedia = (j['cover_media'] as List?) ?? const [],
        startsAt = (j['starts_at'] as num?)?.toInt(),
        durationMin = (j['duration_min'] as num?)?.toInt(),
        capacity = (j['capacity'] as num?)?.toInt(),
        ratingAvg = (j['rating_avg'] as num?)?.toDouble(),
        translationEnabled = j['translation_enabled'] == true,
        spokenLang = j['spoken_lang']?.toString(),
        expiresAt = (j['expires_at'] as num?)?.toInt(),
        marketType = j['market_type']?.toString(),
        location = j['location']?.toString(),
        creator = ListingCreator.fromJson((j['creator'] as Map?)?.cast<String, dynamic>() ?? const {}),
        description = j['description']?.toString();

  bool get isMarketplace => (marketType ?? '').isNotEmpty || const ['sell', 'buy', 'social'].contains(kind);
  bool get isExpired => expiresAt != null && expiresAt! < DateTime.now().millisecondsSinceEpoch;
  /// Marketplace price shows the listing's own currency in major units
  /// (e.g. "3000 INR"); creator listings keep the USD-cents money() format.
  String get displayPrice => isMarketplace
      ? (price > 0 ? '$price $currency' : (kind == 'buy' ? 'Budget' : 'Free'))
      : priceLabel;

  String? get coverUrl {
    for (final m in coverMedia) {
      final url = (m is Map ? (m['url'] ?? m['r2_key']) : null)?.toString();
      if (url != null && url.startsWith('http')) return url;
    }
    return null;
  }

  /// "$12.50" — coins are USD cents.
  String money(int coins) => coins == 0 ? 'Free' : '\$${(coins / 100).toStringAsFixed(coins % 100 == 0 ? 0 : 2)}';
  String get priceLabel => money(effectivePrice);
}

class ListingReview {
  final String id, authorId, body;
  final String? authorName, authorAvatar;
  final int rating, createdAt;
  ListingReview.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        authorId = (j['author_id'] ?? '').toString(),
        authorName = j['author_name']?.toString(),
        authorAvatar = j['author_avatar']?.toString(),
        body = (j['body'] ?? '').toString(),
        rating = (j['rating'] as num?)?.toInt() ?? 0,
        createdAt = (j['created_at'] as num?)?.toInt() ?? 0;
}

class ListingDetail {
  final ListingCard listing;
  final List<ListingReview> reviews;
  final double? creatorRating;
  final int creatorRatingCount, followerCount;
  final bool following, booked, isOwner;
  ListingDetail.fromJson(Map<String, dynamic> j)
      : listing = ListingCard.fromJson((j['listing'] as Map).cast<String, dynamic>()),
        reviews = ((j['reviews'] as List?) ?? const [])
            .map((r) => ListingReview.fromJson((r as Map).cast<String, dynamic>()))
            .toList(),
        creatorRating = ((j['creator_stats'] as Map?)?['rating_avg'] as num?)?.toDouble(),
        creatorRatingCount = ((j['creator_stats'] as Map?)?['rating_count'] as num?)?.toInt() ?? 0,
        followerCount = ((j['creator_stats'] as Map?)?['follower_count'] as num?)?.toInt() ?? 0,
        following = (j['viewer'] as Map?)?['following'] == true,
        booked = (j['viewer'] as Map?)?['booked'] == true,
        isOwner = (j['viewer'] as Map?)?['is_owner'] == true;
}

class CreatorChannel {
  final String uid;
  final String? handle, name, avatarUrl, bio, bannerKey, introVideoRef, pinnedListingId;
  final bool kycVerified;
  final double? ratingAvg;
  final int ratingCount, followerCount;
  final List<dynamic> links;
  final Map<String, dynamic> publicFields;
  final List<ListingCard> listings;
  final List<ListingReview> reviews;
  final bool following, notify;
  CreatorChannel.fromJson(Map<String, dynamic> j)
      : uid = ((j['creator'] as Map)['uid'] ?? '').toString(),
        handle = (j['creator'] as Map)['handle']?.toString(),
        name = (j['creator'] as Map)['name']?.toString(),
        avatarUrl = (j['creator'] as Map)['avatar_url']?.toString(),
        bio = (j['creator'] as Map)['bio']?.toString(),
        bannerKey = (j['creator'] as Map)['banner_r2_key']?.toString(),
        introVideoRef = (j['creator'] as Map)['intro_video_ref']?.toString(),
        pinnedListingId = (j['creator'] as Map)['pinned_listing_id']?.toString(),
        kycVerified = (j['creator'] as Map)['kyc_verified'] == true,
        ratingAvg = ((j['creator'] as Map)['rating_avg'] as num?)?.toDouble(),
        ratingCount = ((j['creator'] as Map)['rating_count'] as num?)?.toInt() ?? 0,
        followerCount = ((j['creator'] as Map)['follower_count'] as num?)?.toInt() ?? 0,
        links = ((j['creator'] as Map)['links'] as List?) ?? const [],
        publicFields = (((j['creator'] as Map)['public_fields']) as Map?)?.cast<String, dynamic>() ?? const {},
        listings = ((j['listings'] as List?) ?? const [])
            .map((r) => ListingCard.fromJson((r as Map).cast<String, dynamic>()))
            .toList(),
        reviews = ((j['reviews'] as List?) ?? const [])
            .map((r) => ListingReview.fromJson((r as Map).cast<String, dynamic>()))
            .toList(),
        following = (j['viewer'] as Map?)?['following'] == true,
        notify = (j['viewer'] as Map?)?['notify'] != false;
}

class ExploreCategory {
  final String id, label, emoji;
  ExploreCategory.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        label = (j['label'] ?? '').toString(),
        emoji = (j['emoji'] ?? '').toString();
}

class ListingsApi {
  static Map<String, dynamic> _j(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  static List<ListingCard> _cards(Map<String, dynamic> j) =>
      ((j['listings'] as List?) ?? const [])
          .map((r) => ListingCard.fromJson((r as Map).cast<String, dynamic>()))
          .toList();

  // ── marketplace reads (public) ────────────────────────────────────────────
  static Future<List<ExploreCategory>> categories() async {
    final r = await ApiAuth.getSigned('$_base/explore/categories');
    return ((_j(r.body)['categories'] as List?) ?? const [])
        .map((c) => ExploreCategory.fromJson((c as Map).cast<String, dynamic>()))
        .toList();
  }

  static Future<List<ListingCard>> explore({String? kind, String? category, String? country, String? creator}) async {
    final q = <String>[
      if (kind != null) 'kind=$kind',
      if (category != null && category.isNotEmpty) 'category=$category',
      if (country != null) 'country=$country',
      if (creator != null) 'creator=$creator',
      'limit=40',
    ].join('&');
    final r = await ApiAuth.getSigned('$_base/explore?$q');
    return _cards(_j(r.body));
  }

  /// AvaMarketplace browse — buy/sell/social only. Country-filtered by default
  /// (the user's detected country); pass country='' for all countries. A query
  /// routes through search (FTS/AI), filtered to marketplace listings.
  static Future<List<ListingCard>> marketBrowse({String? country, String? category, String? q}) async {
    if (q != null && q.trim().isNotEmpty) {
      // AI search endpoint (query expansion + marketplace filter, server-side).
      final params = <String>[
        'q=${Uri.encodeQueryComponent(q.trim())}', 'limit=40',
        if (country != null && country.isNotEmpty) 'country=$country',
        if (category != null && category.isNotEmpty) 'category=${Uri.encodeQueryComponent(category)}',
      ].join('&');
      final r = await ApiAuth.getSigned('$_base/marketplace/search?$params');
      return _cards(_j(r.body));
    }
    final params = <String>[
      'market=1', 'limit=40',
      if (country != null && country.isNotEmpty) 'country=$country',
      if (category != null && category.isNotEmpty) 'category=${Uri.encodeQueryComponent(category)}',
    ].join('&');
    final r = await ApiAuth.getSigned('$_base/explore?$params');
    return _cards(_j(r.body));
  }

  static Future<List<ListingCard>> liveNow() async {
    final r = await ApiAuth.getSigned('$_base/explore/live-now');
    return _cards(_j(r.body));
  }

  static Future<List<ListingCard>> search({
    required String q, String? kind, String? category, String? country,
    int? minPrice, int? maxPrice, int? from, int? to, double? minRating,
    String sort = 'soonest',
  }) async {
    final params = <String>[
      'q=${Uri.encodeQueryComponent(q)}', 'sort=$sort', 'limit=40',
      if (kind != null) 'kind=$kind',
      if (category != null && category.isNotEmpty) 'category=$category',
      if (country != null && country.isNotEmpty) 'country=$country',
      if (minPrice != null) 'minPrice=$minPrice',
      if (maxPrice != null) 'maxPrice=$maxPrice',
      if (from != null) 'from=$from',
      if (to != null) 'to=$to',
      if (minRating != null) 'minRating=$minRating',
    ].join('&');
    final r = await ApiAuth.getSigned('$_base/explore/search?$params');
    return _cards(_j(r.body));
  }

  static Future<ListingDetail?> detail(String id) async {
    final r = await ApiAuth.getSigned('$_base/listings/$id');
    if (r.statusCode != 200) return null;
    return ListingDetail.fromJson(_j(r.body));
  }

  static Future<CreatorChannel?> creator(String uid) async {
    final r = await ApiAuth.getSigned('$_base/creators/$uid');
    if (r.statusCode != 200) return null;
    return CreatorChannel.fromJson(_j(r.body));
  }

  // ── creator insights (owner-gated dashboards) ─────────────────────────────
  /// Cross-listing rollup: views by day/country/age group, bookings, revenue.
  static Future<Map<String, dynamic>?> creatorStats() async {
    final r = await ApiAuth.getSigned('$_base/creators/me/stats');
    return r.statusCode == 200 ? _j(r.body) : null;
  }

  /// Per-listing dashboard (views, audience, conversion).
  static Future<Map<String, dynamic>?> listingStats(String id) async {
    final r = await ApiAuth.getSigned('$_base/listings/$id/stats');
    return r.statusCode == 200 ? _j(r.body) : null;
  }

  // ── creator pipeline ──────────────────────────────────────────────────────
  static Future<String?> createDraft(String kind, Map<String, dynamic> fields) async {
    final r = await ApiAuth.postJson('$_base/listings', {'kind': kind, ...fields});
    final j = _j(r.body);
    return r.statusCode == 200 ? j['listing_id']?.toString() : null;
  }

  static Future<bool> update(String id, Map<String, dynamic> fields) async =>
      (await ApiAuth.putJson('$_base/listings/$id', fields)).statusCode == 200;

  /// Returns {} on success, or {error, conflictWith?/reason?} on failure.
  static Future<Map<String, dynamic>> publish(String id) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/publish', {});
    final j = _j(r.body);
    return r.statusCode == 200 ? {} : {...j, 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> setStatus(String id, String status) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/status', {'status': status});
    return {..._j(r.body), 'ok': r.statusCode == 200};
  }

  static Future<String?> duplicate(String id) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/duplicate', {});
    return r.statusCode == 200 ? _j(r.body)['listing_id']?.toString() : null;
  }

  static Future<bool> cancel(String id, {bool permanent = false}) async =>
      (await ApiAuth.deleteSigned('$_base/listings/$id${permanent ? '?permanent=true' : ''}')).statusCode == 200;

  static Future<List<ListingCard>> mine() async {
    final r = await ApiAuth.getSigned('$_base/listings/mine');
    return _cards(_j(r.body));
  }

  static Future<bool> addPromotion(String id, {required String kind, required int pctOff, String? code, int? maxUses, int? endsAt}) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/promotions', {
      'kind': kind, 'pct_off': pctOff,
      if (code != null) 'code': code,
      if (maxUses != null) 'max_uses': maxUses,
      if (endsAt != null) 'ends_at': endsAt,
    });
    return r.statusCode == 200;
  }

  // ── booking / reviews / social ────────────────────────────────────────────
  /// Returns the response json + 'status' (402 → insufficient_funds w/ `needed`).
  static Future<Map<String, dynamic>> book(String id, {int? slotStart, int? slotEnd, String? promoCode, String? translationLang}) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/book', {
      if (slotStart != null) 'slot': {'start_at': slotStart, if (slotEnd != null) 'end_at': slotEnd},
      if (promoCode != null && promoCode.isNotEmpty) 'promo_code': promoCode,
      // "Would you like this to be translated…?" — $3/h prepay, refunds unused.
      if (translationLang != null && translationLang.isNotEmpty) 'translation': {'lang': translationLang},
    }, timeout: const Duration(seconds: 20));
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<bool> review(String id, int rating, String? body) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/reviews', {'rating': rating, if (body != null && body.isNotEmpty) 'body': body});
    return r.statusCode == 200;
  }

  static Future<bool> follow(String uid, {bool? notify}) async =>
      (await ApiAuth.postJson('$_base/creators/$uid/follow', {if (notify != null) 'notify': notify})).statusCode == 200;

  static Future<bool> unfollow(String uid) async =>
      (await ApiAuth.deleteSigned('$_base/creators/$uid/follow')).statusCode == 200;

  static Future<bool> blockCreator(String uid) async =>
      (await ApiAuth.postJson('$_base/creators/$uid/block', {})).statusCode == 200;

  static Future<bool> report(String targetType, String targetId, String reason) async =>
      (await ApiAuth.postJson('$_base/report', {'targetType': targetType, 'targetId': targetId, 'reason': reason})).statusCode == 200;

  static Future<bool> updateChannel(Map<String, dynamic> fields) async =>
      (await ApiAuth.putJson('$_base/creators/me', fields)).statusCode == 200;

  /// Consult slot grid for a day — occupied slots come back flagged (greyed UX).
  static Future<List<Map<String, dynamic>>> slotGrid(String creatorUid, String dateYmd, int durMin) async {
    final r = await ApiAuth.getSigned('https://$kSignalingHost/api/calendar/slots?creator=$creatorUid&date=$dateYmd&dur=$durMin');
    return (((_j(r.body)['slots']) as List?) ?? const []).map((s) => (s as Map).cast<String, dynamic>()).toList();
  }
}
