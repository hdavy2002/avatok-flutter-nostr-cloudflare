import 'package:flutter/material.dart';

import '../router/nav.dart';
import '../theme/hf_tokens.dart';
import 'hf_card.dart';

/// Placeholder body of a screen that a later issue builds. Replace the whole widget in
/// `lib/features/<x>/ui/`: the route, its parameters and its sign-in rule already exist.
class StubScreen extends StatelessWidget {
  const StubScreen({
    super.key,
    required this.title,
    required this.issue,
    this.details = const <String, String>{},
    this.showBack = false,
    this.children = const <Widget>[],
  });

  final String title;

  /// The issue that builds the real screen, shown on the stub (for example `HF-NATIVE-3`).
  final String issue;

  /// Route parameters, shown so a deep link can be checked on a phone.
  final Map<String, String> details;
  final bool showBack;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: showBack ? const HfBackButton() : null,
        title: Text(title),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(HfSpacing.page),
          children: [
            HfCard(
              color: HfColors.lilac,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: HfText.title),
                  const SizedBox(height: 8),
                  Text('This screen is built in $issue.', style: HfText.bodyText),
                  for (final e in details.entries) ...[
                    const SizedBox(height: 8),
                    Text('${e.key}: ${e.value}', style: HfText.note),
                  ],
                ],
              ),
            ),
            for (final c in children) ...[
              const SizedBox(height: HfSpacing.gapLarge),
              c,
            ],
          ],
        ),
      ),
    );
  }
}
