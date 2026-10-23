import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/call_flags.dart';
import '../../data/favourites_store.dart';
import '../../data/models/queue.dart';
import '../../data/models/reel.dart';
import '../../data/repos/channel_repo.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/services.dart';
import '../../data/share.dart'; // [HF-SHARE-APP-1]
import '../../ui/async_view.dart';
import '../channel_pop_kit.dart';
import '../data.dart';
import '../notify_me_button.dart';
import '../presence_bridge.dart';
import '../profile_kit.dart';
import '../reels_real.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'bookings_real.dart'; // [HF-WIRE-8]
import 'channel_sections.dart'; // [HF-CHANNEL-APP-1]
import 'sheets.dart';

/// Public influencer channel page ([HF-CHANNEL-APP-1], built to the owner-approved phone mock PhoneChannel, 2026-10-23): big photo
/// with Online / AI labels, name, tagline and the stats that have data, section tabs, then Merch first, Now Showing (videos),
/// Book a time, About and Before you call, with a sticky bar (rate, Book, Call now). Sections without data are left out.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.id, this.repo});

  /// In demo mode a dummy influencer id; in real mode the host's slug.
  final String id;

  /// Tests pass a repo on a fake API; the app uses [Services].
  final ReelsRepo? repo;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _SectionTab {
  const _SectionTab(this.label, this.key, {this.count});
  final String label;
  final GlobalKey key;
  final int? count;
}

class _ProfileScreenState extends State<ProfileScreen> {
  AsyncState<PublicProfile> _ps = const AsyncLoading();
  ChannelShop? _shop;
  bool _viewed = false;

  final ScrollController _scroll = ScrollController();
  final GlobalKey _stackKey = GlobalKey();
  final GlobalKey _navKey = GlobalKey();
  final GlobalKey _merchKey = GlobalKey();
  final GlobalKey _videosKey = GlobalKey();
  final GlobalKey _bookKey = GlobalKey();
  final GlobalKey _aboutKey = GlobalKey();
  bool _pinNav = false;
  int _active = 0;
  List<_SectionTab> _tabs = const [];

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    if (PresenceBridge.real) {
      unawaited(_loadProfile());
      unawaited(_loadShop());
    }
    if (PresenceBridge.real && demo.signedIn) unawaited(FavouritesStore.instance.ensureLoaded()); // [HF-WIRE-9]
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadProfile() async {
    setState(() => _ps = const AsyncLoading());
    try {
      final p = await (widget.repo ?? Services.instance.reelsRepo).profile(widget.id);
      if (!mounted) return;
      setState(() => _ps = AsyncData(p));
      if (!_viewed) {
        _viewed = true;
        channelEvent('channel_viewed', {'slug': widget.id, 'surface': 'app', 'online': p.host.presence == 'online', 'videos': p.reels.length});
      }
    } catch (e) {
      if (mounted) setState(() => _ps = AsyncFailure(e));
    }
  }

  /// The merch tiles. Nothing is shown while the shop is off, still loading, failed, or empty (the page works without it).
  Future<void> _loadShop() async {
    try {
      await Services.instance.merchRepo.loadFlags();
      if (!MerchRepo.flags.value.enabled) return;
      final s = await ChannelRepo.instance.shop(widget.id);
      if (mounted && s.items.isNotEmpty) setState(() => _shop = s);
    } catch (_) {
      // merch is an extra: a failed read just leaves it out
    }
  }

  /// Pins the section tabs under the header once they scroll away, and marks the section being read.
  void _onScroll() {
    final stack = _stackKey.currentContext?.findRenderObject();
    final nav = _navKey.currentContext?.findRenderObject();
    if (stack is! RenderBox || !stack.attached) return;
    final top = stack.localToGlobal(Offset.zero).dy;
    var pin = _pinNav;
    if (nav is RenderBox && nav.attached) pin = nav.localToGlobal(Offset.zero).dy < top;
    var active = _active;
    for (var i = 0; i < _tabs.length; i++) {
      final box = _tabs[i].key.currentContext?.findRenderObject();
      if (box is RenderBox && box.attached && box.localToGlobal(Offset.zero).dy <= top + 120) active = i;
    }
    if (pin != _pinNav || active != _active) setState(() {
      _pinNav = pin;
      _active = active;
    });
  }

  void _goTo(int i) {
    final ctx = _tabs[i].key.currentContext;
    if (ctx == null) return;
    final h = MediaQuery.sizeOf(context).height;
    unawaited(Scrollable.ensureVisible(ctx, duration: const Duration(milliseconds: 350), curve: Curves.easeOutCubic, alignment: h <= 0 ? 0 : 60 / h));
  }

  /// First sentence of the bio, short enough for under the name.
  static String _tagline(String bio) {
    final b = bio.trim();
    if (b.isEmpty) return '';
    final m = RegExp(r'^(.+?[.!?])(\s|$)').firstMatch(b);
    final first = m == null ? b : m.group(1)!;
    return first.length > 90 ? '${first.substring(0, 87).trimRight()}...' : first;
  }

  Widget _primaryAction(BuildContext context, Influencer who, String first) {
    final notify = NotifyMeButton(slug: who.id, firstName: first, big: true);
    final call = GpButton('Call now', icon: Icons.call_rounded, onTap: () => startCall(context, who));
    final queueOn = CallFlags.queue;
    final queue = GpButton(
      'Join the queue',
      icon: Icons.groups_rounded,
      onTap: () => requireAccount(context, () => unawaited(context.push<Object?>('/queue/${Uri.encodeComponent(who.id)}?n=${who.queueWaiting}')), reason: 'to join the queue'),
    );
    final cs = CallFlags.modes ? who.callState : null;
    if (cs == null) return who.online ? call : notify;
    return switch (cs) {
      HostCallState.available => call,
      HostCallState.onCall => queueOn ? queue : notify,
      HostCallState.connecting => queueOn ? queue : call,
      HostCallState.queueOnly => queueOn ? queue : notify,
      HostCallState.appointments => notify,
      HostCallState.offline => notify,
    };
  }

  @override
  Widget build(BuildContext context) {
    PublicProfile? pp;
    if (PresenceBridge.real) {
      final s = _ps;
      if (s is! AsyncData<PublicProfile>) {
        return Scaffold(
          backgroundColor: GP.bg,
          body: SafeArea(
            child: Stack(
              children: [
                AsyncView<PublicProfile>(state: s, onRetry: () => unawaited(_loadProfile()), builder: (_, __) => const SizedBox.shrink()),
                const Positioned(top: 10, left: 16, child: BackBtn()),
              ],
            ),
          ),
        );
      }
      pp = s.value;
    }
    final prof = pp;
    final who = prof != null ? influencerFromHost(prof.host, bio: prof.about, likes: prof.likes, videos: prof.reels.length) : influencerById(widget.id);
    final mine = reels.where((r) => r.who.id == who.id).toList();
    final firstReel = mine.isEmpty ? null : mine.first;
    final first = who.name.split(' ').first;
    final shop = _shop;
    final hasMerch = prof != null && shop != null && shop.items.isNotEmpty;
    final hasVideos = prof != null && prof.reels.isNotEmpty;
    final hasBook = prof != null && BookingsBridge.real;
    final hasAbout = who.bio.trim().isNotEmpty;
    _tabs = [
      if (hasMerch) _SectionTab('Merch', _merchKey, count: shop!.items.length),
      if (hasVideos) _SectionTab('Videos', _videosKey),
      if (hasBook) _SectionTab('Book', _bookKey),
      if (hasAbout) _SectionTab('About', _aboutKey),
    ];
    final active = _active.clamp(0, _tabs.isEmpty ? 0 : _tabs.length - 1);
    return ListenableBuilder(
      listenable: prof != null ? Listenable.merge([demo, FavouritesStore.instance]) : demo,
      builder: (context, _) {
        final realSlug = prof?.host.slug; // [HF-WIRE-9] real hearts are saved by influencer slug
        final faved = realSlug != null ? FavouritesStore.instance.isFav(realSlug) : firstReel != null && demo.isFav(firstReel.id);
        final onHeart = (firstReel != null || realSlug != null)
            ? () => requireAccount(
                  context,
                  () => realSlug != null
                      ? unawaited(toggleFavourite(realSlug, onError: (_) => toast(context, 'Could not save that. Please try again.')))
                      : demo.toggleFav(firstReel!.id),
                  reason: 'to save favourites',
                )
            : null;
        // [HF-SHARE-APP-1] only a live profile has a slug to link to
        final onShare = realSlug == null ? null : () => unawaited(ShareSheet.influencer(realSlug, who.name, own: Services.instance.me?.hostSlug == realSlug));
        final nav = _tabs.length < 2
            ? null
            : _SectionNav(tabs: _tabs, active: active, onTap: _goTo);
        final stats = <(String, String)>[
          if (prof != null && prof.likes > 0) (compactCount(prof.likes), 'likes'),
          if (prof != null && prof.reels.isNotEmpty) ('${prof.reels.length}', 'videos'),
          if (prof != null && prof.host.followers > 0) (compactCount(prof.host.followers), 'followers'),
        ];
        final tags = [who.niche, who.city].where((e) => e.isNotEmpty).toList();
        final cs = CallFlags.modes ? who.callState : null;
        final showBook = cs != HostCallState.offline;
        return Scaffold(
          backgroundColor: GP.bg,
          body: Column(children: [
            const GpHeader(logo: true),
            Expanded(
              child: Stack(key: _stackKey, children: [
                SingleChildScrollView(
                  controller: _scroll,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    _ChannelHero(
                      who: who,
                      tagline: _tagline(who.bio),
                      stats: stats,
                      faved: faved,
                      onHeart: onHeart,
                      onShare: onShare,
                    ),
                    if (nav != null) KeyedSubtree(key: _navKey, child: nav),
                    if (hasMerch) KeyedSubtree(key: _merchKey, child: ChannelMerchSection(shop: shop!, hostSlug: who.id, firstName: first)),
                    if (hasVideos) ...[
                      if (hasMerch) const GpBand(),
                      KeyedSubtree(key: _videosKey, child: ChannelVideosSection(reels: prof!.reels)),
                    ],
                    if (hasBook) KeyedSubtree(key: _bookKey, child: ChannelBookSection(slug: who.id, firstName: first, hostName: who.name, avatarUrl: who.avatarUrl)),
                    if (hasAbout) ...[
                      const GpBand(rick: true),
                      KeyedSubtree(key: _aboutKey, child: ChannelAboutSection(bio: who.bio.trim(), tags: tags)),
                    ],
                    const ChannelRulesSection(),
                    const SizedBox(height: 12),
                  ]),
                ),
                if (_pinNav && nav != null) Positioned(top: 0, left: 0, right: 0, child: nav),
              ]),
            ),
          ]),
          bottomNavigationBar: GpBottomBar(
            child: Row(children: [
              Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('₹${who.rate}', style: t(24, color: GP.ink, w: FontWeight.w900, h: 1.05)),
                Text('/min', style: t(14, color: GP.muted, w: FontWeight.w700, h: 1.1)),
              ]),
              const SizedBox(width: 12),
              if (showBook) ...[
                Expanded(child: GpButton('Book', kind: GpBtn.outline, onTap: () => context.push('/book/${who.id}'))),
                const SizedBox(width: 10),
              ],
              Expanded(child: _primaryAction(context, who, first)),
            ]),
          ),
        );
      },
    );
  }
}

/// The sticky section tabs (Merch with its count, Videos, Book, About).
class _SectionNav extends StatelessWidget {
  const _SectionNav({required this.tabs, required this.active, required this.onTap});

  final List<_SectionTab> tabs;
  final int active;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: GP.paper,
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        decoration: const BoxDecoration(border: Border.symmetric(horizontal: BorderSide(color: GP.line))),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (var i = 0; i < tabs.length; i++)
              Semantics(
                button: true,
                selected: i == active,
                child: InkWell(
                  customBorder: const StadiumBorder(),
                  onTap: () => onTap(i),
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 48),
                    margin: const EdgeInsets.only(right: 2),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    decoration: ShapeDecoration(shape: const StadiumBorder(), color: i == active ? GP.ink : GP.paper),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(tabs[i].label, style: t(15, color: i == active ? GP.paper : GP.ink, w: FontWeight.w900)),
                      if (tabs[i].count != null) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
                          decoration: BoxDecoration(color: GP.yel, borderRadius: BorderRadius.circular(99)),
                          child: Text('${tabs[i].count}', style: t(14, color: GP.ink, w: FontWeight.w900)),
                        ),
                      ],
                    ]),
                  ),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

/// Full-width photo (Online now / Offline and the AI label on it), then the eyebrow, name, tagline, stats and Save / Share.
/// No decorative border, arch or curtain round the photo (decision D2).
class _ChannelHero extends StatelessWidget {
  const _ChannelHero({required this.who, required this.tagline, required this.stats, required this.faved, required this.onHeart, required this.onShare});

  final Influencer who;
  final String tagline;
  final List<(String, String)> stats;
  final bool faved;
  final VoidCallback? onHeart;
  final VoidCallback? onShare;

  Widget _round(IconData icon, String label, Color color, VoidCallback onTap) => Semantics(
        button: true,
        label: label,
        child: Tooltip(
          message: label,
          child: Material(
            color: GP.paper,
            shape: const CircleBorder(side: BorderSide(color: GP.line, width: 2)),
            child: InkWell(customBorder: const CircleBorder(), onTap: onTap, child: SizedBox(width: 52, height: 52, child: Icon(icon, color: color))),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final hasPhoto = (who.avatarUrl ?? '').isNotEmpty || who.portrait != null;
    final online = who.online;
    return Column(children: [
      AspectRatio(
        aspectRatio: 4 / 4.6,
        child: ClipRRect(
          borderRadius: const BorderRadius.vertical(bottom: Radius.circular(32)),
          child: Stack(fit: StackFit.expand, children: [
            profilePhoto(who),
            if (!hasPhoto) const Center(child: Icon(Icons.person_rounded, size: 150, color: GP.veil)),
            Positioned(
              left: 16,
              top: 16,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(color: online ? GP.ink : GP.veil, borderRadius: BorderRadius.circular(999)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (online) ...[
                    Container(width: 9, height: 9, decoration: const BoxDecoration(color: GP.yel, shape: BoxShape.circle)),
                    const SizedBox(width: 8),
                  ],
                  Text(online ? 'Online now' : 'Offline', style: t(14, color: online ? GP.paper : GP.ink, w: FontWeight.w900)),
                ]),
              ),
            ),
            Positioned(
              left: 16,
              right: 16,
              bottom: 16,
              child: Align(
                alignment: Alignment.bottomLeft,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(color: GP.veil, borderRadius: BorderRadius.circular(999)),
                  child: Text('AI avatar chosen by the influencer', style: t(14, color: GP.ink, w: FontWeight.w800)),
                ),
              ),
            ),
          ]),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 22, 16, 30),
        child: Column(children: [
          Text(['Creator', if (who.handle.isNotEmpty) who.handle].join(' · ').toUpperCase(), textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis, style: gpEyebrow()),
          const SizedBox(height: 6),
          Semantics(header: true, child: Text(who.name, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(48, color: GP.ink, w: FontWeight.w900, h: .98))),
          if (tagline.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(tagline, textAlign: TextAlign.center, style: t(18, color: GP.muted, w: FontWeight.w700, h: 1.35)),
          ],
          if (stats.isNotEmpty) ...[
            const SizedBox(height: 16),
            Wrap(alignment: WrapAlignment.center, spacing: 26, runSpacing: 8, children: [
              for (final s in stats)
                Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(s.$1, style: t(26, color: GP.ink, w: FontWeight.w900, h: 1.05)),
                  Text(s.$2, style: t(14, color: GP.muted, w: FontWeight.w700)),
                ]),
            ]),
          ],
          if (onHeart != null || onShare != null) ...[
            const SizedBox(height: 18),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (onHeart != null) _round(faved ? Icons.favorite_rounded : Icons.favorite_border_rounded, faved ? 'Remove from favourites' : 'Add to favourites', GP.rani, onHeart!),
              if (onHeart != null && onShare != null) const SizedBox(width: 12),
              if (onShare != null) _round(Icons.share_rounded, 'Share this page', GP.ink, onShare!),
            ]),
          ],
        ]),
      ),
    ]);
  }
}
