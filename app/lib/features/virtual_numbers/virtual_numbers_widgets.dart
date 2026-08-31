import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../avadial/avadial_theme.dart';
import 'virtual_numbers_models.dart';

class VirtualNumbersUi {
  static const gap = 12.0;
  static const radius = 16.0;

  static Widget shell(
          {required String title,
          required Widget child,
          VoidCallback? onBack,
          List<Widget> actions = const []}) =>
      Scaffold(
        backgroundColor: AvaDialTheme.bg,
        appBar: AppBar(
          backgroundColor: AvaDialTheme.bg,
          surfaceTintColor: Colors.transparent,
          leading: onBack == null
              ? null
              : IconButton(
                  onPressed: onBack,
                  icon: Icon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.regular)),
                  tooltip: 'Back'),
          title: Text(title, style: AvaDialTheme.title(size: 21)),
          actions: actions,
        ),
        body: SafeArea(child: child),
      );

  static Widget sectionLabel(String text) => Padding(
        padding: const EdgeInsets.only(left: 2, top: 4, bottom: 2),
        child: Text(text.toUpperCase(),
            style: AvaDialTheme.tag(size: 11, color: AvaDialTheme.textMute)),
      );

  static Widget lineTypeChip(VirtualLine line) => AvaDialTheme.chip(
        line.typeLabel,
        color: line.isDid ? AvaDialTheme.unknown : AvaDialTheme.contact,
        icon: line.isDid
            ? PhosphorIcons.phone(PhosphorIconsStyle.bold)
            : PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
      );

  static Widget statusChip(VirtualLine line) => AvaDialTheme.chip(
        line.statusLabel,
        color: line.isActive ? AvaDialTheme.contact : AvaDialTheme.spam,
        icon: line.isActive ? PhosphorIcons.checkCircle(PhosphorIconsStyle.regular) : PhosphorIcons.info(PhosphorIconsStyle.regular),
      );

  static Widget labelValue(String label, String value,
          {Widget? trailing, bool enabled = true}) =>
      Semantics(
        label: '$label: $value',
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: enabled ? AvaDialTheme.surface : AvaDialTheme.surface2,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
                color: enabled
                    ? AvaDialTheme.border
                    : AvaDialTheme.border.withValues(alpha: .5),
                width: 1.5),
          ),
          child: Row(children: [
            Expanded(
                child: Text(value,
                    style: AvaDialTheme.value(
                        color: enabled
                            ? AvaDialTheme.text
                            : AvaDialTheme.textMute))),
            if (trailing != null) trailing
          ]),
        ),
      );

  static Widget toggleRow(
          {required String title,
          required String subtitle,
          required bool value,
          required ValueChanged<bool> onChanged}) =>
      SwitchListTile.adaptive(
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 1),
        title: Text(title, style: AvaDialTheme.value(size: 14)),
        subtitle: Text(subtitle, style: AvaDialTheme.sub(size: 12)),
        value: value,
        onChanged: onChanged,
        activeColor: AvaDialTheme.contact,
      );

  static Widget primaryButton(
          {required String label,
          required VoidCallback? onPressed,
          IconData? icon,
          bool busy = false}) =>
      SizedBox(
          width: double.infinity,
          height: 50,
          child: FilledButton.icon(
            onPressed: busy ? null : onPressed,
            icon: busy
                ? const SizedBox.square(
                    dimension: 17,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : Icon(icon ?? PhosphorIcons.check(PhosphorIconsStyle.regular)),
            label: Text(label),
            style: FilledButton.styleFrom(
                backgroundColor: AvaDialTheme.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14))),
          ));
}

class VirtualLineAvatar extends StatelessWidget {
  const VirtualLineAvatar({super.key, required this.line, this.size = 44});
  final VirtualLine line;
  final double size;
  @override
  Widget build(BuildContext context) => Semantics(
        label: line.typeLabel,
        child: Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(
              color: virtualLineColor(line.colorKey),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AvaDialTheme.border, width: 1.5)),
          child: Text(
              line.label.isEmpty
                  ? '?'
                  : line.label.characters.first.toUpperCase(),
              style: AvaDialTheme.title(size: size * .38, color: Colors.white)),
        ),
      );
}
