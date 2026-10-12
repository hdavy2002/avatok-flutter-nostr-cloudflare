import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/config/flags.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/tab_shell.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../home/data/home_balance.dart';
import '../data/explore_controller.dart';
import '../data/host_card.dart';
import '../data/host_filters.dart';
import '../data/host_options.dart';
import '../data/hosts_repository.dart';
import '../widgets/host_card_view.dart';
import '../widgets/marketplace_host_tile.dart';
import 'explore_copy.dart';
import 'filter_sheet.dart';
import 'discovery_header.dart';

/// Tab 2: the marketplace. Filters live in the route query: `/explore?lane=&topics=&lang=&max=&online=`.
///
/// - Cached list at once, fresh list right after; pull to refresh; more pages as you scroll.
/// - Lane tabs: All / Women-only / LGBTQ+. A lane needs sign-in, and `403 lane_required` shows "Verify to join".
/// - A filter sheet (mood, language, price, online only). Anyone can browse without signing in.
class ExploreScreen extends ConsumerStatefulWidget {
  const ExploreScreen({super.key, this.query = const <String, String>{}});

  /// The route's query parameters (lane, topics, lang, max, online).
  final Map<String, String> query;

  @override
  ConsumerState<ExploreScreen> createState() => _ExploreScreenState();
}

class _ExploreScreenState extends ConsumerState<ExploreScreen> {
  final ScrollController _scroll = ScrollController();
  final TextEditingController _search = TextEditingController();
  Timer? _searchDebounce;

  ExploreController get _controller =>
      ref.read(exploreControllerProvider.notifier);

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    final fromRoute = HostFilters.fromRouteQuery(widget.query);
    _search.text = fromRoute.search;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Analytics.capture('hf_app_explore_viewed', <String, Object>{
        'filtered': fromRoute.hasAny,
        if (fromRoute.lane != null) 'lane': fromRoute.lane!,
      });
      unawaited(_controller.applyRoute(fromRoute));
    });
  }

  @override
  void didUpdateWidget(ExploreScreen old) {
    super.didUpdateWidget(old);
    if (!mapEquals(old.query, widget.query)) {
      final fromRoute = HostFilters.fromRouteQuery(widget.query);
      if (_search.text.trim() != fromRoute.search) _search.text = fromRoute.search;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_controller.applyRoute(fromRoute));
      });
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _scroll.dispose();
    _search.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final p = _scroll.position;
    if (p.pixels >= p.maxScrollExtent - 600) unawaited(_controller.loadMore());
  }

  /// A short first page on a tall screen cannot scroll, so no scroll event would ask for more.
  void _fillViewport() {
    if (!mounted || !_scroll.hasClients) return;
    if (_scroll.position.maxScrollExtent <= 0) {
      unawaited(_controller.loadMore());
    }
  }

  /// Applies filters and keeps the route in step, so `/explore?...` always describes what is on screen.
  void _apply(HostFilters f, FilterSource source) {
    _searchDebounce?.cancel();
    if (_search.text.trim() != f.search) _search.text = f.search;
    unawaited(_controller.setFilters(f, source: source));
    GoRouter.of(context).go(f.toLocation());
  }

  void _searchHosts(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), () {
      if (!mounted) return;
      _apply(ref.read(exploreControllerProvider).filters.copyWith(
        search: HostFilters.cleanSearch(value),
      ), FilterSource.sheet);
    });
  }

  void _chooseFilters(HostFilters next) {
    final previous = ref.read(exploreControllerProvider).filters;
    final me = ref.read(sessionProvider).me;
    final granted = next.lane == HostLane.women
        ? me?.womenLane == true
        : me?.lgbtqLane == true;
    if (next.lane != null && next.lane != previous.lane && !granted) {
      unawaited(
        GoRouter.of(
          context,
        ).push(Routes.lanesOf(next.lane, next: next.toLocation())),
      );
      return;
    }
    _apply(
      next,
      next.lane != previous.lane ? FilterSource.lane : FilterSource.sheet,
    );
  }

  Future<void> _openFilters(HostFilters current) async {
    final standardPlan = (await ref.read(flagsProvider.future)).hfStdPlanEnabled;
    if (!mounted) return;
    final result = await showFilterSheet(
      context,
      current,
      standardPlan: standardPlan,
      countFor: _controller.previewCount,
    );
    if (result == null || !mounted) return;
    _apply(result, FilterSource.sheet);
  }

  Future<void> _verify(String? lane) async {
    await GoRouter.of(context).push(
      Routes.lanesOf(
        lane,
        next: ref.read(exploreControllerProvider).filters.toLocation(),
      ),
    );
    if (mounted) unawaited(_controller.reload());
  }

  Future<void> _refresh() {
    ref.invalidate(homeBalanceProvider);
    ref.invalidate(marketplaceSectionProvider);
    return _controller.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(exploreControllerProvider);
    final options = optionsOf(ref.watch(hostOptionsProvider));
    ref.listen<bool>(sessionProvider.select((s) => s.isSignedIn), (prev, next) {
      if (prev != next &&
          ref.read(exploreControllerProvider).filters.lane != null) {
        unawaited(_controller.reload());
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _fillViewport());
    final f = st.filters;
    return Scaffold(
      body: SafeArea(
        top: true,
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: CustomScrollView(
            controller: _scroll,
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverToBoxAdapter(
                child: DiscoveryHeader(
                  filters: f,
                  options: options,
                  search: _search,
                  onSearch: _searchHosts,
                  onFilters: () => _openFilters(f),
                  onApply: _chooseFilters,
                  showListTitle: false,
                ),
              ),
              if (st.status == ExploreStatus.ready && st.showSavedPill)
                const SliverToBoxAdapter(child: _SavedPill()),
              ..._body(st, options),
              SliverToBoxAdapter(
                child: SizedBox(height: hfNavPadding(context)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _body(ExploreState st, HostOptions? options) {
    Widget fill(Widget child) =>
        SliverFillRemaining(hasScrollBody: false, child: child);
    final f = st.filters;
    switch (st.status) {
      case ExploreStatus.loading:
        return [
          const SliverPadding(
            padding: EdgeInsets.fromLTRB(HfSpacing.page, 14, HfSpacing.page, 0),
            sliver: SliverToBoxAdapter(child: _LoadingCards()),
          ),
        ];
      case ExploreStatus.error:
        return [
          fill(
            ErrorPanel(
              error: st.error,
              onRetry: () => unawaited(_controller.refresh()),
            ),
          ),
        ];
      case ExploreStatus.comingSoon:
        return [fill(const ComingSoonPanel())];
      case ExploreStatus.signInNeeded:
        return [
          fill(
            _LanePanel(
              icon: Icons.lock_outline_rounded,
              title: ExploreCopy.signInLaneTitle,
              body: ExploreCopy.signInLaneBody,
              action: HfButton(
                label: 'About this space',
                onPressed: () => _verify(f.lane),
              ),
            ),
          ),
        ];
      case ExploreStatus.laneRequired:
        return [
          fill(
            _LanePanel(
              icon: Icons.verified_user_outlined,
              title: ExploreCopy.verifyTitle,
              body: ExploreCopy.verifyBody,
              action: HfButton(
                label: ExploreCopy.verifyButton,
                onPressed: () => _verify(f.lane),
              ),
            ),
          ),
        ];
      case ExploreStatus.ready:
        if (st.items.isEmpty && f.activeCount > 0) {
          return [
            fill(
              EmptyPanel(
                      message: ExploreCopy.emptyFiltered,
                      actionLabel: ExploreCopy.clearFilters,
                      onAction: () => _apply(
                        HostFilters.none.copyWith(lane: f.lane),
                        FilterSource.clear,
                      ),
                    ),
            ),
          ];
        }
        return _list(st, options);
    }
  }

  List<Widget> _list(ExploreState st, HostOptions? options) {
    final labels = options?.topicLabels ?? const <String, String>{};
    final items = st.items;
    final browse = st.filters.activeCount == 0;
    final base = HostFilters.none.copyWith(lane: st.filters.lane);
    return [
      if (browse)
        SliverToBoxAdapter(
          child: _ServerHostRail(
            title: 'Popular conversations',
            filters: base.copyWith(sort: HostSort.popular),
            from: 'explore_popular',
          ),
        ),
      if (browse)
        SliverToBoxAdapter(
          child: _ServerHostRail(
            title: 'Online now',
            filters: base.copyWith(online: true),
            from: 'explore_online',
          ),
        ),
      if (browse) ...[
        SliverToBoxAdapter(child: _CommunityServicesCard(base: base, options: options)),
        SliverToBoxAdapter(child: _ServerHostRail(
          title: 'Influencers & creators',
          filters: base.copyWith(category: HostCategoryFilter.creators),
          from: 'explore_creators',
        )),
      ],
      SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              HfSpacing.pageWide,
              HfSpacing.xxl,
              HfSpacing.pageWide,
              0,
            ),
            child: Row(children: [
              Expanded(child: Text(browse ? 'All hosts' : _resultsTitle(st.filters), style: HfText.section)),
              if (!browse) TextButton(onPressed: () => _apply(base, FilterSource.clear), child: const Text('Clear filters')),
            ]),
          ),
        ),
      if (items.isEmpty)
        const SliverToBoxAdapter(child: Padding(
          padding: EdgeInsets.all(HfSpacing.page),
          child: Text(ExploreCopy.emptyAll),
        )),
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(
          HfSpacing.page,
          14,
          HfSpacing.page,
          0,
        ),
        sliver: SliverLayoutBuilder(
          builder: (context, c) {
            // Full width on a phone; two columns once the screen is wide (tablet, foldable).
            final columns = c.crossAxisExtent >= 720 ? 2 : 1;
            final rows = (items.length / columns).ceil();
            return SliverList.separated(
              itemCount: rows,
              separatorBuilder: (_, __) => const SizedBox(height: 22),
              itemBuilder: (context, row) {
                Widget cardAt(int idx) => idx < items.length
                    ? HostCardView(
                        host: items[idx],
                        topicLabels: labels,
                        from: 'explore',
                        lane: st.filters.lane,
                      )
                    : const SizedBox.shrink();
                if (columns == 1) return cardAt(row);
                final cells = <Widget>[];
                for (var i = 0; i < columns; i++) {
                  cells.add(Expanded(child: cardAt(row * columns + i)));
                  if (i < columns - 1) cells.add(const SizedBox(width: 22));
                }
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: cells,
                );
              },
            );
          },
        ),
      ),
      SliverToBoxAdapter(
        child: _Footer(
          st: st,
          onRetry: () => unawaited(_controller.loadMore(retry: true)),
        ),
      ),
      const SliverToBoxAdapter(
        child: Padding(
          padding: EdgeInsets.fromLTRB(HfSpacing.page, 0, HfSpacing.page, 20),
          child: CrisisStrip(),
        ),
      ),
    ];
  }

  String _resultsTitle(HostFilters f) {
    if (f.search.isNotEmpty) return 'Search results';
    if (f.category == HostCategoryFilter.influencer) return 'Influencers';
    if (f.category == HostCategoryFilter.celebrity) return 'Celebrities';
    if (f.category == HostCategoryFilter.creators) return 'Influencers & creators';
    if (f.online) return 'Online now';
    if (f.sort == HostSort.popular) return 'Popular conversations';
    return 'Hosts for you';
  }
}

class _CommunityServicesCard extends StatelessWidget {
  const _CommunityServicesCard({required this.base, required this.options});

  final HostFilters base;
  final HostOptions? options;

  void _topic(BuildContext context, HostTopic topic) =>
      GoRouter.of(context).go(base.copyWith(topics: [topic.slug]).toLocation());

  void _allTopics(BuildContext context) {
    final topics = options?.topics ?? const <HostTopic>[];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView.builder(
          itemCount: topics.length + 1,
          itemBuilder: (_, i) => i == 0
              ? const Padding(padding: EdgeInsets.all(HfSpacing.page), child: Text('Services for you', style: HfText.section))
              : ListTile(
                  title: Text(topics[i - 1].label),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _topic(context, topics[i - 1]);
                  },
                ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final topics = options?.topics ?? const <HostTopic>[];
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.xxl,
        HfSpacing.pageWide,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _SectionTitle(
            title: 'Communities',
            onSeeAll: () => GoRouter.of(context).go(base.copyWith(category: HostCategoryFilter.creators).toLocation()),
          ),
          const SizedBox(height: HfSpacing.lg),
          LayoutBuilder(builder: (context, c) {
            final columns = c.maxWidth >= 280 && MediaQuery.textScalerOf(context).scale(16) <= 24 ? 2 : 1;
            return Wrap(spacing: HfSpacing.lg, runSpacing: HfSpacing.lg, children: [
              for (final entry in (const {'influencer': 'Influencers', 'celebrity': 'Celebrities'}).entries)
                SizedBox(
                  width: (c.maxWidth - (columns - 1) * HfSpacing.lg) / columns,
                  child: _DiscoveryActionCard(
                    key: ValueKey('community-${entry.key}'),
                    title: entry.value,
                    illustrated: true,
                    onTap: () => GoRouter.of(context).go(base.copyWith(category: entry.key).toLocation()),
                  ),
                ),
            ]);
          }),
          const SizedBox(height: HfSpacing.xxl),
          _SectionTitle(title: 'Services for you', onSeeAll: topics.isEmpty ? null : () => _allTopics(context)),
          const SizedBox(height: HfSpacing.lg),
          if (topics.isEmpty)
            const Text('Conversation topics are not available yet.')
          else LayoutBuilder(builder: (context, c) {
            final columns = MediaQuery.textScalerOf(context).scale(16) > 24 ? 1 : c.maxWidth >= 720 ? 3 : c.maxWidth >= 280 ? 2 : 1;
            return Wrap(spacing: HfSpacing.lg, runSpacing: HfSpacing.lg, children: [
              for (final topic in topics.take(6))
                SizedBox(
                  width: (c.maxWidth - (columns - 1) * HfSpacing.lg) / columns,
                  child: _DiscoveryActionCard(key: ValueKey('service-${topic.slug}'), title: topic.label, onTap: () => _topic(context, topic)),
                ),
            ]);
          }),
        ],
      ),
    );
  }
}

class _DiscoveryActionCard extends StatelessWidget {
  const _DiscoveryActionCard({super.key, required this.title, required this.onTap, this.illustrated = false});
  final String title;
  final VoidCallback onTap;
  final bool illustrated;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Material(
      color: dark ? HfColors.darkCard : HfColors.surfaceSoft,
      borderRadius: BorderRadius.circular(HfRadius.card),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (illustrated) SizedBox(
            height: 92,
            child: Image.asset('assets/images/community_services_card.png', fit: BoxFit.cover, excludeFromSemantics: true),
          ),
          Padding(
            padding: const EdgeInsets.all(HfSpacing.lg),
            child: Row(children: [
              Expanded(child: Text(title, style: HfText.of(context, HfText.label))),
              const SizedBox(width: HfSpacing.sm),
              const Icon(Icons.arrow_forward_rounded, size: 18),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title, this.onSeeAll});
  final String title;
  final VoidCallback? onSeeAll;

  @override
  Widget build(BuildContext context) => Row(children: [
    Expanded(child: Text(title, style: HfText.of(context, HfText.section))),
    if (onSeeAll != null) TextButton(key: ValueKey('see-all-$title'), onPressed: onSeeAll, child: const Text('See all')),
  ]);
}

class _ServerHostRail extends ConsumerWidget {
  const _ServerHostRail({required this.title, required this.filters, required this.from});
  final String title;
  final HostFilters filters;
  final String from;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final location = filters.toLocation();
    final page = ref.watch(marketplaceSectionProvider(location));
    return _HostRail(
      title: title,
      hosts: page.asData?.value.items ?? const [],
      from: from,
      lane: filters.lane,
      onSeeAll: () => GoRouter.of(context).go(location),
      empty: page.isLoading ? 'Loading conversations…'
          : page.hasError ? 'Could not load this section. Open See all to retry.'
          : filters.online ? 'No hosts are online right now.'
          : 'No published hosts in this section yet.',
    );
  }
}

class _HostRail extends StatelessWidget {
  const _HostRail({
    required this.title,
    required this.hosts,
    required this.from,
    required this.onSeeAll,
    required this.empty,
    this.lane,
  });

  final String title;
  final List<HostCard> hosts;
  final String from;
  final String? lane;
  final VoidCallback onSeeAll;
  final String empty;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: HfSpacing.xxl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: HfSpacing.pageWide,
            ),
            child: _SectionTitle(title: title, onSeeAll: onSeeAll),
          ),
          const SizedBox(height: HfSpacing.lg),
          if (hosts.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(horizontal: HfSpacing.pageWide), child: Text(empty, style: HfText.of(context, HfText.note)))
          else SizedBox(
            height: 360 + (MediaQuery.textScalerOf(context).scale(14) - 14).clamp(0, 80).toDouble() * 5,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(
                horizontal: HfSpacing.pageWide,
              ),
              itemCount: hosts.length,
              separatorBuilder: (_, __) =>
                  const SizedBox(width: HfSpacing.lg),
              itemBuilder: (context, index) => SizedBox(
                width: 182,
                child: MarketplaceHostTile(
                  host: hosts[index],
                  from: from,
                  lane: lane,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Showing saved list": the list on screen is an old copy.
class _SavedPill extends StatelessWidget {
  const _SavedPill();

  @override
  Widget build(BuildContext context) {
    const tint = HfTint.butter;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.sm,
        HfSpacing.pageWide,
        0,
      ),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          key: const ValueKey<String>('saved-pill'),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: tint.bg(context),
            borderRadius: BorderRadius.circular(HfRadius.segment),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.history_rounded, size: 18, color: tint.ink(context)),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  Strings.showingSavedList,
                  style: HfText.badge.copyWith(color: tint.ink(context)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Two host-card skeletons while the first page is on its way.
class _LoadingCards extends StatelessWidget {
  const _LoadingCards();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: Strings.loadingPeople,
      child: const Column(
        children: [
          HfSkeleton.hostCard(),
          SizedBox(height: 22),
          HfSkeleton.hostCard(),
        ],
      ),
    );
  }
}

/// The lane panels: sign in, or verify to join.
class _LanePanel extends StatelessWidget {
  const _LanePanel({
    required this.icon,
    required this.title,
    required this.body,
    required this.action,
  });

  final IconData icon;
  final String title;
  final String body;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 44,
              color: dark ? HfColors.lavenderLight : HfColors.link,
            ),
            const SizedBox(height: 12),
            Text(
              title,
              style: HfText.of(context, HfText.subsection),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              body,
              style: HfText.of(context, HfText.body),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            action,
          ],
        ),
      ),
    );
  }
}

/// Below the list: a spinner while the next page loads, "Try again" when it failed, the end note otherwise.
class _Footer extends StatelessWidget {
  const _Footer({required this.st, required this.onRetry});

  final ExploreState st;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final Widget child;
    if (st.loadMoreFailed) {
      child = Column(
        children: [
          Text(
            ExploreCopy.loadMoreFailed,
            style: HfText.of(context, HfText.body),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          HfButton(
            label: Strings.tryAgain,
            kind: HfButtonKind.secondary,
            onPressed: onRetry,
            expand: false,
          ),
        ],
      );
    } else if (st.loadingMore) {
      child = const Center(child: CircularProgressIndicator());
    } else if (st.hasMore) {
      // The next page starts loading as the person scrolls near the end.
      child = const SizedBox(height: 24);
    } else {
      child = Text(
        ExploreCopy.endOfList,
        style: HfText.of(context, HfText.note),
        textAlign: TextAlign.center,
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.page,
        20,
        HfSpacing.page,
        28,
      ),
      child: child,
    );
  }
}
