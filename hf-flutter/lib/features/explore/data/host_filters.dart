import '../../../core/router/routes.dart';

/// Sort orders `GET /api/hf/hosts` understands.
enum HostSort {
  onlineFirst('online_first', 'Online first'),
  priceLow('price_low', 'Price: low to high'),
  rating('rating', 'Top rated'),
  popular('popular', 'Popular conversations');

  const HostSort(this.wire, this.label);
  final String wire;
  final String label;

  static HostSort parse(String? v) => HostSort.values.firstWhere(
    (s) => s.wire == v,
    orElse: () => HostSort.onlineFirst,
  );
}

/// The lanes: women-only and LGBTQ+ (the `lane` query value).
abstract final class HostLane {
  static const String women = 'women';
  static const String lgbtq = 'lgbtq';

  /// Anything but the two known lanes means "All".
  static String? clean(String? v) => (v == women || v == lgbtq) ? v : null;
}

abstract final class HostCategoryFilter {
  static const String standard = 'standard';
  static const String influencer = 'influencer';
  static const String celebrity = 'celebrity';
  static const String creators = 'creators';

  static String? clean(String? value) =>
      value == standard || value == influencer || value == celebrity || value == creators ? value : null;
}

/// Everything the person can filter by. Immutable; [copyWith] makes the next one.
///
/// It maps to the API (`toApiQuery`) and to the route (`toRouteQuery`, which `/explore?lane=&topics=&lang=&max=&online=`
/// and the Home tiles use). Search, category and sort are preserved in deep links.
class HostFilters {
  const HostFilters({
    this.topics = const <String>[],
    this.languages = const <String>[],
    this.minPrice,
    this.maxPrice,
    this.online = false,
    this.lane,
    this.category,
    this.search = '',
    this.sort = HostSort.onlineFirst,
  });

  /// Topic slugs (any match).
  final List<String> topics;

  /// Language codes (`hi`, `en`, ...; any match).
  final List<String> languages;
  final int? minPrice;
  final int? maxPrice;
  final bool online;

  /// `women`, `lgbtq` or null for All.
  final String? lane;
  final String? category;
  final String search;
  final HostSort sort;

  static const HostFilters none = HostFilters();

  static String cleanSearch(String value) {
    final normalized = value.trim().replaceAll(RegExp(r'\s+'), ' ');
    return normalized.length > 80 ? normalized.substring(0, 80) : normalized;
  }

  /// How many filters are on (the badge on the filter button). The lane and the sort are not counted:
  /// the lane has its own tabs.
  int get activeCount =>
      (topics.isEmpty ? 0 : 1) +
      (languages.isEmpty ? 0 : 1) +
      ((minPrice != null || maxPrice != null) ? 1 : 0) +
      (online ? 1 : 0) +
      (category == null ? 0 : 1) +
      (search.isEmpty ? 0 : 1) +
      (sort == HostSort.onlineFirst ? 0 : 1);

  bool get hasAny => activeCount > 0 || lane != null;

  HostFilters copyWith({
    List<String>? topics,
    List<String>? languages,
    Object? minPrice = _keep,
    Object? maxPrice = _keep,
    bool? online,
    Object? lane = _keep,
    Object? category = _keep,
    String? search,
    HostSort? sort,
  }) => HostFilters(
    topics: topics ?? this.topics,
    languages: languages ?? this.languages,
    minPrice: identical(minPrice, _keep) ? this.minPrice : minPrice as int?,
    maxPrice: identical(maxPrice, _keep) ? this.maxPrice : maxPrice as int?,
    online: online ?? this.online,
    lane: identical(lane, _keep) ? this.lane : lane as String?,
    category: identical(category, _keep) ? this.category : category as String?,
    search: search ?? this.search,
    sort: sort ?? this.sort,
  );

  static const Object _keep = Object();

  /// The query for `GET /api/hf/hosts`. Defaults are left out, so the unfiltered list has the same
  /// edge-cache key for everyone.
  Map<String, Object?> toApiQuery({required int limit, required int offset}) =>
      <String, Object?>{
        if (topics.isNotEmpty) 'topic': topics.join(','),
        if (languages.isNotEmpty) 'lang': languages.join(','),
        if (minPrice != null) 'minPrice': minPrice,
        if (maxPrice != null) 'maxPrice': maxPrice,
        if (online) 'online': '1',
        if (lane != null) 'lane': lane,
        if (category != null) 'category': category,
        if (search.isNotEmpty) 'q': search,
        if (sort != HostSort.onlineFirst) 'sort': sort.wire,
        'limit': limit,
        'offset': offset,
      };

  /// Query values for the route: `lane`, `topics`, `lang`, `max`, `online` (and `min`, which the Home never sets).
  Map<String, String> toRouteQuery() => <String, String>{
    if (lane != null) 'lane': lane!,
    if (category != null) 'category': category!,
    if (search.isNotEmpty) 'q': search,
    if (sort != HostSort.onlineFirst) 'sort': sort.wire,
    if (topics.isNotEmpty) 'topics': topics.join(','),
    if (languages.isNotEmpty) 'lang': languages.join(','),
    if (maxPrice != null) 'max': '$maxPrice',
    if (minPrice != null) 'min': '$minPrice',
    if (online) 'online': '1',
  };

  /// The `/explore?...` location for these filters.
  String toLocation() {
    final q = toRouteQuery();
    return q.isEmpty
        ? Routes.explore
        : Uri(path: Routes.explore, queryParameters: q).toString();
  }

  /// Reads the route's query. Unknown or junk values are dropped (a deep link never crashes the screen).
  factory HostFilters.fromRouteQuery(Map<String, String> q) {
    List<String> csv(String? v) => (v ?? '')
        .split(',')
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toSet()
        .toList();
    int? price(String? v) {
      final n = int.tryParse((v ?? '').trim());
      return (n == null || n < 0) ? null : n;
    }

    return HostFilters(
      topics: csv(q['topics'] ?? q['topic']),
      languages: csv(q['lang']),
      minPrice: price(q['min']),
      maxPrice: price(q['max']),
      online: q['online'] == '1' || q['online'] == 'true',
      lane: HostLane.clean(q['lane']),
      category: HostCategoryFilter.clean(q['category']),
      search: cleanSearch(q['q'] ?? ''),
      sort: HostSort.parse(q['sort']),
    );
  }

  /// A short, anonymous description for telemetry (`hf_app_filter_applied {filters}`): slugs and numbers only.
  Map<String, Object> toTelemetry() => <String, Object>{
    if (topics.isNotEmpty) 'topics': topics,
    if (languages.isNotEmpty) 'languages': languages,
    if (minPrice != null) 'min_price': minPrice!,
    if (maxPrice != null) 'max_price': maxPrice!,
    if (online) 'online': true,
    if (lane != null) 'lane': lane!,
    if (category != null) 'category': category!,
    if (search.isNotEmpty) 'has_search': true,
    'sort': sort.wire,
  };

  /// Same filters on the parts the route can carry.
  bool sameAsRoute(HostFilters o) =>
      _same(topics, o.topics) &&
      _same(languages, o.languages) &&
      minPrice == o.minPrice &&
      maxPrice == o.maxPrice &&
      online == o.online &&
      lane == o.lane &&
      category == o.category &&
      search == o.search &&
      sort == o.sort;

  /// Same list request: every field, including the sort.
  bool sameRequest(HostFilters o) => sameAsRoute(o) && sort == o.sort;

  /// Stable key for the offline cache: the same request always has the same key.
  String get cacheKey {
    final t = [...topics]..sort();
    final l = [...languages]..sort();
    return 't=${t.join(',')}|l=${l.join(',')}|min=${minPrice ?? ''}|max=${maxPrice ?? ''}|o=${online ? 1 : 0}|c=${category ?? ''}|q=${Uri.encodeComponent(search)}|s=${sort.wire}';
  }

  static bool _same(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    final x = [...a]..sort();
    final y = [...b]..sort();
    for (var i = 0; i < x.length; i++) {
      if (x[i] != y[i]) return false;
    }
    return true;
  }
}
