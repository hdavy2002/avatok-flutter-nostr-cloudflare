import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/explore_controller.dart';
import '../data/host_filters.dart';
import '../data/host_options.dart';
import '../widgets/host_card_view.dart';
import '../widgets/option_chip.dart';
import 'explore_copy.dart';
import 'filter_sheet.dart';

/// Tab 2: the marketplace. Filters live in the route query: `/explore?lane=&topics=&lang=&max=&online=`.
///
/// - Cached list at once, fresh list right after; pull to refresh; more pages as you scroll.
/// - Lane tabs: All / Women-only / LGBTQ+. A lane needs sign-in, and `403 lane_required` shows "Verify to join".
/// - A filter sheet (mood, language, price, online only, sort). Anyone can browse without signing in.
class ExploreScreen extends ConsumerStatefulWidget {
  const ExploreScreen({super.key, this.query = const <String, String>{}});

  /// The route's query parameters (lane, topics, lang, max, online).
  final Map<String, String> query;

  @override
  ConsumerState<ExploreScreen> createState() => _ExploreScreenState();
}

class _ExploreScreenState extends ConsumerState<ExploreScreen> {
  final ScrollController _scroll = ScrollController();

  ExploreController get _controller => ref.read(exploreControllerProvider.notifier);

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    final fromRoute = HostFilters.fromRouteQuery(widget.query);
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
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_controller.applyRoute(fromRoute));
      });
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
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
    if (_scroll.position.maxScrollExtent <= 0) unawaited(_controller.loadMore());
  }

  /// Applies filters and keeps the route in step, so `/explore?...` always describes what is on screen.
  void _apply(HostFilters f, FilterSource source) {
    unawaited(_controller.setFilters(f, source: source));
    GoRouter.of(context).go(f.toLocation());
  }

  Future<void> _openFilters(HostFilters current) async {
    final result = await showFilterSheet(context, current);
    if (result == null || !mounted) return;
    _apply(result, FilterSource.sheet);
  }

  Future<void> _signIn() async {
    final ok = await requireSignIn(context, ref);
    if (ok && mounted) unawaited(_controller.reload());
  }

  Future<void> _verify(String? lane) async {
    await GoRouter.of(context).push(Routes.lanesOf(lane));
    if (mounted) unawaited(_controller.reload());
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(exploreControllerProvider);
    final options = optionsOf(ref.watch(hostOptionsProvider));
    ref.listen<bool>(sessionProvider.select((s) => s.isSignedIn), (prev, next) {
      if (prev != next && ref.read(exploreControllerProvider).filters.lane != null) {
        unawaited(_controller.reload());
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _fillViewport());
    final f = st.filters;
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text(ExploreCopy.title),
        actions: [
          IconButton(
            key: const ValueKey<String>('open-filters'),
            tooltip: ExploreCopy.filters,
            iconSize: 28,
            onPressed: () => _openFilters(f),
            icon: Badge(
              isLabelVisible: f.activeCount > 0,
              label: Text('${f.activeCount}', style: HfText.badge.copyWith(color: HfColors.white)),
              backgroundColor: HfColors.rose,
              child: const Icon(Icons.tune_rounded),
            ),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: _controller.refresh,
          child: CustomScrollView(
            controller: _scroll,
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverToBoxAdapter(
                child: _LaneTabs(lane: f.lane, onChanged: (l) => _apply(f.copyWith(lane: l), FilterSource.lane)),
              ),
              if (st.status == ExploreStatus.ready && st.showSavedPill) const SliverToBoxAdapter(child: _SavedPill()),
              ..._body(st, options),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _body(ExploreState st, HostOptions? options) {
    Widget fill(Widget child) => SliverFillRemaining(hasScrollBody: false, child: child);
    final f = st.filters;
    switch (st.status) {
      case ExploreStatus.loading:
        return [fill(const LoadingPanel(message: Strings.loadingPeople))];
      case ExploreStatus.error:
        return [fill(ErrorPanel(error: st.error, onRetry: () => unawaited(_controller.refresh())))];
      case ExploreStatus.comingSoon:
        return [fill(const ComingSoonPanel())];
      case ExploreStatus.signInNeeded:
        return [
          fill(_LanePanel(
            icon: Icons.lock_outline_rounded,
            title: ExploreCopy.signInLaneTitle,
            body: ExploreCopy.signInLaneBody,
            action: HfButton(label: ExploreCopy.signIn, onPressed: _signIn),
          )),
        ];
      case ExploreStatus.laneRequired:
        return [
          fill(_LanePanel(
            icon: Icons.verified_user_outlined,
            title: ExploreCopy.verifyTitle,
            body: ExploreCopy.verifyBody,
            action: HfButton(label: ExploreCopy.verifyButton, onPressed: () => _verify(f.lane)),
          )),
        ];
      case ExploreStatus.ready:
        if (st.items.isEmpty) {
          final narrowed = f.activeCount > 0;
          return [
            fill(narrowed
                ? EmptyPanel(
                    message: ExploreCopy.emptyFiltered,
                    actionLabel: ExploreCopy.clearFilters,
                    onAction: () => _apply(HostFilters.none.copyWith(lane: f.lane), FilterSource.clear),
                  )
                : const EmptyPanel(message: ExploreCopy.emptyAll)),
          ];
        }
        return _list(st, options);
    }
  }

  List<Widget> _list(ExploreState st, HostOptions? options) {
    final labels = options?.topicLabels ?? const <String, String>{};
    final shown = st.total > st.items.length ? st.total : st.items.length;
    return [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(HfSpacing.page, 4, HfSpacing.page, 8),
          child: Text(ExploreCopy.peopleCount(shown), style: HfText.label),
        ),
      ),
      SliverPadding(
        padding: const EdgeInsets.symmetric(horizontal: HfSpacing.page),
        sliver: SliverLayoutBuilder(builder: (context, c) {
          // Full width on a phone; two columns once the screen is wide (tablet, foldable).
          final columns = c.crossAxisExtent >= 720 ? 2 : 1;
          final rows = (st.items.length / columns).ceil();
          return SliverList.separated(
            itemCount: rows,
            separatorBuilder: (_, __) => const SizedBox(height: HfSpacing.gap),
            itemBuilder: (context, row) {
              Widget cardAt(int idx) => idx < st.items.length
                  ? HostCardView(host: st.items[idx], topicLabels: labels, from: 'explore')
                  : const SizedBox.shrink();
              if (columns == 1) return cardAt(row);
              final cells = <Widget>[];
              for (var i = 0; i < columns; i++) {
                cells.add(Expanded(child: cardAt(row * columns + i)));
                if (i < columns - 1) cells.add(const SizedBox(width: HfSpacing.gap));
              }
              return IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: cells));
            },
          );
        }),
      ),
      SliverToBoxAdapter(child: _Footer(st: st, onRetry: () => unawaited(_controller.loadMore(retry: true)))),
    ];
  }
}

/// All / Women-only / LGBTQ+.
class _LaneTabs extends StatelessWidget {
  const _LaneTabs({required this.lane, required this.onChanged});

  final String? lane;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: HfSpacing.page, vertical: 8),
      child: Row(
        children: [
          OptionChip(label: ExploreCopy.laneAll, selected: lane == null, onTap: () => onChanged(null)),
          const SizedBox(width: 8),
          OptionChip(
              label: ExploreCopy.laneWomen, selected: lane == HostLane.women, onTap: () => onChanged(HostLane.women)),
          const SizedBox(width: 8),
          OptionChip(
              label: ExploreCopy.laneLgbtq, selected: lane == HostLane.lgbtq, onTap: () => onChanged(HostLane.lgbtq)),
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
    return Padding(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 0, HfSpacing.page, 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          key: const ValueKey<String>('saved-pill'),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: HfColors.butter,
            borderRadius: BorderRadius.circular(HfRadius.pill),
            border: Border.all(color: HfColors.butterDeep),
          ),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.history_rounded, size: 18, color: HfColors.plum),
              SizedBox(width: 6),
              Text(Strings.showingSavedList, style: HfText.badge),
            ],
          ),
        ),
      ),
    );
  }
}

/// The lane panels: sign in, or verify to join.
class _LanePanel extends StatelessWidget {
  const _LanePanel({required this.icon, required this.title, required this.body, required this.action});

  final IconData icon;
  final String title;
  final String body;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 44, color: HfColors.orchid),
            const SizedBox(height: 12),
            Text(title, style: HfText.subtitle, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(body, style: HfText.bodyText, textAlign: TextAlign.center),
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
          const Text(ExploreCopy.loadMoreFailed, style: HfText.bodyText, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          HfButton(label: Strings.tryAgain, kind: HfButtonKind.secondary, onPressed: onRetry, expand: false),
        ],
      );
    } else if (st.loadingMore) {
      child = const Center(child: CircularProgressIndicator());
    } else if (st.hasMore) {
      // The next page starts loading as the person scrolls near the end.
      child = const SizedBox(height: 24);
    } else {
      child = const Text(ExploreCopy.endOfList, style: HfText.note, textAlign: TextAlign.center);
    }
    return Padding(padding: const EdgeInsets.fromLTRB(HfSpacing.page, 20, HfSpacing.page, 28), child: child);
  }
}
