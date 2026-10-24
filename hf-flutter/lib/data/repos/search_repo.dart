import '../api_client.dart';
import '../api_exception.dart';
import '../models/search.dart';
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
  Future<SearchResult> search(String q, {String? topic, String? platform, String? space}) => _guard(() async {
        final query = <String, Object?>{'q': q.trim()};
        if (topic != null && topic.isNotEmpty) query['topic'] = topic;
        if (platform == 'youtube' || platform == 'instagram') query['platform'] = platform;
        if (space == 'women' || space == 'lgbtq') query['space'] = space; // [HF-CREATOR-SPACES-1]
        return SearchResult.fromJson(await _api.getJson('/api/hf/search', query: query, auth: false, store: true));
      });

  /// [HF-APP-CACHE-1] [search] cached-first (the landing list and repeat searches paint at once).
  Stream<SearchResult> watchSearch(String q, {String? topic, String? platform, String? space}) {
    final query = <String, Object?>{'q': q.trim()};
    if (topic != null && topic.isNotEmpty) query['topic'] = topic;
    if (platform == 'youtube' || platform == 'instagram') query['platform'] = platform;
    if (space == 'women' || space == 'lgbtq') query['space'] = space; // [HF-CREATOR-SPACES-1]
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

  /// Vote to bring [c] in. One vote per person; repeating it is harmless. Returns the new total.
  Future<int> vote(MissingCreator c) => _guard(() async {
        final handle = Uri.encodeComponent(c.handle.replaceFirst('@', ''));
        final j = await _api.postJson('/api/hf/invites/${Uri.encodeComponent(c.platform)}/$handle');
        final v = j['votes'];
        return v is num ? v.toInt() : c.votes + 1;
      });
}
