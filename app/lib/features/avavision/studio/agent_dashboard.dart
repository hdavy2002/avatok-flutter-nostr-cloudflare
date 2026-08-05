import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavision_api.dart';
import '../../../core/ui/zine_widgets.dart';

/// Per-agent earnings + performance dashboard. Mirrors AvaVoice and adds the
/// vision-specific blocks: average / peak score and "Analyze my form" usage.
class AgentDashboardScreen extends StatefulWidget {
  final VisionAgent agent;
  const AgentDashboardScreen({super.key, required this.agent});
  @override
  State<AgentDashboardScreen> createState() => _AgentDashboardScreenState();
}

class _AgentDashboardScreenState extends State<AgentDashboardScreen> {
  AgentDayStats? _stats;
  bool _loading = true;

  VisionAgent get a => widget.agent;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavision', 'studio_dashboard');
    _load();
  }

  Future<void> _load() async {
    final s = await AvaVisionApi.stats(a.id);
    if (!mounted) return;
    setState(() {
      _stats = s;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = _stats;
    return Scaffold(
      appBar: ZineAppBar(title: a.name, tag: 'Dashboard · earnings', showBack: Navigator.of(context).canPop()),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AD.tabCalls))
            : RefreshIndicator(
                color: AD.tabGroups,
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.all(Msg.s5),
                  children: [
                    Row(children: [
                      Avatar(seed: a.id, name: a.name, size: 56, avatarUrl: a.avatarUrl),
                      const SizedBox(width: Msg.s3),
                      Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(a.name, style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
                        Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
                      ])),
                    ]),
                    const SizedBox(height: Msg.s5),
                    Text('Last 24 hours', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                    const SizedBox(height: Msg.s2),
                    if (s == null)
                      Padding(
                          padding: const EdgeInsets.all(24),
                          child: Center(
                              child: Text('No stats yet — they appear after your first booking or session.',
                                  textAlign: TextAlign.center, style: ADText.preview().copyWith(fontSize: 13, height: 1.42))))
                    else ...[
                      Row(children: [
                        _stat('Bookings', '${s.bookings}', PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), AD.tabGroups),
                        const SizedBox(width: Msg.s2),
                        _stat('Sessions', '${s.calls}', PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), AD.tabCalls),
                      ]),
                      const SizedBox(height: Msg.s2),
                      Row(children: [
                        _stat('Minutes', '${s.minutes}', PhosphorIcons.timer(PhosphorIconsStyle.bold), AD.online),
                        const SizedBox(width: Msg.s2),
                        _stat('Refunds', fmtCoins(s.refundsCoins), PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), AD.danger),
                      ]),
                      const SizedBox(height: 16),
                      // Earnings hero — money = mint.
                      ZineCard(
                        color: AD.card,
                        padding: const EdgeInsets.all(Msg.s5),
                        boxShadow: Msg.lift,
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('You earned', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                          const SizedBox(height: Msg.s1),
                          Text(fmtCoins(s.netCoins), style: ADText.appTitle(c: AD.online).copyWith(fontSize: 38, height: 1.0, letterSpacing: -0.76)),
                          const SizedBox(height: Msg.s1),
                          Text(
                              a.isFreeForCallers
                                  ? 'Sponsored agent — users train free; usage billed to your AvaWallet.'
                                  : 'Gross ${fmtCoins(s.grossCoins)} · your 50% share after the platform fee. Paid to your AvaWallet on settlement.',
                              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12, height: 1.42)),
                        ]),
                      ),
                      // ── Vision performance (scores + snapshot usage) ──
                      const SizedBox(height: Msg.s5),
                      Text('Vision performance', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                      const SizedBox(height: Msg.s2),
                      Row(children: [
                        _stat(
                            a.hasScore && a.scoreLabel != null ? 'Avg ${a.scoreLabel}' : 'Avg score',
                            s.avgScore != null ? s.avgScore!.toStringAsFixed(0) : '—',
                            PhosphorIcons.gauge(PhosphorIconsStyle.bold),
                            AD.tabGroups),
                        const SizedBox(width: Msg.s2),
                        _stat('Peak score', s.peakScore != null ? '${s.peakScore}' : '—',
                            PhosphorIcons.trendUp(PhosphorIconsStyle.bold), AD.tabCalls),
                      ]),
                      const SizedBox(height: Msg.s2),
                      Row(children: [
                        _stat('"Analyze" used', '${s.snapshotCalls}', PhosphorIcons.camera(PhosphorIconsStyle.bold), AD.danger),
                        const SizedBox(width: Msg.s2),
                        _stat('Free / session', '${a.freeSnapshotsPerSession}', PhosphorIcons.sparkle(PhosphorIconsStyle.bold), AD.online),
                      ]),
                      // ── Audience (last 30 days) ──
                      const SizedBox(height: Msg.s5),
                      Text('Audience — last 30 days', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                      const SizedBox(height: Msg.s2),
                      Row(children: [
                        _stat('Page views', '${s.views30d}', PhosphorIcons.eye(PhosphorIconsStyle.bold), AD.tabGroups),
                        const SizedBox(width: Msg.s2),
                        _stat('Unique viewers', '${s.uniqueViewers30d}', PhosphorIcons.users(PhosphorIconsStyle.bold), AD.tabCalls),
                      ]),
                      if (s.viewsByCountry.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text('Top countries', style: ADText.threadName().copyWith(fontSize: 15, height: 1.1, letterSpacing: -0.2)),
                        const SizedBox(height: 8),
                        for (final c in s.viewsByCountry) _rank(c.key, c.value, s.viewsByCountry.first.value),
                      ],
                      if (s.viewsByAgeGroup.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text('Age groups', style: ADText.threadName().copyWith(fontSize: 15, height: 1.1, letterSpacing: -0.2)),
                        const SizedBox(height: 8),
                        for (final g in s.viewsByAgeGroup) _rank(g.key, g.value, s.views30d),
                      ],
                    ],
                    const SizedBox(height: Msg.s4),
                    Text("📬 You'll also get a morning digest with these numbers for all your agents.",
                        style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
                  ],
                ),
              ),
      ),
    );
  }

  String _flag(String cc) {
    if (cc.length != 2 || cc == '??') return '🌐';
    return String.fromCharCodes(cc.toUpperCase().codeUnits.map((c) => c + 127397));
  }

  Widget _rank(String label, int value, int max) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [
          SizedBox(
              width: 90,
              child: Text(label.length == 2 ? '${_flag(label)}  $label' : label,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w600))),
          Expanded(
              child: ClipRRect(
            borderRadius: BorderRadius.circular(Msg.rPill),
            child: LinearProgressIndicator(
              value: max > 0 ? value / max : 0,
              minHeight: 9,
              backgroundColor: AD.card,
              valueColor: const AlwaysStoppedAnimation(AD.tabCalls),
            ),
          )),
          const SizedBox(width: 8),
          SizedBox(
              width: 32,
              child: Text('$value', textAlign: TextAlign.right, style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w700))),
        ]),
      );

  Widget _stat(String label, String value, IconData icon, Color accent) => Expanded(
        child: ZineCard(
          radius: Msg.rLg,
          boxShadow: Msg.none,
          padding: const EdgeInsets.all(Msg.s4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(height: Msg.s2),
            Text(value, style: ADText.appTitle().copyWith(fontSize: 26, height: 1.0, letterSpacing: -0.52), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Text(label, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 10, letterSpacing: 0.8), maxLines: 1, overflow: TextOverflow.ellipsis),
          ]),
        ),
      );
}
