import 'package:flutter/material.dart';

import '../desi.dart';
import '../theme.dart';
import 'contract.dart';

/// [HF-MERCH-STUDIO-2] The tool panels of the studio (Pictures, Edit picture, Arrange, Layers) and the small widgets they share.
/// The Text panel is in panel_text.dart. Panels never hold design state: they read it from the [StudioHost] (the designer) and ask
/// it to change things, so undo and the stage always agree.

abstract class StudioHost {
  /// Bottom to top.
  List<DesignLayer> get layers;
  DesignLayer? get selected;
  List<StudioArt> get arts;
  double get areaW;
  double get areaH;

  /// Background removal or erasing is running (a sentence like "Removing the background...") or null.
  String? get editStatus;

  /// A plain-words problem from the last edit, or null.
  String? get editMessage;
  String? get eraseLayerId;
  double get eraseTolerance;

  /// Soft edge of the erase, 0 to 6 pixels.
  double get eraseSoftEdge;
  bool get eraseHasPreview;

  void select(String? id);
  void addArt(StudioArt a);
  void wantMoreArt();
  void addText({bool hindi = false});

  /// Changes a layer in place and records an undo step. Changes with the same [key] close together become one step.
  void mutate(String id, void Function(DesignLayer l) change, {String? key});
  void removeLayer(String id);
  void duplicateLayer(String id);

  /// +1 one step forward, -1 one step back, 1000 to the front, -1000 to the back.
  void moveLayer(String id, int delta);

  /// Indices in [layers].
  void reorderLayers(int from, int to);

  /// 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' (relative to the print area, turned box)
  void alignLayer(String id, String how);

  /// Picture only. [fill] false: biggest size inside the print area. true: covers the print area. Centred.
  void fitLayer(String id, {required bool fill});
  Future<void> removeBackground(ImageDesignLayer l);
  void startErase(ImageDesignLayer l);
  void setEraseTolerance(double v);
  void setEraseSoftEdge(double v);
  void runErase();
  Future<void> keepErase();
  void cancelErase();
}

/// Print quality words, same rules as the web studio (studioGeometry.ts dpiQuality): 300 and up Sharp, 200 Good, 150 OK, below 150
/// too blurry to print (blocks "Looks good").
({String text, Color bg, Color fg, bool blocks}) studioDpiQuality(double dpi) {
  if (dpi >= 300) return (text: 'Sharp', bg: C.lavtint, fg: C.maroon, blocks: false);
  if (dpi >= 200) return (text: 'Good', bg: C.goldtint, fg: C.amber, blocks: false);
  if (dpi >= 150) return (text: 'OK, slightly soft', bg: C.blush, fg: C.tan, blocks: false);
  return (text: 'Too blurry', bg: C.blush, fg: C.ruby, blocks: true);
}

// ---------------------------------------------------------------------------------------------- shared widgets

class PanelLabel extends StatelessWidget {
  const PanelLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.only(top: 10, bottom: 6), child: Text(text, style: t(15, color: C.maroon)));
}

class PanelNote extends StatelessWidget {
  const PanelNote(this.text, {super.key, this.bad = false});
  final String text;
  final bool bad;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(text, style: t(15, color: bad ? C.ruby : C.muted, w: FontWeight.w600, h: 1.35)),
      );
}

/// A big rounded button: icon over label.
class BigToolButton extends StatelessWidget {
  const BigToolButton({super.key, required this.icon, required this.label, required this.onTap, this.danger = false, this.on = false});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool danger;
  final bool on;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    final ink = !enabled ? C.muted : (danger ? C.ruby : C.maroon);
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: Material(
        color: on ? C.lavtint : C.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: BorderSide(color: on ? C.maroon : C.line, width: on ? 2 : 1.5),
        ),
        child: InkWell(
          customBorder: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 72),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(icon, size: 26, color: ink),
              const SizedBox(height: 4),
              Text(label, textAlign: TextAlign.center, style: t(15, color: ink, h: 1.15)),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Lays buttons out three to a row.
Widget toolGrid(BuildContext context, List<Widget> kids) {
  final w = (MediaQuery.sizeOf(context).width - 32 - 20) / 3;
  return Wrap(spacing: 10, runSpacing: 10, children: [for (final k in kids) SizedBox(width: w, child: k)]);
}

class StudioSlider extends StatelessWidget {
  const StudioSlider({super.key, required this.label, required this.valueText, required this.value, required this.min, required this.max, required this.onChanged, this.onChangeEnd});
  final String label;
  final String valueText;
  final double value;
  final double min;
  final double max;
  final ValueChanged<double> onChanged;
  final ValueChanged<double>? onChangeEnd;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Text(label, style: t(15, color: C.deep))),
        Text(valueText, style: t(15, color: C.muted, w: FontWeight.w700)),
      ]),
      SliderTheme(
        data: SliderTheme.of(context).copyWith(
          activeTrackColor: C.maroon,
          inactiveTrackColor: C.brass,
          thumbColor: C.maroon,
          overlayColor: C.maroon.withValues(alpha: 0.15),
          trackHeight: 5,
          thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 12),
        ),
        child: SizedBox(
          height: 44,
          child: Slider(value: value < min ? min : (value > max ? max : value), min: min, max: max, onChanged: onChanged, onChangeEnd: onChangeEnd),
        ),
      ),
    ]);
  }
}

/// One colour circle (48 px to tap).
class ColourDot extends StatelessWidget {
  const ColourDot({super.key, required this.colour, required this.selected, required this.onTap, this.none = false, this.label});
  final Color colour;
  final bool selected;
  final VoidCallback onTap;
  final bool none;
  final String? label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: label ?? 'Colour',
      child: InkResponse(
        onTap: onTap,
        radius: 26,
        child: SizedBox(
          width: 48,
          height: 48,
          child: Center(
            child: Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: none ? C.white : colour,
                shape: BoxShape.circle,
                border: Border.all(color: selected ? C.rani : C.brass, width: selected ? 3.5 : 1.5),
              ),
              child: none ? const Icon(Icons.block_rounded, size: 22, color: C.muted) : null,
            ),
          ),
        ),
      ),
    );
  }
}

Future<String?> askText(BuildContext context, {required String title, required String initial, int maxLength = 40}) {
  final ctl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: ctl, autofocus: true, maxLength: maxLength, style: t(17, w: FontWeight.w600)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: t(16, color: C.muted))),
        TextButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: Text('OK', style: t(16, color: C.maroon))),
      ],
    ),
  );
}

// ---------------------------------------------------------------------------------------------- Pictures

class PicturesPanel extends StatelessWidget {
  const PicturesPanel({super.key, required this.host});
  final StudioHost host;

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
      const PanelLabel('Your pictures'),
      SizedBox(
        height: 108,
        child: ListView(scrollDirection: Axis.horizontal, children: [
          _AddTile(onTap: host.wantMoreArt),
          for (final a in host.arts) _ArtTile(art: a, onTap: () => host.addArt(a)),
        ]),
      ),
      const PanelNote('Tap a picture to put it on the product. Use "Add picture" to bring a new one or make one with AI.'),
    ]);
  }
}

class _AddTile extends StatelessWidget {
  const _AddTile({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 10),
      child: Semantics(
        button: true,
        label: 'Add picture',
        child: Material(
          color: C.blush,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: const BorderSide(color: C.rani, width: 2)),
          child: InkWell(
            customBorder: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            onTap: onTap,
            child: SizedBox(
              width: 100,
              height: 108,
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                const Icon(Icons.add_photo_alternate_outlined, size: 32, color: C.rani),
                const SizedBox(height: 6),
                Text('Add picture', textAlign: TextAlign.center, style: t(15, color: C.maroon)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _ArtTile extends StatelessWidget {
  const _ArtTile({required this.art, required this.onTap});
  final StudioArt art;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bytes = art.bytes;
    const broken = Icon(Icons.broken_image_outlined, color: C.muted);
    return Padding(
      padding: const EdgeInsets.only(right: 10),
      child: Semantics(
        button: true,
        label: art.label ?? 'Picture',
        child: Material(
          color: C.lavtint,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: const BorderSide(color: C.line, width: 1.5)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: SizedBox(
              width: 108,
              height: 108,
              child: Padding(
                padding: const EdgeInsets.all(6),
                child: bytes != null && bytes.isNotEmpty
                    ? Image.memory(bytes, fit: BoxFit.contain, cacheWidth: 260, errorBuilder: (c, e, s) => broken)
                    : Image.network(art.art.url, fit: BoxFit.contain, cacheWidth: 260, errorBuilder: (c, e, s) => broken),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Edit picture

class EditPanel extends StatelessWidget {
  const EditPanel({super.key, required this.host});
  final StudioHost host;

  @override
  Widget build(BuildContext context) {
    final sel = host.selected;
    if (sel is! ImageDesignLayer) {
      return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 16), children: [
        PanelNote(sel is TextDesignLayer ? 'Words are changed in the Text tab.' : 'Tap a picture on the product to edit it.'),
      ]);
    }
    final l = sel;
    final erasing = host.eraseLayerId == l.id;
    final status = host.editStatus;
    final q = studioDpiQuality(l.dpi);
    return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
      const SizedBox(height: 8),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: q.bg, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.line, width: 1.5)),
        child: Text('${q.text} · ${l.dpi.round()} DPI · prints ${l.w.toStringAsFixed(1)} × ${l.h.toStringAsFixed(1)} in', style: t(15, color: q.fg, w: FontWeight.w700, h: 1.3)),
      ),
      const PanelLabel('Background'),
      if (status != null)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(children: [
            const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3, color: C.maroon)),
            const SizedBox(width: 12),
            Expanded(child: Text(status, style: t(16, color: C.deep, w: FontWeight.w700))),
          ]),
        )
      else
        toolGrid(context, [
          BigToolButton(icon: Icons.auto_fix_high_rounded, label: 'Remove background', onTap: () => host.removeBackground(l)),
          BigToolButton(icon: Icons.format_color_reset_outlined, label: 'Erase plain colour', on: erasing, onTap: () => host.startErase(l)),
        ]),
      if (host.editMessage != null) PanelNote(host.editMessage!, bad: true),
      if (erasing && status == null) ...[
        const PanelNote('Slide to the right to erase more of the plain colour around your picture.'),
        StudioSlider(
          label: 'How much',
          valueText: '${host.eraseTolerance.round()}',
          value: host.eraseTolerance,
          min: 1,
          max: 100,
          onChanged: host.setEraseTolerance,
          onChangeEnd: (_) => host.runErase(),
        ),
        StudioSlider(
          label: 'Soft edge',
          valueText: '${host.eraseSoftEdge.round()} px',
          value: host.eraseSoftEdge,
          min: 0,
          max: 6,
          onChanged: host.setEraseSoftEdge,
          onChangeEnd: (_) => host.runErase(),
        ),
        const SizedBox(height: 6),
        Row(children: [
          Expanded(child: DesiButton('Keep this', icon: Icons.check_rounded, kind: DesiButtonKind.gold, onTap: host.eraseHasPreview ? host.keepErase : null)),
          const SizedBox(width: 10),
          Expanded(child: DesiButton('Cancel', kind: DesiButtonKind.ghost, onTap: host.cancelErase)),
        ]),
      ],
      const PanelLabel('Flip and turn'),
      toolGrid(context, [
        BigToolButton(icon: Icons.flip_rounded, label: 'Flip left-right', on: l.flipX, onTap: () => host.mutate(l.id, (x) => x.flipX = !x.flipX)),
        BigToolButton(icon: Icons.swap_vert_rounded, label: 'Flip up-down', on: l.flipY, onTap: () => host.mutate(l.id, (x) => x.flipY = !x.flipY)),
        BigToolButton(icon: Icons.rotate_90_degrees_cw_outlined, label: 'Turn 90°', onTap: () => host.mutate(l.id, (x) => x.rotation = (x.rotation + 90) % 360)),
      ]),
      const PanelLabel('See-through'),
      StudioSlider(
        label: 'Opacity',
        valueText: '${(l.opacity * 100).round()}%',
        value: l.opacity,
        min: 0.1,
        max: 1,
        onChanged: (v) => host.mutate(l.id, (x) => x.opacity = v, key: 'opacity:${l.id}'),
      ),
      const PanelLabel('Size'),
      toolGrid(context, [
        BigToolButton(icon: Icons.fit_screen_rounded, label: 'Fit to box', onTap: () => host.fitLayer(l.id, fill: false)),
        BigToolButton(icon: Icons.crop_free_rounded, label: 'Fill the box', onTap: () => host.fitLayer(l.id, fill: true)),
      ]),
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- Arrange

class ArrangePanel extends StatelessWidget {
  const ArrangePanel({super.key, required this.host});
  final StudioHost host;

  @override
  Widget build(BuildContext context) {
    final l = host.selected;
    if (l == null) {
      return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 16), children: const [PanelNote('Tap something on the product first, then arrange it here.')]);
    }
    return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
      const PanelLabel('Place'),
      toolGrid(context, [
        BigToolButton(icon: Icons.align_horizontal_left_rounded, label: 'Left', onTap: () => host.alignLayer(l.id, 'left')),
        BigToolButton(icon: Icons.align_horizontal_center_rounded, label: 'Centre across', onTap: () => host.alignLayer(l.id, 'centerH')),
        BigToolButton(icon: Icons.align_horizontal_right_rounded, label: 'Right', onTap: () => host.alignLayer(l.id, 'right')),
        BigToolButton(icon: Icons.vertical_align_top_rounded, label: 'Top', onTap: () => host.alignLayer(l.id, 'top')),
        BigToolButton(icon: Icons.align_vertical_center_rounded, label: 'Centre up-down', onTap: () => host.alignLayer(l.id, 'centerV')),
        BigToolButton(icon: Icons.vertical_align_bottom_rounded, label: 'Bottom', onTap: () => host.alignLayer(l.id, 'bottom')),
      ]),
      const PanelLabel('Order'),
      toolGrid(context, [
        BigToolButton(icon: Icons.flip_to_front_rounded, label: 'Bring forward', onTap: () => host.moveLayer(l.id, 1)),
        BigToolButton(icon: Icons.flip_to_back_rounded, label: 'Send back', onTap: () => host.moveLayer(l.id, -1)),
        BigToolButton(icon: Icons.content_copy_rounded, label: 'Make a copy', onTap: () => host.duplicateLayer(l.id)),
        BigToolButton(icon: Icons.vertical_align_top_rounded, label: 'To front', onTap: () => host.moveLayer(l.id, 1000)),
        BigToolButton(icon: Icons.vertical_align_bottom_rounded, label: 'To back', onTap: () => host.moveLayer(l.id, -1000)),
      ]),
      const PanelLabel('Keep or remove'),
      toolGrid(context, [
        BigToolButton(
          icon: l.locked ? Icons.lock_open_rounded : Icons.lock_outline_rounded,
          label: l.locked ? 'Unlock' : 'Lock',
          onTap: () => host.mutate(l.id, (x) => x.locked = !x.locked),
        ),
        BigToolButton(
          icon: l.visible ? Icons.visibility_off_outlined : Icons.visibility_outlined,
          label: l.visible ? 'Hide' : 'Show',
          onTap: () => host.mutate(l.id, (x) => x.visible = !x.visible),
        ),
        BigToolButton(icon: Icons.delete_outline_rounded, label: 'Delete', danger: true, onTap: () => host.removeLayer(l.id)),
      ]),
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- Layers

class LayersPanel extends StatelessWidget {
  const LayersPanel({super.key, required this.host});
  final StudioHost host;

  @override
  Widget build(BuildContext context) {
    final layers = host.layers;
    final n = layers.length;
    if (n == 0) {
      return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 16), children: const [PanelNote('Nothing here yet. Add a picture or some text first.')]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: PanelLabel('Top one first. Use the arrows to change the order, or press and hold a row and drag. Tap a row for rename, lock and delete.')),
      Expanded(
        child: ReorderableListView.builder(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          itemCount: n,
          buildDefaultDragHandles: true,
          onReorder: (oldI, newI) {
            var to = newI;
            if (to > oldI) to -= 1;
            host.reorderLayers(n - 1 - oldI, n - 1 - to);
          },
          itemBuilder: (context, i) {
            final l = layers[n - 1 - i];
            return _LayerRow(key: ValueKey<String>(l.id), layer: l, host: host, canUp: i > 0, canDown: i < n - 1);
          },
        ),
      ),
    ]);
  }
}

class _LayerRow extends StatelessWidget {
  const _LayerRow({super.key, required this.layer, required this.host, required this.canUp, required this.canDown});
  final DesignLayer layer;
  final StudioHost host;

  /// False for the top layer (it cannot go further up) and the bottom layer.
  final bool canUp;
  final bool canDown;

  Widget _icon(IconData icon, String label, VoidCallback? onTap, {Color color = C.maroon}) => IconButton(
        tooltip: label,
        onPressed: onTap,
        icon: Icon(icon, size: 24, color: onTap == null ? C.brass : color),
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints.tightFor(width: 48, height: 48),
      );

  Widget _thumb() {
    final l = layer;
    final dim = !l.visible;
    Widget inner;
    if (l is ImageDesignLayer) {
      const broken = Icon(Icons.broken_image_outlined, size: 20, color: C.muted);
      StudioArt? found;
      for (final a in host.arts) {
        if (a.artId == l.artId) {
          found = a;
          break;
        }
      }
      final bytes = found?.bytes;
      inner = bytes != null && bytes.isNotEmpty
          ? Image.memory(bytes, fit: BoxFit.contain, cacheWidth: 96, errorBuilder: (c, e, s) => broken)
          : Image.network(l.url, fit: BoxFit.contain, cacheWidth: 96, errorBuilder: (c, e, s) => broken);
    } else {
      inner = Center(child: Text('T', style: t(20, color: C.maroon, w: FontWeight.w800)));
    }
    return Opacity(
      opacity: dim ? 0.45 : 1,
      child: Container(
        width: 40,
        height: 40,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(10), border: Border.all(color: C.line, width: 1.5)),
        child: Padding(padding: EdgeInsets.all(l is ImageDesignLayer ? 3 : 0), child: inner),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = layer;
    final on = host.selected?.id == l.id;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      decoration: BoxDecoration(
        color: on ? C.lavtint : C.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: on ? C.maroon : C.line, width: on ? 2 : 1.5),
      ),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        SizedBox(
          height: 56,
          child: Row(children: [
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: () => host.select(l.id),
                child: Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Row(children: [
                    _thumb(),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(l.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(15, color: l.visible ? C.deep : C.muted, w: FontWeight.w700)),
                    ),
                  ]),
                ),
              ),
            ),
            _icon(Icons.arrow_upward_rounded, 'Move up', canUp ? () => host.moveLayer(l.id, 1) : null),
            _icon(Icons.arrow_downward_rounded, 'Move down', canDown ? () => host.moveLayer(l.id, -1) : null),
            _icon(l.visible ? Icons.visibility_outlined : Icons.visibility_off_outlined, l.visible ? 'Hide' : 'Show', () => host.mutate(l.id, (x) => x.visible = !x.visible)),
          ]),
        ),
        if (on)
          SizedBox(
            height: 48,
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              _icon(Icons.edit_outlined, 'Rename', () async {
                final name = await askText(context, title: 'Name this layer', initial: l.name);
                if (name != null && name.isNotEmpty) host.mutate(l.id, (x) => x.name = name);
              }),
              _icon(l.locked ? Icons.lock_outline_rounded : Icons.lock_open_rounded, l.locked ? 'Unlock' : 'Lock', () => host.mutate(l.id, (x) => x.locked = !x.locked),
                  color: l.locked ? C.rani : C.maroon),
              _icon(Icons.delete_outline_rounded, 'Delete', () => host.removeLayer(l.id), color: C.ruby),
            ]),
          ),
      ]),
    );
  }
}
