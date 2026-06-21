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

import 'zine.dart';
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
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
        child: ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(10),
          boxShadow: Zine.shadowSm,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < options.length; i++) ...[
              if (i > 0) const SizedBox(height: 8),
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
    return ZinePressable(
      onTap: onTap,
      color: Zine.card,
      radius: BorderRadius.circular(Zine.rBadge),
      boxShadow: const <BoxShadow>[],
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Row(children: [
        ZineIconBadge(icon: option.icon, color: option.color, size: 38),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(option.title, style: ZineText.value(size: 15)),
                const SizedBox(height: 2),
                Text(option.subtitle, style: ZineText.sub(size: 12)),
              ]),
        ),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
            size: 16, color: Zine.inkSoft),
      ]),
    );
  }
}
