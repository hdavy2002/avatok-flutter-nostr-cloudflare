import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/theme.dart';
import 'admin_money_screen.dart';

// ── AvaWallet (Phase 2) ───────────────────────────────────────────────────────
// Balance cards + the double-entry ledger trail: infinite scroll on the server's
// keyset cursor, server-side filters (type chips / date range / search), row
// detail sheet with the fee breakdown, and the Stripe top-up flow. Local-first:
// the drift wallet_ledger_cache (per-account DB file) paints instantly, then the
// network refresh merges in.

const _kTypes = <String, ({String label, IconData icon, bool inflow})>{
  'topup': (label: 'Top-up', icon: Icons.add_card, inflow: true),
  'purchase_hold': (label: 'Purchase', icon: Icons.shopping_bag_outlined, inflow: false),
  'escrow_release': (label: 'Earning', icon: Icons.workspace_premium_outlined, inflow: true),
  'refund': (label: 'Refund', icon: Icons.replay_circle_filled_outlined, inflow: true),
  'fee': (label: 'Fee', icon: Icons.percent, inflow: false),
  'payout': (label: 'Payout', icon: Icons.account_balance_outlined, inflow: false),
  'donation': (label: 'Donation', icon: Icons.favorite_outline, inflow: false),
  'storage_charge': (label: 'Storage', icon: Icons.cloud_outlined, inflow: false),
  'adjustment': (label: 'Adjustment', icon: Icons.build_circle_outlined, inflow: true),
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
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(c).viewInsets.bottom + 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Top up wallet', style: Theme.of(c).textTheme.titleLarge),
          const SizedBox(height: 4),
          const Text('Any amount. 1 AvaCoin = \$0.01.', style: TextStyle(color: AvaColors.sub)),
          const SizedBox(height: 16),
          TextField(
            controller: ctrl,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(prefixText: '\$ ', hintText: '10.00', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            for (final v in [5, 10, 25, 50])
              ActionChip(label: Text('\$$v'), onPressed: () => ctrl.text = v.toStringAsFixed(2)),
          ]),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: () {
                final d = double.tryParse(ctrl.text.trim());
                if (d == null || d < 0.5 || d > 500) return;
                Navigator.pop(c, (d * 100).round());
              },
              child: const Text('Continue to payment'),
            ),
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
          title: const Text('Finishing payment…'),
          content: const Text('Complete the payment in your browser, then come back and tap Done.'),
          actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))],
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
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (c) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              CircleAvatar(
                backgroundColor: (amount >= 0 ? AvaColors.success : AvaColors.danger).withValues(alpha: .12),
                child: Icon(t?.icon ?? Icons.swap_horiz, color: amount >= 0 ? AvaColors.success : AvaColors.danger),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${entry['title'] ?? t?.label ?? entry['type']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16), maxLines: 2, overflow: TextOverflow.ellipsis),
                  Text(_fullDate(((entry['created_at'] as num?) ?? 0).toInt()), style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                ]),
              ),
              Text('${amount >= 0 ? '+' : '−'}${_usd(amount)}',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: amount >= 0 ? AvaColors.success : AvaColors.danger)),
            ]),
            const SizedBox(height: 16),
            const Divider(height: 1),
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
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                icon: const Icon(Icons.mail_outline, size: 18),
                label: const Text('Email me this receipt'),
                onPressed: () async {
                  final r = await MoneyApi.resendReceipt(id);
                  if (c.mounted) Navigator.pop(c);
                  _snack(r['sent'] == true ? 'Receipt sent to your email.' : 'Could not send the receipt.');
                },
              ),
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

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text(k, style: const TextStyle(color: AvaColors.sub))),
          Expanded(child: Text(v, style: const TextStyle(fontWeight: FontWeight.w600))),
        ]),
      );

  // ── build ───────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final (inn, out) = _monthInOut();
    return Scaffold(
      appBar: AppBar(
        title: const Text('AvaWallet'),
        actions: [
          if (_admin)
            IconButton(
              tooltip: 'Money ops console',
              icon: const Icon(Icons.admin_panel_settings_outlined),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AdminMoneyScreen())),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: CustomScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(child: _header(inn, out)),
            SliverToBoxAdapter(child: _filterBar()),
            if (_entries.isEmpty && !_loading)
              const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(child: Text('No transactions yet', style: TextStyle(color: AvaColors.sub))),
              )
            else
              SliverList.separated(
                itemCount: _entries.length + (_exhausted ? 0 : 1),
                separatorBuilder: (_, __) => const Divider(height: 1, indent: 68),
                itemBuilder: (c, i) {
                  if (i >= _entries.length) {
                    _loadMore();
                    return const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))));
                  }
                  return _row(_entries[i]);
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _header(int inn, int out) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Column(children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [AvaColors.brand, Color(0xFF0AA3A3)], begin: Alignment.topLeft, end: Alignment.bottomRight),
            borderRadius: BorderRadius.circular(20),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Balance', style: TextStyle(color: Colors.white70, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(_usd(_balance), style: const TextStyle(color: Colors.white, fontSize: 34, fontWeight: FontWeight.w800)),
            Text('$_balance AvaCoins${_held > 0 ? '  ·  ${_usd(_held)} pending (7-day hold)' : ''}',
                style: const TextStyle(color: Colors.white70, fontSize: 13)),
            const SizedBox(height: 14),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: AvaColors.ink),
              onPressed: _topupFlow,
              icon: const Icon(Icons.add),
              label: const Text('Top up'),
            ),
          ]),
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: _miniCard('This month in', '+${_usd(inn)}', AvaColors.success)),
          const SizedBox(width: 10),
          Expanded(child: _miniCard('This month out', '−${_usd(out)}', AvaColors.danger)),
        ]),
      ]),
    );
  }

  Widget _miniCard(String label, String value, Color color) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
          const SizedBox(height: 2),
          Text(value, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 16)),
        ]),
      );

  Widget _filterBar() {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: TextField(
          controller: _searchCtrl,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: 'Search by event or consult name',
            prefixIcon: const Icon(Icons.search, size: 20),
            suffixIcon: _query.isEmpty ? null : IconButton(icon: const Icon(Icons.clear, size: 18), onPressed: () { _searchCtrl.clear(); setState(() => _query = ''); _applyFilters(); }),
            isDense: true,
            filled: true,
            fillColor: AvaColors.soft,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
          ),
          onSubmitted: (v) { setState(() => _query = v.trim()); _applyFilters(); },
        ),
      ),
      SizedBox(
        height: 48,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          children: [
            FilterChip(
              label: Text(_range == null ? 'Dates' : '${_dateShort(_range!.start.millisecondsSinceEpoch)} – ${_dateShort(_range!.end.millisecondsSinceEpoch)}'),
              selected: _range != null,
              avatar: const Icon(Icons.calendar_today_outlined, size: 14),
              onSelected: (_) => _pickRange(),
              onDeleted: _range == null ? null : () { setState(() => _range = null); _applyFilters(); },
            ),
            const SizedBox(width: 8),
            for (final t in _kTypes.entries.where((e) => e.key != 'storage_charge')) ...[
              FilterChip(
                label: Text(t.value.label),
                selected: _typeFilter.contains(t.key),
                onSelected: (s) {
                  setState(() => s ? _typeFilter.add(t.key) : _typeFilter.remove(t.key));
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

  Widget _row(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final t = _kTypes['${e['type']}'];
    final positive = amount >= 0;
    return ListTile(
      onTap: () => _showDetail(e),
      leading: CircleAvatar(
        backgroundColor: (positive ? AvaColors.success : AvaColors.danger).withValues(alpha: .10),
        child: Icon(t?.icon ?? Icons.swap_horiz, size: 20, color: positive ? AvaColors.success : AvaColors.danger),
      ),
      title: Text('${e['title'] ?? t?.label ?? e['type']}', maxLines: 1, overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Text('${t?.label ?? e['type']} · ${_dateShort(((e['created_at'] as num?) ?? 0).toInt())}',
          style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
      trailing: Text('${positive ? '+' : '−'}${_usd(amount)}',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: positive ? AvaColors.success : AvaColors.danger)),
    );
  }
}
