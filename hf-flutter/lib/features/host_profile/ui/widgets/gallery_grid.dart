import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'net_image.dart';
import 'profile_common.dart';

/// The profile gallery: a two-column grid, the first picture spanning both columns (200 tall), then 150 px
/// tiles. With more than two pictures the second slot is a lavender "+N more" tile. Any tile opens the lightbox.
/// AI-generated pictures are labelled individually; uploaded photos are never mislabelled.
class GalleryGrid extends ConsumerWidget {
  const GalleryGrid({super.key, required this.items});

  final List<GalleryImage> items;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (items.isEmpty) return const SizedBox.shrink();
    final image = ref.watch(hostImageBuilderProvider);
    final hasAi = items.any((item) => item.isAi);
    void open(int index) => showGalleryLightbox(
      context,
      items: items,
      initial: index,
      image: image,
    );

    Widget picture(int i, double height) {
      final item = items[i];
      final provenance = item.isAi
          ? HostProfileStrings.aiGalleryImage
          : HostProfileStrings.galleryImage;
      return Semantics(
        button: true,
        label:
            '${HostProfileStrings.openPicture(i + 1)}: ${item.caption ?? provenance}',
        excludeSemantics: true,
        child: GestureDetector(
          key: ValueKey('gallery-tile-$i'),
          behavior: HitTestBehavior.opaque,
          onTap: () => open(i),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(HfRadius.tile),
            child: SizedBox(
              height: height,
              width: double.infinity,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ColoredBox(color: HfTint.peach.bg(context)),
                  image(context, item.url, fit: BoxFit.cover),
                  Positioned(
                    left: 8,
                    bottom: 8,
                    child: AiLabel(text: provenance),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    final more = items.length - 2;
    final Widget? second = items.length >= 2
        ? (items.length > 2
              ? Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: picture(1, 150)),
                    const SizedBox(width: HfSpacing.sm),
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: HostProfileStrings.seeAllPictures(items.length),
                        excludeSemantics: true,
                        child: Material(
                          color: HfTint.lavender.bg(context),
                          borderRadius: BorderRadius.circular(HfRadius.tile),
                          child: InkWell(
                            key: const ValueKey('gallery-more'),
                            borderRadius: BorderRadius.circular(HfRadius.tile),
                            onTap: () => open(2),
                            child: SizedBox(
                              height: 150,
                              child: Center(
                                child: Padding(
                                  padding: const EdgeInsets.all(HfSpacing.sm),
                                  child: Text(
                                    HostProfileStrings.morePictures(more),
                                    textAlign: TextAlign.center,
                                    style: HfText.section.copyWith(
                                      fontSize: 22,
                                      color: HfTint.lavender.valueInk(context),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                )
              : Row(
                  children: [
                    Expanded(child: picture(1, 150)),
                    const SizedBox(width: HfSpacing.sm),
                    const Expanded(child: SizedBox()),
                  ],
                ))
        : null;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: kProfileSidePad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: HfSpacing.sm,
            runSpacing: HfSpacing.sm,
            children: [
              const SectionTitle(HostProfileStrings.gallery),
              if (hasAi) Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  color: HfBrightness.isDark(context)
                      ? HfColors.darkTile
                      : HfColors.surfaceSoft,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  HostProfileStrings.aiImagesMarked,
                  style: HfText.badge.copyWith(color: profileSoftInk(context)),
                ),
              ),
            ],
          ),
          const SizedBox(height: HfSpacing.lg),
          picture(0, 200),
          if (second != null) ...[const SizedBox(height: HfSpacing.sm), second],
        ],
      ),
    );
  }
}

/// Full-screen swipeable viewer for the gallery pictures.
Future<void> showGalleryLightbox(
  BuildContext context, {
  required List<GalleryImage> items,
  required int initial,
  required HostImageBuilder image,
}) {
  return showDialog<void>(
    context: context,
    barrierColor: HfColors.ink,
    builder: (_) => _Lightbox(items: items, initial: initial, image: image),
  );
}

class _Lightbox extends StatefulWidget {
  const _Lightbox({
    required this.items,
    required this.initial,
    required this.image,
  });

  final List<GalleryImage> items;
  final int initial;
  final HostImageBuilder image;

  @override
  State<_Lightbox> createState() => _LightboxState();
}

class _LightboxState extends State<_Lightbox> {
  late final PageController _controller = PageController(
    initialPage: widget.initial,
  );
  late int _page = widget.initial;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.items;
    final caption = items[_page].caption;
    return Dialog.fullscreen(
      key: const ValueKey('gallery-lightbox'),
      backgroundColor: HfColors.ink,
      child: SafeArea(
        child: Stack(
          children: [
            PageView.builder(
              controller: _controller,
              itemCount: items.length,
              onPageChanged: (i) => setState(() => _page = i),
              itemBuilder: (context, i) => Semantics(
                image: true,
                label:
                    'Picture ${i + 1} of ${items.length}: ${items[i].caption ?? (items[i].isAi ? HostProfileStrings.aiGalleryImage : HostProfileStrings.galleryImage)}',
                excludeSemantics: true,
                child: InteractiveViewer(
                  child: Center(
                    child: widget.image(
                      context,
                      items[i].url,
                      fit: BoxFit.contain,
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              top: HfSpacing.sm,
              left: HfSpacing.sm,
              child: HeroCloseButton(onTap: () => Navigator.of(context).pop()),
            ),
            Positioned(
              left: HfSpacing.page,
              right: HfSpacing.page,
              bottom: HfSpacing.page,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (caption != null)
                    Text(
                      caption,
                      textAlign: TextAlign.center,
                      style: HfText.body.copyWith(color: HfColors.white),
                    ),
                  const SizedBox(height: HfSpacing.sm),
                  Wrap(
                    spacing: HfSpacing.md,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    alignment: WrapAlignment.center,
                    children: [
                      Text(
                        '${_page + 1} / ${items.length}',
                        style: HfText.badge.copyWith(color: HfColors.white),
                      ),
                      AiLabel(
                        text: items[_page].isAi
                            ? HostProfileStrings.aiGalleryImage
                            : HostProfileStrings.galleryImage,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Close button of the lightbox.
class HeroCloseButton extends StatelessWidget {
  const HeroCloseButton({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Close',
      excludeSemantics: true,
      child: Material(
        color: HfColors.white.withValues(alpha: 0.9),
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: const SizedBox(
            width: HfSpacing.tap,
            height: HfSpacing.tap,
            child: Icon(Icons.close_rounded, size: 20, color: HfColors.ink),
          ),
        ),
      ),
    );
  }
}
