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
              const Spacer(flex: 2),
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
                pre: 'Meet ',
                mark: 'Ava',
                post: '.',
                fontSize: 40,
              ),
              const SizedBox(height: 10),
              Center(
                child: Text('Way more than an assistant.',
                    style: ZineText.cardTitle(size: 17), textAlign: TextAlign.center),
              ),
              const SizedBox(height: 14),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 320),
                  child: Text(
                    "Ava replies to your group chats while you're away, talks to "
                    "strangers while you sleep, keeps your records, calls for help in "
                    "an emergency — and just talks when you're bored. The Siri of messaging.",
                    style: ZineText.sub(),
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Center(
                child: ZineSticker(
                  'PRIVATE @ava · PUBLIC #ava',
                  icon: PhosphorIcons.chatsCircle(PhosphorIconsStyle.fill),
                ),
              ),
              const Spacer(flex: 2),
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
