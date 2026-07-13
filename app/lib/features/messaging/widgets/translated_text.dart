// translated_text.dart — [GROUP-AI-3] a small wrapper widget that renders a
// message's translated text with a "translated · show original" toggle. It does
// NOT modify Stream K's bubble geometry — the chat bubble passes its ORIGINAL
// text child in, and (when a translation exists) this widget shows the
// translation with a one-line footer to flip back to the source.
//
// Two use-sites:
//   • [GROUP-AI-2] per-member group translation (translation supplied by the
//     parent from /api/ai/group-translate).
//   • [GROUP-AI-5] inline "Translate" context-menu item (single-bubble result).
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';

class TranslatedText extends StatefulWidget {
  /// The original bubble content (already styled by the caller / Stream K bubble).
  final Widget original;

  /// The translated string. When null/empty the [original] renders unchanged.
  final String? translated;

  /// Text style for the translated line (match the bubble's body style).
  final TextStyle? translatedStyle;

  /// Whether to start showing the translation (true) or the original (false).
  final bool startTranslated;

  const TranslatedText({
    super.key,
    required this.original,
    required this.translated,
    this.translatedStyle,
    this.startTranslated = true,
  });

  @override
  State<TranslatedText> createState() => _TranslatedTextState();
}

class _TranslatedTextState extends State<TranslatedText> {
  late bool _showTranslated = widget.startTranslated;

  @override
  Widget build(BuildContext context) {
    final t = widget.translated;
    if (t == null || t.trim().isEmpty) return widget.original;

    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      _showTranslated
          ? Text(t, style: widget.translatedStyle ?? ADText.bubbleBody())
          : widget.original,
      const SizedBox(height: 3),
      GestureDetector(
        onTap: () => setState(() => _showTranslated = !_showTranslated),
        behavior: HitTestBehavior.opaque,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold), size: 11, color: AD.iconSearch),
          const SizedBox(width: 4),
          Text(
            _showTranslated ? 'translated · show original' : 'show translation',
            style: ADText.statCaption(c: AD.iconSearch),
          ),
        ]),
      ),
    ]);
  }
}
