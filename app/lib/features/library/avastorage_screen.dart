import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/api_auth.dart';
import '../../core/apps.dart';
import '../../core/config.dart';
import '../../core/theme.dart';

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

/// AvaStorage — the universal per-account storage pool. One quota shared by every
/// AvaVerse app: coloured per-category bars, total used, space left, and a top-up
/// prompt when over quota with an empty wallet (read-only, never deleted).
class AvaStorageScreen extends StatefulWidget {
  const AvaStorageScreen({super.key});
  @override
  State<AvaStorageScreen> createState() => _AvaStorageScreenState();
}

class _AvaStorageScreenState extends State<AvaStorageScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await ApiAuth.getSigned(kStorageUrl);
      if (mounted) setState(() { _data = jsonDecode(r.body) as Map<String, dynamic>; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final total = (d?['total_used'] as num?)?.toDouble() ?? 0;
    final quota = (d?['quota'] as num?)?.toDouble() ?? (5 * 1024 * 1024 * 1024);
    final used = quota <= 0 ? 0.0 : (total / quota).clamp(0.0, 1.0);
    final readOnly = (d?['state']?.toString() == 'read_only');
    final byCat = ((d?['by_category'] as Map?) ?? const {}).cast<String, dynamic>();
    final byApp = ((d?['by_app'] as Map?) ?? const {}).cast<String, dynamic>();

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
                Center(child: Text(_fmt(total), style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w900, color: AvaColors.ink))),
                Center(child: Text('of ${_fmt(quota)} used · ${_fmt((quota - total).clamp(0, quota))} free',
                    style: const TextStyle(color: AvaColors.sub, fontSize: 13))),
                const SizedBox(height: 18),
                _stackedBar(total, quota, byCat),
                const SizedBox(height: 8),
                Text('${(used * 100).toStringAsFixed(used >= 0.1 ? 0 : 1)}% of your plan',
                    style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                if (readOnly) _readOnlyBanner(),
                const SizedBox(height: 22),
                const Text('BY TYPE', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
                const SizedBox(height: 10),
                for (final e in _catStyles.entries)
                  _legendRow(e.value.label, e.value.color, (byCat[e.key] as num?)?.toDouble() ?? 0, total),
                const SizedBox(height: 22),
                const Text('BY APP', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
                const SizedBox(height: 10),
                ...(byApp.entries.toList()..sort((a, b) => ((b.value as num)).compareTo(a.value as num)))
                    .map((e) => _appRow(e.key, (e.value as num).toDouble())),
                const SizedBox(height: 30),
              ]),
            ),
    );
  }

  Widget _stackedBar(double total, double quota, Map<String, dynamic> byCat) {
    final segments = <Widget>[];
    for (final e in _catStyles.entries) {
      final v = (byCat[e.key] as num?)?.toDouble() ?? 0;
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

  Widget _legendRow(String label, Color color, double bytes, double total) {
    final pct = total <= 0 ? 0.0 : (bytes / total).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(children: [
        Container(width: 12, height: 12, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3))),
        const SizedBox(width: 10),
        Expanded(child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600, color: AvaColors.ink))),
        Text('${_fmt(bytes)}  ·  ${(pct * 100).toStringAsFixed(0)}%', style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
      ]),
    );
  }

  Widget _appRow(String app, double bytes) {
    final def = appByKey(app);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(children: [
        Icon(def.icon, size: 18, color: def.color),
        const SizedBox(width: 10),
        Expanded(child: Text(def.name, style: const TextStyle(fontWeight: FontWeight.w600, color: AvaColors.ink))),
        Text(_fmt(bytes), style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
      ]),
    );
  }

  Widget _readOnlyBanner() => Container(
        margin: const EdgeInsets.only(top: 16),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: AvaColors.danger.withOpacity(0.08), borderRadius: BorderRadius.circular(14)),
        child: Row(children: [
          const Icon(Icons.lock_outline, color: AvaColors.danger),
          const SizedBox(width: 10),
          const Expanded(child: Text('Over your free quota and your AvaWallet is empty. Your files are safe and read-only — top up AvaCoins to add more.',
              style: TextStyle(color: AvaColors.ink, fontSize: 12))),
        ]),
      );
}
