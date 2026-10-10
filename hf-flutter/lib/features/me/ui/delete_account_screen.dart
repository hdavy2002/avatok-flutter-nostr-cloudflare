import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/me/delete` (needs sign-in). Built in HF-NATIVE-12 (`DELETE /api/hf/me`, 30-day closing state).
class DeleteAccountScreen extends StatelessWidget {
  const DeleteAccountScreen({super.key});

  @override
  Widget build(BuildContext context) =>
      const StubScreen(title: 'Delete my account', issue: 'HF-NATIVE-12', showBack: true);
}
