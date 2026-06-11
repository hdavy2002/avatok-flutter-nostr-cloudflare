import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

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
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'Creator insights',
        markWord: 'insights',
        tag: 'last 30 days',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : s == null
              ? Center(child: ZineEmptyState(
                  icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
                  text: 'Could not load insights — pull to retry.'))
              : RefreshIndicator(onRefresh: _load, color: Zine.blueInk, child: _body(s)),
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
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 32),
      children: [
        // Metric cards (§7.11) — accent rotation blue/lime/coral/lilac/mint.
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _stat('Views (30d)', '${_i(views['last30d'])}',
              PhosphorIcons.eye(PhosphorIconsStyle.bold), Zine.blue),
          const SizedBox(width: 14),
          _stat('Unique viewers', '${_i(views['unique_viewers'])}',
              PhosphorIcons.usersThree(PhosphorIconsStyle.bold), Zine.lime),
        ]),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _stat('Bookings (30d)', '${_i(bookings['last30d'])}',
              PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), Zine.coral),
          const SizedBox(width: 14),
          _stat('Conversion', conv == null ? '—' : '$conv%',
              PhosphorIcons.trendUp(PhosphorIconsStyle.bold), Zine.lilac),
        ]),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _stat('Revenue (30d)', '\$${(_i(bookings['gross_coins_30d']) / 100).toStringAsFixed(2)}',
              PhosphorIcons.coins(PhosphorIconsStyle.bold), Zine.mint, money: true),
          const SizedBox(width: 14),
          _stat('Followers', '${_i(s['follower_count'])}',
              PhosphorIcons.heart(PhosphorIconsStyle.bold), Zine.blue),
        ]),

        if (byDay.isNotEmpty) ...[
          _h('Views — last 30 days'),
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
            boxShadow: Zine.shadowXs,
            child: SizedBox(height: 120, child: _bars(byDay)),
          ),
        ],

        if (byCountry.isNotEmpty) ...[
          _h('Where your audience is'),
          for (final c in byCountry)
            _ledgerRow('${_flag(c['country'].toString())}  ${c['country']}', '${_i(c['views'])}'),
        ],

        if (byAge.isNotEmpty) ...[
          _h('Age groups'),
          for (final a in byAge)
            _ledgerRow(a['age_group'].toString(), '${_i(a['views'])}'),
          const SizedBox(height: 6),
          Text('ONLY VIEWERS WHO SHARED A BIRTH YEAR ARE COUNTED.',
              style: ZineText.kicker(size: 9.5, color: Zine.inkMute)),
        ],

        if (bySource.isNotEmpty) ...[
          _h('How people find you'),
          for (final src in bySource)
            _ledgerRow(src['source'].toString(), '${_i(src['views'])}'),
        ],

        if (listings.isNotEmpty) ...[
          _h('Your offerings — views (30d)'),
          for (final l in listings)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(l['title']?.toString() ?? l['subject_id'].toString(),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 13.5, weight: FontWeight.w800)),
                  Text(l['kind'].toString().toUpperCase(),
                      style: ZineText.kicker(size: 9.5, color: Zine.inkMute)),
                ])),
                const SizedBox(width: 10),
                Text('${_i(l['views_30d'])}', style: ZineText.value(size: 15, weight: FontWeight.w900)),
              ]),
            ),
        ],

        const SizedBox(height: 14),
        Text(
          '📈 Numbers update in near-real-time. Guests (not signed in) are counted in views but not in unique viewers.',
          style: ZineText.sub(size: 12),
        ),
      ],
    );
  }

  Widget _h(String t) => Padding(
        padding: const EdgeInsets.only(top: 24, bottom: 10),
        child: Text(t, style: ZineText.cardTitle(size: 17)),
      );

  /// Metric card (§7.11): icon badge + Fredoka number + mono caption.
  Widget _stat(String label, String value, IconData icon, Color accent, {bool money = false}) => Expanded(
        child: ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(14),
          boxShadow: Zine.shadowXs,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 30),
            const SizedBox(height: 10),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(value, style: ZineText.stat(size: 30, color: money ? Zine.mintInk : Zine.ink)),
            ),
            const SizedBox(height: 3),
            Text(label.toUpperCase(), style: ZineText.kicker(size: 9.5)),
          ]),
        ),
      );

  /// Simple bar chart — no chart package needed. Flat poster-blue bars.
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
                height: 8 + 96 * (_i(d['views']) / max),
                decoration: BoxDecoration(
                  color: Zine.blue,
                  border: Border.all(color: Zine.ink, width: 1.5),
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(3)),
                ),
              ),
            ),
          ),
      ],
    );
  }

  /// Ledger row (§7.10): label + dotted leader + Nunito 900 value.
  Widget _ledgerRow(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.sub(size: 13.5)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              '·' * 80,
              maxLines: 1,
              overflow: TextOverflow.clip,
              style: ZineText.sub(size: 13, color: Zine.inkMute),
            ),
          ),
          const SizedBox(width: 6),
          Text(value, style: ZineText.value(size: 14, weight: FontWeight.w900)),
        ]),
      );
}
