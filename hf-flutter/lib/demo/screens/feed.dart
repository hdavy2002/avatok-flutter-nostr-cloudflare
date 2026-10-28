import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/unplayable_reels.dart';
import '../../data/feed_order.dart'; // [HF-REELS-FRESH-OPEN-1]
import '../../data/reel_bookmarks.dart';
import '../../data/reel_engage_store.dart'; // [HF-REEL-ENGAGE-APP-1]
import '../../data/repos/reel_engage_repo.dart';
import '../../data/api_exception.dart';
import '../../data/models/reel.dart';
import '../../data/models/search.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/repos/search_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../data/share.dart';
import '../../ui/async_view.dart';
import '../data.dart';
import '../intro_reel_overlay.dart'; // [HF-INTRO-A2]
import '../presence_bridge.dart';
import '../queue_kit.dart'; // [HF-CALL-MODES-E2]
import '../space_kit.dart' show womenGateThen; // [HF-INTRO-A2]
import 'sheets.dart' show startCall; // [HF-INTRO-A2]
import '../reel_player.dart';
import '../reels_real.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'creator_page.dart';
import 'original_post_page.dart'; // [HF-REEL-RAW-APP-1]
import 'reel_comments_sheet.dart';

/// Reels feed: full-screen cards, swipe up/down. Presence controls instant calls; offline creators can still be booked.
/// Demo mode keeps the dummy reels; real mode (HF-WIRE-4) pages `GET /api/hf/reels`. [reelId] opens a shared reel first.
class FeedScreen extends StatelessWidget {
  const FeedScreen({
    super.key,
    this.reelId,
    this.repo,
    this.onlineFetch,
    this.searchRepo,
  });

  final String? reelId;

  /// Tests pass a repo for the INVITE vote on invite reels (HF-REEL-40).
  final SearchRepo? searchRepo;

  /// Tests pass a repo on a fake API; the app uses [Services].
  final ReelsRepo? repo;

  /// Tests replace the online-count call.
  final Future<int> Function()? onlineFetch;

  @override
  Widget build(BuildContext context) => PresenceBridge.real
      ? RealFeed(
          reelId: reelId,
          repo: repo ?? Services.instance.reelsRepo,
          onlineFetch: onlineFetch,
          searchRepo: searchRepo,
        )
      : const _DemoFeed();
}

/// The empty-feed text (owner copy).
const String kFeedEmptyText = 'No reels yet. Check back soon.';

/// The real feed: a vertical pager over the server's pages. Plays the visible reel, pauses the others, readies the next.
class RealFeed extends StatefulWidget {
  const RealFeed({
    super.key,
    required this.repo,
    this.reelId,
    this.onlineFetch,
    this.searchRepo,
    this.initialReel,
  });

  final FeedReel? initialReel;
  final ReelsRepo repo;
  final SearchRepo? searchRepo;
  final String? reelId;
  final Future<int> Function()? onlineFetch;

  @override
  State<RealFeed> createState() => _RealFeedState();
}

class _RealFeedState extends State<RealFeed> with WidgetsBindingObserver {
  final _pager = PageController();
  DateTime? _backgroundAt; // [HF-REELS-FRESH-OPEN-1]

  /// [HF-REELS-FRESH-OPEN-1] Opening the app again after a while (it was only in the background) also starts on a new video.
  static const Duration freshAfter = Duration(minutes: 10);

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.paused) {
      _backgroundAt = DateTime.now();
    } else if (s == AppLifecycleState.resumed) {
      final away = _backgroundAt;
      _backgroundAt = null;
      if (away != null && widget.reelId == null && DateTime.now().difference(away) >= freshAfter && mounted) {
        if (_pager.hasClients) {
          _ownJump = true;
          _pager.jumpToPage(0);
          _ownJump = false;
        }
        unawaited(_first());
      }
    }
  }
  final List<FeedReel> _items = [];
  final Set<String> _counted = {};
  AsyncState<List<FeedReel>> _state = const AsyncLoading();
  String? _cursor;
  bool _more = false;
  bool _loadingMore = false;
  int _index = 0;

  void _onGate() {
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this); // [HF-REELS-FRESH-OPEN-1]
    ReelGate.visible.addListener(
      _onGate,
    ); // [HF-BOOK-APPROVE-POLISH] pause when the feed is not on screen
    // [HF-REEL-SKIP-1] the list of reels that cannot play here loads alongside the feed; any that arrived first leave
    unawaited(
      UnplayableReels.load().then((_) {
        if (!mounted) return;
        for (final r in List.of(_items)) {
          if (UnplayableReels.contains(r.id) && _items.indexOf(r) != _index) {
            _dropUnplayable(r.id);
          }
        }
      }),
    );
    unawaited(_first());
  }

  @override
  void didUpdateWidget(covariant RealFeed oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.reelId != oldWidget.reelId) {
      if (_pager.hasClients) {
        _ownJump = true;
        _pager.jumpToPage(0);
        _ownJump = false;
      }
      unawaited(_first());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this); // [HF-REELS-FRESH-OPEN-1]
    ReelGate.visible.removeListener(_onGate);
    _pager.dispose();
    super.dispose();
  }

  /// [HF-REELS-LOOP-1] Loop round of each item in [_items] (0 = first pass). The same reel can come back in a later round,
  /// so a page's key is id + round.
  final List<int> _loops = [];
  int _round = 0;
  int _loopOf(int i) => i < _loops.length ? _loops[i] : 0;
  static String _creatorOf(FeedReel r) => r.invite?.key ?? 'hf:${r.host.slug}';

  void _setItems(List<FeedReel> list) {
    _items
      ..clear()
      ..addAll(list);
    _loops
      ..clear()
      ..addAll(List.filled(list.length, 0));
    _round = 0;
  }

  void _append(Iterable<FeedReel> list, int round) {
    for (final r in list) {
      _items.add(r);
      _loops.add(round);
    }
  }

  void _show(ReelsPage page, FeedReel? shared, List<FeedReel> firstPage) {
    _setItems([if (shared != null) shared, ...firstPage]);
    _cursor = page.nextCursor;
    _more = page.nextCursor != null;
    _index = 0;
    if (_items.isNotEmpty && !_items.first.isInvite && _counted.add(_items.first.id)) unawaited(widget.repo.view(_items.first.id));
    setState(() => _state = AsyncData(List.of(_items)));
  }

  /// [HF-REEL-CALL-2] Bumped by every [_first]; a slower earlier load that finds a newer one running stops instead of
  /// overwriting it (a deep link arriving while the cached feed was still loading).
  int _gen = 0;

  Future<void> _first() async {
    final gen = ++_gen;
    final sharedId = widget.reelId;
    if (sharedId != null && await _openShared(sharedId, gen)) return;
    if (!mounted || gen != _gen) return;
    if (_items.isEmpty) setState(() => _state = const AsyncLoading());
    // [HF-REELS-FAST-START-1] With no shared reel, show the last stored first page at once (shuffled, new first video),
    // then swap in the fresh page in the background without moving the reel on screen.
    if (FeedOrder.enabled && widget.reelId == null && widget.initialReel == null) {
      final cached = await widget.repo.cachedFirstPage();
      if (!mounted || gen != _gen) return;
      final firstPage = (cached?.items ?? const <FeedReel>[]).where((r) => !UnplayableReels.contains(r.id)).toList();
      if (firstPage.isNotEmpty) {
        await FeedOrder.freshStart<FeedReel>(firstPage, (r) => r.id);
        if (!mounted || gen != _gen) return;
        _show(cached!, null, firstPage);
        unawaited(_refreshFirst(gen));
        return;
      }
    }
    try {
      final page = await widget.repo.feed();
      if (!mounted || gen != _gen) return;
      final shared = widget.initialReel;
      final firstPage = page.items.where((r) => r.id != shared?.id && !UnplayableReels.contains(r.id)).toList();
      // [HF-REELS-FRESH-OPEN-1] a new first video on every open (a shared reel still plays first).
      if (shared == null) await FeedOrder.freshStart<FeedReel>(firstPage, (r) => r.id);
      if (!mounted || gen != _gen) return;
      _show(page, shared, firstPage);
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _state = AsyncFailure(e));
    }
  }

  /// [HF-REEL-CALL-2] A shared reel (`/r/<id>`, `/reels?reel=<id>`): THAT reel is item 0 straight away and plays alone; the
  /// normal feed loads behind it and is attached after it. Nothing from an earlier or cached feed is ever on screen first
  /// (that was the "another video plays, then it jumps" bug: the old first item kept playing while the link loaded).
  /// Returns true when it took over the screen (including when a newer load superseded it), false when the reel is gone
  /// so the caller falls back to the ordinary feed.
  Future<bool> _openShared(String id, int gen) async {
    FeedReel? shared = widget.initialReel;
    if (shared != null && shared.id != id) shared = null;
    if (shared == null) {
      for (final r in _items) {
        if (r.id == id) {
          shared = r;
          break;
        }
      }
    }
    if (shared == null) {
      // not held yet: stop whatever the old feed was playing and wait on the poster, never on another video
      setState(() {
        _items.clear();
        _loops.clear();
        _index = 0;
        _state = const AsyncLoading();
      });
      final stored = FeedOrder.enabled ? await widget.repo.cachedFirstPage() : null; // widget tests keep to the fake API
      if (!mounted || gen != _gen) return true;
      for (final r in stored?.items ?? const <FeedReel>[]) {
        if (r.id == id) {
          shared = r;
          break;
        }
      }
    }
    if (widget.initialReel == null) Telemetry.event('reel_deeplink_open', {'reel_id': id, 'cached': shared != null});
    if (shared == null) {
      try {
        shared = await widget.repo.one(id);
      } catch (_) {
        shared = null;
      }
      if (!mounted || gen != _gen) return true;
    }
    final head = shared;
    if (head == null) return false;
    _setItems([head]);
    _cursor = null;
    _more = true; // the feed behind it is still to come; a swipe near the end asks again if it failed
    _index = 0;
    if (!head.isInvite && _counted.add(head.id)) unawaited(widget.repo.view(head.id));
    setState(() => _state = AsyncData(List.of(_items)));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_pager.hasClients) return;
      _ownJump = true;
      _pager.jumpToPage(0);
      _ownJump = false;
    });
    unawaited(_attachFeed(gen));
    return true;
  }

  /// [HF-REEL-CALL-2] The normal feed, added after the shared reel without moving it.
  Future<void> _attachFeed(int gen) async {
    try {
      final page = await widget.repo.feed();
      if (!mounted || gen != _gen) return;
      final have = _items.map((r) => r.id).toSet();
      _append(page.items.where((r) => !have.contains(r.id) && !UnplayableReels.contains(r.id)), 0);
      _cursor = page.nextCursor;
      _more = page.nextCursor != null;
      setState(() => _state = AsyncData(List.of(_items)));
    } catch (_) {
      // the shared reel plays on its own; swiping near the end asks for the feed again
    }
  }

  /// [HF-REELS-FAST-START-1] The fresh first page after a cached start: keep what is on screen, add reels it did not have,
  /// and continue paging from the fresh cursor.
  Future<void> _refreshFirst(int gen) async {
    try {
      final page = await widget.repo.feed();
      if (!mounted || gen != _gen) return;
      final have = _items.map((r) => r.id).toSet();
      _append(page.items.where((r) => !have.contains(r.id) && !UnplayableReels.contains(r.id)), 0);
      _cursor = page.nextCursor;
      _more = page.nextCursor != null;
      setState(() => _state = AsyncData(List.of(_items)));
    } catch (_) {
      // offline: keep the stored reels; the end of the list loops them
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore) return;
    if (!_more) {
      _loopAgain();
      return;
    }
    _loadingMore = true;
    try {
      final page = await widget.repo.feed(cursor: _cursor);
      if (!mounted) return;
      final have = _items.map((r) => r.id).toSet();
      _append(page.items.where((r) => !have.contains(r.id) && !UnplayableReels.contains(r.id)), _round);
      _cursor = page.nextCursor;
      _more = page.nextCursor != null;
      setState(() => _state = AsyncData(List.of(_items)));
      if (!_more && _items.length - _index < 4) _loopAgain();
    } catch (_) {
      // keep what is on screen; the next swipe tries again
    } finally {
      _loadingMore = false;
    }
  }

  /// [HF-REELS-LOOP-1] Owner: at the end, play them again, one video per creator at a time, shuffled. Every reel seen so
  /// far is dealt round-robin across creators (each creator's reels shuffled, creator order shuffled) and added again.
  void _loopAgain() {
    if (!FeedOrder.enabled || !mounted || _items.length < 2) return; // widget tests keep a fixed-length feed
    if (_index < _items.length - 4) return;
    final seen = <String>{};
    final byCreator = <String, List<FeedReel>>{};
    for (final r in _items) {
      if (UnplayableReels.contains(r.id) || !seen.add(r.id)) continue;
      byCreator.putIfAbsent(_creatorOf(r), () => []).add(r);
    }
    if (seen.length < 2) return;
    final groups = byCreator.values.map((g) => g..shuffle()).toList()..shuffle();
    final next = <FeedReel>[];
    for (var k = 0; groups.any((g) => k < g.length); k++) {
      for (final g in groups) {
        if (k < g.length) next.add(g[k]);
      }
    }
    if (next.length > 1 && next.first.id == _items[_index].id) next.add(next.removeAt(0));
    _round++;
    _append(next, _round);
    setState(() => _state = AsyncData(List.of(_items)));
  }

  /// [HF-REELS-FAV-1] The reels of an invite creator that this feed already holds (for the creator page).
  List<FeedReel> _reelsOfCreator(FeedReel r) {
    final seen = <String>{};
    return [
      for (final x in _items)
        if (x.invite != null && x.invite!.key == r.invite?.key && seen.add(x.id)) x,
    ];
  }

  /// [HF-REEL-CLEAN-1] The feed only moves when a finger moves it (owner 2026-10-22: "no auto scroll"). A page change
  /// that no drag started (e.g. a player grabbing focus and the list scrolling to it) is undone. Screen-reader users
  /// scroll without dragging, so the guard is off for them.
  bool _fingerScroll = false;
  bool _ownJump = false;

  bool _onScroll(ScrollNotification n) {
    if (n is ScrollStartNotification) {
      _fingerScroll = n.dragDetails != null;
    } else if (n is ScrollEndNotification) {
      _fingerScroll = false;
    }
    return false;
  }

  /// [HF-REEL-SKIP-1] A reel that turned out not to play inside the app leaves the feed (usually while it is still the
  /// warmed next reel, so the viewer never sees it). The reel on screen stays on screen.
  void _dropUnplayable(String id) {
    if (!mounted) return;
    var shift = 0;
    var removed = false;
    setState(() {
      for (var i = _items.length - 1; i >= 0; i--) {
        if (_items[i].id != id || i == _index) continue;
        _items.removeAt(i);
        if (i < _loops.length) _loops.removeAt(i);
        removed = true;
        if (i < _index) shift++;
      }
      _index -= shift;
      if (_index >= _items.length) _index = _items.isEmpty ? 0 : _items.length - 1;
      _state = AsyncData(List.of(_items));
    });
    if (!removed) return;
    if (shift > 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_pager.hasClients) return;
        _ownJump = true;
        _pager.jumpToPage(_index);
        _ownJump = false;
      });
    }
    if (_items.length - _index < 4) unawaited(_loadMore());
  }

  void _onPage(int i) {
    if (!_fingerScroll &&
        !_ownJump &&
        !MediaQuery.of(context).accessibleNavigation) {
      final back = _index;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_pager.hasClients) return;
        _ownJump = true;
        _pager.jumpToPage(back);
        _ownJump = false;
      });
      return;
    }
    setState(() => _index = i);
    if (i >= _items.length - 3) unawaited(_loadMore());
    if (i < _items.length && !_items[i].isInvite && _counted.add(_items[i].id))
      unawaited(
        widget.repo.view(_items[i].id),
      ); // invite reels are not ours to count
  }

  @override
  Widget build(BuildContext context) {
    final s = _state;
    final data = s is AsyncData<List<FeedReel>> && s.value.isNotEmpty;
    if (!data) {
      return Scaffold(
        backgroundColor: C.cream,
        body: SafeArea(
          child: AsyncView<List<FeedReel>>(
            state: s,
            onRetry: () => unawaited(_first()),
            emptyTitle: 'Nothing to watch yet',
            emptyMessage: kFeedEmptyText,
            loadingLabel: 'Finding reels…',
            builder: (_, __) => const SizedBox.shrink(),
          ),
        ),
      );
    }
    final items = s.value;
    return Scaffold(
      backgroundColor: C.cinema,
      body: Stack(
        children: [
          NotificationListener<ScrollNotification>(
            onNotification: _onScroll,
            child: PageView.builder(
              controller: _pager,
              scrollDirection: Axis.vertical,
              itemCount: items.length,
              onPageChanged: _onPage,
              allowImplicitScrolling:
                  true, // builds the next page early so its video is ready
              itemBuilder: (_, i) => ReelPage(
                key: ValueKey('${items[i].id}~${_loopOf(i)}'), // [HF-REELS-LOOP-1]
                reel: demoReelFrom(items[i]),
                real: items[i],
                active: i == _index && ReelGate.visible.value,
                preload: i == _index + 1,
                keepAlive: (i - _index).abs() <= 1,
                onUnplayable: (reason) {
                  _dropUnplayable(items[i].id);
                  // [HF-REEL-SKIP-2] so the server can hide it for everyone
                  unawaited(widget.repo.reportUnplayable(items[i].id, reason));
                },
                searchRepo: widget.searchRepo,
                creatorReels: _reelsOfCreator,
              ),
            ),
          ),
          // [HF-REEL-CLEAN-1] no "N online now" pill on the feed (owner 2026-10-22: it moves to the influencer page)
        ],
      ),
    );
  }
}

class _DemoFeed extends StatefulWidget {
  const _DemoFeed();

  @override
  State<_DemoFeed> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<_DemoFeed> {
  final _pager = PageController();
  int _index = 0;

  @override
  void dispose() {
    _pager.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final live = reels.where((r) => r.who.online).toList();
    return Scaffold(
      backgroundColor: C.cinema,
      body: Stack(
        children: [
          PageView.builder(
            controller: _pager,
            scrollDirection: Axis.vertical,
            itemCount: live.length,
            onPageChanged: (i) => setState(() => _index = i),
            itemBuilder: (_, i) => ReelPage(reel: live[i], active: i == _index),
          ),
          // [HF-REEL-CLEAN-1] no "N online now" pill on the feed (owner 2026-10-22: it moves to the influencer page)
        ],
      ),
    );
  }
}

class ReelPage extends StatefulWidget {
  const ReelPage({
    super.key,
    required this.reel,
    required this.active,
    this.real,
    this.preload = false,
    this.keepAlive = false,
    this.onUnplayable,
    this.searchRepo,
    this.creatorReels,
    this.engageRepo,
  });

  /// [HF-REEL-ENGAGE-APP-1] Likes and comments; the app uses [Services], a demo reel keeps them in memory.
  final ReelEngageApi? engageRepo;

  /// [HF-REELS-FAV-1] Lets the channel page of an invite creator show their reels.
  final List<FeedReel> Function(FeedReel)? creatorReels;

  /// Used by the INVITE button of an invite reel; the app uses [Services].
  final SearchRepo? searchRepo;

  final Reel reel;
  final bool active;

  /// The real reel (HF-WIRE-4). When set, the picture is the real video instead of the stand-in.
  final FeedReel? real;
  final bool preload;

  /// [HF-REEL-WARM-1] Keep this page (and its player) alive while it is next to the one on screen, so scrolling back
  /// up plays instantly from where it was instead of loading again.
  final bool keepAlive;

  /// [HF-REEL-SKIP-1] The real reel cannot play inside the app (with the reason); the feed removes it.
  final void Function(String reason)? onUnplayable;

  @override
  State<ReelPage> createState() => _ReelPageState();
}

/// Stand-in "video": the influencer's art with a slow zoom and a progress bar, until real reels are wired.
class _ReelPageState extends State<ReelPage>
    with SingleTickerProviderStateMixin, AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => widget.keepAlive;

  bool _covered = false;
  bool _likeBusy = false;
  static final DemoReelEngage _demoEngage = DemoReelEngage();

  /// [HF-REEL-DOT-1] The one-second message in the middle of the screen (status dot tap).
  String? _flashText;
  Timer? _flashTimer;

  Future<void> _whileCovered(Future<void> Function() open) async {
    setState(() => _covered = true);
    try {
      await open();
    } finally {
      if (mounted) setState(() => _covered = false);
    }
  }

  late final AnimationController _play = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 12),
  );

  @override
  void initState() {
    super.initState();
    _play.value =
        0; // build the controller now: a late field first touched in dispose() would make a ticker on a dead element
    if (widget.active && widget.real == null) _play.repeat();
    if (widget.real != null && demo.signedIn)
      unawaited(
        ReelBookmarks.instance.load().catchError((Object _) {}),
      ); // [HF-WIRE-9] so the ♥ starts right
  }

  @override
  void didUpdateWidget(covariant ReelPage old) {
    super.didUpdateWidget(old);
    if (old.keepAlive != widget.keepAlive) updateKeepAlive();
    if (widget.real != null) return;
    if (widget.active && !_play.isAnimating) {
      _play.repeat();
    } else if (!widget.active && _play.isAnimating) {
      _play.stop();
    }
  }

  @override
  void dispose() {
    _flashTimer?.cancel();
    _play.dispose();
    super.dispose();
  }

  /// [HF-REELS-FAV-1] Avatar and name: an on-platform influencer opens the public profile; a creator not on the app
  /// opens the invite page. A reel with no slug never pushes `/profile/` (that was the "Page Not Found").
  void _openChannel(BuildContext context) {
    final real = widget.real;
    final inv = real?.invite;
    if (inv != null) {
      final reels = widget.creatorReels?.call(real!) ?? [real!];
      _whileCovered(
        () => context.push<void>(
          creatorPath(inv),
          extra: InviteProfileArgs(
            creator: inv,
            reels: reels.isEmpty ? [real!] : reels,
          ),
        ),
      );
      return;
    }
    final id = real != null ? real.host.slug : widget.reel.who.id;
    if (id.isEmpty) return;
    _whileCovered(
      () => context.push<void>('/profile/${Uri.encodeComponent(id)}'),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context); // keep-alive bookkeeping
    final r = widget.reel;
    final who = r.who;
    final inviteOf = widget
        .real
        ?.invite; // [HF-WIRE-22] set for a creator who is not on the app yet
    final bookmarks = widget.real == null ? null : ReelBookmarks.instance;
    final presence =
        widget.real?.host.presence ?? (who.online ? 'online' : 'offline');
    // [HF-CALL-MODES-E2] null unless call modes are on and the server sent a callState
    final stateDot = callStateDot(widget.real?.host.callState);
    // [HF-REEL-ENGAGE-APP-1] a real reel shows Like and Comment only when the server sent the numbers; a demo reel always does
    final engage = ReelEngageStore.instance;
    final engageId = widget.real?.id ?? r.id;
    final engageOn = widget.real == null || widget.real!.engagementOn;
    if (engageOn) {
      if (widget.real == null) {
        engage.seed(engageId, likes: EngageCount(platform: r.hearts), comments: const EngageCount());
      } else {
        engage.seedReel(widget.real!);
      }
    }
    final engageRepo = widget.engageRepo ?? (widget.real == null ? _demoEngage : Services.instance.reelEngageRepo);
    return ListenableBuilder(
      listenable: Listenable.merge([demo, if (bookmarks != null) bookmarks, engage]),
      builder: (context, _) {
        final faved = bookmarks?.isSaved(widget.real!.id) ?? demo.isFav(r.id);
        final eState = engageOn ? engage.of(engageId) : null;
        // [HF-REEL-ENGAGE-APP-1] On a short screen the "Reel information" button leaves the column (it moves to the bottom-left)
        // so nothing has to shrink: text never renders under 14 sp.
        return LayoutBuilder(builder: (context, box) {
        // [HF-REEL-OVERLAY-APP-1] (owner 2026-10-26) everything sits INSIDE the video, which fills the page: our buttons on the
        // right (Like and Share at the bottom), Call / Invite bottom-right, and for Instagram a name + caption bottom-left.
        final ig = widget.real != null && ReelPlayer.isInstagram(widget.real!);
        final intro = widget.real?.isIntro ?? false; // [HF-INTRO-A2] an approved intro video: its own overlay below
        final yt = widget.real != null && !ig && !intro;
        final pad = MediaQuery.paddingOf(context);
        return Stack(
          fit: StackFit.expand,
          children: [
            // the video: the real player, or the stand-in with a slow zoom
            if (widget.real != null)
              ReelPlayer(
                reel: widget.real!,
                active: widget.active && !_covered,
                preload: widget.preload,
                onUnplayable: widget.onUnplayable,
                onOpenLink: _openLinkInApp,
              )
            else
              AnimatedBuilder(
                animation: _play,
                builder: (_, child) => Transform.scale(
                  scale: 1 + 0.08 * _play.value,
                  child: child,
                ),
                child: Container(
                  decoration: BoxDecoration(
                    gradient: RadialGradient(
                      center: const Alignment(0, -0.3),
                      radius: 1.2,
                      colors: [who.tones.first, who.tones.last, C.cinema],
                    ),
                  ),
                  child: who.portrait == null
                      ? Center(
                          child: Text(
                            '[ REEL VIDEO ]',
                            style: t(
                              14,
                              color: C.ivory.withValues(alpha: 0.5),
                              ls: 0.12,
                            ),
                          ),
                        )
                      : Art(
                          who.portrait!,
                          fit: BoxFit.cover,
                          alignment: Alignment.topCenter,
                          fallback: Center(
                            child: Text(
                              '[ REEL VIDEO ]',
                              style: t(
                                14,
                                color: C.ivory.withValues(alpha: 0.5),
                                ls: 0.12,
                              ),
                            ),
                          ),
                        ),
                ),
              ),
            // IgnorePointer: the scrim must not swallow the tap that the player turns into play / pause
            const IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Color(0x66000000),
                      Color(0x00000000),
                      Color(0x00000000),
                      Color(0x33000000),
                    ],
                    stops: [0, 0.18, 0.5, 0.86],
                  ),
                ),
                child: SizedBox.expand(),
              ),
            ),
            // [HF-REEL-DOT-1] the status message, centred, for one second
            Positioned.fill(
              child: IgnorePointer(
                child: Center(
                  child: AnimatedOpacity(
                    opacity: _flashText == null ? 0 : 1,
                    duration: const Duration(milliseconds: 180),
                    child: Container(
                      key: const ValueKey('reel-status-flash'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 22,
                        vertical: 14,
                      ),
                      decoration: BoxDecoration(
                        color: C.cinema.withValues(alpha: 0.92),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        _flashText ?? '',
                        style: t(16, color: C.ivory),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            // progress (stand-in only: the real player shows its own)
            if (widget.real == null)
              Positioned(
                top: MediaQuery.paddingOf(context).top + 2,
                left: 16,
                right: 16,
                child: AnimatedBuilder(
                  animation: _play,
                  builder: (_, __) => LinearProgressIndicator(
                    value: _play.value,
                    minHeight: 3,
                    backgroundColor: C.ivory.withValues(alpha: 0.2),
                    color: C.marigold,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
            // Instagram: its card is hidden, so a small attribution label (not Instagram's artwork) top-left
            if (ig)
              Positioned(
                left: 16,
                top: pad.top + 18,
                child: IgnorePointer(
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                      width: 22,
                      height: 22,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(7),
                        border: Border.all(color: C.white, width: 2),
                      ),
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: C.white, width: 1.5)),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text('Instagram', style: t(15, color: C.white, w: FontWeight.w900).copyWith(shadows: _textShadow)),
                  ]),
                ),
              ),
            // Instagram: photo, name and caption bottom-left (not tappable: a tap falls to the play / pause layer)
            if (ig)
              Positioned(
                left: 16,
                bottom: pad.bottom + 90,
                child: IgnorePointer(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: (box.maxWidth - 120).clamp(120.0, 600.0).toDouble()),
                    child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Container(
                          key: const ValueKey('reel-photo'),
                          width: 36,
                          height: 36,
                          padding: const EdgeInsets.all(2),
                          decoration: const BoxDecoration(shape: BoxShape.circle, color: C.white),
                          child: ClipOval(child: Avatar(who, size: 32, ring: false)),
                        ),
                        const SizedBox(width: 10),
                        Flexible(
                          child: Text(
                            _callName(who),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: t(16, color: C.white, w: FontWeight.w900).copyWith(shadows: _textShadow),
                          ),
                        ),
                      ]),
                      if ((widget.real?.caption ?? '').trim().isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(
                          widget.real!.caption.trim(),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: t(14, color: C.white, w: FontWeight.w700).copyWith(shadows: _textShadow),
                        ),
                      ],
                    ]),
                  ),
                ),
              ),
            // Our buttons on the right, bottom edge just above the Call / Invite button. On YouTube they sit on a frosted patch
            // so YouTube's own like / share underneath are blurred (a platform-view WebView may not blur on every Android; the tint stays).
            if (!intro)
            Positioned(
              right: 0,
              bottom: pad.bottom + 92,
              top: pad.top + 8,
              child: Align(
                alignment: Alignment.bottomRight,
                child: _railPatch(
                  blur: yt,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Book a time, Comments, More above; Like then Share at the bottom ([HF-REEL-OVERLAY-APP-1]).
                      // [HF-REEL-CALL-2] a creator who is not on the app has nothing to book
                      if (inviteOf == null)
                        _railBtn('Book a time', Icons.calendar_month_outlined, () {
                          Telemetry.event('hf_reel_action', {'action': 'book'});
                          _whileCovered(
                            () => context.push<void>(
                              '/book/${Uri.encodeComponent(widget.real?.host.slug ?? who.id)}',
                            ),
                          );
                        }, text: 'Book'),
                      if (eState != null)
                        _railBtn(
                          'Comments',
                          Icons.chat_bubble_outline_rounded,
                          () => _whileCovered(() => _openComments(context, engageId, engageRepo)),
                          key: const ValueKey('reel-comment'),
                          text: compactCount(eState.comments.total),
                          count: true,
                        ),
                  _railBtn(
                    'More',
                    Icons.more_horiz_rounded,
                    () => _whileCovered(() => _openMore(
                      context,
                      status: inviteOf != null
                          ? ('Not on ${Brand.name} yet', C.ruby)
                          : (
                              stateDot?.$2 ?? (presence == 'online' ? 'Available now' : presence == 'busy' ? 'On a call' : 'Offline'),
                              stateDot?.$3 ?? (presence == 'online' ? C.onlineDot : presence == 'busy' ? C.marigold : C.ruby),
                            ),
                      items: [
                        ('Open ${who.name} profile', Icons.person_outline_rounded, null, () async {
                          _openProfile(context, 'more');
                        }),
                        (
                          faved ? 'Remove saved video' : 'Save video',
                          faved ? Icons.bookmark_rounded : Icons.bookmark_border_rounded,
                          null,
                          () => requireAccount(context, () async {
                            if (widget.real == null) {
                              demo.toggleFav(r.id);
                              if (mounted) _flash(faved ? 'Removed from saved' : 'Saved');
                              return;
                            }
                            try {
                              await bookmarks!.toggle(widget.real!);
                              if (mounted) _flash(faved ? 'Removed from saved' : 'Saved'); // [HF-REEL-RAIL-2] the save icon is in More now
                            } catch (e) {
                              if (context.mounted) toast(context, e is ApiException ? e.userMessage : 'Could not save that. Please try again.');
                            }
                          }, reason: 'to save videos'),
                        ),
                      ],
                    )),
                    key: const ValueKey('reel-more'),
                    text: 'More',
                  ),
                      if (eState != null)
                        _railBtn(
                          eState.liked ? 'Unlike' : 'Like',
                          yt
                              ? (eState.liked ? Icons.thumb_up_rounded : Icons.thumb_up_outlined)
                              : (eState.liked ? Icons.favorite_rounded : Icons.favorite_border_rounded),
                          _likeBusy ? null : () => _toggleLike(context, engageId, engageRepo),
                          color: eState.liked ? (yt ? C.marigold : C.rani) : C.ivory,
                          key: const ValueKey('reel-like'),
                          text: compactCount(eState.likes.total),
                          count: true,
                        ),
                      _railBtn(
                        'Share this reel',
                        yt ? Icons.shortcut_rounded : Icons.send_outlined,
                        () => widget.real == null
                            ? toast(context, 'Share link copied (demo)')
                            : _share(context, widget.real!),
                        key: const ValueKey('reel-share'),
                        text: 'Share',
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // Call now (a creator on the app) or the invite vote (a creator who is not), inside the video, bottom-right
            if (!intro)
            Positioned(
              right: 12,
              bottom: pad.bottom + 26,
              child: inviteOf != null
                  ? SizedBox(width: 170, height: 52, child: InviteButton(creator: inviteOf, repo: widget.searchRepo, compact: true))
                  : _callNow(context, who),
            ),
            // [HF-INTRO-A2] a stronger dark wash under the text of an intro video (the taps still fall through to the player)
            if (intro)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: 360,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [C.clear, C.cinema.withValues(alpha: 0.8)],
                      ),
                    ),
                  ),
                ),
              ),
            // [HF-INTRO-A2] Intro video: name + tick + socials, women tag, chips, status, one line, the one main button, and the
            // rail (Like, Comment, Share, Info). Design: Specs/hf-intro-screens/Reel1Call, Reel2Busy, Reel3Women.
            if (intro)
              IntroReelOverlay(
                reel: widget.real!,
                who: who,
                onProfile: () => _openProfile(context, 'rail'),
                onSocial: (s) => _openSocial(s, 'overlay'),
                onCall: () => _introGated(context, 'call', () => startCall(context, who)),
                onQueue: () => _introGated(context, 'queue', () {
                  final real = widget.real!;
                  return _whileCovered(() => context.push<void>('/queue/${Uri.encodeComponent(real.host.slug)}?n=${real.host.queueWaiting}'));
                }),
                onBook: () => _introGated(context, 'book', () => _whileCovered(
                      () => context.push<void>('/book/${Uri.encodeComponent(widget.real!.host.slug)}'),
                    )),
                rail: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (eState != null)
                      _railBtn(
                        eState.liked ? 'Unlike' : 'Like',
                        eState.liked ? Icons.favorite_rounded : Icons.favorite_border_rounded,
                        _likeBusy ? null : () => _toggleLike(context, engageId, engageRepo),
                        color: eState.liked ? C.rani : C.ivory,
                        key: const ValueKey('reel-like'),
                        text: compactCount(eState.likes.total),
                        count: true,
                      ),
                    if (eState != null)
                      _railBtn(
                        'Comments',
                        Icons.chat_bubble_outline_rounded,
                        () => _whileCovered(() => _openComments(context, engageId, engageRepo)),
                        key: const ValueKey('reel-comment'),
                        text: compactCount(eState.comments.total),
                        count: true,
                      ),
                    _railBtn(
                      'Share this reel',
                      Icons.send_outlined,
                      () => _shareIntro(context, widget.real!),
                      key: const ValueKey('reel-share'),
                      text: 'Share',
                    ),
                    _railBtn(
                      'Verified accounts',
                      Icons.info_outline_rounded,
                      () => _openIntroInfo(context),
                      key: const ValueKey('reel-info'),
                      text: 'Info',
                    ),
                  ],
                ),
              ),
          ],
        );
        });
      },
    );
  }

  /// [HF-INTRO-A2] Call / Join queue / Book on an intro reel. On a Women-to-Women channel the viewer signs in first (a guest
  /// gets the sign-up sheet), then the Aadhaar-only gate (Reel4Gate) runs; [go] only runs when she is let in.
  Future<void> _introGated(BuildContext context, String action, FutureOr<void> Function() go) async {
    Telemetry.event('hf_reel_action', {'action': 'intro_$action'});
    final real = widget.real;
    if (real == null) return;
    if (!real.womenOnly) {
      await go();
      return;
    }
    final first = real.host.name.trim().split(RegExp(r'\s+')).first;
    await requireAccount(
      context,
      () => unawaited(womenGateThen(context, () => unawaited(Future<void>.sync(go)))),
      reason: first.isEmpty ? 'to talk to her' : 'to talk to $first',
    );
  }

  /// [HF-INTRO-A2] A verified social icon (or Open in the info sheet): the account opens inside the app, the reel paused.
  Future<void> _openSocial(ReelSocial s, String surface) => _whileCovered(() => _pushSocial(s, surface));

  Future<void> _pushSocial(ReelSocial s, String surface) async {
    final u = Uri.tryParse(s.url);
    if (u == null || !OriginalPostPage.allowed(u)) {
      if (mounted) toast(context, 'Could not open that account.');
      return;
    }
    Telemetry.event('hf_social_link_open', {'platform': s.platform, 'surface': surface});
    await OriginalPostPage.open(context, u, bottom: _linkBar());
  }

  /// [HF-INTRO-A2] The ⓘ sheet "Verified owner of" (Reel5Info).
  Future<void> _openIntroInfo(BuildContext context) async {
    final real = widget.real;
    if (real == null) return;
    Telemetry.event('hf_reel_action', {'action': 'info'});
    await _whileCovered(() async {
      final pick = await showIntroInfoSheet(context, reel: real, who: widget.reel.who);
      if (pick != null && mounted) await _pushSocial(pick, 'sheet');
    });
  }

  /// [HF-INTRO-A2] Share an intro reel: the system share sheet with the public link that plays this video.
  Future<void> _shareIntro(BuildContext context, FeedReel r) async {
    Telemetry.event('hf_reel_share', {'source': 'intro'});
    try {
      await ShareSheet.text('${r.host.name} on ${Brand.name}\n${r.shareUrl ?? reelShareUrl(r.id)}');
    } catch (_) {
      if (context.mounted) toast(context, 'Could not open sharing. Please try again.');
    }
  }

  void _flash(String message) {
    _flashTimer?.cancel();
    setState(() => _flashText = message);
    _flashTimer = Timer(const Duration(seconds: 1), () {
      if (mounted) setState(() => _flashText = null);
    });
  }

  /// [HF-REEL-CALL-2] What the bar and the photo call the creator: the name, else the handle, else "influencer".
  static String _callName(Influencer who) {
    final n = who.name.trim();
    if (n.isNotEmpty) return n;
    final h = who.handle.replaceFirst('@', '').trim();
    return h.isNotEmpty ? h : 'influencer';
  }

  /// [HF-REEL-CALL-2] Opens the profile of this reel's creator (a network host's profile, or the vote page of a creator
  /// who is not on the app yet). [source] is `rail` (the photo) or `callbar`.
  void _openProfile(BuildContext context, String source) {
    Telemetry.event('reel_profile_tap', {'source': source, 'kind': widget.real?.invite != null ? 'invite' : 'network'});
    _openChannel(context);
  }

  /// [HF-REEL-RAW-APP-1] The red Call button (56 px tall). [label] is what a screen reader says, [text] what it shows.
  Widget _callPill(String label, VoidCallback onTap, {Key key = const ValueKey('reel-call-bar'), String text = 'Call', double? width}) => Semantics(
        button: true,
        label: label,
        child: Material(
          color: C.rani,
          borderRadius: BorderRadius.circular(999),
          child: InkWell(
            key: key,
            borderRadius: BorderRadius.circular(999),
            onTap: onTap,
            child: SizedBox(
              height: 56,
              width: width,
              child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
                const SizedBox(width: 22),
                const Icon(Icons.call_rounded, color: C.white, size: 22),
                const SizedBox(width: 10),
                Text(text, maxLines: 1, style: t(17, color: C.white, w: FontWeight.w900)),
                const SizedBox(width: 22),
              ]),
            ),
          ),
        ),
      );

  static final List<Shadow> _textShadow = [
    Shadow(color: C.cinema.withValues(alpha: 0.9), blurRadius: 4),
    Shadow(color: C.cinema.withValues(alpha: 0.9), blurRadius: 8),
  ];

  /// [HF-REEL-OVERLAY-APP-1] The Call button inside the video, bottom-right: marigold stadium, 52 px tall. [HF-REEL-CALL-2]
  /// It opens the creator's profile, where Call / Book live.
  Widget _callNow(BuildContext context, Influencer who) => Semantics(
        button: true,
        label: 'Call ${_callName(who)}',
        child: Material(
          color: C.marigold,
          shape: const StadiumBorder(),
          elevation: 2,
          child: InkWell(
            key: const ValueKey('reel-call-bar'),
            customBorder: const StadiumBorder(),
            onTap: () {
              Telemetry.event('hf_reel_action', {'action': 'call_bar'});
              _openProfile(context, 'callbar');
            },
            child: SizedBox(
              height: 52,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                const SizedBox(width: 18),
                const Icon(Icons.call_rounded, color: C.deep, size: 22),
                const SizedBox(width: 8),
                Text('Call now', maxLines: 1, style: t(17, color: C.deep, w: FontWeight.w900)),
                const SizedBox(width: 18),
              ]),
            ),
          ),
        ),
      );

  /// [HF-REEL-OVERLAY-APP-1] The right-hand column's holder: 92 px wide at the right edge. With [blur] (YouTube) it is a
  /// frosted patch (blur 14, light dark tint, left corners 28) so YouTube's own like / share beneath are not readable.
  Widget _railPatch({required bool blur, required Widget child}) {
    final inner = Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: SizedBox(width: 68, child: child),
    );
    if (!blur) return SizedBox(width: 92, child: inner);
    return ClipRRect(
      key: const ValueKey('reel-rail-blur'),
      borderRadius: const BorderRadius.horizontal(left: Radius.circular(28)),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 14, sigmaY: 14),
        child: Container(width: 92, color: C.cinema.withValues(alpha: 0.22), child: inner),
      ),
    );
  }

  /// [HF-REEL-OVERLAY-APP-1] A round dark rail button (50 px) with a 13 px w900 label under it. [count] shows [text] as a
  /// number (14 px).
  Widget _railBtn(
    String label,
    IconData icon,
    VoidCallback? tap, {
    Color color = C.ivory,
    Key? key,
    required String text,
    bool count = false,
  }) {
    final k = key;
    final Key? countKey = (count && k is ValueKey) ? ValueKey('${k.value}-count') : null;
    return Padding(
    key: key,
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          tooltip: label,
          onPressed: tap,
          iconSize: 26,
          style: IconButton.styleFrom(
            backgroundColor: C.cinema.withValues(alpha: 0.72),
            fixedSize: const Size(50, 50),
            minimumSize: const Size(50, 50),
            padding: EdgeInsets.zero,
          ),
          icon: Icon(icon, color: color),
        ),
        const SizedBox(height: 2),
        Text(
          text,
          key: countKey,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: t(count ? 14 : 13, color: C.white, w: FontWeight.w900).copyWith(shadows: _textShadow),
        ),
      ],
    ),
    );
  }

  /// [HF-REEL-RAW-APP-1] A YouTube / Instagram link tapped inside the player opens in the app, with our Call / Invite
  /// bar under it; the reel is paused while it is open.
  Future<void> _openLinkInApp(Uri url) =>
      _whileCovered(() => OriginalPostPage.open(context, url, bottom: _linkBar()));

  Widget _linkBar() {
    final invite = widget.real?.invite;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: invite != null
          ? InviteButton(creator: invite, repo: widget.searchRepo)
          : Builder(
              builder: (bar) => _callPill(
                'Call ${_callName(widget.reel.who)}',
                () {
                  Telemetry.event('hf_reel_action', {'action': 'link_call'});
                  Navigator.of(bar).maybePop();
                  _openProfile(context, 'linkbar');
                },
                key: const ValueKey('reel-link-call'),
                text: 'Call ${_callName(widget.reel.who)}',
                width: double.infinity,
              ),
            ),
    );
  }

  /// [HF-REEL-RAIL-2] The "More" sheet: creator status, original post, profile, save and share.
  Future<void> _openMore(
    BuildContext context, {
    required (String, Color) status,
    required List<(String, IconData, Key?, Future<void> Function())> items,
  }) async {
    Telemetry.event('hf_reel_action', {'action': 'more'});
    final pick = await showModalBottomSheet<Future<void> Function()>(
      context: context,
      backgroundColor: C.cream,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Row(children: [
              Container(
                key: const ValueKey('reel-status-dot'),
                width: 18,
                height: 18,
                decoration: BoxDecoration(shape: BoxShape.circle, color: status.$2, border: Border.all(color: C.ivory, width: 2)),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(status.$1, style: t(17, color: C.maroon, w: FontWeight.w900))),
            ]),
          ),
          for (final it in items)
            Tooltip(
              message: it.$1,
              child: ListTile(
                key: it.$3,
                leading: Icon(it.$2, color: C.maroon),
                title: Text(it.$1, style: t(17, color: C.deep, w: FontWeight.w800)),
                onTap: () => Navigator.of(sheet).pop(it.$4),
              ),
            ),
          const SizedBox(height: 8),
        ]),
      ),
    );
    if (pick != null && context.mounted) await pick();
  }

  void _toggleLike(BuildContext context, String id, ReelEngageApi repo) {
    unawaited(requireAccount(context, () async {
      final store = ReelEngageStore.instance;
      final before = store.of(id);
      if (before == null || _likeBusy) return;
      final on = !before.liked;
      _likeBusy = true;
      store.put(id, before.withLiked(on)); // instant
      Telemetry.event('hf_reel_action', {'action': on ? 'like' : 'unlike', 'platform': widget.real?.platform ?? 'demo'});
      try {
        final res = await repo.setLike(id, on);
        // the server's numbers win for a real reel (the demo one only echoes)
        if (widget.real != null) store.update(id, (s) => s.copyWith(likes: res.likes, liked: res.liked));
      } catch (e) {
        store.update(id, (s) => s.withLiked(!on)); // put it back
        if (context.mounted) toast(context, engageErrorText(e, fallback: 'Could not save your like. Please try again.'));
      } finally {
        _likeBusy = false;
        if (mounted) setState(() {});
      }
    }, reason: 'to like videos'));
  }

  Future<void> _openComments(BuildContext context, String id, ReelEngageApi repo) async {
    // [HF-REEL-OWN-1] owner: viewers are never sent to Instagram / YouTube, so the comments sheet has no "open original" link
    await showReelComments(
      context,
      reelId: id,
      platform: widget.real?.platform ?? 'youtube',
      repo: repo,
      store: ReelEngageStore.instance,
      canOpenOriginal: false,
    );
  }


  Future<void> _share(BuildContext context, FeedReel r) async {
    // [HF-WIRE-9] the system share sheet, link on the brand domain (Brand.url via reelShareUrl)
    try {
      await ShareSheet.reel(r.id, caption: r.caption);
    } catch (_) {
      if (context.mounted)
        toast(context, 'Could not open sharing. Please try again.');
    }
  }
}

/// Votes remembered for this session so a card keeps saying VOTED when it is scrolled away and back.
class InviteVotes {
  static final Set<String> voted = {};

  /// [HF-VOTE-COUNT-1] The newest vote total the server gave us, per creator key, so every page shows the real count.
  static final Map<String, int> totals = {};
  static final ValueNotifier<int> changed = ValueNotifier<int>(0);

  static void note(String key, int total) {
    totals[key] = total;
    changed.value++;
  }

  static void clear() {
    voted.clear();
    totals.clear();
  }
}

/// [HF-WIRE-22] HF-REEL-40: the INVITE button of an invite reel. One tap = one vote (HF-REEL-9), needs an account, then reads VOTED.
class InviteButton extends StatefulWidget {
  const InviteButton({required this.creator, this.repo, this.compact = false});

  final InviteCreator creator;
  final SearchRepo? repo;

  /// [HF-REEL-RAW-APP-1] Smaller label and padding so it fits the strip under a reel on a phone.
  final bool compact;

  @override
  State<InviteButton> createState() => InviteButtonState();
}

class InviteButtonState extends State<InviteButton> {
  bool _busy = false;

  Future<void> _vote() async {
    final c = widget.creator;
    setState(() => _busy = true);
    try {
      final total = await (widget.repo ?? Services.instance.searchRepo).vote(
        MissingCreator(
          handle: c.handle,
          platform: c.platform,
          votes: c.votes,
          followers: c.followers,
        ),
      );
      InviteVotes.voted.add(c.key);
      InviteVotes.note(c.key, total); // [HF-VOTE-COUNT-1] the page's Votes number follows the server's total
      if (mounted) toast(context, 'Voted! We will ask ${c.handle} to join.');
    } on ApiException catch (e) {
      if (mounted) toast(context, e.userMessage);
    } catch (_) {
      if (mounted) toast(context, ApiException.genericText);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final voted = InviteVotes.voted.contains(widget.creator.key);
    return SizedBox(
      height: 56,
      width: double.infinity,
      child: FilledButton(
        key: const ValueKey('invite-button'),
        style: FilledButton.styleFrom(
          backgroundColor: voted ? C.sand : C.marigold,
          foregroundColor: C.deep,
          shape: const StadiumBorder(),
          padding: widget.compact ? const EdgeInsets.symmetric(horizontal: 12) : null,
        ),
        onPressed: voted || _busy
            ? null
            : () => requireAccount(
                context,
                () => unawaited(_vote()),
                reason: 'to vote',
              ),
        child: Text(
          voted ? 'VOTED' : 'VOTE TO INVITE', // [HF-REEL-CALL-2]
          maxLines: 1,
          style: t(widget.compact ? 15 : 18, color: C.deep, ls: 0.06),
        ),
      ),
    );
  }
}
