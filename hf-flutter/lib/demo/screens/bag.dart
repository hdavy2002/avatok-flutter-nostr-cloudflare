import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/bag_store.dart';
import '../../data/models/bag.dart';
import '../../data/models/merch.dart';
import '../../data/repos/channel_repo.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/repos/wallet_repo.dart';
import '../../data/services.dart';
import '../../ui/net_image.dart';
import '../channel_pop_kit.dart';
import '../merch_kit.dart';
import '../merch_parity_kit.dart'; // [HF-APP-PARITY-MERCH-1]
import '../theme.dart';
import '../widgets.dart';

/// [HF-CHANNEL-APP-1] The bag and the checkout, built to the owner-approved phone mocks PhoneBag and PhoneCheckout.

/// What the bag checkout is told: the lines to pay for, and whether they come from the bag (then a paid bag is emptied).
/// "Buy now" on a product passes just that one line with [fromBag] false, so the rest of the bag is left alone.
class BagCheckoutArgs {
  const BagCheckoutArgs({required this.lines, this.fromBag = true});

  final List<BagLine> lines;
  final bool fromBag;

  int get totalPaise => lines.fold<int>(0, (a, l) => a + l.totalPaise);
  int get itemCount => lines.fold<int>(0, (a, l) => a + l.qty);
}

/// Asks the server where the pending online bag payment stands. Null when there is none. When the group is paid, the bag lines
/// (if the payment was for the bag) and the pending record are cleared, and `bag_paid` is sent. Throws when the server cannot be read.
Future<BagGroupStatus?> resolveBagPayment({ChannelRepo? repo}) async {
  final store = BagStore.instance;
  await store.ensureLoaded();
  final p = store.pending;
  if (p == null) return null;
  final g = await (repo ?? ChannelRepo.instance).groupStatus(p.groupId);
  if (g.paid) {
    if (p.fromBag) await store.clear();
    await store.setPending(null);
    channelEvent('bag_paid', {'items': p.items, 'total_rupees': (g.totalPaise > 0 ? g.totalPaise : p.totalPaise) ~/ 100, 'method': 'online', 'orders': g.orderNos.length});
  }
  return g;
}

String _itemsText(int n) => '$n ${n == 1 ? 'item' : 'items'}';

/// One product picture in a square tile (a plain icon when it has none).
class _LineThumb extends StatelessWidget {
  const _LineThumb(this.line);

  final BagLine line;
  static const double size = 88;

  @override
  Widget build(BuildContext context) {
    final icon = Center(child: Icon(gpCategoryIcon(line.category), size: size * .45, color: GP.muted));
    final url = line.imageUrl;
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: SizedBox(width: size, height: size, child: ColoredBox(color: GP.tile, child: url == null ? icon : NetImage(url, fallback: icon))),
    );
  }
}

String _lineSub(BagLine l) => [if (l.colour.isNotEmpty) l.colour, if (l.size.isNotEmpty) l.size].join(' · ');

// ------------------------------------------------------------------------------------------------ the bag

class BagScreen extends StatefulWidget {
  const BagScreen({super.key});

  @override
  State<BagScreen> createState() => _BagScreenState();
}

class _BagScreenState extends State<BagScreen> with WidgetsBindingObserver {
  bool _unfinished = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_checkPending());
    unawaited(BagStore.instance.ensureLoaded());
    unawaited(Services.instance.merchRepo.loadFlags());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_checkPending());
  }

  /// Back from the payment page (or the app was reopened): if a bag payment was started, ask the server how it went.
  Future<void> _checkPending() async {
    try {
      final g = await resolveBagPayment();
      if (!mounted || g == null) return;
      if (g.paid) {
        toast(context, 'Payment received. Your order is placed.');
        context.go('/merch/orders');
      } else {
        setState(() => _unfinished = true);
      }
    } catch (_) {
      // cannot reach the server right now: the bag stays as it is
    }
  }

  void _checkout() {
    final lines = BagStore.instance.lines;
    if (lines.isEmpty) return;
    requireAccount(context, () => unawaited(context.push<Object?>('/bag/checkout', extra: BagCheckoutArgs(lines: lines))), reason: 'to check out');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: GP.bg,
      body: Column(children: [
        const GpHeader(title: 'Your bag', bag: false),
        Expanded(
          child: ListenableBuilder(
            listenable: Listenable.merge([BagStore.instance, MerchRepo.flags]),
            builder: (context, _) {
              final bag = BagStore.instance;
              final lines = bag.lines;
              if (lines.isEmpty) {
                return _empty(context, bag.loaded);
              }
              final byHost = <String, List<BagLine>>{};
              for (final l in lines) {
                byHost.putIfAbsent(l.hostSlug, () => []).add(l);
              }
              final total = bag.totalPaise;
              final count = bag.count;
              return ListView(padding: const EdgeInsets.fromLTRB(16, 22, 16, 24), children: [
                if (_unfinished && BagStore.instance.pending != null)
                  Container(
                    margin: const EdgeInsets.only(bottom: 14),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: GP.mariTint, borderRadius: BorderRadius.circular(16), border: Border.all(color: GP.mari, width: 2)),
                    child: Semantics(liveRegion: true, child: Text('Payment not finished — try again.', style: t(16, color: GP.ink, w: FontWeight.w900))),
                  ),
                Semantics(header: true, child: Text('${_itemsText(count)}. ${count == 1 ? 'Good choice' : 'Good choices'}.', style: t(30, color: GP.ink, w: FontWeight.w900, h: 1.1))),
                for (final e in byHost.entries) ...[
                  const SizedBox(height: 18),
                  Text('FROM ${e.value.first.hostName}'.toUpperCase(), style: t(14, color: GP.muted, w: FontWeight.w800, ls: .06)),
                  for (final l in e.value) _line(context, l),
                ],
                const SizedBox(height: 22),
                _summary([
                  ('Items ($count)', merchRupees(total)),
                  ('Delivery', 'Free'),
                ], merchRupees(total), 'GST included · one payment'),
                const SizedBox(height: 22),
                const Center(child: GpSticker('Bag full, dil full.', angle: -0.04)),
              ]);
            },
          ),
        ),
      ]),
      bottomNavigationBar: ListenableBuilder(
        listenable: Listenable.merge([BagStore.instance, MerchRepo.flags]),
        builder: (context, _) {
          if (BagStore.instance.isEmpty) return const SizedBox.shrink();
          final open = MerchRepo.flags.value.checkoutEnabled;
          final blocked = BagStore.instance.hasUnavailable;
          final label = !open ? 'Buying opens soon' : (blocked ? 'Remove unavailable items' : 'Checkout · ${merchRupees(BagStore.instance.totalPaise)}');
          return GpBottomBar(child: GpButton(label, onTap: (open && !blocked) ? _checkout : null));
        },
      ),
    );
  }

  Widget _empty(BuildContext context, bool loaded) {
    if (!loaded) return const Center(child: CircularProgressIndicator(color: GP.red));
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Image.asset('assets/channel/empty-bag.webp', height: 200, fit: BoxFit.contain, semanticLabel: 'Your bag is empty'),
          const SizedBox(height: 14),
          Text('Your bag is empty', textAlign: TextAlign.center, style: t(26, color: GP.ink, w: FontWeight.w900)),
          const SizedBox(height: 6),
          Text('Pick something you like from an influencer’s page.', textAlign: TextAlign.center, style: t(16, color: GP.muted, w: FontWeight.w700, h: 1.35)),
          const SizedBox(height: 20),
          GpButton('Keep browsing', onTap: () => context.canPop() ? context.pop() : context.go('/reels')),
        ]),
      ),
    );
  }

  Widget _line(BuildContext context, BagLine l) {
    final sub = _lineSub(l);
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(20), border: Border.all(color: GP.line, width: 2)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: l.productSlug.isEmpty ? null : () => unawaited(context.push<Object?>('/merch/p/${Uri.encodeComponent(l.hostSlug)}/${Uri.encodeComponent(l.productSlug)}')),
          child: _LineThumb(l),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(l.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(18, color: GP.ink, w: FontWeight.w900, h: 1.15)),
            const SizedBox(height: 2),
            Text.rich(
              TextSpan(children: [
                if (sub.isNotEmpty) TextSpan(text: '$sub · '),
                TextSpan(text: merchRupees(l.unitPaise), style: t(15, color: GP.ink, w: FontWeight.w900)),
              ]),
              style: t(15, color: GP.muted, w: FontWeight.w700),
            ),
            if (BagStore.instance.unavailableReason(l.productId) != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(BagStore.instance.unavailableReason(l.productId)!, style: t(14, color: GP.redDeep, w: FontWeight.w800, h: 1.3)),
              ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
              GpQty(value: l.qty, max: l.maxQty, onChanged: (v) => unawaited(BagStore.instance.setQty(l.key, v))),
              TextButton(
                style: TextButton.styleFrom(minimumSize: const Size(48, 48), foregroundColor: GP.red),
                onPressed: () => unawaited(BagStore.instance.remove(l.key)),
                child: Text('Remove', style: t(15, color: GP.red, w: FontWeight.w900).copyWith(decoration: TextDecoration.underline)),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }
}

/// The white totals card (the mock's `.sumcard`).
Widget _summary(List<(String, String)> rows, String total, String? note) {
  return Container(
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(22), border: Border.all(color: GP.line, width: 2)),
    child: Column(children: [
      for (final r in rows)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text(r.$1, style: t(16, color: GP.muted, w: FontWeight.w700)),
            Text(r.$2, style: t(16, color: GP.ink, w: FontWeight.w900)),
          ]),
        ),
      Container(
        padding: const EdgeInsets.only(top: 10),
        decoration: const BoxDecoration(border: Border(top: BorderSide(color: GP.line, width: 2))),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text('Total', style: t(22, color: GP.ink, w: FontWeight.w900)),
          Text(total, style: t(22, color: GP.ink, w: FontWeight.w900)),
        ]),
      ),
      if (note != null) Align(alignment: Alignment.centerLeft, child: Padding(padding: const EdgeInsets.only(top: 6), child: Text(note, style: t(14, color: GP.muted, w: FontWeight.w700)))),
    ]),
  );
}

// ------------------------------------------------------------------------------------------------ checkout

enum _Stage { address, payment, waiting, done }

class BagCheckoutScreen extends StatefulWidget {
  const BagCheckoutScreen({super.key, required this.args, this.merch, this.channel});

  final BagCheckoutArgs args;
  final MerchRepo? merch;
  final ChannelRepo? channel;

  @override
  State<BagCheckoutScreen> createState() => _BagCheckoutScreenState();
}

class _BagCheckoutScreenState extends State<BagCheckoutScreen> with WidgetsBindingObserver {
  _Stage _stage = _Stage.address;
  List<SavedAddress> _saved = const [];
  bool _loadingAddr = true;
  String? _savedId; // null = a new address
  MerchAddress? _address;
  final TextEditingController _name = TextEditingController();
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _line1 = TextEditingController();
  final TextEditingController _line2 = TextEditingController();
  final TextEditingController _city = TextEditingController();
  final TextEditingController _state = TextEditingController();
  final TextEditingController _pin = TextEditingController();
  bool _saveAddress = true;
  bool _terms = false;
  String _method = 'wallet';
  int? _balance;
  bool _busy = false;
  String? _error;
  bool _unavailable = false;
  String _requestKey = MerchRepo.newRequestKey();
  List<String> _doneNos = const [];
  int _doneTotal = 0;

  MerchRepo get _merch => widget.merch ?? Services.instance.merchRepo;
  ChannelRepo get _channel => widget.channel ?? ChannelRepo.instance;
  BagCheckoutArgs get _a => widget.args;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lastPin = MerchLastPincode.value;
    if (lastPin != null) _pin.text = lastPin;
    unawaited(_loadAddresses());
    unawaited(_loadBalance());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    for (final c in [_name, _phone, _line1, _line2, _city, _state, _pin]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _stage == _Stage.waiting) unawaited(_verify());
  }

  /// Back from the payment page: the bag is emptied and the order shown only when the server says the group is paid.
  Future<void> _verify() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final p = BagStore.instance.pending;
      final g = await resolveBagPayment(repo: _channel);
      if (!mounted) return;
      if (g != null && g.paid) {
        _showDone(g.orderNos, g.totalPaise > 0 ? g.totalPaise : (p?.totalPaise ?? _a.totalPaise));
        return;
      }
      setState(() {
        _busy = false;
        _stage = _Stage.payment;
        _requestKey = MerchRepo.newRequestKey();
        _error = 'Payment not finished — try again.';
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : ApiException.genericText;
        });
      }
    }
  }

  void _showDone(List<String> nos, int total) {
    setState(() {
      _busy = false;
      _error = null;
      _doneNos = nos;
      _doneTotal = total;
      _stage = _Stage.done;
    });
  }

  Future<void> _loadAddresses() async {
    try {
      final list = await _merch.addresses();
      if (!mounted) return;
      setState(() {
        _saved = list;
        _loadingAddr = false;
        if (list.isNotEmpty) _savedId = list.first.id;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingAddr = false);
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
      // without a balance both ways stay open; the server decides
    }
  }

  /// [HF-APP-PARITY-MERCH-1] Removes a saved address after asking, like the website's "Remove".
  Future<void> _removeSaved(SavedAddress a) async {
    final gone = await removeSavedAddress(context, _merch, a);
    if (!gone || !mounted) return;
    setState(() {
      _saved = [for (final x in _saved) if (x.id != a.id) x];
      if (_savedId == a.id) _savedId = _saved.isEmpty ? null : _saved.first.id;
    });
  }

  SavedAddress? get _chosenSaved {
    final id = _savedId;
    if (id == null) return null;
    for (final x in _saved) {
      if (x.id == id) return x;
    }
    return null;
  }

  String? _formProblem() {
    if (_name.text.trim().length < 2) return 'Enter the name of the person receiving the parcel.';
    if (!RegExp(r'^[6-9][0-9]{9}$').hasMatch(_phone.text.trim())) return 'Enter a 10 digit Indian mobile number.';
    if (_line1.text.trim().length < 3) return 'Enter the house number and street.';
    if (_city.text.trim().length < 2) return 'Enter the city.';
    if (!kIndianStates.contains(_state.text.trim())) return 'Choose the state.';
    if (!RegExp(r'^[1-9][0-9]{5}$').hasMatch(_pin.text.trim())) return 'Enter a 6 digit pincode.';
    return null;
  }

  void _toPayment() {
    final s = _chosenSaved;
    if (s != null) {
      setState(() {
        _address = s.toAddress();
        _stage = _Stage.payment;
        _error = null;
      });
      return;
    }
    final problem = _formProblem();
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _address = MerchAddress(
        name: _name.text.trim(),
        phone: _phone.text.trim(),
        line1: _line1.text.trim(),
        line2: _line2.text.trim(),
        city: _city.text.trim(),
        state: _state.text.trim(),
        pincode: _pin.text.trim(),
      );
      MerchLastPincode.remember(_pin.text);
      _stage = _Stage.payment;
      _error = null;
    });
  }

  Future<void> _pay() async {
    final addr = _address;
    if (addr == null || !_terms || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _unavailable = false;
    });
    channelEvent('bag_checkout_started', {'items': _a.itemCount, 'lines': _a.lines.length, 'total_rupees': _a.totalPaise ~/ 100, 'method': _method});
    try {
      final r = await _channel.bagCheckout(
        lines: _a.lines,
        address: addr,
        saveAddress: _chosenSaved == null && _saveAddress,
        method: _method,
        requestKey: _requestKey,
      );
      if (!mounted) return;
      if (r.paid) {
        if (_a.fromBag) await BagStore.instance.clear();
        channelEvent('bag_paid', {'items': _a.itemCount, 'total_rupees': r.totalPaise ~/ 100, 'method': _method, 'orders': r.orders.length});
        if (mounted) _showDone([for (final o in r.orders) o.orderNo], r.totalPaise);
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
      // The bag stays as it is until the server says this group is paid (see _verify).
      await BagStore.instance.setPending(BagPending(groupId: r.groupId, fromBag: _a.fromBag, totalPaise: r.totalPaise, items: _a.itemCount));
      if (mounted) {
        setState(() {
          _busy = false;
          _stage = _Stage.waiting;
        });
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      if (e.status == 402) {
        await _lowBalance(e);
      } else if (e.status == 409 || e.code == 'item_unavailable') {
        final pid = e.extra['productId'];
        if (pid is String && pid.isNotEmpty) {
          final m = e.userMessage;
          BagStore.instance.markUnavailable(pid, m.isEmpty ? 'This item is no longer available.' : m);
        }
        setState(() {
          _unavailable = true;
          _error = 'One item is no longer available, so nothing was charged. Remove it from your bag and try again.';
        });
      } else {
        merchEvent('merch_checkout_failed', {'code': e.code, 'status': e.status, 'surface': 'bag'});
        setState(() => _error = e.code == 'whatsapp_required' ? merchWhatsappRequiredText : merchCheckoutErrorText(e));
      }
    } catch (e, st) {
      merchCapture(e, st, 'bag_checkout');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = ApiException.genericText;
        });
      }
    }
  }

  Future<void> _lowBalance(ApiException e) async {
    final text = merchLowBalanceText(e); // [HF-APP-PARITY-MERCH-1] says when only test credit is left
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: GP.paper,
        title: Text('Not enough in your wallet', style: t(20, color: GP.ink, w: FontWeight.w900)),
        content: Text(
          text,
          style: t(16, color: GP.muted, w: FontWeight.w700, h: 1.35),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop('topup'), child: Text('Add money', style: t(16, color: GP.ink, w: FontWeight.w900))),
          TextButton(onPressed: () => Navigator.of(ctx).pop('cashfree'), child: Text('Pay online', style: t(16, color: GP.red, w: FontWeight.w900))),
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

  static String _mask(String phone) => phone.length < 6 ? phone : '${phone.substring(0, 2)}•••••${phone.substring(phone.length - 3)}';

  @override
  Widget build(BuildContext context) {
    final done = _stage == _Stage.done;
    return PopScope(
      canPop: !_busy,
      child: Scaffold(
        backgroundColor: GP.bg,
        body: Column(children: [
          GpHeader(title: done ? 'Order placed' : 'Checkout', bag: false),
          Expanded(child: done ? _donePanel() : _form()),
        ]),
        bottomNavigationBar: done ? null : _bottom(),
      ),
    );
  }

  Widget? _bottom() {
    if (_stage == _Stage.address) {
      return GpBottomBar(child: GpButton('Continue', onTap: _loadingAddr ? null : _toPayment));
    }
    if (_stage == _Stage.waiting) {
      return GpBottomBar(child: GpButton(_busy ? 'Checking…' : 'I have paid, check now', onTap: _busy ? null : () => unawaited(_verify())));
    }
    return GpBottomBar(
      child: GpButton(_busy ? 'Please wait…' : 'Pay ${merchRupees(_a.totalPaise)}', icon: Icons.lock_rounded, onTap: (_terms && !_busy) ? () => unawaited(_pay()) : null),
    );
  }

  Widget _form() {
    return ListView(padding: const EdgeInsets.fromLTRB(16, 18, 16, 28), children: [
      _Steps(current: _stage == _Stage.address ? 1 : 2),
      const SizedBox(height: 20),
      if (_stage == _Stage.address) ..._addressSection() else if (_stage == _Stage.waiting) ..._waitingSection() else ..._paymentSection(),
      if (_error != null) ...[
        const SizedBox(height: 12),
        Semantics(liveRegion: true, child: Text(_error!, style: t(15, color: GP.redDeep, w: FontWeight.w800, h: 1.3))),
        if (_unavailable) ...[
          const SizedBox(height: 10),
          GpButton('Back to my bag', kind: GpBtn.outline, onTap: () => context.canPop() ? context.pop() : context.go('/bag')),
        ],
      ],
    ]);
  }

  Widget _panel({required String title, Widget? trailing, required List<Widget> children}) => Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 14),
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(22), border: Border.all(color: GP.line, width: 2)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Semantics(header: true, child: Text(title, style: t(18, color: GP.ink, w: FontWeight.w900)))),
            if (trailing != null) trailing,
          ]),
          const SizedBox(height: 8),
          ...children,
        ]),
      );

  List<Widget> _addressSection() {
    if (_loadingAddr) return const [Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(color: GP.red)))];
    return [
      _panel(title: 'Where should we send it?', children: [
        for (final a in _saved)
          _Choice(
            on: _savedId == a.id,
            title: a.name,
            sub: '${a.line1}${a.line2.isEmpty ? '' : ', ${a.line2}'}\n${a.city}, ${a.state} ${a.pincode}\n${a.phone}',
            onTap: () => setState(() => _savedId = a.id),
            onRemove: () => unawaited(_removeSaved(a)),
          ),
        if (_saved.isNotEmpty) _Choice(on: _savedId == null, title: 'Use a new address', sub: '', onTap: () => setState(() => _savedId = null)),
        if (_savedId == null) ...[
          const SizedBox(height: 8),
          _GpField(label: 'Full name', controller: _name, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(60)]),
          _GpField(
            label: 'Mobile number',
            controller: _phone,
            keyboard: TextInputType.phone,
            hint: '10 digits',
            formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
          ),
          _GpField(label: 'House number and street', controller: _line1, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(50)]),
          _GpField(label: 'Area, landmark (optional)', controller: _line2, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(50)]),
          _GpField(label: 'City', controller: _city, capitalization: TextCapitalization.words, formatters: [LengthLimitingTextInputFormatter(40)]),
          _StateField(controller: _state, onChanged: () => setState(() {})),
          _GpField(label: 'Pincode', controller: _pin, keyboard: TextInputType.number, formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)]),
          _Tick(value: _saveAddress, onChanged: (v) => setState(() => _saveAddress = v), text: 'Save this address for next time'),
        ],
      ]),
    ];
  }

  List<Widget> _waitingSection() => [
        _panel(title: 'Finish paying', children: [
          Text(
            'The payment page is open. When you are done, come back here. Your order is placed only after the payment goes through.',
            style: t(15, color: GP.ink, w: FontWeight.w700, h: 1.4),
          ),
        ]),
        GpButton('Pay another way', kind: GpBtn.outline, onTap: _busy ? null : () => setState(() {
              _stage = _Stage.payment;
              _requestKey = MerchRepo.newRequestKey();
            })),
      ];

  List<Widget> _paymentSection() {
    final a = _address!;
    final low = _balance != null && _balance! < _a.totalPaise;
    return [
      _panel(
        title: 'Delivering to',
        trailing: TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: () => setState(() {
            _stage = _Stage.address;
            _error = null;
          }),
          child: Text('Change', style: t(15, color: GP.red, w: FontWeight.w900).copyWith(decoration: TextDecoration.underline)),
        ),
        children: [
          Text('${a.name} · ${_mask(a.phone)}\n${a.line1}${a.line2.isEmpty ? '' : ', ${a.line2}'}, ${a.city} ${a.pincode}', style: t(15, color: GP.ink, w: FontWeight.w700, h: 1.4)),
        ],
      ),
      _panel(title: 'Payment', children: [
        _Choice(
          on: _method == 'wallet',
          title: 'Wallet',
          sub: _balance == null ? 'Pay from your wallet' : (low ? 'Balance ${merchRupees(_balance!)} · add money first' : 'Balance ${merchRupees(_balance!)}'),
          onTap: () => _setMethod('wallet'),
        ),
        _Choice(on: _method == 'cashfree', title: 'Pay online', sub: 'UPI, cards, netbanking', onTap: () => _setMethod('cashfree')),
        _Tick(value: _terms, onChanged: (v) => setState(() => _terms = v), text: 'I agree to the Terms. No returns for a change of mind; wrong or damaged items fixed if reported within 48 hours.'),
      ]),
      _summary([
        (_itemsText(_a.itemCount), merchRupees(_a.totalPaise)),
        ('Delivery', 'Free'),
      ], merchRupees(_a.totalPaise), null),
    ];
  }

  Widget _donePanel() {
    final nos = _doneNos.where((n) => n.isNotEmpty).join(', ');
    final total = merchRupees(_doneTotal > 0 ? _doneTotal : _a.totalPaise);
    return Container(
      color: GP.ink,
      width: double.infinity,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 32, 20, 32),
        child: Column(children: [
          Container(
            decoration: BoxDecoration(color: GP.darkTile, borderRadius: BorderRadius.circular(22)),
            clipBehavior: Clip.antiAlias,
            child: ExcludeSemantics(child: Image.asset('assets/channel/order-done.webp', width: double.infinity, fit: BoxFit.fitWidth)),
          ),
          const SizedBox(height: 22),
          Text('ORDER PLACED', style: gpEyebrow(color: GP.yel)),
          const SizedBox(height: 6),
          Semantics(header: true, child: Text('Picture abhi baaki hai!', textAlign: TextAlign.center, style: gpPoster(44))),
          const SizedBox(height: 12),
          Text(
            '${nos.isEmpty ? 'Your order' : 'Order $nos'} · $total paid. We’ll message you when it ships.',
            textAlign: TextAlign.center,
            style: t(16, color: GP.onDark, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 22),
          GpButton('Track my order', kind: GpBtn.yellow, onTap: () => context.go('/merch/orders')),
        ]),
      ),
    );
  }
}

class _Steps extends StatelessWidget {
  const _Steps({required this.current});

  /// 1 = bag, 2 = address, 3 = payment (the mock numbers the screens this way; the address screen is step 2).
  final int current;

  @override
  Widget build(BuildContext context) {
    // current: 1 -> address is the active step (2 of 4); 2 -> payment is the active step (3 of 4)
    final active = current + 1;
    const labels = ['Bag', 'Address', 'Payment', 'Done'];
    Widget step(int n) {
      final done = n < active;
      final on = n == active;
      return Semantics(
        label: '${labels[n - 1]}${done ? ', done' : (on ? ', now' : '')}',
        child: Container(
          constraints: const BoxConstraints(minHeight: 32, minWidth: 32),
          padding: EdgeInsets.symmetric(horizontal: on ? 12 : 0),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: done ? GP.ink : (on ? GP.red : GP.paper),
            borderRadius: BorderRadius.circular(99),
            border: Border.all(color: done ? GP.ink : (on ? GP.red : GP.inputLine), width: 2),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(done ? '✓' : '$n', style: t(14, color: done || on ? GP.paper : GP.muted, w: FontWeight.w900)),
            if (on) ...[const SizedBox(width: 6), Text(labels[n - 1], style: t(14, color: GP.paper, w: FontWeight.w900))],
          ]),
        ),
      );
    }

    return Row(mainAxisAlignment: MainAxisAlignment.center, children: [
      for (var n = 1; n <= 4; n++) ...[
        step(n),
        if (n < 4) Container(width: 24, height: 2, color: GP.inputLine),
      ],
    ]);
  }
}

class _Choice extends StatelessWidget {
  const _Choice({required this.on, required this.title, required this.sub, required this.onTap, this.onRemove});

  final bool on;
  final String title;
  final String sub;
  final VoidCallback onTap;
  final VoidCallback? onRemove; // [HF-APP-PARITY-MERCH-1] saved addresses only

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: on,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Material(
          color: on ? GP.mariTint : GP.paper,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: on ? GP.ink : GP.inputLine, width: 2)),
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 56),
              padding: const EdgeInsets.all(14),
              child: Row(children: [
                Icon(on ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded, color: on ? GP.red : GP.muted),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(title, style: t(16, color: GP.ink, w: FontWeight.w900)),
                    if (sub.isNotEmpty) Text(sub, style: t(14, color: GP.muted, w: FontWeight.w700, h: 1.3)),
                  ]),
                ),
                if (onRemove != null) IconButton(tooltip: 'Remove this address', onPressed: onRemove, icon: const Icon(Icons.delete_outline_rounded, color: GP.red)),
              ]),
            ),
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
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Row(children: [
          Checkbox(value: value, activeColor: GP.ink, onChanged: (v) => onChanged(v == true)),
          Expanded(child: Text(text, style: t(15, color: GP.ink, w: FontWeight.w700, h: 1.3))),
        ]),
      ),
    );
  }
}

/// What a fan sees when the server wants a verified WhatsApp number before a purchase (`whatsapp_required`).
const String merchWhatsappRequiredText =
    'Please verify your WhatsApp number first. We send your order updates on WhatsApp, so a verified number is needed to buy. You can verify it in your profile.';

/// The states and union territories the website offers at checkout (same list and spelling).
const List<String> kIndianStates = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

/// A tap-to-choose State field: opens a list of the states, writes the choice into [controller].
class _StateField extends StatelessWidget {
  const _StateField({required this.controller, required this.onChanged});

  final TextEditingController controller;
  final VoidCallback onChanged;

  Future<void> _open(BuildContext context) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: GP.bg,
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.8),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 8), child: Text('Choose your state', style: t(19, color: GP.ink, w: FontWeight.w900))),
            Flexible(
              child: ListView.builder(
                itemCount: kIndianStates.length,
                itemBuilder: (_, i) {
                  final name = kIndianStates[i];
                  final on = name == controller.text.trim();
                  return ListTile(
                    minVerticalPadding: 14,
                    title: Text(name, style: t(17, color: GP.ink, w: on ? FontWeight.w900 : FontWeight.w700)),
                    trailing: on ? const Icon(Icons.check_rounded, color: GP.ink) : null,
                    onTap: () => Navigator.of(ctx).pop(name),
                  );
                },
              ),
            ),
          ]),
        ),
      ),
    );
    if (picked == null) return;
    controller.text = picked;
    onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final v = controller.text.trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('State', style: t(15, color: GP.ink, w: FontWeight.w900)),
        const SizedBox(height: 6),
        Semantics(
          button: true,
          label: v.isEmpty ? 'State, not chosen' : 'State, $v',
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => unawaited(_open(context)),
            child: Container(
              constraints: const BoxConstraints(minHeight: 56),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: GP.inputLine, width: 2)),
              child: Row(children: [
                Expanded(child: Text(v.isEmpty ? 'Choose your state' : v, style: t(17, color: v.isEmpty ? GP.muted : GP.ink, w: FontWeight.w700))),
                const Icon(Icons.expand_more_rounded, color: GP.ink),
              ]),
            ),
          ),
        ),
      ]),
    );
  }
}

class _GpField extends StatelessWidget {
  const _GpField({required this.label, required this.controller, this.hint, this.keyboard, this.formatters, this.capitalization = TextCapitalization.none});

  final String label;
  final TextEditingController controller;
  final String? hint;
  final TextInputType? keyboard;
  final List<TextInputFormatter>? formatters;
  final TextCapitalization capitalization;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: t(15, color: GP.ink, w: FontWeight.w900)),
        const SizedBox(height: 6),
        TextField(
          controller: controller,
          keyboardType: keyboard,
          textCapitalization: capitalization,
          inputFormatters: formatters,
          style: t(17, color: GP.ink, w: FontWeight.w700),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: t(16, color: GP.muted, w: FontWeight.w700),
            filled: true,
            fillColor: GP.paper,
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: GP.inputLine, width: 2)),
            focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: GP.blue, width: 2)),
          ),
        ),
      ]),
    );
  }
}
