import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'net_image.dart';

/// Swipeable gallery with per-image provenance labels.
class GalleryPager extends ConsumerStatefulWidget {
  const GalleryPager({super.key, required this.items});

  final List<GalleryImage> items;

  @override
  ConsumerState<GalleryPager> createState() => _GalleryPagerState();
}

class _GalleryPagerState extends ConsumerState<GalleryPager> {
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
    final items = widget.items;
    final hasAi = items.any((item) => item.isAi);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Semantics(
              header: true,
              child: Text(
                HostProfileStrings.gallery,
                style: HfText.of(context, HfText.title),
              ),
            ),
            if (hasAi) ...[
              const SizedBox(width: 12),
              const AiLabel(text: HostProfileStrings.aiImagesMarked),
            ],
          ],
        ),
        const SizedBox(height: HfSpacing.gap),
        // Paint the shadow outside the pager's clip while each photo keeps its
        // foreground frame. Neither decoration changes the gallery's layout.
        DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(HfRadius.card),
            boxShadow: HfShadows.cardFor(context),
          ),
          child: SizedBox(
            height: 260,
            child: PageView.builder(
              controller: _controller,
              itemCount: items.length,
              onPageChanged: (i) => setState(() => _page = i),
              itemBuilder: (context, i) {
                final item = items[i];
                final provenance = item.isAi
                    ? HostProfileStrings.aiGalleryImage
                    : HostProfileStrings.galleryImage;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2),
                  child: Semantics(
                    image: true,
                    label:
                        'Picture ${i + 1} of ${items.length}: ${item.caption ?? provenance}',
                    excludeSemantics: true,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(HfRadius.card),
                      child: DecoratedBox(
                        position: DecorationPosition.foreground,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(HfRadius.card),
                          border: Border.all(color: HfColors.white, width: 2),
                        ),
                        child: Stack(
                          fit: StackFit.expand,
                          children: [
                            image(context, item.url, fit: BoxFit.cover),
                            Positioned(
                              left: 10,
                              bottom: 10,
                              child: AiLabel(text: provenance),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
        const SizedBox(height: 10),
        if (items[_page].caption != null)
          Text(items[_page].caption!, style: HfText.of(context, HfText.note)),
        if (items.length > 1) ...[
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var i = 0; i < items.length; i++)
                Container(
                  width: i == _page ? 22 : 10,
                  height: 10,
                  margin: const EdgeInsets.symmetric(horizontal: 3),
                  decoration: BoxDecoration(
                    color: i == _page ? HfColors.orchid : HfColors.line,
                    borderRadius: BorderRadius.circular(5),
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }
}
