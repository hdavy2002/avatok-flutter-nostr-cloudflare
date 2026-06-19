import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../payout/payout_screen.dart';
import 'admin_money_screen.dart';

// ── AvaWallet (Phase 2) ───────────────────────────────────────────────────────
// Balance cards + the double-entry ledger trail: infinite scroll on the server's
// keyset cursor, server-side filters (type chips / date range / search), row
// detail sheet with the fee breakdown, and the Stripe top-up flow. Local-first:
// the drift wallet_ledger_cache (per-account DB file) paints instantly, then the
// network refresh merges in.

final _kTypes = <String, ({String label, IconData icon, bool inflow})>{
  'topup': (label: 'Top-up', icon: PhosphorIcons.creditCard(PhosphorIconsStyle.bold), inflow: true),
  'purchase_hold': (label: 'Purchase', icon: PhosphorIcons.shoppingBag(PhosphorIconsStyle.bold), inflow: false),
  'escrow_release': (label: 'Earning', icon: PhosphorIcons.medal(PhosphorIconsStyle.bold), inflow: true),
  'refund': (label: 'Refund', icon: PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), inflow: true),
  'fee': (label: 'Fee', icon: PhosphorIcons.percent(PhosphorIconsStyle.bold), inflow: false),
  'payout': (label: 'Payout', icon: PhosphorIcons.bank(PhosphorIconsStyle.bold), inflow: false),
  'donation': (label: 'Donation', icon: PhosphorIcons.heart(PhosphorIconsStyle.bold), inflow: false),
  'storage_charge': (label: 'Storage', icon: PhosphorIcons.cloud(PhosphorIconsStyle.bold), inflow: false),
  'adjustment': (label: 'Adjustment', icon: PhosphorIcons.wrench(PhosphorIconsStyle.bold), inflow: true),
};

String _usd(num coins) {
  final v = coins.abs() / 100.0;
  return '\$${v.toStringAsFixed(2)}';
}

String _dateShort(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${d.day} ${m[d.month - 1]} ${d.year != DateTime.now().year ? d.year : ''}'.trim();
}

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});
  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  int _balance = 0, _held = 0;
  final List<Map<String, dynamic>> _entries = [];
  String? _cursor;
  bool _loading = false, _exhausted = false, _admin = false;

  // Filters (server-side).
  final Set<String> _typeFilter = {};
  DateTimeRange? _range;
  String _query = '';
  final _searchCtrl = TextEditingController();
  final _scroll = ScrollController();

  bool get _filtered => _typeFilter.isNotEmpty || _range != null || _query.isNotEmpty;

  @override
  void initState() {
    super.initState();
    Analytics.capture('wallet_viewed');
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) _loadMore();
    });
    _paintFromCache();
    _refresh();
    MoneyApi.isAdmin().then((a) { if (mounted && a) setState(() => _admin = true); });
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _paintFromCache() async {
    if (_filtered) return; // cache is the unfiltered trail
    try {
      final rows = await Db.I.walletLedgerOnce();
      if (!mounted || rows.isEmpty || _entries.isNotEmpty) return;
      setState(() {
        _entries.addAll(rows.map((r) => (jsonDecode(r.json) as Map).cast<String, dynamic>()));
      });
    } catch (_) {/* cache is best-effort */}
  }

  Future<void> _refresh() async {
    setState(() { _cursor = null; _exhausted = false; });
    final bal = MoneyApi.balance();
    await _fetchPage(reset: true);
    final b = await bal;
    if (mounted && b['balance'] is num) {
      setState(() { _balance = (b['balance'] as num).toInt(); _held = ((b['held'] as num?) ?? 0).toInt(); });
    }
  }

  Future<void> _loadMore() => _fetchPage();

  Future<void> _fetchPage({bool reset = false}) async {
    if (_loading || (_exhausted && !reset)) return;
    setState(() => _loading = true);
    try {
      final r = await MoneyApi.ledger(
        cursor: reset ? null : _cursor,
        types: _typeFilter.toList(),
        from: _range?.start.millisecondsSinceEpoch,
        to: _range == null ? null : _range!.end.add(const Duration(days: 1)).millisecondsSinceEpoch,
        q: _query,
      );
      final list = ((r['entries'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
      if (!mounted) return;
      setState(() {
        if (reset) _entries.clear();
        _entries.addAll(list);
        _cursor = r['cursor'] as String?;
        _exhausted = _cursor == null;
      });
      // Local-first: merge the unfiltered head page into the per-account cache.
      if (!_filtered) {
        await Db.I.upsertWalletLedger([
          for (final e in list)
            (id: '${e['id']}', createdAt: ((e['created_at'] as num?) ?? 0).toInt(), type: '${e['type']}', json: jsonEncode(e)),
        ]);
      }
    } catch (_) {/* offline → cache stays */} finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // This-month in/out from the loaded trail (signed amounts from the server).
  (int, int) _monthInOut() {
    final now = DateTime.now();
    final lo = DateTime(now.year, now.month).millisecondsSinceEpoch;
    var inn = 0, out = 0;
    for (final e in _entries) {
      if (((e['created_at'] as num?) ?? 0) < lo) continue;
      final a = ((e['amount'] as num?) ?? 0).toInt();
      if (a >= 0) { inn += a; } else { out += -a; }
    }
    return (inn, out);
  }

  // ── top-up ──────────────────────────────────────────────────────────────
  Future<void> _topupFlow() async {
    final ctrl = TextEditingController();
    final cents = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(c).viewInsets.bottom + 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Top up wallet', style: ZineText.cardTitle(size: 21)),
          const SizedBox(height: 4),
          Text('Any amount. 1 AvaCoin = \$0.01.', style: ZineText.sub(size: 14)),
          const SizedBox(height: 16),
          ZineField(
            controller: ctrl,
            autofocus: true,
            leadText: '\$',
            hint: '10.00',
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
          ),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final v in [5, 10, 25, 50])
              ZineSticker('\$$v', onTap: () => ctrl.text = v.toStringAsFixed(2)),
          ]),
          const SizedBox(height: 18),
          ZineButton(
            label: 'Continue to payment',
            fullWidth: true,
            icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
            onPressed: () {
              final d = double.tryParse(ctrl.text.trim());
              if (d == null || d < 0.5 || d > 500) return;
              Navigator.pop(c, (d * 100).round());
            },
          ),
        ]),
      ),
    );
    if (cents == null || !mounted) return;

    Analytics.capture('wallet_topup_started', {'cents': cents});
    final r = await MoneyApi.topup(cents);
    if (!mounted) return;
    final url = r['checkout_url'] as String?;
    if (url != null) {
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      if (!mounted) return;
      // On return, refresh — webhook credit may take a few seconds.
      await showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Finishing payment…', style: ZineText.cardTitle()),
          content: Text('Complete the payment in your browser, then come back and tap Done.',
              style: ZineText.sub(size: 14)),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: Text('Done', style: ZineText.link(size: 14)),
            ),
          ],
        ),
      );
      final before = _balance;
      await _refresh();
      if (mounted && _balance > before) {
        Analytics.capture('wallet_topup_succeeded', {'cents': cents});
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Added ${_usd(_balance - before)} to your wallet')));
      }
    } else if (r['reason'] == 'pending_legal_approval') {
      _snack('Top-ups are not live yet — coming soon.');
    } else if (r['status'] == 429) {
      _snack('Too many top-up attempts. Try again in a little while.');
    } else {
      _snack('Top-up failed: ${r['error'] ?? 'unknown error'}');
    }
  }

  void _snack(String m) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  // ── filters ─────────────────────────────────────────────────────────────
  void _applyFilters() {
    Analytics.capture('wallet_filter_used', {
      'types': _typeFilter.join(','), 'range': _range != null, 'q': _query.isNotEmpty,
    });
    _fetchPage(reset: true);
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final r = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 3),
      lastDate: now,
      initialDateRange: _range,
    );
    if (r != null || _range != null) {
      setState(() => _range = r ?? _range);
      if (r != null) _applyFilters();
    }
  }

  // ── detail sheet ────────────────────────────────────────────────────────
  Future<void> _showDetail(Map<String, dynamic> e) async {
    final id = '${e['id']}';
    Map<String, dynamic> d = {'entry': e};
    try { d = await MoneyApi.ledgerDetail(id); } catch (_) {/* offline: show row */}
    if (!mounted) return;
    final entry = ((d['entry'] as Map?) ?? e).cast<String, dynamic>();
    final meta = ((entry['meta'] as Map?) ?? const {}).cast<String, dynamic>();
    final related = ((d['related'] as List?) ?? const []).map((x) => (x as Map).cast<String, dynamic>()).toList();
    final amount = ((entry['amount'] as num?) ?? 0).toInt();
    final t = _kTypes['${entry['type']}'];
    final gross = (meta['gross'] as num?)?.toInt();
    final fee = (meta['fee'] as num?)?.toInt() ?? related.where((r) => r['type'] == 'fee').fold<int>(0, (s, r) => s + ((r['amount'] as num?) ?? 0).toInt().abs());
    final net = (meta['net'] as num?)?.toInt();

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (c) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(
                icon: t?.icon ?? PhosphorIcons.swap(PhosphorIconsStyle.bold),
                color: amount >= 0 ? Zine.mint : Zine.coral,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${entry['title'] ?? t?.label ?? entry['type']}',
                      style: ZineText.value(size: 16), maxLines: 2, overflow: TextOverflow.ellipsis),
                  Text(_fullDate(((entry['created_at'] as num?) ?? 0).toInt()).toUpperCase(),
                      style: ZineText.kicker(size: 10, color: Zine.inkMute)),
                ]),
              ),
              Text('${amount >= 0 ? '+' : '−'}${_usd(amount)}',
                  style: ZineText.value(size: 18, weight: FontWeight.w900,
                      color: amount >= 0 ? Zine.mintInk : Zine.coral)),
            ]),
            const SizedBox(height: 16),
            Container(height: Zine.bw, color: Zine.ink),
            const SizedBox(height: 12),
            _kv('From', '${entry['debit'] ?? '—'}'),
            _kv('To', '${entry['credit'] ?? '—'}'),
            if (gross != null) _kv('Gross', _usd(gross)),
            if (fee > 0) _kv('Platform fee', '− ${_usd(fee)}'),
            if (net != null) _kv('Net', _usd(net)),
            if (meta['reason'] != null) _kv('Reason', '${meta['reason']}'),
            if (entry['ref'] != null) _kv('Reference', '${entry['ref']}'),
            _kv('Coins', '${amount.abs()}'),
            const SizedBox(height: 16),
            ZineButton(
              label: 'Email me this receipt',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              trailingIcon: false,
              icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
              onPressed: () async {
                final r = await MoneyApi.resendReceipt(id);
                if (c.mounted) Navigator.pop(c);
                _snack(r['sent'] == true ? 'Receipt sent to your email.' : 'Could not send the receipt.');
              },
            ),
          ]),
        ),
      ),
    );
  }

  String _fullDate(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${_dateShort(ms)} ${d.year == DateTime.now().year ? d.year : ''} · ${p(d.hour)}:${p(d.minute)}'.replaceAll('  ', ' ');
  }

  /// Ledger-style key/value row (§7.10): label + dotted leader + value.
  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Text(k, style: ZineText.sub(size: 13.5)),
          const SizedBox(width: 6),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ZineText.sub(size: 13, color: Zine.inkMute)),
          ),
          const SizedBox(width: 6),
          Flexible(child: Text(v, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.value(size: 14, weight: FontWeight.w900))),
        ]),
      );

  // ── build ───────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final (inn, out) = _monthInOut();
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'AvaWallet',
        markWord: 'Wallet',
        tag: 'your avacoins',
        actions: [
          if (_admin)
            ZineBackButton(
              icon: PhosphorIcons.shieldStar(PhosphorIconsStyle.bold),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AdminMoneyScreen())),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        color: Zine.blueInk,
        child: CustomScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(child: _header(inn, out)),
            SliverToBoxAdapter(child: _filterBar()),
            if (_entries.isEmpty && !_loading)
              SliverFillRemaining(
                hasScrollBody: false,
                child: Center(
                  child: ZineEmptyState(
                    icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold),
                    text: 'No transactions yet — top up to get rolling.',
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(18, 4, 18, 24),
                sliver: SliverList.separated(
                  itemCount: _entries.length + (_exhausted ? 0 : 1),
                  separatorBuilder: (_, __) => const SizedBox(height: 2),
                  itemBuilder: (c, i) {
                    if (i >= _entries.length) {
                      _loadMore();
                      return const Padding(
                          padding: EdgeInsets.all(16),
                          child: Center(child: SizedBox(width: 20, height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))));
                    }
                    return _row(_entries[i]);
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _header(int inn, int out) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 4),
      child: Column(children: [
        // Hero balance — MINT money card (§7.10 reference: Earnings leans mint).
        ZineCard(
          color: Zine.mint,
          padding: const EdgeInsets.all(20),
          boxShadow: Zine.shadow,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineCardHead(
              icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
              accent: Zine.card,
              title: 'Balance',
              tag: 'avacoins',
            ),
            const SizedBox(height: 14),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(_usd(_balance), style: ZineText.stat(size: 48)),
            ),
            const SizedBox(height: 4),
            Text(
              '$_balance AvaCoins${_held > 0 ? '  ·  ${_usd(_held)} pending (7-day hold)' : ''}',
              style: ZineText.value(size: 14, weight: FontWeight.w900),
            ),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(
                child: ZineButton(
                  label: 'Top up',
                  fontSize: 17,
                  trailingIcon: false,
                  icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
                  onPressed: _topupFlow,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ZineButton(
                  label: 'Withdraw',
                  variant: ZineButtonVariant.blue,
                  fontSize: 17,
                  trailingIcon: false,
                  icon: PhosphorIcons.bank(PhosphorIconsStyle.bold),
                  onPressed: () => Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const PayoutScreen())),
                ),
              ),
            ]),
          ]),
        ),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(child: _miniCard('This month in', '+${_usd(inn)}',
              PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold), Zine.mint, Zine.mintInk)),
          const SizedBox(width: 10),
          Expanded(child: _miniCard('This month out', '−${_usd(out)}',
              PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), Zine.coral, Zine.coral)),
        ]),
      ]),
    );
  }

  /// Metric card (§7.11): icon badge + Nunito number + mono caption.
  Widget _miniCard(String label, String value, IconData icon, Color accent, Color valueColor) => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: accent, size: 30),
          const SizedBox(height: 10),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value, style: ZineText.stat(size: 24, color: valueColor)),
          ),
          const SizedBox(height: 3),
          Text(label.toUpperCase(), style: ZineText.kicker(size: 9.5)),
        ]),
      );

  Widget _filterBar() {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
        child: ZineField(
          controller: _searchCtrl,
          hint: 'Search by event or consult name',
          leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
          trailing: _query.isEmpty
              ? null
              : GestureDetector(
                  onTap: () { _searchCtrl.clear(); setState(() => _query = ''); _applyFilters(); },
                  child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
                ),
          onSubmitted: (v) { setState(() => _query = v.trim()); _applyFilters(); },
        ),
      ),
      SizedBox(
        height: 52,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
          children: [
            ZineChip(
              label: _range == null
                  ? 'Dates'
                  : '${_dateShort(_range!.start.millisecondsSinceEpoch)} – ${_dateShort(_range!.end.millisecondsSinceEpoch)}',
              active: _range != null,
              onTap: _pickRange,
            ),
            if (_range != null) ...[
              const SizedBox(width: 8),
              ZineChip(
                label: 'Clear dates',
                onTap: () { setState(() => _range = null); _applyFilters(); },
              ),
            ],
            const SizedBox(width: 8),
            for (final t in _kTypes.entries.where((e) => e.key != 'storage_charge')) ...[
              ZineChip(
                label: t.value.label,
                active: _typeFilter.contains(t.key),
                onTap: () {
                  setState(() => _typeFilter.contains(t.key) ? _typeFilter.remove(t.key) : _typeFilter.add(t.key));
                  _applyFilters();
                },
              ),
              const SizedBox(width: 8),
            ],
          ],
        ),
      ),
    ]);
  }

  /// Transaction row — ledger style (§7.10): label + dotted leader + value.
  /// Credits in mint-ink, debits in coral.
  Widget _row(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final t = _kTypes['${e['type']}'];
    final positive = amount >= 0;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _showDetail(e),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            Flexible(
              child: Text('${e['title'] ?? t?.label ?? e['type']}',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 14, weight: FontWeight.w800)),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                  style: ZineText.sub(size: 13, color: Zine.inkMute)),
            ),
            const SizedBox(width: 6),
            Text('${positive ? '+' : '−'}${_usd(amount)}',
                style: ZineText.value(size: 14.5, weight: FontWeight.w900,
                    color: positive ? Zine.mintInk : Zine.coral)),
          ]),
          const SizedBox(height: 2),
          Text('${t?.label ?? e['type']} · ${_dateShort(((e['created_at'] as num?) ?? 0).toInt())}'.toUpperCase(),
              style: ZineText.kicker(size: 9.5, color: Zine.inkMute)),
        ]),
      ),
    );
  }
}
