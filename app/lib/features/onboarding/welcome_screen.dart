import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/illustrations.dart';
import '../../core/ui/messenger_theme.dart';

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
              // [RAJ-SEAMS-1] Hero illustration — 01-onboarding-illo-1.svg
              // (390x316), the designer's single hero art for this screen.
              // Decorative: the "Meet Ava." headline + subtitle beside it
              // carry the meaning, so it is excluded from semantics. This
              // screen stays full-bleed — no header band per the spec.
              Center(
                child: SvgPicture.asset(
                  Illustrations.onboardingHero,
                  width: 260,
                  fit: BoxFit.contain,
                  excludeFromSemantics: true,
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
              const SizedBox(height: Msg.s3),
              Text.rich(
                TextSpan(children: [
                  const TextSpan(text: 'Meet '),
                  TextSpan(text: 'Ava', style: const TextStyle(color: AD.primaryBadge)),
                  const TextSpan(text: '.'),
                ]),
                textAlign: TextAlign.center,
                style: ADText.appTitle().copyWith(fontSize: 40, height: 1.08),
              ),
              const SizedBox(height: Msg.s2),
              Center(
                child: Text('Way more than an assistant.',
                    style: ADText.threadName().copyWith(fontSize: 17), textAlign: TextAlign.center),
              ),
              const SizedBox(height: Msg.s3),
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
              const SizedBox(height: Msg.s4),
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
