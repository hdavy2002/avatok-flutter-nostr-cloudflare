import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import 'host_card.dart';
import 'host_filters.dart';
import 'hosts_repository.dart';

enum ExploreStatus {
  /// First page on its way and nothing to show yet.
  loading,

  /// A list to show (possibly empty, possibly a saved copy).
  ready,

  /// The first page failed and there is no saved copy.
  error,

  /// A lane tab while signed out.
  signInNeeded,

  /// `403 lane_required`: the person has not joined this lane.
  laneRequired,

  /// `404 not_enabled`: the list is switched off.
  comingSoon,
}

class ExploreState {
  const ExploreState({
    required this.filters,
    required this.status,
    this.items = const <HostCard>[],
    this.nextOffset,
    this.total = 0,
    this.fromCache = false,
    this.stale = false,
    this.refreshFailed = false,
    this.awaitingFresh = false,
    this.loadingMore = false,
    this.loadMoreFailed = false,
    this.error,
  });

  final HostFilters filters;
  final ExploreStatus status;
  final List<HostCard> items;
  final int? nextOffset;
  final int total;

  /// The list on screen is a saved copy (or an old list a refresh could not renew).
  final bool fromCache;
  final bool stale;
  final bool refreshFailed;

  /// Only the saved copy is here so far; the fresh page is still on its way.
  final bool awaitingFresh;
  final bool loadingMore;
  final bool loadMoreFailed;
  final ApiError? error;

  /// The "Showing saved list" pill: a saved copy that is old, or one the refresh could not replace.
  bool get showSavedPill => fromCache && (stale || refreshFailed);

  bool get hasMore => nextOffset != null;

  ExploreState copyWith({
    HostFilters? filters,
    ExploreStatus? status,
    List<HostCard>? items,
    Object? nextOffset = _keep,
    int? total,
    bool? fromCache,
    bool? stale,
    bool? refreshFailed,
    bool? awaitingFresh,
    bool? loadingMore,
    bool? loadMoreFailed,
    ApiError? error,
    bool clearError = false,
  }) =>
      ExploreState(
        filters: filters ?? this.filters,
        status: status ?? this.status,
        items: items ?? this.items,
        nextOffset: identical(nextOffset, _keep) ? this.nextOffset : nextOffset as int?,
        total: total ?? this.total,
        fromCache: fromCache ?? this.fromCache,
        stale: stale ?? this.stale,
        refreshFailed: refreshFailed ?? this.refreshFailed,
        awaitingFresh: awaitingFresh ?? this.awaitingFresh,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
        error: clearError ? null : (error ?? this.error),
      );

  static const Object _keep = Object();
}

/// Where a filter change came from (telemetry `source`).
enum FilterSource { sheet, lane, route, clear }

/// The Explore list: filters, the first page (cached, then fresh), more pages, refresh.
///
/// One request counts at a time: every new load bumps [_gen], and an answer from an older load is dropped.
final exploreControllerProvider = NotifierProvider<ExploreController, ExploreState>(ExploreController.new);

class ExploreController extends Notifier<ExploreState> {
  int _gen = 0;
  bool _started = false;

  @override
  ExploreState build() => const ExploreState(filters: HostFilters.none, status: ExploreStatus.loading);

  HostsRepository get _repo => ref.read(hostsRepositoryProvider);

  /// The route's filters arrived (first build, a Home tile, a deep link). The local sort is kept.
  Future<void> applyRoute(HostFilters fromRoute) {
    final next = fromRoute.copyWith(sort: state.filters.sort);
    if (_started && state.filters.sameRequest(next)) return Future<void>.value();
    final changed = _started;
    if (changed) _filterApplied(next, FilterSource.route);
    return _load(next);
  }

  /// The person changed filters (sheet, lane tab, clear).
  Future<void> setFilters(HostFilters next, {FilterSource source = FilterSource.sheet}) {
    if (_started && state.filters.sameRequest(next)) return Future<void>.value();
    _filterApplied(next, source);
    return _load(next);
  }

  /// Pull to refresh, "Try again", and the sign-in coming back. Keeps the list on screen while it loads.
  Future<void> refresh() => _load(state.filters, keepItems: true, useCache: false);

  /// Reload for the same filters, starting from the saved copy (used after sign-in).
  Future<void> reload() => _load(state.filters);

  void _filterApplied(HostFilters f, FilterSource source) {
    Analytics.capture('hf_app_filter_applied', <String, Object>{
      'filters': f.toTelemetry(),
      'source': source.name,
    });
  }

  Future<void> _load(HostFilters f, {bool keepItems = false, bool useCache = true}) async {
    final gen = ++_gen;
    _started = true;
    final signedIn = ref.read(sessionProvider).isSignedIn;
    if (f.lane != null && !signedIn) {
      state = ExploreState(filters: f, status: ExploreStatus.signInNeeded);
      return;
    }
    final keep = keepItems && state.status == ExploreStatus.ready && state.items.isNotEmpty;
    state = keep
        ? state.copyWith(filters: f, loadMoreFailed: false, loadingMore: false, refreshFailed: false)
        : ExploreState(filters: f, status: ExploreStatus.loading);
    try {
      await for (final u in _repo.firstPage(
        f,
        cacheKey: kExploreCacheKey,
        useCache: useCache,
        screen: 'explore',
      )) {
        if (gen != _gen) return;
        state = ExploreState(
          filters: f,
          status: ExploreStatus.ready,
          items: u.page.items,
          nextOffset: u.page.nextOffset,
          total: u.page.total,
          fromCache: u.fromCache,
          stale: u.stale,
          refreshFailed: u.failed,
          awaitingFresh: u.fromCache && !u.failed,
        );
      }
    } on ApiError catch (e) {
      if (gen != _gen) return;
      if (f.lane != null && e.isUnauthorized) {
        state = ExploreState(filters: f, status: ExploreStatus.signInNeeded);
      } else if (f.lane != null && e.code == 'lane_required') {
        state = ExploreState(filters: f, status: ExploreStatus.laneRequired);
      } else if (e.isNotEnabled) {
        state = ExploreState(filters: f, status: ExploreStatus.comingSoon, error: e);
      } else if (keep) {
        // The refresh failed: keep what is on screen and say it is not fresh.
        state = state.copyWith(fromCache: true, refreshFailed: true, awaitingFresh: false, error: e);
      } else {
        state = ExploreState(filters: f, status: ExploreStatus.error, error: e);
      }
    }
  }

  /// The next page. Called when the person scrolls near the end; after a failure it waits for the person to
  /// tap "Try again" ([retry]) instead of asking again on every scroll.
  Future<void> loadMore({bool retry = false}) async {
    final s = state;
    final offset = s.nextOffset;
    if (s.status != ExploreStatus.ready || s.loadingMore || s.awaitingFresh || offset == null) return;
    if (s.loadMoreFailed && !retry) return;
    final gen = _gen;
    state = s.copyWith(loadingMore: true, loadMoreFailed: false);
    try {
      final page = await _repo.fetch(s.filters, offset: offset);
      if (gen != _gen) return;
      final seen = <String>{for (final c in state.items) c.slug};
      final merged = <HostCard>[...state.items, for (final c in page.items) if (seen.add(c.slug)) c];
      state = state.copyWith(
        items: merged,
        nextOffset: page.items.isEmpty ? null : page.nextOffset,
        total: page.total,
        loadingMore: false,
      );
    } catch (_) {
      if (gen != _gen) return;
      state = state.copyWith(loadingMore: false, loadMoreFailed: true);
    }
  }
}
