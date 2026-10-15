import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config/flags.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/hf_page_header.dart';
import '../../../core/widgets/widgets.dart';
import '../../kyc/kyc.dart';
import '../flow/onboarding_context.dart';
import '../flow/onboarding_steps.dart';
import 'step_registry.dart';
import 'steps/onboarding_copy.dart';

/// `/host/onboarding?step=` (needs sign-in): the onboarding shell (HF-NATIVE-9). It owns the step list, the
/// progress header, the back button and the server state; each step is a widget registered in `step_registry.dart`
/// (part A) or `part_b/part_b_steps.dart` (part B).
///
/// - Opens at the step the server says is next ([resumeStepKey]). `?step=` can go back to an earlier step, never
///   past the first unfinished one.
/// - `dl=return` (back from DigiLocker): the Aadhaar step finishes the check. If the pending DigiLocker attempt
///   belongs to a lane join, the person goes to the lane screen instead, which finishes it.
/// - A flag that is off (`404 not_enabled`) shows "Coming soon".
class HostOnboardingScreen extends ConsumerStatefulWidget {
  const HostOnboardingScreen({
    super.key,
    this.step,
    this.digiLockerReturn = false,
  });

  final String? step;
  final bool digiLockerReturn;

  @override
  ConsumerState<HostOnboardingScreen> createState() =>
      _HostOnboardingScreenState();
}

class _HostOnboardingScreenState extends ConsumerState<HostOnboardingScreen> {
  String? _key;

  /// Whether the last step change moved forward (the new step slides in from the right) or back.
  bool _forward = true;

  void _setKey(String key) {
    final from = onboardingStepIndex(_key, standardPlan: _standardPlan);
    final to = onboardingStepIndex(key, standardPlan: _standardPlan);
    _forward = from < 0 || to >= from;
    _key = key;
  }

  bool get _standardPlan {
    final state = ref.read(onboardingStateProvider);
    final creator = state.hasValue && state.value?.isCreator == true;
    return hfStdPlanOn(ref.read(flagsProvider)) && !creator;
  }

  List<OnboardingStepDef> get _steps =>
      onboardingSteps(standardPlan: _standardPlan);

  @override
  void initState() {
    super.initState();
    if (widget.digiLockerReturn) unawaited(_routeDigiLockerReturn());
  }

  @override
  void didUpdateWidget(covariant HostOnboardingScreen old) {
    super.didUpdateWidget(old);
    if (widget.digiLockerReturn && !old.digiLockerReturn) {
      unawaited(_routeDigiLockerReturn());
    }
    if (widget.step != old.step ||
        (widget.digiLockerReturn && !old.digiLockerReturn)) {
      final s = ref.read(onboardingStateProvider);
      final state = s.hasValue ? s.value : null;
      if (state != null) {
        setState(
          () => _key = startStepKey(
            state,
            requested: _requested,
            standardPlan: _standardPlan,
          ),
        );
      }
    }
  }

  String? get _requested =>
      widget.step ?? (widget.digiLockerReturn ? OnboardingKeys.aadhaar : null);

  /// A DigiLocker check that a lane join started finishes on the lane screen.
  Future<void> _routeDigiLockerReturn() async {
    final p = await ref.read(digiLockerPendingStoreProvider).read();
    if (!mounted) return;
    final pendingNext = p?.next;
    if (pendingNext != null && Uri.tryParse(pendingNext)?.path == Routes.identityKyc) {
      final next = Uri.parse(pendingNext);
      context.go(next.replace(queryParameters: {...next.queryParameters, 'dl': 'return'}).toString());
      return;
    }
    if (p != null && p.role == KycRole.laneCaller) {
      context.go(Routes.lanesOf(p.lane, next: p.next));
    }
  }

  Future<OnboardingServerState> _refresh() =>
      ref.refresh(onboardingStateProvider.future);

  Future<void> _next() async {
    try {
      await _refresh();
    } on ApiError {
      // keep going: the next step reads the server again when it needs to
    }
    if (!mounted) return;
    final steps = _steps;
    final i = onboardingStepIndex(_key, standardPlan: _standardPlan);
    if (i < 0 || i >= steps.length - 1) return;
    setState(() => _setKey(steps[i + 1].key));
  }

  void _goTo(String key) {
    if (onboardingStepIndex(key, standardPlan: _standardPlan) >= 0) {
      setState(() => _setKey(key));
    }
  }

  int get _index => onboardingStepIndex(_key, standardPlan: _standardPlan);

  bool get _atFirstStep => _key == null || _index <= 0;

  void _back() {
    if (_atFirstStep) {
      popOrHome(context);
    } else {
      setState(() => _setKey(_steps[_index - 1].key));
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(onboardingStateProvider);
    final standardPlan = hfStdPlanOn(ref.watch(flagsProvider));
    return PopScope(
      // Back always goes through _back: one step back, or (at the first step) pop, or Home when opened by a link.
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) _back();
      },
      child: Scaffold(
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              HfPageHeader(
                backKey: const ValueKey<String>('onboarding-back'),
                title: OnboardingCopy.screenTitle,
                onBack: _back,
              ),
              Expanded(child: _content(async, standardPlan)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _content(
    AsyncValue<OnboardingServerState> async,
    bool standardPlan,
  ) {
    return async.when(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      skipError: true,
      loading: () => const LoadingPanel(message: OnboardingCopy.loadingState),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) {
          return const ComingSoonPanel();
        }
        return ErrorPanel(
          error: e,
          onRetry: () => ref.invalidate(onboardingStateProvider),
        );
      },
      data: (state) => _body(state, standardPlan),
    );
  }

  Widget _body(OnboardingServerState state, bool standardPlan) {
    standardPlan = standardPlan && !state.isCreator;
    final steps = onboardingSteps(standardPlan: standardPlan);
    if (_key == null || onboardingStepIndex(_key, standardPlan: standardPlan) < 0) {
      _key = startStepKey(
        state,
        requested: _requested,
        standardPlan: standardPlan,
      );
    }
    final key = _key!;
    final index = onboardingStepIndex(key, standardPlan: standardPlan);
    final def = index >= 0 ? steps[index] : null;
    final builder = ref.watch(onboardingStepBuildersProvider)[key];
    final ctx = OnboardingStepContext(
      state: state,
      next: _next,
      goTo: _goTo,
      refresh: _refresh,
      digiLockerReturn:
          widget.digiLockerReturn && key == OnboardingKeys.aadhaar,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ProgressHeader(
          index: index < 0 ? 0 : index,
          total: steps.length,
          group: def?.group.label ?? '',
        ),
        Expanded(
          child: KeyedSubtree(
            key: ValueKey<String>('onboarding-step-$key'),
            child: StepEntrance(
              forward: _forward,
              child: builder == null
                  ? const _ComingStep()
                  : builder(context, ctx),
            ),
          ),
        ),
      ],
    );
  }
}

class _ProgressHeader extends StatelessWidget {
  const _ProgressHeader({
    required this.index,
    required this.total,
    required this.group,
  });

  final int index;
  final int total;
  final String group;

  HfTint get _tint {
    switch (group) {
      case 'Verify':
        return HfTint.sky;
      case 'Profile':
        return HfTint.peach;
      case 'Voice':
        return HfTint.blush;
      case 'Finish':
        return HfTint.butter;
      default:
        return HfTint.lavender;
    }
  }

  @override
  Widget build(BuildContext context) {
    final tint = _tint;
    final dark = HfBrightness.isDark(context);
    final label =
        '${OnboardingCopy.stepOf} ${index + 1} ${OnboardingCopy.of} $total';
    final deep = dark ? HfColors.lavenderLight : HfColors.lavenderDeep;
    // The pill is lavender; on a lavender strip it flips to the card colour so it stays visible.
    final pillBg = tint == HfTint.lavender
        ? (dark ? HfColors.darkCard : HfColors.surface)
        : HfTint.lavender.bg(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.sm,
        HfSpacing.pageWide,
        HfSpacing.sm,
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: HfSpacing.pageWide,
        vertical: 16,
      ),
      decoration: HfSurfaces.card(context, radius: HfRadius.tile),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (group.isNotEmpty)
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      group,
                      style: HfText.section.copyWith(color: deep),
                    ),
                  ),
                )
              else
                const Spacer(),
              const SizedBox(width: HfSpacing.sm),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: pillBg,
                  borderRadius: BorderRadius.circular(HfRadius.pillRadius),
                ),
                child: Text(
                  label,
                  key: const ValueKey<String>('onboarding-progress'),
                  style: HfText.badge.copyWith(color: deep),
                ),
              ),
            ],
          ),
          const SizedBox(height: HfSpacing.xl),
          TweenAnimationBuilder<double>(
            tween: Tween<double>(end: (index + 1) / total),
            duration: HfMotion.of(context, const Duration(milliseconds: 600)),
            curve: Curves.easeOutBack,
            builder: (context, value, _) => ProgressRibbon(
              value: value,
              track: dark ? HfColors.darkCard : HfColors.segmentTrack,
            ),
          ),
        ],
      ),
    );
  }
}

/// The onboarding progress as a growing ribbon: a rounded orange to deep-orange bar with a soft glow and a bright
/// tip. [value] is 0..1 (it may overshoot a little while it springs; it is clamped).
class ProgressRibbon extends StatelessWidget {
  const ProgressRibbon({super.key, required this.value, required this.track});

  final double value;
  final Color track;

  @override
  Widget build(BuildContext context) {
    final v = value.clamp(0.0, 1.0).toDouble();
    return Semantics(
      value: '${(v * 100).round()}%',
      child: Container(
        key: const ValueKey<String>('onboarding-ribbon'),
        height: 10,
        decoration: BoxDecoration(
          color: track,
          borderRadius: BorderRadius.circular(5),
        ),
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: v,
          heightFactor: 1,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: HfGradients.sunDeep,
              borderRadius: BorderRadius.circular(5),
              boxShadow: [
                BoxShadow(
                  color: HfColors.primary.withValues(alpha: 0.35),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ],
            ),
            child: Align(
              alignment: Alignment.centerRight,
              child: Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.only(right: 2),
                decoration: const BoxDecoration(
                  color: HfColors.sunshine,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Each new step slides in (from the right going forward, from the left going back) and fades in, 320 ms.
/// Only the incoming step animates: the old one is gone at once, so two steps are never on screen together.
class StepEntrance extends StatefulWidget {
  const StepEntrance({super.key, required this.forward, required this.child});

  final bool forward;
  final Widget child;

  @override
  State<StepEntrance> createState() => _StepEntranceState();
}

class _StepEntranceState extends State<StepEntrance>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
  );
  late final CurvedAnimation _curved = CurvedAnimation(
    parent: _c,
    curve: Curves.easeOutCubic,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (hfReduceMotion(context)) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _curved.dispose();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final curved = _curved;
    final from = Offset(widget.forward ? 0.12 : -0.12, 0);
    return FadeTransition(
      opacity: curved,
      child: SlideTransition(
        position: Tween<Offset>(begin: from, end: Offset.zero).animate(curved),
        child: widget.child,
      ),
    );
  }
}

/// A step nobody has registered yet (part B before HF-NATIVE-10 lands).
class _ComingStep extends StatelessWidget {
  const _ComingStep();

  @override
  Widget build(BuildContext context) => const ComingSoonPanel(
    title: OnboardingCopy.notBuiltTitle,
    body: OnboardingCopy.notBuiltBody,
  );
}
