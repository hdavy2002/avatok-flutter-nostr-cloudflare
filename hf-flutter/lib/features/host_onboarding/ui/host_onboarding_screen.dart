import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
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
  const HostOnboardingScreen({super.key, this.step, this.digiLockerReturn = false});

  final String? step;
  final bool digiLockerReturn;

  @override
  ConsumerState<HostOnboardingScreen> createState() => _HostOnboardingScreenState();
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
    if (widget.digiLockerReturn && !old.digiLockerReturn) unawaited(_routeDigiLockerReturn());
    if (widget.step != old.step || (widget.digiLockerReturn && !old.digiLockerReturn)) {
      final s = ref.read(onboardingStateProvider);
      final state = s.hasValue ? s.value : null;
      if (state != null) setState(() => _key = startStepKey(state, requested: _requested));
    }
  }

  String? get _requested => widget.step ?? (widget.digiLockerReturn ? OnboardingKeys.aadhaar : null);

  /// A DigiLocker check that a lane join started finishes on the lane screen.
  Future<void> _routeDigiLockerReturn() async {
    final p = await ref.read(digiLockerPendingStoreProvider).read();
    if (!mounted) return;
    if (p != null && p.role == KycRole.laneCaller) context.go(Routes.lanesOf(p.lane, next: p.next));
  }

  Future<OnboardingServerState> _refresh() => ref.refresh(onboardingStateProvider.future);

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
        appBar: AppBar(
          automaticallyImplyLeading: false,
          leading: IconButton(
            key: const ValueKey<String>('onboarding-back'),
            tooltip: 'Back',
            icon: const Icon(Icons.arrow_back_rounded),
            onPressed: _back,
          ),
          title: const Text(OnboardingCopy.screenTitle),
        ),
        body: SafeArea(
          child: async.when(
            skipLoadingOnReload: true,
            skipLoadingOnRefresh: true,
            skipError: true,
            loading: () => const LoadingPanel(message: OnboardingCopy.loadingState),
            error: (e, _) {
              if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
              return ErrorPanel(error: e, onRetry: () => ref.invalidate(onboardingStateProvider));
            },
            data: _body,
          ),
        ),
      ),
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
      digiLockerReturn: widget.digiLockerReturn && key == OnboardingKeys.aadhaar,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ProgressHeader(index: index < 0 ? 0 : index, total: kOnboardingSteps.length, group: def?.group.label ?? ''),
        Expanded(
          child: KeyedSubtree(
            key: ValueKey<String>('onboarding-step-$key'),
            child: builder == null ? const _ComingStep() : builder(context, ctx),
          ),
        ),
      ],
    );
  }
}

class _ProgressHeader extends StatelessWidget {
  const _ProgressHeader({required this.index, required this.total, required this.group});

  final int index;
  final int total;
  final String group;

  @override
  Widget build(BuildContext context) {
    final label = '${OnboardingCopy.stepOf} ${index + 1} ${OnboardingCopy.of} $total${group.isEmpty ? '' : ', $group'}';
    return Padding(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 4, HfSpacing.page, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, key: const ValueKey<String>('onboarding-progress'), style: HfText.label),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: LinearProgressIndicator(
              value: (index + 1) / total,
              minHeight: 8,
              backgroundColor: HfColors.white,
              color: HfColors.forest,
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
  Widget build(BuildContext context) =>
      const ComingSoonPanel(title: OnboardingCopy.notBuiltTitle, body: OnboardingCopy.notBuiltBody);
}
