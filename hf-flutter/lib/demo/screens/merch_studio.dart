import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../merch_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-MERCH-APP-1] The influencer's merch studio: Products (status, markup, hide, delete, "+ New product") and Orders (filter,
/// each order opens in place). Opened from Me -> My merch (`/merch`). Needs a live host; the server answers 403 otherwise.
class MerchStudioScreen extends StatefulWidget {
  const MerchStudioScreen({super.key, this.repo});

  final MerchRepo? repo;

  @override
  State<MerchStudioScreen> createState() => _MerchStudioScreenState();
}

class _MerchStudioScreenState extends State<MerchStudioScreen> {
  int _tab = 0;
  int _reload = 0;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  void _bump() => setState(() => _reload++);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('My merch'),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
              child: Row(children: [
                MerchPill(label: 'Products', selected: _tab == 0, onTap: () => setState(() => _tab = 0)),
                const SizedBox(width: 8),
                MerchPill(label: 'Orders', selected: _tab == 1, onTap: () => setState(() => _tab = 1)),
              ]),
            ),
            Expanded(
              child: _tab == 0
                  ? _ProductsTab(key: ValueKey('products-$_reload'), repo: _repo, onChanged: _bump)
                  : _OrdersTab(key: ValueKey('orders-$_reload'), repo: _repo),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- summary

class _Summary extends StatefulWidget {
  const _Summary({required this.repo});

  final MerchRepo repo;

  @override
  State<_Summary> createState() => _SummaryState();
}

class _SummaryState extends State<_Summary> {
  MerchSummary? _s;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final s = await widget.repo.summary();
      if (mounted) setState(() => _s = s);
    } catch (_) {
      // the lists below say what went wrong; the numbers just stay away
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    if (s == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DesiKpiGrid(children: [
        DesiKpi(label: 'Live products', value: '${s.live}', sub: s.pending > 0 ? '${s.pending} in review' : 'on your page', tone: DesiTone.tea, icon: Icons.checkroom_rounded),
        DesiKpi(label: 'New orders', value: '${s.ordersNew}', sub: '${s.processing + s.shipped} on the way', tone: DesiTone.rani, icon: Icons.shopping_bag_rounded),
        DesiKpi(label: 'Coming to you', value: merchRupees(s.pendingPaise), sub: 'after delivery', tone: DesiTone.gold, icon: Icons.hourglass_top_rounded),
        DesiKpi(label: 'Ready to withdraw', value: merchRupees(s.availablePaise), sub: 'from Payout', tone: DesiTone.lav, icon: Icons.account_balance_wallet_rounded),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------------------------- products

class _ProductsTab extends StatefulWidget {
  const _ProductsTab({super.key, required this.repo, required this.onChanged});

  final MerchRepo repo;
  final VoidCallback onChanged;

  @override
  State<_ProductsTab> createState() => _ProductsTabState();
}

class _ProductsTabState extends State<_ProductsTab> {
  AsyncState<List<MerchProduct>> _state = const AsyncLoading();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final list = await widget.repo.products();
      if (mounted) setState(() => _state = AsyncData(list));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _new() async {
    final made = await context.push<bool>('/merch/new');
    if (made == true && mounted) widget.onChanged();
  }

  void _replace(MerchProduct p) {
    final s = _state;
    if (s is! AsyncData<List<MerchProduct>>) return;
    setState(() => _state = AsyncData([for (final x in s.value) x.id == p.id ? p : x]));
  }

  Future<void> _edit(MerchProduct p) async {
    final updated = await showModalBottomSheet<MerchProduct>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _MarkupSheet(repo: widget.repo, product: p),
    );
    if (updated != null && mounted) {
      _replace(updated);
      toast(context, 'Markup saved.');
    }
  }

  Future<void> _toggleHidden(MerchProduct p) async {
    try {
      final updated = await widget.repo.patchProduct(p.id, {'hidden': p.status == 'live'});
      if (!mounted) return;
      _replace(updated);
      toast(context, updated.status == 'hidden' ? 'Hidden from your page.' : 'Back on your page.');
    } catch (e) {
      if (mounted) toast(context, merchErrorText(e));
    }
  }

  Future<void> _delete(MerchProduct p) async {
    final ok = await hfConfirm(
      context,
      title: 'Delete this product?',
      body: '${p.title} will be removed from your page. This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep it',
      destructive: true,
    );
    if (!ok || !mounted) return;
    try {
      await widget.repo.deleteProduct(p.id);
      if (!mounted) return;
      final s = _state;
      if (s is AsyncData<List<MerchProduct>>) setState(() => _state = AsyncData([for (final x in s.value) if (x.id != p.id) x]));
      toast(context, 'Deleted.');
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.status == 409 && e.code == 'open_orders') {
        await hfConfirm(
          context,
          title: 'Orders still open',
          body: e.userMessage,
          confirmLabel: null,
          cancelLabel: 'OK',
        );
      } else {
        toast(context, e.userMessage);
      }
    } catch (e) {
      if (mounted) toast(context, merchErrorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AsyncView<List<MerchProduct>>(
      state: _state,
      onRetry: () => unawaited(_load()),
      isEmpty: (_) => false,
      builder: (context, items) => RefreshIndicator(
        color: C.maroon,
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
          children: [
            _Summary(repo: widget.repo),
            DesiButton('New product', icon: Icons.add_rounded, kind: DesiButtonKind.rani, expand: true, onTap: () => unawaited(_new())),
            const SizedBox(height: 12),
            if (items.isEmpty)
              const DesiEmpty(text: 'No products yet. Put your art on T-shirts, hoodies, mugs and more, and sell them to your fans.')
            else
              for (final p in items) ...[
                _ProductCard(
                  product: p,
                  onEdit: () => unawaited(_edit(p)),
                  onToggleHidden: () => unawaited(_toggleHidden(p)),
                  onDelete: () => unawaited(_delete(p)),
                ),
                const SizedBox(height: 12),
              ],
            const DesiMogra(),
          ],
        ),
      ),
    );
  }
}

class _ProductCard extends StatelessWidget {
  const _ProductCard({required this.product, required this.onEdit, required this.onToggleHidden, required this.onDelete});

  final MerchProduct product;
  final VoidCallback onEdit;
  final VoidCallback onToggleHidden;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final p = product;
    final canHide = p.status == 'live' || p.status == 'hidden';
    return DesiCard(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          MerchThumb(p.imageUrl, size: 84),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(18)),
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 6, children: [
                merchProductChip(p.status),
                if (p.soldCount > 0) DesiChip('${p.soldCount} sold', tone: DesiTone.white),
              ]),
              const SizedBox(height: 6),
              Text(
                p.sizes.isEmpty ? 'Markup ${merchRupees(p.markupRupees * 100)}' : 'Fans pay from ${merchRupees(p.fromPaise)} (incl. ${merchGstText(p.gstRateBps)} & delivery) · your markup ${merchRupees(p.markupRupees * 100)}',
                style: t(14, color: C.muted, w: FontWeight.w700),
              ),
            ]),
          ),
        ]),
        if (p.status == 'rejected' && (p.reviewNote ?? '').isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(p.reviewNote!, style: t(15, color: C.ruby, w: FontWeight.w700)),
        ],
        if (p.status == 'pending') ...[
          const SizedBox(height: 10),
          Text('Our team is checking it before it goes on sale.', style: t(15, color: C.muted, w: FontWeight.w700)),
        ],
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          DesiButton('Edit markup', icon: Icons.edit_rounded, kind: DesiButtonKind.ghost, onTap: onEdit),
          if (canHide)
            DesiButton(p.status == 'live' ? 'Hide' : 'Show', icon: p.status == 'live' ? Icons.visibility_off_rounded : Icons.visibility_rounded, kind: DesiButtonKind.ghost, onTap: onToggleHidden),
          DesiButton('Delete', icon: Icons.delete_outline_rounded, kind: DesiButtonKind.danger, onTap: onDelete),
        ]),
      ]),
    );
  }
}

/// Change the markup with a live "fan pays / you earn" for every size.
class _MarkupSheet extends StatefulWidget {
  const _MarkupSheet({required this.repo, required this.product});

  final MerchRepo repo;
  final MerchProduct product;

  @override
  State<_MarkupSheet> createState() => _MarkupSheetState();
}

class _MarkupSheetState extends State<_MarkupSheet> {
  late final TextEditingController _c = TextEditingController(text: '${widget.product.markupRupees}');
  MerchCatalog? _cat;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_loadCatalog());
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _loadCatalog() async {
    try {
      final c = await widget.repo.catalog();
      if (mounted) setState(() => _cat = c);
    } catch (_) {
      // the "you earn" column just stays blank
    }
  }

  int? get _markup => int.tryParse(_c.text.trim());
  int get _min => _cat?.minMarkupRupees ?? MerchRepo.flags.value.minMarkupRupees;

  String? get _problem {
    final m = _markup;
    if (m == null) return 'Enter a whole number of rupees.';
    if (m < _min) return 'The markup must be at least ${merchRupees(_min * 100)}.';
    if (m > 5000) return 'The markup can be at most ₹5,000.';
    final cap = _maxMarkup;
    if (m > cap) return 'Clothing is capped at ₹2,500 so the 5% GST rate applies. The most you can add is ${merchRupees(cap * 100)}.';
    return null;
  }

  /// [HF-MERCH-GST-2] Highest markup that keeps every size of this product under the price cap (from the catalog cap and each base).
  /// Only clothing is capped; other categories keep the old limit.
  int get _maxMarkup {
    var best = 5000;
    final cap = widget.product.capApplies == true ? _cat?.priceCapPaise : null;
    if (cap != null) {
      for (final s in widget.product.sizes) {
        final v = (cap - s.basePaise) ~/ 100;
        if (v < best) best = v;
      }
    }
    return best < 0 ? 0 : best;
  }

  Future<void> _save() async {
    final problem = _problem;
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final updated = await widget.repo.patchProduct(widget.product.id, {'markupRupees': _markup});
      if (mounted) Navigator.of(context).pop(updated);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = merchErrorText(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = _markup ?? 0;
    final valid = _problem == null;
    final cat = _cat;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('Your markup', style: t(22, color: C.maroon)),
          const SizedBox(height: 2),
          Text(widget.product.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(15, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 14),
          MerchField(
            label: 'Markup per item (₹)',
            controller: _c,
            keyboard: TextInputType.number,
            formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
            onChanged: (_) => setState(() => _error = null),
          ),
          if (widget.product.capApplies == true) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(merchCapHint, style: t(13, color: C.muted))),
          if (valid)
            for (final s in widget.product.sizes)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    SizedBox(width: 52, child: Text(s.size, style: t(16))),
                    Expanded(child: Text('Fan pays (incl. ${merchGstText(widget.product.gstRateBps)} & delivery) ${merchRupees(s.basePaise + m * 100)}', style: t(15, w: FontWeight.w700))),
                    Text(cat == null ? '' : 'You earn (royalty) ${merchRupees(cat.youEarnPaise(m))}', style: t(15, color: C.rani)),
                  ]),
                  if (s.printingPaise != null && s.shippingPaise != null)
                    Padding(
                      padding: const EdgeInsets.only(left: 52),
                      child: Text(
                        'Printing incl. GST ${merchRupees(s.printingPaise!)} + Shipping ${merchRupees(s.shippingPaise!)} = Base ${merchRupees(s.basePaise)}${widget.product.breakdownEstimated ? ' (estimate)' : ''}',
                        style: t(13, color: C.muted),
                      ),
                    ),
                ]),
              ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w700)),
          ],
          const SizedBox(height: 16),
          DesiButton(_busy ? 'Saving…' : 'Save markup', kind: DesiButtonKind.rani, expand: true, onTap: _busy ? null : () => unawaited(_save())),
        ]),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- orders

class _OrdersTab extends StatefulWidget {
  const _OrdersTab({super.key, required this.repo});

  final MerchRepo repo;

  @override
  State<_OrdersTab> createState() => _OrdersTabState();
}

class _OrdersTabState extends State<_OrdersTab> {
  static const List<(String, String?)> _filters = [
    ('All', null),
    ('New', 'new'),
    ('Getting ready', 'processing'),
    ('Shipped', 'shipped'),
    ('Delivered', 'delivered'),
    ('Cancelled', 'cancelled'),
  ];

  String? _status;
  AsyncState<List<SellerOrder>> _state = const AsyncLoading();
  int _run = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final run = ++_run;
    setState(() => _state = const AsyncLoading());
    try {
      final list = await widget.repo.orders(status: _status);
      if (mounted && run == _run) setState(() => _state = AsyncData(list));
    } catch (e) {
      if (mounted && run == _run) setState(() => _state = AsyncFailure(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      SizedBox(
        height: 56,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
          children: [
            for (final f in _filters) ...[
              MerchPill(
                label: f.$1,
                selected: _status == f.$2,
                onTap: () {
                  if (_status == f.$2) return;
                  setState(() => _status = f.$2);
                  unawaited(_load());
                },
              ),
              const SizedBox(width: 8),
            ],
          ],
        ),
      ),
      Expanded(
        child: AsyncView<List<SellerOrder>>(
          state: _state,
          onRetry: () => unawaited(_load()),
          emptyTitle: 'No orders here yet',
          emptyMessage: 'When a fan buys your product it shows up here.',
          builder: (context, items) => RefreshIndicator(
            color: C.maroon,
            onRefresh: _load,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
              children: [
                for (final o in items) ...[
                  _OrderTile(key: ValueKey(o.id), repo: widget.repo, order: o),
                  const SizedBox(height: 10),
                ],
                const DesiMogra(),
              ],
            ),
          ),
        ),
      ),
    ]);
  }
}

class _OrderTile extends StatefulWidget {
  const _OrderTile({super.key, required this.repo, required this.order});

  final MerchRepo repo;
  final SellerOrder order;

  @override
  State<_OrderTile> createState() => _OrderTileState();
}

class _OrderTileState extends State<_OrderTile> {
  bool _open = false;
  List<TimelineEntry> _timeline = const [];

  Future<void> _toggle() async {
    setState(() => _open = !_open);
    if (!_open) return;
    merchEvent('merch_order_opened', {'role': 'influencer', 'order_id': widget.order.id, 'status': widget.order.status});
    if (_timeline.isNotEmpty) return;
    try {
      final full = await widget.repo.order(widget.order.id);
      if (mounted) setState(() => _timeline = full.timeline);
    } catch (_) {
      // the details above are enough; the steps just stay hidden
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.order;
    final ship = o.shipping;
    final holdDays = MerchRepo.flags.value.holdDays;
    return DesiCard(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(
          button: true,
          label: 'Order ${o.orderNo}',
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => unawaited(_toggle()),
            child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
              MerchThumb(o.imageUrl, size: 64),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(o.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(17)),
                  Text('${o.size} · ${o.colour} · ${o.qty} ${o.qty == 1 ? 'piece' : 'pieces'}', style: t(14, color: C.muted, w: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                    merchSellerStatusChip(o.status),
                    if (o.status != 'cancelled') Text('You earn ${merchRupees(o.youEarnPaise)}', style: t(14, color: C.rani)),
                  ]),
                ]),
              ),
              Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: C.maroon),
            ]),
          ),
        ),
        if (_open) ...[
          const SizedBox(height: 10),
          const Divider(height: 1, color: C.line),
          const SizedBox(height: 8),
          MerchKv('Order', o.orderNo),
          MerchKv('Placed', merchDateTime(o.createdAt)),
          MerchKv('Fan paid (incl. GST & delivery)', merchRupees(o.pricePaise)),
          MerchKv('Base price', merchRupees(o.basePaise)),
          MerchKv('You earn', o.status == 'cancelled' ? '₹0' : merchRupees(o.youEarnPaise), strong: true),
          if (o.status != 'cancelled')
            MerchKv(
              'Withdraw from',
              o.credited && o.availableAt != null
                  ? merchDate(o.availableAt!)
                  : (o.availableAt != null ? merchDate(o.availableAt!) : 'About $holdDays days after delivery'),
            ),
          const SizedBox(height: 6),
          Text('Sent to', style: t(15, color: C.maroon)),
          const SizedBox(height: 2),
          Text(o.firstName, style: t(16)),
          Text([o.city, o.state].where((e) => e.isNotEmpty).join(', '), style: t(15, color: C.muted, w: FontWeight.w700)),
          if (o.addressMasked.isNotEmpty) Text(o.addressMasked, style: t(15, color: C.muted, w: FontWeight.w700)),
          if (ship != null) ...[
            const SizedBox(height: 10),
            Text([ship.courier, ship.awb].whereType<String>().join(' · '), style: t(15, w: FontWeight.w700)),
            if (ship.trackingUrl != null) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: DesiButton('Track parcel', icon: Icons.local_shipping_rounded, kind: DesiButtonKind.tea, onTap: () => unawaited(openMerchLink(context, ship.trackingUrl!))),
              ),
            ],
          ],
          if (_timeline.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('What happened', style: t(15, color: C.maroon)),
            const SizedBox(height: 4),
            MerchTimeline(_timeline),
          ],
        ],
      ]),
    );
  }
}
