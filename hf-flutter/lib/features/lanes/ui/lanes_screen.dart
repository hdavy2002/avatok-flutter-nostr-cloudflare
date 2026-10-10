import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../../kyc/kyc.dart';
import '../data/lanes_api.dart';

/// `/lanes?lane=women|lgbtq` (needs sign-in). Built in HF-NATIVE-8.
///
/// Joining a protected space (spec 2.12, worker routes/hf_lanes.ts):
///  1. the 18+ and rules tick boxes (LGBTQ+ also asks for the private self-declaration);
///  2. the shared Aadhaar check with `role: lane_caller` (OTP, DigiLocker as the fallback);
///  3. `POST /api/hf/lanes/women/join` or `.../lgbtq/join {declare:true, ack18:true}`.
/// A person who is already in sees "You're in" with Browse and Leave. Without `?lane=` both spaces are listed.
///
/// Telemetry carries only the lane name and a result, never gender or the declaration (`hf_app_lane_join`).
class LanesScreen extends ConsumerStatefulWidget {
  const LanesScreen({super.key, this.lane});

  final String? lane;

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
    final status = ref.watch(laneStatusProvider);
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: const HfBackButton(),
        title: const Text(LaneCopy.screenTitle),
      ),
      body: SafeArea(
        child: AsyncValueView<LaneStatus>(
          value: status,
          loadingMessage: LaneCopy.loading,
          onRetry: () => ref.invalidate(laneStatusProvider),
          data: (s) {
            final lane = _lane;
            if (lane == null) return _Chooser(status: s, onChoose: (l) => setState(() => _lane = l));
            return _LaneFlow(
              key: ValueKey<String>('lane-${lane.wire}'),
              lane: lane,
              status: s,
              onSeeBoth: widget.lane == null ? () => setState(() => _lane = null) : null,
            );
          },
        ),
      ),
    );
  }
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
        const Text(LaneCopy.chooseTitle, style: HfText.title),
        const SizedBox(height: 8),
        const Text(LaneCopy.chooseLead, style: HfText.bodyText),
        const SizedBox(height: 20),
        for (final l in Lane.values) ...[
          HfCard(
            key: ValueKey<String>('choose-${l.wire}'),
            color: l == Lane.women ? HfColors.blush : HfColors.lilac,
            onTap: () => onChoose(l),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
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
  const _LaneFlow({super.key, required this.lane, required this.status, this.onSeeBoth});

  final Lane lane;
  final LaneStatus status;
  final VoidCallback? onSeeBoth;

  @override
  ConsumerState<_LaneFlow> createState() => _LaneFlowState();
}

class _LaneFlowState extends ConsumerState<_LaneFlow> {
  bool _ack18 = false;
  bool _declare = false;
  late bool _aadhaarDone = widget.status.aadhaarVerified;
  String? _gender; // from this session's Aadhaar check
  bool _joining = false;
  bool _joined = false;
  bool _left = false;
  String? _error;
  String? _notEligible;

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

  bool get _inLane => !_left && (_joined || widget.status.granted(_lane));

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
      KycTelemetry.laneJoin(_lane.wire, 'joined');
      setState(() {
        _joined = true;
        _left = false;
      });
      ref.invalidate(laneStatusProvider);
      unawaited(ref.read(sessionProvider.notifier).refreshMe());
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
        _joined = false;
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
        Text(LaneCopy.titleOf(_lane), style: HfText.title),
        const SizedBox(height: 8),
        Text(LaneCopy.leadOf(_lane), style: HfText.bodyText),
        const SizedBox(height: 20),
        if (_inLane) ..._inBlock() else ..._joinBlock(),
        if (widget.onSeeBoth != null) ...[
          const SizedBox(height: 12),
          HfButton(label: LaneCopy.seeBoth, kind: HfButtonKind.text, onPressed: widget.onSeeBoth),
        ],
      ],
    );
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
          label: LaneCopy.browse,
          onPressed: () => context.go(Routes.exploreWith(lane: _lane.wire)),
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
      ConsentRow(
        key: const ValueKey<String>('lane-ack18'),
        value: _ack18,
        onChanged: (v) => setState(() => _ack18 = v),
        text: LaneCopy.ack18,
      ),
      if (_lane == Lane.lgbtq)
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
              onVerified: (r) => unawaited(_onAadhaar(r)),
            ),
          ),
        ),
      ],
      if (_error != null) InlineError(_error!),
      if (ineligible == null && _aadhaarDone) ...[
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('lane-join'),
          label: LaneCopy.join,
          loading: _joining,
          onPressed: _acksOk ? _join : null,
        ),
      ],
    ];
  }
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
      ? 'This space is for women. We check your Aadhaar once to make sure. We never show your details to anyone.'
      : 'A private, respectful space. You tell us it is right for you. We check your Aadhaar once so everyone here is a real adult. What you choose here is never shown to anyone.';

  static String leaveBody(Lane l) => 'You will stop seeing the ${titleOf(l).toLowerCase()}. You can join again later.';
}
