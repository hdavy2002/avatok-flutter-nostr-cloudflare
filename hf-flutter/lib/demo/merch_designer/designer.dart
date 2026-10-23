import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../data/api_exception.dart';
import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../desi.dart';
import '../merch_kit.dart';
import '../theme.dart';
import 'contract.dart';
import 'designer_bits.dart';
import 'erase.dart';
import 'finish.dart';
import 'fonts.dart';
import 'history.dart';
import 'images.dart';
import 'layer_paint.dart';
import 'panel_text.dart';
import 'panels.dart';
import 'render.dart';
import 'silhouettes.dart';
import 'stage.dart';

export 'contract.dart';
export 'silhouettes.dart' show ProductSilhouette, colourFromHex;

part 'designer_view.dart';

/// [HF-MERCH-STUDIO-2] Step "Design" of the merch wizard: the design studio. Layers of pictures and words on the product,
/// phone-first. Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md. The web studio does the same (web/.../merch/studio/Designer.tsx).
/// Fills its parent. "Looks good" draws one 300 DPI transparent print file, uploads it and the product pictures, then calls [onDone].
class MerchDesigner extends StatefulWidget {
  const MerchDesigner({
    super.key,
    required this.repo,
    required this.item,
    required this.side,
    required this.colours,
    required this.arts,
    required this.onArtAdded,
    required this.onWantMoreArt,
    this.initialLayers,
    this.onLayersChange,
    required this.onBack,
    required this.onDone,
  });

  final MerchRepo repo;
  final CatalogItem item;
  final String side;
  final List<MerchColour> colours;
  final List<StudioArt> arts;
  final ValueChanged<StudioArt> onArtAdded;
  final VoidCallback onWantMoreArt;
  final List<DesignLayer>? initialLayers;
  final ValueChanged<List<DesignLayer>>? onLayersChange;
  final VoidCallback onBack;
  final ValueChanged<DesignResult> onDone;

  @override
  State<MerchDesigner> createState() => _MerchDesignerState();
}

enum _Tool { pictures, text, edit, arrange, layers }

extension on _Tool {
  String get label => switch (this) {
        _Tool.pictures => 'Pictures',
        _Tool.text => 'Text',
        _Tool.edit => 'Edit',
        _Tool.arrange => 'Arrange',
        _Tool.layers => 'Layers',
      };
  IconData get icon => switch (this) {
        _Tool.pictures => Icons.image_outlined,
        _Tool.text => Icons.text_fields_rounded,
        _Tool.edit => Icons.auto_fix_high_rounded,
        _Tool.arrange => Icons.tune_rounded,
        _Tool.layers => Icons.layers_outlined,
      };
}

class _MerchDesignerState extends State<MerchDesigner> implements StudioHost {
  late List<DesignLayer> _layers;
  late LayerHistory _hist;
  late ImageStore _store;
  String? _selId;
  _Tool? _tool;
  bool _zoom = false;
  int _colourIx = 0;
  String? _busy;
  String? _problem;
  String? _editStatus;
  String? _editMessage;
  String? _eraseId;
  double _eraseTol = 30;
  ui.Image? _erased;
  int _eraseSeq = 0;
  int _idSeq = 0;

  // ---------------------------------------------------------------------------------------------- product facts

  PrintArea get _area => widget.item.areaFor(widget.side);
  @override
  double get areaW => _area.wIn;
  @override
  double get areaH => _area.hIn;
  String get _family => familyOfItem(widget.item);
  List<MerchColour> get _colours => widget.colours.isNotEmpty ? widget.colours : widget.item.colours.take(1).toList();
  MerchColour? get _colour {
    final c = _colours;
    if (c.isEmpty) return null;
    return c[math.max(0, math.min(c.length - 1, _colourIx))];
  }

  Color get _colourNow => colourFromHex(_colour?.hex ?? '#ffffff');

  // ---------------------------------------------------------------------------------------------- StudioHost

  @override
  List<DesignLayer> get layers => _layers;
  @override
  DesignLayer? get selected => _byId(_selId);
  @override
  List<StudioArt> get arts => widget.arts;
  @override
  String? get editStatus => _editStatus;
  @override
  String? get editMessage => _editMessage;
  @override
  String? get eraseLayerId => _eraseId;
  @override
  double get eraseTolerance => _eraseTol;
  @override
  bool get eraseHasPreview => _erased != null;

  DesignLayer? _byId(String? id) {
    if (id == null) return null;
    for (final l in _layers) {
      if (l.id == id) return l;
    }
    return null;
  }

  String _newId() => 'l${DateTime.now().microsecondsSinceEpoch}_${_idSeq++}';

  String _nextName(String base) {
    final n = _layers.where((l) => l.name.startsWith(base)).length;
    return n == 0 ? base : '$base ${n + 1}';
  }

  ImageDesignLayer _layerForArt(StudioArt a) {
    final pw = a.art.width > 0 ? a.art.width : 1000;
    final ph = a.art.height > 0 ? a.art.height : 1000;
    final aspect = ph / pw;
    // ~70% of the print area, but never so big that a small picture prints soft (keep about 220 DPI). Same rule as the web studio.
    var w = math.min(areaW * 0.7, pw / 220);
    var h = w * aspect;
    if (h > areaH * 0.7) {
      h = areaH * 0.7;
      w = h / aspect;
    }
    w = math.max(w, math.min(2.0, areaW));
    h = w * aspect;
    return ImageDesignLayer(
      id: _newId(), name: _nextName(a.label ?? 'Picture'), x: areaW / 2, y: math.min(areaH / 2, h / 2 + 1),
      artId: a.artId, url: a.art.url, pxW: pw, pxH: ph, w: w, h: h,
    );
  }

  void _commit({String? key}) {
    _hist.push(_layers, key: key);
    _store.ensureLayers(_layers);
    _notifyLayers();
    if (mounted) setState(() {});
  }

  void _notifyLayers() => widget.onLayersChange?.call(<DesignLayer>[for (final l in _layers) l.copy()]);

  @override
  void select(String? id) {
    if (id != _eraseId) _clearErase();
    setState(() {
      _selId = id;
      final l = _byId(id);
      if (l != null && _tool != null && _tool != _Tool.layers && _tool != _Tool.arrange) {
        if (l is TextDesignLayer) {
          _tool = _Tool.text;
        } else if (_tool == _Tool.text || _tool == _Tool.pictures) {
          _tool = _Tool.edit;
        }
      }
    });
  }

  @override
  void addArt(StudioArt a) {
    final l = _layerForArt(a);
    _layers.add(l);
    _selId = l.id;
    merchEvent('merch_studio_step', {'step': 'design_add_picture', 'source': a.source});
    _commit();
  }

  @override
  void wantMoreArt() => widget.onWantMoreArt();

  @override
  void addText({bool hindi = false}) {
    final dark = _colourNow.computeLuminance() < 0.3;
    final l = TextDesignLayer(
      id: _newId(), name: _nextName('Text'), x: areaW / 2, y: areaH / 2,
      text: hindi ? 'नमस्ते' : 'Your text', font: kDefaultMerchFont,
      sizeIn: math.min(3.0, math.max(0.6, areaW * 0.12)), fill: dark ? '#ffffff' : '#1a1a1a', lineHeight: 1.1, strokeIn: 0.04,
    );
    MerchFonts.loadQuiet(kDefaultMerchFont);
    _layers.add(l);
    _selId = l.id;
    _tool = _Tool.text;
    merchEvent('merch_studio_step', {'step': 'design_add_text', 'hindi': hindi});
    _commit();
  }

  @override
  void mutate(String id, void Function(DesignLayer l) change, {String? key}) {
    final l = _byId(id);
    if (l == null) return;
    change(l);
    _commit(key: key);
  }

  @override
  void removeLayer(String id) {
    _layers.removeWhere((l) => l.id == id);
    if (_selId == id) _selId = null;
    if (_eraseId == id) _clearErase();
    _commit();
  }

  DesignLayer _copyOf(DesignLayer l) => switch (l) {
        final ImageDesignLayer i => ImageDesignLayer(
            id: _newId(), name: '${i.name} copy', visible: i.visible, x: i.x + 0.3, y: i.y + 0.3, rotation: i.rotation, opacity: i.opacity,
            flipX: i.flipX, flipY: i.flipY, artId: i.artId, url: i.url, pxW: i.pxW, pxH: i.pxH, w: i.w, h: i.h),
        final TextDesignLayer t => TextDesignLayer(
            id: _newId(), name: '${t.name} copy', visible: t.visible, x: t.x + 0.3, y: t.y + 0.3, rotation: t.rotation, opacity: t.opacity,
            flipX: t.flipX, flipY: t.flipY, text: t.text, font: t.font, sizeIn: t.sizeIn, fill: t.fill, align: t.align,
            letterSpacing: t.letterSpacing, lineHeight: t.lineHeight, stroke: t.stroke, strokeIn: t.strokeIn, shadow: t.shadow),
      };

  @override
  void duplicateLayer(String id) {
    final i = _layers.indexWhere((l) => l.id == id);
    if (i < 0) return;
    final c = _copyOf(_layers[i]);
    _layers.insert(i + 1, c);
    _selId = c.id;
    _commit();
  }

  @override
  void moveLayer(String id, int delta) {
    final i = _layers.indexWhere((l) => l.id == id);
    if (i < 0) return;
    final n = _layers.length;
    final to = delta >= 1000 ? n - 1 : (delta <= -1000 ? 0 : math.max(0, math.min(n - 1, i + delta)));
    reorderLayers(i, to);
  }

  @override
  void reorderLayers(int from, int to) {
    final n = _layers.length;
    if (from == to || from < 0 || from >= n || to < 0 || to >= n) return;
    final l = _layers.removeAt(from);
    _layers.insert(to, l);
    _commit();
  }

  @override
  void alignLayer(String id, String how) {
    final l = _byId(id);
    if (l == null) return;
    final b = layerBoundsIn(l);
    switch (how) {
      case 'centerH':
        l.x += areaW / 2 - (b.left + b.right) / 2;
      case 'centerV':
        l.y += areaH / 2 - (b.top + b.bottom) / 2;
      case 'top':
        l.y += -b.top;
    }
    _commit();
  }

  void _undo() {
    final p = _hist.undo();
    if (p != null) _applyHistory(p);
  }

  void _redo() {
    final p = _hist.redo();
    if (p != null) _applyHistory(p);
  }

  void _applyHistory(List<DesignLayer> p) {
    _clearErase();
    setState(() {
      _layers = p;
      if (_byId(_selId) == null) _selId = null;
    });
    _store.ensureLayers(_layers);
    _notifyLayers();
  }

  // ---------------------------------------------------------------------------------------------- picture edits

  void _adoptArt(String layerId, ArtUpload up, {required String label, required String source, Uint8List? bytes}) {
    widget.onArtAdded(StudioArt(art: up, source: source, bytes: bytes, label: label));
    if (bytes != null) _store.putBytes(up.artId, bytes);
    final l = _byId(layerId);
    if (l is ImageDesignLayer) {
      l.artId = up.artId;
      l.url = up.url;
      if (up.width > 0 && up.height > 0) {
        l.pxW = up.width;
        l.pxH = up.height;
        l.h = l.w * up.height / up.width;
      }
    }
    _commit();
  }

  @override
  Future<void> removeBackground(ImageDesignLayer l) async {
    if (_editStatus != null) return;
    _clearErase();
    setState(() {
      _editStatus = 'Removing the background. This can take a few seconds.';
      _editMessage = null;
    });
    merchEvent('merch_studio_step', {'step': 'design_bg_remove'});
    try {
      final up = await widget.repo.removeBackground(l.artId);
      if (!mounted) return;
      _adoptArt(l.id, up, label: '${l.name} (no background)', source: 'bg_removed');
      setState(() => _editStatus = null);
    } on ApiException catch (e) {
      if (!mounted) return;
      final soft = e.status == 502 || e.code == 'bg_remove_failed';
      setState(() {
        _editStatus = null;
        _editMessage = soft ? (e.message ?? 'Could not remove the background. Try "Erase plain colour" instead.') : merchErrorText(e);
      });
    } catch (e, st) {
      merchCapture(e, st, 'studio_bg_remove');
      if (!mounted) return;
      setState(() {
        _editStatus = null;
        _editMessage = 'Could not remove the background. Please try again.';
      });
    }
  }

  void _clearErase() {
    final id = _eraseId;
    _eraseId = null;
    _eraseSeq++;
    if (id != null) _store.setOverride(id, null);
    _erased = null;
  }

  @override
  void startErase(ImageDesignLayer l) {
    _clearErase();
    _eraseId = l.id;
    _eraseTol = 30;
    setState(() => _editMessage = null);
    runErase();
  }

  @override
  void setEraseTolerance(double v) => setState(() => _eraseTol = v);

  @override
  void runErase() => unawaited(_runErase());

  Future<void> _runErase() async {
    final id = _eraseId;
    final l = _byId(id);
    if (id == null || l is! ImageDesignLayer) return;
    final seq = ++_eraseSeq;
    setState(() {
      _editStatus = 'Erasing the plain colour.';
      _editMessage = null;
    });
    ui.Image? src;
    try {
      final bytes = await _store.bytesFor(l.artId, l.url);
      src = await decodePicture(bytes, maxSide: kEraseMaxSide);
      final out = await eraseFlatColour(src, tolerance: _eraseTol.round());
      if (!mounted || seq != _eraseSeq || _eraseId != id) {
        out.dispose();
        return;
      }
      _store.setOverride(id, out);
      _erased = out;
      setState(() => _editStatus = null);
    } catch (e, st) {
      if (e is! PictureUnreadable) merchCapture(e, st, 'studio_erase');
      if (!mounted || seq != _eraseSeq) return;
      setState(() {
        _editStatus = null;
        _editMessage = e is PictureUnreadable ? e.toString() : 'Could not erase the colour. Please try again.';
      });
    } finally {
      src?.dispose();
    }
  }

  @override
  Future<void> keepErase() async {
    final id = _eraseId;
    final img = _erased;
    final l = _byId(id);
    if (id == null || img == null || l is! ImageDesignLayer) return;
    final w = img.width, h = img.height;
    setState(() {
      _editStatus = 'Saving the picture.';
      _editMessage = null;
    });
    merchEvent('merch_studio_step', {'step': 'design_erase_colour'});
    try {
      final png = await encodePng(img);
      final up = await widget.repo.uploadArt(png, contentType: 'image/png', fileName: 'erased.png');
      if (!mounted) return;
      _clearErase();
      final fixed = ArtUpload(artId: up.artId, url: up.url, width: up.width > 0 ? up.width : w, height: up.height > 0 ? up.height : h, warnings: up.warnings);
      _adoptArt(id, fixed, label: '${l.name} (cleaned)', source: 'bg_removed', bytes: png);
      setState(() => _editStatus = null);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _editStatus = null;
        _editMessage = merchErrorText(e);
      });
    } catch (e, st) {
      merchCapture(e, st, 'studio_erase_save');
      if (!mounted) return;
      setState(() {
        _editStatus = null;
        _editMessage = 'Could not save the picture. Please try again.';
      });
    }
  }

  @override
  void cancelErase() {
    _clearErase();
    setState(() {});
  }

  // ---------------------------------------------------------------------------------------------- Looks good

  void _say(String? s) {
    if (mounted) setState(() => _busy = s);
  }

  Future<void> _finish(Rect? bounds) async {
    if (_busy != null || _blockedReason(bounds) != null) return;
    _clearErase();
    setState(() {
      _problem = null;
      _busy = 'Making your print file.';
    });
    merchEvent('merch_studio_step', {'step': 'design_export_start', 'layers': _layers.length});
    try {
      final result = await finishDesign(
        repo: widget.repo, family: _family, side: widget.side, colours: _colours, areaW: areaW, areaH: areaH,
        layers: <DesignLayer>[for (final l in _layers) l.copy()], store: _store, onArtAdded: widget.onArtAdded, say: _say,
      );
      if (!mounted) return;
      merchEvent('merch_studio_step', {'step': 'design_export_ok', 'dpi': result.dpi, 'mockups': result.mockupUrls.length});
      setState(() => _busy = null);
      widget.onDone(result);
    } on StudioExportException catch (e) {
      _fail(e.message);
    } on ApiException catch (e) {
      _fail(merchErrorText(e));
    } catch (e, st) {
      merchCapture(e, st, 'studio_finish');
      _fail('Could not make the print file. Please try again.');
    }
  }

  void _fail(String message) {
    if (!mounted) return;
    setState(() {
      _busy = null;
      _problem = message;
    });
  }

  // ---------------------------------------------------------------------------------------------- numbers shown

  ({String text, Color bg, Color fg, bool blocks}) _quality(double dpi) {
    if (dpi >= 250) return (text: 'Sharp', bg: C.lavtint, fg: C.maroon, blocks: false);
    if (dpi >= 200) return (text: 'Good', bg: C.goldtint, fg: C.amber, blocks: false);
    if (dpi >= 150) return (text: 'Soft', bg: C.blush, fg: C.tan, blocks: false);
    return (text: 'Too blurry', bg: C.blush, fg: C.ruby, blocks: true);
  }

  List<ImageDesignLayer> get _visibleImages => <ImageDesignLayer>[
        for (final l in _layers)
          if (l is ImageDesignLayer && l.visible) l,
      ];

  String? _blockedReason(Rect? bounds) {
    if (bounds == null) {
      return _layers.any((l) => l.visible)
          ? 'Nothing is inside the dashed box yet. Move your picture or words into it.'
          : 'Add a picture or some words to begin.';
    }
    for (final l in _visibleImages) {
      if (_quality(l.dpi).blocks) {
        return '"${l.name}" is too blurry to print (${l.dpi.round()} dots per inch). Make it smaller on the product, or add a sharper picture.';
      }
      if (_store.failed.contains(l.artId)) return 'A picture could not be loaded. Delete it and add it again.';
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------- life cycle

  @override
  void initState() {
    super.initState();
    _store = ImageStore(widget.arts);
    _layers = <DesignLayer>[for (final l in widget.initialLayers ?? const <DesignLayer>[]) l.copy()];
    var added = false;
    if (_layers.isEmpty && widget.arts.isNotEmpty) {
      final l = _layerForArt(widget.arts.first);
      _layers.add(l);
      _selId = l.id;
      added = true;
    }
    _hist = LayerHistory(_layers);
    _store.ensureLayers(_layers);
    _store.changes.addListener(_repaintNote);
    MerchFonts.changes.addListener(_repaintNote);
    unawaited(MerchFonts.loadAll(<String>[kDefaultMerchFont, for (final l in _layers) if (l is TextDesignLayer) l.font]));
    merchEvent('merch_studio_step', {'step': 'design_open', 'family': _family, 'side': widget.side});
    if (added) WidgetsBinding.instance.addPostFrameCallback((_) => _notifyLayers());
  }

  void _repaintNote() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(MerchDesigner old) {
    super.didUpdateWidget(old);
    _store.arts = widget.arts;
  }

  @override
  void dispose() {
    _store.changes.removeListener(_repaintNote);
    MerchFonts.changes.removeListener(_repaintNote);
    _erased = null;
    _store.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------------------------- view

  @override
  Widget build(BuildContext context) {
    final kb = MediaQuery.viewInsetsOf(context).bottom > 0;
    final bounds = designBounds(_layers, areaW, areaH);
    final blocked = _blockedReason(bounds);
    return Material(
      color: C.ivory,
      child: Stack(children: [
        Positioned.fill(
          child: Column(children: [
            _topBar(),
            if (!kb) _chips(bounds),
            if (!kb && blocked != null && _busy == null) _notice(blocked, bad: false),
            if (_problem != null) _notice(_problem!, bad: true),
            Expanded(child: _stageArea(kb)),
            if (!kb)
              SafeArea(
                top: false,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  _swatchRow(),
                  _toolBar(),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                    child: DesiButton('Looks good', expand: true, kind: DesiButtonKind.gold, icon: Icons.check_rounded, onTap: blocked == null && _busy == null ? () => unawaited(_finish(bounds)) : null),
                  ),
                ]),
              ),
          ]),
        ),
        if (_busy != null) Positioned.fill(child: StudioBusyOverlay(text: _busy!)),
      ]),
    );
  }

  void _rebuild(VoidCallback fn) => setState(fn);
}
