import 'package:flutter/material.dart';

import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_models.dart';
import 'call_avatar.dart';
import 'call_confirm_sheet.dart';

/// The live call body (mockup `Calling`): privacy chip, ringed avatar, copy for the current status and the
/// progress chips. The screen puts Cancel call / the "end from your phone" note under it.
class CallLiveView extends StatelessWidget {
  const CallLiveView({
    super.key,
    required this.info,
    required this.elapsedSeconds,
    this.currentRatePaise,
    this.photoUrl,
    this.notice,
    this.showConnectionTrouble = false,
  });

  final CallInfo info;
  final int elapsedSeconds;
  final int? currentRatePaise;
  final String? photoUrl;
  final String? notice;
  final bool showConnectionTrouble;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final connected = info.status == CallStatus.connected;
    final callerRinging = info.status == CallStatus.ringingCaller;
    final standardPlan = info.plan == 'standard' || currentRatePaise != null;
    final name = info.hostFirstName;
    final step = connected ? 2 : (callerRinging ? 1 : 0);

    final String? eyebrow = callerRinging ? CallStrings.saidYes(name) : null;
    final String headline = connected
        ? CallStrings.connected
        : (callerRinging
              ? CallStrings.phoneWillRingNow
              : CallStrings.ringingHostHeadline(name));
    final String note = connected
        ? '${CallStrings.endWithHash} ${standardPlan ? CallStrings.noLimitHint : CallStrings.legacyLimitHint}'
        : (callerRinging
              ? '${CallStrings.yourPhoneWillRingSub} ${CallStrings.billingStarts}'
              : CallStrings.ringingHostNote);

    return Padding(
      padding: const EdgeInsets.only(top: HfSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const _PrivacyChip(),
          const SizedBox(height: HfSpacing.xl),
          _Rings(
            name: info.hostFirstName == 'your host' ? '' : info.hostFirstName,
            pulsing: info.status.isRinging,
            saidYes: callerRinging,
            photoUrl: photoUrl,
          ),
          const SizedBox(height: HfSpacing.xl),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: Column(
              children: [
                if (eyebrow != null) ...[
                  Text(
                    eyebrow,
                    textAlign: TextAlign.center,
                    style: HfText.buttonSmall.copyWith(
                      color: dark ? HfColors.blushLight : HfColors.rose,
                    ),
                  ),
                  const SizedBox(height: HfSpacing.md),
                ],
                Semantics(
                  liveRegion: true,
                  child: Text(
                    headline,
                    textAlign: TextAlign.center,
                    style: HfText.of(context, HfText.hero),
                  ),
                ),
                if (connected) ...[
                  const SizedBox(height: HfSpacing.md),
                  _RollingClock(
                    text: Money.clock(elapsedSeconds),
                    style: HfText.of(
                      context,
                      HfText.hero.copyWith(fontSize: 44, height: 1.1),
                    ),
                  ),
                  if (currentRatePaise != null) ...[
                    const SizedBox(height: HfSpacing.xs),
                    Text(
                      CallStrings.currentRate(currentRatePaise!),
                      key: const ValueKey<String>('call-rate'),
                      textAlign: TextAlign.center,
                      style: HfText.of(context, HfText.note),
                    ),
                  ],
                ],
                const SizedBox(height: HfSpacing.md),
                Text(
                  note,
                  textAlign: TextAlign.center,
                  style: HfText.of(context, HfText.note.copyWith(height: 1.5)),
                ),
              ],
            ),
          ),
          const SizedBox(height: HfSpacing.lg),
          // HF-MOTION-C: the one beaver on this screen, on the phone while it rings, laughing once connected.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: HfSpacing.page),
            child: BeaverGuide(
              pose: connected ? BeaverPose.phoneLaugh : BeaverPose.phoneTalk,
              size: 84,
              bubbleSide: BeaverBubbleSide.beside,
              message: connected
                  ? CallStrings.beaverConnected
                  : (callerRinging
                        ? CallStrings.beaverSaidYes
                        : CallStrings.yourPhoneWillRing),
            ),
          ),
          const SizedBox(height: HfSpacing.lg),
          _Progress(name: name, step: step),
          const SizedBox(height: HfSpacing.xl),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 28),
            child: CallSafetyCard(),
          ),
          if (notice != null) ...[
            const SizedBox(height: HfSpacing.lg),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  notice!,
                  textAlign: TextAlign.center,
                  style: HfText.of(context, HfText.bodyStrong),
                ),
              ),
            ),
          ],
          if (showConnectionTrouble) ...[
            const SizedBox(height: HfSpacing.lg),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Text(
                CallStrings.connectionTrouble,
                textAlign: TextAlign.center,
                style: HfText.of(context, HfText.note),
              ),
            ),
          ],
          const SizedBox(height: HfSpacing.section),
        ],
      ),
    );
  }
}

class _PrivacyChip extends StatelessWidget {
  const _PrivacyChip();

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final fg = dark ? HfColors.darkText : HfColors.inkSoft;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: HfSpacing.xl,
        vertical: HfSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.lock_outline_rounded, size: 16, color: fg),
          const SizedBox(width: HfSpacing.sm),
          Flexible(
            child: Text(
              CallStrings.bothPrivate,
              style: HfText.badge.copyWith(color: fg),
            ),
          ),
        ],
      ),
    );
  }
}

/// The host's portrait on warm halos with the phone badge (HF-MOTION-C). While the phone rings, [RippleRings]
/// in primary and sunshine spread out from it; when the host says yes ([saidYes] turns true) a warm yellow
/// burst flashes once behind the portrait. Reduced motion: still halos, no ripples, no flash.
class _Rings extends StatefulWidget {
  const _Rings({
    required this.name,
    required this.pulsing,
    this.saidYes = false,
    this.photoUrl,
  });

  final String name;
  final String? photoUrl;
  final bool pulsing;
  final bool saidYes;

  @override
  State<_Rings> createState() => _RingsState();
}

class _RingsState extends State<_Rings> with SingleTickerProviderStateMixin {
  late final AnimationController _flash;

  @override
  void initState() {
    super.initState();
    _flash = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 560),
    );
  }

  @override
  void didUpdateWidget(_Rings old) {
    super.didUpdateWidget(old);
    if (widget.saidYes && !old.saidYes && !hfReduceMotion(context)) {
      _flash.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _flash.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return ExcludeSemantics(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final double size = constraints.maxWidth.isFinite
              ? (constraints.maxWidth - 72).clamp(184.0, 240.0).toDouble()
              : 240.0;
          final k = size / 300;
          Widget disc(double diameter, Color color) => Container(
            width: diameter * k,
            height: diameter * k,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          );
          final portrait = Stack(
            alignment: Alignment.center,
            clipBehavior: Clip.none,
            children: [
              disc(
                236,
                dark
                    ? HfColors.darkCard
                    : HfColors.sunshine.withValues(alpha: 0.22),
              ),
              disc(184, dark ? HfColors.darkBar : HfColors.butter),
              AnimatedBuilder(
                animation: _flash,
                builder: (context, _) {
                  final t = _flash.value;
                  if (t <= 0 || t >= 1) return const SizedBox.shrink();
                  return Opacity(
                    opacity: (1 - t) * 0.95,
                    child: Transform.scale(
                      scale: 0.7 + 0.6 * Curves.easeOutCubic.transform(t),
                      child: Container(
                        width: 240 * k,
                        height: 240 * k,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: RadialGradient(
                            colors: [
                              HfColors.sunshine,
                              HfColors.sunshine.withValues(alpha: 0),
                            ],
                            stops: const [0.55, 1],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
              HfCallAvatar(
                name: widget.name,
                photoUrl: widget.photoUrl,
                size: 132 * k,
                radius: 66 * k,
                borderColor: dark ? HfColors.darkBg : HfColors.white,
                borderWidth: 4,
              ),
              Positioned(
                right: 70 * k,
                bottom: 74 * k,
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: HfColors.primary,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: dark ? HfColors.darkBg : HfColors.white,
                      width: 3,
                    ),
                  ),
                  child: Icon(
                    Icons.call_rounded,
                    size: 18,
                    color: HfColors.onPrimary,
                  ),
                ),
              ),
            ],
          );
          return RippleRings(
            size: size,
            enabled: widget.pulsing,
            colors: const [HfColors.primary, HfColors.sunshine],
            child: SizedBox.square(dimension: size, child: portrait),
          );
        },
      ),
    );
  }
}

/// The running clock (HF-MOTION-C): each new value rolls up a few pixels and fades in. Only ONE Text exists,
/// keyed `call-clock`, always holding the current value. Reduced motion: no roll.
class _RollingClock extends StatelessWidget {
  const _RollingClock({required this.text, required this.style});

  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      key: ValueKey<String>('clock-roll-$text'),
      tween: Tween<double>(begin: 0, end: 1),
      duration: HfMotion.of(context, const Duration(milliseconds: 260)),
      curve: Curves.easeOutCubic,
      builder: (context, t, child) => Opacity(
        opacity: 0.35 + 0.65 * t,
        child: Transform.translate(
          offset: Offset(0, (1 - t) * 10),
          child: child,
        ),
      ),
      child: Text(
        text,
        key: const ValueKey<String>('call-clock'),
        textAlign: TextAlign.center,
        style: style,
      ),
    );
  }
}

/// `{name} ✓` (ink) → `You` (peach) → `Talking` (white). [step] is the current one: 0 host, 1 you, 2 talking.
class _Progress extends StatelessWidget {
  const _Progress({required this.name, required this.step});

  final String name;
  final int step;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final line = dark ? HfColors.darkLine : HfColors.handle;
    const done = HfColors.primary;
    Widget connector(bool filled) =>
        Container(width: 18, height: 2, color: filled ? done : line);
    return Semantics(
      container: true,
      label: CallStrings.progressLabel,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: HfSpacing.page),
        child: Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: HfSpacing.sm,
          runSpacing: HfSpacing.sm,
          children: [
            _StepChip(
              label: name,
              state: step > 0 ? _StepState.done : _StepState.current,
            ),
            connector(step > 0),
            _StepChip(
              label: CallStrings.progressYou,
              state: step > 1
                  ? _StepState.done
                  : (step == 1 ? _StepState.current : _StepState.todo),
            ),
            connector(step > 1),
            _StepChip(
              label: CallStrings.progressTalking,
              state: step == 2 ? _StepState.current : _StepState.todo,
            ),
          ],
        ),
      ),
    );
  }
}

enum _StepState { done, current, todo }

class _StepChip extends StatelessWidget {
  const _StepChip({required this.label, required this.state});

  final String label;
  final _StepState state;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final Color bg;
    final Color fg;
    var weight = FontWeight.w700;
    switch (state) {
      case _StepState.done:
        bg = HfColors.primary;
        fg = HfColors.onPrimary;
      case _StepState.current:
        bg = HfTint.peach.bg(context);
        fg = HfTint.peach.valueInk(context);
      case _StepState.todo:
        bg = dark ? HfColors.darkCard : HfColors.surface;
        fg = dark ? HfColors.mutedSoft : HfColors.muted;
        weight = FontWeight.w600;
    }
    return Semantics(
      container: true,
      selected: state == _StepState.current,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 160),
        padding: const EdgeInsets.symmetric(
          horizontal: HfSpacing.lg,
          vertical: HfSpacing.sm,
        ),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(HfRadius.chip),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (state == _StepState.done) ...[
              Icon(Icons.check_rounded, size: 14, color: fg),
              const SizedBox(width: HfSpacing.xs),
            ],
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: HfText.badge.copyWith(color: fg, fontWeight: weight),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
