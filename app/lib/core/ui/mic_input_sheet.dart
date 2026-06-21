/// The mic slide-out menu shared by the AvaTok chat and AvaChat composers.
///
/// Tapping the mic once opens this sheet with two choices (top → bottom, per the
/// product spec): "Record audio" and "Convert voice to text". It slides up from
/// the bottom so it sits ABOVE the composer. Each choice runs its callback after
/// the sheet closes.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'zine.dart';
import 'zine_widgets.dart';

/// Show the mic menu. [recordSubtitle] lets each screen describe what "record"
/// does there (send a voice note vs. transcribe to text).
Future<void> showMicInputSheet(
  BuildContext context, {
  required VoidCallback onRecordAudio,
  required VoidCallback onVoiceToText,
  String recordSubtitle = 'Record your voice and send it',
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (sheetCtx) => SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
        child: ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(10),
          boxShadow: Zine.shadowSm,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            _MicOption(
              icon: PhosphorIcons.microphone(PhosphorIconsStyle.fill),
              color: Zine.coral,
              title: 'Record audio',
              subtitle: recordSubtitle,
              onTap: () {
                Navigator.of(sheetCtx).pop();
                onRecordAudio();
              },
            ),
            const SizedBox(height: 8),
            _MicOption(
              icon: PhosphorIcons.textT(PhosphorIconsStyle.bold),
              color: Zine.mint,
              title: 'Convert voice to text',
              subtitle: 'Speak and watch it type into the box',
              onTap: () {
                Navigator.of(sheetCtx).pop();
                onVoiceToText();
              },
            ),
          ]),
        ),
      ),
    ),
  );
}

class _MicOption extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  const _MicOption({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap,
      color: Zine.card,
      radius: BorderRadius.circular(Zine.rBadge),
      boxShadow: const <BoxShadow>[],
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Row(children: [
        ZineIconBadge(icon: icon, color: color, size: 38),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: ZineText.value(size: 15)),
                const SizedBox(height: 2),
                Text(subtitle, style: ZineText.sub(size: 12)),
              ]),
        ),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
            size: 16, color: Zine.inkSoft),
      ]),
    );
  }
}
