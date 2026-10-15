import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/boot.dart';
import '../../../core/router/startup_navigation.dart';
import '../../intro/data/install_intro_store.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';

/// Boot restoration only, with no artificial animation delay. Public browsing never requires consent.
///
/// HF-MOTION-A: while restoration runs, the sun hill rises and the beaver waves up from behind it. The
/// animation is decoration only: routing starts the moment restoration is ready and never waits for it.
class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  /// Hill height (fraction of the screen) at the start and the end of the rise.
  static const double riseFrom = 0.08;
  static const double riseTo = 0.38;

  /// How long the rise takes when animations are on. Purely visual.
  static const Duration riseDuration = Duration(milliseconds: 1100);

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _rise = AnimationController(
    vsync: this,
    duration: SplashScreen.riseDuration,
  );
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (hfReduceMotion(context)) {
      _rise.value = 1;
    } else {
      _rise.forward();
    }
  }

  @override
  void dispose() {
    _rise.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    try {
      await ref.read(appBootProvider.future);
    } catch (_) {
      // boot never throws, and a failure must not strand the person here
    }
    if (!mounted) return;
    final completed = await ref.read(installIntroStoreProvider).isCompleted();
    if (!mounted) return;
    if (!completed) {
      context.go(Routes.intro);
      return;
    }
    await ref.read(startupNavigationProvider).openLanding();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final sky = dark ? HfColors.darkBg : null;
    return Scaffold(
      backgroundColor: dark ? HfColors.darkBg : HfColors.page,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final w = constraints.maxWidth;
          final h = constraints.maxHeight;
          final beaver = math.min(200.0, math.min(w * 0.5, h * 0.26));
          // The beaver's feet sink this far into the crest, so it stands in the hill.
          final sink = beaver * 0.16;
          final brandBottom = math.min(
            h * 0.85,
            h * SplashScreen.riseTo + beaver - sink,
          );
          return AnimatedBuilder(
            animation: _rise,
            builder: (context, _) {
              final t = _rise.value;
              final rise =
                  SplashScreen.riseFrom +
                  (SplashScreen.riseTo - SplashScreen.riseFrom) *
                      Curves.easeOutCubic.transform(t);
              // The beaver starts below the crest (hidden by the front hill) and pops up in the second half.
              final lift = Curves.easeOutBack.transform(
                ((t - 0.35) / 0.65).clamp(0.0, 1.0).toDouble(),
              );
              return Stack(
                children: [
                  Positioned.fill(
                    child: RepaintBoundary(
                      child: CustomPaint(
                        painter: SunHillPainter(rise: rise, sky: sky),
                      ),
                    ),
                  ),
                  Positioned(
                    key: const ValueKey<String>('splash-beaver'),
                    left: (w - beaver) / 2,
                    bottom: h * rise - sink - beaver * (1 - lift),
                    width: beaver,
                    height: beaver,
                    child: BeaverGuide(
                      pose: BeaverPose.wave,
                      size: beaver,
                      entrance: false,
                    ),
                  ),
                  // The same hill again, in front, so the beaver rises from behind it.
                  Positioned.fill(
                    child: IgnorePointer(
                      child: RepaintBoundary(
                        child: CustomPaint(
                          painter: SunHillPainter(
                            rise: rise,
                            sky: const Color(0x00000000),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: brandBottom,
                    child: SafeArea(
                      bottom: false,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: HfSpacing.section,
                          vertical: HfSpacing.lg,
                        ),
                        child: Center(
                          child: FittedBox(
                            fit: BoxFit.scaleDown,
                            child: PopIn(
                              duration: const Duration(milliseconds: 420),
                              // [HF-LOGO-1] The badge carries the name itself.
                              child: HfBrandMark(
                                size: math.min(176.0, h * 0.24),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          );
        },
      ),
    );
  }
}
