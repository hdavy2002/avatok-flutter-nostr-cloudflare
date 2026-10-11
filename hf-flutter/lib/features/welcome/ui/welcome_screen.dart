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
    with SingleTickerProviderStateMixin {
  /// Each rule row fades and slides in over 220 ms, 120 ms after the one before it.
  static const int _rowMs = 220;
  static const int _gapMs = 120;
  static const int _totalMs = _rowMs + 2 * _gapMs;

  late final AnimationController _intro = AnimationController(vsync: this);
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
    } else {
      _intro.duration = d;
      _intro.forward();
    }
  }

  @override
  void dispose() {
    _intro.dispose();
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
          if (mounted) router.go(next ?? Routes.home);
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
        body: SafeArea(
          top: false,
          child: CustomScrollView(
            slivers: [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _ShapeCluster(),
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
                          const SizedBox(height: HfSpacing.lg),
                          Text(
                            WelcomeCopy.intro,
                            style: HfText.of(
                              context,
                              HfText.note,
                            ).copyWith(height: 1.5),
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
                            child: const _RuleRow(
                              tint: HfTint.lavender,
                              icon: Icons.lock_outline_rounded,
                              child: Text(WelcomeCopy.rule1Title),
                            ),
                          ),
                          const SizedBox(height: HfSpacing.md),
                          _StaggerIn(
                            animation: _rows[1],
                            child: const _RuleRow(
                              tint: HfTint.peach,
                              glyph: '#',
                              child: Text(WelcomeCopy.rule2Title),
                            ),
                          ),
                          const SizedBox(height: HfSpacing.md),
                          _StaggerIn(
                            animation: _rows[2],
                            child: const _RuleRow(
                              tint: HfTint.sky,
                              icon: Icons.favorite_border_rounded,
                              child: _CrisisRuleText(),
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
                            onTick: (v) => setState(() => _ticked = v),
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

/// The pastel picture at the top: five soft shapes, an ink phone circle and a white chip with the masked line.
/// Coordinates are the mockup's (390 wide); on other widths the cluster stays centred.
class _ShapeCluster extends StatelessWidget {
  const _ShapeCluster();

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final dx = (MediaQuery.sizeOf(context).width - 390) / 2;
    Widget shape(
      double left,
      double top,
      double size,
      double radius,
      HfTint tint, [
      double deg = 0,
    ]) => Positioned(
      left: left + dx,
      top: top,
      child: Transform.rotate(
        angle: deg * math.pi / 180,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: tint.bg(context),
            borderRadius: BorderRadius.circular(radius),
          ),
        ),
      ),
    );
    return ExcludeSemantics(
      child: ClipRect(
        child: SizedBox(
          height: 250,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              shape(34, 70, 150, 48, HfTint.lavender, -8),
              shape(150, 52, 120, 60, HfTint.peach),
              shape(236, 120, 110, 36, HfTint.sky, 10),
              shape(118, 150, 76, 38, HfTint.butter),
              Positioned(
                left: 76 + dx,
                top: 108,
                child: Container(
                  width: 66,
                  height: 66,
                  decoration: BoxDecoration(
                    color: dark ? HfColors.darkSelected : HfColors.ink,
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: const Icon(
                    Icons.phone_outlined,
                    size: 30,
                    color: HfColors.white,
                  ),
                ),
              ),
              Positioned(
                left: 196 + dx,
                top: 92,
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
                  child: Text(
                    WelcomeCopy.maskedLine,
                    style: HfText.of(context, HfText.badge),
                  ),
                ),
              ),
            ],
          ),
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
  });

  final HfTint tint;
  final IconData? icon;
  final String? glyph;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final ink = tint.ink(context);
    return Container(
      padding: const EdgeInsets.all(HfSpacing.lg),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
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
          child: FilledButton(
            onPressed: ticked && !busy ? onContinue : null,
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
      ],
    );
  }
}
