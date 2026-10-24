import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/repos/wallet_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../../ui/net_image.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../merch_canvas.dart';
import '../../data/merch_art_picker.dart'; // [HF-APP-PARITY-MERCH-1]
import '../merch_kit.dart';
import '../merch_parity_kit.dart'; // [HF-APP-PARITY-MERCH-1]
import '../theme.dart';
import '../widgets.dart';
import 'bag.dart' show merchWhatsappRequiredText, resolveBagPayment; // [HF-APP-PARITY-MERCH-1] a paid bag payment empties the bag

/// [HF-MERCH-APP-1] The fan side of the merch shop: the "Merch" row on an influencer's page, the product sheet, checkout,
/// My orders and one order's tracker. Everything stays hidden until `/api/config` says `hfMerchEnabled`.

/// What the checkout screen is told when a fan taps Buy.
class MerchCheckoutArgs {
  const MerchCheckoutArgs({
    required this.host,
    required this.product,
    required this.colour,
    required this.size,
    required this.qty,
    required this.unitPaise,
  });

  final PublicHost host;
  final PublicProduct product;
  final String colour;
  final String size;
  final int qty;
  final int unitPaise;

  int get totalPaise => unitPaise * qty;
}

// ------------------------------------------------------------------------------------------------ the row on the influencer page

/// "Merch" under Book a call. Shows nothing while the shop is off, still loading, failed, or the influencer has no products.
class MerchProfileRow extends StatefulWidget {
  const MerchProfileRow({super.key, required this.slug, this.repo});

  /// The influencer's slug (the profile id).
  final String slug;
  final MerchRepo? repo;

  @override
  State<MerchProfileRow> createState() => _MerchProfileRowState();
}

class _MerchProfileRowState extends State<MerchProfileRow> {
  PublicShop? _shop;
  bool _loading = false;
  bool _viewed = false;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  @override
  void initState() {
    super.initState();
    MerchRepo.flags.addListener(_maybeLoad);
    unawaited(_repo.loadFlags().then((_) => _maybeLoad()));
    _maybeLoad();
  }

  @override
  void dispose() {
    MerchRepo.flags.removeListener(_maybeLoad);
    super.dispose();
  }

  void _maybeLoad() {
    if (!mounted || !MerchRepo.flags.value.enabled || _shop != null || _loading) return;
    unawaited(_load());
  }

  Future<void> _load() async {
    _loading = true;
    try {
      final s = await _repo.publicShop(widget.slug);
      if (!mounted) return;
      setState(() => _shop = s);
      if (s.products.isNotEmpty && !_viewed) {
        _viewed = true;
        merchEvent('merch_strip_viewed', {'count': s.products.length});
      }
    } catch (_) {
      // the row is an extra: a failed read just leaves it out
    } finally {
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final shop = _shop;
    if (!MerchRepo.flags.value.enabled || shop == null || shop.products.isEmpty) return const SizedBox.shrink();
    final first = shop.host.displayName.split(' ').first;
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: DesiCard(
        title: 'Merch',
        note: first.isEmpty ? 'T-shirts made for you' : 'T-shirts by $first',
        tone: DesiTone.cream,
        child: SizedBox(
          height: 158,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: shop.products.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (context, i) {
              final p = shop.products[i];
              return Semantics(
                button: true,
                label: '${p.title}, from ${merchRupees(p.fromPaise)}',
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () => unawaited(showMerchProduct(context, host: shop.host, product: p, checkoutEnabled: shop.checkoutEnabled, repo: widget.repo)),
                  child: SizedBox(
                    width: 104,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      MerchThumb(p.imageUrl, size: 104),
                      const SizedBox(height: 6),
                      Text(p.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14)),
                      Text('from ${merchRupees(p.fromPaise)}', style: t(14, color: C.rani)),
                      Text('incl. ${merchGstText(p.gstRateBps)} & free delivery', style: t(12, color: C.muted)),
                    ]),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------ product sheet

Future<void> showMerchProduct(
  BuildContext context, {
  required PublicHost host,
  required PublicProduct product,
  required bool checkoutEnabled,
  MerchRepo? repo,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: C.ivory,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
    builder: (_) => _ProductSheet(host: host, summary: product, checkoutEnabled: checkoutEnabled, repo: repo),
  );
}

class _ProductSheet extends StatefulWidget {
  const _ProductSheet({required this.host, required this.summary, required this.checkoutEnabled, this.repo});

  final PublicHost host;
  final PublicProduct summary;
  final bool checkoutEnabled;
  final MerchRepo? repo;

  @override
  State<_ProductSheet> createState() => _ProductSheetState();
}

class _ProductSheetState extends State<_ProductSheet> {
  late PublicProduct _p = widget.summary;
  late bool _checkout = widget.checkoutEnabled;
  int? _gstBps; // [HF-MERCH-GST-2] host-level fallback from the product page; the product's own rate wins
  int? get _rate => _p.gstRateBps ?? _gstBps;
  String _colour = '';
  String _size = '';
  int _qty = 1;
  int _photo = 0;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  @override
  void initState() {
    super.initState();
    _pickDefaults();
    merchEvent('merch_product_viewed', {'photos': _p.photos.length});
    unawaited(_load());
  }

  void _pickDefaults() {
    if (_colour.isEmpty && _p.colours.isNotEmpty) _colour = _p.colours.first.name;
    if (_size.isEmpty) {
      for (final s in _p.sizes) {
        if (s.inStock) {
          _size = s.size;
          break;
        }
      }
    }
  }

  Future<void> _load() async {
    try {
      final page = await _repo.publicProduct(widget.host.slug, widget.summary.slug);
      if (!mounted) return;
      setState(() {
        _p = page.product;
        _checkout = page.checkoutEnabled;
        _gstBps = page.gstRateBps;
        _pickDefaults();
        if (_qty > _p.maxQty) _qty = _p.maxQty;
      });
    } catch (_) {
      // the summary is enough to buy from
    }
  }

  int get _unit {
    for (final s in _p.sizes) {
      if (s.size == _size) return s.pricePaise;
    }
    return _p.fromPaise;
  }

  List<String> get _photos {
    if (_p.photos.isNotEmpty) return _p.photos;
    final u = _p.imageUrl;
    return u == null ? const <String>[] : [u];
  }

  void _buy() {
    merchEvent('merch_buy_clicked', {'qty': _qty, 'price_rupees': (_unit * _qty) ~/ 100});
    final args = MerchCheckoutArgs(host: widget.host, product: _p, colour: _colour, size: _size, qty: _qty, unitPaise: _unit);
    final router = GoRouter.of(context);
    unawaited(requireAccount(context, () {
      Navigator.of(context).pop();
      unawaited(router.push<Object?>('/merch/checkout', extra: args));
    }, reason: 'to buy this T-shirt'));
  }

  @override
  Widget build(BuildContext context) {
    final photos = _photos;
    final canBuy = _checkout && _size.isNotEmpty && _colour.isNotEmpty;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Semantics(header: true, child: Text(_p.title, style: t(22, color: C.maroon)))),
            IconButton(
              tooltip: 'Close',
              constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              onPressed: () => Navigator.of(context).pop(),
              icon: const Icon(Icons.close_rounded, color: C.maroon),
            ),
          ]),
          Text('by ${widget.host.displayName}', style: t(15, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(22),
            child: SizedBox(
              height: 300,
              child: photos.isEmpty
                  ? Container(color: C.sand, alignment: Alignment.center, child: const Icon(Icons.checkroom_rounded, size: 80, color: C.brassDark))
                  : Stack(children: [
                      PageView.builder(
                        itemCount: photos.length,
                        onPageChanged: (i) => setState(() => _photo = i),
                        itemBuilder: (_, i) => NetImage(
                          photos[i],
                          fit: BoxFit.contain,
                          fallback: Container(color: C.sand, alignment: Alignment.center, child: const Icon(Icons.checkroom_rounded, size: 80, color: C.brassDark)),
                        ),
                      ),
                      if (photos.length > 1)
                        Positioned(
                          left: 0,
                          right: 0,
                          bottom: 8,
                          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                            for (var i = 0; i < photos.length; i++)
                              Container(
                                width: 9,
                                height: 9,
                                margin: const EdgeInsets.symmetric(horizontal: 3),
                                decoration: BoxDecoration(shape: BoxShape.circle, color: i == _photo ? C.rani : C.brass),
                              ),
                          ]),
                        ),
                    ]),
            ),
          ),
          if (_p.description.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(_p.description, style: t(16, w: FontWeight.w600, h: 1.35)),
          ],
          if (_p.colours.isNotEmpty) ...[
            const SizedBox(height: 14),
            Text('Colour: $_colour', style: t(16, color: C.maroon)),
            const SizedBox(height: 8),
            Wrap(spacing: 10, runSpacing: 10, children: [
              for (final c in _p.colours) _Swatch(colour: c, selected: c.name == _colour, onTap: () => setState(() => _colour = c.name)),
            ]),
          ],
          const SizedBox(height: 14),
          Text('Size', style: t(16, color: C.maroon)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final s in _p.sizes)
              Opacity(
                opacity: s.inStock ? 1 : 0.45,
                child: MerchPill(label: s.inStock ? s.size : '${s.size} · sold out', selected: s.size == _size, onTap: () {
                  if (s.inStock) setState(() => _size = s.size);
                }),
              ),
          ]),
          const SizedBox(height: 14),
          Row(children: [
            Text('Quantity', style: t(16, color: C.maroon)),
            const Spacer(),
            IconButton(
              tooltip: 'One less',
              constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              onPressed: _qty > 1 ? () => setState(() => _qty--) : null,
              icon: const Icon(Icons.remove_circle_outline_rounded),
            ),
            SizedBox(width: 32, child: Text('$_qty', textAlign: TextAlign.center, style: t(18))),
            IconButton(
              tooltip: 'One more',
              constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              onPressed: _qty < _p.maxQty ? () => setState(() => _qty++) : null,
              icon: const Icon(Icons.add_circle_outline_rounded),
            ),
          ]),
          const SizedBox(height: 6),
          Text(merchRupees(_unit * _qty), style: t(26, color: C.rani)),
          Text('incl. ${merchGstText(_rate)} & free delivery', style: t(14, color: C.muted, w: FontWeight.w700)),
          Text('Price includes: printing, ${merchGstText(_rate)} and delivery across India. Made to order.', style: t(14, color: C.muted, w: FontWeight.w700)),
          Text('You\'ll get a GST invoice by email.', style: t(14, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 14),
          DesiButton(
            _checkout ? 'Buy now' : 'Coming soon',
            icon: Icons.shopping_bag_rounded,
            kind: DesiButtonKind.rani,
            expand: true,
            onTap: canBuy ? _buy : null,
          ),
        ]),
      ),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({required this.colour, required this.selected, required this.onTap});

  final MerchColour colour;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fill = merchColour(colour.hex);
    return Semantics(
      button: true,
      selected: selected,
      label: colour.name,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Container(
          width: 48,
          height: 48,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, color: fill, border: Border.all(color: selected ? C.rani : C.brass, width: selected ? 4 : 1.5)),
          child: selected ? Icon(Icons.check_rounded, size: 22, color: fill.computeLuminance() > 0.5 ? C.deep : C.white) : null,
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------ checkout

class MerchCheckoutScreen extends StatefulWidget {
  const MerchCheckoutScreen({super.key, required this.args, this.repo});

  final MerchCheckoutArgs args;
  final MerchRepo? repo;

  @override
  State<MerchCheckoutScreen> createState() => _MerchCheckoutScreenState();
}

class _MerchCheckoutScreenState extends State<MerchCheckoutScreen> {
  AsyncState<List<SavedAddress>> _saved = const AsyncLoading();
  String? _savedId; // null = a new address
  final TextEditingController _name = TextEditingController();
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _line1 = TextEditingController();
  final TextEditingController _line2 = TextEditingController();
  final TextEditingController _city = TextEditingController();
  final TextEditingController _state = TextEditingController();
  final TextEditingController _pin = TextEditingController();
  bool _saveAddress = true;
  bool _terms = false;
  bool _refund = false;
  String _method = 'wallet';
  int? _balance;
  PincodeCheck? _pinCheck;
  String _pinChecked = '';
  bool _busy = false;
  String? _error;
  String _requestKey = MerchRepo.newRequestKey();

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;
  MerchCheckoutArgs get _a => widget.args;

  @override
  void initState() {
    super.initState();
    unawaited(_loadAddresses());
    unawaited(_loadBalance());
  }

  @override
  void dispose() {
    for (final c in [_name, _phone, _line1, _line2, _city, _state, _pin]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _loadAddresses() async {
    try {
      final list = await _repo.addresses();
      if (!mounted) return;
      setState(() {
        _saved = AsyncData(list);
        if (list.isNotEmpty) _savedId = list.first.id;
      });
    } catch (_) {
      if (mounted) setState(() => _saved = const AsyncData(<SavedAddress>[]));
    }
  }

  Future<void> _loadBalance() async {
    try {
      final w = await Services.instance.walletRepo.fetch(limit: 1);
      if (!mounted) return;
      setState(() {
        _balance = w.balancePaise;
        if (w.balancePaise < _a.totalPaise) _method = 'cashfree';
      });
    } catch (_) {
      // without a balance both options stay open; the server decides
    }
  }

  Future<void> _checkPin(String v) async {
    if (v.length != 6 || v == _pinChecked) {
      if (v.length != 6 && _pinCheck != null) setState(() => _pinCheck = null);
      return;
    }
    _pinChecked = v;
    try {
      final c = await _repo.pincode(v);
      if (mounted && _pin.text == v) setState(() => _pinCheck = c);
    } catch (_) {
      if (mounted) setState(() => _pinCheck = null);
    }
  }

  /// [HF-APP-PARITY-MERCH-1] Removes a saved address after asking, like the website's "Remove".
  Future<void> _removeSaved(SavedAddress a) async {
    final gone = await removeSavedAddress(context, _repo, a);
    if (!gone || !mounted) return;
    final s = _saved;
    final left = s is AsyncData<List<SavedAddress>> ? [for (final x in s.value) if (x.id != a.id) x] : <SavedAddress>[];
    setState(() {
      _saved = AsyncData(left);
      if (_savedId == a.id) _savedId = left.isEmpty ? null : left.first.id;
    });
  }

  SavedAddress? get _chosenSaved {
    final s = _saved;
    final id = _savedId;
    if (s is! AsyncData<List<SavedAddress>> || id == null) return null;
    for (final x in s.value) {
      if (x.id == id) return x;
    }
    return null;
  }

  String? _formProblem() {
    if (_name.text.trim().length < 2) return 'Enter the name of the person receiving the parcel.';
    if (!RegExp(r'^[6-9][0-9]{9}$').hasMatch(_phone.text.trim())) return 'Enter a 10 digit Indian mobile number.';
    if (_line1.text.trim().length < 3) return 'Enter the house number and street.';
    if (_city.text.trim().length < 2) return 'Enter the city.';
    if (_state.text.trim().length < 2) return 'Enter the state.';
    if (!RegExp(r'^[1-9][0-9]{5}$').hasMatch(_pin.text.trim())) return 'Enter a 6 digit pincode.';
    if (_pinCheck != null && !_pinCheck!.deliverable) return 'We cannot deliver to that pincode yet.';
    return null;
  }

  MerchAddress? _address() {
    final s = _chosenSaved;
    if (s != null) return s.toAddress();
    if (_formProblem() != null) return null;
    return MerchAddress(
      name: _name.text.trim(),
      phone: _phone.text.trim(),
      line1: _line1.text.trim(),
      line2: _line2.text.trim(),
      city: _city.text.trim(),
      state: _state.text.trim(),
      pincode: _pin.text.trim(),
    );
  }

  bool _notReady = false; // [HF-MERCH-GST-2] server answered 403 gst_not_ready

  bool get _ready => !_busy && !_notReady && _terms && _refund && (_chosenSaved != null || _formProblem() == null);

  Future<void> _pay() async {
    final addr = _address();
    if (addr == null) {
      setState(() => _error = _formProblem() ?? 'Choose where to send it.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    merchEvent('merch_pay_method_chosen', {'method': _method});
    try {
      final r = await _repo.checkout(
        productId: _a.product.id,
        colour: _a.colour,
        size: _a.size,
        qty: _a.qty,
        address: addr,
        saveAddress: _chosenSaved == null && _saveAddress,
        method: _method,
        requestKey: _requestKey,
      );
      if (!mounted) return;
      if (r.paid) {
        context.pushReplacement('/merch/orders/${Uri.encodeComponent(r.orderId)}?src=pay'); // go_router 16: returns void
        return;
      }
      final url = r.checkoutUrl;
      if (url == null) {
        setState(() {
          _busy = false;
          _error = 'The payment page could not be opened. Please try again.';
        });
        return;
      }
      final opened = await Checkout.open(url);
      if (!mounted) return;
      if (!opened) {
        setState(() {
          _busy = false;
          _error = 'The payment page could not be opened. Please try again.';
        });
        return;
      }
      context.pushReplacement('/merch/orders/${Uri.encodeComponent(r.orderId)}?src=pay&wait=1');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      if (e.status == 402) {
        await _lowBalance(e);
      } else if (e.code == 'gst_not_ready') {
        setState(() {
          _notReady = true;
          _error = merchErrorText(e);
        });
      } else {
        merchEvent('merch_checkout_failed', {'code': e.code, 'status': e.status, 'surface': 'single'});
        setState(() => _error = e.code == 'whatsapp_required' ? merchWhatsappRequiredText : merchCheckoutErrorText(e));
      }
    } catch (e, st) {
      merchCapture(e, st, 'checkout');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = ApiException.genericText;
        });
      }
    }
  }

  Future<void> _lowBalance(ApiException e) async {
    final text = merchLowBalanceText(e, otherWay: 'pay with UPI or a card instead'); // [HF-APP-PARITY-MERCH-1] says when only test credit is left
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: C.ivory,
        title: Text('Not enough in your wallet', style: t(20, color: C.maroon)),
        content: Text(
          text,
          style: t(16, w: FontWeight.w600, h: 1.35),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop('topup'), child: Text('Add money', style: t(16, color: C.maroon))),
          TextButton(onPressed: () => Navigator.of(ctx).pop('cashfree'), child: Text('Pay another way', style: t(16, color: C.rani))),
        ],
      ),
    );
    if (!mounted) return;
    if (choice == 'topup') {
      await context.push<Object?>('/topup');
      if (mounted) unawaited(_loadBalance());
    } else if (choice == 'cashfree') {
      setState(() {
        _method = 'cashfree';
        _requestKey = MerchRepo.newRequestKey();
      });
      unawaited(_pay());
    }
  }

  void _setMethod(String m) {
    if (_method == m) return;
    setState(() {
      _method = m;
      _requestKey = MerchRepo.newRequestKey(); // a different way to pay is a different attempt
    });
  }

  @override
  Widget build(BuildContext context) {
    final total = _a.totalPaise;
    final walletLow = _balance != null && _balance! < total;
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Checkout'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
                children: [
                  DesiCard(
                    child: Row(children: [
                      MerchThumb(_a.product.imageUrl, size: 76),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(_a.product.title, style: t(17)),
                          Text('${_a.colour} · ${_a.size} · Qty ${_a.qty}', style: t(14, color: C.muted, w: FontWeight.w700)),
                          Text('by ${_a.host.displayName}', style: t(14, color: C.muted, w: FontWeight.w700)),
                          const SizedBox(height: 4),
                          Text(merchRupees(total), style: t(20, color: C.rani)),
                          Text('Total (incl. ${merchGstText(_a.product.gstRateBps)} & delivery)', style: t(14, color: C.muted, w: FontWeight.w700)),
                          Text('No extra charges at checkout.', style: t(14, color: C.muted, w: FontWeight.w700)),
                          Text('You\'ll get a GST invoice by email.', style: t(14, color: C.muted, w: FontWeight.w700)),
                        ]),
                      ),
                    ]),
                  ),
                  const SizedBox(height: 14),
                  Text('Where should we send it?', style: t(18, color: C.maroon)),
                  const SizedBox(height: 8),
                  ..._addressSection(),
                  const SizedBox(height: 14),
                  Text('How do you want to pay?', style: t(18, color: C.maroon)),
                  const SizedBox(height: 8),
                  _PayTile(
                    icon: Icons.account_balance_wallet_rounded,
                    title: 'Wallet',
                    sub: _balance == null ? 'Pay from your wallet' : (walletLow ? 'Balance ${merchRupees(_balance!)} · add money first' : 'Balance ${merchRupees(_balance!)}'),
                    selected: _method == 'wallet',
                    onTap: () => _setMethod('wallet'),
                  ),
                  const SizedBox(height: 8),
                  _PayTile(
                    icon: Icons.qr_code_2_rounded,
                    title: 'UPI, card or net banking',
                    sub: 'A secure payment page opens',
                    selected: _method == 'cashfree',
                    onTap: () => _setMethod('cashfree'),
                  ),
                  const SizedBox(height: 12),
                  _Tick(
                    value: _terms,
                    onChanged: (v) => setState(() => _terms = v),
                    text: 'I agree to the terms of sale. This T-shirt is printed only for me, once I order.',
                  ),
                  _Tick(
                    value: _refund,
                    onChanged: (v) => setState(() => _refund = v),
                    text: 'I understand the refund rule: a made-to-order T-shirt is refunded only if it arrives wrong or damaged. I will tell you within 48 hours of delivery.',
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 8),
                    Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w700)),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: DesiButton(
                _busy ? 'Please wait…' : 'Pay ${merchRupees(total)}',
                icon: Icons.lock_rounded,
                kind: DesiButtonKind.rani,
                expand: true,
                onTap: _ready ? () => unawaited(_pay()) : null,
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _addressSection() {
    final s = _saved;
    if (s is AsyncLoading<List<SavedAddress>>) {
      return const [Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(color: C.maroon)))];
    }
    final list = s is AsyncData<List<SavedAddress>> ? s.value : const <SavedAddress>[];
    return [
      for (final a in list) ...[
        _AddressTile(
          selected: _savedId == a.id,
          title: a.name,
          lines: '${a.line1}${a.line2.isEmpty ? '' : ', ${a.line2}'}\n${a.city}, ${a.state} ${a.pincode}\n${a.phone}',
          onTap: () => setState(() => _savedId = a.id),
          onRemove: () => unawaited(_removeSaved(a)),
        ),
        const SizedBox(height: 8),
      ],
      if (list.isNotEmpty)
        _AddressTile(selected: _savedId == null, title: 'Use a new address', lines: '', onTap: () => setState(() => _savedId = null)),
      if (_savedId == null) ...[
        const SizedBox(height: 10),
        MerchField(label: 'Full name', controller: _name, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(60)], onChanged: (_) => setState(() {})),
        MerchField(
          label: 'Mobile number',
          controller: _phone,
          keyboard: TextInputType.phone,
          hint: '10 digits',
          formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
          onChanged: (_) => setState(() {}),
        ),
        MerchField(label: 'House number and street', controller: _line1, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(50)], onChanged: (_) => setState(() {})),
        MerchField(label: 'Area, landmark (optional)', controller: _line2, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(50)]),
        MerchField(label: 'City', controller: _city, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(40)], onChanged: (_) => setState(() {})),
        MerchField(label: 'State', controller: _state, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(40)], onChanged: (_) => setState(() {})),
        MerchField(
          label: 'Pincode',
          controller: _pin,
          keyboard: TextInputType.number,
          formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          onChanged: (v) {
            setState(() {});
            unawaited(_checkPin(v));
          },
        ),
        if (_pinCheck != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              _pinCheck!.deliverable ? 'We deliver there${_pinCheck!.etaDays == null ? '' : ' in about ${_pinCheck!.etaDays} days'}.' : 'We cannot deliver to that pincode yet.',
              style: t(15, color: _pinCheck!.deliverable ? C.peacock : C.ruby, w: FontWeight.w700),
            ),
          ),
        _Tick(value: _saveAddress, onChanged: (v) => setState(() => _saveAddress = v), text: 'Save this address for next time'),
      ],
    ];
  }
}

class _AddressTile extends StatelessWidget {
  const _AddressTile({required this.selected, required this.title, required this.lines, required this.onTap, this.onRemove});

  final bool selected;
  final String title;
  final String lines;
  final VoidCallback onTap;
  final VoidCallback? onRemove; // [HF-APP-PARITY-MERCH-1] only saved addresses can be removed

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: selected ? C.rani : C.line, width: selected ? 3 : 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              Icon(selected ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded, color: selected ? C.rani : C.muted),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: t(16)),
                  if (lines.isNotEmpty) Text(lines, style: t(14, color: C.muted, w: FontWeight.w600)),
                ]),
              ),
              if (onRemove != null)
                IconButton(
                  tooltip: 'Remove this address',
                  onPressed: onRemove,
                  icon: const Icon(Icons.delete_outline_rounded, color: C.rani),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _PayTile extends StatelessWidget {
  const _PayTile({required this.icon, required this.title, required this.sub, required this.selected, required this.onTap});

  final IconData icon;
  final String title;
  final String sub;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: selected ? C.rani : C.line, width: selected ? 3 : 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 60),
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              Icon(icon, color: C.maroon, size: 28),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: t(16)),
                  Text(sub, style: t(14, color: C.muted, w: FontWeight.w600)),
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

class _Tick extends StatelessWidget {
  const _Tick({required this.value, required this.onChanged, required this.text});

  final bool value;
  final ValueChanged<bool> onChanged;
  final String text;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => onChanged(!value),
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        child: Row(children: [
          Checkbox(value: value, activeColor: C.maroon, onChanged: (v) => onChanged(v == true)),
          Expanded(child: Text(text, style: t(15, w: FontWeight.w700, h: 1.3))),
        ]),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------ my orders

class MerchMyOrdersScreen extends StatefulWidget {
  const MerchMyOrdersScreen({super.key, this.repo});

  final MerchRepo? repo;

  @override
  State<MerchMyOrdersScreen> createState() => _MerchMyOrdersScreenState();
}

class _MerchMyOrdersScreenState extends State<MerchMyOrdersScreen> {
  AsyncState<List<FanOrder>> _state = const AsyncLoading();

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final list = await _repo.myOrders();
      if (mounted) setState(() => _state = AsyncData(list));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('My orders'),
            Expanded(
              child: AsyncView<List<FanOrder>>(
                state: _state,
                onRetry: () {
                  setState(() => _state = const AsyncLoading());
                  unawaited(_load());
                },
                emptyTitle: 'No orders yet',
                emptyMessage: 'Merch you buy from your favourite influencers will show up here.',
                builder: (context, orders) => RefreshIndicator(
                  color: C.maroon,
                  onRefresh: _load,
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 6, 16, 28),
                    itemCount: orders.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (context, i) {
                      final o = orders[i];
                      return DesiCard(
                        onTap: () => unawaited(context.push<Object?>('/merch/orders/${Uri.encodeComponent(o.id)}?src=list')),
                        child: Row(children: [
                          MerchThumb(o.imageUrl, size: 72),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(o.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(17)),
                              if (o.hostName.isNotEmpty) Text(o.hostName, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
                              Text('${o.colour} · ${o.size} · Qty ${o.qty}', style: t(14, color: C.muted, w: FontWeight.w700)),
                              Text('Order ${o.orderNo} · ${merchDate(o.createdAt)}', style: t(14, color: C.muted, w: FontWeight.w700)),
                              const SizedBox(height: 6),
                              Wrap(spacing: 6, runSpacing: 4, children: [
                                merchFanStatusChip(o.status),
                                if (o.groupId != null) const DesiChip('From your bag', tone: DesiTone.white, icon: Icons.shopping_bag_rounded), // [HF-APP-PARITY-MERCH-1]
                              ]),
                            ]),
                          ),
                          const SizedBox(width: 8),
                          Text(merchRupees(o.totalPaise), style: t(16, color: C.rani)),
                        ]),
                      );
                    },
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------ one order

/// The tracker for one order, or for a whole bag payment when [id] is a group id (`mgp_...`, where the bag's payment page sends the
/// buyer back). While a payment is awaited it asks again every 3 seconds (the server asks the gateway itself), up to 40 tries.
/// [waiting] says the payment page was just opened; an order that loads as "waiting for payment" is polled either way.
class MerchOrderScreen extends StatefulWidget {
  const MerchOrderScreen({super.key, required this.id, this.waiting = false, this.source = 'link', this.repo});

  final String id;
  final bool waiting;
  final String source;
  final MerchRepo? repo;

  @override
  State<MerchOrderScreen> createState() => _MerchOrderScreenState();
}

class _MerchOrderScreenState extends State<MerchOrderScreen> with WidgetsBindingObserver {
  AsyncState<FanOrder> _state = const AsyncLoading();
  FanGroup? _group; // [HF-APP-PARITY-MERCH-1] set when [MerchOrderScreen.id] is a bag payment
  Timer? _poll;
  int _polls = 0;
  bool _opened = false;
  bool _timedOut = false;
  bool _receiptBusy = false;
  bool _bagChecked = false;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;
  bool get _isGroup => widget.id.startsWith('mgp_');

  bool get _awaiting {
    final g = _group;
    if (_isGroup) return g != null && g.awaitingPayment;
    final cur = _state;
    return cur is AsyncData<FanOrder> && cur.value.status == 'awaiting_payment';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
    if (widget.waiting) _startPoll();
  }

  @override
  void dispose() {
    _poll?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _startPoll() {
    _poll ??= Timer.periodic(const Duration(seconds: 3), (_) => unawaited(_tick()));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) unawaited(_load(quiet: true));
  }

  Future<void> _tick() async {
    _polls++;
    final cur = _state;
    final settled = cur is AsyncData<FanOrder> && !_awaiting;
    if (settled) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    if (_polls > 40) {
      _poll?.cancel();
      _poll = null;
      if (mounted) setState(() => _timedOut = true);
      return;
    }
    await _load(quiet: true);
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet && mounted) setState(() => _state = const AsyncLoading());
    try {
      final FanOrder o;
      if (_isGroup) {
        final g = await _repo.myGroup(widget.id);
        if (g.orders.isEmpty) throw const ApiException(kind: ApiFailure.http, status: 404, code: 'not_found', message: 'No such order.');
        _group = g;
        o = g.orders.first;
      } else {
        o = await _repo.myOrder(widget.id);
      }
      if (!mounted) return;
      setState(() => _state = AsyncData(o));
      if (!_opened) {
        _opened = true;
        merchEvent('merch_order_opened', {'status': o.status, 'source': widget.source});
      }
      if (_awaiting) _startPoll();
      if (_isGroup && !_awaiting && !_bagChecked && _group != null && !_group!.allCancelled) {
        // The payment went through: let the bag settle (empties the lines, sends bag_paid once). Quiet when there is no pending record.
        _bagChecked = true;
        try {
          await resolveBagPayment();
        } catch (_) {
          // the bag is tidied on the next visit
        }
      }
    } catch (e) {
      if (mounted && !quiet) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _report(FanOrder o) async {
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: C.ivory,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      builder: (_) => _ProblemSheet(repo: _repo, orderId: o.id),
    );
    if (done == true) {
      if (mounted) toast(context, 'Thanks. We have your report and will contact you.');
      unawaited(_load(quiet: true));
    }
  }

  Future<void> _receipt(FanOrder o) async {
    if (_receiptBusy) return;
    setState(() => _receiptBusy = true);
    await openMerchReceipt(context, _repo, o);
    if (mounted) setState(() => _receiptBusy = false);
  }

  String _refundLine(FanOrder o) => switch (o.refundStatus) {
        'done' => 'Your money has been sent back.',
        'refunding' => 'Your refund is on its way.',
        'pending_manual' => 'Our team is sending your refund by hand. We will message you when it is done.',
        _ => '',
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            BookHeader(_isGroup ? 'Your bag orders' : 'Your order'),
            Expanded(
              child: AsyncView<FanOrder>(
                state: _state,
                onRetry: () => unawaited(_load()),
                builder: (context, o) => RefreshIndicator(
                  color: C.maroon,
                  onRefresh: () => _load(quiet: true),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
                    children: _group != null ? _groupChildren(_group!) : _orderChildren(o),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The "confirming your payment" card, with the website's wording after the polling has given up.
  Widget _waitingCard() => DesiCard(
        tone: DesiTone.gold,
        child: _timedOut
            ? Text(
                'We have not heard from the bank yet. If money was taken from your account, it will show here soon, and we refund anything that does not go through.',
                style: t(15, w: FontWeight.w700, h: 1.3),
              )
            : Row(children: [
                const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3)),
                const SizedBox(width: 12),
                Expanded(child: Text('Confirming your payment with the bank. This usually takes a few seconds. This page updates by itself.', style: t(15, w: FontWeight.w700))),
              ]),
      );

  List<Widget> _groupChildren(FanGroup g) {
    final line = g.awaitingPayment
        ? (_timedOut ? 'We are still waiting for the bank to confirm. Check back in a few minutes.' : 'Confirming your payment…')
        : g.allCancelled
            ? 'The payment did not go through.'
            : 'Payment received.';
    return [
      DesiCard(
        title: 'These came from your bag',
        note: '${g.orders.length} ${g.orders.length == 1 ? 'order' : 'orders'}, one payment of ${merchRupees(g.totalPaise)}. $line',
        child: const SizedBox.shrink(),
      ),
      if (g.awaitingPayment) ...[const SizedBox(height: 12), _waitingCard()],
      for (final x in g.orders) ...[
        const SizedBox(height: 12),
        DesiCard(
          onTap: () => unawaited(context.push<Object?>('/merch/orders/${Uri.encodeComponent(x.id)}?src=group')),
          child: Row(children: [
            MerchThumb(x.imageUrl, size: 72),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(x.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(17)),
                Text('${x.colour} · ${x.size} · Qty ${x.qty}', style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 6),
                merchFanStatusChip(x.status),
              ]),
            ),
            const SizedBox(width: 8),
            Text(merchRupees(x.totalPaise), style: t(16, color: C.rani)),
          ]),
        ),
      ],
    ];
  }

  List<Widget> _orderChildren(FanOrder o) {
    final closed = o.status == 'cancelled' || o.status == 'refunded';
    final refund = _refundLine(o);
    return [
      DesiCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            MerchThumb(o.imageUrl, size: 84),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(o.title, style: t(18)),
                Text('${o.colour} · ${o.size} · Qty ${o.qty}', style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 6),
                merchFanStatusChip(o.status),
              ]),
            ),
          ]),
          const SizedBox(height: 10),
          MerchKv('Order', '#${o.orderNo}'),
          MerchKv('Placed', merchDateTime(o.createdAt)),
          if (o.hostName.isNotEmpty) MerchKv('From', o.hostName),
          MerchKv('Paid (incl. GST & delivery)', merchRupees(o.totalPaise), strong: true),
          if (o.payMethod != null) MerchKv('Paid with', o.payMethod == 'wallet' ? 'Wallet' : 'UPI, card or net banking'),
          if (o.shipping?.courier != null) MerchKv('Courier', o.shipping!.courier!),
          if (o.shipping?.awb != null) MerchKv('Tracking number', o.shipping!.awb!),
        ]),
      ),
      if (!closed && o.status != 'awaiting_payment') ...[
        const SizedBox(height: 12),
        DesiCard(child: MerchTracker(o.status)),
      ],
      if (o.status == 'awaiting_payment') ...[const SizedBox(height: 12), _waitingCard()],
      if (closed) ...[
        const SizedBox(height: 12),
        DesiCard(
          tone: DesiTone.rani,
          child: Text(
            'This order was ${o.status == 'refunded' ? 'refunded' : 'cancelled'}.${o.rejectReason == null ? '' : ' ${o.rejectReason}'}${refund.isEmpty ? '' : ' $refund'}',
            style: t(15, color: C.white, w: FontWeight.w700, h: 1.3),
          ),
        ),
      ] else if (o.rejectReason != null) ...[
        const SizedBox(height: 12),
        DesiCard(tone: DesiTone.rani, child: Text(o.rejectReason!, style: t(15, color: C.white, w: FontWeight.w700))),
      ],
      if (!closed && refund.isNotEmpty) ...[
        const SizedBox(height: 12),
        DesiCard(child: MerchKv('Refund', refund)),
      ],
      if (o.timeline.isNotEmpty) ...[
        const SizedBox(height: 12),
        DesiCard(title: 'Where it is', child: MerchTimeline(o.timeline)),
      ],
      const SizedBox(height: 12),
      Wrap(spacing: 10, runSpacing: 10, children: [
        if (o.shipping?.trackingUrl != null)
          DesiButton('Track parcel', icon: Icons.local_shipping_rounded, kind: DesiButtonKind.tea, onTap: () {
            merchEvent('merch_tracking_opened', {'order_id': o.id});
            unawaited(openMerchLink(context, o.shipping!.trackingUrl!));
          }),
        if (o.receiptUrl != null)
          DesiButton(_receiptBusy ? 'Opening…' : 'Download GST invoice', icon: Icons.receipt_long_rounded, kind: DesiButtonKind.ghost, onTap: _receiptBusy ? null : () => unawaited(_receipt(o))),
        if (o.hostSlug.isNotEmpty)
          DesiButton(o.hostName.isEmpty ? 'Their page' : '${o.hostName}’s page', icon: Icons.person_rounded, kind: DesiButtonKind.ghost, onTap: () => unawaited(context.push<Object?>('/h/${Uri.encodeComponent(o.hostSlug)}'))),
        if (o.canReportProblem)
          DesiButton('Report a problem', icon: Icons.report_problem_rounded, kind: DesiButtonKind.danger, onTap: () => unawaited(_report(o))),
      ]),
      if (o.status == 'delivered' && !o.canReportProblem) ...[
        const SizedBox(height: 10),
        Text('Problems with an order can be reported within 48 hours of delivery.', style: t(14, color: C.muted, w: FontWeight.w700)),
      ],
    ];
  }
}

/// "Report a problem": wrong or damaged, what happened and an optional photo (PNG, JPEG or WebP, up to 5 MB). The photo is uploaded first
/// (`problem-photo`), then the report is sent with its key (`problem`). Sends `merch_problem_submitted {order_id, kind, has_photo, ok}`.
class _ProblemSheet extends StatefulWidget {
  const _ProblemSheet({required this.repo, required this.orderId});

  final MerchRepo repo;
  final String orderId;

  @override
  State<_ProblemSheet> createState() => _ProblemSheetState();
}

class _ProblemSheetState extends State<_ProblemSheet> {
  static const int _maxPhotoBytes = 5 * 1024 * 1024;

  final TextEditingController _note = TextEditingController();
  String _kind = 'damaged';
  PickedArt? _photo;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickPhoto() async {
    try {
      final p = await MerchArtPicker.pick(allowWebp: true);
      if (p == null || !mounted) return;
      if (p.bytes.length > _maxPhotoBytes) {
        setState(() => _error = 'That photo is too big. Please choose one that is 5 MB or smaller.');
        return;
      }
      setState(() {
        _photo = p;
        _error = null;
      });
    } catch (_) {
      if (mounted) setState(() => _error = 'We could not open your photos. Please try again.');
    }
  }

  String _errorText(Object e) {
    if (e is ApiException) {
      if (e.code == 'window_closed') return 'The 48 hours to report a problem have passed.';
      if (e.code == 'already_reported') return 'You have already reported a problem with this order.';
      return merchErrorText(e);
    }
    return ApiException.genericText;
  }

  Future<void> _send() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final photo = _photo;
    var ok = false;
    try {
      String? key;
      if (photo != null) key = await widget.repo.uploadProblemPhoto(widget.orderId, photo.bytes, contentType: photo.mime);
      await widget.repo.reportProblem(widget.orderId, kind: _kind, note: _note.text.trim(), photoKey: key);
      ok = true;
      merchEvent('merch_problem_submitted', {'order_id': widget.orderId, 'kind': _kind, 'has_photo': key != null, 'ok': true});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!ok) merchEvent('merch_problem_submitted', {'order_id': widget.orderId, 'kind': _kind, 'has_photo': photo != null, 'ok': false});
      if (mounted) {
        setState(() {
          _busy = false;
          _error = _errorText(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final len = _note.text.trim().length;
    final ok = len >= 10 && !_busy;
    final photo = _photo;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text('Report a problem', style: t(22, color: C.maroon))),
          const SizedBox(height: 4),
          Text('Tell us within 48 hours of delivery and we will make it right.', style: t(14, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            MerchPill(label: 'It arrived damaged', selected: _kind == 'damaged', onTap: () => setState(() => _kind = 'damaged')),
            MerchPill(label: 'Wrong item, size or print', selected: _kind == 'wrong', onTap: () => setState(() => _kind = 'wrong')),
          ]),
          const SizedBox(height: 12),
          MerchField(
            label: 'What happened? (at least 10 letters)',
            controller: _note,
            maxLines: 4,
            capitalization: TextCapitalization.sentences,
            formatters: [LengthLimitingTextInputFormatter(1000)],
            onChanged: (_) => setState(() {}),
          ),
          Text('Add a photo (optional, up to 5 MB)', style: t(15, color: C.maroon)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            DesiButton(photo == null ? 'Choose a photo' : 'Change photo', icon: Icons.photo_camera_rounded, kind: DesiButtonKind.ghost, onTap: _busy ? null : () => unawaited(_pickPhoto())),
            if (photo != null) ...[
              ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.memory(photo.bytes, width: 56, height: 56, fit: BoxFit.cover)),
              IconButton(tooltip: 'Remove the photo', onPressed: _busy ? null : () => setState(() => _photo = null), icon: const Icon(Icons.close_rounded, color: C.rani)),
            ],
          ]),
          const SizedBox(height: 12),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w700))),
          DesiButton(_busy ? 'Sending…' : 'Send report', kind: DesiButtonKind.rani, expand: true, onTap: ok ? () => unawaited(_send()) : null),
        ]),
      ),
    );
  }
}
