import 'package:flutter/material.dart';

import '../../../core/theme/hf_tokens.dart';

/// A tick box with a full-width tap area (at least 48 dp high) and readable text.
class ConsentRow extends StatelessWidget {
  const ConsentRow({super.key, required this.value, required this.onChanged, required this.text});

  final bool value;
  final ValueChanged<bool>? onChanged;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      checked: value,
      label: text,
      onTap: onChanged == null ? null : () => onChanged!(!value),
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(HfRadius.control),
        onTap: onChanged == null ? null : () => onChanged!(!value),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Checkbox(value: value, onChanged: onChanged == null ? null : (v) => onChanged!(v ?? false)),
                const SizedBox(width: 4),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(text, style: HfText.bodyText),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// An error line in the alert colour. Announced to screen readers.
class InlineError extends StatelessWidget {
  const InlineError(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 2, right: 8),
              child: Icon(Icons.error_outline_rounded, size: 20, color: HfColors.accent),
            ),
            Expanded(child: Text(message, style: HfText.bodyText.copyWith(color: HfColors.accent))),
          ],
        ),
      ),
    );
  }
}

/// A calm note box (lilac). Used for "let's try DigiLocker instead" and similar hints.
class InfoBox extends StatelessWidget {
  const InfoBox({super.key, required this.title, this.body, this.color = HfColors.lilac});

  final String title;
  final String? body;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(HfRadius.card),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: HfText.subtitle),
            if (body != null) ...[
              const SizedBox(height: 6),
              Text(body!, style: HfText.bodyText),
            ],
          ],
        ),
      ),
    );
  }
}

/// A done tick with a line of text. The tick is orchid, never green.
class DoneRow extends StatelessWidget {
  const DoneRow(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Icon(Icons.check_circle_rounded, size: 28, color: HfColors.orchid),
        const SizedBox(width: 12),
        Expanded(child: Text(text, style: HfText.bodyStrong)),
      ],
    );
  }
}
