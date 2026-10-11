import 'package:flutter/material.dart';

import '../strings.dart';
import '../theme/hf_tokens.dart';
import 'hf_button.dart';
import 'hf_scene.dart';

/// The screen shown BEFORE an Android permission prompt (spec 2.13):
///   Camera: "We need your camera for a 10-second video to prove it's really you."
///   Mic:    "We need your microphone to record your voice introduction."
/// After a denial, `denied: true` swaps the main button for "Open settings" (`openAppSettings()` from
/// permission_handler, passed as [onOpenSettings]).
class PermissionExplainer extends StatelessWidget {
  const PermissionExplainer({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    required this.onAllow,
    this.onSkip,
    this.denied = false,
    this.onOpenSettings,
  });

  final IconData icon;
  final String title;
  final String body;

  /// Runs the Android prompt.
  final VoidCallback onAllow;
  final VoidCallback? onSkip;

  /// The person already said no: offer "Open settings".
  final bool denied;
  final VoidCallback? onOpenSettings;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(HfSpacing.page),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const HfScene(kind: HfSceneKind.verify, height: 140),
          Icon(icon, size: 40, color: HfColors.ink),
          const SizedBox(height: 16),
          Text(title, style: HfText.title, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Text(body, style: HfText.bodyText, textAlign: TextAlign.center),
          const SizedBox(height: 24),
          if (denied)
            HfButton(label: Strings.openSettings, onPressed: onOpenSettings)
          else
            HfButton(label: Strings.continueLabel, onPressed: onAllow),
          if (onSkip != null) ...[
            const SizedBox(height: 8),
            HfButton(label: Strings.notNow, kind: HfButtonKind.text, onPressed: onSkip),
          ],
        ],
      ),
    );
  }
}
