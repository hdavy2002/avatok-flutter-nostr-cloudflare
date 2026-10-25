import '../api_client.dart';
import '../api_exception.dart';
import '../models/reel.dart';
import '../response_cache.dart';

/// Reels: the public feed, a single reel (deep link), the public profile, and the influencer's own reels.
class ReelsRepo {
  const ReelsRepo(this._api);

  final ApiClient _api;

  static const String notOpenText =
      'Reels are not open yet. Please check back soon.';

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        throw const ApiException(
          kind: ApiFailure.http,
          status: 404,
          code: 'not_enabled',
          message: notOpenText,
        );
      }
      rethrow;
    }
  }

  /// One page of the feed (online influencers only). Guests can watch, so no sign-in is needed.
  Future<ReelsPage> feed({String? cursor, int limit = 10}) => _guard(
    () async => ReelsPage.fromJson(
      await _api.getJson(
        '/api/hf/reels',
        query: {'cursor': cursor, 'limit': limit},
        auth: false,
        store: cursor == null,
      ),
    ),
  );

  /// [HF-REELS-FAST-START-1] The first page [feed] stored last time (up to a day old), or null. Never touches the network.
  Future<ReelsPage?> cachedFirstPage({int limit = 10}) async {
    try {
      final j = await _api.peekJson('/api/hf/reels', query: {'cursor': null, 'limit': limit}, auth: false, maxAge: const Duration(days: 1));
      return j == null ? null : ReelsPage.fromJson(j);
    } catch (_) {
      return null;
    }
  }

  /// [HF-APP-CACHE-1] The first page of the feed, cached-first (not wired into the feed screen yet; see the speed plan).
  Stream<ReelsPage> watchFirstPage({int limit = 10}) => _guard2(
    _api
        .watchJson(
          '/api/hf/reels',
          query: {'limit': limit},
          auth: false,
          policy: CachePolicy.list,
        )
        .map(ReelsPage.fromJson),
  );

  /// [HF-APP-CACHE-1] A public profile, cached-first.
  Stream<PublicProfile> watchProfile(String slug) => _guard2(
    _api
        .watchJson(
          '/api/hosts/public/${Uri.encodeComponent(slug)}',
          auth: false,
          policy: CachePolicy.profile,
        )
        .map(PublicProfile.fromJson),
  );

  Stream<T> _guard2<T>(Stream<T> s) async* {
    try {
      yield* s;
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        throw const ApiException(
          kind: ApiFailure.http,
          status: 404,
          code: 'not_enabled',
          message: notOpenText,
        );
      }
      rethrow;
    }
  }

  /// One reel, for the `/reels?reel=<id>` link. Null when it is gone or hidden.
  Future<FeedReel?> one(String id) async {
    try {
      final j = await _guard(
        () => _api.getJson(
          '/api/hf/reels/${Uri.encodeComponent(id)}',
          auth: false,
        ),
      );
      final item = j['item'];
      return item is Map
          ? FeedReel.fromJson(Map<String, dynamic>.from(item))
          : null;
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }

  /// Counts a view. Fire and forget: never throws.
  Future<void> view(String id) async {
    try {
      await _api.postJson(
        '/api/hf/reels/${Uri.encodeComponent(id)}/view',
        auth: false,
      );
    } catch (_) {
      // a missed count is fine
    }
  }

  /// [HF-REEL-SKIP-2] Tell the server this reel cannot play inside the app, so it is hidden for everyone once enough phones
  /// agree. Best effort: a lost report only means another phone reports it.
  Future<void> reportUnplayable(String id, String reason) async {
    try {
      await _api.postJson(
        '/api/hf/reels/${Uri.encodeComponent(id)}/unplayable',
        body: {'reason': reason},
        auth: false,
      );
    } catch (_) {
      // best effort
    }
  }

  /// The public profile of an influencer by slug, with her visible reels.
  Future<PublicProfile> profile(String slug) => _guard(
    () async => PublicProfile.fromJson(
      await _api.getJson(
        '/api/hosts/public/${Uri.encodeComponent(slug)}',
        auth: false,
        store: true,
      ),
    ),
  );

  /// The signed-in influencer's own reels, hidden ones too.
  Future<List<MyReel>> mine() => _guard(() async {
    final j = await _api.getJson('/api/hf/hosts/me/reels');
    return [
      for (final e in (j['reels'] is List ? j['reels'] as List : const []))
        if (e is Map) MyReel.fromJson(Map<String, dynamic>.from(e)),
    ];
  });

  /// Show on / hide from the feed.
  Future<MyReel> setVisible(String id, bool visible) => _guard(() async {
    final j = await _api.patchJson(
      '/api/hf/reels/${Uri.encodeComponent(id)}',
      body: {'visible': visible},
    );
    final r = j['reel'];
    return r is Map
        ? MyReel.fromJson(Map<String, dynamic>.from(r))
        : MyReel(id: id, visible: visible);
  });
}
