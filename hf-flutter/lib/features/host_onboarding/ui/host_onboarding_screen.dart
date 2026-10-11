import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
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
        setState(() => _key = startStepKey(state, requested: _requested));
      }
    }
  }

  String? get _requested =>
      widget.step ?? (widget.digiLockerReturn ? OnboardingKeys.aadhaar : null);

  /// A DigiLocker check that a lane join started finishes on the lane screen.
  Future<void> _routeDigiLockerReturn() async {
    final p = await ref.read(digiLockerPendingStoreProvider).read();
    if (!mounted) return;
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
    final i = onboardingStepIndex(_key);
    if (i < 0 || i >= kOnboardingSteps.length - 1) return;
    setState(() => _key = kOnboardingSteps[i + 1].key);
  }

  void _goTo(String key) {
    if (onboardingStepIndex(key) >= 0) setState(() => _key = key);
  }

  int get _index => onboardingStepIndex(_key);

  bool get _atFirstStep => _key == null || _index <= 0;

  void _back() {
    if (_atFirstStep) {
      popOrHome(context);
    } else {
      setState(() => _key = kOnboardingSteps[_index - 1].key);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(onboardingStateProvider);
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
              Expanded(child: _content(async)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _content(AsyncValue<OnboardingServerState> async) {
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
      data: _body,
    );
  }

  Widget _body(OnboardingServerState state) {
    _key ??= startStepKey(state, requested: _requested);
    final key = _key!;
    final index = onboardingStepIndex(key);
    final def = index >= 0 ? kOnboardingSteps[index] : null;
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
          total: kOnboardingSteps.length,
          group: def?.group.label ?? '',
        ),
        Expanded(
          child: KeyedSubtree(
            key: ValueKey<String>('onboarding-step-$key'),
            child: builder == null
                ? const _ComingStep()
                : builder(context, ctx),
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
        ? (dark ? HfColors.darkCard : HfColors.white)
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
      decoration: BoxDecoration(
        color: tint.bg(context),
        borderRadius: BorderRadius.circular(HfRadius.tile),
      ),
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
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: TweenAnimationBuilder<double>(
              tween: Tween<double>(end: (index + 1) / total),
              duration: HfMotion.of(context, HfMotion.base),
              curve: HfMotion.curve,
              builder: (context, value, _) => LinearProgressIndicator(
                value: value,
                minHeight: 6,
                backgroundColor: dark
                    ? HfColors.darkCard
                    : HfColors.segmentTrack,
                color: deep,
              ),
            ),
          ),
        ],
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
