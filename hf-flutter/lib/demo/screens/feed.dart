import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../data.dart';
import '../online_now_pill.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'sheets.dart';

/// Reels feed: full-screen cards, swipe up/down. Only ONLINE influencers are shown (HF-REEL-4).
class FeedScreen extends StatefulWidget {
  const FeedScreen({super.key});

  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
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
                const Expanded(
                  child: Text(Brand.name, style: TextStyle(fontFamily: 'Comfortaa', fontSize: 21, color: C.ivory, fontWeight: FontWeight.w400)),
                ),
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
  const ReelPage({super.key, required this.reel, required this.active});

  final Reel reel;
  final bool active;

  @override
  State<ReelPage> createState() => _ReelPageState();
}

/// Stand-in "video": the influencer's art with a slow zoom and a progress bar, until real reels are wired.
class _ReelPageState extends State<ReelPage> with SingleTickerProviderStateMixin {
  late final AnimationController _play = AnimationController(vsync: this, duration: const Duration(seconds: 12));

  @override
  void initState() {
    super.initState();
    if (widget.active) _play.repeat();
  }

  @override
  void didUpdateWidget(covariant ReelPage old) {
    super.didUpdateWidget(old);
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

  @override
  Widget build(BuildContext context) {
    final r = widget.reel;
    final who = r.who;
    return ListenableBuilder(
      listenable: demo,
      builder: (context, _) {
        final faved = demo.isFav(r.id);
        return Stack(
          fit: StackFit.expand,
          children: [
            // the "video"
            AnimatedBuilder(
              animation: _play,
              builder: (_, child) => Transform.scale(scale: 1 + 0.08 * _play.value, child: child),
              child: Container(
                decoration: BoxDecoration(
                  gradient: RadialGradient(center: const Alignment(0, -0.3), radius: 1.2, colors: [who.tones.first, who.tones.last, C.cinema]),
                ),
                child: who.portrait == null
                    ? Center(child: Text('[ REEL VIDEO ]', style: t(14, color: C.ivory.withValues(alpha: 0.5), ls: 0.12)))
                    : Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter,
                        fallback: Center(child: Text('[ REEL VIDEO ]', style: t(14, color: C.ivory.withValues(alpha: 0.5), ls: 0.12)))),
              ),
            ),
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Color(0xBF1A0B26), Color(0x001A0B26), Color(0x001A0B26), Color(0xEB1A0B26)],
                  stops: [0, 0.18, 0.5, 0.86],
                ),
              ),
            ),
            const Positioned(left: 0, top: 0, bottom: 0, child: SprocketRail()),
            const Positioned(right: 0, top: 0, bottom: 0, child: SprocketRail()),
            // progress
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
            // side knobs
            Positioned(
              right: 18,
              bottom: 150,
              child: Column(
                children: [
                  Semantics(
                    button: true,
                    label: 'Open ${who.name} profile',
                    child: GestureDetector(
                      onTap: () => context.push('/profile/${who.id}'),
                      child: Stack(
                        clipBehavior: Clip.none,
                        alignment: Alignment.bottomCenter,
                        children: [
                          Avatar(who, size: 58),
                          Positioned(
                            bottom: -9,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                              decoration: BoxDecoration(color: C.rani, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.cinema, width: 2)),
                              child: Text('LIVE', style: t(11, color: C.ivory, ls: 0.06)),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                  BrassKnob(
                    label: faved ? 'Remove from favourites' : 'Add to favourites',
                    onTap: () => requireAccount(context, () => demo.toggleFav(r.id), reason: 'to save favourites'),
                    child: Icon(faved ? Icons.favorite_rounded : Icons.favorite_border_rounded, color: faved ? C.rani : C.deep, size: 26),
                  ),
                  const SizedBox(height: 4),
                  Text(_count(r.hearts + (faved ? 1 : 0)), style: t(13, color: C.ivory)),
                  const SizedBox(height: 14),
                  BrassKnob(
                    label: 'Share this reel',
                    onTap: () => toast(context, 'Share link copied (demo)'),
                    child: const Icon(Icons.reply_rounded, color: C.deep, textDirection: TextDirection.rtl),
                  ),
                ],
              ),
            ),
            // caption + call now
            Positioned(
              left: 24,
              right: 24,
              bottom: 20,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(right: 70),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            GestureDetector(
                              onTap: () => context.push('/profile/${who.id}'),
                              child: Text(who.name, style: t(22, color: C.ivory, ls: 0.02)),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                              decoration: BoxDecoration(color: C.marigold, borderRadius: BorderRadius.circular(999)),
                              child: Text('₹${who.rate}/min', style: t(13, color: C.deep)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text('${who.handle} · ${who.followers} followers', style: t(14, color: C.gold, w: FontWeight.w700)),
                        const SizedBox(height: 6),
                        Text(r.caption, style: t(15, color: C.ivory, w: FontWeight.w600, h: 1.4)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  TicketButton(
                    label: 'CALL NOW',
                    icon: Icons.call_rounded,
                    stubTop: 'RATE',
                    stubBottom: '₹${who.rate}/min',
                    onTap: () => startCall(context, who),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  static String _count(int n) => n >= 1000 ? '${(n / 1000).toStringAsFixed(1)}K' : '$n';
}
