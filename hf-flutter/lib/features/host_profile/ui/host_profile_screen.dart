import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/h/:slug` (no sign-in needed to look). Built in HF-NATIVE-4.
class HostProfileScreen extends StatelessWidget {
  const HostProfileScreen({super.key, required this.slug});

  final String slug;

  @override
  Widget build(BuildContext context) =>
      StubScreen(title: 'Host profile', issue: 'HF-NATIVE-4', showBack: true, details: {'slug': slug});
}
