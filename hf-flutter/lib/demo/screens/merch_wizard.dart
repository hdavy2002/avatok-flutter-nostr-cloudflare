import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/merch_art_picker.dart';
import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../merch_canvas.dart';
import '../merch_kit.dart';
import '../theme.dart';
import '../widgets.dart';

enum _Step { art, shirt, place, price }

/// [HF-MERCH-APP-1] "+ New product": pick art from the gallery, pick the shirt, place the art (drag and pinch on the shirt), set the
/// markup and publish. The art is cut to its frame and drawn to a PNG at 300 DPI on the phone, uploaded as the print file, and the
/// product goes to the team for review ("Sent for review") unless the server has review switched off.
class MerchWizardScreen extends StatefulWidget {
  const MerchWizardScreen({super.key, this.repo});

  final MerchRepo? repo;

  @override
  State<MerchWizardScreen> createState() => _MerchWizardScreenState();
}

class _MerchWizardScreenState extends State<MerchWizardScreen> {
  _Step _step = _Step.art;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  // art
  ArtUpload? _art;
  ui.Image? _imgFull;
  ui.Image? _imgSmall;
  bool _busyArt = false;
  String? _artError;

  // shirt
  AsyncState<MerchCatalog> _cat = const AsyncLoading();
  CatalogItem? _item;
  final Set<String> _colours = <String>{};
  final Set<String> _sizes = <String>{};

  // placement (inches on the print area; the centre of the print)
  bool _placeFresh = true;
  bool _back = false;
  MerchFrame _frame = MerchFrame.none;
  double _w = 0;
  double _cx = 0;
  double _cy = 0;
  double _startW = 0;
  String? _previewColour;

  // price
  final TextEditingController _title = TextEditingController();
  final TextEditingController _desc = TextEditingController();
  final TextEditingController _markup = TextEditingController(text: '100');
  bool _own = false;
  Map<String, int>? _bases;
  bool _quoting = false;
  String? _quoteError;

  // publish
  bool _publishing = false;
  String _phase = '';
  String? _publishError;
  MerchProduct? _done;

  @override
  void initState() {
    super.initState();
    merchEvent('merch_studio_step', {'step': _Step.art.name});
    unawaited(_loadCatalog());
  }

  @override
  void dispose() {
    _title.dispose();
    _desc.dispose();
    _markup.dispose();
    _imgFull?.dispose();
    _imgSmall?.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------------------------- art

  Future<void> _pickArt() async {
    setState(() {
      _busyArt = true;
      _artError = null;
    });
    try {
      final picked = await MerchArtPicker.pick();
      if (picked == null) {
        if (mounted) setState(() => _busyArt = false);
        return;
      }
      final up = await _repo.uploadArt(picked.bytes, contentType: picked.mime, fileName: picked.name);
      final full = await merchDecode(picked.bytes, width: up.width, height: up.height, maxSide: 4096);
      final small = await merchDecode(picked.bytes, width: up.width, height: up.height, maxSide: 1024);
      if (!mounted) {
        full.dispose();
        small.dispose();
        return;
      }
      final oldFull = _imgFull;
      final oldSmall = _imgSmall;
      setState(() {
        _art = up;
        _imgFull = full;
        _imgSmall = small;
        _busyArt = false;
        _placeFresh = true;
        _bases = null;
      });
      oldFull?.dispose();
      oldSmall?.dispose();
    } on PlatformException catch (e) {
      if (mounted) {
        setState(() {
          _busyArt = false;
          _artError = e.code == 'too_large' ? 'The picture must be 15 MB or smaller.' : 'Could not open that picture. Try another one.';
        });
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busyArt = false;
          _artError = e.userMessage;
        });
      }
    } catch (e, st) {
      merchCapture(e, st, 'art');
      if (mounted) {
        setState(() {
          _busyArt = false;
          _artError = 'Could not read that picture. Try another one.';
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- shirt

  Future<void> _loadCatalog() async {
    setState(() => _cat = const AsyncLoading());
    try {
      final c = await _repo.catalog();
      if (mounted) setState(() => _cat = AsyncData(c));
    } catch (e) {
      if (mounted) setState(() => _cat = AsyncFailure(e));
    }
  }

  void _chooseItem(CatalogItem it) {
    if (_item?.id == it.id) return;
    setState(() {
      _item = it;
      _colours
        ..clear()
        ..addAll(it.colours.isEmpty ? const <String>[] : [it.colours.first.name]);
      _sizes
        ..clear()
        ..addAll(it.sizes.map((s) => s.size));
      _placeFresh = true;
      _bases = null;
    });
  }

  void _toggleColour(String name) {
    setState(() {
      if (_colours.contains(name)) {
        if (_colours.length > 1) _colours.remove(name);
      } else if (_colours.length < 8) {
        _colours.add(name);
      } else {
        toast(context, 'You can sell up to 8 colours.');
      }
      _bases = null;
    });
  }

  void _toggleSize(String size) {
    setState(() {
      if (_sizes.contains(size)) {
        if (_sizes.length > 1) _sizes.remove(size);
      } else {
        _sizes.add(size);
      }
      _bases = null;
    });
  }

  // ---------------------------------------------------------------------------------------------- placement maths

  double get _aspect {
    final fixed = _frame.fixedAspect;
    if (fixed != null) return fixed;
    final img = _imgFull;
    return img == null ? 1.0 : img.width / img.height;
  }

  double get _h => _w / _aspect;

  Rect _srcFor(ui.Image img) => merchCoverSource(img.width.toDouble(), img.height.toDouble(), _aspect);

  /// The biggest the print may be: inside the print area, and sharp enough (150 DPI or better) for the picture's own pixels.
  double get _maxW {
    final it = _item;
    final img = _imgFull;
    if (it == null || img == null) return 1;
    final sharp = _srcFor(img).width / 150;
    return math.min(math.min(it.areaW, it.areaH * _aspect), sharp);
  }

  double get _minW => math.min(1.5, _maxW);

  static double _cl(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

  void _clampBox() {
    final it = _item;
    if (it == null) return;
    _w = _cl(_w, _minW, _maxW);
    _cx = _cl(_cx, _w / 2, it.areaW - _w / 2);
    _cy = _cl(_cy, _h / 2, it.areaH - _h / 2);
  }

  void _initPlacement() {
    final it = _item;
    if (it == null) return;
    _back = false;
    _frame = MerchFrame.none;
    _previewColour = _colours.isEmpty ? null : _colours.first;
    _w = math.min(_maxW, 8.0);
    _cx = it.areaW / 2;
    _cy = _h / 2 + 0.5;
    _clampBox();
    _placeFresh = false;
  }

  double get _dpi {
    final img = _imgFull;
    if (img == null || _w <= 0) return 0;
    return _srcFor(img).width / _w;
  }

  String get _colourHex {
    final it = _item;
    if (it == null || it.colours.isEmpty) return '#cccccc';
    for (final c in it.colours) {
      if (c.name == _previewColour) return c.hex;
    }
    return it.colours.first.hex;
  }

  // ---------------------------------------------------------------------------------------------- price

  int? get _markupValue => int.tryParse(_markup.text.trim());

  int get _minMarkup {
    final c = _cat;
    return c is AsyncData<MerchCatalog> ? c.value.minMarkupRupees : MerchRepo.flags.value.minMarkupRupees;
  }

  String? get _markupProblem {
    final m = _markupValue;
    if (m == null) return 'Enter a whole number of rupees.';
    if (m < _minMarkup) return 'The markup must be at least ${merchRupees(_minMarkup * 100)}.';
    if (m > 5000) return 'The markup can be at most ₹5,000.';
    return null;
  }

  Future<void> _quote() async {
    final it = _item;
    if (it == null) return;
    setState(() {
      _quoting = true;
      _quoteError = null;
    });
    try {
      final sizesInOrder = [for (final s in it.sizes) if (_sizes.contains(s.size)) s.size];
      final b = await _repo.quote(
        catalogId: it.id,
        colours: _colours.toList(),
        side: _back ? 'back' : 'front',
        wIn: _w,
        hIn: _h,
        sizes: sizesInOrder,
      );
      if (mounted) {
        setState(() {
          _bases = b;
          _quoting = false;
          if (b.isEmpty) _quoteError = 'That shirt cannot be priced in those colours right now.';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _quoting = false;
          _quoteError = merchErrorText(e);
        });
      }
    }
  }

  bool get _canPublish =>
      !_publishing && !_quoting && (_bases?.isNotEmpty ?? false) && _title.text.trim().length >= 2 && _markupProblem == null && _own;

  double _r2(double v) => (v * 100).round() / 100;

  Future<void> _publish() async {
    final art = _art;
    final full = _imgFull;
    final small = _imgSmall;
    final it = _item;
    final bases = _bases;
    final markup = _markupValue;
    if (art == null || full == null || small == null || it == null || bases == null || markup == null) return;
    final frame = _frame;
    final w = _w;
    final h = _h;
    final x = math.max(0.0, _cx - w / 2);
    final y = math.max(0.0, _cy - h / 2);
    final back = _back;
    final hex = _colourHex;
    final sizes = [for (final s in it.sizes) if (bases.containsKey(s.size)) s.size];
    setState(() {
      _publishing = true;
      _publishError = null;
      _phase = 'Preparing your print…';
    });
    try {
      final png = await renderPrintPng(art: full, source: _srcFor(full), frame: frame, wIn: w, hIn: h);
      if (!mounted) return;
      setState(() => _phase = 'Uploading your print…');
      final printId = await _repo.uploadPrintFile(art.artId, png);
      final mockups = <String>[];
      try {
        if (mounted) setState(() => _phase = 'Making the shirt picture…');
        final scene = ShirtScene(
          colour: merchColour(hex),
          back: back,
          areaW: it.areaW,
          areaH: it.areaH,
          art: small,
          source: _srcFor(small),
          frame: frame,
          x: x,
          y: y,
          w: w,
          h: h,
          guides: false,
        );
        mockups.add(await _repo.uploadMockup(await renderMockupPng(scene)));
      } catch (e, st) {
        merchCapture(e, st, 'mockup'); // the product still goes up; the server then shows the print preview
      }
      if (!mounted) return;
      setState(() => _phase = 'Saving your product…');
      final product = await _repo.createProduct({
        'title': _title.text.trim(),
        if (_desc.text.trim().isNotEmpty) 'description': _desc.text.trim(),
        'catalogId': it.id,
        'colours': _colours.toList(),
        'sizes': sizes,
        'side': back ? 'back' : 'front',
        'placement': {'frame': frame.name, 'x': _r2(x), 'y': _r2(y), 'w': _r2(w), 'h': _r2(h), 'zoom': 100},
        'artId': art.artId,
        'printFileId': printId,
        'markupRupees': markup,
        'ownArtConfirmed': true,
        if (mockups.isNotEmpty) 'mockupUrls': mockups,
      });
      merchEvent('merch_studio_step', {'step': 'published', 'status': product.status});
      if (mounted) {
        setState(() {
          _publishing = false;
          _done = product;
        });
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _publishing = false;
          _publishError = e.userMessage;
        });
      }
    } catch (e, st) {
      merchCapture(e, st, 'publish');
      if (mounted) {
        setState(() {
          _publishing = false;
          _publishError = 'Something went wrong while preparing your print. Please try again.';
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- navigation

  bool get _canNext {
    switch (_step) {
      case _Step.art:
        return _art != null && !_busyArt;
      case _Step.shirt:
        return _item != null && _colours.isNotEmpty && _sizes.isNotEmpty;
      case _Step.place:
        return _item != null && _imgFull != null && _w > 0;
      case _Step.price:
        return false;
    }
  }

  void _goto(_Step s) {
    if (s == _Step.place && _placeFresh) _initPlacement();
    setState(() => _step = s);
    merchEvent('merch_studio_step', {'step': s.name});
    if (s == _Step.price) {
      unawaited(_quote());
    }
  }

  void _next() {
    switch (_step) {
      case _Step.art:
        _goto(_Step.shirt);
      case _Step.shirt:
        _goto(_Step.place);
      case _Step.place:
        _goto(_Step.price);
      case _Step.price:
        break;
    }
  }

  void _prev() {
    switch (_step) {
      case _Step.art:
        break;
      case _Step.shirt:
        _goto(_Step.art);
      case _Step.place:
        _goto(_Step.shirt);
      case _Step.price:
        _goto(_Step.place);
    }
  }

  static const Map<_Step, String> _titles = {
    _Step.art: 'Your art',
    _Step.shirt: 'Pick your shirt',
    _Step.place: 'Place your art',
    _Step.price: 'Price and publish',
  };

  @override
  Widget build(BuildContext context) {
    final done = _done;
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('New product'),
            if (done == null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 2, 20, 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('Step ${_step.index + 1} of 4 · ${_titles[_step]}', style: t(15, color: C.tan)),
                ),
              ),
            Expanded(child: done != null ? _doneView(done) : _body()),
            if (done == null) _bottomBar(),
          ],
        ),
      ),
    );
  }

  Widget _body() {
    switch (_step) {
      case _Step.art:
        return _artStep();
      case _Step.shirt:
        return _shirtStep();
      case _Step.place:
        return _placeStep();
      case _Step.price:
        return _priceStep();
    }
  }

  Widget _bottomBar() {
    if (_step == _Step.price) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Row(children: [
          DesiButton('Back', kind: DesiButtonKind.ghost, onTap: _publishing ? null : _prev),
          const SizedBox(width: 10),
          Expanded(
            child: DesiButton(_publishing ? 'Please wait…' : 'Publish', icon: Icons.check_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _canPublish ? () => unawaited(_publish()) : null),
          ),
        ]),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Row(children: [
        if (_step != _Step.art) ...[
          DesiButton('Back', kind: DesiButtonKind.ghost, onTap: _prev),
          const SizedBox(width: 10),
        ],
        Expanded(child: DesiButton('Next', icon: Icons.arrow_forward_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _canNext ? _next : null)),
      ]),
    );
  }

  // ---------------------------------------------------------------------------------------------- step 1: art

  Widget _artStep() {
    final art = _art;
    final img = _imgSmall;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
      children: [
        Text('Choose the picture you want on the T-shirt. A PNG with a see-through background prints best. JPEG or PNG, up to 15 MB.', style: t(15, color: C.muted, w: FontWeight.w700)),
        const SizedBox(height: 14),
        Container(
          height: 260,
          decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: C.line)),
          clipBehavior: Clip.antiAlias,
          alignment: Alignment.center,
          child: _busyArt
              ? Column(mainAxisSize: MainAxisSize.min, children: [
                  const SizedBox(width: 40, height: 40, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 5)),
                  const SizedBox(height: 12),
                  Text('Uploading your art…', style: t(16, color: C.muted, w: FontWeight.w700)),
                ])
              : (img == null
                  ? Column(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.photo_library_rounded, size: 52, color: C.violet),
                      const SizedBox(height: 8),
                      Text('No art chosen yet', style: t(16, color: C.muted, w: FontWeight.w700)),
                    ])
                  : Padding(padding: const EdgeInsets.all(12), child: RawImage(image: img, fit: BoxFit.contain))),
        ),
        const SizedBox(height: 14),
        DesiButton(art == null ? 'Choose from gallery' : 'Choose another picture', icon: Icons.photo_library_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _busyArt ? null : () => unawaited(_pickArt())),
        if (_artError != null) ...[
          const SizedBox(height: 10),
          Text(_artError!, style: t(15, color: C.ruby, w: FontWeight.w700)),
        ],
        if (art != null) ...[
          const SizedBox(height: 12),
          Text('${art.width} × ${art.height} pixels', style: t(14, color: C.muted, w: FontWeight.w700)),
          for (final w in art.warnings)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Icon(Icons.info_outline_rounded, size: 20, color: C.amber),
                const SizedBox(width: 8),
                Expanded(child: Text(w, style: t(14, color: C.deep, w: FontWeight.w700))),
              ]),
            ),
        ],
      ],
    );
  }

  // ---------------------------------------------------------------------------------------------- step 2: shirt

  Widget _shirtStep() {
    return AsyncView<MerchCatalog>(
      state: _cat,
      onRetry: () => unawaited(_loadCatalog()),
      emptyTitle: 'No shirts yet',
      emptyMessage: 'Shirts are not available right now. Please try again in a little while.',
      isEmpty: (c) => c.items.isEmpty,
      builder: (context, cat) {
        final it = _item;
        return ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
          children: [
            for (final s in cat.items) ...[
              _ShirtOption(item: s, selected: it?.id == s.id, onTap: () => _chooseItem(s)),
              const SizedBox(height: 10),
            ],
            if (it != null) ...[
              const SizedBox(height: 4),
              Text('Colours you will sell (up to 8)', style: t(16, color: C.maroon)),
              const SizedBox(height: 8),
              Wrap(spacing: 10, runSpacing: 10, children: [
                for (final c in it.colours) _ColourDot(colour: c, selected: _colours.contains(c.name), onTap: () => _toggleColour(c.name)),
              ]),
              const SizedBox(height: 16),
              Text('Sizes', style: t(16, color: C.maroon)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final s in it.sizes) MerchPill(label: s.size, selected: _sizes.contains(s.size), onTap: () => _toggleSize(s.size)),
              ]),
            ],
          ],
        );
      },
    );
  }

  // ---------------------------------------------------------------------------------------------- step 3: place

  Widget _placeStep() {
    final it = _item;
    final small = _imgSmall;
    if (it == null || small == null) return const SizedBox.shrink();
    final maxW = _maxW;
    final minW = _minW;
    final dpi = _dpi;
    final quality = dpi >= 250 ? 'Sharp print' : (dpi >= 190 ? 'Good print' : 'A little soft');
    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Center(
              child: AspectRatio(
                aspectRatio: 0.9,
                child: LayoutBuilder(
                  builder: (context, c) {
                    final size = Size(c.maxWidth, c.maxHeight);
                    final geo = ShirtGeometry(size, it.areaW, it.areaH);
                    final scene = ShirtScene(
                      colour: merchColour(_colourHex),
                      back: _back,
                      areaW: it.areaW,
                      areaH: it.areaH,
                      art: small,
                      source: _srcFor(small),
                      frame: _frame,
                      x: _cx - _w / 2,
                      y: _cy - _h / 2,
                      w: _w,
                      h: _h,
                    );
                    return Semantics(
                      label: 'Shirt preview. Drag the art to move it. Pinch to make it bigger or smaller.',
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onScaleStart: (d) => _startW = _w,
                        onScaleUpdate: (d) => setState(() {
                          _w = _startW * d.scale;
                          _cx += d.focalPointDelta.dx / geo.ppi;
                          _cy += d.focalPointDelta.dy / geo.ppi;
                          _clampBox();
                        }),
                        child: CustomPaint(size: size, painter: ShirtPainter(scene)),
                      ),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(
              'Drag to move, pinch to resize · ${_w.toStringAsFixed(1)} × ${_h.toStringAsFixed(1)} in · $quality',
              textAlign: TextAlign.center,
              style: t(14, color: C.muted, w: FontWeight.w700),
            ),
            if (maxW - minW > 0.05)
              Slider(
                value: _cl(_w, minW, maxW),
                min: minW,
                max: maxW,
                onChanged: (v) => setState(() {
                  _w = v;
                  _clampBox();
                }),
              ),
            SizedBox(
              height: 52,
              child: ListView(scrollDirection: Axis.horizontal, children: [
                MerchPill(label: 'Front', selected: !_back, onTap: () => setState(() => _back = false)),
                const SizedBox(width: 8),
                MerchPill(label: 'Back', selected: _back, onTap: () => setState(() => _back = true)),
                const SizedBox(width: 16),
                for (final f in MerchFrame.values) ...[
                  MerchPill(
                    label: f.label,
                    selected: _frame == f,
                    onTap: () => setState(() {
                      _frame = f;
                      _clampBox();
                    }),
                  ),
                  const SizedBox(width: 8),
                ],
              ]),
            ),
            if (_colours.length > 1) ...[
              const SizedBox(height: 6),
              SizedBox(
                height: 56,
                child: ListView(scrollDirection: Axis.horizontal, children: [
                  for (final c in it.colours)
                    if (_colours.contains(c.name))
                      Padding(
                        padding: const EdgeInsets.only(right: 10),
                        child: _ColourDot(colour: c, selected: _previewColour == c.name, onTap: () => setState(() => _previewColour = c.name), compact: true),
                      ),
                ]),
              ),
            ],
          ]),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------------------------------------- step 4: price

  Widget _priceStep() {
    final it = _item;
    final cat = _cat;
    final bases = _bases;
    final m = _markupValue ?? 0;
    final validMarkup = _markupProblem == null;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
      children: [
        MerchField(label: 'Product name', controller: _title, hint: 'My first T-shirt', capitalization: TextCapitalization.sentences, formatters: [LengthLimitingTextInputFormatter(80)], onChanged: (_) => setState(() {})),
        MerchField(label: 'About it (optional)', controller: _desc, hint: 'A line or two for your fans', maxLines: 3, capitalization: TextCapitalization.sentences, formatters: [LengthLimitingTextInputFormatter(600)]),
        MerchField(
          label: 'Your markup per T-shirt (₹)',
          controller: _markup,
          keyboard: TextInputType.number,
          formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
          onChanged: (_) => setState(() {}),
        ),
        if (!validMarkup) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_markupProblem!, style: t(15, color: C.ruby, w: FontWeight.w700))),
        DesiCard(
          title: 'Your prices',
          note: 'Base price covers printing and delivery.',
          tone: DesiTone.gold,
          child: _quoting
              ? const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(color: C.maroon)))
              : (_quoteError != null
                  ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(_quoteError!, style: t(15, color: C.ruby, w: FontWeight.w700)),
                      const SizedBox(height: 8),
                      DesiButton('Try again', kind: DesiButtonKind.ghost, onTap: () => unawaited(_quote())),
                    ])
                  : Column(children: [
                      Row(children: [
                        SizedBox(width: 50, child: Text('Size', style: t(14, color: C.muted))),
                        Expanded(child: Text('Base', style: t(14, color: C.muted))),
                        Expanded(child: Text('Fan pays', style: t(14, color: C.muted))),
                        Expanded(child: Text('You earn', textAlign: TextAlign.right, style: t(14, color: C.muted))),
                      ]),
                      const SizedBox(height: 4),
                      if (it != null && bases != null)
                        for (final s in it.sizes)
                          if (bases.containsKey(s.size))
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: Row(children: [
                                SizedBox(width: 50, child: Text(s.size, style: t(16))),
                                Expanded(child: Text(merchRupees(bases[s.size] ?? 0), style: t(15, w: FontWeight.w700))),
                                Expanded(child: Text(validMarkup ? merchRupees((bases[s.size] ?? 0) + m * 100) : '—', style: t(15, w: FontWeight.w700))),
                                Expanded(
                                  child: Text(
                                    validMarkup && cat is AsyncData<MerchCatalog> ? merchRupees(cat.value.youEarnPaise(m)) : '—',
                                    textAlign: TextAlign.right,
                                    style: t(15, color: C.rani),
                                  ),
                                ),
                              ]),
                            ),
                    ])),
        ),
        const SizedBox(height: 12),
        Semantics(
          container: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => setState(() => _own = !_own),
            child: Container(
              constraints: const BoxConstraints(minHeight: 56),
              child: Row(children: [
                Checkbox(value: _own, activeColor: C.maroon, onChanged: (v) => setState(() => _own = v == true)),
                Expanded(child: Text('This art is mine, or I have the right to sell it.', style: t(15, w: FontWeight.w700))),
              ]),
            ),
          ),
        ),
        if (_publishing) ...[
          const SizedBox(height: 10),
          Row(children: [
            const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3)),
            const SizedBox(width: 12),
            Expanded(child: Text(_phase, style: t(15, color: C.muted, w: FontWeight.w700))),
          ]),
        ],
        if (_publishError != null) ...[
          const SizedBox(height: 10),
          Text(_publishError!, style: t(15, color: C.ruby, w: FontWeight.w700)),
        ],
      ],
    );
  }

  Widget _doneView(MerchProduct p) {
    final review = p.status != 'live';
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        DesiCard(
          tone: DesiTone.plum,
          corner: DesiCorner.yellow,
          title: review ? 'Sent for review' : 'Your product is live',
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              review
                  ? 'Our team checks every new design before it goes on sale. We will tell you as soon as it is live on your page.'
                  : 'Fans can now buy it from your page.',
              style: t(16, color: C.white, w: FontWeight.w700, h: 1.35),
            ),
          ]),
        ),
        const SizedBox(height: 14),
        Row(children: [
          MerchThumb(p.imageUrl, size: 84),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p.title, style: t(18)),
              const SizedBox(height: 6),
              merchProductChip(p.status),
            ]),
          ),
        ]),
        const SizedBox(height: 18),
        DesiButton('Back to My merch', icon: Icons.checkroom_rounded, kind: DesiButtonKind.rani, expand: true, onTap: () => context.pop(true)),
      ],
    );
  }
}

class _ShirtOption extends StatelessWidget {
  const _ShirtOption({required this.item, required this.selected, required this.onTap});

  final CatalogItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: item.name,
      child: Material(
        color: C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: BorderSide(color: selected ? C.rani : C.line, width: selected ? 3 : 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              MerchThumb(item.mockupUrl, size: 64),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(item.name, style: t(17)),
                  const SizedBox(height: 2),
                  Text(item.fromPaise > 0 ? 'Base price from ${merchRupees(item.fromPaise)}' : 'Base price on the next step', style: t(14, color: C.muted, w: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Row(children: [
                    for (final c in item.colours.take(8))
                      Container(
                        width: 16,
                        height: 16,
                        margin: const EdgeInsets.only(right: 4),
                        decoration: BoxDecoration(shape: BoxShape.circle, color: merchColour(c.hex), border: Border.all(color: C.brass)),
                      ),
                  ]),
                ]),
              ),
              if (selected) const Icon(Icons.check_circle_rounded, color: C.rani),
            ]),
          ),
        ),
      ),
    );
  }
}

class _ColourDot extends StatelessWidget {
  const _ColourDot({required this.colour, required this.selected, required this.onTap, this.compact = false});

  final MerchColour colour;
  final bool selected;
  final VoidCallback onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final fill = merchColour(colour.hex);
    return Semantics(
      button: true,
      selected: selected,
      label: colour.name,
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: SizedBox(
          width: compact ? 52 : 68,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(shape: BoxShape.circle, color: fill, border: Border.all(color: selected ? C.rani : C.brass, width: selected ? 4 : 1.5)),
              child: selected ? Icon(Icons.check_rounded, size: 22, color: fill.computeLuminance() > 0.5 ? C.deep : C.white) : null,
            ),
            if (!compact) Text(colour.name, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700)),
          ]),
        ),
      ),
    );
  }
}
