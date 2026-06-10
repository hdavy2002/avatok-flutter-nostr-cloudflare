import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
import '../../sync/sync_hub.dart';
import '../wallet/wallet_screen.dart';

class _CatStyle {
  final String label;
  final Color color;
  const _CatStyle(this.label, this.color);
}

const _catStyles = <String, _CatStyle>{
  'image': _CatStyle('Images', Color(0xFF22C9C0)),
  'video': _CatStyle('Videos', Color(0xFFFF3B30)),
  'document': _CatStyle('Documents', Color(0xFFEAB308)),
  'audio': _CatStyle('Music', Color(0xFF7C5CFC)),
  'other': _CatStyle('Other', Color(0xFF737A86)),
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
/// shared by every AvaVerse app: a radial used-vs-quota gauge, stacked
/// per-category bar + legend (bytes AND counts), a last-6-months trend, and
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
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('AvaStorage', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.all(20), children: [
                _donut(total, quota, frac, state),
                const SizedBox(height: 18),
                _stackedBar(total, quota, byCat),
                const SizedBox(height: 8),
                Text('${(frac * 100).toStringAsFixed(frac >= 0.1 ? 0 : 1)}% of your plan used',
                    style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                if (state == 'read_only') _banner(
                  icon: Icons.lock_outline, color: AvaColors.danger,
                  text: 'Over your free quota with an empty AvaWallet. Your files are safe and read-only — top up AvaCoins to add more.',
                  cta: 'Top up wallet',
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const WalletScreen())),
                )
                else if (state == 'over_quota_paying') _banner(
                  icon: Icons.payments_outlined, color: const Color(0xFFEAB308),
                  text: 'Over the free quota — ${gbOver * coinsPerGb} AvaCoins/month ($coinsPerGb coins/GB × $gbOver GB) are charged from your wallet.',
                )
                else if (frac >= 0.8) _banner(
                  icon: Icons.warning_amber_rounded, color: const Color(0xFFEAB308),
                  text: 'You\'ve used ${(frac * 100).toStringAsFixed(0)}% of your free ${_fmt(quota)}. Past it, storage costs $coinsPerGb AvaCoins/GB per month.',
                ),
                const SizedBox(height: 22),
                const Text('BY TYPE', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
                const SizedBox(height: 10),
                for (final e in _catStyles.entries) _legendRow(e.key, e.value, byCat, total),
                if (_trend.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  const Text('LAST 6 MONTHS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 10),
                  _trendBars(quota),
                ],
                const SizedBox(height: 30),
              ]),
            ),
    );
  }

  // -- radial gauge (CustomPainter per perf budget §1; animated via tween) -----
  Widget _donut(double total, double quota, double frac, String state) {
    final color = state == 'read_only'
        ? AvaColors.danger
        : frac >= 0.8 ? const Color(0xFFEAB308) : AvaColors.brand;
    return Center(
      child: RepaintBoundary(
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: frac),
          duration: const Duration(milliseconds: 600),
          curve: Curves.easeOutCubic,
          builder: (_, v, __) => SizedBox(
            width: 190, height: 190,
            child: CustomPaint(
              painter: _DonutPainter(v, color, AvaColors.line),
              child: Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(_fmt(total), style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900, color: AvaColors.ink)),
                  Text('of ${_fmt(quota)}', style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                  Text('${_fmt((quota - total).clamp(0, quota))} free', style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _stackedBar(double total, double quota, Map<String, dynamic> byCat) {
    final segments = <Widget>[];
    for (final e in _catStyles.entries) {
      final v = ((byCat[e.key] as Map?)?['bytes'] as num?)?.toDouble() ?? 0;
      if (v <= 0 || quota <= 0) continue;
      segments.add(Expanded(flex: (v / quota * 10000).round().clamp(1, 10000), child: Container(color: e.value.color)));
    }
    final remaining = (quota - total).clamp(0, quota);
    if (remaining > 0) segments.add(Expanded(flex: (remaining / quota * 10000).round().clamp(1, 10000), child: Container(color: AvaColors.line)));
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: SizedBox(height: 18, child: Row(children: segments.isEmpty ? [Expanded(child: Container(color: AvaColors.line))] : segments)),
    );
  }

  Widget _legendRow(String key, _CatStyle style, Map<String, dynamic> byCat, double total) {
    final cat = (byCat[key] as Map?)?.cast<String, dynamic>();
    final bytes = (cat?['bytes'] as num?)?.toDouble() ?? 0;
    final count = (cat?['count'] as num?)?.toInt() ?? 0;
    final pct = total <= 0 ? 0.0 : (bytes / total).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(children: [
        Container(width: 12, height: 12, decoration: BoxDecoration(color: style.color, borderRadius: BorderRadius.circular(3))),
        const SizedBox(width: 10),
        Expanded(child: Text('${style.label} · $count', style: const TextStyle(fontWeight: FontWeight.w600, color: AvaColors.ink))),
        Text('${_fmt(bytes)}  ·  ${(pct * 100).toStringAsFixed(0)}%', style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
      ]),
    );
  }

  // -- last-6-months mini-bars (storage_snapshots via the summary API) ---------
  Widget _trendBars(double quota) {
    final maxV = _trend.fold<double>(
      1, (m, e) => math.max(m, ((e['used_bytes'] as num?) ?? 0).toDouble()));
    return SizedBox(
      height: 92,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final s in _trend)
            Expanded(
              child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                Text(_fmt((s['used_bytes'] as num?) ?? 0), style: const TextStyle(color: AvaColors.sub, fontSize: 9)),
                const SizedBox(height: 4),
                AnimatedContainer(
                  duration: const Duration(milliseconds: 400),
                  height: (54 * (((s['used_bytes'] as num?) ?? 0) / maxV)).clamp(2, 54).toDouble(),
                  margin: const EdgeInsets.symmetric(horizontal: 6),
                  decoration: BoxDecoration(color: AvaColors.brand.withOpacity(0.85), borderRadius: BorderRadius.circular(4)),
                ),
                const SizedBox(height: 4),
                Text(_monthLabel((s['month'] ?? '').toString()),
                    style: const TextStyle(color: AvaColors.sub, fontSize: 10)),
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

  Widget _banner({required IconData icon, required Color color, required String text, String? cta, VoidCallback? onTap}) =>
      Container(
        margin: const EdgeInsets.only(top: 16),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: color.withOpacity(0.08), borderRadius: BorderRadius.circular(14)),
        child: Row(children: [
          Icon(icon, color: color),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: const TextStyle(color: AvaColors.ink, fontSize: 12))),
          if (cta != null)
            TextButton(onPressed: onTap, child: Text(cta, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 12))),
        ]),
      );
}

class _DonutPainter extends CustomPainter {
  final double frac;
  final Color color;
  final Color track;
  _DonutPainter(this.frac, this.color, this.track);

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2 - 8;
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 14
      ..strokeCap = StrokeCap.round;
    canvas.drawCircle(c, r, stroke..color = track);
    if (frac > 0) {
      canvas.drawArc(Rect.fromCircle(center: c, radius: r), -math.pi / 2,
          2 * math.pi * frac.clamp(0.0, 1.0), false, stroke..color = color);
    }
  }

  @override
  bool shouldRepaint(_DonutPainter old) => old.frac != frac || old.color != color;
}
