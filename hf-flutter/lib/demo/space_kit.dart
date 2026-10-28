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

/// [HF-CREATOR-BADGES-1] Shared wording.
const String kKycOnlyText = 'This creator only takes calls from video-KYC verified customers';
const String kNeverShareText = 'We never share any customer\'s details with anyone.';

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

/// [HF-CREATOR-BADGES-1] "Channel verified": an approved YouTube / Instagram channel (maroon, not green).
class ChannelVerifiedPill extends StatelessWidget {
  const ChannelVerifiedPill({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return Semantics(
        label: 'Channel verified',
        child: Container(
          width: 20,
          height: 20,
          decoration: const BoxDecoration(color: C.maroon, shape: BoxShape.circle),
          child: const Icon(Icons.smart_display_rounded, size: 13, color: C.white),
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.maroon, width: 1.5)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.smart_display_rounded, size: 18, color: C.maroon),
        const SizedBox(width: 6),
        Text('Channel verified', style: t(14, color: C.maroon, w: FontWeight.w900)),
      ]),
    );
  }
}

/// [HF-VERIFIED-BLIP-1] "WhatsApp number verified": checked by a one-time code (plain sand pill, not green).
class PhoneVerifiedPill extends StatelessWidget {
  const PhoneVerifiedPill({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(color: C.sand, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.brass, width: 1.5)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.check_circle_rounded, size: 18, color: C.deep),
        const SizedBox(width: 6),
        Text('WhatsApp number verified', style: t(14, color: C.deep, w: FontWeight.w900)),
      ]),
    );
  }
}

/// [HF-CREATOR-BADGES-1] "Only video-KYC callers": the creator only takes calls from customers with full video KYC.
class KycOnlyNote extends StatelessWidget {
  const KycOnlyNote({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return Semantics(label: 'Only video-KYC callers', child: const Icon(Icons.lock_rounded, size: 18, color: C.maroon));
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.line, width: 1.5)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.lock_rounded, size: 16, color: C.maroon),
        const SizedBox(width: 6),
        Text('Only video-KYC callers', style: t(14, color: C.maroon, w: FontWeight.w900)),
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
  const SpaceBadges({
    super.key,
    required this.space,
    required this.videoKycVerified,
    required this.surface,
    this.compact = false,
    this.center = true,
    this.channelVerified = false,
    this.kycCallersOnly = false,
    this.phoneVerified = false,
  });

  final String? space;

  /// [HF-VERIFIED-BLIP-1] WhatsApp number checked by a one-time code: a plain pill on the profile (never on compact rows).
  final bool phoneVerified;
  final bool videoKycVerified;

  /// [HF-CREATOR-BADGES-1] An approved channel is connected; and only video-KYC customers may call.
  final bool channelVerified;
  final bool kycCallersOnly;
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
    // a space is always video-KYC callers only, so the extra note is for the other creators
    final kycNote = widget.kycCallersOnly && lane == null;
    if (lane == null && !widget.videoKycVerified && !widget.channelVerified && !kycNote && !(widget.phoneVerified && !widget.compact)) return const SizedBox.shrink();
    if (widget.compact) {
      return Padding(
        padding: const EdgeInsets.only(right: 6),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (widget.channelVerified) ...[const ChannelVerifiedPill(compact: true), const SizedBox(width: 4)],
          if (widget.videoKycVerified) ...[const VideoKycPill(compact: true), const SizedBox(width: 4)],
          if (kycNote) ...[const KycOnlyNote(compact: true), const SizedBox(width: 4)],
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
        if (widget.channelVerified) const ChannelVerifiedPill(),
        if (widget.videoKycVerified) const VideoKycPill(),
        if (widget.phoneVerified) const PhoneVerifiedPill(),
        if (kycNote) const KycOnlyNote(),
      ],
    );
  }
}

/// Opens the native verification flow (`/verify/space`). True when the person finished and is verified for [lane].
/// [lane] null = plain video KYC (no gender rule, declaration or join): `lane=kyc`.
Future<bool> openSpaceVerify(BuildContext context, SpaceLane? lane, {bool creator = false}) async {
  final r = await context.push<bool>('/verify/space?lane=${lane?.name ?? 'kyc'}${creator ? '&creator=1' : ''}');
  return r == true;
}

/// The locked prompt: "Only verified women can call this channel" with "Verify to call". Returns true if the person verified.
/// [status] is what `GET /api/hf/lanes/me` said, when the caller already has it.
Future<bool> showSpaceLocked(BuildContext context, {required SpaceLane lane, SpaceStatus? status}) async {
  Telemetry.event('hf_space_gate_shown', {'lane': lane.name, 'missing': status?.missingFor(lane) ?? 'unknown'});
  Telemetry.event('hf_caller_gate_shown', {'reason': lane.name}); // [HF-CREATOR-BADGES-1]
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
  if (error is! ApiException) return false;
  // [HF-CREATOR-BADGES-1] the creator only takes customers with full video KYC
  if (error.code == 'video_kyc_required_caller') {
    await showKycLocked(context);
    return true;
  }
  if (error.code != 'lane_required') return false;
  final lane = SpaceLane.parse(error.extra['lane']) ?? SpaceLane.women;
  // [HF-INTRO-A2] With the Aadhaar-only rule on, the server says what is missing (`need`): the plain women-only pop-up.
  final need = error.extra['need']?.toString() ?? '';
  if (lane == SpaceLane.women && (need == 'aadhaar' || need == 'female_only')) {
    await showWomenOnlyGate(context, need: need);
    return true;
  }
  await showSpaceLocked(context, lane: lane);
  return true;
}

/// [HF-INTRO-A2] (D17) The pop-up for a Women-to-Women channel. [need] `aadhaar`: "Only Aadhaar-verified women can talk to
/// her." with [Verify now] (the existing verification flow for the women lane) and [Not now]; `female_only`: a verified
/// person who is not a woman, "Sorry, this channel is for women only." Returns true when the person verified here.
/// Telemetry `hf_women_gate {result}`.
Future<bool> showWomenOnlyGate(BuildContext context, {required String need}) async {
  final aadhaar = need != 'female_only';
  Telemetry.event('hf_women_gate', {'result': aadhaar ? 'blocked_aadhaar' : 'blocked_female_only'});
  // Owner design Reel4Gate: white card, ink border, rose offset shadow, round rose symbol, title, body, Verify now / Not now.
  final go = await showDialog<bool>(
    context: context,
    builder: (dialog) => Dialog(
      key: const ValueKey('women-gate-dialog'),
      backgroundColor: C.clear,
      elevation: 0,
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      child: Container(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 16),
        decoration: BoxDecoration(
          color: C.white,
          border: Border.all(color: C.deep, width: 3),
          borderRadius: BorderRadius.circular(28),
          boxShadow: const [BoxShadow(color: C.rani, offset: Offset(8, 8))],
        ),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(
            child: Container(
              width: 72,
              height: 72,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, color: C.blush, border: Border.all(color: C.rani, width: 3)),
              child: Text('♀', style: t(34, color: C.tan, w: FontWeight.w900)),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            aadhaar ? 'This is a women-only channel' : 'Sorry, this channel is for women only.',
            key: const ValueKey('women-gate-title'),
            textAlign: TextAlign.center,
            style: t(aadhaar ? 24 : 20, color: C.deep, w: FontWeight.w900, h: 1.15),
          ),
          if (aadhaar) ...[
            const SizedBox(height: 14),
            Text(
              'Only Aadhaar-verified women can talk to her. It takes about a minute. Your Aadhaar number is never shown to anyone.',
              textAlign: TextAlign.center,
              style: t(15, color: C.deep, w: FontWeight.w600, h: 1.55),
            ),
            const SizedBox(height: 14),
            FilledButton(
              key: const ValueKey('women-gate-verify'),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(56),
                backgroundColor: C.marigold,
                foregroundColor: C.deep,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: C.deep, width: 3)),
              ),
              onPressed: () => Navigator.of(dialog).pop(true),
              child: Text('Verify now', style: t(18, color: C.deep, w: FontWeight.w900)),
            ),
          ],
          const SizedBox(height: 10),
          TextButton(
            key: const ValueKey('women-gate-close'),
            style: TextButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            onPressed: () => Navigator.of(dialog).pop(false),
            child: Text(aadhaar ? 'Not now' : 'OK', style: t(16, color: C.deep, w: FontWeight.w900)),
          ),
        ]),
      ),
    ),
  );
  if (!aadhaar) return false;
  if (go != true || !context.mounted) {
    Telemetry.event('hf_women_gate', {'result': 'not_now'});
    return false;
  }
  Telemetry.event('hf_women_gate', {'result': 'verify_now'});
  final ok = await openSpaceVerify(context, SpaceLane.women);
  Telemetry.event('hf_women_gate', {'result': ok ? 'verified' : 'verify_incomplete'});
  return ok;
}

/// [HF-INTRO-A2] The gate in front of Call / Join queue / Book on a Women-to-Women intro reel: runs [then] when the signed-in
/// viewer is allowed in, else shows the pop-up that fits what is missing. A failed status read lets [then] run (the server
/// answers 403 `lane_required` anyway and [handleLaneRequired] shows the same pop-up).
Future<void> womenGateThen(BuildContext context, VoidCallback then) async {
  SpaceStatus st;
  try {
    st = await Services.instance.spacesRepo.laneStatus();
  } catch (_) {
    then();
    return;
  }
  if (st.womenGranted) {
    Telemetry.event('hf_women_gate', {'result': 'allowed'});
    then();
    return;
  }
  if (!context.mounted) return;
  if (!st.aadhaarVerified) {
    if (await showWomenOnlyGate(context, need: 'aadhaar') && context.mounted) then();
    return;
  }
  if (st.gender != null && st.gender != 'F') {
    await showWomenOnlyGate(context, need: 'female_only');
    return;
  }
  // Aadhaar done and Female, but the server still wants more (an older server asks for the selfie): the earlier prompt
  final ok = await showSpaceLocked(context, lane: SpaceLane.women, status: st);
  if (ok && context.mounted) then();
}

/// [HF-CREATOR-BADGES-1] The locked prompt for a creator who only takes video-KYC callers. Returns true if the person verified.
Future<bool> showKycLocked(BuildContext context, {SpaceStatus? status}) async {
  Telemetry.event('hf_caller_gate_shown', {'reason': 'video_kyc'});
  final pending = status?.selfie.pending ?? false;
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
          Text(kKycOnlyText, textAlign: TextAlign.center, style: t(22, color: C.maroon, w: FontWeight.w900, h: 1.2)),
          const SizedBox(height: 8),
          Text(
            pending
                ? 'Your video is under review. Calling opens as soon as it is approved.'
                : 'It takes a few minutes: Aadhaar code and a short selfie video. Only you and our team see them.',
            textAlign: TextAlign.center,
            style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 6),
          Text(kNeverShareText, textAlign: TextAlign.center, style: t(15, color: C.muted, w: FontWeight.w800, h: 1.35)),
          const SizedBox(height: 14),
          if (!pending)
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
  return openSpaceVerify(context, null);
}

/// [HF-CREATOR-BADGES-1] Runs [then] when the viewer has full video KYC, else shows [showKycLocked]. A failed status read lets
/// [then] run (the server refuses with `video_kyc_required_caller` anyway and [handleLaneRequired] shows the prompt).
Future<void> kycGateThen(BuildContext context, VoidCallback then) async {
  SpaceStatus st;
  try {
    st = await Services.instance.spacesRepo.laneStatus();
  } catch (_) {
    then();
    return;
  }
  if (st.kycGranted) {
    then();
    return;
  }
  if (!context.mounted) return;
  final ok = await showKycLocked(context, status: st);
  if (ok && context.mounted) then();
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

  /// Null = a creator who only takes plain video-KYC callers ([HF-CREATOR-BADGES-1]).
  final SpaceLane? lane;
  final SpaceStatus? status;
  final VoidCallback onVerify;

  @override
  Widget build(BuildContext context) {
    final pending = status?.selfie.pending ?? false;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        const Icon(Icons.lock_rounded, size: 22, color: C.maroon),
        const SizedBox(width: 10),
        Expanded(child: Text(pending ? 'Under review. Calling opens once your video is approved.' : (lane?.lockedText ?? kKycOnlyText), style: t(16, color: C.maroon, w: FontWeight.w900, h: 1.25))),
      ]),
      if (!pending) ...[
        const SizedBox(height: 10),
        BookBottomButton(label: 'VERIFY TO CALL', plum: true, icon: Icons.verified_user_rounded, padding: EdgeInsets.zero, height: 52, onTap: onVerify),
        const SizedBox(height: 6),
        Text(kNeverShareText, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3)),
      ],
    ]);
  }
}
