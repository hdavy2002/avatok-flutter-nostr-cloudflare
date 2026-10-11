import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/hf_theme.dart';
import '../../core/widgets/widgets.dart';
import '../call/data/call_models.dart';
import '../call/ui/call_live_view.dart';
import '../call/ui/call_summary.dart';
import 'demo_data.dart';
import 'demo_widgets.dart';

/// Where the simulated call is. [status] walks `ringing_host` -> `ringing_caller` -> `connected` -> `completed`
/// (or ends early as `noAnswer` when the person cancels while it rings).
class DemoCallState {
  const DemoCallState({
    this.status = CallStatus.ringingHost,
    this.elapsedSeconds = 0,
    this.cancelledByMe = false,
    this.reviewed = false,
  });

  final CallStatus status;
  final int elapsedSeconds;
  final bool cancelledByMe;
  final bool reviewed;

  /// Whole minutes, rounded up, at least one once the call connected (the same rule the real bill uses).
  int get billedMinutes {
    if (status != CallStatus.completed) return 0;
    final m = (elapsedSeconds + 59) ~/ 60;
    return m < 1 ? 1 : m;
  }

  /// Rupees the real flow would have charged. Nothing is charged in the demo.
  int get pretendCharge => billedMinutes * kDemoNehaCard.pricePerMin;

  CallInfo get info => CallInfo(
    id: kDemoCallId,
    status: status,
    hostSlug: kDemoNehaSlug,
    hostName: 'Neha',
    rate: kDemoNehaCard.pricePerMin,
    billedMinutes: billedMinutes,
    chargedRupees: pretendCharge,
    endReason: status == CallStatus.completed ? 'caller_hangup' : null,
    canReview: status == CallStatus.completed,
  );

  DemoCallState copyWith({
    CallStatus? status,
    int? elapsedSeconds,
    bool? cancelledByMe,
    bool? reviewed,
  }) => DemoCallState(
    status: status ?? this.status,
    elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
    cancelledByMe: cancelledByMe ?? this.cancelledByMe,
    reviewed: reviewed ?? this.reviewed,
  );
}

/// Drives the pretend call: no network, no wallet, no real telemetry (only `hf_demo_flow {step}`).
class DemoCallController extends Notifier<DemoCallState> {
  static const Duration ringingHostFor = Duration(seconds: 3);
  static const Duration ringingCallerFor = Duration(seconds: 4);

  Timer? _step;
  Timer? _clock;
  bool _started = false;

  @override
  DemoCallState build() {
    ref.onDispose(_stopTimers);
    return const DemoCallState();
  }

  void _stopTimers() {
    _step?.cancel();
    _clock?.cancel();
    _step = null;
    _clock = null;
  }

  /// Starts the sequence once (the screen calls this when it opens).
  void start() {
    if (_started) return;
    _started = true;
    demoStep('ringing_host');
    _step = Timer(ringingHostFor, () {
      state = state.copyWith(status: CallStatus.ringingCaller);
      HapticFeedback.lightImpact();
      demoStep('ringing_caller');
      _step = Timer(ringingCallerFor, _connect);
    });
  }

  void _connect() {
    state = state.copyWith(status: CallStatus.connected, elapsedSeconds: 0);
    HapticFeedback.mediumImpact();
    demoStep('connected');
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      state = state.copyWith(elapsedSeconds: state.elapsedSeconds + 1);
    });
  }

  /// "Cancel call": only while it rings.
  void cancel() {
    if (!state.status.isRinging) return;
    _stopTimers();
    state = state.copyWith(status: CallStatus.noAnswer, cancelledByMe: true);
    HapticFeedback.selectionClick();
    demoStep('cancelled');
  }

  /// "End demo call": only once connected.
  void end() {
    if (state.status != CallStatus.connected) return;
    _stopTimers();
    state = state.copyWith(status: CallStatus.completed);
    HapticFeedback.mediumImpact();
    demoStep('ended');
  }

  void markReviewed() => state = state.copyWith(reviewed: true);
}

final demoCallProvider =
    NotifierProvider.autoDispose<DemoCallController, DemoCallState>(
      DemoCallController.new,
    );

/// `/call/demo-call`: the real live view and summary, driven by [DemoCallController] instead of `CallApi`.
class DemoCallScreen extends ConsumerStatefulWidget {
  const DemoCallScreen({super.key});

  @override
  ConsumerState<DemoCallScreen> createState() => _DemoCallScreenState();
}

class _DemoCallScreenState extends ConsumerState<DemoCallScreen> {
  @override
  void initState() {
    super.initState();
    // After the first frame, so the provider is not changed while the tree builds.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(demoCallProvider.notifier).start();
    });
  }

  Future<void> _rate() async {
    final router = GoRouter.of(context);
    final result = await router.push<bool>(Routes.reviewCallOf(kDemoCallId));
    if (result == true && mounted) {
      ref.read(demoCallProvider.notifier).markReviewed();
      router.go(Routes.explore);
    }
  }

  void _done() => GoRouter.of(context).go(Routes.explore);

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(demoCallProvider);
    final live = !s.status.isTerminal;
    final dark = HfBrightness.isDark(context);
    return Scaffold(
      backgroundColor: live
          ? (dark
                ? HfColors.darkBg
                : Color.lerp(HfColors.page, HfColors.lavender, 0.45))
          : null,
      appBar: live
          ? null
          : AppBar(
              automaticallyImplyLeading: false,
              title: const Text(CallStrings.screenTitle),
            ),
      body: SafeArea(child: live ? _live(s) : _summary(s)),
    );
  }

  Widget _live(DemoCallState s) {
    final connected = s.status == CallStatus.connected;
    final ctl = ref.read(demoCallProvider.notifier);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: EdgeInsets.only(top: HfSpacing.md),
          child: Center(child: DemoChip()),
        ),
        Expanded(
          child: SingleChildScrollView(
            child: CallLiveView(info: s.info, elapsedSeconds: s.elapsedSeconds),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            HfSpacing.pageWide,
            HfSpacing.sm,
            HfSpacing.pageWide,
            34,
          ),
          child: AnimatedSwitcher(
            duration: HfMotion.of(context, HfMotion.base),
            child: connected
                ? HfButton(
                    key: const ValueKey<String>('demo-end'),
                    label: 'End demo call',
                    kind: HfButtonKind.secondary,
                    onPressed: ctl.end,
                  )
                : HfButton(
                    key: const ValueKey<String>('demo-cancel'),
                    label: CallStrings.cancelCall,
                    kind: HfButtonKind.secondary,
                    onPressed: ctl.cancel,
                  ),
          ),
        ),
      ],
    );
  }

  Widget _summary(DemoCallState s) {
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: constraints.maxHeight - HfSpacing.page * 2,
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Center(child: DemoChip()),
              const SizedBox(height: HfSpacing.lg),
              CallSummary(
                info: s.info,
                cancelledByMe: s.cancelledByMe,
                reviewed: s.reviewed,
                onRate: _rate,
                onDone: _done,
              ),
              const SizedBox(height: HfSpacing.lg),
              Text(
                'Demo — nothing was charged.',
                key: const ValueKey<String>('demo-not-charged'),
                textAlign: TextAlign.center,
                style: HfText.of(context, HfText.note),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
