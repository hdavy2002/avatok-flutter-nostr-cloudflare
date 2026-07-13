import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';

/// "Everything you do, one account." — pre-auth welcome hero in the AvaTOK
/// zine style: paper background, crest, marker-highlighted headline, sticker
/// row, full-width lime CTA.
class WelcomeScreen extends StatelessWidget {
  final VoidCallback onContinue;
  const WelcomeScreen({super.key, required this.onContinue});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        color: AD.bg,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Spacer(flex: 2),
              Center(
                child: Container(
                  width: 116, height: 116,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AD.card,
                    border: Border.all(color: AD.borderControl, width: 1),
                    boxShadow: AD.overlayShadow,
                  ),
                  child: Center(
                    child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                        size: 46, color: AD.primaryBadge),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              // Brand wordmark — "Ava" in ink + "TOK" in blue-ink (§3).
              Center(
                child: Text.rich(
                  TextSpan(
                    style: const TextStyle(
                        fontFamily: ADText.family,
                        fontWeight: FontWeight.w700,
                        fontSize: 22,
                        letterSpacing: -0.4,
                        color: AD.textPrimary),
                    children: [
                      const TextSpan(text: 'Ava'),
                      TextSpan(
                          text: 'TOK',
                          style: const TextStyle(color: AD.iconSearch)),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text.rich(
                TextSpan(children: [
                  const TextSpan(text: 'Meet '),
                  TextSpan(text: 'Ava', style: const TextStyle(color: AD.primaryBadge)),
                  const TextSpan(text: '.'),
                ]),
                textAlign: TextAlign.center,
                style: ADText.appTitle().copyWith(fontSize: 40, height: 1.08),
              ),
              const SizedBox(height: 10),
              Center(
                child: Text('Way more than an assistant.',
                    style: ADText.threadName().copyWith(fontSize: 17), textAlign: TextAlign.center),
              ),
              const SizedBox(height: 14),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 320),
                  child: Text(
                    "Ava replies to your group chats while you're away, talks to "
                    "strangers while you sleep, keeps your records, calls for help in "
                    "an emergency — and just talks when you're bored. The Siri of messaging.",
                    style: ADText.preview(c: AD.textSecondary),
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Center(
                child: AdSticker(
                  'PRIVATE @ava · PUBLIC #ava',
                  icon: PhosphorIcons.chatsCircle(PhosphorIconsStyle.fill),
                ),
              ),
              const Spacer(flex: 2),
              AdButton(
                label: "Let's go",
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                onPressed: onContinue,
              ),
              const SizedBox(height: 16),
              Center(
                child: Text('by continuing you agree to our terms & privacy',
                    style: ADText.sectionLabel(c: AD.textTertiary), textAlign: TextAlign.center),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
