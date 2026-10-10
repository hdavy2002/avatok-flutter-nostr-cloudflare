import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/storage/cache.dart';
import 'host_card.dart';
import 'host_filters.dart';

/// Cache key of the Explore list (the last unfiltered-or-filtered first page; see [HostFilters.cacheKey]).
const String kExploreCacheKey = 'hf.cache.hosts.v1';

/// Cache key of the "Online now" strip on Home.
const String kOnlineCacheKey = 'hf.cache.hosts.online.v1';

/// One answer of [HostsRepository.firstPage].
class HostListUpdate {
  const HostListUpdate({
    required this.page,
    this.fromCache = false,
    this.stale = false,
    this.failed = false,
  });

  final HostsPage page;

  /// The page came from the phone's saved copy, not from the server.
  final bool fromCache;

  /// The saved copy is older than 10 minutes (shows the "Showing saved list" pill).
  final bool stale;

  /// The refresh failed, so the saved copy is all there is (also shows the pill).
  final bool failed;

  bool get showSaved => fromCache && (stale || failed);
}

/// `GET /api/hf/hosts` with the offline cache: cached first, then fresh.
///
/// Lane lists carry the person's bearer token and are never cached (they are private to the lane).
class HostsRepository {
  HostsRepository(this._api, this._cache);

  final ApiClient _api;
  final JsonCache _cache;

  /// A saved list older than this shows the "Showing saved list" pill (spec section 4.6).
  static const Duration staleAfter = Duration(minutes: 10);
  static const int pageSize = 24;

  /// One page from the server. Throws [ApiError] (the network, `401` or `403 lane_required` for a lane, `404 not_enabled`).
  Future<HostsPage> fetch(HostFilters f, {int offset = 0, int limit = pageSize}) async {
    final json = await _api.request(
      'GET',
      '/api/hf/hosts',
      query: f.toApiQuery(limit: limit, offset: offset),
      // The bearer token is only for lanes. An anonymous list stays cacheable at the edge.
      auth: f.lane != null,
    );
    if (json is! Map) throw ApiError.badResponse(200);
    return HostsPage.fromJson(json);
  }

  /// The first page as a stream: the saved copy at once (when there is one for these filters), then the
  /// fresh page. If the refresh fails and a saved copy was shown, a last update says so (`failed`) instead
  /// of throwing. With no saved copy the failure is thrown as an [ApiError].
  ///
  /// [screen] is the telemetry source (`explore` or `home`). Emits `hf_hosts_list_loaded` once.
  Stream<HostListUpdate> firstPage(
    HostFilters f, {
    String? cacheKey,
    bool useCache = true,
    int limit = pageSize,
    String screen = 'explore',
  }) async* {
    final sw = Stopwatch()..start();
    HostsPage? saved;
    var savedStale = true;
    if (useCache && cacheKey != null && f.lane == null) {
      final entry = await _cache.read(cacheKey);
      final data = entry?.data;
      if (entry != null && data is Map && data['key'] == f.cacheKey) {
        saved = HostsPage.fromJson(data['page']);
        savedStale = entry.isStale(staleAfter);
        yield HostListUpdate(page: saved, fromCache: true, stale: savedStale);
      }
    }
    try {
      final page = await fetch(f, limit: limit);
      if (cacheKey != null && f.lane == null) {
        await _cache.write(cacheKey, <String, Object?>{'key': f.cacheKey, 'page': page.toJson()});
      }
      _report(screen, ok: true, count: page.items.length, fromCache: false, sw: sw);
      yield HostListUpdate(page: page);
    } catch (e, st) {
      final err = _asApiError(e, st);
      _report(screen, ok: false, count: saved?.items.length ?? 0, fromCache: saved != null, sw: sw, error: err);
      // A flag that is off, or a lane that is closed to this person, is an answer, not a bad connection:
      // never hide it behind an old list.
      final shown = saved;
      if (shown != null && !err.isNotEnabled && !err.isUnauthorized && err.code != 'lane_required') {
        yield HostListUpdate(page: shown, fromCache: true, stale: true, failed: true);
      } else {
        throw err;
      }
    }
  }

  ApiError _asApiError(Object e, StackTrace st) {
    if (e is ApiError) return e;
    // Not an API failure: a bug. Report it, show the generic message.
    Analytics.captureException(e, st, screen: 'explore', handled: true, extra: {'where': 'hosts_repository'});
    return const ApiError(status: 0, code: 'unknown');
  }

  void _report(String screen,
      {required bool ok, required int count, required bool fromCache, required Stopwatch sw, ApiError? error}) {
    Analytics.capture('hf_hosts_list_loaded', <String, Object>{
      'screen_name': screen,
      'outcome': ok ? 'ok' : 'error',
      'result': !ok ? 'error' : (count == 0 ? 'empty' : 'cards'),
      if (error != null) 'reason': error.code,
      if (error != null) 'status': error.status,
      'count': count,
      'from_cache': fromCache,
      'ms': sw.elapsedMilliseconds,
    });
  }
}

final hostsRepositoryProvider = Provider<HostsRepository>(
  (ref) => HostsRepository(ref.watch(apiClientProvider), ref.watch(jsonCacheProvider)),
);
