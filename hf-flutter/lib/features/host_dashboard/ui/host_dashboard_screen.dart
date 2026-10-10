import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// Host tab (needs sign-in, shown when `GET /api/hf/me` has a host). Built in HF-NATIVE-11.
/// A person without a host profile who lands here (deep link) should see a "Become a host" panel.
class HostDashboardScreen extends StatelessWidget {
  const HostDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) => const StubScreen(title: 'Host', issue: 'HF-NATIVE-11');
}
