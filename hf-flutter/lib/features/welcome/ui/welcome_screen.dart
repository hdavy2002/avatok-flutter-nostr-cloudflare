import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/welcome`: 18+ and safety rules, shown first on a device that has not accepted them. Built in HF-NATIVE-2.
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) => const StubScreen(
        title: 'Welcome',
        issue: 'HF-NATIVE-2',
        children: [CrisisStrip()],
      );
}
