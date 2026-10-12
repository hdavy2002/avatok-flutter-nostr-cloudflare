import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';

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
