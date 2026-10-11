import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../../flow/onboarding_steps.dart';
import '../data/host_setup_api.dart';
import '../data/part_b_telemetry.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// How often the status is read (the contract says every 3 seconds). Tests make it short.
final generationPollIntervalProvider = Provider<Duration>((ref) => const Duration(seconds: 3));

/// After this long without an end, the screen says it is taking long and tells the host they can close the app.
const Duration kGenerationSlowAfter = Duration(minutes: 8);

const int kMaxGenerationTries = 3;

/// Step `generating`: starts the profile job (`POST /api/hosts/generate`) when it is not already running and
/// follows it (`GET /api/hosts/generate/status`, every 3 s) with three stages: text, images, safety.
///
/// - Host status `generating`: only follows the running job.
/// - A profile that was already made (`pending_host`, `rejected`, `paused`, ...): shows "Your profile is ready"
///   with "See my profile" and "Make a new version" (while tries are left), and never starts a job by itself.
/// - Any error is shown kindly; `profile_incomplete` lists the steps to fix with a button each.
/// - No network while following: says so and keeps trying.
class GeneratingStep extends ConsumerStatefulWidget {
  const GeneratingStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<GeneratingStep> createState() => _GeneratingStepState();
}

enum _Phase { starting, following, ready, failed }

class _GeneratingStepState extends ConsumerState<GeneratingStep> {
  _Phase _phase = _Phase.starting;
  GenerationStatus? _status;
  String? _error;
  List<String> _fixSteps = const <String>[];
  bool _offline = false;
  bool _slow = false;
  bool _exhausted = false;
  bool _disposed = false;
  bool _finishing = false;
  Timer? _timer;
  Timer? _slowTimer;

  OnboardingStepContext get ctx => widget.ctx;

  int get _attempts => ctx.state.hostNum('genAttempts')?.toInt() ?? 0;

  @override
  void initState() {
    super.initState();
    final status = ctx.state.hostStatus;
    if (status == 'generating') {
      _follow();
    } else if (ctx.state.generated) {
      _phase = _Phase.ready;
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_disposed) unawaited(_start());
      });
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _slowTimer?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _phase = _Phase.starting;
      _error = null;
      _fixSteps = const <String>[];
      _exhausted = false;
      _status = null;
    });
    try {
      await ref.read(hostSetupApiProvider).startGeneration();
      OnboardingTelemetry.step('generating', 'started');
      if (_disposed) return;
      _follow();
    } on ApiError catch (e) {
      if (_disposed) return;
      if (e.code == 'already_generating') {
        _follow();
        return;
      }
      OnboardingTelemetry.step('generating', 'error', reason: e.code, status: e.status);
      setState(() {
        _phase = _Phase.failed;
        if (e.code == 'attempts_exhausted') {
          _exhausted = true;
          _error = PartBCopy.generatingExhausted;
        } else if (e.code == 'profile_incomplete') {
          _fixSteps = missingSteps(e);
          _error = PartBCopy.generatingMissing;
        } else {
          _error = e.userMessage;
        }
      });
    }
  }

  void _follow() {
    setState(() {
      _phase = _Phase.following;
      _error = null;
    });
    _slowTimer?.cancel();
    _slowTimer = Timer(kGenerationSlowAfter, () {
      if (!_disposed) setState(() => _slow = true);
    });
    unawaited(_poll());
  }

  Future<void> _poll() async {
    if (_disposed || _finishing || _phase != _Phase.following) return;
    try {
      final st = await ref.read(hostSetupApiProvider).generationStatus();
      if (_disposed) return;
      _offline = false;
      setState(() => _status = st);
      if (st.anyFailed) {
        _slowTimer?.cancel();
        OnboardingTelemetry.step('generating', 'failed', reason: st.error);
        setState(() {
          _phase = _Phase.failed;
          _error = PartBCopy.generatingFailed;
        });
        return;
      }
      if (st.finished || const {'done', 'complete', 'completed', 'succeeded'}.contains(st.status)) {
        await _finish();
        return;
      }
    } on ApiError catch (e) {
      if (_disposed) return;
      if (e.isOffline || e.code == ApiError.codeTimeout) {
        setState(() => _offline = true);
      } else if (e.isUnauthorized) {
        setState(() {
          _phase = _Phase.failed;
          _error = e.userMessage;
        });
        return;
      } else {
        // A hiccup on the server: keep following, the job itself is not affected.
        setState(() => _offline = true);
      }
    }
    _timer?.cancel();
    _timer = Timer(ref.read(generationPollIntervalProvider), () => unawaited(_poll()));
  }

  Future<void> _finish() async {
    if (_finishing) return;
    _finishing = true;
    _slowTimer?.cancel();
    OnboardingTelemetry.step('generating', 'done');
    await ctx.next();
  }

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.ready:
        return _ready();
      case _Phase.failed:
        return _failed();
      case _Phase.starting:
      case _Phase.following:
        return _following();
    }
  }

  Widget _stageList() {
    final st = _status;
    return HfCard(
      key: const ValueKey<String>('gen-stages'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _StageRow(
            id: 'text',
            label: PartBCopy.stageText,
            state: st?.stage('text') ?? 'waiting',
          ),
          _StageRow(
            id: 'images',
            label: PartBCopy.stageImages,
            state: st?.stage('images') ?? 'waiting',
          ),
          _StageRow(
            id: 'safety',
            label: PartBCopy.stageSafety,
            state: st?.stage('safety') ?? 'waiting',
          ),
        ],
      ),
    );
  }

  Widget _following() {
    return PartBStep(
      scene: HfSceneKind.profile,
      title: PartBCopy.generatingTitle,
      lead: PartBCopy.generatingLead,
      children: [
        if (_phase == _Phase.starting && _status == null)
          const Padding(
            padding: EdgeInsets.only(bottom: 12),
            child: Text(PartBCopy.generatingStarting, key: ValueKey<String>('gen-starting'), style: HfText.bodyText),
          ),
        Semantics(liveRegion: true, child: _stageList()),
        if (_offline)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: Text(PartBCopy.generatingOffline, key: ValueKey<String>('gen-offline'), style: HfText.note),
          ),
        if (_slow)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: Text(PartBCopy.generatingSlow, key: ValueKey<String>('gen-slow'), style: HfText.note),
          ),
      ],
    );
  }

  Widget _failed() {
    final tries = kMaxGenerationTries - _attempts;
    return PartBStep(
      scene: HfSceneKind.profile,
      title: PartBCopy.generatingTitle,
      lead: PartBCopy.generatingLead,
      bottom: [
        if (!_exhausted && _fixSteps.isEmpty)
          HfButton(key: const ValueKey<String>('gen-retry'), label: PartBCopy.tryAgain, onPressed: _start),
      ],
      children: [
        if (_status != null) _stageList(),
        const SizedBox(height: 12),
        if (_error != null) InlineError(_error!),
        if (!_exhausted && _fixSteps.isEmpty && _attempts > 0 && tries > 0)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(PartBCopy.triesLeft(tries), style: HfText.note),
          ),
        for (final key in _fixSteps)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: HfButton(
              key: ValueKey<String>('gen-fix-$key'),
              label: '${PartBCopy.fixThis}: ${_titleOf(key)}',
              kind: HfButtonKind.secondary,
              onPressed: () => ctx.goTo(key),
            ),
          ),
      ],
    );
  }

  Widget _ready() {
    final tries = kMaxGenerationTries - _attempts;
    return PartBStep(
      scene: HfSceneKind.profile,
      title: PartBCopy.generatingReadyTitle,
      lead: PartBCopy.generatingReadyBody,
      bottom: [
        HfButton(
          key: const ValueKey<String>('gen-see'),
          label: PartBCopy.seeMyProfile,
          onPressed: () => ctx.goTo(OnboardingKeys.preview),
        ),
        if (tries > 0 && ctx.state.hostStatus != 'pending_review' && ctx.state.hostStatus != 'live')
          HfButton(
            key: const ValueKey<String>('gen-again'),
            label: '${PartBCopy.makeNewVersion} (${PartBCopy.triesLeft(tries)})',
            kind: HfButtonKind.text,
            onPressed: _start,
          ),
      ],
      children: const [DoneRow(PartBCopy.generatingReadyTitle)],
    );
  }

  static String _titleOf(String key) {
    for (final d in kOnboardingSteps) {
      if (d.key == key) return d.title;
    }
    return key;
  }
}

/// One line of the stage list: an icon for the state, the label and the state as a word (so colour is never the
/// only sign). Never green: done is orchid, failed is the alert red.
class _StageRow extends StatelessWidget {
  const _StageRow({required this.id, required this.label, required this.state});

  final String id;
  final String label;
  final String state;

  String get _word {
    switch (state) {
      case 'done':
        return PartBCopy.stageDone;
      case 'working':
        return PartBCopy.stageWorking;
      case 'skipped':
        return PartBCopy.stageSkipped;
      case 'failed':
        return PartBCopy.stageFailed;
    }
    return PartBCopy.stageWaiting;
  }

  @override
  Widget build(BuildContext context) {
    final Widget icon;
    switch (state) {
      case 'done':
      case 'skipped':
        icon = const Icon(Icons.check_circle_rounded, size: 28, color: HfColors.forest);
      case 'working':
        icon = const Padding(
          padding: EdgeInsets.all(3),
          child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 3)),
        );
      case 'failed':
        icon = const Icon(Icons.error_rounded, size: 28, color: HfColors.accent);
      default:
        icon = const Icon(Icons.radio_button_unchecked_rounded, size: 28, color: HfColors.mauve);
    }
    return Semantics(
      label: '$label, $_word',
      excludeSemantics: true,
      child: Padding(
        key: ValueKey<String>('gen-stage-$id-$state'),
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            SizedBox(width: 32, height: 32, child: Center(child: icon)),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: HfText.bodyStrong),
              const SizedBox(height: 4),
              Text(_word, style: HfText.note),
            ])),
          ],
        ),
      ),
    );
  }
}
