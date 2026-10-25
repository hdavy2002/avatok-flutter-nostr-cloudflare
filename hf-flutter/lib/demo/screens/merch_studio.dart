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
import '../merch_parity_kit.dart'; // [HF-APP-PARITY-MERCH-1]
import '../share_page_kit.dart'; // [HF-APP-PARITY-MERCH-1]
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
  MerchSummary? _summary; // [HF-APP-PARITY-MERCH-1] one read for the strip and the order counts

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_loadSummary());
  }

  Future<void> _loadSummary() async {
    try {
      final s = await _repo.summary();
      if (mounted) setState(() => _summary = s);
    } catch (_) {
      // the lists say what went wrong; the numbers just stay away
    }
  }

  void _bump() {
    setState(() => _reload++);
    unawaited(_loadSummary());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('My merch'),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
              child: Row(children: [
                MerchPill(label: 'Products', selected: _tab == 0, onTap: () => setState(() => _tab = 0)),
                const SizedBox(width: 8),
                MerchPill(label: _summary != null && _summary!.ordersNew > 0 ? 'Orders (${_summary!.ordersNew})' : 'Orders', selected: _tab == 1, onTap: () => setState(() => _tab = 1)),
              ]),
            ),
            Expanded(
              child: _tab == 0
                  ? _ProductsTab(key: ValueKey('products-$_reload'), repo: _repo, summary: _summary, onChanged: _bump)
                  : _OrdersTab(key: ValueKey('orders-$_reload'), repo: _repo, summary: _summary),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- summary

class _Summary extends StatelessWidget {
  const _Summary({required this.summary});

  final MerchSummary? summary;

  @override
  Widget build(BuildContext context) {
    final s = summary;
    if (s == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DesiKpiGrid(children: [
          DesiKpi(label: 'Live products', value: '${s.live}', sub: s.pending > 0 ? '${s.pending} waiting for review' : 'on your page', tone: DesiTone.tea, icon: Icons.checkroom_rounded),
          DesiKpi(label: 'New orders', value: '${s.ordersNew}', sub: '${s.processing} processing · ${s.shipped} shipped', tone: DesiTone.rani, icon: Icons.shopping_bag_rounded),
          DesiKpi(label: 'Royalty coming', value: merchRupees(s.pendingPaise), sub: 'unlocks after the hold', tone: DesiTone.gold, icon: Icons.hourglass_top_rounded),
          DesiKpi(label: 'Ready to withdraw', value: merchRupees(s.availablePaise), sub: 'from Payout', tone: DesiTone.lav, icon: Icons.account_balance_wallet_rounded),
        ]),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: DesiButton('Earnings & withdrawals', icon: Icons.account_balance_wallet_rounded, kind: DesiButtonKind.ghost, onTap: () => unawaited(context.push<Object?>('/payout'))),
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------------------------- products

class _ProductsTab extends StatefulWidget {
  const _ProductsTab({super.key, required this.repo, required this.summary, required this.onChanged});

  final MerchRepo repo;
  final MerchSummary? summary;
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
      toast(context, 'Saved.');
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
        final canHide = p.status == 'live';
        final hide = await hfConfirm(
          context,
          title: 'Orders still open',
          body: e.userMessage,
          confirmLabel: canHide ? 'Hide it instead' : null,
          cancelLabel: 'OK',
        );
        if (hide && canHide && mounted) await _toggleHidden(p);
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
            const ShareShopRow(), // [HF-APP-PARITY-MERCH-1]
            _Summary(summary: widget.summary),
            MerchGstinCard(repo: widget.repo), // [HF-APP-PARITY-MERCH-1]
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

/// "₹120" for one value, "₹120 – ₹180" for a spread.
String _range(Iterable<int> paise) {
  if (paise.isEmpty) return '—';
  final lo = paise.reduce((a, b) => a < b ? a : b);
  final hi = paise.reduce((a, b) => a > b ? a : b);
  return lo == hi ? merchRupees(lo) : '${merchRupees(lo)} – ${merchRupees(hi)}';
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
              if (p.catalogName.isNotEmpty || p.colours.isNotEmpty)
                Text(
                  [if (p.catalogName.isNotEmpty) p.catalogName, if (p.colours.isNotEmpty) '${p.colours.length} ${p.colours.length == 1 ? 'colour' : 'colours'}'].join(' · '),
                  style: t(14, color: C.muted, w: FontWeight.w700),
                ),
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
              if (p.sizes.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text.rich(TextSpan(children: [
                  TextSpan(text: _range(p.sizes.map((s) => s.youEarnPaise)), style: t(15, color: C.rani)),
                  TextSpan(text: ' design royalty per item', style: t(14, color: C.muted, w: FontWeight.w700)),
                ])),
              ],
            ]),
          ),
        ]),
        if (p.status == 'rejected' && (p.reviewNote ?? '').isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(p.reviewNote!, style: t(15, color: C.ruby, w: FontWeight.w700)),
        ],
        if (p.status == 'pending') ...[
          const SizedBox(height: 10),
          Text(
            (p.reviewNote ?? '').isNotEmpty ? p.reviewNote! : 'Our team is checking your art. You can still change the price.',
            style: t(15, color: C.muted, w: FontWeight.w700),
          ),
        ],
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          DesiButton('Edit price', icon: Icons.edit_rounded, kind: DesiButtonKind.ghost, onTap: onEdit),
          if (canHide)
            DesiButton(p.status == 'live' ? 'Hide' : 'Show', icon: p.status == 'live' ? Icons.visibility_off_rounded : Icons.visibility_rounded, kind: DesiButtonKind.ghost, onTap: onToggleHidden),
          if (p.status == 'live' && p.publicUrl.isNotEmpty)
            DesiButton('Copy link', icon: Icons.copy_rounded, kind: DesiButtonKind.ghost, onTap: () async {
              await Clipboard.setData(ClipboardData(text: p.publicUrl));
              if (context.mounted) toast(context, 'Link copied. Share it with your fans.');
            }),
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
  late final TextEditingController _title = TextEditingController(text: widget.product.title); // [HF-APP-PARITY-MERCH-1]
  late final TextEditingController _desc = TextEditingController(text: widget.product.description);
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
    _title.dispose();
    _desc.dispose();
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
    if (_title.text.trim().isEmpty) return 'Give the product a name.';
    if (m == null) return 'Enter a whole number of rupees.';
    if (m < _min) return 'The markup must be at least ${merchRupees(_min * 100)}.';
    if (m > 5000) return 'The markup can be at most ₹5,000.';
    final cap = _maxMarkup;
    if (m > cap) return '$_capHint The most you can add is ${merchRupees(cap * 100)}.';
    return null;
  }

  /// [HF-MERCH-PARITY-1] The cap sentence from the catalog's own cap and this product's GST rate (web `capHint`).
  String get _capHint => merchCapHintFor(capPaise: _cat?.priceCapPaise, gstBps: widget.product.gstRateBps ?? _cat?.gstRateBps);

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
      final body = <String, Object?>{};
      if (_markup != widget.product.markupRupees) body['markupRupees'] = _markup;
      if (_title.text.trim() != widget.product.title) body['title'] = _title.text.trim();
      if (_desc.text.trim() != widget.product.description.trim()) body['description'] = _desc.text.trim();
      if (body.isEmpty) {
        if (mounted) Navigator.of(context).pop(widget.product);
        return;
      }
      final updated = await widget.repo.patchProduct(widget.product.id, body);
      merchEvent('merch_product_edited', {'product_id': widget.product.id, 'markup': _markup});
      if (mounted) Navigator.of(context).pop(updated);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = merchErrorText(e, capPaise: _cat?.priceCapPaise, gstBps: widget.product.gstRateBps ?? _cat?.gstRateBps);
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
          Text('Edit product', style: t(22, color: C.maroon)),
          const SizedBox(height: 14),
          MerchField(label: 'Name', controller: _title, capitalization: TextCapitalization.sentences, formatters: [LengthLimitingTextInputFormatter(80)], onChanged: (_) => setState(() => _error = null)),
          MerchField(label: 'Description', controller: _desc, maxLines: 3, capitalization: TextCapitalization.sentences, formatters: [LengthLimitingTextInputFormatter(600)]),
          MerchField(
            label: 'Markup per item (₹)',
            controller: _c,
            keyboard: TextInputType.number,
            formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
            onChanged: (_) => setState(() => _error = null),
          ),
          if (widget.product.capApplies == true) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(_capHint, style: t(14, color: C.muted))),
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
                        style: t(14, color: C.muted),
                      ),
                    ),
                ]),
              ),
          if (cat != null) MerchPriceNote(shareBps: cat.platformShareBps, holdDays: cat.holdDays),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w700)),
          ],
          const SizedBox(height: 16),
          DesiButton(_busy ? 'Saving…' : 'Save', kind: DesiButtonKind.rani, expand: true, onTap: _busy ? null : () => unawaited(_save())),
        ]),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- orders

class _OrdersTab extends StatefulWidget {
  const _OrdersTab({super.key, required this.repo, required this.summary});

  final MerchRepo repo;
  final MerchSummary? summary;

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

  /// "New (2)": the counts the summary strip reads, like the website's filter chips.
  String _pillLabel((String, String?) f) {
    final s = widget.summary;
    final n = s == null
        ? 0
        : switch (f.$2) {
            'new' => s.ordersNew,
            'processing' => s.processing,
            'shipped' => s.shipped,
            'delivered' => s.delivered,
            _ => 0,
          };
    return n > 0 ? '${f.$1} ($n)' : f.$1;
  }

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
                label: _pillLabel(f),
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
          MerchKv(
            'Withdrawable',
            o.status == 'cancelled'
                ? 'Cancelled, nothing to pay'
                : o.credited && (o.availableAt == null || !o.availableAt!.isAfter(DateTime.now()))
                    ? 'Available now'
                    : (o.availableAt != null ? 'From ${merchDate(o.availableAt!)}' : '$holdDays days after delivery'),
          ),
          const SizedBox(height: 6),
          Text('Sent to', style: t(15, color: C.maroon)),
          const SizedBox(height: 2),
          Text(o.firstName, style: t(16)),
          Text([o.city, o.state].where((e) => e.isNotEmpty).join(', '), style: t(15, color: C.muted, w: FontWeight.w700)),
          if (o.addressMasked.isNotEmpty) Text(o.addressMasked, style: t(15, color: C.muted, w: FontWeight.w700)),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('The fan’s full address and phone are kept private. We print and ship for you.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3)),
          ),
          if (ship != null) ...[
            const SizedBox(height: 10),
            if (ship.courier != null) MerchKv('Courier', ship.courier!),
            if (ship.awb != null) MerchKv('Tracking no.', ship.awb!),
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
