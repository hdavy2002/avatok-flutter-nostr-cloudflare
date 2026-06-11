import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/theme.dart';

/// Creator Insights — audience analytics across ALL the creator's offerings
/// (AvaLive events, AvaConsult listings, AvaVoice agents). Backed by
/// GET /api/creators/me/stats: views by day / country / age group / source,
/// bookings, revenue and conversion (last 30 days unless noted).
class CreatorInsightsScreen extends StatefulWidget {
  const CreatorInsightsScreen({super.key});
  @override
  State<CreatorInsightsScreen> createState() => _CreatorInsightsScreenState();
}

class _CreatorInsightsScreenState extends State<CreatorInsightsScreen> {
  Map<String, dynamic>? _s;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaexplore', 'creator_insights');
    _load();
  }

  Future<void> _load() async {
    final s = await ListingsApi.creatorStats();
    if (mounted) setState(() { _s = s; _loading = false; });
  }

  int _i(dynamic v) => (v as num?)?.toInt() ?? 0;
  List<Map<String, dynamic>> _l(dynamic v) =>
      ((v as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();

  String _flag(String cc) {
    if (cc.length != 2 || cc == '??') return '🌐';
    return String.fromCharCodes(cc.toUpperCase().codeUnits.map((c) => c + 127397));
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0,
          foregroundColor: AvaColors.ink, title: const Text('Creator insights')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : s == null
              ? const Center(child: Text('Could not load insights — pull to retry.',
                  style: TextStyle(color: AvaColors.sub)))
              : RefreshIndicator(onRefresh: _load, child: _body(s)),
    );
  }

  Widget _body(Map<String, dynamic> s) {
    final views = (s['views'] as Map?)?.cast<String, dynamic>() ?? const {};
    final bookings = (s['bookings'] as Map?)?.cast<String, dynamic>() ?? const {};
    final byDay = _l(views['by_day']);
    final byCountry = _l(views['by_country']);
    final byAge = _l(views['by_age_group']);
    final bySource = _l(views['by_source']);
    final listings = _l(s['listings']);
    final conv = s['conversion_pct'];

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
      children: [
        Row(children: [
          _stat('Views (30d)', '${_i(views['last30d'])}', Icons.visibility_outlined),
          const SizedBox(width: 10),
          _stat('Unique viewers', '${_i(views['unique_viewers'])}', Icons.group_outlined),
        ]),
        const SizedBox(height: 10),
        Row(children: [
          _stat('Bookings (30d)', '${_i(bookings['last30d'])}', Icons.event_available_outlined),
          const SizedBox(width: 10),
          _stat('Conversion', conv == null ? '—' : '$conv%', Icons.trending_up),
        ]),
        const SizedBox(height: 10),
        Row(children: [
          _stat('Revenue (30d)', '\$${(_i(bookings['gross_coins_30d']) / 100).toStringAsFixed(2)}',
              Icons.payments_outlined),
          const SizedBox(width: 10),
          _stat('Followers', '${_i(s['follower_count'])}', Icons.favorite_outline),
        ]),

        if (byDay.isNotEmpty) ...[
          _h('Views — last 30 days'),
          SizedBox(height: 120, child: _bars(byDay)),
        ],

        if (byCountry.isNotEmpty) ...[
          _h('Where your audience is'),
          for (final c in byCountry)
            _rankRow('${_flag(c['country'].toString())}  ${c['country']}', _i(c['views']),
                _i(byCountry.first['views'])),
        ],

        if (byAge.isNotEmpty) ...[
          _h('Age groups'),
          for (final a in byAge)
            _rankRow(a['age_group'].toString(), _i(a['views']), _i(views['last30d'])),
          const SizedBox(height: 4),
          const Text('Only viewers who shared a birth year are counted.',
              style: TextStyle(fontSize: 11, color: AvaColors.sub)),
        ],

        if (bySource.isNotEmpty) ...[
          _h('How people find you'),
          for (final src in bySource)
            _rankRow(src['source'].toString(), _i(src['views']), _i(bySource.first['views'])),
        ],

        if (listings.isNotEmpty) ...[
          _h('Your offerings — views (30d)'),
          for (final l in listings)
            ListTile(
              contentPadding: EdgeInsets.zero, dense: true,
              title: Text(l['title']?.toString() ?? l['subject_id'].toString(),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
              subtitle: Text(l['kind'].toString(), style: const TextStyle(fontSize: 11.5)),
              trailing: Text('${_i(l['views_30d'])}',
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            ),
        ],

        const SizedBox(height: 12),
        const Text(
          '📈 Numbers update in near-real-time. Guests (not signed in) are counted in views but not in unique viewers.',
          style: TextStyle(fontSize: 12, color: AvaColors.sub, height: 1.4),
        ),
      ],
    );
  }

  Widget _h(String t) => Padding(
        padding: const EdgeInsets.only(top: 22, bottom: 8),
        child: Text(t, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
      );

  Widget _stat(String label, String value, IconData icon) => Expanded(
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            border: Border.all(color: AvaColors.line),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, size: 18, color: AvaColors.brand),
            const SizedBox(height: 8),
            Text(value, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
            Text(label, style: const TextStyle(fontSize: 11.5, color: AvaColors.sub)),
          ]),
        ),
      );

  /// Simple bar chart — no chart package needed.
  Widget _bars(List<Map<String, dynamic>> byDay) {
    final max = byDay.fold<int>(1, (m, d) => _i(d['views']) > m ? _i(d['views']) : m);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (final d in byDay)
          Expanded(
            child: Tooltip(
              message: '${d['day']}: ${_i(d['views'])}',
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 1),
                height: 8 + 104 * (_i(d['views']) / max),
                decoration: BoxDecoration(
                  color: AvaColors.brand.withValues(alpha: .85),
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(3)),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _rankRow(String label, int value, int max) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [
          SizedBox(width: 110, child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600))),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: max > 0 ? value / max : 0, minHeight: 8,
                backgroundColor: AvaColors.soft,
                valueColor: const AlwaysStoppedAnimation(AvaColors.brand),
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(width: 36, child: Text('$value', textAlign: TextAlign.right,
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 12.5))),
        ]),
      );
}
