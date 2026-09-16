
import '../../core/localization/ui_text.dart';
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
    UiLocaleScope.watch(context);
    return Scaffold(
      body: Container(
        color: AD.bg,
        child: SafeArea(
          child: LayoutBuilder(builder: (context, constraints) {
            // Small phones (and large accessibility text) cannot fit the full
            // editorial hero and CTA in one viewport. Let the page scroll
            // instead of painting Flutter's overflow diagnostics over the CTA.
            return SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight - 36),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const SizedBox(height: 16),
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
                        fontFamily: ADText.display,
                        fontWeight: FontWeight.w700,
                        fontSize: 22,
                        letterSpacing: 0.44,
                        color: AD.textPrimary),
                    children: [
                       TextSpan(text: uiCopy(UiMessage.m_ava_149f7514de)),
                      TextSpan(
                          text: uiCopy(UiMessage.m_tok_ca36cd3eaf),
                          style: const TextStyle(color: AD.iconSearch)),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: Msg.s3),
              Text.rich(
                TextSpan(children: [
                   TextSpan(text: uiCopy(UiMessage.m_meet_6669ac2baf)),
                  TextSpan(text: uiCopy(UiMessage.m_ava_149f7514de), style: const TextStyle(color: AD.primaryBadge)),
                  const TextSpan(text: '.'),
                ]),
                textAlign: TextAlign.center,
                style: ADText.appTitle().copyWith(fontSize: 40, height: 1.08),
              ),
              const SizedBox(height: Msg.s2),
              Center(
                child: UiText(UiMessage.m_way_more_than_an_assistant_4edc623f85,
                    style: ADText.threadName().copyWith(fontSize: 17), textAlign: TextAlign.center),
              ),
              const SizedBox(height: Msg.s3),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 320),
                  child: UiText(
                    UiMessage.m_ava_replies_to_your_group_e877ddc6b7,
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
              const SizedBox(height: 24),
              AdButton(
                label: uiCopy(UiMessage.m_let_s_go_b59bed0f27),
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                onPressed: onContinue,
              ),
              const SizedBox(height: 16),
              Center(
                child: UiText(UiMessage.m_by_continuing_you_agree_to_6ebbdd4173,
                    style: ADText.sectionLabel(c: AD.textTertiary), textAlign: TextAlign.center),
              ),
                ]),
              ),
            );
          }),
        ),
      ),
    );
  }
}
