import 'package:flutter/material.dart';

import '../brand.dart';
import '../theme/hf_theme.dart';

/// The brand logo in use: the owner's badge logo (turbaned uncle,
/// name on the ribbon) from design/hf logo/ — [HF-LOGO-1 2026-10-15].
/// The art already carries the name, so callers should not add the wordmark.
const String kLogoAsset = 'assets/brand/hf_logo.png';

/// The brand logo sticker, optionally with the wordmark (Comfortaa) under it.
///
/// [size] is the logo's square size. Screen readers hear the brand name once.
/// This does not change the launcher icon or brand.dart (both come from
/// scripts/gen_brand.py).
class HfBrandMark extends StatelessWidget {
  const HfBrandMark({
    super.key,
    this.size = 96,
    this.showWordmark = false,
    this.wordmarkStyle,
  });

  final double size;
  final bool showWordmark;

  /// Defaults to [HfText.wordmark].
  final TextStyle? wordmarkStyle;

  @override
  Widget build(BuildContext context) {
    final logo = Image.asset(
      kLogoAsset,
      width: size,
      height: size,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.medium,
      excludeFromSemantics: true,
      errorBuilder: (context, error, stack) => SizedBox.square(dimension: size),
    );
    return Semantics(
      label: Brand.name,
      image: !showWordmark,
      container: true,
      child: ExcludeSemantics(
        child: showWordmark
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  logo,
                  const SizedBox(height: 8),
                  Text(
                    Brand.name,
                    textAlign: TextAlign.center,
                    style: HfText.of(context, wordmarkStyle ?? HfText.wordmark),
                  ),
                ],
              )
            : logo,
      ),
    );
  }
}
