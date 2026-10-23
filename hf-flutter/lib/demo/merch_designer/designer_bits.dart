import 'package:flutter/material.dart';

import '../theme.dart';

/// [HF-MERCH-STUDIO-2] Small widgets of the studio's own chrome (top bar buttons, chips, the busy sheet).

class StudioRoundButton extends StatelessWidget {
  const StudioRoundButton({super.key, required this.icon, required this.label, required this.onTap, this.on = false});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool on;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: Tooltip(
        message: label,
        child: InkResponse(
          onTap: onTap,
          radius: 28,
          child: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(color: on ? C.lavtint : C.clear, shape: BoxShape.circle),
            child: Icon(icon, size: 26, color: enabled ? C.maroon : C.brass),
          ),
        ),
      ),
    );
  }
}

class StudioChip extends StatelessWidget {
  const StudioChip(this.text, {super.key, required this.bg, required this.fg});
  final String text;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.line, width: 1.5)),
        child: Text(text, style: t(15, color: fg)),
      );
}

class StudioBusyOverlay extends StatelessWidget {
  const StudioBusyOverlay({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return AbsorbPointer(
      child: ColoredBox(
        color: const Color(0x99000000),
        child: Center(
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 32),
            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 20),
            decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(24)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3.5, color: C.maroon)),
              const SizedBox(width: 16),
              Flexible(child: Text(text, style: t(17, color: C.deep, h: 1.3))),
            ]),
          ),
        ),
      ),
    );
  }
}
