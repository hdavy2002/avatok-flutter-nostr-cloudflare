import 'dart:ui' show ImageFilter;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../features/demo/demo_data.dart'; // [HF-DEMO] remove with lib/features/demo
import '../../features/demo/demo_widgets.dart'; // [HF-DEMO] remove with lib/features/demo
import '../theme/hf_theme.dart';
import 'hf_status_pill.dart';

/// The big host photo of the Discover card and the profile hero (mockup `Main`).
///
/// A [height] px tall photo (default 380) with radius 28: pastel placeholder while loading and a soft tile with a
/// person icon on error. Over it: the [status] pill (top-left, 12 px), the [aiLabel] chip under it (leave null to
/// hide), a 48 px heart button (top-right, 10 px; Semantics "Save", toggled by [saved]) and, if [child] is given,
/// a frosted panel inset 10 px at the bottom (`ClipRRect(24) > BackdropFilter(blur 10) > white 90%`) that holds it.
/// Wrap the card in your own tap handler to open the profile. [tint] picks the placeholder colour.
class HfPhotoCard extends StatelessWidget {
  const HfPhotoCard({
    super.key,
    required this.imageUrl,
    this.height = 380,
    this.status,
    this.aiLabel = 'AI avatar',
    this.saved = false,
    this.onSave,
    this.child,
    this.tint = HfTint.lavender,
    this.animatePill = true,
  });

  final String? imageUrl;
  final double height;
  final HfPresence? status;
  final String? aiLabel;
  final bool saved;
  final VoidCallback? onSave;

  /// Content of the frosted bottom panel (name, rating, tagline, voice bar).
  final Widget? child;
  final HfTint tint;

  /// Pass false in widget tests that use `pumpAndSettle` (the online dot pulses).
  final bool animatePill;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final url = imageUrl;
    final placeholderColor = tint.bg(context);
    Widget tile(IconData icon) => Container(
      color: placeholderColor,
      alignment: Alignment.center,
      child: Icon(
        icon,
        size: 56,
        color: tint.ink(context).withValues(alpha: 0.5),
      ),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(HfRadius.cardInner),
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (url == null || url.isEmpty)
              tile(Icons.person_rounded)
            else if (demoAssetPath(url) !=
                null) // [HF-DEMO] remove with lib/features/demo
              DemoAssetImage(url)
            else
              CachedNetworkImage(
                imageUrl: url,
                fit: BoxFit.cover,
                fadeInDuration: HfMotion.of(context, HfMotion.base),
                placeholder: (_, __) => Container(color: placeholderColor),
                errorWidget: (_, __, ___) => tile(Icons.person_rounded),
              ),
            if (status != null)
              Positioned(
                top: 12,
                left: 12,
                child: HfStatusPill(status: status!, animate: animatePill),
              ),
            if (aiLabel != null)
              Positioned(
                top: 60,
                left: 12,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 5,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xD9FFFFFF),
                    borderRadius: BorderRadius.circular(HfRadius.segmentItem),
                  ),
                  child: Text(
                    aiLabel!,
                    style: HfText.label.copyWith(color: HfColors.inkSoft),
                  ),
                ),
              ),
            Positioned(
              top: 10,
              right: 10,
              child: Semantics(
                button: true,
                toggled: saved,
                label: 'Save',
                excludeSemantics: true,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: onSave,
                  child: Container(
                    width: 48,
                    height: 48,
                    decoration: const BoxDecoration(
                      color: Color(0xE6FFFFFF),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      saved
                          ? Icons.favorite_rounded
                          : Icons.favorite_border_rounded,
                      size: 22,
                      color: HfColors.rose,
                    ),
                  ),
                ),
              ),
            ),
            if (child != null)
              Positioned(
                left: 10,
                right: 10,
                bottom: 10,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(24),
                  child: BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                    child: Container(
                      padding: const EdgeInsets.all(HfSpacing.xl),
                      color: dark
                          ? const Color(0xDB14121F)
                          : const Color(0xE6FFFFFF),
                      child: child,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
