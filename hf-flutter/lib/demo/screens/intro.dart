import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../core/deep_links.dart';
import '../../data/repos/config_repo.dart';
import '../../data/services.dart';
import '../../data/intro_store.dart';
import '../../data/auth/clerk_client.dart';
import '../../data/telemetry.dart';
import '../../ui/update_prompt.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../inf_kit.dart';
import '../money_kit.dart';

/// Opening: a colourful leheriya 3-2-1, then intro (first open) or Reels.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key, this.boot, this.hasLocalCredential});

  /// Test seams for slow boot and local secure storage; production uses Services/Clerk.
  final Future<void> Function()? boot;
  final Future<bool> Function()? hasLocalCredential;

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _sweep = AnimationController(vsync: this, duration: const Duration(milliseconds: 600))..repeat();
  int _n = 3;
  Timer? _timer;
  Future<void> _boot = Future<void>.value();
  late final Future<bool> _introSeen;
  late final Future<bool> _hasCredential;
  bool _bootTimedOut = false;

  @override
  void initState() {
    super.initState();
    // Real start-up work runs behind the countdown (HF-WIRE-1A): intro-seen flag, Clerk session restore,
    // /api/hf/me and app config. Network boot is capped; the local intro/credential reads
    // are awaited separately so a slow network cannot replay intro for an existing install.
    _introSeen = IntroStore.read();
    _hasCredential = (widget.hasLocalCredential ?? ClerkClient.hasLocalCredential)();
    _boot = (widget.boot ?? Services.instance.boot)().timeout(const Duration(milliseconds: 1500), onTimeout: () { _bootTimedOut = true; }).catchError((Object _) { _bootTimedOut = true; });
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
    final seen = await _introSeen;
    if (!mounted) return;
    final hasCredential = await _hasCredential;
    if (!mounted) return;
    final skip = seen || demo.introSeen || demo.signedIn || Services.instance.isSignedIn || hasCredential;
    Telemetry.event('hf_intro_decision', {'show_intro': !skip, 'boot_timed_out': _bootTimedOut});
    // Persist before displaying onboarding so restart/login cannot replay it.
    await IntroStore.markSeen();
    demo.introSeen = true;
    if (!mounted) return;
    context.go(skip ? '/reels' : '/intro');
    DeepLinks.markReady();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _sweep.dispose();
    super.dispose();
  }

  /// [HF-APP-DESI-14] approved splash: dark plum, gold dots, flower string, leheriya countdown.
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.deep,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const _PlumBackdrop(),
          Positioned(left: 12, right: 12, top: MediaQuery.paddingOf(context).top, child: const FlowerString()),
          const Positioned(left: -24, bottom: 120, child: Marigold(size: 90)),
          const Positioned(right: -18, top: 150, child: Hibiscus(size: 64)),
          Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: const Color(0x8CFBBF24), width: 3)),
                    child: CountdownLeader(number: _n, sweep: _sweep, size: 250),
                  ),
                  const SizedBox(height: 36),
                  Text('ROLLING OUT THE COLOURS…', textAlign: TextAlign.center, style: t(22, color: C.lemon, w: FontWeight.w900, ls: 0.06)),
                  const SizedBox(height: 8),
                  Text('Rangili is unfolding the next reel.', textAlign: TextAlign.center, style: t(16, color: const Color(0xFFF7E6F0), w: FontWeight.w700)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Dark plum radial background with gold dots (splash and intro page 2).
class _PlumBackdrop extends StatelessWidget {
  const _PlumBackdrop();
  @override
  Widget build(BuildContext context) => const DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(center: Alignment(0, -.3), radius: 1.2, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .45, 1]),
        ),
        child: CustomPaint(painter: _GoldDots(), size: Size.infinite),
      );
}

class _GoldDots extends CustomPainter {
  const _GoldDots();
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = const Color(0x24FBBF24);
    for (var y = 9.0; y < size.height; y += 18) {
      for (var x = 9.0; x < size.width; x += 18) {
        canvas.drawCircle(Offset(x, y), 1.5, p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
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
          Text('$number', style: t(size * 0.52, color: C.lemon, w: FontWeight.w900, h: 1).copyWith(shadows: const [Shadow(color: Color(0x66000000), offset: Offset(0, 6), blurRadius: 18)])),
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

  Future<void> _done() async {
    await IntroStore.markSeen();
    if (!mounted) return;
    demo.finishIntro();
    context.go('/reels');
  }

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  /// [HF-APP-DESI-14] approved intro: cream page 1, dark plum page 2.
  @override
  Widget build(BuildContext context) {
    final dark = _page == 1;
    return Scaffold(
      backgroundColor: dark ? C.deep : C.ivory,
      body: Stack(
        children: [
          PageView(
            controller: _pages,
            onPageChanged: (p) => setState(() => _page = p),
            children: const [_IntroOne(), _IntroTwo()],
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 24,
            right: 16,
            child: TextButton(
              onPressed: _done,
              style: TextButton.styleFrom(
                minimumSize: const Size(64, 44),
                backgroundColor: dark ? const Color(0x24FFFFFF) : C.white,
                shape: StadiumBorder(side: BorderSide(color: dark ? const Color(0x59FFFFFF) : C.line, width: 1.5)),
              ),
              child: Text('Skip', style: t(15, color: dark ? C.white : C.maroon, w: FontWeight.w800)),
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
                          color: dark ? (i == _page ? C.lemon : const Color(0x4DFFFFFF)) : (i == _page ? C.rani : C.line),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                _page == 0
                    ? BookBottomButton(
                        label: 'NEXT',
                        plum: true,
                        padding: EdgeInsets.zero,
                        onTap: () => _pages.nextPage(duration: const Duration(milliseconds: 350), curve: Curves.easeOutCubic),
                      )
                    : MoneyPill(label: 'START WATCHING', gold: true, height: 60, onTap: _done),
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
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: FlowerString()),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            decoration: BoxDecoration(color: C.blush, borderRadius: BorderRadius.circular(999)),
            child: Text('AAO, RANG BAZAAR', style: t(14, color: C.rani, w: FontWeight.w800, ls: 0.1)),
          ),
          const SizedBox(height: 10),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: 'So much\n', style: t(48, color: C.maroon, w: FontWeight.w900, h: 1)),
              TextSpan(text: 'colour!', style: t(48, color: C.rani, w: FontWeight.w900, h: 1)),
            ]),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 10),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(30),
                  border: Border.all(color: const Color(0xFFF8C4D9), width: 1.5),
                  gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFFFF0F6), Color(0xFFFFF6EA)]),
                ),
                child: const Stack(fit: StackFit.expand, children: [
                  Padding(padding: EdgeInsets.all(8), child: Art('intro/bazaar-hero.webp', fallback: ArtStandIn('BAZAAR ART\nChhotu + bandhani stall', color: C.lemon))),
                  Positioned(left: -14, top: -14, child: Marigold(size: 58)),
                  Positioned(right: -10, bottom: -10, child: Hibiscus(size: 48)),
                ]),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 16, 28, 130),
            child: Text(
              'Reels from the influencers you love, in every colour. Swipe up for the next one.',
              textAlign: TextAlign.center,
              style: t(18, w: FontWeight.w700, h: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}

class _IntroTwo extends StatelessWidget {
  const _IntroTwo();

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        const _PlumBackdrop(),
        SafeArea(
          bottom: false,
          child: Column(
            children: [
              const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: FlowerString()),
              const SizedBox(height: 40),
              Text.rich(
                TextSpan(children: [
                  TextSpan(text: 'Your favourite\ninfluencer,\n', style: t(40, color: C.lemon, w: FontWeight.w900, h: 1.02)),
                  TextSpan(text: 'on call.', style: t(40, color: C.white, w: FontWeight.w900, h: 1.02)),
                ]),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              Expanded(
                child: Center(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        FractionallySizedBox(
                          widthFactor: .9,
                          heightFactor: .9,
                          child: Container(
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              gradient: RadialGradient(colors: [C.marigold, C.saffron], stops: [0, .7]),
                              boxShadow: [BoxShadow(color: Color(0x2EFBBF24), spreadRadius: 10)],
                            ),
                          ),
                        ),
                        const Art('intro/chhotu.webp', fallback: SizedBox(width: 160, height: 200, child: ArtStandIn('CHHOTU\nat the stall'))),
                      ],
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 30),
                child: Text(
                  '${Brand.name} is where you talk to your favourite influencers on a private phone call.',
                  textAlign: TextAlign.center,
                  style: t(17, color: const Color(0xFFF7E6F0), w: FontWeight.w700, h: 1.45),
                ),
              ),
              const SizedBox(height: 14),
              Container(
                margin: const EdgeInsets.symmetric(horizontal: 20),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: const Color(0x24FBBF24), borderRadius: BorderRadius.circular(22), border: Border.all(color: const Color(0x80FBBF24), width: 1.5)),
                child: Row(
                  children: [
                    const SizedBox(width: 46, height: 48, child: Art('intro/invite-vote-badge.webp', fallback: Icon(Icons.how_to_vote_rounded, color: C.lemon))),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text.rich(
                        TextSpan(children: [
                          TextSpan(text: 'Not here yet? ', style: t(15, color: C.lemon, w: FontWeight.w900)),
                          TextSpan(text: 'Find them in Search and tap ', style: t(15, color: C.white, w: FontWeight.w700)),
                          TextSpan(text: 'Invite', style: t(15, color: C.lemon, w: FontWeight.w900)),
                          TextSpan(text: ' — every tap is a vote to bring them in.', style: t(15, color: C.white, w: FontWeight.w700)),
                        ]),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 140),
            ],
          ),
        ),
      ],
    );
  }
}
