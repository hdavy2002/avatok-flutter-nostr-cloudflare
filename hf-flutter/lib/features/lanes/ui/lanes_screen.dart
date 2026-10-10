import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/lanes?lane=women|lgbtq` (needs sign-in). Built in HF-NATIVE-8.
class LanesScreen extends StatelessWidget {
  const LanesScreen({super.key, this.lane});

  final String? lane;

  @override
  Widget build(BuildContext context) => StubScreen(
        title: 'Verify to join',
        issue: 'HF-NATIVE-8',
        showBack: true,
        details: {if (lane != null) 'lane': lane!},
      );
}
