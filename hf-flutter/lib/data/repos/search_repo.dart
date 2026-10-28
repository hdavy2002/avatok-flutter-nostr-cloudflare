import '../api_client.dart';
import '../api_exception.dart';
import '../models/search.dart';
import '../models/search_filters.dart'; // [HF-SEARCH-FILTERS-1]
import '../response_cache.dart';

/// Search, topic chips and Invite votes (HF-REEL-9 / HF-REEL-29).
class SearchRepo {
  const SearchRepo(this._api);

  final ApiClient _api;

  static const String notOpenText = 'Search is not open yet. Please check back soon.';

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        throw const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: notOpenText);
      }
      rethrow;
    }
  }

  /// Our network (online first), plus the exact @handle lookup for people who are not here yet. Public: no sign-in.
  /// [platform] is `youtube` or `instagram` (HF-REEL-41); null or `all` means everything.
  /// [HF-SEARCH-FILTERS-1] With [filters] the new parameters are sent instead of topic / platform / space (see [searchQuery]); [offset] pages the list.
  Future<SearchResult> search(String q, {String? topic, String? platform, String? space, SearchFilters? filters, int offset = 0}) => _guard(() async {
        final query = searchQuery(q, topic: topic, platform: platform, space: space, filters: filters, offset: offset);
        return SearchResult.fromJson(await _api.getJson('/api/hf/search', query: query, auth: false, store: true));
      });

  /// The query of `GET /api/hf/search`. Without [filters] it is exactly what older builds sent. With [filters] the server's intro listing
  /// (flag `hfIntroReelsEnabled`) filters, sorts and pages; an older server just ignores the extra keys.
  static Map<String, Object?> searchQuery(String q, {String? topic, String? platform, String? space, SearchFilters? filters, int offset = 0}) {
    final query = <String, Object?>{'q': q.trim()};
    if (filters != null) {
      query.addAll(filters.toQuery());
      query['limit'] = '$kSearchPage';
      if (offset > 0) query['offset'] = '$offset';
      return query;
    }
    if (topic != null && topic.isNotEmpty) query['topic'] = topic;
    if (platform == 'youtube' || platform == 'instagram') query['platform'] = platform;
    if (space == 'women') query['space'] = space; // [HF-CREATOR-SPACES-1] [HF-SEARCH-FILTERS-1] the LGBTQ+ and Video KYC filters are gone
    return query;
  }

  /// Cards per page.
  static const int kSearchPage = 30;

  /// [HF-APP-CACHE-1] [search] cached-first (the landing list and repeat searches paint at once).
  Stream<SearchResult> watchSearch(String q, {String? topic, String? platform, String? space, SearchFilters? filters}) {
    final query = searchQuery(q, topic: topic, platform: platform, space: space, filters: filters);
    return _guard2(_api.watchJson('/api/hf/search', query: query, auth: false, policy: CachePolicy.list).map(SearchResult.fromJson));
  }

  Stream<T> _guard2<T>(Stream<T> s) async* {
    try {
      yield* s;
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        throw const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: notOpenText);
      }
      rethrow;
    }
  }

  /// [HF-APP-CACHE-1] The topic chips, cached-first (they almost never change).
  Stream<List<TopicOption>> watchTopics() =>
      _api.watchJson('/api/hf/options', auth: false, policy: CachePolicy.stable).map(_topicsOf);

  /// [HF-SEARCH-FILTERS-1] The category catalogue (`GET /api/hf/onboarding/categories`, sensitive four last), cached-first. Empty when it cannot be read.
  Stream<List<FilterOption>> watchCategories() => _api.watchJson('/api/hf/onboarding/categories', auth: false, policy: CachePolicy.stable).map(categoriesOf);

  /// [HF-SEARCH-FILTERS-1] The language list (`languages` of `GET /api/hf/options`), cached-first. Empty when it cannot be read.
  Stream<List<FilterOption>> watchLanguages() => _api.watchJson('/api/hf/options', auth: false, policy: CachePolicy.stable).map(languagesOf);

  static List<FilterOption> categoriesOf(Map<String, dynamic> j) => [
        for (final e in (j['categories'] is List ? j['categories'] as List : const []))
          if (e is Map && e['id'] != null) FilterOption('${e['id']}', '${e['label'] ?? e['id']}', sensitive: e['sensitive'] == true),
      ];

  static List<FilterOption> languagesOf(Map<String, dynamic> j) => [
        for (final e in (j['languages'] is List ? j['languages'] as List : const []))
          if (e is Map && e['code'] != null) FilterOption('${e['code']}', '${e['label'] ?? e['code']}'),
      ];

  /// [HF-APP-CACHE-1] "Most-wanted, not here yet", cached-first. Switched off (404) means an empty list.
  Stream<List<MissingCreator>> watchTopInvites() async* {
    try {
      await for (final j in _api.watchJson('/api/hf/invites/top', auth: false, policy: CachePolicy.list)) {
        yield [
          for (final e in (j['items'] is List ? j['items'] as List : const []))
            if (e is Map) MissingCreator.fromJson(Map<String, dynamic>.from(e)),
        ];
      }
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        yield const <MissingCreator>[];
        return;
      }
      rethrow;
    }
  }

  static List<TopicOption> _topicsOf(Map<String, dynamic> j) => [
        for (final e in (j['topics'] is List ? j['topics'] as List : const []))
          if (e is Map && e['slug'] != null) TopicOption(slug: '${e['slug']}', label: '${e['label'] ?? e['slug']}'),
      ];

  /// The topic chips. The worker is the single source (`GET /api/hf/options`).
  Future<List<TopicOption>> topics() async {
    final j = await _api.getJson('/api/hf/options', auth: false, store: true);
    return [
      for (final e in (j['topics'] is List ? j['topics'] as List : const []))
        if (e is Map && e['slug'] != null) TopicOption(slug: '${e['slug']}', label: '${e['label'] ?? e['slug']}'),
    ];
  }

  /// "Most-wanted, not here yet". An empty list when invites are switched off.
  Future<List<MissingCreator>> topInvites() async {
    try {
      final j = await _api.getJson('/api/hf/invites/top', auth: false);
      return [
        for (final e in (j['items'] is List ? j['items'] as List : const []))
          if (e is Map) MissingCreator.fromJson(Map<String, dynamic>.from(e)),
      ];
    } on ApiException catch (e) {
      if (e.isNotEnabled) return const [];
      rethrow;
    }
  }

  /// [HF-VOTE-COUNT-1] The live vote total of one creator who is not here yet (`GET /api/hf/invites/:platform/:handle`).
  /// Null when it cannot be read; the caller keeps what it already shows.
  Future<int?> voteCount(String platform, String handle) async {
    try {
      final h = Uri.encodeComponent(handle.replaceFirst('@', ''));
      final j = await _api.getJson('/api/hf/invites/${Uri.encodeComponent(platform)}/$h', auth: false);
      final c = j['creator'];
      final v = c is Map ? c['votes'] : null;
      return v is num ? v.toInt() : null;
    } catch (_) {
      return null;
    }
  }

  /// Vote to bring [c] in. One vote per person; repeating it is harmless. Returns the new total.
  /// [HF-REEL-CALL-2] The worker's route is `POST /api/hf/invites/:platform/:handle`; its header comment also names a
  /// `.../vote` form, so a 404 (route not found, not the flag being off) retries once on that path.
  Future<int> vote(MissingCreator c) => _guard(() async {
        final handle = Uri.encodeComponent(c.handle.replaceFirst('@', ''));
        final base = '/api/hf/invites/${Uri.encodeComponent(c.platform)}/$handle';
        Map<String, dynamic> j;
        try {
          j = await _api.postJson(base);
        } on ApiException catch (e) {
          if (e.status != 404 || e.isNotEnabled) rethrow;
          j = await _api.postJson('$base/vote');
        }
        final v = j['votes'];
        return v is num ? v.toInt() : c.votes + 1;
      });
}
