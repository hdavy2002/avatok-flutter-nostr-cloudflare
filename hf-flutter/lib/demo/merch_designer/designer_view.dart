part of 'designer.dart';

/// [HF-MERCH-STUDIO-2] The studio's screen pieces (top bar, chips, stage area, tool panel, colour row, tool bar). Kept apart from the
/// state class to keep both files readable; they read and change the same state.
extension _DesignerView on _MerchDesignerState {
  Widget _topBar() {
    final c = _colour;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
      child: Row(children: [
        StudioRoundButton(icon: Icons.arrow_back_rounded, label: 'Back', onTap: _busy == null ? widget.onBack : null),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(widget.item.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(17)),
              Text('${widget.side == 'back' ? 'Back' : 'Front'} print${c == null ? '' : ' · ${c.name}'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w600)),
            ]),
          ),
        ),
        StudioRoundButton(icon: Icons.undo_rounded, label: 'Undo', onTap: _hist.canUndo && _busy == null ? _undo : null),
        StudioRoundButton(icon: Icons.redo_rounded, label: 'Redo', onTap: _hist.canRedo && _busy == null ? _redo : null),
        StudioRoundButton(
          icon: _zoomK > 1.001 ? Icons.zoom_out_map_rounded : Icons.zoom_in_rounded,
          label: _zoomK > 1.001 ? 'Show the whole product' : 'Zoom to the print box',
          on: _zoomK > 1.001,
          onTap: () {
            if (_zoomK > 1.001) {
              _setZoom(1);
            } else {
              _zoomPrintBox();
            }
          },
        ),
      ]),
    );
  }

  Widget _chips(Rect? bounds) {
    final images = _visibleImages;
    final sel = selected;
    ImageDesignLayer? shown = sel is ImageDesignLayer ? sel : null;
    if (shown == null) {
      for (final l in images) {
        if (shown == null || l.dpi < shown.dpi) shown = l;
      }
    }
    final q = shown == null ? null : _quality(shown.dpi);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 4),
      child: Wrap(spacing: 8, runSpacing: 6, children: [
        if (q != null && shown != null) StudioChip('${q.text} · ${shown.dpi.round()} dpi', bg: q.bg, fg: q.fg),
        if (bounds != null) StudioChip('Prints ${bounds.width.toStringAsFixed(1)} × ${bounds.height.toStringAsFixed(1)} in', bg: C.white, fg: C.deep),
        if (bounds == null) StudioChip('Print box ${areaW.toStringAsFixed(1)} × ${areaH.toStringAsFixed(1)} in', bg: C.white, fg: C.muted),
      ]),
    );
  }

  Widget _notice(String text, {required bool bad}) => Container(
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: bad ? C.blush : C.goldtint, borderRadius: BorderRadius.circular(16)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(bad ? Icons.error_outline_rounded : Icons.info_outline_rounded, size: 22, color: bad ? C.ruby : C.amber),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: t(15, color: bad ? C.ruby : C.deep, w: FontWeight.w600, h: 1.3))),
        ]),
      );

  Widget _stageArea(bool kb) {
    return LayoutBuilder(builder: (context, c) {
      final tool = _tool;
      final panelH = tool == null ? 0.0 : math.min(300.0, c.maxHeight * (kb ? 0.78 : 0.52));
      return Stack(children: [
        Positioned.fill(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 6),
            child: DecoratedBox(
              decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(26)),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(26),
                child: Stack(children: [
                  Positioned.fill(
                    child: StudioStage(
                      family: _family,
                      side: widget.side,
                      colour: _colourNow,
                      areaW: areaW,
                      areaH: areaH,
                      layers: _layers,
                      selectedId: _selId,
                      store: _store,
                      zoom: _zoomK,
                      focus: _focus,
                      onView: _onStageView,
                      bottomInset: panelH,
                      onSelect: select,
                      onChanged: () => _rebuild(() {}),
                      onCommit: () => _commit(),
                    ),
                  ),
                  Positioned(top: 6, right: 6, child: _zoomBar()),
                  if (_layers.isEmpty)
                    Positioned.fill(
                      child: IgnorePointer(
                        child: Align(
                          alignment: const Alignment(0, -0.6),
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text('Start with a picture or some words.\nUse the buttons below.', textAlign: TextAlign.center, style: t(16, color: C.maroon, h: 1.35)),
                          ),
                        ),
                      ),
                    ),
                ]),
              ),
            ),
          ),
        ),
        if (tool != null) Positioned(left: 0, right: 0, bottom: 0, height: panelH, child: _panel(tool)),
      ]);
    });
  }

  /// Zoom stepper: view only, never changes the design. 100% to 400%.
  Widget _zoomBar() {
    final z = _zoomK;
    return Material(
      color: const Color(0xEBFFFFFF),
      elevation: 2,
      shadowColor: const Color(0x55000000),
      borderRadius: BorderRadius.circular(26),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        StudioRoundButton(icon: Icons.remove_rounded, label: 'Zoom out', onTap: z > 1.001 ? () => _setZoom(z - 0.25) : null),
        SizedBox(
          width: 52,
          child: Text('${(z * 100).round()}%', textAlign: TextAlign.center, style: t(15, color: C.deep, w: FontWeight.w700)),
        ),
        StudioRoundButton(icon: Icons.add_rounded, label: 'Zoom in', onTap: z < 3.999 ? () => _setZoom(z + 0.25) : null),
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(52, 48), padding: const EdgeInsets.symmetric(horizontal: 10)),
          onPressed: z > 1.001 ? () => _setZoom(1) : null,
          child: Text('Fit', style: t(15, color: z > 1.001 ? C.maroon : C.brass)),
        ),
      ]),
    );
  }

  Widget _panel(_Tool tool) {
    final body = switch (tool) {
      _Tool.pictures => PicturesPanel(host: this),
      _Tool.text => TextPanel(host: this),
      _Tool.edit => EditPanel(host: this),
      _Tool.arrange => ArrangePanel(host: this),
      _Tool.layers => LayersPanel(host: this),
    };
    return Material(
      color: C.paper,
      elevation: 10,
      shadowColor: const Color(0x55000000),
      borderRadius: const BorderRadius.vertical(top: Radius.circular(26)),
      clipBehavior: Clip.antiAlias,
      child: Column(children: [
        SizedBox(
          height: 48,
          child: Row(children: [
            Padding(padding: const EdgeInsets.only(left: 18), child: Icon(tool.icon, size: 22, color: C.maroon)),
            const SizedBox(width: 8),
            Expanded(child: Text(tool.label, style: t(17, color: C.maroon))),
            IconButton(
              tooltip: 'Close',
              constraints: const BoxConstraints.tightFor(width: 48, height: 48),
              onPressed: () => _rebuild(() => _tool = null),
              icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 30, color: C.maroon),
            ),
          ]),
        ),
        Expanded(child: body),
      ]),
    );
  }

  Widget _swatchRow() {
    final cols = _colours;
    if (cols.isEmpty) return const SizedBox(height: 4);
    return SizedBox(
      height: 54,
      child: Row(children: [
        Padding(padding: const EdgeInsets.only(left: 16, right: 4), child: Text('Colour', style: t(15, color: C.maroon))),
        Expanded(
          child: ListView(scrollDirection: Axis.horizontal, children: [
            for (var i = 0; i < cols.length; i++)
              ColourDot(colour: colourFromHex(cols[i].hex), selected: i == _colourIx, label: cols[i].name, onTap: () => _rebuild(() => _colourIx = i)),
          ]),
        ),
      ]),
    );
  }

  Widget _toolBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(children: [
        for (final tl in _Tool.values)
          Expanded(
            child: Semantics(
              button: true,
              selected: _tool == tl,
              label: tl.label,
              child: InkWell(
                borderRadius: BorderRadius.circular(18),
                onTap: () => _rebuild(() {
                  _tool = _tool == tl ? null : tl;
                }),
                child: Container(
                  height: 64,
                  margin: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
                  decoration: BoxDecoration(color: _tool == tl ? C.lavtint : C.clear, borderRadius: BorderRadius.circular(18)),
                  child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Icon(tl.icon, size: 26, color: _tool == tl ? C.maroon : C.muted),
                    const SizedBox(height: 2),
                    Text(tl.label, style: t(15, color: _tool == tl ? C.maroon : C.muted)),
                  ]),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}
