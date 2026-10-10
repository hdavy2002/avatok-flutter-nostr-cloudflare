import 'package:flutter/material.dart';

import '../../../core/brand.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';

/// Tab 1. Built in HF-NATIVE-3 (greeting band, Online now strip, mood chips, lanes, how it works, safety).
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return StubScreen(
      title: Brand.name,
      issue: 'HF-NATIVE-3',
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(HfRadius.card),
          child: Image.asset(
            'assets/images/hero_collage.webp',
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => const SizedBox.shrink(),
          ),
        ),
        const Text(Brand.slogan, style: HfText.title),
        const CrisisStrip(),
      ],
    );
  }
}
