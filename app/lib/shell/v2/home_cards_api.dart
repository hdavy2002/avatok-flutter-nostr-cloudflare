import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';

/// Client for the Phase-3 Home card aggregate endpoint (`GET /api/home/cards`,
/// worker/src/routes/homecards.ts). ONE precomputed response feeds the Earnings,
/// Visitors and Listings cards, so Home never fans out to N endpoints and NEVER
/// touches PostHog (card contract §8). The worker edge-caches per uid (10 min);
/// here we also keep a short in-memory cache so switching Home tabs doesn't re-hit
/// the network within the same window.
class HomeCardsApi {
  HomeCardsApi._();

  static String get _url => '$kApiBase/home/cards';
  static const _memTtl = Duration(minutes: 5);

  static HomeCardsData? _cache;
  static DateTime? _cachedAt;

  /// Fetch the aggregate. Returns the in-memory cache when fresh unless [force].
  /// Returns null on any failure (the cards then show their failure fallback).
  static Future<HomeCardsData?> fetch({bool force = false}) async {
    final now = DateTime.now();
    if (!force && _cache != null && _cachedAt != null && now.difference(_cachedAt!) < _memTtl) {
      return _cache;
    }
    try {
      final res = await ApiAuth.getSigned(_url, timeout: const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final data = HomeCardsData.fromJson(j);
      _cache = data;
      _cachedAt = now;
      return data;
    } catch (_) {
      return null;
    }
  }

  /// Drop the in-memory cache (e.g. on account switch, so a child never sees the
  /// parent's aggregate).
  static void clear() {
    _cache = null;
    _cachedAt = null;
  }
}

class HomeCardsData {
  final EarningsAgg earnings;
  final VisitorsAgg visitors;
  final List<ListingAgg> listings;
  const HomeCardsData({required this.earnings, required this.visitors, required this.listings});

  factory HomeCardsData.fromJson(Map<String, dynamic> j) {
    final e = (j['earnings'] as Map?)?.cast<String, dynamic>() ?? const {};
    final v = (j['visitors'] as Map?)?.cast<String, dynamic>() ?? const {};
    final l = (j['listings'] as Map?)?.cast<String, dynamic>() ?? const {};
    final top = (l['top'] as List?) ?? const [];
    return HomeCardsData(
      earnings: EarningsAgg.fromJson(e),
      visitors: VisitorsAgg.fromJson(v),
      listings: [
        for (final r in top)
          if (r is Map) ListingAgg.fromJson(r.cast<String, dynamic>()),
      ],
    );
  }
}

class EarningsAgg {
  final int today;
  final int week;
  final int month;
  final List<int> series7d; // oldest→newest, 7 buckets
  const EarningsAgg({
    required this.today,
    required this.week,
    required this.month,
    required this.series7d,
  });

  factory EarningsAgg.fromJson(Map<String, dynamic> j) => EarningsAgg(
        today: (j['today'] as num?)?.toInt() ?? 0,
        week: (j['week'] as num?)?.toInt() ?? 0,
        month: (j['month'] as num?)?.toInt() ?? 0,
        series7d: [
          for (final n in (j['series7d'] as List?) ?? const []) (n as num?)?.toInt() ?? 0,
        ],
      );
}

class VisitorsAgg {
  /// When false the worker has no D1 view store for this user — the card hides.
  final bool available;
  final int total7d;
  final List<GeoCount> byCountry;
  final List<GeoCount> byCity;
  const VisitorsAgg({
    required this.available,
    this.total7d = 0,
    this.byCountry = const [],
    this.byCity = const [],
  });

  factory VisitorsAgg.fromJson(Map<String, dynamic> j) => VisitorsAgg(
        available: j['available'] == true,
        total7d: (j['total7d'] as num?)?.toInt() ?? 0,
        byCountry: [
          for (final r in (j['byCountry'] as List?) ?? const [])
            if (r is Map) GeoCount((r['country'] ?? '').toString(), (r['views'] as num?)?.toInt() ?? 0),
        ],
        byCity: [
          for (final r in (j['byCity'] as List?) ?? const [])
            if (r is Map) GeoCount((r['city'] ?? '').toString(), (r['views'] as num?)?.toInt() ?? 0),
        ],
      );
}

class GeoCount {
  final String label;
  final int views;
  const GeoCount(this.label, this.views);
}

class ListingAgg {
  final String id;
  final String title;
  final String? kind;
  final String status;
  final int joinedCount;
  final int views7d;
  const ListingAgg({
    required this.id,
    required this.title,
    required this.kind,
    required this.status,
    required this.joinedCount,
    required this.views7d,
  });

  factory ListingAgg.fromJson(Map<String, dynamic> j) => ListingAgg(
        id: (j['id'] ?? '').toString(),
        title: (j['title'] ?? '').toString(),
        kind: j['kind'] as String?,
        status: (j['status'] ?? '').toString(),
        joinedCount: (j['joined_count'] as num?)?.toInt() ?? 0,
        views7d: (j['views7d'] as num?)?.toInt() ?? 0,
      );
}
