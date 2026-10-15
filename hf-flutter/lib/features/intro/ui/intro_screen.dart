import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/brand.dart';
import '../../../core/router/startup_navigation.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/install_intro_store.dart';

class IntroScreen extends ConsumerStatefulWidget {
  const IntroScreen({super.key});

  /// The beaver's pose on each page (wave, point, thumbs).
  static const List<BeaverPose> poses = [
    BeaverPose.wave,
    BeaverPose.point,
    BeaverPose.thumbs,
  ];

  @override
  ConsumerState<IntroScreen> createState() => _IntroScreenState();
}

class _IntroScreenState extends ConsumerState<IntroScreen> {
  static const _pages = [
    (
      title: 'Find the right person to talk to',
      body: 'Browse by language and mood. Find someone who feels right for the conversation you want.',
      image: 'find-person',
      imageLabel: 'Two adults sharing a relaxed conversation',
      note: 'Your language. Your mood. Your choice.',
    ),
    (
      title: 'Listen before you connect',
      body: 'Hear a voice intro, read ratings and see clear pricing before you call.',
      image: 'listen-first',
      imageLabel: 'A woman listening through an earbud',
      note: 'You are charged only while connected.',
    ),
    (
      title: 'Explore freely',
      body: 'Browse without an account. We will ask you to sign in when you call, open your wallet or visit your profile.',
      image: 'explore-freely',
      imageLabel: 'A man comfortably browsing on his phone',
      note: 'Take a look around. No sign-in needed.',
    ),
  ];

  final ScrollController _scroll = ScrollController();
  int _page = 0;
  bool _busy = false;
  bool _precached = false;

  @override
  void initState() {
    super.initState();
    _trackView();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_precached) return;
    _precached = true;
    // Decode the next poses early so a page change never shows a blank beaver.
    final reduced = hfReduceMotion(context);
    for (final pose in IntroScreen.poses.skip(1)) {
      unawaited(precacheImage(
        AssetImage(reduced ? pose.stillAsset : pose.animatedAsset),
        context,
        // A failed warm-up only means the pose decodes when shown.
        onError: (_, _) {},
      ));
    }
  }

  void _trackView() => unawaited(Analytics.capture('hf_app_intro_viewed', {
    'page': _page + 1,
    'intro_version': 1,
  }));

  void _show(int page) {
    if (_busy || page == _page || page < 0 || page >= _pages.length) return;
    setState(() => _page = page);
    if (_scroll.hasClients) _scroll.jumpTo(0);
    _trackView();
  }

  /// A horizontal swipe moves one page (left = next, right = back). Never completes the intro.
  void _onSwipe(DragEndDetails details) {
    final v = details.primaryVelocity ?? 0;
    if (v.abs() < 250) return;
    _show(v < 0 ? _page + 1 : _page - 1);
  }

  Future<void> _complete({required bool skipped}) async {
    if (_busy) return;
    setState(() => _busy = true);
    final saved = await ref.read(installIntroStoreProvider).complete();
    await Analytics.capture('hf_app_intro_completed', {
      'page': _page + 1,
      'method': skipped ? 'skip' : 'explore',
      'persisted': saved,
      'intro_version': 1,
    });
    if (!mounted) return;
    await ref.read(startupNavigationProvider).openLanding();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final page = _pages[_page];
    final dark = HfBrightness.isDark(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || _busy) return;
        if (_page > 0) {
          _show(_page - 1);
        } else {
          unawaited(SystemNavigator.pop());
        }
      },
      child: Scaffold(
        backgroundColor: dark ? HfColors.darkBg : HfColors.page,
        body: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onHorizontalDragEnd: _busy ? null : _onSwipe,
          child: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: LayoutBuilder(builder: (context, constraints) {
                final photoHeight = (constraints.maxHeight * .30)
                    .clamp(150.0, 300.0).toDouble();
                return SingleChildScrollView(
                  controller: _scroll,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: constraints.maxHeight),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                            Row(children: [
                              Expanded(child: Text(Brand.name,
                                style: HfText.of(context, HfText.section))),
                              const SizedBox(width: 8),
                              TextButton(
                                key: const ValueKey('intro-skip'),
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(48, 48)),
                                onPressed: _busy ? null
                                  : () => _complete(skipped: true),
                                child: const Text('Skip'),
                              ),
                            ]),
                            const SizedBox(height: 16),
                            KeyedSubtree(
                              key: ValueKey('intro-page-$_page'),
                              child: PopIn(
                                beginScale: 0.94,
                                duration: const Duration(milliseconds: 360),
                                child: Container(
                                  key: ValueKey('intro-photo-${page.image}'),
                                  padding: const EdgeInsets.all(5),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(32),
                                    boxShadow: dark ? HfShadows.navDark : HfShadows.nav,
                                  ),
                                  child: ClipRRect(
                                    borderRadius: BorderRadius.circular(27),
                                    child: Image.asset(
                                      'assets/images/intro/${page.image}.webp',
                                      height: photoHeight,
                                      width: double.infinity,
                                      fit: BoxFit.cover,
                                      alignment: const Alignment(0, -.3),
                                      semanticLabel: page.imageLabel,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(height: 12),
                            _IntroGuide(page: _page, message: page.note),
                            const SizedBox(height: 12),
                            KeyedSubtree(
                              key: ValueKey('intro-copy-$_page'),
                              child: StaggeredReveal(
                                stagger: const Duration(milliseconds: 90),
                                children: [
                                  Semantics(
                                    header: true,
                                    liveRegion: true,
                                    child: Text(page.title,
                                      textAlign: TextAlign.center,
                                      style: HfText.of(context, HfText.hero)),
                                  ),
                                  const SizedBox(height: 14),
                                  Text(page.body,
                                    textAlign: TextAlign.center,
                                    style: HfText.of(context, HfText.body)),
                                ],
                              ),
                            ),
                          ]),
                          Padding(
                            padding: const EdgeInsets.only(top: 24),
                            child: Column(children: [
                              Text('Page ${_page + 1} of 3',
                                style: HfText.of(context, HfText.note)),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [for (var i = 0; i < 3; i++)
                                  _PageDot(
                                    index: i,
                                    active: i == _page,
                                    onTap: _busy ? null : () => _show(i),
                                  ),
                                ],
                              ),
                              HfButton(
                                key: const ValueKey('intro-next'),
                                label: _page == 2 ? 'Start exploring' : 'Next',
                                loading: _busy,
                                onPressed: _busy ? null : () {
                                  if (_page == 2) {
                                    unawaited(_complete(skipped: false));
                                  } else {
                                    _show(_page + 1);
                                  }
                                },
                              ),
                            ]),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
        ),
      ),
    );
  }
}

/// The beaver guide for the current page on a soft sunshine-to-orange blob that drifts as the pages change.
/// The bubble carries the page's short note.
class _IntroGuide extends StatelessWidget {
  const _IntroGuide({required this.page, required this.message});

  final int page;
  final String message;

  static const double beaverSize = 104;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(1);
    return LayoutBuilder(builder: (context, constraints) {
      final beside = constraints.maxWidth - beaverSize >= 180 * scale;
      return Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: IgnorePointer(
              child: TweenAnimationBuilder<double>(
                tween: Tween<double>(end: page.toDouble()),
                duration: HfMotion.of(context, const Duration(milliseconds: 520)),
                curve: Curves.easeInOutCubic,
                builder: (context, t, _) => RepaintBoundary(
                  child: CustomPaint(
                    key: const ValueKey('intro-blob'),
                    painter: IntroBlobPainter(
                      t: t,
                      beside: beside,
                      dark: HfBrightness.isDark(context),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Align(
            alignment: beside ? Alignment.centerLeft : Alignment.center,
            child: BeaverGuide(
              key: const ValueKey('intro-beaver'),
              pose: IntroScreen.poses[page],
              size: beaverSize,
              message: message,
              bubbleSide: beside ? BeaverBubbleSide.beside : BeaverBubbleSide.above,
            ),
          ),
        ],
      );
    });
  }
}

/// A soft, slightly wobbly sunshine-to-orange blob behind the beaver. [t] is the page as a double (0..2):
/// as it moves the blob slides, turns and changes shape a little.
class IntroBlobPainter extends CustomPainter {
  IntroBlobPainter({required this.t, required this.beside, this.dark = false});

  final double t;
  final bool beside;
  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final r = math.min(size.height * 0.48, 92.0);
    // Beside: the blob sits behind the beaver on the left. Above: behind the beaver at the bottom centre.
    final baseX = beside ? r * 0.95 : size.width / 2;
    final baseY = beside ? size.height / 2 : size.height - r * 0.9;
    final center = Offset(
      baseX + math.sin(t * math.pi / 2) * r * 0.22 - t * r * 0.06,
      baseY + math.cos(t * math.pi * 0.8) * r * 0.06,
    );
    final path = Path();
    const steps = 48;
    for (var i = 0; i <= steps; i++) {
      final a = i / steps * math.pi * 2;
      final wobble = 1 +
          0.07 * math.sin(3 * a + t * math.pi * 0.9) +
          0.04 * math.cos(2 * a - t * math.pi * 0.6);
      final p = center + Offset(math.cos(a) * r * 1.12 * wobble, math.sin(a) * r * wobble);
      if (i == 0) {
        path.moveTo(p.dx, p.dy);
      } else {
        path.lineTo(p.dx, p.dy);
      }
    }
    path.close();
    final bounds = Rect.fromCircle(center: center, radius: r * 1.2);
    canvas.drawPath(
      path,
      Paint()
        ..color = HfColors.sunshine.withValues(alpha: dark ? 0.22 : 0.45)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 14),
    );
    canvas.drawPath(
      path,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          transform: GradientRotation(t * 0.5),
          colors: [
            HfColors.sunshine.withValues(alpha: dark ? 0.35 : 0.85),
            HfColors.primary.withValues(alpha: dark ? 0.35 : 0.8),
          ],
        ).createShader(bounds),
    );
  }

  @override
  bool shouldRepaint(IntroBlobPainter old) =>
      old.t != t || old.beside != beside || old.dark != dark;
}

/// A page dot: a small round dot, stretched into a warm pill for the current page. 48 dp touch target.
class _PageDot extends StatelessWidget {
  const _PageDot({required this.index, required this.active, required this.onTap});

  final int index;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Semantics(
      label: 'Page ${index + 1} of 3',
      selected: active,
      button: true,
      excludeSemantics: true,
      child: Tooltip(
        message: 'Go to page ${index + 1}',
        excludeFromSemantics: true,
        child: InkResponse(
          key: ValueKey('intro-dot-$index'),
          onTap: onTap,
          radius: 24,
          child: SizedBox(
            height: 48,
            width: active ? 56 : 32,
            child: Center(
              child: AnimatedContainer(
                key: ValueKey('intro-dot-pill-$index'),
                duration: HfMotion.of(context, const Duration(milliseconds: 280)),
                curve: Curves.easeOutCubic,
                width: active ? 30 : 9,
                height: active ? 10 : 9,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(HfRadius.pillRadius),
                  gradient: active ? HfGradients.sunDeep : null,
                  color: active ? null : (dark ? HfColors.mutedSoft : HfColors.handle),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
