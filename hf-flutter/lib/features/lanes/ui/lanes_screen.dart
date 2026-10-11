import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/pending_intent.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../../kyc/kyc.dart';
import '../../call/data/call_api.dart';
import '../data/lanes_api.dart';

/// `/lanes?lane=women|lgbtq`: public explanation, authenticated verification. Built in HF-NATIVE-8.
///
/// Joining a protected space (spec 2.12, worker routes/hf_lanes.ts):
///  1. the 18+ and rules tick boxes (LGBTQ+ also asks for the private self-declaration);
///  2. the shared Aadhaar check with `role: lane_caller` (OTP, DigiLocker as the fallback);
///  3. `POST /api/hf/lanes/women/join` or `.../lgbtq/join {declare:true, ack18:true}`.
/// A person who is already in sees "You're in" with Browse and Leave. Without `?lane=` both spaces are listed.
///
/// Telemetry carries only the lane name and a result, never gender or the declaration (`hf_app_lane_join`).
class LanesScreen extends ConsumerStatefulWidget {
  const LanesScreen({super.key, this.lane, this.next});

  final String? lane;
  final String? next;

  @override
  ConsumerState<LanesScreen> createState() => _LanesScreenState();
}

class _LanesScreenState extends ConsumerState<LanesScreen> {
  Lane? _lane;

  @override
  void initState() {
    super.initState();
    _lane = Lane.parse(widget.lane);
  }

  @override
  void didUpdateWidget(covariant LanesScreen old) {
    super.didUpdateWidget(old);
    if (old.lane != widget.lane) setState(() => _lane = Lane.parse(widget.lane));
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = ref.watch(sessionProvider).isSignedIn;
    final Widget body;
    if (!signedIn) {
      final lane = _lane;
      body = lane == null
          ? _Chooser(status: const LaneStatus(), onChoose: (l) => setState(() => _lane = l))
          : _GuestIntro(lane: lane, onContinue: () => requireSignIn(context, ref,
              next: Routes.lanesOf(lane.wire, next: Routes.safeNext(widget.next))),
              onSeeBoth: widget.lane == null ? () => setState(() => _lane = null) : null);
    } else {
      body = AsyncValueView<LaneStatus>(
        value: ref.watch(laneStatusProvider),
        loadingMessage: LaneCopy.loading,
        onRetry: () => ref.invalidate(laneStatusProvider),
        data: (s) {
          final lane = _lane;
          if (lane == null) return _Chooser(status: s, onChoose: (l) => setState(() => _lane = l));
          return _LaneFlow(key: ValueKey<String>('lane-${lane.wire}'), lane: lane,
            status: s, next: Routes.safeNext(widget.next),
            onSeeBoth: widget.lane == null ? () => setState(() => _lane = null) : null);
        },
      );
    }
    return PopScope(
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) unawaited(ref.read(pendingIntentProvider).clear());
      },
      child: Scaffold(
      appBar: AppBar(automaticallyImplyLeading: false, leading: IconButton(
        tooltip: 'Back', icon: const Icon(Icons.arrow_back_rounded), onPressed: () async {
          await ref.read(pendingIntentProvider).clear();
          if (context.mounted) popOrHome(context);
        }), title: const Text(LaneCopy.screenTitle)),
      body: SafeArea(child: body),
      ),
    );
  }

}

class _GuestIntro extends StatelessWidget {
  const _GuestIntro({required this.lane, required this.onContinue, this.onSeeBoth});
  final Lane lane;
  final VoidCallback onContinue;
  final VoidCallback? onSeeBoth;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(HfSpacing.page),
    children: [
      HfScene(kind: lane == Lane.women ? HfSceneKind.women : HfSceneKind.lgbtq, height: 160),
      const SizedBox(height: 20),
      Text(LaneCopy.titleOf(lane), style: HfText.title),
      const SizedBox(height: 12),
      Text(LaneCopy.leadOf(lane), style: HfText.bodyText),
      const SizedBox(height: 20),
      HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Icon(Icons.shield_outlined, size: 36, color: HfColors.ink),
        const SizedBox(height: 12),
        const Text('Your details stay private', style: HfText.subtitle),
        const SizedBox(height: 8),
        Text(lane == Lane.women
          ? 'Sign in or create an account, confirm you are 18+, then verify Aadhaar. Access is for Aadhaar female or transgender records. Existing verification is reused.'
          : 'Sign in or create an account, make a private declaration, verify Aadhaar, and record a short video for team approval. The video confirms authenticity, never orientation.', style: HfText.bodyText),
        const SizedBox(height: 20),
        HfButton(key: const ValueKey<String>('lane-sign-in'), label: 'Sign in or register to continue', onPressed: onContinue),
      ])),
      if (onSeeBoth != null) HfButton(label: LaneCopy.seeBoth, kind: HfButtonKind.text, onPressed: onSeeBoth),
    ],
  );
}

class _Chooser extends StatelessWidget {
  const _Chooser({required this.status, required this.onChoose});

  final LaneStatus status;
  final void Function(Lane lane) onChoose;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(HfSpacing.page),
      children: [
        const HfScene(kind: HfSceneKind.women, height: 160),
        const SizedBox(height: 20),
        const Text(LaneCopy.chooseTitle, style: HfText.title),
        const SizedBox(height: 8),
        const Text(LaneCopy.chooseLead, style: HfText.bodyText),
        const SizedBox(height: 20),
        for (final l in Lane.values) ...[
          HfCard(
            key: ValueKey<String>('choose-${l.wire}'),
            color: HfColors.white,
            onTap: () => onChoose(l),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                HfScene(kind: l == Lane.women ? HfSceneKind.women : HfSceneKind.lgbtq, height: 104),
                const SizedBox(height: 16),
                Text(LaneCopy.titleOf(l), style: HfText.subtitle),
                const SizedBox(height: 6),
                Text(LaneCopy.shortOf(l), style: HfText.bodyText),
                const SizedBox(height: 12),
                Text(status.granted(l) ? LaneCopy.youAreIn : LaneCopy.tapToJoin, style: HfText.badge),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
      ],
    );
  }
}

class _LaneFlow extends ConsumerStatefulWidget {
  const _LaneFlow({super.key, required this.lane, required this.status, this.onSeeBoth, this.next});

  final Lane lane;
  final LaneStatus status;
  final VoidCallback? onSeeBoth;
  final String? next;

  @override
  ConsumerState<_LaneFlow> createState() => _LaneFlowState();
}

class _LaneFlowState extends ConsumerState<_LaneFlow> {
  bool _ack18 = false;
  bool _declare = false;
  late bool _aadhaarDone = widget.status.aadhaarVerified;
  String? _gender; // from this session's Aadhaar check
  bool _joining = false;
  LaneStatus? _fresh;
  bool _recordAgain = false;
  bool _videoUploaded = false;
  bool _left = false;
  String? _error;
  String? _notEligible;

  @override
  void didUpdateWidget(covariant _LaneFlow old) {
    super.didUpdateWidget(old);
    if (old.status != widget.status) {
      _fresh = null;
      _aadhaarDone = widget.status.aadhaarVerified;
    }
  }

  Lane get _lane => widget.lane;

  bool get _acksOk => _ack18 && (_lane == Lane.women || _declare);

  /// Already eligible by the stored record, or by what the check just returned.
  bool get _eligible {
    if (_lane != Lane.women) return true;
    if (_notEligible != null) return false;
    if (_gender != null) return _gender == 'F' || _gender == 'T';
    if (widget.status.aadhaarVerified) return widget.status.womenEligible;
    return true;
  }

  LaneStatus get _status => _fresh ?? widget.status;
  bool get _inLane => !_left && _status.granted(_lane);
  bool get _declared => !_left && _status.lgbtqDeclared;
  String get _selfieStatus => _videoUploaded ? 'pending' : _status.selfieStatus;

  Future<void> _checkStatus() async {
    try {
      final fresh = await ref.read(lanesApiProvider).me();
      if (!mounted) return;
      setState(() {
        _fresh = fresh;
        _videoUploaded = false;
        _error = null;
      });
      ref.invalidate(laneStatusProvider);
      unawaited(ref.read(sessionProvider.notifier).refreshMe());
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.userMessage);
    }
  }

  void _onVideoUploaded() {
    setState(() {
      _videoUploaded = true;
      _recordAgain = false;
    });
    unawaited(_checkStatus());
  }

  Future<void> _onAadhaar(AadhaarResult r) async {
    if (!mounted) return;
    setState(() {
      _aadhaarDone = true;
      _gender = r.gender;
      _error = null;
    });
    if (_lane == Lane.women && r.gender != null && !r.isFemaleOrTransgender) {
      KycTelemetry.laneJoin(_lane.wire, 'not_eligible', reason: 'aadhaar_record');
      setState(() => _notEligible = LaneCopy.womenNotEligible);
      return;
    }
    if (_acksOk) await _join();
  }

  Future<void> _join() async {
    if (_joining || !_acksOk || !_aadhaarDone || !_eligible) return;
    setState(() {
      _joining = true;
      _error = null;
    });
    final api = ref.read(lanesApiProvider);
    try {
      if (_lane == Lane.women) {
        await api.joinWomen();
      } else {
        await api.joinLgbtq(declare: true, ack18: true);
      }
      if (!mounted) return;
      setState(() => _left = false);
      // A successful declaration is not access. Read the current video decision.
      await _checkStatus();
      KycTelemetry.laneJoin(_lane.wire, _inLane ? 'joined' : 'pending');
    } on ApiError catch (e) {
      if (!mounted) return;
      final result = e.code == 'not_eligible'
          ? 'not_eligible'
          : (e.code == 'aadhaar_required' ? 'aadhaar_required' : 'error');
      KycTelemetry.laneJoin(_lane.wire, result, reason: e.code, status: e.status);
      setState(() {
        if (e.code == 'not_eligible') {
          _notEligible = e.userMessage;
        } else {
          _error = e.userMessage;
        }
      });
    } finally {
      if (mounted) setState(() => _joining = false);
    }
  }

  Future<void> _leave() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(LaneCopy.leaveTitle, style: HfText.title),
        content: Text(LaneCopy.leaveBody(_lane), style: HfText.bodyText),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text(LaneCopy.stay)),
          TextButton(
            key: const ValueKey<String>('leave-confirm'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(LaneCopy.leave),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    try {
      await ref.read(lanesApiProvider).leave(_lane);
      if (!mounted) return;
      setState(() {
        _left = true;
        _fresh = null;
        _ack18 = false;
        _declare = false;
      });
      ref.invalidate(laneStatusProvider);
      unawaited(ref.read(sessionProvider.notifier).refreshMe());
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.userMessage);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(HfSpacing.page),
      children: [
        HfScene(kind: _lane == Lane.women ? HfSceneKind.women : HfSceneKind.lgbtq, height: 150),
        const SizedBox(height: 20),
        Text(LaneCopy.titleOf(_lane), style: HfText.title),
        const SizedBox(height: 8),
        Text(LaneCopy.leadOf(_lane), style: HfText.bodyText),
        const SizedBox(height: 20),
        HfCard(child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: _inLane ? _inBlock() : _joinBlock(),
        )),
        if (widget.onSeeBoth != null) ...[
          const SizedBox(height: 12),
          HfButton(label: LaneCopy.seeBoth, kind: HfButtonKind.text, onPressed: widget.onSeeBoth),
        ],
      ],
    );
  }

  Future<void> _openDestination(String destination) async {
    await ref.read(pendingIntentProvider).clear();
    if (!mounted) return;
    final uri = Uri.tryParse(destination);
    final slug = uri?.queryParameters['host'];
    if (uri?.path == '/call/new' && slug != null && slug.isNotEmpty) {
      ref.invalidate(callEstimateProvider(slug));
    }
    context.go(destination);
  }

  List<Widget> _inBlock() => [
        const HfCard(
          key: ValueKey<String>('lane-in'),
          color: HfColors.lilac,
          child: DoneRow(LaneCopy.youAreIn),
        ),
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('lane-browse'),
          label: widget.next == null ? LaneCopy.browse : 'Continue',
          onPressed: () => _openDestination(Routes.safeNext(widget.next) ?? Routes.exploreWith(lane: _lane.wire)),
        ),
        const SizedBox(height: 8),
        HfButton(
          key: const ValueKey<String>('lane-leave'),
          label: LaneCopy.leaveButton,
          kind: HfButtonKind.secondary,
          onPressed: _leave,
        ),
        if (_error != null) InlineError(_error!),
      ];

  List<Widget> _joinBlock() {
    final ineligible = _notEligible ?? (!_eligible ? LaneCopy.womenNotEligible : null);
    return [
      if (_left)
        const Padding(
          padding: EdgeInsets.only(bottom: 16),
          child: InfoBox(title: LaneCopy.leftTitle),
        ),
      if (!_declared || _lane == Lane.women) ConsentRow(
        key: const ValueKey<String>('lane-ack18'),
        value: _ack18,
        onChanged: (v) => setState(() => _ack18 = v),
        text: LaneCopy.ack18,
      ),
      if (_lane == Lane.lgbtq && !_declared)
        ConsentRow(
          key: const ValueKey<String>('lane-declare'),
          value: _declare,
          onChanged: (v) => setState(() => _declare = v),
          text: LaneCopy.declare,
        ),
      const SizedBox(height: 16),
      if (ineligible != null)
        InfoBox(
          key: const ValueKey<String>('lane-not-eligible'),
          title: LaneCopy.notEligibleTitle,
          body: ineligible,
          color: HfColors.blush,
        )
      else if (_aadhaarDone)
        const DoneRow(KycCopy.aadhaarVerified)
      else ...[
        if (!_acksOk) const Padding(padding: EdgeInsets.only(bottom: 8), child: Text(LaneCopy.tickFirst, style: HfText.note)),
        Opacity(
          opacity: _acksOk ? 1 : 0.5,
          child: AbsorbPointer(
            absorbing: !_acksOk,
            child: AadhaarVerifyWidget(
              role: KycRole.laneCaller,
              lane: _lane.wire,
              next: widget.next,
              onVerified: (r) => unawaited(_onAadhaar(r)),
            ),
          ),
        ),
      ],
      if (_error != null) InlineError(_error!),
      if (_lane == Lane.lgbtq && _aadhaarDone && _declared) ..._videoBlock(),
      if (ineligible == null && _aadhaarDone && (_lane == Lane.women || !_declared)) ...[
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('lane-join'),
          label: _lane == Lane.lgbtq ? 'Save declaration and continue' : LaneCopy.join,
          loading: _joining,
          onPressed: _acksOk ? _join : null,
        ),
      ],
    ];
  }

  List<Widget> _videoBlock() => [
    const SizedBox(height: 20),
    const DoneRow('Private declaration saved'),
    const SizedBox(height: 16),
    const Text('A private authenticity check', style: HfText.subtitle),
    const SizedBox(height: 8),
    const Text('The video confirms it is you. It does not verify your orientation or identity as LGBTQ+. Only our verification team sees it.', style: HfText.bodyText),
    const SizedBox(height: 16),
    if (_selfieStatus == 'pending' && !_recordAgain) ...[
      const InfoBox(key: ValueKey<String>('lane-video-pending'), title: 'Video is with our team',
        body: 'Your access opens after approval. You can keep browsing the public marketplace while we check.'),
      const SizedBox(height: 12),
      HfButton(label: 'Check review status', onPressed: _checkStatus),
      HfButton(label: KycCopy.recordAgain, kind: HfButtonKind.text,
        onPressed: () => setState(() { _recordAgain = true; _videoUploaded = false; })),
    ] else if (_selfieStatus == 'approved') ...[
      const DoneRow('Your approved video is ready to reuse'),
      HfButton(label: 'Check access', onPressed: _checkStatus),
    ] else ...[
      if (_selfieStatus == 'rejected') ...[
        InfoBox(key: const ValueKey<String>('lane-video-rejected'), title: 'Please record a new video',
          body: _status.selfieReason ?? 'Keep your face clear and say the code shown on screen.', color: HfColors.blush),
        const SizedBox(height: 16),
      ],
      SelfieVideoWidget(onUploaded: _onVideoUploaded),
    ],
    const SizedBox(height: 12),
    HfButton(label: 'Browse public hosts', kind: HfButtonKind.secondary, onPressed: () => _openDestination(Routes.home)),
    HfButton(key: const ValueKey<String>('lane-leave'), label: 'Withdraw my declaration', kind: HfButtonKind.text, onPressed: _leave),
  ];

}

/// Copy for the lane screens (simple English).
abstract final class LaneCopy {
  static const String screenTitle = 'Verify to join';
  static const String loading = 'Checking your spaces…';
  static const String chooseTitle = 'Protected spaces';
  static const String chooseLead =
      'Some conversations feel safer in a space made for you. Joining is free and takes a few minutes.';
  static const String youAreIn = "You're in";
  static const String tapToJoin = 'Tap to join';
  static const String seeBoth = 'See both spaces';
  static const String browse = 'See people in this space';
  static const String leaveButton = 'Leave this space';
  static const String leaveTitle = 'Leave this space?';
  static const String stay = 'Stay';
  static const String leave = 'Leave';
  static const String leftTitle = 'You left this space. You can join again any time.';
  static const String join = 'Join this space';
  static const String tickFirst = 'Tick the boxes above to go on.';
  static const String notEligibleTitle = 'This space is not open to you';
  static const String womenNotEligible =
      'The women-only space is open to callers whose Aadhaar shows female or transgender.';
  static const String ack18 = 'I am 18 or older, and I will follow the community guidelines.';
  static const String declare =
      'This space is right for me. I understand it is private, and I am choosing to join myself.';

  static String titleOf(Lane l) => l == Lane.women ? 'Women-only space' : 'LGBTQ+ space';

  static String shortOf(Lane l) =>
      l == Lane.women ? 'Talk with hosts in a calmer space for women.' : 'A private, respectful space to talk.';

  static String leadOf(Lane l) => l == Lane.women
      ? 'For people whose Aadhaar shows female or transgender. We check Aadhaar once; no caller selfie is needed. Your verification details stay private.'
      : 'A private space for LGBTQ+ people. First make your own private declaration, then verify Aadhaar and a short video. A team member approves the video before access opens. Your declaration is never put on your public profile.';

  static String leaveBody(Lane l) => 'You will stop seeing the ${titleOf(l).toLowerCase()}. You can join again later.';
}
