import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../sync/sync_hub.dart';
import '../wallet/wallet_screen.dart';

class _CatStyle {
  final String label;
  final Color color;
  const _CatStyle(this.label, this.color);
}

const _catStyles = <String, _CatStyle>{
  'image': _CatStyle('Images', Zine.blue),
  'video': _CatStyle('Videos', Zine.coral),
  'document': _CatStyle('Documents', Zine.lime),
  'audio': _CatStyle('Music', Zine.lilac),
  'other': _CatStyle('Other', Zine.mint),
};

String _fmt(num b) {
  if (b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var v = b.toDouble();
  var i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return '${v.toStringAsFixed(v >= 10 || i == 0 ? 0 : 1)} ${u[i]}';
}

/// AvaStorage — the universal per-account storage pool (Phase 4). One quota
/// shared by every AvaVerse app: a flat used-vs-quota meter, stacked
/// per-category bar + ledger (bytes AND counts), a last-6-months trend, and
/// LIVE updates — the server pushes a fresh summary over the single InboxDO
/// socket after any upload/delete in any app, and the graphs animate.
/// Over quota: 20 AvaCoins/GB/month from the AvaWallet; empty wallet =
/// read-only (files are NEVER deleted).
class AvaStorageScreen extends StatefulWidget {
  const AvaStorageScreen({super.key});
  @override
  State<AvaStorageScreen> createState() => _AvaStorageScreenState();
}

class _AvaStorageScreenState extends State<AvaStorageScreen> {
  Map<String, dynamic>? _data;
  List<Map<String, dynamic>> _trend = const [];
  bool _loading = true;
  StreamSubscription<Map<String, dynamic>>? _live;

  @override
  void initState() {
    super.initState();
    Analytics.capture('storage_viewed');
    _load();
    // Live: any upload from any app pushes {type:'storage', ...summary} over the
    // ONE multiplexed InboxDO socket (no polling); implicit animations repaint.
    _live = SyncHub.I.storage.listen((m) {
      if (mounted) setState(() => _data = {...?_data, ...m});
    });
  }

  @override
  void dispose() {
    _live?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await ApiAuth.getSigned(kStorageSummaryUrl);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _data = j;
          _trend = ((j['trend'] as List?) ?? const [])
              .map((e) => (e as Map).cast<String, dynamic>())
              .toList();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final total = (d?['used_bytes'] as num?)?.toDouble() ?? 0;
    final quota = (d?['quota_bytes'] as num?)?.toDouble() ?? (5 * 1024 * 1024 * 1024);
    final frac = quota <= 0 ? 0.0 : (total / quota).clamp(0.0, 1.0);
    final state = (d?['state'] ?? 'ok').toString();
    final coinsPerGb = (d?['coins_per_gb_month'] as num?)?.toInt() ?? 20;
    final byCat = ((d?['by_category'] as Map?) ?? const {}).cast<String, dynamic>();
    final gbOver = total > quota ? ((total - quota) / (1024 * 1024 * 1024)).ceil() : 0;

    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'AvaStorage',
        markWord: 'Storage',
        tag: 'One pool, every app',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : RefreshIndicator(
              color: Zine.blueInk,
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(18, 18, 18, 30), children: [
                _metricCards(total, quota, frac),
                const SizedBox(height: 16),
                _meterBar(frac, state),
                const SizedBox(height: 10),
                Text('${(frac * 100).toStringAsFixed(frac >= 0.1 ? 0 : 1)}% OF YOUR PLAN USED',
                    style: ZineText.kicker()),
                if (state == 'read_only') _readOnlyCard()
                else if (state == 'over_quota_paying') _warnCard(
                  sticker: 'Over quota',
                  text: 'Over the free quota — ${gbOver * coinsPerGb} AvaCoins/month ($coinsPerGb coins/GB × $gbOver GB) are charged from your wallet.',
                )
                else if (frac >= 0.8) _warnCard(
                  sticker: 'Heads up',
                  text: 'You\'ve used ${(frac * 100).toStringAsFixed(0)}% of your free ${_fmt(quota)}. Past it, storage costs $coinsPerGb AvaCoins/GB per month.',
                ),
                const SizedBox(height: 24),
                Text('BY TYPE', style: ZineText.kicker()),
                const SizedBox(height: 10),
                _stackedBar(total, quota, byCat),
                const SizedBox(height: 14),
                for (final e in _catStyles.entries) _ledgerRow(e.key, e.value, byCat, total),
                if (_trend.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  Text('LAST 6 MONTHS', style: ZineText.kicker()),
                  const SizedBox(height: 12),
                  _trendBars(quota),
                ],
              ]),
            ),
    );
  }

  // -- usage stats: two metric cards (§7.11) ----------------------------------
  Widget _metricCards(double total, double quota, double frac) {
    final left = (quota - total).clamp(0, quota).toDouble();
    return Row(children: [
      Expanded(
        child: ZineCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: PhosphorIcons.database(PhosphorIconsStyle.bold), color: Zine.blue),
            const SizedBox(height: 12),
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(_fmt(total), style: ZineText.stat(size: 30)),
            ),
            const SizedBox(height: 6),
            Text('USED OF ${_fmt(quota).toUpperCase()}', style: ZineText.kicker(size: 10.5)),
          ]),
        ),
      ),
      const SizedBox(width: 14),
      Expanded(
        child: ZineCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: PhosphorIcons.cloudCheck(PhosphorIconsStyle.bold), color: Zine.mint),
            const SizedBox(height: 12),
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(_fmt(left), style: ZineText.stat(size: 30, color: Zine.mintInk)),
            ),
            const SizedBox(height: 6),
            Text('STILL FREE', style: ZineText.kicker(size: 10.5)),
          ]),
        ),
      ),
    ]);
  }

  // -- flat fill bar inside an ink-bordered track (no gradients, no donut) -----
  Widget _meterBar(double frac, String state) {
    final fill = state == 'read_only' ? Zine.coral : Zine.mint;
    return Container(
      height: 24,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Zine.paper2,
        borderRadius: BorderRadius.circular(100),
        border: Zine.border,
        boxShadow: Zine.shadowXs,
      ),
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: frac),
        duration: const Duration(milliseconds: 600),
        curve: Curves.easeOutCubic,
        builder: (_, v, __) => Align(
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: v.clamp(0.0, 1.0),
            heightFactor: 1,
            child: Container(
              decoration: BoxDecoration(
                color: fill,
                border: v > 0.02
                    ? const Border(right: BorderSide(color: Zine.ink, width: 2))
                    : null,
              ),
            ),
          ),
        ),
      ),
    );
  }

  // -- read-only: coral card + the one lime CTA (top up wallet) ----------------
  Widget _readOnlyCard() => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: ZineCard(
          color: Zine.coral,
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              PhosphorIcon(PhosphorIcons.lock(PhosphorIconsStyle.bold), size: 18, color: Colors.white),
              const SizedBox(width: 8),
              Text('READ-ONLY', style: ZineText.tag(size: 12, color: Colors.white)),
            ]),
            const SizedBox(height: 8),
            Text(
              'Over your free quota with an empty AvaWallet. Your files are safe and read-only — top up AvaCoins to add more.',
              style: ZineText.sub(size: 14, color: Colors.white),
            ),
            const SizedBox(height: 14),
            ZineButton(
              label: 'Top up wallet',
              fullWidth: true,
              fontSize: 17,
              icon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
              onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const WalletScreen())),
            ),
          ]),
        ),
      );

  // -- soft warnings: coral sticker + short line --------------------------------
  Widget _warnCard({required String sticker, required String text}) => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: ZineCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineSticker(sticker, kind: ZineStickerKind.no),
            const SizedBox(height: 10),
            Text(text, style: ZineText.sub(size: 14)),
          ]),
        ),
      );

  Widget _stackedBar(double total, double quota, Map<String, dynamic> byCat) {
    final segments = <Widget>[];
    for (final e in _catStyles.entries) {
      final v = ((byCat[e.key] as Map?)?['bytes'] as num?)?.toDouble() ?? 0;
      if (v <= 0 || quota <= 0) continue;
      segments.add(Expanded(flex: (v / quota * 10000).round().clamp(1, 10000), child: Container(color: e.value.color)));
    }
    final remaining = (quota - total).clamp(0, quota);
    if (remaining > 0) segments.add(Expanded(flex: (remaining / quota * 10000).round().clamp(1, 10000), child: Container(color: Zine.paper2)));
    return Container(
      height: 20,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(100),
        border: Zine.border,
      ),
      child: Row(children: segments.isEmpty ? [Expanded(child: Container(color: Zine.paper2))] : segments),
    );
  }

  // -- per-type ledger rows (§7.10): label + dotted leader + Nunito 900 value --
  Widget _ledgerRow(String key, _CatStyle style, Map<String, dynamic> byCat, double total) {
    final cat = (byCat[key] as Map?)?.cast<String, dynamic>();
    final bytes = (cat?['bytes'] as num?)?.toDouble() ?? 0;
    final count = (cat?['count'] as num?)?.toInt() ?? 0;
    final pct = total <= 0 ? 0.0 : (bytes / total).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(children: [
        Container(
          width: 13, height: 13,
          decoration: BoxDecoration(
            color: style.color,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: Zine.ink, width: 2),
          ),
        ),
        const SizedBox(width: 10),
        Text('${style.label} · $count', style: ZineText.sub(size: 14.5)),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: CustomPaint(size: const Size(double.infinity, 2), painter: _DotLeaderPainter()),
          ),
        ),
        Text('${_fmt(bytes)} · ${(pct * 100).toStringAsFixed(0)}%',
            style: ZineText.value(size: 14, weight: FontWeight.w900)),
      ]),
    );
  }

  // -- last-6-months mini-bars (storage_snapshots via the summary API) ---------
  Widget _trendBars(double quota) {
    final maxV = _trend.fold<double>(
      1, (m, e) => math.max(m, ((e['used_bytes'] as num?) ?? 0).toDouble()));
    return SizedBox(
      height: 96,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final s in _trend)
            Expanded(
              child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                Text(_fmt((s['used_bytes'] as num?) ?? 0),
                    style: ZineText.tag(size: 8.5, color: Zine.inkSoft)),
                const SizedBox(height: 4),
                AnimatedContainer(
                  duration: const Duration(milliseconds: 400),
                  height: (54 * (((s['used_bytes'] as num?) ?? 0) / maxV)).clamp(4, 54).toDouble(),
                  margin: const EdgeInsets.symmetric(horizontal: 6),
                  decoration: BoxDecoration(
                    color: Zine.mint,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                ),
                const SizedBox(height: 4),
                Text(_monthLabel((s['month'] ?? '').toString()).toUpperCase(),
                    style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
              ]),
            ),
        ],
      ),
    );
  }

  static const _months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  String _monthLabel(String yyyyMm) {
    final m = int.tryParse(yyyyMm.length >= 7 ? yyyyMm.substring(5, 7) : '') ?? 0;
    return m >= 1 && m <= 12 ? _months[m] : yyyyMm;
  }
}

/// The dotted "·" leader line between a ledger label and its value (§7.10).
class _DotLeaderPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Zine.inkMute;
    for (double x = 0; x < size.width; x += 7) {
      canvas.drawCircle(Offset(x, size.height / 2), 1.1, p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}
