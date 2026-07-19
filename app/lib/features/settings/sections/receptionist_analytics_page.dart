// [RECEPT-STATS-1] Receptionist / Voicemail — Analytics (plan §C3,
// Specs/PLAN-2026-07-19-onboarding-bonus-analytics.md).
//
// Per-owner dashboard of incoming Ava/voicemail traffic, read from the server's
// D1 mirror via GET /api/receptionist/analytics (never PostHog). Reuses the
// cockpit-wallet widget family (AdCard instrument cards + plain-Container bars —
// no chart packages). Entry: "View call analytics" on the merged Receptionist /
// Voice mail settings card (receptionist_section.dart).

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';

/// Inline dark v2 header band (same pattern as wallet_screen.dart's _darkHeader).
PreferredSizeWidget _darkHeader({required String title, String? tag}) {
  return PreferredSize(
    preferredSize: Size.fromHeight(tag == null ? 76 : 92),
    child: Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: Row(children: [
            const AdBackButton(),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: ADText.appTitle(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                  if (tag != null) ...[
                    const SizedBox(height: 2),
                    Text(tag.toUpperCase(), style: ADText.sectionLabel()),
                  ],
                ],
              ),
            ),
          ]),
        ),
      ),
    ),
  );
}

class ReceptionistAnalyticsPage extends StatefulWidget {
  const ReceptionistAnalyticsPage({super.key});

  @override
  State<ReceptionistAnalyticsPage> createState() =>
      _ReceptionistAnalyticsPageState();
}

class _ReceptionistAnalyticsPageState extends State<ReceptionistAnalyticsPage> {
  int _days = 30;
  bool _loading = true;
  Map<String, dynamic>? _data;

  @override
  void initState() {
    super.initState();
    Analytics.capture('recept_analytics_opened', {'days': _days});
    _load();
  }

  Future<void> _load() async {
    final d = await ReceptionistApi.analytics(days: _days);
    if (!mounted) return;
    setState(() {
      _data = d;
      _loading = false;
    });
  }

  Future<void> _setDays(int d) async {
    if (_days == d) return;
    Analytics.capture('recept_analytics_days_changed', {'days': d});
    setState(() {
      _days = d;
      _loading = true;
    });
    await _load();
  }

  // ── data accessors (defensive against a null/partial payload) ──────────────
  Map<String, dynamic> get _totals =>
      ((_data?['totals'] as Map?) ?? const {}).cast<String, dynamic>();
  List<Map<String, dynamic>> _list(String key) =>
      (((_data?[key] as List?) ?? const [])
          .map((e) => (e as Map).cast<String, dynamic>())).toList();
  List<int> get _byHour =>
      (((_data?['by_hour'] as List?) ?? const [])
          .map((e) => (e as num?)?.toInt() ?? 0)).toList();

  int _n(dynamic v) => ((v as num?) ?? 0).toInt();
  double _d(dynamic v) => ((v as num?) ?? 0).toDouble();

  String _mins(double m) =>
      m == m.roundToDouble() ? '${m.round()}m' : '${m.toStringAsFixed(1)}m';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _darkHeader(title: 'Call Analytics', tag: 'receptionist · voicemail'),
      body: RefreshIndicator(
        onRefresh: () {
          Analytics.capture('recept_analytics_pull_refresh', {'days': _days});
          return _load();
        },
        color: AD.iconSearch,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 28),
          children: [
            _daysChips(),
            const SizedBox(height: 14),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(
                    child: SizedBox(
                        width: 24,
                        height: 24,
                        child: CircularProgressIndicator(strokeWidth: 2))),
              )
            else if (_data == null)
              _messageCard('Couldn’t load analytics — pull down to retry.')
            else if (_n(_totals['calls']) == 0)
              _messageCard(
                  'No calls yet in the last $_days days. When Ava answers a '
                  'call or takes a voicemail, it shows up here.')
            else ...[
              _totalsRow(),
              const SizedBox(height: 10),
              _modeSplitCard(),
              const SizedBox(height: 14),
              _hoursCard(),
              const SizedBox(height: 14),
              _trendCard(),
              const SizedBox(height: 14),
              _topCallersCard(),
              const SizedBox(height: 14),
              _countriesCard(),
            ],
          ],
        ),
      ),
    );
  }

  Widget _daysChips() => Wrap(spacing: 8, runSpacing: 8, children: [
        for (final d in const [7, 30, 90])
          AdChip(
            label: '$d days',
            active: _days == d,
            onTap: () => _setDays(d),
          ),
      ]);

  Widget _messageCard(String text) => AdCard(
        padding: const EdgeInsets.all(16),
        child: Text(text, style: ADText.rowName()),
      );

  // ── totals row (wallet _miniCard family) ────────────────────────────────────
  Widget _totalsRow() {
    final calls = _n(_totals['calls']);
    final minutes = _d(_totals['minutes']);
    final tokens = _d(_totals['tokens']);
    return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Expanded(
          child: _miniCard('Calls', '$calls',
              PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), AD.iconSearch)),
      const SizedBox(width: 10),
      Expanded(
          child: _miniCard('Minutes', _mins(minutes),
              PhosphorIcons.timer(PhosphorIconsStyle.bold), AD.online)),
      const SizedBox(width: 10),
      Expanded(
          child: _miniCard(
              'Tokens',
              tokens == tokens.roundToDouble()
                  ? '${tokens.round()}'
                  : tokens.toStringAsFixed(1),
              PhosphorIcons.coins(PhosphorIconsStyle.bold),
              AD.danger)),
    ]);
  }

  Widget _miniCard(String label, String value, IconData icon, Color accent) =>
      AdCard(
        radius: AD.rStatCard,
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: accent, size: 30),
          const SizedBox(height: 10),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value, style: ADText.appTitle(c: accent)),
          ),
          const SizedBox(height: 3),
          Text(label.toUpperCase(), style: ADText.statCaption()),
        ]),
      );

  // ── mode split: AI agent vs voicemail ───────────────────────────────────────
  Widget _modeSplitCard() {
    final agent = _n(_totals['agent_calls']);
    final vm = _n(_totals['voicemails']);
    final total = (agent + vm).clamp(1, 1 << 31);
    return AdCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.scales(PhosphorIconsStyle.bold),
              color: AD.iconSearch,
              size: 26),
          const SizedBox(width: 8),
          Text('HOW AVA ANSWERED', style: ADText.sectionLabel()),
        ]),
        const SizedBox(height: 10),
        _splitRow('AI Voice Agent', agent, agent / total, AD.online),
        const SizedBox(height: 8),
        _splitRow('Voice mail', vm, vm / total, AD.iconSearch),
      ]),
    );
  }

  Widget _splitRow(String label, int count, double f, Color c) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(label, style: ADText.rowName())),
          Text('×$count', style: ADText.rowName(c: c)),
        ]),
        const SizedBox(height: 5),
        _bar(f, c),
      ]);

  /// Thin horizontal gauge bar (wallet _bar family — plain Containers).
  Widget _bar(double f, Color c) => ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: Container(
          height: 5,
          color: AD.bg,
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: f.clamp(0.02, 1.0).toDouble(),
            child: Container(color: c),
          ),
        ),
      );

  // ── busiest hours (24 vertical mini-bars, owner-local time) ─────────────────
  Widget _hoursCard() {
    final hours = _byHour;
    if (hours.length < 24) return const SizedBox.shrink();
    final maxH = hours.fold<int>(1, (m, v) => v > m ? v : m);
    return AdCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.clock(PhosphorIconsStyle.bold),
              color: AD.danger,
              size: 26),
          const SizedBox(width: 8),
          Text('BUSIEST HOURS · YOUR TIME', style: ADText.sectionLabel()),
        ]),
        const SizedBox(height: 12),
        SizedBox(
          height: 64,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var h = 0; h < 24; h++) ...[
                Expanded(
                  child: ClipRRect(
                    borderRadius:
                        const BorderRadius.vertical(top: Radius.circular(2)),
                    child: FractionallySizedBox(
                      heightFactor: hours[h] == 0
                          ? 0.04
                          : (hours[h] / maxH).clamp(0.08, 1.0).toDouble(),
                      child: Container(
                          color: hours[h] == 0 ? AD.borderControl : AD.online),
                    ),
                  ),
                ),
                if (h < 23) const SizedBox(width: 2),
              ],
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (final t in const ['12am', '6am', '12pm', '6pm', '11pm'])
              Text(t, style: ADText.statCaption()),
          ],
        ),
      ]),
    );
  }

  // ── daily trend mini-bars ───────────────────────────────────────────────────
  Widget _trendCard() {
    final days = _list('by_day');
    if (days.isEmpty) return const SizedBox.shrink();
    final maxC = days.fold<int>(1, (m, e) => _n(e['count']) > m ? _n(e['count']) : m);
    final first = (days.first['date'] ?? '').toString();
    final last = (days.last['date'] ?? '').toString();
    return AdCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
              color: AD.iconSearch,
              size: 26),
          const SizedBox(width: 8),
          Text('CALLS PER DAY', style: ADText.sectionLabel()),
        ]),
        const SizedBox(height: 12),
        SizedBox(
          height: 48,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var i = 0; i < days.length; i++) ...[
                Expanded(
                  child: ClipRRect(
                    borderRadius:
                        const BorderRadius.vertical(top: Radius.circular(2)),
                    child: FractionallySizedBox(
                      heightFactor: _n(days[i]['count']) == 0
                          ? 0.05
                          : (_n(days[i]['count']) / maxC)
                              .clamp(0.1, 1.0)
                              .toDouble(),
                      child: Container(
                          color: _n(days[i]['count']) == 0
                              ? AD.borderControl
                              : AD.iconSearch),
                    ),
                  ),
                ),
                if (i < days.length - 1) const SizedBox(width: 1.5),
              ],
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(first, style: ADText.statCaption()),
          Text(last, style: ADText.statCaption()),
        ]),
      ]),
    );
  }

  // ── top callers ─────────────────────────────────────────────────────────────
  Widget _topCallersCard() {
    final callers = _list('top_callers');
    if (callers.isEmpty) return const SizedBox.shrink();
    final maxC = callers.fold<int>(1, (m, e) => _n(e['count']) > m ? _n(e['count']) : m);
    return AdCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
              color: AD.online,
              size: 26),
          const SizedBox(width: 8),
          Text('TOP CALLERS', style: ADText.sectionLabel()),
        ]),
        const SizedBox(height: 6),
        for (final c in callers)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text(
                    _callerLabel(c),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.rowName(),
                  ),
                ),
                const SizedBox(width: 8),
                Text('×${_n(c['count'])}', style: ADText.statCaption()),
                const SizedBox(width: 8),
                Text(_mins(_d(c['minutes'])),
                    style: ADText.rowName(c: AD.online)),
              ]),
              const SizedBox(height: 5),
              _bar(_n(c['count']) / maxC, AD.online),
            ]),
          ),
      ]),
    );
  }

  String _callerLabel(Map<String, dynamic> c) {
    final name = (c['name'] ?? '').toString().trim();
    final caller = (c['caller'] ?? '').toString();
    // E.164 numbers are shown as-is (the owner may see their own callers'
    // numbers); bare uids get a friendlier fallback.
    final id = caller.startsWith('+') ? caller : (name.isEmpty ? 'AvaTOK caller' : '');
    if (name.isNotEmpty && id.isNotEmpty) return '$name · $id';
    if (name.isNotEmpty) return name;
    return id.isNotEmpty ? id : caller;
  }

  // ── countries ───────────────────────────────────────────────────────────────
  Widget _countriesCard() {
    final countries = _list('by_country');
    if (countries.isEmpty) return const SizedBox.shrink();
    final maxC =
        countries.fold<int>(1, (m, e) => _n(e['count']) > m ? _n(e['count']) : m);
    return AdCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.globeHemisphereEast(PhosphorIconsStyle.bold),
              color: AD.iconSearch,
              size: 26),
          const SizedBox(width: 8),
          Text('WHERE CALLS CAME FROM', style: ADText.sectionLabel()),
        ]),
        const SizedBox(height: 6),
        for (final c in countries.take(12))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text(_countryLabel((c['country'] ?? '').toString()),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.rowName()),
                ),
                Text('×${_n(c['count'])}', style: ADText.rowName(c: AD.iconSearch)),
              ]),
              const SizedBox(height: 5),
              _bar(_n(c['count']) / maxC, AD.iconSearch),
            ]),
          ),
      ]),
    );
  }

  String _countryLabel(String iso) {
    const names = <String, String>{
      'IN': 'India', 'US': 'United States', 'CA': 'Canada',
      'GB': 'United Kingdom', 'AE': 'UAE', 'SA': 'Saudi Arabia',
      'SG': 'Singapore', 'AU': 'Australia', 'NZ': 'New Zealand',
      'PK': 'Pakistan', 'BD': 'Bangladesh', 'LK': 'Sri Lanka', 'NP': 'Nepal',
      'QA': 'Qatar', 'KW': 'Kuwait', 'OM': 'Oman', 'BH': 'Bahrain',
      'MY': 'Malaysia', 'TH': 'Thailand', 'ID': 'Indonesia',
      'PH': 'Philippines', 'DE': 'Germany', 'FR': 'France', 'IT': 'Italy',
      'ES': 'Spain', 'NL': 'Netherlands', 'RU': 'Russia', 'CN': 'China',
      'JP': 'Japan', 'KR': 'South Korea', 'BR': 'Brazil', 'MX': 'Mexico',
      'ZA': 'South Africa', 'NG': 'Nigeria', 'KE': 'Kenya', 'EG': 'Egypt',
      '??': 'Unknown',
    };
    return names[iso.toUpperCase()] ?? iso.toUpperCase();
  }
}
