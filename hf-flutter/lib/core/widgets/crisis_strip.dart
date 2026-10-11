import 'package:flutter/material.dart';

import '../links.dart';
import '../strings.dart';
import '../theme/hf_theme.dart';
import 'hf_button.dart';
import 'hf_card.dart';

/// Tele-MANAS 14416 and 112 as `tel:` links (HF-WELL-8, HF-WELL-10). Shown on Home, the welcome screen and Me.
/// The person taps Call in the dialer themselves; the app never places a call.
class CrisisStrip extends StatelessWidget {
  const CrisisStrip({super.key});

  @override
  Widget build(BuildContext context) {
    Widget call(String label, String number) => HfButton(
      label: label,
      icon: Icons.phone_rounded,
      kind: HfButtonKind.secondary,
      onPressed: () => LinkOpener.instance.tel(number),
    );
    return SizedBox(
      width: double.infinity,
      child: HfCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              Strings.crisisTitle,
              style: HfText.of(context, HfText.subsection),
            ),
            const SizedBox(height: 12),
            // At large text sizes the two buttons stack, so the labels never overflow.
            if (MediaQuery.textScalerOf(context).scale(14) > 22 ||
                MediaQuery.sizeOf(context).width < 380)
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  call(Strings.crisisTeleManas, Strings.crisisTeleManasNumber),
                  const SizedBox(height: 12),
                  call(Strings.crisisEmergency, Strings.crisisEmergencyNumber),
                ],
              )
            else
              Row(
                children: [
                  Expanded(
                    child: call(
                      Strings.crisisTeleManas,
                      Strings.crisisTeleManasNumber,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: call(
                      Strings.crisisEmergency,
                      Strings.crisisEmergencyNumber,
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
