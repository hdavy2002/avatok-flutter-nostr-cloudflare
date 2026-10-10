import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/call/:id` (needs sign-in). Built in HF-NATIVE-5 (2 s status polling, resume, cancel, summary).
class CallScreen extends StatelessWidget {
  const CallScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) =>
      StubScreen(title: 'Call', issue: 'HF-NATIVE-5', showBack: true, details: {'id': id});
}
