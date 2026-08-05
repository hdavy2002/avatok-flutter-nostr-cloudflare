import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(
        title: 'Creator insights',
        markWord: 'insights',
        tag: 'last 30 days',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
          : s == null
              ? Center(child: ZineEmptyState(
                  icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
                  text: 'Could not load insights — pull to retry.'))
              : RefreshIndicator(onRefresh: _load, color: AD.primaryBadge, child: _body(s)),
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
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
      children: [
        // Metric cards (§7.11) — accent rotation blue/lime/coral/lilac/mint.
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _stat('Views (30d)', '${_i(views['last30d'])}',
              PhosphorIcons.eye(PhosphorIconsStyle.bold), AD.newGroup),
          const SizedBox(width: Msg.s4),
          _stat('Unique viewers', '${_i(views['unique_viewers'])}',
              PhosphorIcons.usersThree(PhosphorIconsStyle.bold), AD.primaryBadge),
        ]),
        const SizedBox(height: Msg.s4),
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _stat('Bookings (30d)', '${_i(bookings['last30d'])}',
              PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), AD.danger),
          const SizedBox(width: Msg.s4),
          _stat('Conversion', conv == null ? '—' : '$conv%',
              PhosphorIcons.trendUp(PhosphorIconsStyle.bold), AD.micIdleBg),
        ]),
        const SizedBox(height: Msg.s4),
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _stat('Revenue (30d)', '\u20b9${_i(bookings['gross_coins_30d'])}',
              PhosphorIcons.coins(PhosphorIconsStyle.bold), AD.online, money: true),
          const SizedBox(width: Msg.s4),
          _stat('Followers', '${_i(s['follower_count'])}',
              PhosphorIcons.heart(PhosphorIconsStyle.bold), AD.newGroup),
        ]),

        if (byDay.isNotEmpty) ...[
          _h('Views — last 30 days'),
          ZineCard(
            color: AD.card,
            radius: Msg.rLg,
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s3),
            boxShadow: const <BoxShadow>[],
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
          const SizedBox(height: Msg.s2),
          Text('Only viewers who shared a birth year are counted.',
              style: ADText.sectionLabel(c: AD.textTertiary)),
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
              padding: const EdgeInsets.symmetric(vertical: Msg.s2),
              child: Row(children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(l['title']?.toString() ?? l['subject_id'].toString(),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ADText.rowName().copyWith(fontWeight: FontWeight.w600)),
                  Text(l['kind'].toString(),
                      style: ADText.sectionLabel(c: AD.textTertiary)),
                ])),
                const SizedBox(width: Msg.s3),
                Text('${_i(l['views_30d'])}', style: ADText.rowName().copyWith(fontWeight: FontWeight.w700)),
              ]),
            ),
        ],

        const SizedBox(height: Msg.s4),
        // [UI-DS-SWEEP-1] emoji in user-facing copy replaced by a Phosphor glyph.
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: PhosphorIcon(PhosphorIcons.trendUp(PhosphorIconsStyle.regular),
                size: 14, color: AD.textTertiary),
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text(
              'Numbers update in near-real-time. Guests (not signed in) are counted in views but not in unique viewers.',
              style: ADText.preview(),
            ),
          ),
        ]),
      ],
    );
  }

  Widget _h(String t) => Padding(
        padding: const EdgeInsets.only(top: Msg.s5, bottom: Msg.s3),
        child: Text(t, style: ADText.threadName()),
      );

  /// Metric card (§7.11): icon badge + Nunito number + mono caption.
  Widget _stat(String label, String value, IconData icon, Color accent, {bool money = false}) => Expanded(
        child: ZineCard(
          radius: Msg.rLg,
          padding: const EdgeInsets.all(Msg.s4),
          boxShadow: const <BoxShadow>[],
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 30),
            const SizedBox(height: Msg.s3),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(value, style: ADText.appTitle(c: money ? AD.online : AD.textPrimary).copyWith(fontSize: 30)),
            ),
            const SizedBox(height: Msg.s1),
            Text(label, style: ADText.sectionLabel()),
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
                  color: AD.newGroup,
                  border: Border.all(color: AD.borderCard, width: 1.5),
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
        padding: const EdgeInsets.symmetric(vertical: Msg.s1),
        child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.preview()),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text(
              '·' * 80,
              maxLines: 1,
              overflow: TextOverflow.clip,
              style: ADText.preview(c: AD.textTertiary),
            ),
          ),
          const SizedBox(width: Msg.s2),
          Text(value, style: ADText.rowName().copyWith(fontWeight: FontWeight.w700)),
        ]),
      );
}
