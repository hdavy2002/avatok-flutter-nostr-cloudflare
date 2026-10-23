import 'package:flutter/material.dart';

import '../../data/models/merch.dart';
import '../desi.dart';
import '../merch_canvas.dart';
import '../merch_designer/silhouettes.dart';
import '../merch_kit.dart';
import '../theme.dart';

/// [HF-MERCH-STUDIO-2] Step 2, "Product": category chips, a two-column grid of product cards (the product drawn in its first
/// colour), then the side, the colours (up to 8) and the sizes of the chosen product. The wizard owns the choices.
class MerchProductPick extends StatefulWidget {
  const MerchProductPick({
    super.key,
    required this.items,
    required this.item,
    required this.side,
    required this.colours,
    required this.sizes,
    required this.onItem,
    required this.onSide,
    required this.onColour,
    required this.onSize,
  });

  final List<CatalogItem> items;
  final CatalogItem? item;
  final String side;
  final Set<String> colours;
  final Set<String> sizes;
  final ValueChanged<CatalogItem> onItem;
  final ValueChanged<String> onSide;
  final ValueChanged<String> onColour;
  final ValueChanged<String> onSize;

  @override
  State<MerchProductPick> createState() => _MerchProductPickState();
}

class _MerchProductPickState extends State<MerchProductPick> {
  String _category = 'all';
  final ScrollController _scroll = ScrollController();
  final GlobalKey _optionsKey = GlobalKey();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant MerchProductPick old) {
    super.didUpdateWidget(old);
    final now = widget.item?.id;
    if (now != null && now != old.item?.id) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final ctx = _optionsKey.currentContext;
        if (!mounted || ctx == null) return;
        Scrollable.ensureVisible(ctx, duration: const Duration(milliseconds: 350), curve: Curves.easeOutCubic, alignment: 0.02);
      });
    }
  }

  /// Category slug -> label, in the order the catalogue lists them.
  Map<String, String> get _categories {
    final out = <String, String>{};
    for (final i in widget.items) {
      out.putIfAbsent(i.category, () => i.categoryLabel);
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final cats = _categories;
    final shown = _category == 'all' || !cats.containsKey(_category) ? widget.items : [for (final i in widget.items) if (i.category == _category) i];
    final it = widget.item;
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      children: [
        Text('What do you want to sell your art on?', style: t(18, color: C.maroon)),
        const SizedBox(height: 10),
        if (cats.length > 1)
          SizedBox(
            height: 52,
            child: ListView(scrollDirection: Axis.horizontal, children: [
              MerchPill(label: 'All', selected: _category == 'all', onTap: () => setState(() => _category = 'all')),
              for (final e in cats.entries) ...[
                const SizedBox(width: 8),
                MerchPill(label: e.value, selected: _category == e.key, onTap: () => setState(() => _category = e.key)),
              ],
            ]),
          ),
        const SizedBox(height: 10),
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: shown.length,
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2, mainAxisSpacing: 12, crossAxisSpacing: 12, mainAxisExtent: 296),
          itemBuilder: (context, i) => _ProductCard(item: shown[i], selected: it?.id == shown[i].id, onTap: () => widget.onItem(shown[i])),
        ),
        if (it != null) ...[
          const SizedBox(height: 18),
          KeyedSubtree(key: _optionsKey, child: _options(it)),
        ],
      ],
    );
  }

  Widget _options(CatalogItem it) {
    String? firstHex;
    for (final c in it.colours) {
      if (widget.colours.contains(c.name)) {
        firstHex = c.hex;
        break;
      }
    }
    firstHex ??= it.colours.isEmpty ? '#cccccc' : it.colours.first.hex;
    return DesiCard(
      tone: DesiTone.lav,
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            width: 92,
            height: 92,
            decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(22)),
            alignment: Alignment.center,
            child: ProductSilhouette(family: it.family, colour: colourFromHex(firstHex), size: 76, side: widget.side),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('You picked', style: t(14, color: C.muted, w: FontWeight.w700)),
              Text(it.name, style: t(20, color: C.maroon)),
            ]),
          ),
        ]),
        if (it.sides.length == 2) ...[
          const SizedBox(height: 16),
          Text('Which side gets your art?', style: t(16, color: C.maroon)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            MerchPill(label: 'Front', selected: widget.side == 'front', onTap: () => widget.onSide('front')),
            MerchPill(label: 'Back', selected: widget.side == 'back', onTap: () => widget.onSide('back')),
          ]),
        ],
        const SizedBox(height: 16),
        Text('Colours you will sell', style: t(16, color: C.maroon)),
        Text('Pick up to 8 · ${widget.colours.length} picked', style: t(14, color: C.muted, w: FontWeight.w700)),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 10, children: [
          for (final c in it.colours) MerchSwatch(colour: c, fill: merchColour(c.hex), selected: widget.colours.contains(c.name), onTap: () => widget.onColour(c.name)),
        ]),
        const SizedBox(height: 16),
        Text('Sizes', style: t(16, color: C.maroon)),
        Text('Base price for each size, before your markup', style: t(14, color: C.muted, w: FontWeight.w700)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final s in it.sizes) _SizeChip(size: s, selected: widget.sizes.contains(s.size), onTap: () => widget.onSize(s.size)),
        ]),
      ]),
    );
  }
}

class _ProductCard extends StatelessWidget {
  const _ProductCard({required this.item, required this.selected, required this.onTap});

  final CatalogItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final hex = item.colours.isEmpty ? '#cccccc' : item.colours.first.hex;
    return Semantics(
      button: true,
      selected: selected,
      label: item.name,
      child: Material(
        color: C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24), side: BorderSide(color: selected ? C.rani : C.line, width: selected ? 3 : 1.5)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.lavtint, C.blush]),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  alignment: Alignment.center,
                  child: LayoutBuilder(
                    builder: (context, c) {
                      final s = (c.maxWidth < c.maxHeight ? c.maxWidth : c.maxHeight) * 0.86;
                      return Stack(alignment: Alignment.center, children: [
                        ProductSilhouette(family: item.family, colour: colourFromHex(hex), size: s),
                        if (selected)
                          Positioned(
                            right: 6,
                            top: 6,
                            child: Container(
                              width: 26,
                              height: 26,
                              decoration: const BoxDecoration(shape: BoxShape.circle, color: C.rani),
                              child: const Icon(Icons.check_rounded, size: 18, color: C.white),
                            ),
                          ),
                      ]);
                    },
                  ),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(height: 38, child: Text(item.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(15, h: 1.2))),
              Text(item.fromPaise > 0 ? 'from ${merchRupees(item.fromPaise)}' : 'Price on the last step', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, color: C.rani)),
              Text('incl. printing, GST & delivery', maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w600, h: 1.1)),
              const SizedBox(height: 6),
              Row(children: [
                for (final c in item.colours.take(6))
                  Container(
                    width: 16,
                    height: 16,
                    margin: const EdgeInsets.only(right: 4),
                    decoration: BoxDecoration(shape: BoxShape.circle, color: merchColour(c.hex), border: Border.all(color: C.brass)),
                  ),
                if (item.colours.length > 6) Text('+${item.colours.length - 6}', style: t(14, color: C.muted)),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}

class _SizeChip extends StatelessWidget {
  const _SizeChip({required this.size, required this.selected, required this.onTap});

  final CatalogSize size;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: 'Size ${size.size}',
      child: Material(
        color: selected ? C.maroon : C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: selected ? C.maroon : C.line, width: 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minWidth: 72, minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            alignment: Alignment.center,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(size.size, style: t(16, color: selected ? C.white : C.maroon)),
              if (size.basePaise > 0) Text(merchRupees(size.basePaise), style: t(14, color: selected ? C.gold : C.muted, w: FontWeight.w700)),
            ]),
          ),
        ),
      ),
    );
  }
}
