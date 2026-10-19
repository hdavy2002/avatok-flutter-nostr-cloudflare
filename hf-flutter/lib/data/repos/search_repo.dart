import '../api_client.dart';
import '../api_exception.dart';
import '../models/search.dart';

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
  Future<SearchResult> search(String q, {String? topic}) => _guard(() async {
        final query = <String, Object?>{'q': q.trim()};
        if (topic != null && topic.isNotEmpty) query['topic'] = topic;
        return SearchResult.fromJson(await _api.getJson('/api/hf/search', query: query, auth: false));
      });

  /// The topic chips. The worker is the single source (`GET /api/hf/options`).
  Future<List<TopicOption>> topics() async {
    final j = await _api.getJson('/api/hf/options', auth: false);
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
