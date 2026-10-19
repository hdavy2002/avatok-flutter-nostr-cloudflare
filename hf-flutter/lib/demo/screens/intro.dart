import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../core/deep_links.dart';
import '../../data/repos/config_repo.dart';
import '../../data/services.dart';
import '../../ui/update_prompt.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

/// Opening: a colourful leheriya 3-2-1, then intro (first open) or Reels.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _sweep = AnimationController(vsync: this, duration: const Duration(milliseconds: 600))..repeat();
  int _n = 3;
  Timer? _timer;
  Future<void> _boot = Future<void>.value();

  @override
  void initState() {
    super.initState();
    // Real start-up work runs behind the countdown (HF-WIRE-1A): intro-seen flag, Clerk session restore,
    // /api/hf/me and the app config. It is capped below the countdown and swallows its own failures, so a
    // slow or missing network never blocks or crashes the splash; the demo flow carries on regardless.
    _boot = Services.instance.boot().timeout(const Duration(milliseconds: 1500), onTimeout: () {}).catchError((Object _) {});
    _timer = Timer.periodic(const Duration(milliseconds: 600), (t) {
      if (_n > 1) {
        setState(() => _n--);
      } else {
        t.cancel();
        unawaited(_finish());
      }
    });
  }

  Future<void> _finish() async {
    try {
      await _boot;
    } catch (_) {
      // boot never throws; belt and braces
    }
    if (!mounted) return;
    final status = Services.instance.updateStatus;
    if (status != UpdateStatus.none) {
      await showUpdatePrompt(context, status);
      if (!mounted) return;
    }
    context.go(demo.introSeen ? '/reels' : '/intro');
    DeepLinks.markReady();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _sweep.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.cinema,
      body: Stack(
        children: [
          const Positioned(left: 0, top: 0, bottom: 0, child: SprocketRail()),
          const Positioned(right: 0, top: 0, bottom: 0, child: SprocketRail()),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                CountdownLeader(number: _n, sweep: _sweep),
                const SizedBox(height: 36),
                Text('ROLLING OUT THE COLOURS…', style: t(22, color: C.gold, ls: 0.06)),
                const SizedBox(height: 8),
                Text('Rangili is unfolding the next reel.', style: t(16, color: C.cream, w: FontWeight.w700)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class CountdownLeader extends StatelessWidget {
  const CountdownLeader({super.key, required this.number, required this.sweep, this.size = 240});

  final int number;
  final Animation<double> sweep;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Positioned.fill(
            child: Art(
              'loading/leheriya-loader.webp',
              fallback: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, color: C.deep, border: Border.all(color: C.brass, width: 6)),
                child: CustomPaint(painter: _CrossPainter()),
              ),
            ),
          ),
          Positioned.fill(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: AnimatedBuilder(
                animation: sweep,
                builder: (_, __) => CustomPaint(painter: _SweepPainter(sweep.value)),
              ),
            ),
          ),
          Text('$number', style: t(size * 0.5, color: C.gold, h: 1)),
        ],
      ),
    );
  }
}

class _CrossPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = C.gold.withValues(alpha: 0.45)
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    final c = size.center(Offset.zero);
    canvas.drawLine(Offset(c.dx, 0), Offset(c.dx, size.height), p);
    canvas.drawLine(Offset(0, c.dy), Offset(size.width, c.dy), p);
    canvas.drawCircle(c, size.width * 0.42, p);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _SweepPainter extends CustomPainter {
  _SweepPainter(this.v);
  final double v;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawArc(rect, -math.pi / 2 + v * 2 * math.pi, 1.2, true, Paint()..color = C.marigold.withValues(alpha: 0.45));
  }

  @override
  bool shouldRepaint(covariant _SweepPainter old) => old.v != v;
}

/// Two intro screens (owner: 1–2 intro screens, then Reels).
class IntroScreen extends StatefulWidget {
  const IntroScreen({super.key});

  @override
  State<IntroScreen> createState() => _IntroScreenState();
}

class _IntroScreenState extends State<IntroScreen> {
  final _pages = PageController();
  int _page = 0;

  void _done() {
    demo.finishIntro();
    context.go('/reels');
  }

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _page == 0 ? C.ivory : C.deep,
      body: Stack(
        children: [
          PageView(
            controller: _pages,
            onPageChanged: (p) => setState(() => _page = p),
            children: const [_IntroOne(), _IntroTwo()],
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 8,
            right: 16,
            child: TextButton(
              onPressed: _done,
              style: TextButton.styleFrom(backgroundColor: C.ivory, shape: const StadiumBorder()),
              child: Text('Skip', style: t(15)),
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: MediaQuery.paddingOf(context).bottom + 24,
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (var i = 0; i < 2; i++)
                      AnimatedContainer(
                        duration: const Duration(milliseconds: 250),
                        margin: const EdgeInsets.symmetric(horizontal: 4),
                        width: i == _page ? 26 : 9,
                        height: 9,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(999),
                          color: _page == 0 ? (i == _page ? C.maroon : C.sand) : (i == _page ? C.gold : const Color(0xFFF7A8CB)),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 18),
                _page == 0
                    ? ChunkyButton(
                        label: 'NEXT',
                        dark: true,
                        height: 60,
                        onTap: () => _pages.nextPage(duration: const Duration(milliseconds: 350), curve: Curves.easeOutCubic),
                      )
                    : ChunkyButton(label: 'START WATCHING', height: 60, onTap: _done),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _IntroOne extends StatelessWidget {
  const _IntroOne();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Valance(),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          decoration: BoxDecoration(color: C.maroon, borderRadius: BorderRadius.circular(999)),
          child: Text('AAO, RANG BAZAAR', style: t(14, color: C.gold, ls: 0.16)),
        ),
        const SizedBox(height: 10),
        const Headline(solid: 'SO MUCH', outline: 'COLOUR!', size: 56, align: TextAlign.center),
        const SizedBox(height: 8),
        const Expanded(
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 12),
            child: Art('intro/bazaar-hero.webp', fallback: ArtStandIn('BAZAAR ART\nChhotu + bandhani stall', color: C.lemon)),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(32, 16, 32, 130),
          child: Text(
            'Reels from the influencers you love, in every colour. Swipe up for the next one.',
            textAlign: TextAlign.center,
            style: t(18, w: FontWeight.w700, h: 1.45),
          ),
        ),
      ],
    );
  }
}

class _IntroTwo extends StatelessWidget {
  const _IntroTwo();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          const SizedBox(height: 40),
          const Headline(solid: 'YOUR', outline: 'FAVOURITE', size: 42, color: C.gold, align: TextAlign.center),
          Text('INFLUENCER,\nON CALL.', textAlign: TextAlign.center, style: t(42, color: C.gold, ls: 0.04, h: 1.02)),
          const SizedBox(height: 12),
          Expanded(
            child: Stack(
              alignment: Alignment.center,
              children: [
                Container(width: 250, height: 250, decoration: const BoxDecoration(shape: BoxShape.circle, color: C.turquoise)),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12),
                  child: Art('intro/chhotu.webp', fallback: SizedBox(width: 160, height: 200, child: ArtStandIn('CHHOTU\nat the stall'))),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 30),
            child: Text(
              '${Brand.name} is where you talk to your favourite influencers on a private phone call.',
              textAlign: TextAlign.center,
              style: t(18, color: C.ivory, h: 1.45),
            ),
          ),
          const SizedBox(height: 14),
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 24),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: C.maroon, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.lemon, width: 2)),
            child: Row(
              children: [
                const SizedBox(width: 46, height: 46, child: Art('intro/invite-vote-badge.webp', fallback: BrassKnob(label: 'Invite', size: 46, child: Icon(Icons.add_rounded, color: C.deep)))),
                const SizedBox(width: 12),
                Expanded(
                  child: Text.rich(
                    TextSpan(children: [
                      TextSpan(text: 'Not here yet? ', style: t(15, color: C.gold)),
                      TextSpan(text: 'Find them in Search and tap ', style: t(15, color: C.ivory, w: FontWeight.w700)),
                      TextSpan(text: 'Invite', style: t(15, color: C.gold)),
                      TextSpan(text: ' — every tap is a vote to bring them in.', style: t(15, color: C.ivory, w: FontWeight.w700)),
                    ]),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 140),
        ],
      ),
    );
  }
}
