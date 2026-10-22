import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/reel_bookmarks.dart';
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
import '../online_now_pill.dart';
import '../presence_bridge.dart';
import '../reel_player.dart';
import '../reels_real.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'creator_page.dart';
import 'sheets.dart';

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

class _RealFeedState extends State<RealFeed> {
  final _pager = PageController();
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
    ReelGate.visible.addListener(
      _onGate,
    ); // [HF-BOOK-APPROVE-POLISH] pause when the feed is not on screen
    unawaited(_first());
  }

  @override
  void didUpdateWidget(covariant RealFeed oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.reelId != oldWidget.reelId) {
      if (_pager.hasClients) _pager.jumpToPage(0);
      unawaited(_first());
    }
  }

  @override
  void dispose() {
    ReelGate.visible.removeListener(_onGate);
    _pager.dispose();
    super.dispose();
  }

  Future<void> _first() async {
    setState(() => _state = const AsyncLoading());
    try {
      final results = await Future.wait<Object?>([
        widget.repo.feed(),
        if (widget.reelId != null)
          widget.repo.one(widget.reelId!)
        else
          Future<Object?>.value(null),
      ]);
      if (!mounted) return;
      final page = results[0] as ReelsPage;
      final shared = results[1] as FeedReel? ?? widget.initialReel;
      _items
        ..clear()
        ..addAll([
          if (shared != null) shared,
          ...page.items.where((r) => r.id != shared?.id),
        ]);
      _cursor = page.nextCursor;
      _more = page.nextCursor != null;
      _index = 0;
      if (_items.isNotEmpty &&
          !_items.first.isInvite &&
          _counted.add(_items.first.id))
        unawaited(widget.repo.view(_items.first.id));
      setState(() => _state = AsyncData(List.of(_items)));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_more) return;
    _loadingMore = true;
    try {
      final page = await widget.repo.feed(cursor: _cursor);
      if (!mounted) return;
      final have = _items.map((r) => r.id).toSet();
      _items.addAll(page.items.where((r) => !have.contains(r.id)));
      _cursor = page.nextCursor;
      _more = page.nextCursor != null;
      setState(() => _state = AsyncData(List.of(_items)));
    } catch (_) {
      // keep what is on screen; the next swipe tries again
    } finally {
      _loadingMore = false;
    }
  }

  /// [HF-REELS-FAV-1] The reels of an invite creator that this feed already holds (for the creator page).
  List<FeedReel> _reelsOfCreator(FeedReel r) => [
    for (final x in _items)
      if (x.invite != null && x.invite!.key == r.invite?.key) x,
  ];

  void _onPage(int i) {
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
          PageView.builder(
            controller: _pager,
            scrollDirection: Axis.vertical,
            itemCount: items.length,
            onPageChanged: _onPage,
            allowImplicitScrolling:
                true, // builds the next page early so its video is ready
            itemBuilder: (_, i) => ReelPage(
              key: ValueKey(items[i].id),
              reel: demoReelFrom(items[i]),
              real: items[i],
              active: i == _index && ReelGate.visible.value,
              preload: i == _index + 1,
              keepAlive: (i - _index).abs() <= 1,
              searchRepo: widget.searchRepo,
              creatorReels: _reelsOfCreator,
            ),
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 10,
            left: 22,
            right: 22,
            child: Row(
              children: [
                const Spacer(),
                OnlineNowPill(demoCount: 0, fetch: widget.onlineFetch),
              ],
            ),
          ),
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
    final onlineCount = influencers.where((i) => i.online).length;
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
          Positioned(
            top: MediaQuery.paddingOf(context).top + 10,
            left: 22,
            right: 22,
            child: Row(
              children: [
                const Spacer(),
                OnlineNowPill(demoCount: onlineCount * 21),
              ],
            ),
          ),
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
    this.searchRepo,
    this.creatorReels,
  });

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

  @override
  State<ReelPage> createState() => _ReelPageState();
}

/// Stand-in "video": the influencer's art with a slow zoom and a progress bar, until real reels are wired.
class _ReelPageState extends State<ReelPage>
    with SingleTickerProviderStateMixin, AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => widget.keepAlive;

  bool _covered = false;

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
    return ListenableBuilder(
      listenable: bookmarks == null
          ? demo
          : Listenable.merge([demo, bookmarks]),
      builder: (context, _) {
        final faved = bookmarks?.isSaved(widget.real!.id) ?? demo.isFav(r.id);
        return Stack(
          fit: StackFit.expand,
          children: [
            // the video: the real player, or the stand-in with a slow zoom
            if (widget.real != null)
              ReelPlayer(
                reel: widget.real!,
                active: widget.active && !_covered,
                preload: widget.preload,
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
            Positioned(
              right: 8,
              bottom: 12,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _action(
                    'Reel information',
                    Icons.info_outline_rounded,
                    () => _whileCovered(() => _info(context)),
                  ),
                  _action(
                    'Open ${who.name} profile',
                    Icons.person_outline_rounded,
                    () => _openChannel(context),
                  ),
                  if (inviteOf != null) ...[
                    const Tooltip(
                      message: 'Not available — creator has not joined yet',
                      child: Padding(
                        padding: EdgeInsets.all(8),
                        child: Icon(
                          Icons.nightlight_round,
                          size: 16,
                          color: Color(0xFFAAA5AD),
                          semanticLabel: 'Not available',
                        ),
                      ),
                    ),
                    _action(
                      'Booking unavailable — invite creator',
                      Icons.calendar_month_outlined,
                      () => _whileCovered(() => _info(context)),
                    ),
                  ],
                  if (inviteOf == null) ...[
                    Tooltip(
                      message: presence == 'online'
                          ? 'Available'
                          : presence == 'busy'
                          ? 'On call'
                          : 'Offline',
                      child: Padding(
                        padding: const EdgeInsets.all(8),
                        child: Icon(
                          presence == 'online'
                              ? Icons.circle
                              : presence == 'busy'
                              ? Icons.phone_in_talk_rounded
                              : Icons.nightlight_round,
                          semanticLabel: presence == 'online'
                              ? 'Available'
                              : presence == 'busy'
                              ? 'On call'
                              : 'Offline',
                          size: 16,
                          color: presence == 'online'
                              ? const Color(0xFFA9E7BA)
                              : presence == 'busy'
                              ? const Color(0xFFE85B64)
                              : const Color(0xFFAAA5AD),
                        ),
                      ),
                    ),
                    _action('Book a time', Icons.calendar_month_outlined, () {
                      Telemetry.event('hf_reel_action', {'action': 'book'});
                      _whileCovered(
                        () => context.push<void>(
                          '/book/${Uri.encodeComponent(widget.real?.host.slug ?? who.id)}',
                        ),
                      );
                    }),
                  ],
                  _action(
                    faved ? 'Remove saved video' : 'Save video',
                    faved
                        ? Icons.favorite_rounded
                        : Icons.favorite_border_rounded,
                    bookmarks?.busy(widget.real!.id) == true
                        ? null
                        : () => requireAccount(context, () async {
                            if (widget.real == null) {
                              demo.toggleFav(r.id);
                              return;
                            }
                            try {
                              await bookmarks!.toggle(widget.real!);
                            } catch (e) {
                              if (context.mounted)
                                toast(
                                  context,
                                  e is ApiException
                                      ? e.userMessage
                                      : 'Could not save that. Please try again.',
                                );
                            }
                          }, reason: 'to save videos'),
                    color: faved ? C.rani : C.ivory,
                  ),
                  _action(
                    'Share this reel',
                    Icons.share_outlined,
                    () => widget.real == null
                        ? toast(context, 'Share link copied (demo)')
                        : _share(context, widget.real!),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _action(
    String label,
    IconData icon,
    VoidCallback? tap, {
    Color color = C.ivory,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 1),
    child: IconButton(
      tooltip: label,
      onPressed: tap,
      iconSize: 23,
      style: IconButton.styleFrom(
        backgroundColor: const Color(0x66000000),
        minimumSize: const Size(48, 48),
      ),
      icon: Icon(icon, color: color),
    ),
  );

  Future<void> _info(BuildContext context) async {
    final r = widget.reel;
    Telemetry.event('hf_reel_action', {'action': 'info'});
    Timer? timer;
    await showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) {
        timer ??= Timer(const Duration(seconds: 8), () {
          if (sheetContext.mounted &&
              ModalRoute.of(sheetContext)?.isCurrent == true)
            Navigator.of(sheetContext).pop();
        });
        return SafeArea(
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(r.who.name, style: t(22)),
                  Text(
                    '${r.who.handle} · ${r.who.followers} followers',
                    style: t(14),
                  ),
                  const SizedBox(height: 12),
                  Text(r.caption, style: t(16)),
                  const SizedBox(height: 12),
                  if (widget.real?.invite != null) ...[
                    Text(
                      'Not on ${Brand.name} yet',
                      key: const ValueKey('not-on-pill'),
                      style: t(14),
                    ),
                    Text(
                      '${compactCount(r.hearts)} likes · ${r.views} views',
                      key: const ValueKey('invite-stats'),
                      style: t(14),
                    ),
                    InviteButton(
                      creator: widget.real!.invite!,
                      repo: widget.searchRepo,
                    ),
                  ] else ...[
                    Text('₹${r.who.rate}/min', style: t(14)),
                    if ((widget.real?.host.presence ??
                            (r.who.online ? 'online' : 'offline')) ==
                        'online')
                      TextButton.icon(
                        onPressed: () {
                          Navigator.of(sheetContext).pop();
                          startCall(context, r.who);
                        },
                        icon: const Icon(Icons.call_outlined),
                        label: const Text('Call now'),
                      ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
    timer?.cancel();
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
}

/// [HF-WIRE-22] HF-REEL-40: the INVITE button of an invite reel. One tap = one vote (HF-REEL-9), needs an account, then reads VOTED.
class InviteButton extends StatefulWidget {
  const InviteButton({required this.creator, this.repo});

  final InviteCreator creator;
  final SearchRepo? repo;

  @override
  State<InviteButton> createState() => InviteButtonState();
}

class InviteButtonState extends State<InviteButton> {
  bool _busy = false;

  Future<void> _vote() async {
    final c = widget.creator;
    setState(() => _busy = true);
    try {
      await (widget.repo ?? Services.instance.searchRepo).vote(
        MissingCreator(
          handle: c.handle,
          platform: c.platform,
          votes: c.votes,
          followers: c.followers,
        ),
      );
      InviteVotes.voted.add(c.key);
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
        ),
        onPressed: voted || _busy
            ? null
            : () => requireAccount(
                context,
                () => unawaited(_vote()),
                reason: 'to vote',
              ),
        child: Text(
          voted ? 'VOTED' : 'INVITE',
          style: t(18, color: C.deep, ls: 0.06),
        ),
      ),
    );
  }
}
