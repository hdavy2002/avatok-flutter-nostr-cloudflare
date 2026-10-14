import 'package:flutter/material.dart';

import '../theme/hf_tokens.dart';

enum HfButtonKind {
  /// Orange fill, dark text: the one main action of a screen.
  primary,

  /// Red fill, white text for ending a call or another destructive action.
  destructive,

  /// 2 px ink outline.
  secondary,

  /// Link-coloured text, no box.
  text,
}

/// A rounded (radius 20) button, full width by default, at least 56 dp high and free to grow with its label.
/// `loading` shows a spinner and disables the button, so a second tap cannot double-submit.
class HfButton extends StatelessWidget {
  const HfButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.kind = HfButtonKind.primary,
    this.icon,
    this.loading = false,
    this.expand = true,
  });

  final String label;
  final VoidCallback? onPressed;
  final HfButtonKind kind;
  final IconData? icon;
  final bool loading;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final VoidCallback? action = loading ? null : onPressed;
    final spinnerColor = kind == HfButtonKind.destructive
        ? HfColors.white
        : kind == HfButtonKind.primary
        ? Theme.of(context).colorScheme.onPrimary
        : Theme.of(context).colorScheme.onSurface;
    final Widget content = loading
        ? SizedBox(
            height: 22,
            width: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2.5,
              color: spinnerColor,
            ),
          )
        : Text(label, textAlign: TextAlign.center);

    final Widget button;
    switch (kind) {
      case HfButtonKind.primary:
      case HfButtonKind.destructive:
        final style = kind == HfButtonKind.destructive
            ? ElevatedButton.styleFrom(
                backgroundColor: HfColors.accent,
                foregroundColor: HfColors.white,
              )
            : null;
        button = icon == null || loading
            ? ElevatedButton(onPressed: action, style: style, child: content)
            : ElevatedButton.icon(
                onPressed: action,
                style: style,
                icon: Icon(icon),
                label: content,
              );
      case HfButtonKind.secondary:
        button = icon == null || loading
            ? OutlinedButton(onPressed: action, child: content)
            : OutlinedButton.icon(
                onPressed: action,
                icon: Icon(icon),
                label: content,
              );
      case HfButtonKind.text:
        button = icon == null || loading
            ? TextButton(onPressed: action, child: content)
            : TextButton.icon(
                onPressed: action,
                icon: Icon(icon),
                label: content,
              );
    }
    return Semantics(
      button: true,
      enabled: action != null,
      label: loading ? '$label, loading' : label,
      excludeSemantics: true,
      child: expand ? SizedBox(width: double.infinity, child: button) : button,
    );
  }
}
