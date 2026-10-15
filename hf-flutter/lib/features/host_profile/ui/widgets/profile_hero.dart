import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'net_image.dart';

/// Height of the photo (mockup 440). The body sheet overlaps its bottom 32 px.
const double kHeroHeight = 440;
const double kHeroOverlap = 32;

/// Full-bleed photo: the AI avatar first, then the gallery pictures, swipeable. The label bottom-left says
/// what the picture is (always visible, HF-AVA-1), dots bottom-right show the page. Fades in over 300 ms
/// (instant when the phone asks for no animations).
class ProfileHero extends ConsumerStatefulWidget {
  const ProfileHero({super.key, required this.profile});

  final HostProfile profile;

  @override
  ConsumerState<ProfileHero> createState() => _ProfileHeroState();
}

class _ProfileHeroState extends ConsumerState<ProfileHero> {
  final PageController _controller = PageController();
  int _page = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final image = ref.watch(hostImageBuilderProvider);
    final p = widget.profile;
    final avatar = p.avatarUrl;
    final hasAvatar = avatar != null && avatar.isNotEmpty;
    final avatarAlt = p.isAiAvatar
        ? HostProfileStrings.aiAvatarAlt
        : HostProfileStrings.profilePhoto;
    final pictures = <(String, String)>[
      if (hasAvatar)
        (avatar, '${p.displayName}, $avatarAlt'),
      for (var i = 0; i < p.gallery.length; i++)
        (
          p.gallery[i].url,
          'Picture ${i + 1}: ${p.gallery[i].caption ?? (p.gallery[i].isAi ? HostProfileStrings.aiGalleryImage : HostProfileStrings.galleryImage)}',
        ),
    ];
    final showingAvatar = hasAvatar && _page == 0;
    final galleryIndex = _page - (hasAvatar ? 1 : 0);
    final showingAiGallery = galleryIndex >= 0 &&
        galleryIndex < p.gallery.length &&
        p.gallery[galleryIndex].isAi;
    final label = pictures.isEmpty
        ? HostProfileStrings.noProfilePhoto
        : showingAvatar
        ? (p.isAiAvatar
              ? HostProfileStrings.aiAvatarChosen
              : HostProfileStrings.profilePhotoChosen)
        : showingAiGallery
        ? HostProfileStrings.aiGalleryImage
        : HostProfileStrings.galleryImage;
    final placeholder = Center(
      child: Container(
        width: 132,
        height: 132,
        decoration: BoxDecoration(
          color: HfColors.white.withValues(alpha: 0.55),
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.person_rounded,
          size: 72,
          color: HfColors.deepOrange,
        ),
      ),
    );
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: HfMotion.of(context, HfMotion.slow),
      curve: HfMotion.curve,
      builder: (context, v, child) => Opacity(opacity: v, child: child),
      // HF-MOTION-B: a warm banded sun sits behind the photo (seen while it loads, around a transparent
      // picture and when there is none); a soft orange glow warms the bottom of the photo.
      child: DecoratedBox(
        key: const ValueKey<String>('profile-hero-sun'),
        decoration: const BoxDecoration(color: HfColors.sunshine),
        child: Stack(
          fit: StackFit.expand,
          children: [
            const Positioned.fill(
              child: RepaintBoundary(
                child: CustomPaint(painter: ProfileSunBandsPainter()),
              ),
            ),
            if (pictures.isEmpty)
              placeholder
            else
              PageView.builder(
                controller: _controller,
                itemCount: pictures.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (context, i) => Semantics(
                  image: true,
                  label: pictures[i].$2,
                  excludeSemantics: true,
                  child: SizedBox.expand(
                    child: image(context, pictures[i].$1, fit: BoxFit.cover),
                  ),
                ),
              ),
            const Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              height: 150,
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Color(0x00F28C28), Color(0x4DF28C28)],
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              left: HfSpacing.page,
              right: HfSpacing.page,
              bottom: HfSpacing.section * 2 + 4 - kHeroOverlap,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: HfColors.white.withValues(alpha: 0.88),
                        borderRadius: BorderRadius.circular(
                          HfRadius.segmentItem,
                        ),
                      ),
                      child: Text(
                        label,
                        style: HfText.label.copyWith(color: HfColors.inkSoft),
                      ),
                    ),
                  ),
                  if (pictures.length > 1) ...[
                    const SizedBox(width: HfSpacing.lg),
                    ExcludeSemantics(
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (var i = 0; i < pictures.length; i++)
                              AnimatedContainer(
                                duration: HfMotion.of(context, HfMotion.fast),
                                curve: HfMotion.curve,
                                margin: EdgeInsets.only(
                                  left: i == 0 ? 0 : HfSpacing.xs,
                                ),
                                width: i == _page ? 22 : 6,
                                height: 6,
                                decoration: BoxDecoration(
                                  color: i == _page
                                      ? HfColors.white
                                      : HfColors.white.withValues(alpha: 0.6),
                                  borderRadius: BorderRadius.circular(3),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The warm banded sun behind the profile photo: a sunshine-to-orange sky with soft concentric bands that
/// radiate from a sun low in the middle. Static (no animation), so it is cheap and reduced-motion safe.
class ProfileSunBandsPainter extends CustomPainter {
  const ProfileSunBandsPainter();

  /// Bottom colour of the bands (the strip behind the sheet's rounded corners matches it).
  static const Color base = HfColors.primary;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [HfColors.butterLight, HfColors.sunshine, base],
          stops: [0, 0.45, 1],
        ).createShader(rect),
    );
    final sun = Offset(size.width / 2, size.height * 0.62);
    final step = size.shortestSide * 0.16;
    final band = Paint()..style = PaintingStyle.fill;
    // Outer bands first, each a little whiter towards the sun.
    for (var i = 6; i >= 1; i--) {
      band.color = HfColors.white.withValues(alpha: 0.05 + 0.025 * (6 - i));
      canvas.drawCircle(sun, step * i, band);
    }
    band.color = HfColors.white.withValues(alpha: 0.35);
    canvas.drawCircle(sun, step * 0.7, band);
  }

  @override
  bool shouldRepaint(ProfileSunBandsPainter oldDelegate) => false;
}

/// A 48 px white circle over the photo (back, save, share).
class HeroCircleButton extends StatelessWidget {
  const HeroCircleButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.color = HfColors.ink,
    this.toggled,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Color color;

  /// Non-null for a toggle button (save): announced as on / off.
  final bool? toggled;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      toggled: toggled,
      label: label,
      excludeSemantics: true,
      child: Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: Material(
          color: HfColors.white.withValues(alpha: 0.9),
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(
              width: HfSpacing.tap,
              height: HfSpacing.tap,
              child: Icon(icon, size: 20, color: color),
            ),
          ),
        ),
      ),
    );
  }
}
