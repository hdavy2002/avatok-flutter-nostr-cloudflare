import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';

/// A tick box with a full-width tap area (at least 48 dp high) and readable text.
class ConsentRow extends StatelessWidget {
  const ConsentRow({
    super.key,
    required this.value,
    required this.onChanged,
    required this.text,
  });

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
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Checkbox(
                  value: value,
                  activeColor: HfColors.ink,
                  checkColor: HfColors.white,
                  onChanged: onChanged == null
                      ? null
                      : (v) => onChanged!(v ?? false),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(text, style: HfText.of(context, HfText.body)),
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
    final color = HfBrightness.isDark(context)
        ? HfColors.blushLight
        : HfColors.accent;
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2, right: 8),
              child: Icon(Icons.error_outline_rounded, size: 20, color: color),
            ),
            Expanded(
              child: Text(message, style: HfText.body.copyWith(color: color)),
            ),
          ],
        ),
      ),
    );
  }
}

/// A calm tinted note card (radius 22). Lavender by default; pass [HfColors.blush], [HfColors.butter] or
/// [HfColors.sky] for the other tints. Used for explainers, "let's try DigiLocker instead" and similar hints.
class InfoBox extends StatelessWidget {
  const InfoBox({
    super.key,
    required this.title,
    this.body,
    this.color = HfColors.lavender,
  });

  final String title;
  final String? body;
  final Color color;

  HfTint get _tint {
    if (color == HfColors.blush) return HfTint.blush;
    if (color == HfColors.butter) return HfTint.butter;
    if (color == HfColors.sky) return HfTint.sky;
    if (color == HfColors.peach) return HfTint.peach;
    return HfTint.lavender;
  }

  @override
  Widget build(BuildContext context) {
    final tint = _tint;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(HfSpacing.xxl),
        decoration: HfSurfaces.card(context, radius: HfRadius.tile),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: HfText.subsection.copyWith(color: tint.valueInk(context)),
            ),
            if (body != null) ...[
              const SizedBox(height: 6),
              Text(
                body!,
                style: HfText.body.copyWith(color: tint.ink(context)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A done tick with a line of text, distinct from pending review. The check scales in (no green: lavender deep).
class DoneRow extends StatelessWidget {
  const DoneRow(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Row(
      children: [
        TweenAnimationBuilder<double>(
          tween: Tween<double>(begin: 0, end: 1),
          duration: HfMotion.of(context, HfMotion.slow),
          curve: Curves.easeOutBack,
          builder: (context, t, child) =>
              Transform.scale(scale: t.clamp(0.0, 1.2), child: child),
          child: Icon(
            Icons.check_circle_rounded,
            size: 28,
            color: dark ? HfColors.lavenderLight : HfColors.lavenderDeep,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(text, style: HfText.of(context, HfText.bodyStrong)),
        ),
      ],
    );
  }
}

/// A small tinted pill, for example "Step 2 of 3" or a countdown.
class StepPill extends StatelessWidget {
  const StepPill(this.text, {super.key, this.tint = HfTint.lavender});

  final String text;
  final HfTint tint;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: tint.bg(context),
        borderRadius: BorderRadius.circular(HfRadius.pillRadius),
      ),
      child: Text(text, style: HfText.badge.copyWith(color: tint.ink(context))),
    );
  }
}
