import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/brand.dart';
import '../../../core/links.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/pending_intent.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/ack_service.dart';

/// Copy of the Welcome screen. Simple English; the tick text is the rulebook's Appendix B wording.
abstract final class WelcomeCopy {
  /// Hero headline, two lines.
  static const String title = 'Talk to a real person.';
  static const String titleLine2 = 'Your number stays private.';
  static const String intro =
      'Friendly conversation, paid by the minute. Three rules keep it safe for everyone.';

  /// The masked line shown in the chip of the picture. Nothing typed by anyone, never a real number.
  static const String maskedLine = '+91 •••• ••••';

  static const String rule1Title = 'Never share phone numbers or bank details.';
  static const String rule2Title = 'Press # on any call to end it and block.';
  static const String rule3Lead = 'This is not counselling. In crisis? Call ';
  static const String rule3Title =
      '$rule3Lead${Strings.crisisTeleManasNumber}.';

  static const String tick =
      'I understand ${Brand.name} is friendly conversation, not counselling, therapy or a relationship '
      'service. Hosts are independent people and are not mental-health professionals. If I am in crisis I '
      'will call Tele-MANAS 14416 or 112. I am 18 or older.';

  static const String button = 'Continue';
  static const String linksTitle = 'Read more';
  static const String terms = 'Terms';
  static const String privacy = 'Privacy';
  static const String guidelines = 'Guidelines';
  static const String safety = 'Safety';
}

/// Contextual, account-scoped 18+ and safety consent before a privileged action.
/// Public browsing never passes through this page.
class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key, this.next});

  final String? next;

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen>
    with TickerProviderStateMixin {
  /// Each rule row fades and slides in over 220 ms, 120 ms after the one before it.
  static const int _rowMs = 220;
  static const int _gapMs = 120;
  static const int _totalMs = _rowMs + 2 * _gapMs;

  /// After the rows are in, each rule's tick draws itself (500 ms), 350 ms after the one before it.
  static const int _tickStartMs = _totalMs + 150;
  static const int _tickGapMs = 350;
  static const int _tickMs = 500;
  static const int _ticksTotalMs = _tickStartMs + 2 * _tickGapMs + _tickMs;

  late final AnimationController _intro;

  /// Runs while the rule ticks draw; the beaver nods along, then goes back to namaste.
  late final AnimationController _ticks;
  final ConfettiController _confetti = ConfettiController();

  @override
  void initState() {
    super.initState();
    _intro = AnimationController(vsync: this);
    _ticks = AnimationController(vsync: this)
      ..addStatusListener((_) {
        if (mounted) setState(() {});
      });
  }

  /// Namaste to greet, nod while the rule ticks draw, celebrate once the person has ticked.
  BeaverPose get _pose => _ticked
      ? BeaverPose.celebrate
      : _ticks.isAnimating
      ? BeaverPose.nod
      : BeaverPose.namaste;

  /// Starts rule [i]'s tick after the rows are in (zero with reduced motion).
  Duration _tickDelay(int i) => HfMotion.of(
    context,
    Duration(milliseconds: _tickStartMs + i * _tickGapMs),
  );

  void _onTick(bool value) {
    setState(() => _ticked = value);
    if (value) _confetti.fire();
  }

  bool _introStarted = false;

  bool _ticked = false;
  bool _busy = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_introStarted) return;
    _introStarted = true;
    final d = HfMotion.of(context, const Duration(milliseconds: _totalMs));
    if (d == Duration.zero) {
      _intro.value = 1;
      _ticks.value = 1;
    } else {
      _intro.duration = d;
      _intro.forward();
      _ticks.duration = const Duration(milliseconds: _ticksTotalMs);
      _ticks.forward();
    }
  }

  @override
  void dispose() {
    _intro.dispose();
    _ticks.dispose();
    _confetti.dispose();
    super.dispose();
  }

  late final List<Animation<double>> _rows = [
    for (var i = 0; i < 3; i++)
      CurvedAnimation(
        parent: _intro,
        curve: Interval(
          i * _gapMs / _totalMs,
          (i * _gapMs + _rowMs) / _totalMs,
          curve: HfMotion.curve,
        ),
      ),
  ];

  Future<void> _continue() async {
    if (!_ticked || _busy) return;
    setState(() => _busy = true);
    try {
      final version = await ref.read(ackServiceProvider).accept();
      await Analytics.capture('hf_app_welcome_accepted', {
        'outcome': 'ok',
        'version': version,
        'signed_in': ref.read(sessionProvider).isSignedIn,
      });
      if (!mounted) return;
      // Links that arrived during start were held until now (the splash does not release them for Welcome).
      ref.read(bootDoneProvider.notifier).markDone();
      final opened = await ref.read(deepLinkHandlerProvider).flushPending();
      if (!mounted) return;
      if (!opened) {
        final router = GoRouter.of(context);
        if (router.canPop()) {
          router.pop(true);
        } else {
          final next = Routes.safeNext(widget.next);
          await ref.read(pendingIntentProvider).clear();
          if (mounted) router.go(next ?? Routes.explore);
        }
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'We could not save that. Please try again.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cancel() async {
    await ref.read(pendingIntentProvider).clear();
    if (mounted) popOrHome(context);
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return PopScope<Object?>(
      canPop: GoRouter.of(context).canPop(),
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) {
          _cancel();
        } else if (result != true) {
          ref.read(pendingIntentProvider).clear();
        }
      },
      child: Scaffold(
        body: ConfettiBurst(
          controller: _confetti,
          origin: const Alignment(0, 0.25),
          child: SafeArea(
          top: false,
          child: CustomScrollView(
            slivers: [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _WelcomeHeader(pose: _pose),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: HfSpacing.section,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            Brand.name.toUpperCase(),
                            style: HfText.badge.copyWith(
                              color: dark ? HfColors.blushLight : HfColors.rose,
                              letterSpacing: 1.12,
                            ),
                          ),
                          const SizedBox(height: HfSpacing.lg),
                          Text(
                            '${WelcomeCopy.title}\n${WelcomeCopy.titleLine2}',
                            style: HfText.of(
                              context,
                              HfText.hero,
                            ).copyWith(height: 1.12, letterSpacing: 0.3),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 20),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: HfSpacing.section,
                      ),
                      child: Column(
                        children: [
                          _StaggerIn(
                            animation: _rows[0],
                            child: _RuleRow(
                              tint: HfTint.lavender,
                              icon: Icons.lock_outline_rounded,
                              tick: _RuleTick(
                                index: 0,
                                delay: _tickDelay(0),
                                progress: _ticks,
                              ),
                              child: const Text(WelcomeCopy.rule1Title),
                            ),
                          ),
                          const SizedBox(height: HfSpacing.md),
                          _StaggerIn(
                            animation: _rows[1],
                            child: _RuleRow(
                              tint: HfTint.peach,
                              glyph: '#',
                              tick: _RuleTick(
                                index: 1,
                                delay: _tickDelay(1),
                                progress: _ticks,
                              ),
                              child: const Text(WelcomeCopy.rule2Title),
                            ),
                          ),
                          const SizedBox(height: HfSpacing.md),
                          _StaggerIn(
                            animation: _rows[2],
                            child: _RuleRow(
                              tint: HfTint.sky,
                              icon: Icons.favorite_border_rounded,
                              tick: _RuleTick(
                                index: 2,
                                delay: _tickDelay(2),
                                progress: _ticks,
                              ),
                              child: const _CrisisRuleText(),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: HfSpacing.xxl),
                    const Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: HfSpacing.section,
                      ),
                      child: CrisisStrip(),
                    ),
                    const Spacer(),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        HfSpacing.section,
                        HfSpacing.section,
                        HfSpacing.section,
                        34,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _AcceptPanel(
                            ticked: _ticked,
                            busy: _busy,
                            onTick: _onTick,
                            onContinue: _continue,
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: HfSpacing.md),
                            Text(
                              _error!,
                              style: HfText.badge.copyWith(
                                color: dark
                                    ? HfColors.blushLight
                                    : HfColors.accent,
                              ),
                            ),
                          ],
                          const SizedBox(height: HfSpacing.xl),
                          const _LegalLinks(),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        ),
      ),
    );
  }
}

/// Fade and 12 px slide-up driven by [animation].
class _StaggerIn extends StatelessWidget {
  const _StaggerIn({required this.animation, required this.child});

  final Animation<double> animation;
  final Widget child;

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: animation,
    child: AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (_, c) => Transform.translate(
        offset: Offset(0, 12 * (1 - animation.value)),
        child: c,
      ),
    ),
  );
}

/// The warm top of the page: a cream sky with a low sun hill, the beaver guide standing on it with the
/// welcome bubble, and the white chip with the masked line (never a real number).
class _WelcomeHeader extends StatelessWidget {
  const _WelcomeHeader({required this.pose});

  final BeaverPose pose;

  /// Height of the hill at the bottom of the header, as a fraction of the header.
  static const double hill = 0.30;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final top = MediaQuery.paddingOf(context).top;
    final width = MediaQuery.sizeOf(context).width;
    final beaver = math.min(150.0, width * 0.38);
    // This page sizes itself from intrinsic heights (SliverFillRemaining), and a max-width box does not
    // narrow its child's intrinsic height. Padding does, so the bubble is measured at the width it lays
    // out at (BeaverGuide caps it at max(240, 1.8 x beaver)).
    final bubbleMax = math.max(240.0, beaver * 1.8);
    final side = math.max(0.0, (width - 2 * HfSpacing.section - bubbleMax) / 2);
    return Stack(
      children: [
        Positioned.fill(
          child: ExcludeSemantics(
            child: RepaintBoundary(
              child: CustomPaint(
                painter: SunHillPainter(
                  rise: hill,
                  sky: dark ? HfColors.darkBg : null,
                ),
              ),
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(
            HfSpacing.section,
            top + HfSpacing.lg,
            HfSpacing.section,
            0,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Align(
                alignment: Alignment.centerRight,
                child: ExcludeSemantics(
                  child: PopIn(
                    delay: const Duration(milliseconds: 250),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: dark ? HfColors.darkNav : HfColors.white,
                        borderRadius: BorderRadius.circular(HfRadius.chip),
                        boxShadow: dark ? null : HfShadows.card,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.phone_outlined,
                            size: 18,
                            color: dark ? HfColors.darkText : HfColors.ink,
                          ),
                          const SizedBox(width: HfSpacing.xs),
                          Flexible(
                            child: Text(
                              WelcomeCopy.maskedLine,
                              style: HfText.of(context, HfText.badge),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: HfSpacing.sm),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: side),
                child: Center(
                  child: BeaverGuide(
                    key: const ValueKey<String>('welcome-beaver'),
                    pose: pose,
                    size: beaver,
                    message: WelcomeCopy.intro,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A rule's tick: it draws itself in turn after the rows are in, with a tiny sparkle as it lands.
/// Reduced motion: the finished tick at once, no sparkle.
class _RuleTick extends StatelessWidget {
  const _RuleTick({
    required this.index,
    required this.delay,
    required this.progress,
  });

  final int index;
  final Duration delay;

  /// The screen's tick timeline (0..1 over [_WelcomeScreenState._ticksTotalMs]).
  final Animation<double> progress;

  static const double size = 26;

  @override
  Widget build(BuildContext context) {
    const total = _WelcomeScreenState._ticksTotalMs;
    final landsAt =
        (_WelcomeScreenState._tickStartMs +
            index * _WelcomeScreenState._tickGapMs +
            _WelcomeScreenState._tickMs * 0.7) /
        total;
    final reduced = hfReduceMotion(context);
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            DrawnCheck(
              key: ValueKey<String>('welcome-rule-tick-$index'),
              size: size,
              delay: delay,
              duration: const Duration(
                milliseconds: _WelcomeScreenState._tickMs,
              ),
            ),
            if (!reduced)
              Positioned(
                left: -14,
                top: -14,
                width: size + 28,
                height: size + 28,
                child: IgnorePointer(
                  child: AnimatedBuilder(
                    animation: progress,
                    builder: (context, _) => progress.value >= landsAt
                        ? const HfLottie(HfLottieAssets.sparkleBurst)
                        : const SizedBox.shrink(),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One rule: a 40 px tinted square (icon or glyph) and the sentence, in a white 18 px card with a hairline.
class _RuleRow extends StatelessWidget {
  const _RuleRow({
    required this.tint,
    required this.child,
    this.icon,
    this.glyph,
    this.tick,
  });

  final HfTint tint;
  final IconData? icon;
  final String? glyph;
  final Widget child;

  /// Drawn at the end of the row (the rule's self-drawing tick).
  final Widget? tick;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final ink = tint.ink(context);
    return Container(
      padding: const EdgeInsets.all(HfSpacing.lg),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.surface,
        borderRadius: BorderRadius.circular(HfRadius.tileSmall),
        border: Border.all(color: dark ? HfColors.darkLine : HfColors.line),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: tint.bg(context),
              borderRadius: BorderRadius.circular(HfSpacing.lg),
            ),
            child: glyph != null
                ? Text(
                    glyph!,
                    style: HfText.section.copyWith(color: ink, height: 1),
                  )
                : Icon(icon, size: 20, color: ink),
          ),
          const SizedBox(width: HfSpacing.lg),
          Expanded(
            child: DefaultTextStyle.merge(
              style: HfText.of(
                context,
                HfText.body,
              ).copyWith(fontSize: 15, height: 1.4),
              child: child,
            ),
          ),
          if (tick != null) ...[
            const SizedBox(width: HfSpacing.md),
            tick!,
          ],
        ],
      ),
    );
  }
}

/// Rule 3 with the Tele-MANAS number as a tap-to-call link (the dialer opens; the person presses Call).
class _CrisisRuleText extends StatefulWidget {
  const _CrisisRuleText();

  @override
  State<_CrisisRuleText> createState() => _CrisisRuleTextState();
}

class _CrisisRuleTextState extends State<_CrisisRuleText> {
  late final TapGestureRecognizer _tap = TapGestureRecognizer()
    ..onTap = () => LinkOpener.instance.tel(Strings.crisisTeleManasNumber);

  @override
  void dispose() {
    _tap.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final link = HfBrightness.isDark(context)
        ? HfColors.lavenderLight
        : HfColors.link;
    return Text.rich(
      TextSpan(
        children: [
          const TextSpan(text: WelcomeCopy.rule3Lead),
          TextSpan(
            text: Strings.crisisTeleManasNumber,
            recognizer: _tap,
            style: TextStyle(
              fontWeight: FontWeight.w700,
              color: link,
              decoration: TextDecoration.underline,
            ),
          ),
          const TextSpan(text: '.'),
        ],
      ),
    );
  }
}

/// Terms, Privacy, Guidelines and Safety open the website in a Custom Tab.
class _LegalLinks extends StatelessWidget {
  const _LegalLinks();

  @override
  Widget build(BuildContext context) {
    Widget link(String label, String path) => TextButton(
      onPressed: () => LinkOpener.instance.site(path),
      child: Text(label),
    );
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: HfSpacing.sm,
      children: [
        link(WelcomeCopy.terms, '/terms'),
        link(WelcomeCopy.privacy, '/privacy'),
        link(WelcomeCopy.guidelines, '/community-guidelines'),
        link(WelcomeCopy.safety, '/safety'),
      ],
    );
  }
}

/// The 24 px tick with the legal wording, and the Continue button (ink, 56 tall, arrow).
class _AcceptPanel extends StatelessWidget {
  const _AcceptPanel({
    required this.ticked,
    required this.busy,
    required this.onTick,
    required this.onContinue,
  });

  final bool ticked;
  final bool busy;
  final ValueChanged<bool> onTick;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final scheme = Theme.of(context).colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          key: const ValueKey<String>('welcome-tick'),
          borderRadius: BorderRadius.circular(HfRadius.chip),
          onTap: () => onTick(!ticked),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: HfSpacing.tap),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: SizedBox(
                    width: 24,
                    height: 24,
                    child: Transform.scale(
                      scale: 24 / 18,
                      child: Checkbox(
                        value: ticked,
                        onChanged: (v) => onTick(v ?? false),
                        activeColor: scheme.primary,
                        checkColor: scheme.onPrimary,
                        side: BorderSide(
                          color: dark ? HfColors.mutedSoft : HfColors.ink,
                          width: 1.5,
                        ),
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: HfSpacing.lg),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      WelcomeCopy.tick,
                      style: HfText.body.copyWith(
                        fontSize: 14,
                        height: 1.45,
                        color: dark ? HfColors.darkText : HfColors.inkSoft,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: HfSpacing.xl),
        Semantics(
          button: true,
          enabled: ticked && !busy,
          label: busy ? '${WelcomeCopy.button}, loading' : WelcomeCopy.button,
          excludeSemantics: true,
          child: _WarmFill(
            on: ticked,
            child: FilledButton(
            onPressed: ticked && !busy ? onContinue : null,
            style: FilledButton.styleFrom(
              backgroundColor: Colors.transparent,
              disabledBackgroundColor: Colors.transparent,
              shadowColor: Colors.transparent,
            ),
            child: busy
                ? SizedBox(
                    height: 22,
                    width: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: scheme.onPrimary,
                    ),
                  )
                : const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          WelcomeCopy.button,
                          textAlign: TextAlign.center,
                        ),
                      ),
                      SizedBox(width: HfSpacing.md),
                      Icon(Icons.arrow_forward_rounded, size: 18),
                    ],
                  ),
          ),
          ),
        ),
      ],
    );
  }
}

/// Behind the Continue button: a muted track that a sunshine-to-deep-orange fill sweeps across, left to
/// right, when [on] turns true (and back when it turns false). With reduced motion it jumps.
class _WarmFill extends StatelessWidget {
  const _WarmFill({required this.on, required this.child});

  final bool on;
  final Widget child;

  static const Key fillKey = ValueKey<String>('welcome-continue-fill');

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final track = Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.12);
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(end: on ? 1 : 0),
      duration: HfMotion.of(context, const Duration(milliseconds: 420)),
      curve: Curves.easeOutCubic,
      child: child,
      builder: (context, t, child) => ClipRRect(
        borderRadius: BorderRadius.circular(HfRadius.control),
        child: Stack(
          children: [
            Positioned.fill(child: ColoredBox(color: track)),
            Positioned.fill(
              child: FractionallySizedBox(
                key: fillKey,
                alignment: Alignment.centerLeft,
                widthFactor: t,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: dark
                        ? const LinearGradient(
                            colors: [HfColors.primary, HfColors.deepOrange],
                          )
                        : const LinearGradient(
                            colors: [HfColors.sunshine, HfColors.primary],
                          ),
                  ),
                ),
              ),
            ),
            child!,
          ],
        ),
      ),
    );
  }
}
