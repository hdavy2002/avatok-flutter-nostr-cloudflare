import 'package:flutter/material.dart';

import '../../core/theme/hf_theme.dart';
import 'demo_data.dart';

/// The small butter "Demo" chip: shown on the demo cards, profiles and call screens, so a demo host is never
/// mistaken for a real one.
class DemoChip extends StatelessWidget {
  const DemoChip({super.key});

  @override
  Widget build(BuildContext context) {
    const tint = HfTint.butter;
    return Semantics(
      label: 'Demo host, not a real person',
      excludeSemantics: true,
      child: Container(
        key: const ValueKey<String>('demo-chip'),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: tint.bg(context),
          borderRadius: BorderRadius.circular(HfRadius.pillRadius),
        ),
        child: Text(
          'Demo',
          style: HfText.badge.copyWith(color: tint.valueInk(context)),
        ),
      ),
    );
  }
}

/// A picture bundled with the app (`asset://assets/images/x.webp`). Decoded at about the size it is shown.
class DemoAssetImage extends StatelessWidget {
  const DemoAssetImage(
    this.url, {
    super.key,
    this.fit = BoxFit.cover,
    this.cacheWidth = 900,
  });

  final String url;
  final BoxFit fit;
  final int cacheWidth;

  @override
  Widget build(BuildContext context) {
    final path = demoAssetPath(url);
    final fallback = ColoredBox(
      color: HfTint.lavender.bg(context),
      child: Center(
        child: Icon(
          Icons.person_rounded,
          size: 56,
          color: HfTint.lavender.ink(context),
        ),
      ),
    );
    if (path == null) return fallback;
    return Image.asset(
      path,
      fit: fit,
      cacheWidth: cacheWidth,
      gaplessPlayback: true,
      errorBuilder: (_, __, ___) => fallback,
    );
  }
}
