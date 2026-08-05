/// The mic slide-out menu shared by the AvaTok chat and AvaChat composers.
///
/// Tapping the mic once opens this sheet with a short list of choices that slide
/// up from the bottom (so it sits ABOVE the composer). Each screen supplies its
/// own options — AvaTok: "Record audio" + "Convert voice to text"; AvaChat:
/// "Voice call Ava" + "Convert voice to text". Each choice runs after the sheet
/// closes.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'avatok_dark.dart';
import 'messenger_theme.dart';
import 'zine_widgets.dart';

/// One row in the mic menu.
class MicSheetOption {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  const MicSheetOption({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });
}

Future<void> showMicInputSheet(
  BuildContext context, {
  required List<MicSheetOption> options,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (sheetCtx) => SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s4),
        child: ZineCard(
          radius: Msg.rLg,
          padding: const EdgeInsets.all(Msg.s2),
          boxShadow: Msg.lift,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < options.length; i++) ...[
              if (i > 0) const SizedBox(height: Msg.s2),
              _MicOptionTile(
                option: options[i],
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  options[i].onTap();
                },
              ),
            ],
          ]),
        ),
      ),
    ),
  );
}

class _MicOptionTile extends StatelessWidget {
  final MicSheetOption option;
  final VoidCallback onTap;
  const _MicOptionTile({required this.option, required this.onTap});

  @override
  Widget build(BuildContext context) {
    // Colour + surface come from ZinePressable's dark defaults (AD.card +
    // hairline) — the old forced `Zine.card` fill was a near-WHITE tile.
    return ZinePressable(
      onTap: onTap,
      radius: Msg.brMd,
      boxShadow: Msg.none,
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
      child: Row(children: [
        ZineIconBadge(icon: option.icon, color: option.color, size: 38),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(option.title, style: ADText.rowName()),
                const SizedBox(height: 2),
                Text(option.subtitle, style: ADText.timestamp(c: AD.textSecondary)),
              ]),
        ),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
            size: 16, color: AD.textTertiary),
      ]),
    );
  }
}
