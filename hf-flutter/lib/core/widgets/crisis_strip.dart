import 'package:flutter/material.dart';

import '../links.dart';
import '../strings.dart';
import '../theme/hf_tokens.dart';
import 'hf_button.dart';

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
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: HfColors.butter,
        borderRadius: BorderRadius.circular(HfRadius.card),
        border: Border.all(color: HfColors.butterDeep),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(Strings.crisisTitle, style: HfText.subtitle),
          const SizedBox(height: 12),
          // At large text sizes the two buttons stack, so the labels never overflow.
          if (MediaQuery.textScalerOf(context).scale(14) > 22)
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [call(Strings.crisisTeleManas, Strings.crisisTeleManasNumber), const SizedBox(height: 12), call(Strings.crisisEmergency, Strings.crisisEmergencyNumber)],
            )
          else
            Row(
              children: [
                Expanded(child: call(Strings.crisisTeleManas, Strings.crisisTeleManasNumber)),
                const SizedBox(width: 12),
                Expanded(child: call(Strings.crisisEmergency, Strings.crisisEmergencyNumber)),
              ],
            ),
        ],
      ),
    );
  }
}
