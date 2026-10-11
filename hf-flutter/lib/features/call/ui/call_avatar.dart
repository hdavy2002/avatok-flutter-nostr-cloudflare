import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';
import '../../demo/demo_data.dart'; // [HF-DEMO] remove with lib/features/demo
import '../../demo/demo_widgets.dart'; // [HF-DEMO] remove with lib/features/demo

/// A host's face for the call screens: the photo when there is one, otherwise the first letter of the name on
/// lavender. [radius] is the corner radius; pass `size / 2` for a circle.
class HfCallAvatar extends StatelessWidget {
  const HfCallAvatar({
    super.key,
    required this.name,
    required this.size,
    required this.radius,
    this.photoUrl,
    this.borderColor,
    this.borderWidth = 0,
  });

  final String name;
  final double size;
  final double radius;
  final String? photoUrl;
  final Color? borderColor;
  final double borderWidth;

  String get _initial {
    final n = name.trim();
    return n.isEmpty ? '' : String.fromCharCode(n.runes.first).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final bg = dark ? HfColors.darkTile : HfColors.lavender;
    final fg = dark ? HfColors.lavenderLight : HfColors.lavenderDeep;
    final initial = _initial;
    final fallback = Center(
      child: initial.isEmpty
          ? Icon(Icons.person_rounded, size: size * 0.5, color: fg)
          : Text(
              initial,
              style: HfText.title.copyWith(fontSize: size * 0.42, color: fg),
            ),
    );
    final url = photoUrl;
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(radius),
          border: borderWidth > 0
              ? Border.all(
                  color: borderColor ?? HfColors.white,
                  width: borderWidth,
                )
              : null,
        ),
        clipBehavior: Clip.antiAlias,
        child: url == null || url.isEmpty
            ? fallback
            : demoAssetPath(url) !=
                  null // [HF-DEMO] remove with lib/features/demo
            ? DemoAssetImage(url)
            : Image.network(
                url,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => fallback,
              ),
      ),
    );
  }
}
