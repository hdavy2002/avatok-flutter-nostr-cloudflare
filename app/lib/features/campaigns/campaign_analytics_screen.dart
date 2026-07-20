import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/campaigns_api.dart';
import '../../core/ui/avatok_dark.dart';

// ---------------------------------------------------------------------------
// AVA-CAMP-FL-ANALYTICS — campaign analytics (account rollup + per-campaign).
//
// TODO(design): `fl_chart` is NOT in pubspec.yaml as of this file's creation.
// Every chart below is therefore a minimal hand-rolled Container/Row bar
// widget, not a real plotted chart. If/when `fl_chart` is added as a
// dependency, swap `_BarList`/`_TimeSeriesBars`/`_FunnelSteps` for real
// fl_chart widgets (BarChart/LineChart) — the data-parsing helpers at the
// bottom of this file (`_asStringList`/`_asNumList`/etc.) can stay as-is,
// they just feed different chart widgets.
//
// Every network call goes through [CampaignsApi.fetchAnalytics] /
// [CampaignsApi.fetchAccountAnalytics], both of which return `{}` on ANY
// error (bad status, transport failure, timeout) and NEVER throw. This file
// additionally treats a `{unavailable: true}` response the same as `{}`, and
// every parser below defaults missing/malformed fields to empty/zero rather
// than throwing, so a card can never crash the screen — it just falls back
// to the "Analytics will appear here…" empty state.
// ---------------------------------------------------------------------------

const String _kAnalyticsLagNote = 'Analytics (may lag a few minutes)';
const String _kUnavailableMessage =
    'Analytics will appear here once calls complete (may lag a few minutes).';

/// ACCOUNT-level Analytics menu screen — cards for spend-over-time, campaign
/// leaderboard, dial volume and outcome distribution across ALL of the
/// caller's campaigns (`CampaignsApi.fetchAccountAnalytics`). Standalone
/// screen; not wired into any router/drawer yet (AVA-CAMP-FL-ANALYTICS).
class CampaignAnalyticsScreen extends StatefulWidget {
  const CampaignAnalyticsScreen({super.key});

  @override
  State<CampaignAnalyticsScreen> createState() => _CampaignAnalyticsScreenState();
}

class _CampaignAnalyticsScreenState extends State<CampaignAnalyticsScreen> {
  String _period = '30d';

  late Future<Map<String, dynamic>> _spend;
  late Future<Map<String, dynamic>> _leaderboard;
  late Future<Map<String, dynamic>> _volume;
  late Future<Map<String, dynamic>> _outcomeDist;

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  void _loadAll() {
    _spend = CampaignsApi.fetchAccountAnalytics('spend', period: _period);
    _leaderboard = CampaignsApi.fetchAccountAnalytics('leaderboard', period: _period);
    _volume = CampaignsApi.fetchAccountAnalytics('volume', period: _period);
    _outcomeDist = CampaignsApi.fetchAccountAnalytics('outcome_dist', period: _period);
  }

  void _setPeriod(String p) {
    if (p == _period) return;
    setState(() {
      _period = p;
      _loadAll();
    });
  }

  Future<void> _refresh() async {
    setState(_loadAll);
    await Future.wait([_spend, _leaderboard, _volume, _outcomeDist])
        .catchError((_) => const <Map<String, dynamic>>[]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _header(title: 'Analytics'),
      body: SafeArea(
        child: RefreshIndicator(
          color: AD.iconSearch,
          onRefresh: _refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(20),
            children: [
              _PeriodToggle(period: _period, onChanged: _setPeriod),
              const SizedBox(height: 16),
              _AnalyticsCard(
                icon: PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
                iconColor: AD.iconSearch,
                title: 'Spend over time',
                future: _spend,
                builder: (data) => _spendBody(data),
              ),
              const SizedBox(height: 14),
              _AnalyticsCard(
                icon: PhosphorIcons.trophy(PhosphorIconsStyle.bold),
                iconColor: AD.outgoingCall,
                title: 'Campaign leaderboard',
                future: _leaderboard,
                builder: (data) => _leaderboardBody(data),
              ),
              const SizedBox(height: 14),
              _AnalyticsCard(
                icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                iconColor: AD.iconPhone,
                title: 'Dial volume',
                future: _volume,
                builder: (data) => _volumeBody(data),
              ),
              const SizedBox(height: 14),
              _AnalyticsCard(
                icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
                iconColor: AD.iconShield,
                title: 'Outcome distribution',
                future: _outcomeDist,
                builder: (data) => _outcomeDistBody(data),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- bodies

  Widget _spendBody(Map<String, dynamic> data) {
    final days = _asStringList(data['days']);
    final tokens = _asNumList(data['tokens']);
    if (days.isEmpty || tokens.isEmpty) return const _UnavailableBody();
    return _TimeSeriesBars(labels: days, values: tokens, color: AD.iconSearch, unit: 'tok');
  }

  Widget _leaderboardBody(Map<String, dynamic> data) {
    final raw = (data['campaigns'] as List?) ?? const [];
    if (raw.isEmpty) return const _UnavailableBody();
    final rows = raw.whereType<Map>().map((e) {
      final m = e.cast<String, dynamic>();
      return (
        name: (m['name'] ?? 'Untitled').toString(),
        answerRate: _asNum(m['answer_rate']),
        bookingRate: _asNum(m['booking_rate']),
      );
    }).toList();
    if (rows.isEmpty) return const _UnavailableBody();
    return Column(
      children: [
        for (final r in rows) ...[
          _LeaderboardRow(name: r.name, answerRate: r.answerRate, bookingRate: r.bookingRate),
          const SizedBox(height: 10),
        ],
      ],
    );
  }

  Widget _volumeBody(Map<String, dynamic> data) {
    final days = _asStringList(data['days']);
    final tokens = _asNumList(data['tokens']);
    if (days.isEmpty) return const _UnavailableBody();
    return _TimeSeriesBars(
        labels: days, values: tokens, color: AD.iconPhone, unit: 'calls');
  }

  Widget _outcomeDistBody(Map<String, dynamic> data) {
    final labels = _asStringList(data['labels']);
    final values = _asNumList(data['values']);
    if (labels.isEmpty || values.isEmpty) return const _UnavailableBody();
    return _BarList(labels: labels, values: values, color: AD.iconShield);
  }

  // ---------------------------------------------------------------- header

  PreferredSizeWidget _header({required String title}) {
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
            child: Row(children: [
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).maybePop(),
                child: Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: AD.card,
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: Center(
                    child: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                        size: 20, color: AD.textPrimary),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(title,
                    style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Reusable per-campaign analytics block — funnel, outcomes breakdown,
/// hour-of-day, cost, machine rate, handover — meant to be embedded inside
/// the (not-yet-built) campaign detail screen. Renders as a plain Column
/// (no Scaffold), so the caller controls the surrounding page.
class CampaignAnalyticsCards extends StatefulWidget {
  const CampaignAnalyticsCards({super.key, required this.campaignId});

  final String campaignId;

  @override
  State<CampaignAnalyticsCards> createState() => _CampaignAnalyticsCardsState();
}

class _CampaignAnalyticsCardsState extends State<CampaignAnalyticsCards> {
  late Future<Map<String, dynamic>> _funnel;
  late Future<Map<String, dynamic>> _outcomes;
  late Future<Map<String, dynamic>> _hourOfDay;
  late Future<Map<String, dynamic>> _cost;
  late Future<Map<String, dynamic>> _machineRate;
  late Future<Map<String, dynamic>> _handover;

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  @override
  void didUpdateWidget(covariant CampaignAnalyticsCards oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.campaignId != widget.campaignId) {
      setState(_loadAll);
    }
  }

  void _loadAll() {
    final id = widget.campaignId;
    _funnel = CampaignsApi.fetchAnalytics(id, 'funnel');
    _outcomes = CampaignsApi.fetchAnalytics(id, 'outcomes');
    _hourOfDay = CampaignsApi.fetchAnalytics(id, 'hour_of_day');
    _cost = CampaignsApi.fetchAnalytics(id, 'cost');
    _machineRate = CampaignsApi.fetchAnalytics(id, 'machine_rate');
    _handover = CampaignsApi.fetchAnalytics(id, 'handover');
  }

  @override
  Widget build(BuildContext context) {
    if (widget.campaignId.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _AnalyticsCard(
          icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
          iconColor: AD.iconSearch,
          title: 'Funnel',
          future: _funnel,
          builder: (data) => _funnelBody(data),
        ),
        const SizedBox(height: 14),
        _AnalyticsCard(
          icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
          iconColor: AD.iconShield,
          title: 'Outcomes',
          future: _outcomes,
          builder: (data) => _outcomesBody(data),
        ),
        const SizedBox(height: 14),
        _AnalyticsCard(
          icon: PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
          iconColor: AD.iconBell,
          title: 'Answer rate by hour of day',
          future: _hourOfDay,
          builder: (data) => _hourOfDayBody(data),
        ),
        const SizedBox(height: 14),
        _AnalyticsCard(
          icon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
          iconColor: AD.outgoingCall,
          title: 'Cost',
          future: _cost,
          builder: (data) => _costBody(data),
        ),
        const SizedBox(height: 14),
        _AnalyticsCard(
          icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
          iconColor: AD.iconVideo,
          title: 'Machine (voicemail/IVR) rate',
          future: _machineRate,
          builder: (data) => _singleRateBody(data, key: 'rate'),
        ),
        const SizedBox(height: 14),
        _AnalyticsCard(
          icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
          iconColor: AD.iconCamera,
          title: 'Handover',
          future: _handover,
          builder: (data) => _singleRateBody(data, key: 'rate'),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------- bodies

  Widget _funnelBody(Map<String, dynamic> data) {
    final raw = (data['steps'] as List?) ?? const [];
    if (raw.isEmpty) return const _UnavailableBody();
    final steps = raw.whereType<Map>().map((e) {
      final m = e.cast<String, dynamic>();
      return (name: (m['name'] ?? '').toString(), count: _asNum(m['count']));
    }).toList();
    if (steps.isEmpty) return const _UnavailableBody();
    return _FunnelSteps(steps: steps);
  }

  Widget _outcomesBody(Map<String, dynamic> data) {
    final labels = _asStringList(data['labels']);
    final values = _asNumList(data['values']);
    if (labels.isEmpty || values.isEmpty) return const _UnavailableBody();
    return _BarList(labels: labels, values: values, color: AD.iconShield);
  }

  Widget _hourOfDayBody(Map<String, dynamic> data) {
    final hours = _asStringList(data['hours']);
    final rates = _asNumList(data['answer_rate']);
    if (hours.isEmpty || rates.isEmpty) return const _UnavailableBody();
    return _TimeSeriesBars(labels: hours, values: rates, color: AD.iconBell, unit: '%');
  }

  Widget _costBody(Map<String, dynamic> data) {
    final days = _asStringList(data['days']);
    final tokens = _asNumList(data['tokens']);
    final perAnswer = data['cost_per_answer'];
    final perBooking = data['cost_per_booking'];
    if (days.isEmpty && perAnswer == null && perBooking == null) {
      return const _UnavailableBody();
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (days.isNotEmpty && tokens.isNotEmpty)
        _TimeSeriesBars(labels: days, values: tokens, color: AD.outgoingCall, unit: 'tok'),
      if (perAnswer != null || perBooking != null) ...[
        const SizedBox(height: 12),
        Row(children: [
          if (perAnswer != null)
            Expanded(child: _StatChip(label: 'Per answer', value: _fmtNum(_asNum(perAnswer)))),
          if (perAnswer != null && perBooking != null) const SizedBox(width: 10),
          if (perBooking != null)
            Expanded(child: _StatChip(label: 'Per booking', value: _fmtNum(_asNum(perBooking)))),
        ]),
      ],
    ]);
  }

  Widget _singleRateBody(Map<String, dynamic> data, {required String key}) {
    final rate = data[key];
    if (rate == null && data.isEmpty) return const _UnavailableBody();
    final pct = _asNum(rate ?? data['value'] ?? data['percent']);
    return _RateBar(pct: pct);
  }
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

class _PeriodToggle extends StatelessWidget {
  const _PeriodToggle({required this.period, required this.onChanged});

  final String period;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rTab),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(children: [
        Expanded(child: _segment('7d', '7 days')),
        Expanded(child: _segment('30d', '30 days')),
      ]),
    );
  }

  Widget _segment(String value, String label) {
    final active = value == period;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onChanged(value),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: active ? AD.primaryBadge : Colors.transparent,
          borderRadius: BorderRadius.circular(AD.rTab - 2),
        ),
        alignment: Alignment.center,
        child: Text(label,
            style: ADText.tabLabel(c: active ? Colors.white : AD.textSecondary)),
      ),
    );
  }
}

/// Generic analytics card shell: icon + title + "may lag" subtitle header,
/// then a FutureBuilder body — loading spinner / friendly unavailable state
/// / the caller's [builder] on success. Never throws past this widget: a
/// malformed [future] result is caught and rendered as the unavailable state.
class _AnalyticsCard extends StatelessWidget {
  const _AnalyticsCard({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.future,
    required this.builder,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final Future<Map<String, dynamic>> future;
  final Widget Function(Map<String, dynamic> data) builder;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(icon, size: 18, color: iconColor),
          const SizedBox(width: 8),
          Expanded(
            child: Text(title,
                style: ADText.rowName().copyWith(fontSize: 15),
                maxLines: 1,
                overflow: TextOverflow.ellipsis),
          ),
        ]),
        const SizedBox(height: 2),
        Text(_kAnalyticsLagNote, style: ADText.statCaption(c: AD.textFaint)),
        const SizedBox(height: 14),
        FutureBuilder<Map<String, dynamic>>(
          future: future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Padding(
                padding: EdgeInsets.symmetric(vertical: 18),
                child: Center(
                  child: SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch),
                  ),
                ),
              );
            }
            Map<String, dynamic> data;
            try {
              data = snap.hasError ? const {} : (snap.data ?? const {});
              if (data['unavailable'] == true) data = const {};
            } catch (_) {
              data = const {};
            }
            try {
              return data.isEmpty ? const _UnavailableBody() : builder(data);
            } catch (_) {
              // Any parsing surprise inside `builder` falls back to the
              // empty state instead of taking the screen down.
              return const _UnavailableBody();
            }
          },
        ),
      ]),
    );
  }
}

class _UnavailableBody extends StatelessWidget {
  const _UnavailableBody();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Text(
        _kUnavailableMessage,
        style: ADText.preview(c: AD.textTertiary),
      ),
    );
  }
}

/// Horizontal proportional bar-list — used for outcomes / outcome
/// distribution breakdowns. `values` need not be normalized; bars are scaled
/// relative to the max value in the list.
class _BarList extends StatelessWidget {
  const _BarList({required this.labels, required this.values, required this.color});

  final List<String> labels;
  final List<num> values;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final n = labels.length < values.length ? labels.length : values.length;
    if (n == 0) return const _UnavailableBody();
    final maxV = values.take(n).fold<num>(0, (a, b) => a > b ? a : b);
    return Column(
      children: [
        for (var i = 0; i < n; i++) ...[
          _barRow(labels[i], values[i], maxV),
          if (i != n - 1) const SizedBox(height: 10),
        ],
      ],
    );
  }

  Widget _barRow(String label, num value, num maxV) {
    final frac = maxV <= 0 ? 0.0 : (value / maxV).clamp(0.0, 1.0).toDouble();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
          child: Text(label,
              style: ADText.preview(c: AD.textSecondary),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ),
        const SizedBox(width: 8),
        Text(_fmtNum(value), style: ADText.statCaption(c: AD.textTertiary)),
      ]),
      const SizedBox(height: 4),
      ClipRRect(
        borderRadius: BorderRadius.circular(4),
        child: LayoutBuilder(builder: (context, box) {
          return Container(
            height: 8,
            width: box.maxWidth,
            color: AD.borderControl,
            alignment: Alignment.centerLeft,
            child: FractionallySizedBox(
              widthFactor: frac,
              child: Container(color: color),
            ),
          );
        }),
      ),
    ]);
  }
}

/// Simple vertical bar time-series — scrollable when there are many points
/// (days-of-month, hours-of-day, etc.). No axes/gridlines — a lightweight
/// stand-in until `fl_chart` is added (see TODO at the top of this file).
class _TimeSeriesBars extends StatelessWidget {
  const _TimeSeriesBars({
    required this.labels,
    required this.values,
    required this.color,
    this.unit = '',
  });

  final List<String> labels;
  final List<num> values;
  final Color color;
  final String unit;

  static const double _barWidth = 22;
  static const double _maxBarHeight = 90;

  @override
  Widget build(BuildContext context) {
    final n = labels.length < values.length ? labels.length : values.length;
    if (n == 0) return const _UnavailableBody();
    final maxV = values.take(n).fold<num>(0, (a, b) => a > b ? a : b);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (var i = 0; i < n; i++) _bar(labels[i], values[i], maxV),
        ],
      ),
    );
  }

  Widget _bar(String label, num value, num maxV) {
    final h = maxV <= 0 ? 2.0 : (_maxBarHeight * (value / maxV).clamp(0.0, 1.0)).toDouble();
    return Padding(
      padding: const EdgeInsets.only(right: 10),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(_fmtNum(value), style: ADText.statCaption(c: AD.textTertiary)),
        const SizedBox(height: 4),
        Container(
          width: _barWidth,
          height: h < 2 ? 2 : h,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(4),
          ),
        ),
        const SizedBox(height: 6),
        SizedBox(
          width: _barWidth + 14,
          child: Text(label,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ADText.statCaption(c: AD.textFaint)),
        ),
      ]),
    );
  }
}

/// Descending proportional bars for a call-funnel (contacted → answered →
/// … → booked, etc.).
class _FunnelSteps extends StatelessWidget {
  const _FunnelSteps({required this.steps});

  final List<({String name, num count})> steps;

  @override
  Widget build(BuildContext context) {
    if (steps.isEmpty) return const _UnavailableBody();
    final maxV = steps.fold<num>(0, (a, s) => a > s.count ? a : s.count);
    return Column(
      children: [
        for (var i = 0; i < steps.length; i++) ...[
          _step(steps[i], maxV),
          if (i != steps.length - 1) const SizedBox(height: 10),
        ],
      ],
    );
  }

  Widget _step(({String name, num count}) s, num maxV) {
    final frac = maxV <= 0 ? 0.0 : (s.count / maxV).clamp(0.0, 1.0).toDouble();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
          child: Text(s.name.isEmpty ? '—' : s.name,
              style: ADText.preview(c: AD.textSecondary),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ),
        const SizedBox(width: 8),
        Text(_fmtNum(s.count), style: ADText.statCaption(c: AD.textTertiary)),
      ]),
      const SizedBox(height: 4),
      ClipRRect(
        borderRadius: BorderRadius.circular(4),
        child: LayoutBuilder(builder: (context, box) {
          return Container(
            height: 10,
            width: box.maxWidth,
            color: AD.borderControl,
            alignment: Alignment.centerLeft,
            child: FractionallySizedBox(
              widthFactor: frac == 0 ? 0.02 : frac,
              child: Container(color: AD.iconSearch),
            ),
          );
        }),
      ),
    ]);
  }
}

/// Single-row leaderboard entry — campaign name + answer/booking rate chips.
class _LeaderboardRow extends StatelessWidget {
  const _LeaderboardRow({required this.name, required this.answerRate, required this.bookingRate});

  final String name;
  final num answerRate;
  final num bookingRate;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AD.cardHover,
        borderRadius: BorderRadius.circular(AD.rStatCard),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(children: [
        Expanded(
          child: Text(name.isEmpty ? 'Untitled campaign' : name,
              style: ADText.rowName().copyWith(fontSize: 14),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ),
        const SizedBox(width: 8),
        _miniStat('Answer', answerRate, AD.online),
        const SizedBox(width: 10),
        _miniStat('Booking', bookingRate, AD.outgoingCall),
      ]),
    );
  }

  Widget _miniStat(String label, num pct, Color color) {
    return Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
      Text('${_fmtNum(pct)}%', style: ADText.statCaption(c: color)),
      Text(label, style: ADText.statCaption(c: AD.textFaint)),
    ]);
  }
}

/// A labeled percentage bar for single-value rate metrics (machine rate,
/// handover rate, …).
class _RateBar extends StatelessWidget {
  const _RateBar({required this.pct});

  final num pct;

  @override
  Widget build(BuildContext context) {
    final frac = (pct / 100).clamp(0.0, 1.0).toDouble();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('${_fmtNum(pct)}%', style: ADText.rowName().copyWith(fontSize: 20)),
      const SizedBox(height: 8),
      ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: LinearProgressIndicator(
          value: frac,
          minHeight: 8,
          backgroundColor: AD.borderControl,
          valueColor: const AlwaysStoppedAnimation<Color>(AD.iconVideo),
        ),
      ),
    ]);
  }
}

/// A small labeled stat chip (used for cost-per-answer / cost-per-booking).
class _StatChip extends StatelessWidget {
  const _StatChip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AD.cardHover,
        borderRadius: BorderRadius.circular(AD.rStatCard),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(value, style: ADText.rowName().copyWith(fontSize: 16)),
        const SizedBox(height: 2),
        Text(label, style: ADText.statCaption(c: AD.textFaint)),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Null/empty-safe parsing helpers — every getter here defaults rather than
// throws, so a malformed or partially-shaped Worker response degrades to the
// unavailable state instead of crashing a card.
// ---------------------------------------------------------------------------

List<String> _asStringList(dynamic v) {
  if (v is! List) return const [];
  return v.map((e) => e?.toString() ?? '').toList();
}

List<num> _asNumList(dynamic v) {
  if (v is! List) return const [];
  return v.map(_asNum).toList();
}

num _asNum(dynamic v) {
  if (v is num) return v;
  if (v is String) return num.tryParse(v) ?? 0;
  return 0;
}

String _fmtNum(num v) {
  if (v == v.roundToDouble() && v.abs() < 1e15) return v.toInt().toString();
  return v.toStringAsFixed(1);
}
