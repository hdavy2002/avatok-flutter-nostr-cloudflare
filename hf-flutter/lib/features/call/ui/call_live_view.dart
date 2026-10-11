import 'package:flutter/material.dart';

import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../data/call_models.dart';
import '../../demo/demo_data.dart'; // [HF-DEMO] remove with lib/features/demo
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
    this.notice,
    this.showConnectionTrouble = false,
  });

  final CallInfo info;
  final int elapsedSeconds;
  final int? currentRatePaise;
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
          const SizedBox(height: 44),
          _Rings(
            name: info.hostFirstName == 'your host' ? '' : info.hostFirstName,
            pulsing: info.status.isRinging,
            slug: info.hostSlug ?? '',
          ),
          const SizedBox(height: HfSpacing.section),
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
                  Text(
                    Money.clock(elapsedSeconds),
                    key: const ValueKey<String>('call-clock'),
                    textAlign: TextAlign.center,
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
          const SizedBox(height: 28),
          _Progress(name: name, step: step),
          const SizedBox(height: HfSpacing.xxl),
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
        color: dark ? HfColors.darkCard : HfColors.white,
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

/// Three lavender rings (300 / 240 / 180), the 132 px avatar with a white border and the ink phone badge. The
/// rings breathe while the phone is ringing and stay still on reduced motion.
class _Rings extends StatefulWidget {
  const _Rings({required this.name, required this.pulsing, this.slug = ''});

  final String name;
  final String slug;
  final bool pulsing;

  @override
  State<_Rings> createState() => _RingsState();
}

class _RingsState extends State<_Rings> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(_Rings old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final run = widget.pulsing && !MediaQuery.disableAnimationsOf(context);
    if (run) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse.stop();
      _pulse.value = 0;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final c1 = dark ? HfColors.darkCard : HfColors.lavender;
    final c2 = dark
        ? HfColors.darkTile
        : Color.lerp(HfColors.lavender, HfColors.lavenderLight, 0.5)!;
    final c3 = dark ? HfColors.darkSelected : HfColors.lavenderLight;
    return ExcludeSemantics(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final double size = constraints.maxWidth.isFinite
              ? (constraints.maxWidth - 40).clamp(200.0, 300.0).toDouble()
              : 300.0;
          final k = size / 300;
          Widget ring(double diameter, Color color, double phase) {
            return AnimatedBuilder(
              animation: _pulse,
              builder: (context, _) {
                final t = phase == 0 ? _pulse.value : 1 - _pulse.value;
                return Transform.scale(
                  scale: 1 + 0.035 * t,
                  child: Container(
                    width: diameter * k,
                    height: diameter * k,
                    decoration: BoxDecoration(
                      color: color,
                      shape: BoxShape.circle,
                    ),
                  ),
                );
              },
            );
          }

          return SizedBox(
            width: size,
            height: size,
            child: Stack(
              alignment: Alignment.center,
              clipBehavior: Clip.none,
              children: [
                ring(300, c1, 0),
                ring(240, c2, 1),
                ring(180, c3, 0),
                HfCallAvatar(
                  name: widget.name,
                  photoUrl: demoAvatarFor(
                    widget.slug,
                  ), // [HF-DEMO] remove with lib/features/demo
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
                      color: dark ? HfColors.lavender : HfColors.ink,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: dark ? HfColors.darkBg : HfColors.white,
                        width: 3,
                      ),
                    ),
                    child: Icon(
                      Icons.call_rounded,
                      size: 18,
                      color: dark ? HfColors.ink : HfColors.white,
                    ),
                  ),
                ),
              ],
            ),
          );
        },
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
    final done = dark ? HfColors.lavender : HfColors.ink;
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
        bg = dark ? HfColors.lavender : HfColors.ink;
        fg = dark ? HfColors.ink : HfColors.white;
      case _StepState.current:
        bg = HfTint.peach.bg(context);
        fg = HfTint.peach.valueInk(context);
      case _StepState.todo:
        bg = dark ? HfColors.darkCard : HfColors.white;
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
