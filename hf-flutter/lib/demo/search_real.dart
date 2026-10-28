import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/brand.dart';
import '../data/api_exception.dart';
import '../data/models/reel.dart';
import '../data/models/search.dart';
import '../data/models/search_filters.dart'; // [HF-SEARCH-FILTERS-1]
import '../data/repos/search_repo.dart';
import '../data/telemetry.dart'; // [HF-CREATOR-SPACES-1]
import '../ui/async_view.dart';
import 'reels_real.dart';
import 'theme.dart';
import 'widgets.dart';
import 'desi.dart';
import 'search_filter_sheet.dart'; // [HF-SEARCH-FILTERS-1]
import 'search_intro_card.dart'; // [HF-SEARCH-FILTERS-1]
import 'search_kit.dart';
import 'space_kit.dart'; // [HF-CREATOR-SPACES-1]

/// The real Search screen (HF-WIRE-9): `GET /api/hf/search` debounced 350 ms, results Online then Offline,
/// "Most-wanted, not here yet" with INVITE votes, and topic chips from `GET /api/hf/options`.
class RealSearch extends StatefulWidget {
  const RealSearch({super.key, required this.repo, this.debounce = const Duration(milliseconds: 350)});

  final SearchRepo repo;
  final Duration debounce;

  @override
  State<RealSearch> createState() => _RealSearchState();
}

class _RealSearchState extends State<RealSearch> {
  final _q = TextEditingController();
  Timer? _timer;
  int _run = 0;
  String? _topic;
  String _platform = 'all'; // [HF-WIRE-22] HF-REEL-41: all | youtube | instagram
  String? _space; // [HF-CREATOR-SPACES-1] null | women ([HF-SEARCH-FILTERS-1] the LGBTQ+ and Video KYC filters are gone)
  // [HF-SEARCH-FILTERS-1] While the server lists only approved intro influencers (`intro: true`), the filters below replace the platform / space pills and topic chips.
  // _intro is null until the first answer is in (no filter row is drawn until then), false for an older server (the old screen).
  bool? _intro;
  SearchFilters _filters = const SearchFilters();
  List<FilterOption> _categories = const [];
  List<FilterOption> _languages = const [];
  bool _optionsAsked = false;
  bool _loadingMore = false;
  AsyncState<SearchResult> _state = const AsyncLoading();
  List<TopicOption> _topics = const [];
  List<MissingCreator> _top = const [];
  final Set<String> _voted = {};
  final Map<String, int> _votes = {};

  bool get _browsing => _q.text.trim().isEmpty && _topic == null && _space == null && _filters.isDefault;

  @override
  void initState() {
    super.initState();
    unawaited(_loadHome());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _loadHome() async {
    // [HF-APP-CACHE-1] saved chips / invite list first, then the server's
    unawaited(() async {
      try {
        await for (final t in widget.repo.watchTopics()) {
          if (mounted) setState(() => _topics = t);
        }
      } catch (_) {}
    }());
    unawaited(() async {
      try {
        await for (final t in widget.repo.watchTopInvites()) {
          if (mounted) setState(() => _top = t);
        }
      } catch (_) {}
    }());
    await _search();
  }

  void _onChanged(String _) {
    setState(() {});
    _timer?.cancel();
    _timer = Timer(widget.debounce, () => unawaited(_search()));
  }

  Future<void> _search() async {
    final run = ++_run;
    setState(() => _state = const AsyncLoading());
    AsyncState<SearchResult> next;
    try {
      // [HF-APP-CACHE-1] the same search seen before paints at once, then the server's answer replaces it
      await for (final r in widget.repo.watchSearch(_q.text, topic: _topic, platform: _platform, space: _space, filters: _intro == false ? null : _filters)) {
        if (!mounted || run != _run) return;
        setState(() {
          _intro = r.intro;
          _state = AsyncData(r);
        });
        if (r.intro) _askOptions();
      }
      return;
    } catch (e) {
      next = AsyncFailure(e);
    }
    if (!mounted || run != _run) return; // a newer search is on its way
    setState(() => _state = next);
  }

  /// [HF-SEARCH-FILTERS-1] The category catalogue and the language list for the filter sheet, asked once, after the first intro answer.
  void _askOptions() {
    if (_optionsAsked) return;
    _optionsAsked = true;
    unawaited(() async {
      try {
        await for (final c in widget.repo.watchCategories()) {
          if (mounted) setState(() => _categories = c);
        }
      } catch (_) {}
    }());
    unawaited(() async {
      try {
        await for (final l in widget.repo.watchLanguages()) {
          if (mounted) setState(() => _languages = l);
        }
      } catch (_) {}
    }());
  }

  void _applyFilters(SearchFilters f) {
    _timer?.cancel();
    setState(() => _filters = f);
    Telemetry.event('hf_search_filter', {'active': f.activeCount, 'sort': f.sort, 'surface': 'app_search'});
    unawaited(_search());
  }

  Future<void> _openFilters() async {
    final f = await showSearchFilterSheet(context, current: _filters, categories: _categories, languages: _languages);
    if (f != null && mounted) _applyFilters(f);
  }

  /// "Show more": the next page of the same search, appended.
  Future<void> _loadMore(SearchResult cur) async {
    final off = cur.nextOffset;
    if (off == null || _loadingMore) return;
    final run = _run;
    setState(() => _loadingMore = true);
    try {
      final more = await widget.repo.search(_q.text, filters: _filters, offset: off);
      if (!mounted || run != _run) return;
      setState(() => _state = AsyncData(cur.withMore(more)));
    } catch (_) {
      if (mounted) toast(context, ApiException.genericText);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  List<Widget> _topicBlock() => [
        if (_topics.isNotEmpty) ...[
          SearchTopics(
            topics: [for (final topic in _topics.take(16)) (topic.slug, topic.label)],
            selected: _topic,
            keyFor: (slug) => ValueKey('topic-$slug'),
            onTap: _pickTopic,
          ),
          const SizedBox(height: 14),
        ],
      ];

  void _pickTopic(String? slug) {
    _timer?.cancel();
    setState(() => _topic = _topic == slug ? null : slug);
    unawaited(_search());
  }

  void _pickPlatform(String p) {
    if (_platform == p) return;
    _timer?.cancel();
    setState(() => _platform = p);
    unawaited(_search());
  }

  /// All / YouTube / Instagram, Rang Bazaar style: chunky outlined pills, the chosen one marigold. Text is 15 sp.
  Widget _platformFilter() {
    const options = [('all', 'All'), ('youtube', 'YouTube'), ('instagram', 'Instagram')];
    return Row(
      key: const ValueKey('platform-filter'),
      children: [
        for (final o in options)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Semantics(
                button: true,
                selected: _platform == o.$1,
                label: 'Show ${o.$2}',
                child: InkWell(
                  key: ValueKey('platform-${o.$1}'),
                  borderRadius: BorderRadius.circular(999),
                  onTap: () => _pickPlatform(o.$1),
                  child: Container(
                    height: 48,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _platform == o.$1 ? C.maroon : C.white,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: _platform == o.$1 ? C.maroon : C.line, width: 1.5),
                    ),
                    child: Text(o.$2, style: t(15, color: _platform == o.$1 ? C.white : C.maroon, w: FontWeight.w800)),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  /// [HF-CREATOR-SPACES-1] Women-only / LGBTQ+ channel filter. Tap the chosen one again to clear it.
  void _pickSpace(String space) {
    _timer?.cancel();
    final next = _space == space ? null : space;
    setState(() => _space = next);
    if (next != null) Telemetry.event('hf_space_filter', {'space': next, 'surface': 'app_search'});
    unawaited(_search());
  }

  Widget _spaceFilter() {
    const options = [('women', 'Women-only')];
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        key: const ValueKey('space-filter'),
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final o in options)
            Semantics(
              button: true,
              selected: _space == o.$1,
              label: 'Show ${o.$2} creators',
              child: InkWell(
                key: ValueKey('space-${o.$1}'),
                borderRadius: BorderRadius.circular(999),
                onTap: () => _pickSpace(o.$1),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
                  decoration: BoxDecoration(
                    color: _space == o.$1 ? C.rani : C.white,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: _space == o.$1 ? C.rani : C.line, width: 1.5),
                  ),
                  child: Text(o.$2, style: t(15, color: _space == o.$1 ? C.white : C.rani, w: FontWeight.w800)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// A small platform mark next to a result.
  Widget _platformIcon(String platform) {
    final yt = platform == 'youtube';
    return Icon(yt ? Icons.smart_display_rounded : Icons.camera_alt_rounded, key: ValueKey('plat-icon-$platform'), size: 16, color: yt ? C.rani : C.maroon, semanticLabel: yt ? 'YouTube' : 'Instagram');
  }

  Future<void> _vote(MissingCreator c) async {
    try {
      final total = await widget.repo.vote(c);
      if (!mounted) return;
      setState(() {
        _voted.add(c.key);
        _votes[c.key] = total;
      });
      toast(context, 'Voted! We will ask ${c.handle} to join.');
    } on ApiException catch (e) {
      if (mounted) toast(context, e.userMessage);
    } catch (_) {
      if (mounted) toast(context, ApiException.genericText);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.text.trim();
    // [HF-APP-DESI-2] Layout from the owner-approved canvas preview "2 · Search".
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            SearchHeader(
              field: SearchPill(
                fieldKey: const ValueKey('search-field'),
                controller: _q,
                onChanged: _onChanged,
                onSubmitted: (_) {
                  _timer?.cancel();
                  unawaited(_search());
                },
                onClear: q.isEmpty
                    ? null
                    : () {
                        _q.clear();
                        _onChanged('');
                      },
              ),
            ),
            if (_intro == false) ...[_platformFilter(), _spaceFilter()],
            if (_intro == true)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: SearchFilterBar(filters: _filters, categories: _categories, languages: _languages, onOpen: () => unawaited(_openFilters()), onChanged: _applyFilters),
              ),
            const SizedBox(height: 14),
            // [HF-SEARCH-RESULTS-FIRST-1] While a search or filter is on, results sit right under the
            // filters and the topic list moves below them, so nobody has to scroll past 16 chips to see them.
            if (_intro == false && _browsing) ..._topicBlock(),
            AsyncView<SearchResult>(
              state: _state,
              onRetry: () => unawaited(_search()),
              isEmpty: (r) => r.intro ? r.isEmpty : (!_browsing && r.isEmpty),
              emptyTitle: 'No one found',
              emptyMessage: _intro == true ? 'Try fewer filters, or another name, category or language.' : 'Try another name, or type their @handle to ask them to join.',
              builder: (context, r) => r.intro ? _introResults(context, r) : (_browsing ? _home(context, r) : _results(context, r)),
            ),
            if (_intro == false && !_browsing) ...[const SizedBox(height: 14), ..._topicBlock()],
          ],
        ),
      ),
    );
  }

  /// [HF-SEARCH-FILTERS-1] Approved influencers only (offline ones too), already filtered and sorted by the server.
  Widget _introResults(BuildContext context, SearchResult r) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Text('${r.total} ${r.total == 1 ? 'influencer' : 'influencers'}', key: const ValueKey('intro-count'), style: t(14, color: C.muted, w: FontWeight.w700)),
        ),
        for (final it in r.items) SearchIntroCard(reel: it, onTap: () => context.push('/profile/${it.host.slug}')),
        if (r.nextOffset != null)
          Center(
            child: OutlinedButton(
              key: const ValueKey('search-more'),
              onPressed: _loadingMore ? null : () => unawaited(_loadMore(r)),
              child: Text(_loadingMore ? 'Loading...' : 'Show more', style: t(15, color: C.maroon, w: FontWeight.w800)),
            ),
          ),
        if (r.notOnNetwork.isNotEmpty) ...[
          const SizedBox(height: 14),
          MostWantedCard(title: 'Not on ${Brand.name} yet', rows: [for (var k = 0; k < r.notOnNetwork.length; k++) _missingRow(r.notOnNetwork[k], k + 1)]),
        ],
      ],
    );
  }

  /// Nothing typed: who is online, who you can book, and who fans want most.
  Widget _home(BuildContext context, SearchResult r) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OnlineNowCard(
          listKey: const ValueKey('online-row'),
          people: [for (final h in r.online) (influencerFromHost(h), () => context.push('/profile/${h.slug}'))],
        ),
        if (r.offline.isNotEmpty) ...[
          const SizedBox(height: 14),
          BookTimeCard(rows: [for (var k = 0; k < r.offline.length; k++) _hitRow(context, r.offline[k], last: k == r.offline.length - 1)]),
        ],
        if (_top.isNotEmpty) ...[
          const SizedBox(height: 14),
          MostWantedCard(rows: [for (var k = 0; k < _top.length; k++) _missingRow(_top[k], k + 1)]),
        ],
        const DesiMogra(),
      ],
    );
  }

  /// Something typed (or a topic picked): Online first, then Offline, then people who are not on the app.
  Widget _results(BuildContext context, SearchResult r) {
    Widget group(String title, List<ReelHost> hosts, DesiCorner corner, DesiTone tone) => Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: DesiCard(
            title: title,
            tone: tone,
            corner: corner,
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
            child: Column(children: [for (var k = 0; k < hosts.length; k++) _hitRow(context, hosts[k], last: k == hosts.length - 1)]),
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (r.online.isNotEmpty) group('Online', r.online, DesiCorner.hibiscus, DesiTone.rani),
        if (r.offline.isNotEmpty) group('Offline', r.offline, DesiCorner.marigold, DesiTone.white),
        if (r.notOnNetwork.isNotEmpty)
          MostWantedCard(title: 'Not on ${Brand.name} yet', rows: [for (var k = 0; k < r.notOnNetwork.length; k++) _missingRow(r.notOnNetwork[k], k + 1)]),
      ],
    );
  }

  Widget _hitRow(BuildContext context, ReelHost h, {bool last = false}) {
    return SearchPersonRow(
      key: ValueKey('hit-${h.slug}'),
      who: influencerFromHost(h),
      online: h.online,
      rate: h.rateRupees,
      last: last,
      subtitle: Row(children: [
        SpaceBadges(space: h.space, videoKycVerified: false, channelVerified: false, kycCallersOnly: h.kycCallersOnly, surface: 'app_search', compact: true), // [HF-VERIFIED-BLIP-1] the tick now sits beside the name
        for (final p in h.platforms) Padding(padding: const EdgeInsets.only(right: 4), child: _platformIcon(p)),
        Flexible(child: Text(h.handle ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w600))),
      ]),
      onTap: () => context.push('/profile/${h.slug}'),
    );
  }

  Widget _missingRow(MissingCreator c, int rank) {
    final voted = _voted.contains(c.key);
    final votes = _votes[c.key] ?? c.votes;
    return MostWantedRow(
      key: ValueKey('missing-${c.key}'),
      rank: rank,
      handle: c.handle,
      votes: votes,
      caption: _browsing ? null : 'Not on ${Brand.name} · $votes votes',
      voted: voted,
      platformIcon: _platformIcon(c.platform),
      onInvite: () => requireAccount(context, () => unawaited(_vote(c)), reason: 'to vote'),
    );
  }
}
