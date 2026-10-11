import 'package:flutter/material.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';

/// A full-width form with its own illustrated chapter and white workspace.
class OnboardingStepPage extends StatelessWidget {
  const OnboardingStepPage({super.key, this.title, this.lead,
    this.scene = HfSceneKind.host, required this.children});

  final String? title;
  final String? lead;
  final HfSceneKind scene;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.fromLTRB(HfSpacing.page, 8, HfSpacing.page, 32),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        HfScene(kind: scene, height: 120),
        const SizedBox(height: 20),
        if (title != null) Semantics(header: true, child: Text(title!, style: HfText.title)),
        if (lead != null) ...[
          const SizedBox(height: 8),
          Text(lead!, style: HfText.bodyText),
        ],
        const SizedBox(height: 20),
        HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)),
      ]),
  );
}
