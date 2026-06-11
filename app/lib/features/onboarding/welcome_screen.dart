import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// "Everything you do, one account." — pre-auth welcome hero in the AvaTOK
/// zine style: paper background, crest, marker-highlighted headline, sticker
/// row, full-width lime CTA.
class WelcomeScreen extends StatelessWidget {
  final VoidCallback onContinue;
  const WelcomeScreen({super.key, required this.onContinue});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ZinePaper(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Spacer(flex: 3),
              const Center(child: ZineCrest()),
              const SizedBox(height: 16),
              // Brand wordmark — "Ava" in ink + "TOK" in blue-ink (§3).
              Center(
                child: Text.rich(
                  TextSpan(
                    style: const TextStyle(
                        fontFamily: ZineText.display,
                        fontWeight: FontWeight.w700,
                        fontSize: 22,
                        letterSpacing: -0.4,
                        color: Zine.ink),
                    children: [
                      const TextSpan(text: 'Ava'),
                      TextSpan(
                          text: 'TOK',
                          style: const TextStyle(color: Zine.blueInk)),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 14),
              const ZineMarkTitle(
                pre: 'Everything you do,\n',
                mark: 'one',
                post: ' account.',
                fontSize: 36,
              ),
              const SizedBox(height: 14),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 300),
                  child: Text(
                    'Calls, chat, social, market and storage — one app, in sync on every device.',
                    style: ZineText.sub(),
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Center(
                child: ZineSticker(
                  'ALL YOUR APPS · ONE ACCOUNT',
                  icon: PhosphorIcons.squaresFour(PhosphorIconsStyle.fill),
                ),
              ),
              const Spacer(flex: 4),
              ZineButton(
                label: "Let's go",
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                onPressed: onContinue,
              ),
              const SizedBox(height: 16),
              Center(
                child: Text('by continuing you agree to our terms & privacy',
                    style: ZineText.kicker(), textAlign: TextAlign.center),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
