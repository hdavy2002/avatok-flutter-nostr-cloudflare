import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/models/reel.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../data.dart';
import '../notify_me_button.dart';
import '../presence_bridge.dart';
import '../reel_viewer.dart';
import '../reels_real.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
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
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, mainAxisSpacing: 6, crossAxisSpacing: 6, childAspectRatio: 0.62),
      itemCount: pp.reels.length,
      itemBuilder: (_, i) {
        final r = pp.reels[i];
        return GestureDetector(
          key: ValueKey('video-${r.id}'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => ReelViewer(reels: pp.reels, start: i))),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Stack(
              fit: StackFit.expand,
              children: [
                r.thumbUrl == null
                    ? const ColoredBox(color: C.cinema)
                    : Image.network(r.thumbUrl!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: C.cinema)),
                Positioned(left: 6, bottom: 6, child: Text('▶ ${compactCount(r.views)}', style: t(12, color: C.ivory))),
              ],
            ),
          ),
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
    return Scaffold(
      body: ListenableBuilder(
        listenable: demo,
        builder: (context, _) {
          final faved = firstReel != null && demo.isFav(firstReel.id);
          return CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Container(
                      height: 210,
                      width: double.infinity,
                      decoration: BoxDecoration(gradient: RadialGradient(center: const Alignment(0.2, -0.4), radius: 1.3, colors: [who.tones.first, who.tones.last, C.cinema])),
                      child: who.portrait == null
                          ? null
                          : Opacity(opacity: 0.55, child: Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter)),
                    ),
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: 22,
                      child: Art('profile/gota-border.webp', fit: BoxFit.fitHeight, alignment: Alignment.centerLeft, fallback: CustomPaint(painter: _BulbPainter())),
                    ),
                    Positioned(top: MediaQuery.paddingOf(context).top + 10, left: 16, child: const BackBtn()),
                    if (firstReel != null)
                      Positioned(
                        top: MediaQuery.paddingOf(context).top + 10,
                        right: 16,
                        child: BrassKnob(
                          size: 46,
                          label: faved ? 'Remove from favourites' : 'Add to favourites',
                          onTap: () => requireAccount(context, () => demo.toggleFav(firstReel.id), reason: 'to save favourites'),
                          child: Icon(faved ? Icons.favorite_rounded : Icons.favorite_border_rounded, color: faved ? C.rani : C.deep, size: 22),
                        ),
                      ),
                    Positioned(left: 22, bottom: -62, child: Avatar(who, size: 124)),
                    Positioned(left: 158, bottom: -40, child: StatusPill(online: who.online)),
                  ],
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(22, 76, 22, 0),
                sliver: SliverList.list(
                  children: [
                    Text(who.name, style: t(32, color: C.maroon, ls: 0.03, h: 1.05)),
                    const SizedBox(height: 4),
                    Text('${who.handle} · ${who.city} · ${who.niche}', style: t(15, color: C.tan)),
                    const SizedBox(height: 10),
                    Text(who.bio, style: t(16, w: FontWeight.w700, h: 1.45)),
                    const SizedBox(height: 16),
                    Container(
                      decoration: const BoxDecoration(border: Border.symmetric(horizontal: BorderSide(color: C.deep, width: 3))),
                      child: IntrinsicHeight(
                        child: Row(
                          children: [
                            _stat('Likes', who.likes),
                            const VerticalDivider(color: C.brass, width: 2, thickness: 2),
                            _stat('Videos', '${who.videos}'),
                            const VerticalDivider(color: C.brass, width: 2, thickness: 2),
                            _stat('Rate', '₹${who.rate}/min'),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        Expanded(
                          flex: 3,
                          child: who.online
                              ? TicketButton(label: 'CALL NOW', labelSize: 18, stubIcon: Icons.call_rounded, stubWidth: 52, height: 60, onTap: () => startCall(context, who))
                              : Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Container(
                                      height: 60,
                                      alignment: Alignment.center,
                                      decoration: BoxDecoration(color: C.sand, borderRadius: BorderRadius.circular(16)),
                                      child: Text('Offline right now', style: t(16, color: C.muted)),
                                    ),
                                    const SizedBox(height: 8),
                                    NotifyMeButton(slug: who.id, firstName: who.name.split(' ').first),
                                  ],
                                ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          flex: 2,
                          child: ChunkyButton(label: 'BOOK', filled: false, height: 60, onTap: () => context.push('/book/${who.id}')),
                        ),
                      ],
                    ),
                    const SizedBox(height: 22),
                    Container(
                      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sand, width: 3))),
                      child: Row(children: [_tabBtn('Videos', 0), _tabBtn('Calendar', 1)]),
                    ),
                    const SizedBox(height: 14),
                  ],
                ),
              ),
              if (_tab == 0)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(22, 0, 22, 40),
                  sliver: prof != null ? _realGrid(context, prof) : SliverGrid.count(
                    crossAxisCount: 3,
                    mainAxisSpacing: 6,
                    crossAxisSpacing: 6,
                    childAspectRatio: 0.62,
                    children: [
                      for (var i = 0; i < 9; i++)
                        GestureDetector(
                          onTap: () => toast(context, 'Opens this reel (demo)'),
                          child: Container(
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(10),
                              gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [who.tones.first.withValues(alpha: 1 - i * 0.06), who.tones.last]),
                            ),
                            alignment: Alignment.bottomLeft,
                            padding: const EdgeInsets.all(6),
                            child: Text('▶ ${[82, 41, 110, 23, 310, 9, 57, 64, 18][i]}K', style: t(12, color: C.ivory)),
                          ),
                        ),
                    ],
                  ),
                )
              else
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(22, 0, 22, 40),
                  sliver: SliverList.list(
                    children: [
                      SizedBox(
                        height: 66,
                        child: ListView.separated(
                          scrollDirection: Axis.horizontal,
                          itemCount: openDays.length,
                          separatorBuilder: (_, __) => const SizedBox(width: 8),
                          itemBuilder: (_, i) {
                            final on = i == _day;
                            final d = openDays[i];
                            return GestureDetector(
                              onTap: () => setState(() => _day = i),
                              child: Container(
                                width: 62,
                                decoration: BoxDecoration(
                                  color: on ? C.maroon : C.paper,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: on ? C.maroon : C.sand, width: 2),
                                ),
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Text(weekdayShort[d.weekday - 1], style: t(12, color: on ? C.gold : C.deep)),
                                    Text('${d.day}', style: t(20, color: on ? C.gold : C.deep)),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                      ),
                      const SizedBox(height: 14),
                      if (openDays.isNotEmpty)
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            for (final s in slotsFor(who, openDays[_day.clamp(0, openDays.length - 1)]))
                              ActionChip(
                                label: Text(s, style: t(15, color: C.maroon)),
                                backgroundColor: C.paper,
                                shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                                onPressed: () => context.push('/book/${who.id}?day=${dayKey(openDays[_day.clamp(0, openDays.length - 1)])}&slot=${Uri.encodeComponent(s)}'),
                              ),
                          ],
                        ),
                      const SizedBox(height: 12),
                      Text('Pick a time — we ring you both at that minute.', style: t(14, color: C.muted, w: FontWeight.w700)),
                    ],
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Expanded(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Column(
          children: [
            Text(label, style: t(13, color: C.tan)),
            const SizedBox(height: 2),
            FittedBox(child: Text(value, style: t(22, color: C.maroon))),
          ],
        ),
      ),
    );
  }

  Widget _tabBtn(String label, int i) {
    final on = _tab == i;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _tab = i),
        child: Container(
          height: 48,
          alignment: Alignment.center,
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: on ? C.marigold : C.clear, width: 4))),
          child: Text(label, style: t(17, color: on ? C.maroon : C.muted)),
        ),
      ),
    );
  }
}

class _BulbPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = C.maroon);
    final r = size.height * 0.28;
    for (var x = r * 2; x < size.width; x += r * 4) {
      canvas.drawCircle(Offset(x, size.height / 2), r + 2, Paint()..color = C.brass);
      canvas.drawCircle(Offset(x, size.height / 2), r, Paint()..color = C.lemon);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
