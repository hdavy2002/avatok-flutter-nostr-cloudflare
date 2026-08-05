// [CHAT-MENTIONS-1] Composer controller that paints mention tokens in colour.
//
// Owner request (2026-08-04): mentions inserted from the new "@" picker must be
// visibly distinct in the input box — "if davy selects Sonal, the input box will
// auto have @Sonal in light blue".
//
// A plain TextEditingController renders one flat style, so the only way to get
// per-token colour inside a live TextField is to override buildTextSpan. This is
// PURELY presentational: `text` stays exactly what the user typed, so every
// existing consumer (_send, the @ava/#ava parser in ava_invoke.dart, the draft
// store, the AI rewrite tools that call _replaceComposer) is unaffected.
import 'package:flutter/material.dart';

class MentionTextController extends TextEditingController {
  MentionTextController({super.text});

  /// Light blue for `@name` mentions.
  ///
  /// NOT the 0xFF8FC0F5 the retired hint line used: that blue was picked to sit
  /// on the DARK composer band, and the input field itself is WHITE — pale blue
  /// on white is barely legible (confirmed on the emulator, 2026-08-04). This is
  /// the same hue carried down to a stop that actually reads on paper.
  static const mentionBlue = Color(0xFF2C7BE5);

  /// Green for `#ava` — a SHARED/public Ava ask, which is a different act from a
  /// private mention and was green in the old hint line too.
  static const shareGreen = Color(0xFF12864F);

  // `@word` or `#word`. Word chars only, so a trailing space/punctuation ends the
  // token and an email address (no leading space) is not mistaken for a mention.
  static final _token = RegExp(r'(?<![\w@#])([@#])(\w+)');

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final base = style ?? const TextStyle();
    final src = text;
    if (src.isEmpty) return TextSpan(style: base, text: src);

    final spans = <TextSpan>[];
    var cursor = 0;
    for (final m in _token.allMatches(src)) {
      if (m.start > cursor) {
        spans.add(TextSpan(text: src.substring(cursor, m.start), style: base));
      }
      final sigil = m.group(1)!;
      spans.add(TextSpan(
        text: m.group(0),
        style: base.copyWith(
          color: sigil == '#' ? shareGreen : mentionBlue,
          // [UI-MSG-TYPE-1] w800 is out of the scale; a mention is emphasis
          // inside body copy, not a heading.
          fontWeight: FontWeight.w600,
        ),
      ));
      cursor = m.end;
    }
    if (cursor < src.length) {
      spans.add(TextSpan(text: src.substring(cursor), style: base));
    }
    return TextSpan(style: base, children: spans);
  }
}
