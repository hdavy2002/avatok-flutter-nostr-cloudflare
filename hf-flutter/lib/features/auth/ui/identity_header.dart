import 'package:flutter/material.dart';
import '../../../core/theme/hf_theme.dart';

/// Shared hierarchy from the identity storyboards: progress, title, illustration,
/// then the form. The illustration never represents a signed-in account.
class IdentityHeader extends StatelessWidget {
  const IdentityHeader({super.key, required this.title, required this.subtitle,
    this.step, this.total = 7, this.imageHeight = 190});
  final String title;
  final String subtitle;
  final int? step;
  final int total;
  final double imageHeight;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (step != null) ...[
        Row(children: [
          Expanded(child: Row(children: [for (var i = 0; i < total; i++)
            Expanded(child: Container(height: 7, margin: const EdgeInsets.symmetric(horizontal: 1),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(4),
                color: i < step! ? HfColors.lavenderDeep : HfColors.lavender))),
          ])),
          const SizedBox(width: 20), Text('$step/$total', style: HfText.of(context, HfText.badge)),
        ]),
        const SizedBox(height: 22),
      ],
      Text(title, textAlign: TextAlign.center, style: HfText.of(context, HfText.headline)),
      const SizedBox(height: 8),
      Text(subtitle, textAlign: TextAlign.center, style: HfText.of(context, HfText.body)),
      const SizedBox(height: 16),
      if (imageHeight > 0) ExcludeSemantics(child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: Image.asset('assets/images/hero_collage.webp', height: imageHeight,
          width: double.infinity, fit: BoxFit.cover),
      )),
      const SizedBox(height: 16),
    ],
  );
}
