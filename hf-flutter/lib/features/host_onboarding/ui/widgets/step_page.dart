import 'package:flutter/material.dart';

import '../../../../core/theme/hf_tokens.dart';

/// The standard page body of an onboarding step: scrollable, 20 dp side padding, full width, an optional title
/// and lead line, then the children. Part B steps use it too so every step looks the same.
class OnboardingStepPage extends StatelessWidget {
  const OnboardingStepPage({super.key, this.title, this.lead, required this.children});

  final String? title;
  final String? lead;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 8, HfSpacing.page, 32),
      children: [
        if (title != null) Text(title!, style: HfText.title),
        if (lead != null) ...[
          const SizedBox(height: 8),
          Text(lead!, style: HfText.bodyText),
        ],
        if (title != null || lead != null) const SizedBox(height: 20),
        ...children,
      ],
    );
  }
}
