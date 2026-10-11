import 'package:flutter/material.dart';
import '../theme/hf_theme.dart';

/// What the ink circle of an [HfCluster] shows.
enum HfClusterKind {
  welcome,
  verify,
  women,
  lgbtq,
  host,
  call,
  success,
  profile,
  discover,
  wallet,
  selfie,
  voice,
  bank,
}

IconData _iconFor(HfClusterKind k) => switch (k) {
  HfClusterKind.welcome || HfClusterKind.call => Icons.call_rounded,
  HfClusterKind.verify => Icons.verified_user_rounded,
  HfClusterKind.women => Icons.people_alt_rounded,
  HfClusterKind.lgbtq => Icons.favorite_rounded,
  HfClusterKind.host || HfClusterKind.voice => Icons.mic_rounded,
  HfClusterKind.success => Icons.check_rounded,
  HfClusterKind.profile => Icons.person_rounded,
  HfClusterKind.discover => Icons.search_rounded,
  HfClusterKind.wallet => Icons.account_balance_wallet_rounded,
  HfClusterKind.selfie => Icons.photo_camera_rounded,
  HfClusterKind.bank => Icons.account_balance_rounded,
};

/// The mockup's pastel shape cluster (Welcome.dc.html): overlapping rounded shapes plus one ink circle
/// holding an icon. Painted with plain containers in a 342x250 reference space that is scaled uniformly
/// to fit the box and centred, so it is never stretched.
class HfCluster extends StatelessWidget {
  const HfCluster({
    super.key,
    required this.kind,
    this.height = 150,
    this.chipText,
  });
  final HfClusterKind kind;
  final double height;

  /// Optional small white chip (for example a masked number).
  final String? chipText;

  static const double _refW = 342;
  static const double _refH = 250;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    Color tint(HfTint t) {
      if (!dark) return t.bg(context);
      final light = switch (t) {
        HfTint.lavender => HfColors.lavender,
        HfTint.peach => HfColors.peach,
        HfTint.sky => HfColors.sky,
        HfTint.butter => HfColors.butter,
        HfTint.blush => HfColors.blush,
      };
      return light.withValues(alpha: 0.28);
    }

    final inkBg = dark ? HfColors.lavenderLight : HfColors.ink;
    final inkFg = dark ? HfColors.ink : HfColors.white;
    return ExcludeSemantics(
      child: RepaintBoundary(
        child: SizedBox(
          height: height,
          width: double.infinity,
          child: LayoutBuilder(
            builder: (context, c) {
              final w = c.maxWidth.isFinite ? c.maxWidth : _refW;
              final s = (w / _refW).clamp(0.0, height / _refH);
              Widget at(
                double l,
                double t,
                double size,
                double radius,
                Color color, [
                double deg = 0,
              ]) => Positioned(
                left: l,
                top: t,
                width: size,
                height: size,
                child: Transform.rotate(
                  angle: deg * 3.1415926535 / 180,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(radius),
                    ),
                  ),
                ),
              );
              final inkSize = (66 * s).clamp(38.0, 80.0);
              final icon = (inkSize * 0.45).clamp(18.0, 30.0);
              Widget cluster = SizedBox(
                width: _refW * s,
                height: _refH * s,
                child: ClipRect(
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Positioned(
                        left: 0,
                        top: 0,
                        width: _refW,
                        height: _refH,
                        child: Transform.scale(
                          scale: s,
                          alignment: Alignment.topLeft,
                          child: SizedBox(
                            width: _refW,
                            height: _refH,
                            child: Stack(
                              clipBehavior: Clip.none,
                              children: [
                                at(10, 70, 150, 48, tint(HfTint.lavender), -8),
                                at(126, 52, 120, 60, tint(HfTint.peach)),
                                at(212, 120, 110, 36, tint(HfTint.sky), 10),
                                at(94, 150, 76, 38, tint(HfTint.butter)),
                              ],
                            ),
                          ),
                        ),
                      ),
                      Positioned(
                        left: 52 * s,
                        top: 108 * s,
                        width: inkSize,
                        height: inkSize,
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: inkBg,
                            borderRadius: BorderRadius.circular(inkSize / 3),
                          ),
                          child: Icon(_iconFor(kind), size: icon, color: inkFg),
                        ),
                      ),
                      if (chipText != null)
                        Positioned(
                          left: 172 * s,
                          top: 92 * s,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: dark ? HfColors.darkCard : HfColors.white,
                              borderRadius: BorderRadius.circular(14),
                              boxShadow: const [
                                BoxShadow(
                                  color: Color(0x1A1D1A33),
                                  blurRadius: 20,
                                  offset: Offset(0, 8),
                                ),
                              ],
                            ),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 8,
                              ),
                              child: Text(
                                chipText!,
                                style: TextStyle(
                                  fontFamily: HfText.bodyFamily,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                  color: dark
                                      ? HfColors.darkText
                                      : HfColors.ink,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              );
              cluster = TweenAnimationBuilder<double>(
                tween: Tween(begin: 0, end: 1),
                duration: HfMotion.of(context, HfMotion.slow),
                curve: HfMotion.curve,
                builder: (_, v, child) => Opacity(
                  opacity: v,
                  child: Transform.scale(scale: 0.94 + 0.06 * v, child: child),
                ),
                child: cluster,
              );
              return Center(child: cluster);
            },
          ),
        ),
      ),
    );
  }
}
