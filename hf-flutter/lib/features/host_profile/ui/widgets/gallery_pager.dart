import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/strings.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'net_image.dart';

/// Swipeable gallery. The section says "AI images" and every picture carries its own "AI image" label
/// (HF-AVA-1): the photos are made by AI from the avatar the host chose.
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Semantics(header: true, child: const Text(HostProfileStrings.gallery, style: HfText.title)),
            const SizedBox(width: 12),
            const Flexible(child: AiLabel(text: Strings.aiImagesLabel)),
          ],
        ),
        const SizedBox(height: HfSpacing.gap),
        SizedBox(
          height: 260,
          child: PageView.builder(
            controller: _controller,
            itemCount: items.length,
            onPageChanged: (i) => setState(() => _page = i),
            itemBuilder: (context, i) {
              final item = items[i];
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: Semantics(
                  image: true,
                  label: 'Picture ${i + 1} of ${items.length}: ${item.caption ?? HostProfileStrings.galleryImage}',
                  excludeSemantics: true,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(HfRadius.card),
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        image(context, item.url, fit: BoxFit.cover),
                        const Positioned(
                          left: 10,
                          bottom: 10,
                          child: AiLabel(text: HostProfileStrings.galleryImage),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 10),
        if (items[_page].caption != null) Text(items[_page].caption!, style: HfText.note),
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
