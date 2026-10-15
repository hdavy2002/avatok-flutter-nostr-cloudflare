import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';

abstract final class KycVisualAsset {
  static const phoneLavender = 'assets/images/kyc/phone-lavender.webp';
  static const phoneMan = 'assets/images/kyc/phone-man.webp';
  static const phonePink = 'assets/images/kyc/phone-pink.webp';
  static const verifiedCouple = 'assets/images/kyc/verified-couple.webp';
  static const selfiePermission = 'assets/images/kyc/selfie-permission.webp';
  static const selfieRecord = 'assets/images/kyc/selfie-record.webp';
  static const selfieReview = 'assets/images/kyc/selfie-review.webp';
  static const selfieRejected = 'assets/images/kyc/selfie-rejected.webp';
  static const reviewTeam = 'assets/images/kyc/review-team.webp';
  static const lgbtqCouple = 'assets/images/kyc/lgbtq-couple.webp';
  static const laneIneligible = 'assets/images/kyc/lane-ineligible.webp';
}

/// Photo panel used by the approved 425 x 916 KYC storyboards. At wider
/// widths it stays centered and grows only a little, so faces are not stretched.
class KycPhoto extends StatelessWidget {
  const KycPhoto({
    super.key,
    required this.asset,
    this.height = 190,
    this.alignment = Alignment.center,
    this.overlay,
  });

  final String asset;
  final double height;
  final Alignment alignment;
  final Widget? overlay;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: LayoutBuilder(
      builder: (context, constraints) {
        final panelHeight = constraints.maxWidth <= 425
            ? height
            : (height + 28).clamp(height, 260).toDouble();
        return ClipRRect(
          borderRadius: BorderRadius.circular(HfRadius.card),
          child: SizedBox(
            width: double.infinity,
            height: panelHeight,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Image.asset(asset, fit: BoxFit.cover, alignment: alignment),
                if (overlay != null) overlay!,
              ],
            ),
          ),
        );
      },
    ),
  );
}

class KycCheckRow extends StatelessWidget {
  const KycCheckRow(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Row(
      children: [
        const Icon(Icons.check_circle_rounded, color: Color(0xff1db76a), size: 27),
        const SizedBox(width: 12),
        Expanded(child: Text(text, style: HfText.of(context, HfText.bodyStrong))),
      ],
    ),
  );
}

class KycShieldBadge extends StatelessWidget {
  const KycShieldBadge({super.key});

  @override
  Widget build(BuildContext context) => Positioned(
    right: 14,
    top: 14,
    child: Container(
      width: 62,
      height: 62,
      decoration: BoxDecoration(
        color: const Color(0xff1db76a),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.white, width: 4),
        boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 12, offset: Offset(0, 4))],
      ),
      child: const Icon(Icons.check_rounded, color: Colors.white, size: 38),
    ),
  );
}

/// The three identity steps (Aadhaar, video, review) joined by a line that draws itself as each step is done
/// (HF-MOTION-D). Every flag comes from the server's answer: [approved] is only true once the review team has
/// approved the video, so the last segment never fills early. Reduced motion: drawn at once.
class KycStepLine extends StatelessWidget {
  const KycStepLine({
    super.key,
    required this.aadhaarDone,
    required this.videoSent,
    required this.approved,
  });

  final bool aadhaarDone;
  final bool videoSent;
  final bool approved;

  static const List<String> labels = <String>['Aadhaar', 'Video', 'Approved'];

  @override
  Widget build(BuildContext context) {
    final done = <bool>[aadhaarDone, aadhaarDone && videoSent, approved];
    final d = HfMotion.of(context, const Duration(milliseconds: 700));
    final track = HfBrightness.isDark(context) ? HfColors.darkLine : HfColors.line;
    Widget segment(bool filled) => Expanded(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: SizedBox(
          height: 4,
          child: Stack(
            children: [
              Positioned.fill(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: track,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              TweenAnimationBuilder<double>(
                tween: Tween<double>(end: filled ? 1 : 0),
                duration: d,
                curve: Curves.easeInOutCubic,
                builder: (context, v, _) => FractionallySizedBox(
                  widthFactor: v,
                  heightFactor: 1,
                  child: const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: HfGradients.sunDeep,
                      borderRadius: BorderRadius.all(Radius.circular(2)),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    Widget node(int i) {
      final on = done[i];
      return Semantics(
        label: '${labels[i]}, ${on ? 'done' : 'not done yet'}',
        excludeSemantics: true,
        child: AnimatedContainer(
          key: ValueKey<String>('kyc-node-$i-${on ? 'done' : 'todo'}'),
          duration: d,
          curve: Curves.easeOutBack,
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: on ? HfGradients.sun : null,
            color: on ? null : track,
          ),
          child: on
              ? const Icon(Icons.check_rounded, size: 18, color: HfColors.onPrimary)
              : null,
        ),
      );
    }

    // With large text the labels are left to screen readers (each node says its name and state), so the row
    // never overflows on a 320 px phone.
    final showLabels = MediaQuery.textScalerOf(context).scale(14) <= 20;
    final labelStyle = HfText.of(context, HfText.note);
    return Padding(
      key: const ValueKey<String>('kyc-step-line'),
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              node(0),
              segment(done[1]),
              node(1),
              segment(done[2]),
              node(2),
            ],
          ),
          if (showLabels) ...[
            const SizedBox(height: 4),
            ExcludeSemantics(
              child: Row(
                children: [
                  Expanded(child: Text(labels[0], style: labelStyle)),
                  Expanded(
                    child: Text(labels[1], style: labelStyle, textAlign: TextAlign.center),
                  ),
                  Expanded(
                    child: Text(labels[2], style: labelStyle, textAlign: TextAlign.end),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// "Your video is with our team": a calm breathing sun and the three-dot loader. It says nothing about the
/// outcome; it only shows that the check is in progress (HF-MOTION-D).
class KycReviewWait extends StatelessWidget {
  const KycReviewWait({super.key});

  @override
  Widget build(BuildContext context) => Padding(
    key: const ValueKey<String>('kyc-review-wait'),
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(
      children: [
        Breathing(
          period: const Duration(milliseconds: 3200),
          maxScale: 1.06,
          child: Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: HfGradients.sun,
              boxShadow: [
                BoxShadow(
                  color: HfColors.sunshine.withValues(alpha: 0.5),
                  blurRadius: 24,
                  spreadRadius: 4,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
        const HfLoader(semanticLabel: 'Review in progress'),
      ],
    ),
  );
}

/// The approved badge (shown only when the server says the video is approved): it pops in with a bounce and a
/// sparkle burst. Use it inside the photo's Stack, like [KycShieldBadge].
class KycApprovedBadge extends StatelessWidget {
  const KycApprovedBadge({super.key});

  @override
  Widget build(BuildContext context) => Positioned(
    right: 14,
    top: 14,
    child: SizedBox(
      width: 62,
      height: 62,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          PopIn(
            key: const ValueKey<String>('kyc-approved-badge'),
            delay: const Duration(milliseconds: 200),
            duration: const Duration(milliseconds: 650),
            beginScale: 0.2,
            curve: Curves.elasticOut,
            child: Container(
              width: 62,
              height: 62,
              decoration: BoxDecoration(
                color: const Color(0xff1db76a),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Colors.white, width: 4),
                boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 12, offset: Offset(0, 4))],
              ),
              child: const Icon(Icons.check_rounded, color: Colors.white, size: 38),
            ),
          ),
          if (!hfReduceMotion(context))
            const Positioned(
              left: -49,
              top: -49,
              child: IgnorePointer(
                child: HfLottie(HfLottieAssets.sparkleBurst, width: 160, height: 160),
              ),
            ),
        ],
      ),
    ),
  );
}
