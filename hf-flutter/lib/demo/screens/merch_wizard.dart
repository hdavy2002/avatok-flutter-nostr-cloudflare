import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/merch_art_picker.dart';
import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../desi.dart';
import '../merch_designer/designer.dart';
import '../merch_kit.dart';
import '../theme.dart';
import '../widgets.dart';
import 'merch_ai_sheet.dart';
import 'merch_product_pick.dart';

enum _Step { art, product, design, price }

/// [HF-MERCH-STUDIO-2] "+ New product": Your art (upload or AI) -> Product -> Design (layers studio) -> Price and publish.
/// Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md. The picture tray, the product choices and the design are kept across steps.
/// The print file and the mockups are made by the designer; the money logic (quote, markup, you-earn) is unchanged from v1.
class MerchWizardScreen extends StatefulWidget {
  const MerchWizardScreen({super.key, this.repo});

  final MerchRepo? repo;

  @override
  State<MerchWizardScreen> createState() => _MerchWizardScreenState();
}

class _MerchWizardScreenState extends State<MerchWizardScreen> {
  _Step _step = _Step.art;
  bool _leaving = false;
  bool _madeAny = false;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  // step 1: art
  final List<StudioArt> _arts = <StudioArt>[];
  final List<String> _picked = <String>[];
  AiInfo? _ai;
  bool _busyArt = false;
  String? _artError;
  bool _own = false;
  bool _refUsed = false;

  // step 2: product
  AsyncState<MerchCatalog> _cat = const AsyncLoading();
  CatalogItem? _item;
  String _side = 'front';
  final Set<String> _colours = <String>{};
  final Set<String> _sizes = <String>{};

  // step 3: design
  List<DesignLayer>? _layers;
  DesignResult? _design;
  String _sig = '';

  // step 4: price
  final TextEditingController _title = TextEditingController();
  final TextEditingController _desc = TextEditingController();
  final TextEditingController _markup = TextEditingController(text: '100');
  Map<String, int>? _bases;
  Map<String, QuoteLine> _lines = const <String, QuoteLine>{};
  bool _quoting = false;
  String? _quoteError;
  bool _publishing = false;
  String? _publishError;
  MerchProduct? _done;

  @override
  void initState() {
    super.initState();
    merchEvent('merch_studio_step', {'step': _Step.art.name});
    unawaited(_loadCatalog());
    unawaited(_loadAi());
  }

  @override
  void dispose() {
    _title.dispose();
    _desc.dispose();
    _markup.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------------------------- tray

  bool get _aiOn => _ai?.enabled == true;
  bool get _ownRequired => _refUsed || _arts.any((a) => a.source == 'upload');
  bool get _ownOk => !_ownRequired || _own;

  Future<void> _loadAi() async {
    try {
      final info = await _repo.aiInfo();
      if (!mounted) return;
      setState(() {
        _ai = info;
        for (final g in info.recent) {
          if (_arts.every((a) => a.artId != g.art.artId)) _arts.add(StudioArt(art: g.art, source: 'ai', label: g.prompt));
        }
      });
    } catch (_) {
      if (mounted) setState(() => _ai = null); // AI is off or unreachable: the AI choice stays hidden
    }
  }

  void _addToTray(StudioArt a, {bool select = false}) {
    setState(() {
      if (_arts.every((x) => x.artId != a.artId)) _arts.insert(0, a);
      if (select && !_picked.contains(a.artId)) _picked.add(a.artId);
    });
  }

  void _togglePicked(StudioArt a) {
    setState(() {
      if (!_picked.remove(a.artId)) _picked.add(a.artId);
    });
  }

  void _removeFromTray(StudioArt a) {
    setState(() {
      _arts.removeWhere((x) => x.artId == a.artId);
      _picked.remove(a.artId);
    });
  }

  List<StudioArt> _designerArts() {
    final byId = {for (final a in _arts) a.artId: a};
    final out = <StudioArt>[
      for (final id in _picked)
        if (byId[id] != null) byId[id]!,
    ];
    for (final a in _arts) {
      if (!_picked.contains(a.artId)) out.add(a);
    }
    return out;
  }

  /// Gallery -> upload. Adds the picture to the tray; returns it, or null when nothing was added (the reason is shown).
  Future<StudioArt?> _pickAndUpload({bool select = true}) async {
    if (_busyArt) return null;
    setState(() {
      _busyArt = true;
      _artError = null;
    });
    String? problem;
    StudioArt? made;
    try {
      final picked = await MerchArtPicker.pick();
      if (picked != null) {
        final up = await _repo.uploadArt(picked.bytes, contentType: picked.mime, fileName: picked.name);
        made = StudioArt(art: up, source: 'upload', bytes: picked.bytes, label: picked.name);
      }
    } on PlatformException catch (e) {
      problem = e.code == 'too_large' ? 'The picture must be 15 MB or smaller.' : 'Could not open that picture. Try another one.';
    } on ApiException catch (e) {
      problem = e.userMessage;
    } catch (e, st) {
      merchCapture(e, st, 'art');
      problem = 'Could not read that picture. Try another one.';
    }
    if (!mounted) return null;
    final err = problem;
    setState(() {
      _busyArt = false;
      _artError = err;
    });
    if (err != null) toast(context, err);
    if (made != null) _addToTray(made, select: select);
    return made;
  }

  Future<void> _openAi() async {
    final info = _ai;
    if (info == null || !info.enabled) return;
    merchEvent('merch_ai', {'action': 'open'});
    await showMerchAiSheet(
      context,
      repo: _repo,
      info: info,
      tray: List<StudioArt>.of(_arts),
      pickReference: () => _pickAndUpload(select: false),
      onArt: (a) => _addToTray(a),
      onUse: (a) => _addToTray(a, select: true),
      onRefsUsed: () {
        if (mounted && !_refUsed) setState(() => _refUsed = true);
      },
      onAddMoney: () async {
        await context.push<void>('/topup');
      },
    );
    if (mounted) unawaited(_loadAi());
  }

  /// "More art" from the designer: the same two choices, without losing the layers.
  Future<void> _moreArt() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: C.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Add another picture', style: t(22, color: C.maroon)),
            const SizedBox(height: 12),
            MerchChoiceCard(icon: Icons.photo_library_rounded, title: 'Upload art or photo', sub: 'From your phone gallery', tone: DesiTone.lav, onTap: () => Navigator.of(ctx).pop('upload')),
            if (_aiOn) ...[
              const SizedBox(height: 12),
              MerchChoiceCard(icon: Icons.auto_awesome_rounded, title: 'Create with AI', sub: _aiPriceText(), tone: DesiTone.gold, onTap: () => Navigator.of(ctx).pop('ai')),
            ],
          ]),
        ),
      ),
    );
    if (!mounted) return;
    if (choice == 'upload') {
      await _pickAndUpload();
    } else if (choice == 'ai') {
      await _openAi();
    }
  }

  String _aiPriceText() {
    final c = _ai?.chargePaise ?? 0;
    return c <= 0 ? 'Free right now' : '${merchRupees(c)} per picture';
  }

  // ---------------------------------------------------------------------------------------------- product

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
      _side = it.sides.contains('front') || it.sides.isEmpty ? 'front' : it.sides.first;
      _colours
        ..clear()
        ..addAll(it.colours.isEmpty ? const <String>[] : [it.colours.first.name]);
      _sizes
        ..clear()
        ..addAll(it.sizes.map((s) => s.size));
      _bases = null;
    });
    merchEvent('merch_studio_step', {'step': 'product_chosen', 'catalog': it.id});
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
    final d = _design;
    if (it == null || d == null) return;
    setState(() {
      _quoting = true;
      _quoteError = null;
    });
    try {
      final sizesInOrder = [for (final s in it.sizes) if (_sizes.contains(s.size)) s.size];
      final lines = <String, QuoteLine>{};
      final b = await _repo.quote(catalogId: it.id, colours: _colours.toList(), side: _side, wIn: d.wIn, hIn: d.hIn, sizes: sizesInOrder, breakdownOut: lines);
      if (mounted) {
        setState(() {
          _bases = b;
          _lines = lines;
          _quoting = false;
          if (b.isEmpty) _quoteError = 'That product cannot be priced in those colours right now.';
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
      !_publishing && !_quoting && (_bases?.isNotEmpty ?? false) && _title.text.trim().length >= 2 && _markupProblem == null && _ownOk;

  double _r2(double v) => (v * 100).round() / 100;

  Future<void> _publish() async {
    final it = _item;
    final d = _design;
    final bases = _bases;
    final markup = _markupValue;
    if (it == null || d == null || bases == null || markup == null) return;
    final sizes = [for (final s in it.sizes) if (bases.containsKey(s.size)) s.size];
    setState(() {
      _publishing = true;
      _publishError = null;
    });
    try {
      final product = await _repo.createProduct({
        'title': _title.text.trim(),
        if (_desc.text.trim().isNotEmpty) 'description': _desc.text.trim(),
        'catalogId': it.id,
        'colours': _colours.toList(),
        'sizes': sizes,
        'side': _side,
        'placement': {'frame': 'rect', 'x': _r2(d.leftIn), 'y': _r2(d.topIn), 'w': _r2(d.wIn), 'h': _r2(d.hIn), 'zoom': 100},
        'artId': d.artId,
        'printFileId': d.printFileId,
        'markupRupees': markup,
        'ownArtConfirmed': true,
        if (d.mockupUrls.isNotEmpty) 'mockupUrls': d.mockupUrls,
      });
      merchEvent('merch_studio_step', {'step': 'published', 'status': product.status, 'catalog': it.id});
      if (mounted) {
        setState(() {
          _publishing = false;
          _madeAny = true;
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
          _publishError = 'Something went wrong while saving your product. Please try again.';
        });
      }
    }
  }

  void _again() {
    setState(() {
      _done = null;
      _step = _Step.art;
      _picked.clear();
      _item = null;
      _colours.clear();
      _sizes.clear();
      _layers = null;
      _design = null;
      _sig = '';
      _bases = null;
      _publishError = null;
      _title.clear();
      _desc.clear();
      _markup.text = '100';
    });
    merchEvent('merch_studio_step', {'step': _Step.art.name, 'again': true});
  }

  // ---------------------------------------------------------------------------------------------- navigation

  bool get _hasWork => _picked.isNotEmpty || _item != null;

  void _exit() {
    setState(() => _leaving = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.pop(_madeAny);
    });
  }

  Future<void> _back() async {
    if (_publishing || _leaving) return;
    if (_done != null) {
      _exit();
      return;
    }
    switch (_step) {
      case _Step.art:
        if (!_hasWork) {
          _exit();
          return;
        }
        final ok = await hfConfirm(
          context,
          title: 'Leave this product?',
          body: 'The pictures you picked and your choices will be lost.',
          confirmLabel: 'Leave',
          cancelLabel: 'Stay',
          destructive: true,
        );
        if (ok && mounted) _exit();
      case _Step.product:
        _goto(_Step.art);
      case _Step.design:
        _goto(_Step.product);
      case _Step.price:
        _goto(_Step.design);
    }
  }

  void _goto(_Step s) {
    if (s == _Step.design) {
      final it = _item;
      final sig = it == null ? '' : '${it.id}|$_side';
      if (sig != _sig) {
        _layers = null; // another product or side: the old layers do not fit its print area
        _design = null;
        _sig = sig;
      }
    }
    setState(() {
      _step = s;
      if (s == _Step.price) {
        _bases = null;
      }
    });
    merchEvent('merch_studio_step', {'step': s.name});
    if (s == _Step.price) unawaited(_quote());
  }

  void _onDesignDone(DesignResult r) {
    setState(() {
      _design = r;
      _layers = r.layers;
    });
    _goto(_Step.price);
  }

  bool get _canNext => switch (_step) {
        _Step.art => _picked.isNotEmpty && !_busyArt && _ownOk,
        _Step.product => _item != null && _colours.isNotEmpty && _sizes.isNotEmpty,
        _ => false,
      };

  // ---------------------------------------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    final done = _done;
    return PopScope<Object?>(
      canPop: _leaving,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_back());
      },
      child: Scaffold(
        backgroundColor: C.ivory,
        body: SafeArea(
          child: Column(children: [
            MerchHeader('New product', onBack: () => unawaited(_back())),
            if (done == null) MerchStepper(current: _step.index, compact: _step == _Step.design, onTap: (i) {
              if (!_publishing) _goto(_Step.values[i]);
            }),
            Expanded(child: done != null ? _doneView(done) : _body()),
            if (done == null && (_step == _Step.art || _step == _Step.product || _step == _Step.price)) _bottomBar(),
          ]),
        ),
      ),
    );
  }

  Widget _body() => switch (_step) {
        _Step.art => _artStep(),
        _Step.product => _productStep(),
        _Step.design => _designStep(),
        _Step.price => _priceStep(),
      };

  Widget _bottomBar() {
    final price = _step == _Step.price;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      decoration: const BoxDecoration(color: C.ivory, border: Border(top: BorderSide(color: C.line))),
      child: Row(children: [
        if (_step != _Step.art) ...[
          DesiButton('Back', kind: DesiButtonKind.ghost, onTap: _publishing ? null : () => unawaited(_back())),
          const SizedBox(width: 10),
        ],
        Expanded(
          child: price
              ? DesiButton(_publishing ? 'Please wait…' : 'Publish', icon: Icons.check_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _canPublish ? () => unawaited(_publish()) : null)
              : DesiButton('Next', icon: Icons.arrow_forward_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _canNext ? () => _goto(_step == _Step.art ? _Step.product : _Step.design) : null),
        ),
      ]),
    );
  }

  // ---------------------------------------------------------------------------------------------- step 1: art

  Widget _ownBox() {
    return Semantics(
      container: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => setState(() => _own = !_own),
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          child: Row(children: [
            Checkbox(value: _own, activeColor: C.maroon, onChanged: (v) => setState(() => _own = v == true)),
            Expanded(child: Text('I own these pictures, or I have the right to sell them on products.', style: t(15, w: FontWeight.w700))),
          ]),
        ),
      ),
    );
  }

  Widget _artStep() {
    final warnings = <String>{
      for (final a in _arts)
        if (_picked.contains(a.artId)) ...a.art.warnings,
    };
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
      children: [
        Text('Start with a picture. A PNG with a see-through background prints best. JPEG or PNG, up to 15 MB.', style: t(15, color: C.muted, w: FontWeight.w700)),
        const SizedBox(height: 14),
        MerchChoiceCard(
          icon: Icons.photo_library_rounded,
          title: 'Upload art or photo',
          sub: 'From your phone gallery',
          tone: DesiTone.lav,
          busy: _busyArt,
          onTap: _busyArt ? null : () => unawaited(_pickAndUpload()),
        ),
        if (_aiOn) ...[
          const SizedBox(height: 12),
          MerchChoiceCard(icon: Icons.auto_awesome_rounded, title: 'Create with AI', sub: _aiPriceText(), tone: DesiTone.gold, corner: DesiCorner.marigold, onTap: _busyArt ? null : () => unawaited(_openAi())),
        ],
        if (_artError != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_artError!, style: t(15, color: C.ruby, w: FontWeight.w700))),
        const SizedBox(height: 20),
        Text('My pictures', style: t(18, color: C.maroon)),
        const SizedBox(height: 2),
        Text(_arts.isEmpty ? 'Your pictures will show here.' : 'Tap a picture to use it. Tap the cross to remove it.', style: t(14, color: C.muted, w: FontWeight.w700)),
        const SizedBox(height: 14),
        if (_arts.isNotEmpty)
          Wrap(spacing: 16, runSpacing: 16, children: [
            for (final a in _arts)
              MerchArtThumb(
                a,
                size: 96,
                selected: _picked.contains(a.artId),
                onTap: () => _togglePicked(a),
                onRemove: () => _removeFromTray(a),
                semanticLabel: a.source == 'ai' ? 'AI picture' : 'Your picture',
              ),
          ]),
        for (final w in warnings) MerchNote(w),
        if (_ownRequired) ...[
          const SizedBox(height: 14),
          _ownBox(),
        ],
        if (_arts.isNotEmpty && _picked.isEmpty)
          const Padding(padding: EdgeInsets.only(top: 8), child: MerchNote('Pick at least one picture to go on.', icon: Icons.touch_app_rounded, color: C.maroon)),
      ],
    );
  }

  // ---------------------------------------------------------------------------------------------- step 2: product

  Widget _productStep() {
    return AsyncView<MerchCatalog>(
      state: _cat,
      onRetry: () => unawaited(_loadCatalog()),
      emptyTitle: 'No products yet',
      emptyMessage: 'Products are not available right now. Please try again in a little while.',
      isEmpty: (c) => c.items.isEmpty,
      builder: (context, cat) => MerchProductPick(
        items: cat.items,
        item: _item,
        side: _side,
        colours: _colours,
        sizes: _sizes,
        onItem: _chooseItem,
        onSide: (s) => setState(() {
          _side = s;
          _bases = null;
        }),
        onColour: _toggleColour,
        onSize: _toggleSize,
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------- step 3: design

  Widget _designStep() {
    final it = _item;
    if (it == null) return const SizedBox.shrink();
    return MerchDesigner(
      key: ValueKey<String>('designer-$_sig'),
      repo: _repo,
      item: it,
      side: _side,
      colours: [for (final c in it.colours) if (_colours.contains(c.name)) c],
      arts: _designerArts(),
      onArtAdded: (a) => _addToTray(a, select: true),
      onWantMoreArt: () => unawaited(_moreArt()),
      initialLayers: _layers,
      onLayersChange: (l) => _layers = l,
      onBack: () => _goto(_Step.product),
      onDone: _onDesignDone,
    );
  }

  // ---------------------------------------------------------------------------------------------- step 4: price

  Widget _priceStep() {
    final it = _item;
    final d = _design;
    final cat = _cat;
    final bases = _bases;
    final m = _markupValue ?? 0;
    final validMarkup = _markupProblem == null;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
      children: [
        if (d != null) MerchGallery(urls: d.mockupUrls, previewPng: d.previewPng, wIn: d.wIn, hIn: d.hIn),
        const SizedBox(height: 16),
        MerchField(label: 'Product name', controller: _title, hint: 'My first product', capitalization: TextCapitalization.sentences, formatters: [LengthLimitingTextInputFormatter(80)], onChanged: (_) => setState(() {})),
        MerchField(label: 'About it (optional)', controller: _desc, hint: 'A line or two for your fans', maxLines: 3, capitalization: TextCapitalization.sentences, formatters: [LengthLimitingTextInputFormatter(600)]),
        MerchField(
          label: 'Your markup per item (₹)',
          controller: _markup,
          keyboard: TextInputType.number,
          formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
          onChanged: (_) => setState(() {}),
        ),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final v in const [50, 100, 150, 200, 300, 500])
            if (v >= _minMarkup) MerchPill(label: '₹$v', selected: _markupValue == v, onTap: () => setState(() => _markup.text = '$v')),
        ]),
        if (!validMarkup) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_markupProblem!, style: t(15, color: C.ruby, w: FontWeight.w700))),
        const SizedBox(height: 14),
        DesiCard(
          title: 'Your prices',
          note: 'Base price = printing (incl. GST) + shipping. Fans pay one price, incl. GST & delivery.',
          tone: DesiTone.gold,
          child: _quoting
              ? const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(color: C.maroon)))
              : (_quoteError != null
                  ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(_quoteError!, style: t(15, color: C.ruby, w: FontWeight.w700)),
                      const SizedBox(height: 8),
                      DesiButton('Try again', kind: DesiButtonKind.ghost, onTap: () => unawaited(_quote())),
                    ])
                  : MerchPriceTable(item: it, bases: bases, lines: _lines, markup: m, valid: validMarkup, catalog: cat is AsyncData<MerchCatalog> ? cat.value : null)),
        ),
        if (_ownRequired) ...[
          const SizedBox(height: 12),
          _ownBox(),
        ],
        if (_publishing) ...[
          const SizedBox(height: 10),
          Row(children: [
            const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3)),
            const SizedBox(width: 12),
            Expanded(child: Text('Saving your product…', style: t(15, color: C.muted, w: FontWeight.w700))),
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
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        const MerchCelebrate(),
        const SizedBox(height: 8),
        DesiCard(
          tone: DesiTone.plum,
          corner: DesiCorner.yellow,
          title: review ? 'Sent for review' : 'Your product is live!',
          child: Text(
            review
                ? 'Our team checks every new design before it goes on sale. We will tell you as soon as it is live on your page.'
                : 'Fans can now buy it from your page.',
            style: t(16, color: C.white, w: FontWeight.w700, h: 1.35),
          ),
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
        DesiButton('Back to my products', icon: Icons.storefront_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _exit),
        const SizedBox(height: 10),
        DesiButton('Make another', icon: Icons.add_rounded, kind: DesiButtonKind.ghost, expand: true, onTap: _again),
      ],
    );
  }
}
