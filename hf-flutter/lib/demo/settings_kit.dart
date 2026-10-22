import 'package:flutter/material.dart';

import 'desi.dart';
import 'theme.dart';

/// [HF-APP-DESI-10] Settings and Help pieces, built to the owner-approved canvas previews "10 · Settings" and "10b · Help"
/// (2026-10-22).

/// Pink strip: initial in a rani→marigold circle, name, "Tap to change your name" and a pencil. Tapping edits the name.
class SettingsMeStrip extends StatelessWidget {
  const SettingsMeStrip({super.key, required this.name, this.onTap, this.hint = 'Tap to change your name'});
  final String name;
  final VoidCallback? onTap;
  final String hint;
  @override
  Widget build(BuildContext context) {
    final shown = name.trim().isEmpty ? 'Add your name' : name;
    return Semantics(
      button: onTap != null,
      child: Material(
        color: C.clear,
        child: InkWell(
          borderRadius: BorderRadius.circular(24),
          onTap: onTap,
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: const Color(0xFFF8C4D9), width: 1.5),
              gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFFFE0EC), Color(0xFFFFF0F6), Color(0xFFFFF6EA)]),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(children: [
                Container(
                  width: 60,
                  height: 60,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: C.white, width: 3),
                    gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.rani, C.marigold]),
                  ),
                  child: Text(name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase(), style: t(24, color: C.white, w: FontWeight.w900)),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(shown, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(20, w: FontWeight.w900)),
                    if (onTap != null) Text(hint, style: t(14, color: C.muted, w: FontWeight.w700)),
                  ]),
                ),
                if (onTap != null)
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(color: C.white, shape: BoxShape.circle, border: Border.all(color: const Color(0xFFF8C4D9), width: 1.5)),
                    child: const Icon(Icons.edit_rounded, color: C.rani, size: 20),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Coloured settings group: small caps title and rows. rani = Account, tea = WhatsApp messages, lav = About.
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, required this.title, required this.tone, required this.children, this.flower = false});
  final String title;
  final DesiTone tone;
  final List<Widget> children;
  final bool flower;
  @override
  Widget build(BuildContext context) {
    final (Color tint, Color edge) = switch (tone) {
      DesiTone.tea => (C.teatint, const Color(0xFFB9E2E5)),
      DesiTone.lav => (C.lavtint, const Color(0xFFDDD2FB)),
      _ => (const Color(0xFFFFF0F6), const Color(0xFFF8C4D9)),
    };
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: edge, width: 1.5),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, tint]),
      ),
      child: Stack(children: [
        if (flower) const Positioned(right: -12, top: -12, child: Marigold(size: 46)),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Semantics(header: true, child: Text(title.toUpperCase(), style: t(14, color: desiInk(tone), w: FontWeight.w800, ls: .06))),
            const SizedBox(height: 4),
            ...children,
          ]),
        ),
      ]),
    );
  }
}

/// One row: icon square, label (+ sub), and a chevron or a right-hand value.
class SettingsRow extends StatelessWidget {
  const SettingsRow({super.key, required this.icon, required this.tone, required this.label, this.sub, this.value, this.onTap, this.last = false});
  final IconData icon;
  final DesiTone tone;
  final String label;
  final String? sub;
  final String? value;
  final VoidCallback? onTap;
  final bool last;
  @override
  Widget build(BuildContext context) {
    final row = Container(
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
      child: Row(children: [
        DesiIconSquare(icon, tone: tone, size: 40),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: t(16, w: FontWeight.w800)),
            if (sub != null) Text(sub!, style: t(14, color: C.muted, w: FontWeight.w700)),
          ]),
        ),
        if (value != null) Text(value!, style: t(15, color: C.muted, w: FontWeight.w800)),
        if (onTap != null) const Icon(Icons.chevron_right_rounded, color: C.maroon),
      ]),
    );
    if (onTap == null) return row;
    return Semantics(button: true, child: InkWell(onTap: onTap, child: row));
  }
}

/// Switch row in the teal card (keeps [SwitchListTile] so the switch, label and keys behave as before).
class SettingsSwitch extends StatelessWidget {
  const SettingsSwitch({super.key, required this.icon, required this.label, required this.value, required this.onChanged, this.last = false, this.switchKey});

  /// Put on the [SwitchListTile] itself (tests read its value by key).
  final Key? switchKey;
  final IconData icon;
  final String label;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final bool last;
  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
        child: SwitchListTile(
          key: switchKey,
          contentPadding: EdgeInsets.zero,
          secondary: DesiIconSquare(icon, tone: DesiTone.tea, size: 40),
          title: Text(label, style: t(16, w: FontWeight.w800)),
          value: value,
          activeThumbColor: C.white,
          activeTrackColor: C.rani,
          inactiveThumbColor: C.white,
          inactiveTrackColor: const Color(0xFFE8DDE6),
          trackOutlineColor: const WidgetStatePropertyAll(C.clear),
          onChanged: onChanged,
        ),
      );
}

/// Muted "write to support@…" line under a row.
class SettingsNote extends StatelessWidget {
  const SettingsNote({super.key, required this.lead, required this.email, this.onTap});
  final String lead;
  final String email;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(52, 0, 0, 8),
          child: Text.rich(TextSpan(style: t(14, color: C.muted, w: FontWeight.w700), children: [
            TextSpan(text: '$lead '),
            TextSpan(text: email, style: t(14, color: C.maroon, w: FontWeight.w800)),
            const TextSpan(text: '.'),
          ])),
        ),
      );
}

/// Plum-outlined pill (Sign out).
class OutlinePill extends StatelessWidget {
  const OutlinePill({super.key, required this.label, required this.onTap});
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.white,
          shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: SizedBox(height: 56, child: Center(child: Text(label, style: t(17, color: C.maroon, w: FontWeight.w900)))),
          ),
        ),
      );
}

/// One FAQ card: coloured number and border, tap to open the answer.
class FaqCard extends StatelessWidget {
  const FaqCard({super.key, required this.index, required this.question, required this.answer, this.initiallyOpen = false});
  final int index;
  final String question;
  final String answer;
  final bool initiallyOpen;
  @override
  Widget build(BuildContext context) {
    const inks = [C.rani, C.saffron, C.peacock, C.lav];
    const edges = [Color(0xFFF8C4D9), Color(0xFFF3DFB3), Color(0xFFB9E2E5), Color(0xFFDDD2FB)];
    final i = index % 4;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: edges[i], width: 2)),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: C.clear),
        child: ExpansionTile(
          initiallyExpanded: initiallyOpen,
          shape: const Border(),
          collapsedShape: const Border(),
          tilePadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
          iconColor: inks[i],
          collapsedIconColor: inks[i],
          leading: Container(
            width: 32,
            height: 32,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: inks[i], shape: BoxShape.circle),
            child: Text('${index + 1}', style: t(15, color: C.white, w: FontWeight.w900)),
          ),
          title: Text(question, style: t(16, w: FontWeight.w900)),
          childrenPadding: const EdgeInsets.fromLTRB(60, 0, 16, 14),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [Text(answer, style: t(15, w: FontWeight.w600, h: 1.45))],
        ),
      ),
    );
  }
}

/// Teal "Still stuck? Write to …" card.
class HelpMailCard extends StatelessWidget {
  const HelpMailCard({super.key, required this.lead, required this.email, required this.onTap});
  final String lead;
  final String email;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.clear,
          child: InkWell(
            borderRadius: BorderRadius.circular(22),
            onTap: onTap,
            child: Ink(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: const Color(0xFFB9E2E5), width: 1.5),
                gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.teatint]),
              ),
              child: Row(children: [
                Container(width: 42, height: 42, decoration: const BoxDecoration(color: C.peacock, shape: BoxShape.circle), child: const Icon(Icons.mail_rounded, color: C.white, size: 20)),
                const SizedBox(width: 12),
                Expanded(
                  child: Text.rich(TextSpan(style: t(15, color: C.muted, w: FontWeight.w700), children: [
                    TextSpan(text: '$lead '),
                    TextSpan(text: email, style: t(15, color: C.maroon, w: FontWeight.w800)),
                  ])),
                ),
              ]),
            ),
          ),
        ),
      );
}
