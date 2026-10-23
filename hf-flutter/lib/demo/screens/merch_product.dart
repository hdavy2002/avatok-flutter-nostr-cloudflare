import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../data/models/bag.dart';
import '../../data/models/merch.dart';
import '../../data/repos/channel_repo.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../../ui/net_image.dart';
import '../bag_kit.dart';
import '../channel_pop_kit.dart';
import '../merch_canvas.dart';
import '../merch_kit.dart';
import '../theme.dart';
import '../widgets.dart';
import 'bag.dart';

/// One merch product, built to the owner-approved phone mock PhoneProduct ([HF-CHANNEL-APP-1]): full-width picture pager, the
/// influencer's name, title, price with "GST + free delivery included", colours, sizes (only when the product has them),
/// quantity, a pincode check, two trust cards, an accordion, and a bar with Add to bag / Buy now.
/// Opened at `/merch/p/:host/:slug`; [initial] (from the channel tile) shows the page at once while the full product loads.
class MerchProductScreen extends StatefulWidget {
  const MerchProductScreen({super.key, required this.hostSlug, required this.productSlug, this.initial, this.repo});

  final String hostSlug;
  final String productSlug;
  final ChannelProduct? initial;
  final MerchRepo? repo;

  @override
  State<MerchProductScreen> createState() => _MerchProductScreenState();
}

class _MerchProductScreenState extends State<MerchProductScreen> {
  AsyncState<PublicProductPage> _state = const AsyncLoading();
  final PageController _pager = PageController();
  final TextEditingController _pin = TextEditingController();
  int _photo = 0;
  int _colour = 0;
  String? _size;
  int _qty = 1;
  PincodeCheck? _pinResult;
  bool _pinBusy = false;
  String? _pinError;
  bool _busy = false;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _pager.dispose();
    _pin.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final page = await _repo.publicProduct(widget.hostSlug, widget.productSlug);
      if (!mounted) return;
      setState(() {
        _state = AsyncData(page);
        _qty = 1;
        _colour = 0;
        _size = null;
        for (final s in page.product.sizes) {
          if (s.inStock) {
            _size = s.size;
            break;
          }
        }
      });
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _checkPin() async {
    final v = _pin.text.trim();
    if (!RegExp(r'^[1-9][0-9]{5}$').hasMatch(v)) {
      setState(() {
        _pinResult = null;
        _pinError = 'Enter a 6 digit pincode.';
      });
      return;
    }
    setState(() {
      _pinBusy = true;
      _pinError = null;
    });
    try {
      final r = await _repo.pincode(v);
      if (mounted) setState(() => _pinResult = r);
    } catch (e) {
      if (mounted) setState(() => _pinError = merchErrorText(e));
    } finally {
      if (mounted) setState(() => _pinBusy = false);
    }
  }

  BagLine? _line(PublicProductPage page) => bagLineFor(
        host: page.host,
        hostSlug: widget.hostSlug,
        product: page.product,
        category: widget.initial?.category ?? '',
        colour: page.product.colours.isEmpty ? null : page.product.colours[_colour.clamp(0, page.product.colours.length - 1)].name,
        size: _size,
        qty: _qty,
      );

  Future<void> _addToBag(PublicProductPage page) async {
    final line = _line(page);
    if (line == null) {
      toast(context, 'Please pick a size that is in stock.');
      return;
    }
    setState(() => _busy = true);
    await addLineToBag(context, line, surface: 'product');
    if (mounted) setState(() => _busy = false);
  }

  void _buyNow(PublicProductPage page) {
    final line = _line(page);
    if (line == null) {
      toast(context, 'Please pick a size that is in stock.');
      return;
    }
    unawaited(context.push<Object?>('/bag/checkout', extra: BagCheckoutArgs(lines: [line], fromBag: false)));
  }

  @override
  Widget build(BuildContext context) {
    final s = _state;
    final page = s is AsyncData<PublicProductPage> ? s.value : null;
    final hostName = page?.host.displayName ?? '';
    return Scaffold(
      backgroundColor: GP.bg,
      body: Column(children: [
        GpHeader(title: hostName.isEmpty ? 'Merch' : '$hostName’s merch'),
        Expanded(
          child: page == null
              ? AsyncView<PublicProductPage>(state: s, onRetry: () => unawaited(_load()), builder: (_, __) => const SizedBox.shrink())
              : _body(page),
        ),
      ]),
      bottomNavigationBar: page == null ? null : _bar(page),
    );
  }

  Widget _bar(PublicProductPage page) {
    if (!page.checkoutEnabled) {
      return GpBottomBar(child: GpButton('Buying opens soon', kind: GpBtn.ink, onTap: null));
    }
    return GpBottomBar(
      child: Row(children: [
        Expanded(child: GpButton('Add to bag', kind: GpBtn.ink, onTap: _busy ? null : () => unawaited(_addToBag(page)))),
        const SizedBox(width: 12),
        Expanded(child: GpButton('Buy now', onTap: () => _buyNow(page))),
      ]),
    );
  }

  List<String> _photos(PublicProduct p) {
    final all = <String>[
      ...p.photos,
      if (p.photos.isEmpty && (p.imageUrl ?? '').isNotEmpty) p.imageUrl!,
    ];
    return all;
  }

  Widget _body(PublicProductPage page) {
    final p = page.product;
    final photos = _photos(p);
    final colour = p.colours.isEmpty ? null : p.colours[_colour.clamp(0, p.colours.length - 1)];
    PublicSize? size;
    for (final x in p.sizes) {
      if (x.size == _size) size = x;
    }
    final minPrice = p.sizes.isEmpty ? 0 : p.sizes.map((e) => e.pricePaise).reduce((a, b) => a < b ? a : b);
    final unit = size?.pricePaise ?? p.fromPaise;
    final category = widget.initial?.category ?? '';
    return ListView(padding: EdgeInsets.zero, children: [
      AspectRatio(
        aspectRatio: 1,
        child: Stack(fit: StackFit.expand, children: [
          ColoredBox(
            color: GP.tile,
            child: photos.isEmpty
                ? Center(child: Icon(gpCategoryIcon(category), size: 96, color: GP.muted))
                : PageView.builder(
                    controller: _pager,
                    itemCount: photos.length,
                    onPageChanged: (i) => setState(() => _photo = i),
                    itemBuilder: (_, i) => Semantics(
                      image: true,
                      label: '${p.title}, picture ${i + 1} of ${photos.length}',
                      child: NetImage(photos[i], fallback: Center(child: Icon(gpCategoryIcon(category), size: 96, color: GP.muted))),
                    ),
                  ),
          ),
          if (photos.length > 1)
            Positioned(
              left: 0,
              right: 0,
              bottom: 14,
              child: ExcludeSemantics(
                child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  for (var i = 0; i < photos.length; i++)
                    Container(
                      width: i == _photo ? 22 : 8,
                      height: 8,
                      margin: const EdgeInsets.symmetric(horizontal: 3),
                      decoration: BoxDecoration(color: i == _photo ? GP.ink : GP.inputLine, borderRadius: BorderRadius.circular(9)),
                    ),
                ]),
              ),
            ),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => context.canPop() ? context.pop() : unawaited(context.push<Object?>('/profile/${Uri.encodeComponent(widget.hostSlug)}')),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                ClipOval(
                  child: SizedBox(
                    width: 30,
                    height: 30,
                    child: (page.host.avatarUrl ?? '').isEmpty
                        ? const ColoredBox(color: GP.tile, child: Icon(Icons.person_rounded, size: 20, color: GP.muted))
                        : NetImage(page.host.avatarUrl!, fallback: const ColoredBox(color: GP.tile)),
                  ),
                ),
                const SizedBox(width: 10),
                Flexible(child: Text('By ${page.host.displayName}', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, color: GP.ink, w: FontWeight.w800))),
              ]),
            ),
          ),
          const SizedBox(height: 4),
          Semantics(header: true, child: Text(p.title, style: t(32, color: GP.ink, w: FontWeight.w900, h: 1.1))),
          const SizedBox(height: 10),
          Text(merchRupees(unit), style: t(30, color: GP.red, w: FontWeight.w900, h: 1.1)),
          Text('GST + free delivery included', style: t(14, color: GP.muted, w: FontWeight.w700)),
          if (colour != null) ...[
            _label('Colour: ${colour.name}'),
            Wrap(spacing: 12, runSpacing: 8, children: [
              for (var i = 0; i < p.colours.length; i++) _swatch(p.colours[i], i == _colour, () => setState(() => _colour = i)),
            ]),
          ],
          if (p.sizes.isNotEmpty) ...[
            _label('Size'),
            Wrap(spacing: 10, runSpacing: 10, children: [
              for (final x in p.sizes) _sizeChip(x, x.size == _size, x.pricePaise - minPrice),
            ]),
          ],
          _label('Quantity'),
          Align(alignment: Alignment.centerLeft, child: GpQty(value: _qty, max: p.maxQty, onChanged: (v) => setState(() => _qty = v))),
          _label('Delivery'),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: TextField(
                controller: _pin,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                style: t(17, color: GP.ink, w: FontWeight.w700),
                onSubmitted: (_) => unawaited(_checkPin()),
                decoration: _fieldDecoration('Enter pincode'),
              ),
            ),
            const SizedBox(width: 10),
            SizedBox(width: 110, child: GpButton(_pinBusy ? '…' : 'Check', kind: GpBtn.outline, onTap: _pinBusy ? null : () => unawaited(_checkPin()))),
          ]),
          if (_pinError != null || _pinResult != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _pinError ??
                    (_pinResult!.deliverable
                        ? 'We deliver there${_pinResult!.etaDays == null ? '' : ' in about ${_pinResult!.etaDays} days'}.'
                        : 'We cannot deliver to that pincode yet.'),
                style: t(15, color: _pinError == null && _pinResult!.deliverable ? GP.blue : GP.redDeep, w: FontWeight.w800),
              ),
            ),
          const SizedBox(height: 16),
          _trust('Free delivery', 'Anywhere in India'),
          const SizedBox(height: 10),
          _trust('We fix mistakes', 'Wrong or damaged? Tell us in 48 hrs'),
          const SizedBox(height: 16),
          _Accordion(
            title: 'About this item',
            initiallyOpen: true,
            body: p.description.trim().isEmpty ? 'Made for you, once you order. Printed with the influencer’s design.' : p.description.trim(),
          ),
          const _Accordion(
            title: 'Delivery & returns',
            body: 'Free delivery anywhere in India. Made to order, so no returns for a change of mind. If it arrives wrong or damaged, tell us within 48 hours of delivery and we will fix it.',
          ),
        ]),
      ),
    ]);
  }

  Widget _label(String text) => Padding(padding: const EdgeInsets.only(top: 20, bottom: 10), child: Text(text, style: t(16, color: GP.ink, w: FontWeight.w900)));

  InputDecoration _fieldDecoration(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: t(16, color: GP.muted, w: FontWeight.w700),
        filled: true,
        fillColor: GP.paper,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: GP.inputLine, width: 2)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: GP.blue, width: 2)),
      );

  Widget _swatch(MerchColour c, bool on, VoidCallback onTap) {
    final fill = merchColour(c.hex);
    return Semantics(
      button: true,
      selected: on,
      label: c.name,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Container(
          width: 48,
          height: 48,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, color: fill, border: Border.all(color: on ? GP.ink : GP.inputLine, width: on ? 4 : 2)),
          child: on ? Icon(Icons.check_rounded, size: 22, color: fill.computeLuminance() > 0.5 ? GP.ink : GP.paper) : null,
        ),
      ),
    );
  }

  Widget _sizeChip(PublicSize x, bool on, int extraPaise) {
    final out = !x.inStock;
    return Semantics(
      button: true,
      selected: on,
      enabled: !out,
      label: out ? '${x.size}, sold out' : x.size,
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: out ? null : () => setState(() => _size = x.size),
        child: Container(
          constraints: const BoxConstraints(minWidth: 56, minHeight: 56),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? GP.ink : GP.paper,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: on ? GP.ink : GP.inputLine, width: 2),
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(
              x.size,
              style: t(17, color: on ? GP.paper : (out ? GP.muted : GP.ink), w: FontWeight.w900).copyWith(decoration: out ? TextDecoration.lineThrough : null),
            ),
            if (extraPaise > 0) Text('+${merchRupees(extraPaise)}', style: t(14, color: on ? GP.yel : GP.muted, w: FontWeight.w800, h: 1.1)),
          ]),
        ),
      ),
    );
  }

  Widget _trust(String title, String sub) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(18), border: Border.all(color: GP.line, width: 2)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: t(17, color: GP.ink, w: FontWeight.w900)),
          const SizedBox(height: 2),
          Text(sub, style: t(15, color: GP.muted, w: FontWeight.w700, h: 1.3)),
        ]),
      );
}

/// A simple open / close block (the mock's `<details>`).
class _Accordion extends StatefulWidget {
  const _Accordion({required this.title, required this.body, this.initiallyOpen = false});

  final String title;
  final String body;
  final bool initiallyOpen;

  @override
  State<_Accordion> createState() => _AccordionState();
}

class _AccordionState extends State<_Accordion> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: GP.line))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Semantics(
          button: true,
          expanded: _open,
          child: InkWell(
            onTap: () => setState(() => _open = !_open),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 56),
              child: Row(children: [
                Expanded(child: Text(widget.title, style: t(17, color: GP.ink, w: FontWeight.w900))),
                Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: GP.ink),
              ]),
            ),
          ),
        ),
        if (_open) Padding(padding: const EdgeInsets.only(bottom: 14), child: Text(widget.body, style: t(15, color: GP.muted, w: FontWeight.w700, h: 1.4))),
      ]),
    );
  }
}
