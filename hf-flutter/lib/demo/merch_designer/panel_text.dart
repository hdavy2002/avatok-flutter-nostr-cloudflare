import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';
import 'contract.dart';
import 'fonts.dart';
import 'panels.dart';
import 'silhouettes.dart';

/// [HF-MERCH-STUDIO-2] The Text tool: add words, then change the words, font (each shown in itself, "हिंदी" badge on the fonts that
/// draw Hindi), size, colour, outline, shadow, spacing and alignment. Never green.

const List<String> kStudioPalette = <String>[
  '#ffffff', '#fff1d6', '#fbbf24', '#f59e0b', '#ea6a12', '#e4572e', '#c8102e', '#d81b72', '#f8c8dc',
  '#7a1f3d', '#4a1747', '#6d4fd0', '#3d2c8d', '#1a237e', '#0e7c86', '#8b5e34', '#c9a227', '#111111',
];

final RegExp _hex6 = RegExp(r'^#?[0-9a-fA-F]{6}$');

Future<String?> _askHex(BuildContext context, String initial) {
  final ctl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Pick your own colour'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Type a colour code like #D81B72', style: t(15, color: C.muted, w: FontWeight.w600)),
        const SizedBox(height: 10),
        TextField(controller: ctl, autofocus: true, maxLength: 7, style: t(18, w: FontWeight.w700)),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: t(16, color: C.muted))),
        TextButton(
          onPressed: () {
            final v = ctl.text.trim();
            Navigator.pop(ctx, _hex6.hasMatch(v) ? '#${v.replaceAll('#', '').toLowerCase()}' : null);
          },
          child: Text('OK', style: t(16, color: C.maroon)),
        ),
      ],
    ),
  );
}

class TextPanel extends StatefulWidget {
  const TextPanel({super.key, required this.host});
  final StudioHost host;

  @override
  State<TextPanel> createState() => _TextPanelState();
}

class _TextPanelState extends State<TextPanel> {
  final TextEditingController _ctl = TextEditingController();
  String? _forId;

  @override
  void initState() {
    super.initState();
    for (final f in kMerchFonts) {
      if (!MerchFonts.isLoaded(f.family)) MerchFonts.loadQuiet(f.family);
    }
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  void _edit(TextDesignLayer l, void Function(TextDesignLayer t) f, {String? key}) {
    widget.host.mutate(l.id, (x) {
      if (x is TextDesignLayer) f(x);
    }, key: key);
  }

  @override
  Widget build(BuildContext context) {
    final host = widget.host;
    final sel = host.selected;
    if (sel is! TextDesignLayer) {
      return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
        const PanelLabel('Add words'),
        toolGrid(context, [
          BigToolButton(icon: Icons.text_fields_rounded, label: 'Add text', onTap: () => host.addText()),
          BigToolButton(icon: Icons.translate_rounded, label: 'Add Hindi text', onTap: () => host.addText(hindi: true)),
        ]),
        const PanelNote('Or tap words on the product to change them.'),
      ]);
    }
    final l = sel;
    if (_forId != l.id || _ctl.text != l.text) {
      _ctl.value = TextEditingValue(text: l.text, selection: TextSelection.collapsed(offset: l.text.length));
      _forId = l.id;
    }
    final maxSize = math.max(2.0, math.min(14.0, math.max(host.areaW, host.areaH)));
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
      TextField(
        controller: _ctl,
        minLines: 1,
        maxLines: 3,
        keyboardType: TextInputType.multiline,
        style: t(18, w: FontWeight.w700),
        decoration: const InputDecoration(hintText: 'Type your words'),
        onChanged: (v) => _edit(l, (x) => x.text = v, key: 'text:${l.id}'),
      ),
      const PanelLabel('Font'),
      SizedBox(
        height: 72,
        child: ValueListenableBuilder<int>(
          valueListenable: MerchFonts.changes,
          builder: (context, _, __) => ListView(scrollDirection: Axis.horizontal, children: [
            for (final f in kMerchFonts) _FontChip(font: f, selected: l.font == f.family, onTap: () => _edit(l, (x) => x.font = f.family)),
          ]),
        ),
      ),
      const SizedBox(height: 6),
      StudioSlider(
        label: 'Size',
        valueText: '${l.sizeIn.toStringAsFixed(1)} in',
        value: l.sizeIn,
        min: 0.2,
        max: maxSize,
        onChanged: (v) => _edit(l, (x) => x.sizeIn = v, key: 'size:${l.id}'),
      ),
      const PanelLabel('Colour'),
      _swatches(l.fill, (hex) => _edit(l, (x) => x.fill = hex ?? x.fill), allowNone: false),
      const PanelLabel('Outline'),
      _swatches(l.stroke, (hex) => _edit(l, (x) {
            x.stroke = hex;
            if (hex != null && x.strokeIn < 0.02) x.strokeIn = 0.04;
          }), allowNone: true),
      if (l.stroke != null)
        StudioSlider(
          label: 'Outline width',
          valueText: l.strokeIn.toStringAsFixed(2),
          value: l.strokeIn,
          min: 0.01,
          max: 0.25,
          onChanged: (v) => _edit(l, (x) => x.strokeIn = v, key: 'stroke:${l.id}'),
        ),
      const SizedBox(height: 6),
      _SwitchRow(label: 'Shadow', value: l.shadow, onChanged: (v) => _edit(l, (x) => x.shadow = v)),
      StudioSlider(
        label: 'Space between letters',
        valueText: l.letterSpacing.toStringAsFixed(2),
        value: l.letterSpacing,
        min: -0.1,
        max: 0.8,
        onChanged: (v) => _edit(l, (x) => x.letterSpacing = v, key: 'ls:${l.id}'),
      ),
      StudioSlider(
        label: 'Space between lines',
        valueText: l.lineHeight.toStringAsFixed(2),
        value: l.lineHeight,
        min: 0.8,
        max: 2.0,
        onChanged: (v) => _edit(l, (x) => x.lineHeight = v, key: 'lh:${l.id}'),
      ),
      const PanelLabel('Line up'),
      Row(children: [
        for (final a in const <(String, IconData)>[('left', Icons.format_align_left_rounded), ('center', Icons.format_align_center_rounded), ('right', Icons.format_align_right_rounded)])
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: BigToolButton(icon: a.$2, label: a.$1 == 'left' ? 'Left' : (a.$1 == 'right' ? 'Right' : 'Middle'), on: l.align == a.$1, onTap: () => _edit(l, (x) => x.align = a.$1)),
            ),
          ),
      ]),
      const PanelLabel('See-through'),
      StudioSlider(
        label: 'Opacity',
        valueText: '${(l.opacity * 100).round()}%',
        value: l.opacity,
        min: 0.1,
        max: 1,
        onChanged: (v) => _edit(l, (x) => x.opacity = v, key: 'opacity:${l.id}'),
      ),
      const PanelLabel('Flip and turn'),
      toolGrid(context, [
        BigToolButton(icon: Icons.flip_rounded, label: 'Flip left-right', on: l.flipX, onTap: () => _edit(l, (x) => x.flipX = !x.flipX)),
        BigToolButton(icon: Icons.swap_vert_rounded, label: 'Flip up-down', on: l.flipY, onTap: () => _edit(l, (x) => x.flipY = !x.flipY)),
        BigToolButton(icon: Icons.rotate_90_degrees_cw_outlined, label: 'Turn 90°', onTap: () => _edit(l, (x) => x.rotation = (((x.rotation / 90).round() * 90 + 90) % 360).toDouble())),
      ]),
    ]);
  }

  /// A row of colours. [current] null means none (only for the outline).
  Widget _swatches(String? current, void Function(String?) pick, {required bool allowNone}) {
    final cur = current?.toLowerCase();
    final inPalette = cur != null && kStudioPalette.any((p) => p.toLowerCase() == cur);
    return SizedBox(
      height: 52,
      child: ListView(scrollDirection: Axis.horizontal, children: [
        if (allowNone) ColourDot(colour: C.white, none: true, selected: current == null, label: 'No outline', onTap: () => pick(null)),
        for (final hex in kStudioPalette)
          ColourDot(colour: colourFromHex(hex), selected: cur == hex.toLowerCase(), label: hex, onTap: () => pick(hex.toLowerCase())),
        if (cur != null && !inPalette) ColourDot(colour: colourFromHex(cur), selected: true, label: cur, onTap: () => pick(cur)),
        Semantics(
          button: true,
          label: 'Your own colour',
          child: InkResponse(
            radius: 26,
            onTap: () async {
              final hex = await _askHex(context, cur ?? '#');
              if (hex != null) pick(hex);
            },
            child: const SizedBox(width: 48, height: 48, child: Center(child: Icon(Icons.colorize_rounded, size: 26, color: C.maroon))),
          ),
        ),
      ]),
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({required this.label, required this.value, required this.onChanged});
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 52,
        child: Row(children: [
          Expanded(child: Text(label, style: t(15, color: C.deep))),
          Switch(value: value, onChanged: onChanged),
        ]),
      );
}

class _FontChip extends StatelessWidget {
  const _FontChip({required this.font, required this.selected, required this.onTap});
  final MerchFont font;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final loaded = MerchFonts.isLoaded(font.family);
    final failed = MerchFonts.hasFailed(font.family);
    final ink = selected ? C.maroon : C.deep;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Semantics(
        button: true,
        selected: selected,
        label: font.label,
        child: Material(
          color: selected ? C.lavtint : C.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: selected ? C.maroon : C.line, width: selected ? 2.5 : 1.5)),
          child: InkWell(
            customBorder: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
            onTap: failed ? () => MerchFonts.loadQuiet(font.family) : onTap,
            child: SizedBox(
              width: 168,
              height: 72,
              child: Stack(alignment: Alignment.center, children: [
                if (loaded)
                  Padding(
                    padding: const EdgeInsets.only(top: 14, left: 8, right: 8),
                    child: Text(font.sample, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontFamily: font.flutterFamily, fontSize: 22, color: ink, height: 1.2)),
                  )
                else if (failed)
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.refresh_rounded, size: 20, color: C.muted),
                    const SizedBox(width: 6),
                    Text('Try again', style: t(15, color: C.muted)),
                  ])
                else
                  const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3, color: C.maroon)),
                if (font.devanagari)
                  Positioned(
                    top: 4,
                    right: 8,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                      decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(10)),
                      child: Text('हिंदी', style: t(14, color: C.amber, h: 1.2)),
                    ),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
