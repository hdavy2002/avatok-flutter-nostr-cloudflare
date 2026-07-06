import 'package:flutter/material.dart';

import '../liveness_v2/live_theme.dart';
import 'voice_packs.dart';

/// Liveness V3 — LANGUAGE PICKER stage (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md §1). The flow OPENS with a language dropdown pre-selected to the
/// device locale; on confirm the voice + on-screen strings switch to that
/// language and the flow begins. Styled with the existing V2 [LiveTheme]
/// components (dark stage, lime CTA) — reuse, not redesign.
class LanguagePickerStep extends StatefulWidget {
  const LanguagePickerStep({
    super.key,
    required this.initialLang,
    required this.onConfirm,
  });

  /// Pre-selected language (device locale, normalized to a supported code).
  final String initialLang;

  /// User confirmed — the flow switches language + continues.
  final void Function(String lang) onConfirm;

  @override
  State<LanguagePickerStep> createState() => _LanguagePickerStepState();
}

class _LanguagePickerStepState extends State<LanguagePickerStep> {
  late String _lang = LivenessStrings.supported.contains(widget.initialLang)
      ? widget.initialLang
      : 'en';

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        Center(
          child: Container(
            width: 92,
            height: 92,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: LiveTheme.mint,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: const Icon(Icons.translate_rounded, size: 42, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline('Choose your ', markWord: 'language'),
        const SizedBox(height: 12),
        Text(
          "I'll guide you by voice. Pick the language you'd like me to speak.",
          style: LiveTheme.subStyle,
        ),
        const SizedBox(height: 24),
        // Dropdown inside a zine card so it matches the dark stage chrome.
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          decoration: LiveTheme.taperedCardDecoration,
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: _lang,
              isExpanded: true,
              dropdownColor: LiveTheme.card,
              icon: const Icon(Icons.expand_more_rounded, color: LiveTheme.ink),
              style: const TextStyle(
                fontFamily: 'Nunito',
                fontWeight: FontWeight.w800,
                fontSize: 17,
                color: LiveTheme.ink,
              ),
              items: [
                for (final code in LivenessStrings.supported)
                  DropdownMenuItem<String>(
                    value: code,
                    child: Text(LivenessStrings.labels[code] ?? code),
                  ),
              ],
              onChanged: (v) {
                if (v != null) setState(() => _lang = v);
              },
            ),
          ),
        ),
        const Spacer(),
        LiveTheme.limeButton(
          label: 'Continue',
          icon: Icons.arrow_forward_rounded,
          onPressed: () => widget.onConfirm(_lang),
        ),
      ],
    );
  }
}
