import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/api_exception.dart';
import '../data/models/spaces.dart';
import '../data/services.dart';
import '../data/telemetry.dart';
import 'booking_kit.dart';
import 'call_kit.dart';
import 'theme.dart';

/// [HF-CREATOR-SPACES-1] Shared pieces of the Women-only / LGBTQ+ channels: the green "Video KYC verified" pill, the channel tag,
/// the locked prompt and the gate that sits in front of Call / Book / Queue / Notify.

/// The green "Video KYC verified" pill. [compact] is a small round tick for list rows. The colour is [C.kycGreen]
/// (the owner asked for green on this one badge only).
class VideoKycPill extends StatelessWidget {
  const VideoKycPill({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return Semantics(
        label: 'Video KYC verified',
        child: Container(
          width: 20,
          height: 20,
          decoration: const BoxDecoration(color: C.kycGreen, shape: BoxShape.circle),
          child: const Icon(Icons.check_rounded, size: 15, color: C.kycGreenText),
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(color: C.kycGreen, borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.verified_rounded, size: 18, color: C.kycGreenText),
        const SizedBox(width: 6),
        Text('Video KYC verified', style: t(14, color: C.kycGreenText, w: FontWeight.w900)),
      ]),
    );
  }
}

/// "Women-only channel" / "LGBTQ+ channel" tag (rose and violet, not green).
class SpaceTag extends StatelessWidget {
  const SpaceTag({super.key, required this.lane, this.compact = false});

  final SpaceLane lane;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final women = lane == SpaceLane.women;
    final ink = women ? C.rani : C.lav;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 12, vertical: compact ? 2 : 6),
      decoration: BoxDecoration(color: women ? C.blush : C.lavtint, borderRadius: BorderRadius.circular(999), border: Border.all(color: ink, width: 1.5)),
      child: Text(compact ? lane.chipText : lane.tagText, style: t(14, color: ink, w: FontWeight.w900)),
    );
  }
}

/// The channel tag and the green pill together. Draws nothing when the host has neither. [surface] is for telemetry.
class SpaceBadges extends StatefulWidget {
  const SpaceBadges({super.key, required this.space, required this.videoKycVerified, required this.surface, this.compact = false, this.center = true});

  final String? space;
  final bool videoKycVerified;
  final String surface;
  final bool compact;
  final bool center;

  @override
  State<SpaceBadges> createState() => _SpaceBadgesState();
}

class _SpaceBadgesState extends State<SpaceBadges> {
  @override
  void initState() {
    super.initState();
    if (widget.videoKycVerified && !widget.compact) Telemetry.event('hf_video_kyc_badge_shown', {'surface': widget.surface});
  }

  @override
  Widget build(BuildContext context) {
    final lane = SpaceLane.parse(widget.space);
    if (lane == null && !widget.videoKycVerified) return const SizedBox.shrink();
    if (widget.compact) {
      return Padding(
        padding: const EdgeInsets.only(right: 6),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (widget.videoKycVerified) ...[const VideoKycPill(compact: true), const SizedBox(width: 4)],
          if (lane != null) SpaceTag(lane: lane, compact: true),
        ]),
      );
    }
    return Wrap(
      alignment: widget.center ? WrapAlignment.center : WrapAlignment.start,
      spacing: 8,
      runSpacing: 8,
      children: [
        if (lane != null) SpaceTag(lane: lane),
        if (widget.videoKycVerified) const VideoKycPill(),
      ],
    );
  }
}

/// Opens the native verification flow (`/verify/space`). True when the person finished and is verified for [lane].
Future<bool> openSpaceVerify(BuildContext context, SpaceLane lane, {bool creator = false}) async {
  final r = await context.push<bool>('/verify/space?lane=${lane.name}${creator ? '&creator=1' : ''}');
  return r == true;
}

/// The locked prompt: "Only verified women can call this channel" with "Verify to call". Returns true if the person verified.
/// [status] is what `GET /api/hf/lanes/me` said, when the caller already has it.
Future<bool> showSpaceLocked(BuildContext context, {required SpaceLane lane, SpaceStatus? status}) async {
  Telemetry.event('hf_space_gate_shown', {'lane': lane.name, 'missing': status?.missingFor(lane) ?? 'unknown'});
  final go = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: C.clear,
    builder: (sheet) => CallSheetFrame(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.paddingOf(sheet).bottom + 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Icon(Icons.lock_rounded, size: 40, color: C.maroon),
          const SizedBox(height: 10),
          Text(lane.lockedText, textAlign: TextAlign.center, style: t(22, color: C.maroon, w: FontWeight.w900, h: 1.2)),
          const SizedBox(height: 8),
          Text(
            (status?.selfie.pending ?? false)
                ? 'Your video is under review. Calling opens as soon as it is approved.'
                : 'It takes a few minutes: Aadhaar code and a short selfie video. Only you and our team see them.',
            textAlign: TextAlign.center,
            style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 14),
          if (!(status?.selfie.pending ?? false))
            BookBottomButton(label: 'VERIFY TO CALL', plum: true, icon: Icons.verified_user_rounded, padding: EdgeInsets.zero, onTap: () => Navigator.of(sheet).pop(true)),
          TextButton(
            onPressed: () => Navigator.of(sheet).pop(false),
            child: Text('Not now', style: t(16, color: C.maroon, w: FontWeight.w900)),
          ),
        ]),
      ),
    ),
  );
  if (go != true || !context.mounted) return false;
  return openSpaceVerify(context, lane);
}

/// A 403 `lane_required {lane}` from a call, booking or queue request: shows the locked prompt and returns true. False for any other error.
Future<bool> handleLaneRequired(BuildContext context, Object error) async {
  if (error is! ApiException || error.code != 'lane_required') return false;
  await showSpaceLocked(context, lane: SpaceLane.parse(error.extra['lane']) ?? SpaceLane.women);
  return true;
}

/// Runs [then] when the signed-in viewer may use the [lane] channel, else shows the locked prompt. A failed status read lets
/// [then] run (the server refuses with `lane_required` anyway, and [handleLaneRequired] shows the prompt).
Future<void> spaceGateThen(BuildContext context, SpaceLane lane, VoidCallback then) async {
  SpaceStatus st;
  try {
    st = await Services.instance.spacesRepo.laneStatus();
  } catch (_) {
    then();
    return;
  }
  if (st.grantedFor(lane)) {
    then();
    return;
  }
  if (!context.mounted) return;
  final ok = await showSpaceLocked(context, lane: lane, status: st);
  if (ok && context.mounted) then();
}

/// The sticky bottom bar of a locked space channel (profile): replaces Call / Book / Queue / Notify.
class SpaceLockedBar extends StatelessWidget {
  const SpaceLockedBar({super.key, required this.lane, required this.status, required this.onVerify});

  final SpaceLane lane;
  final SpaceStatus? status;
  final VoidCallback onVerify;

  @override
  Widget build(BuildContext context) {
    final pending = status?.selfie.pending ?? false;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        const Icon(Icons.lock_rounded, size: 22, color: C.maroon),
        const SizedBox(width: 10),
        Expanded(child: Text(pending ? 'Under review. Calling opens once your video is approved.' : lane.lockedText, style: t(16, color: C.maroon, w: FontWeight.w900, h: 1.25))),
      ]),
      if (!pending) ...[
        const SizedBox(height: 10),
        BookBottomButton(label: 'VERIFY TO CALL', plum: true, icon: Icons.verified_user_rounded, padding: EdgeInsets.zero, height: 52, onTap: onVerify),
      ],
    ]);
  }
}
