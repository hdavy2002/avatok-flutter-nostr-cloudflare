import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// Tab 3 (needs sign-in). Built in HF-NATIVE-6 (both wallet shapes, Play Billing, history, limits, refunds).
class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key, this.query = const <String, String>{}});

  /// A top-up return may carry query parameters; the real screen runs its status check on them.
  final Map<String, String> query;

  @override
  Widget build(BuildContext context) =>
      StubScreen(title: 'Wallet', issue: 'HF-NATIVE-6', details: query);
}
