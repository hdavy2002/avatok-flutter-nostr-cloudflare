import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/favourites_store.dart';
import '../../data/models/reel.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../data.dart';
import '../desi.dart';
import '../profile_kit.dart';
import '../notify_me_button.dart';
import '../presence_bridge.dart';
import '../reel_viewer.dart';
import '../reels_real.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'bookings_real.dart'; // [HF-WIRE-8]
import 'sheets.dart';

/// Public influencer profile (HF-REEL-8): likes, videos, rate, bio, Call now / Book,
/// Online/Offline, and two tabs — Videos and Calendar.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.id, this.repo});

  /// In demo mode a dummy influencer id; in real mode the host's slug.
  final String id;

  /// Tests pass a repo on a fake API; the app uses [Services].
  final ReelsRepo? repo;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  int _tab = 0;
  int _day = 0;
  AsyncState<PublicProfile> _ps = const AsyncLoading();

  @override
  void initState() {
    super.initState();
    if (PresenceBridge.real) unawaited(_loadProfile());
    if (PresenceBridge.real && demo.signedIn) unawaited(FavouritesStore.instance.ensureLoaded()); // [HF-WIRE-9]
  }

  Future<void> _loadProfile() async {
    setState(() => _ps = const AsyncLoading());
    try {
      final p = await (widget.repo ?? Services.instance.reelsRepo).profile(widget.id);
      if (mounted) setState(() => _ps = AsyncData(p));
    } catch (e) {
      if (mounted) setState(() => _ps = AsyncFailure(e));
    }
  }

  Widget _realGrid(BuildContext context, PublicProfile pp) {
    if (pp.reels.isEmpty) {
      return SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.only(top: 6), child: Text('No videos yet.', style: t(15, color: C.muted, w: FontWeight.w700))));
    }
    return SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 0.62),
      itemCount: pp.reels.length,
      itemBuilder: (_, i) {
        final r = pp.reels[i];
        return ProfileVideoTile(
          key: ValueKey('video-${r.id}'),
          index: i,
          views: compactCount(r.views),
          thumbUrl: r.thumbUrl,
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => ReelViewer(reels: pp.reels, start: i))),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    PublicProfile? pp;
    if (PresenceBridge.real) {
      final s = _ps;
      if (s is! AsyncData<PublicProfile>) {
        return Scaffold(
          backgroundColor: C.cream,
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
    final today = dayOnly(DateTime.now());
    final openDays = [for (var i = 0; i < 21; i++) today.add(Duration(days: i))].where((d) => slotsFor(who, d).isNotEmpty).take(10).toList();
    final first = who.name.split(' ').first;
    return Scaffold(
      backgroundColor: C.ivory,
      body: ListenableBuilder(
        listenable: prof != null ? Listenable.merge([demo, FavouritesStore.instance]) : demo,
        builder: (context, _) {
          final realSlug = prof?.host.slug; // [HF-WIRE-9] real hearts are saved by influencer slug
          final faved = realSlug != null ? FavouritesStore.instance.isFav(realSlug) : firstReel != null && demo.isFav(firstReel.id);
          const side = EdgeInsets.symmetric(horizontal: 16);
          return SafeArea(
            bottom: false,
            child: CustomScrollView(
              slivers: [
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  sliver: SliverList.list(children: [
                    // [HF-APP-DESI-4] approved profile layout
                    ProfileCover(
                      who: who,
                      line: [who.handle, who.city, who.niche].where((e) => e.isNotEmpty).join(' · '), // [HF-WIRE-12] a live profile has no city/niche
                      faved: faved,
                      onHeart: (firstReel != null || realSlug != null)
                          ? () => requireAccount(
                                context,
                                () => realSlug != null
                                    ? unawaited(toggleFavourite(realSlug, onError: (_) => toast(context, 'Could not save that. Please try again.')))
                                    : demo.toggleFav(firstReel!.id),
                                reason: 'to save favourites',
                              )
                          : null,
                    ),
                    const SizedBox(height: 14),
                    ProfileStats(likes: who.likes, videos: '${who.videos}', rate: '₹${who.rate}/min'),
                    const SizedBox(height: 14),
                    ProfileBio(bio: who.bio, tags: [who.niche, who.city].where((e) => e.isNotEmpty).toList()),
                    const SizedBox(height: 14),
                    ProfileActions(
                      online: who.online,
                      first: first,
                      onCall: () => startCall(context, who),
                      onBook: () => context.push('/book/${who.id}'),
                      notify: NotifyMeButton(slug: who.id, firstName: first, big: true),
                    ),
                    const SizedBox(height: 14),
                    ProfileTabs(tab: _tab, onTab: (i) => setState(() => _tab = i)),
                    const SizedBox(height: 14),
                  ]),
                ),
                if (_tab == 0)
                  SliverPadding(
                    padding: side,
                    sliver: prof != null
                        ? _realGrid(context, prof)
                        : SliverGrid.count(
                            crossAxisCount: 3,
                            mainAxisSpacing: 8,
                            crossAxisSpacing: 8,
                            childAspectRatio: 0.62,
                            children: [
                              for (var i = 0; i < 9; i++)
                                ProfileVideoTile(index: i, views: '${[82, 41, 110, 23, 310, 9, 57, 64, 18][i]}K', onTap: () => toast(context, 'Opens this reel (demo)')),
                            ],
                          ),
                  )
                else if (BookingsBridge.real) // [HF-WIRE-8] real open dates and free times
                  SliverPadding(padding: side, sliver: SliverToBoxAdapter(child: RealProfileCalendar(slug: who.id)))
                else
                  SliverPadding(
                    padding: side,
                    sliver: SliverToBoxAdapter(
                      child: FreeTimesCard(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          SizedBox(
                            height: 68,
                            child: ListView.separated(
                              scrollDirection: Axis.horizontal,
                              itemCount: openDays.length,
                              separatorBuilder: (_, __) => const SizedBox(width: 8),
                              itemBuilder: (_, i) => CalDayChip(weekday: weekdayShort[openDays[i].weekday - 1], day: openDays[i].day, on: i == _day, onTap: () => setState(() => _day = i)),
                            ),
                          ),
                          if (openDays.isNotEmpty) ...[
                            const SizedBox(height: 14),
                            Text(calDayTitle(openDays[_day.clamp(0, openDays.length - 1)]), style: t(15, w: FontWeight.w800)),
                            const SizedBox(height: 8),
                            Wrap(spacing: 8, runSpacing: 8, children: [
                              for (final s in slotsFor(who, openDays[_day.clamp(0, openDays.length - 1)]))
                                CalSlotChip(
                                  label: s,
                                  onTap: () => context.push('/book/${who.id}?day=${dayKey(openDays[_day.clamp(0, openDays.length - 1)])}&slot=${Uri.encodeComponent(s)}'),
                                ),
                            ]),
                          ],
                          const SizedBox(height: 12),
                          Text('Pick a time — we ring you both at that minute.', style: t(14, color: C.muted, w: FontWeight.w700)),
                        ]),
                      ),
                    ),
                  ),
                const SliverPadding(padding: EdgeInsets.fromLTRB(16, 14, 16, 32), sliver: SliverToBoxAdapter(child: DesiMogra())),
              ],
            ),
          );
        },
      ),
    );
  }
}
