import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavision_api.dart';
import '../../../core/ui/zine.dart';
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
      appBar: ZineAppBar(title: a.name, tag: 'DASHBOARD · EARNINGS', showBack: Navigator.of(context).canPop()),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.lilac))
            : RefreshIndicator(
                color: Zine.blueInk,
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    Row(children: [
                      Avatar(seed: a.id, name: a.name, size: 56, avatarUrl: a.avatarUrl),
                      const SizedBox(width: 14),
                      Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(a.name, style: ZineText.cardTitle(size: 19)),
                        Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
                      ])),
                    ]),
                    const SizedBox(height: 22),
                    Text('LAST 24 HOURS', style: ZineText.kicker()),
                    const SizedBox(height: 10),
                    if (s == null)
                      Padding(
                          padding: const EdgeInsets.all(24),
                          child: Center(
                              child: Text('No stats yet — they appear after your first booking or session.',
                                  textAlign: TextAlign.center, style: ZineText.sub(size: 13))))
                    else ...[
                      Row(children: [
                        _stat('Bookings', '${s.bookings}', PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), Zine.blue),
                        const SizedBox(width: 10),
                        _stat('Sessions', '${s.calls}', PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), Zine.lilac),
                      ]),
                      const SizedBox(height: 10),
                      Row(children: [
                        _stat('Minutes', '${s.minutes}', PhosphorIcons.timer(PhosphorIconsStyle.bold), Zine.mint),
                        const SizedBox(width: 10),
                        _stat('Refunds', fmtCoins(s.refundsCoins), PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), Zine.coral),
                      ]),
                      const SizedBox(height: 16),
                      // Earnings hero — money = mint.
                      ZineCard(
                        color: Zine.mint,
                        padding: const EdgeInsets.all(18),
                        boxShadow: Zine.shadow,
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('YOU EARNED', style: ZineText.kicker(color: Zine.ink)),
                          const SizedBox(height: 6),
                          Text(fmtCoins(s.netCoins), style: ZineText.stat(size: 38)),
                          const SizedBox(height: 6),
                          Text(
                              a.isFreeForCallers
                                  ? 'Sponsored agent — users train free; usage billed to your AvaWallet.'
                                  : 'Gross ${fmtCoins(s.grossCoins)} · your 50% share after the platform fee. Paid to your AvaWallet on settlement.',
                              style: ZineText.sub(size: 12, color: Zine.ink)),
                        ]),
                      ),
                      // ── Vision performance (scores + snapshot usage) ──
                      const SizedBox(height: 22),
                      Text('VISION PERFORMANCE', style: ZineText.kicker()),
                      const SizedBox(height: 10),
                      Row(children: [
                        _stat(
                            a.hasScore && a.scoreLabel != null ? 'Avg ${a.scoreLabel}' : 'Avg score',
                            s.avgScore != null ? s.avgScore!.toStringAsFixed(0) : '—',
                            PhosphorIcons.gauge(PhosphorIconsStyle.bold),
                            Zine.blue),
                        const SizedBox(width: 10),
                        _stat('Peak score', s.peakScore != null ? '${s.peakScore}' : '—',
                            PhosphorIcons.trendUp(PhosphorIconsStyle.bold), Zine.lilac),
                      ]),
                      const SizedBox(height: 10),
                      Row(children: [
                        _stat('"Analyze" used', '${s.snapshotCalls}', PhosphorIcons.camera(PhosphorIconsStyle.bold), Zine.coral),
                        const SizedBox(width: 10),
                        _stat('Free / session', '${a.freeSnapshotsPerSession}', PhosphorIcons.sparkle(PhosphorIconsStyle.bold), Zine.mint),
                      ]),
                      // ── Audience (last 30 days) ──
                      const SizedBox(height: 22),
                      Text('AUDIENCE — LAST 30 DAYS', style: ZineText.kicker()),
                      const SizedBox(height: 10),
                      Row(children: [
                        _stat('Page views', '${s.views30d}', PhosphorIcons.eye(PhosphorIconsStyle.bold), Zine.blue),
                        const SizedBox(width: 10),
                        _stat('Unique viewers', '${s.uniqueViewers30d}', PhosphorIcons.users(PhosphorIconsStyle.bold), Zine.lilac),
                      ]),
                      if (s.viewsByCountry.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text('Top countries', style: ZineText.cardTitle(size: 15)),
                        const SizedBox(height: 8),
                        for (final c in s.viewsByCountry) _rank(c.key, c.value, s.viewsByCountry.first.value),
                      ],
                      if (s.viewsByAgeGroup.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text('Age groups', style: ZineText.cardTitle(size: 15)),
                        const SizedBox(height: 8),
                        for (final g in s.viewsByAgeGroup) _rank(g.key, g.value, s.views30d),
                      ],
                    ],
                    const SizedBox(height: 18),
                    Text("📬 You'll also get a morning digest with these numbers for all your agents.",
                        style: ZineText.sub(size: 12)),
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
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 12.5, weight: FontWeight.w800))),
          Expanded(
              child: ClipRRect(
            borderRadius: BorderRadius.circular(100),
            child: LinearProgressIndicator(
              value: max > 0 ? value / max : 0,
              minHeight: 9,
              backgroundColor: Zine.paper2,
              valueColor: const AlwaysStoppedAnimation(Zine.lilac),
            ),
          )),
          const SizedBox(width: 8),
          SizedBox(
              width: 32,
              child: Text('$value', textAlign: TextAlign.right, style: ZineText.value(size: 12.5, weight: FontWeight.w900))),
        ]),
      );

  Widget _stat(String label, String value, IconData icon, Color accent) => Expanded(
        child: ZineCard(
          radius: Zine.rSm,
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(height: 10),
            Text(value, style: ZineText.stat(size: 26), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Text(label.toUpperCase(), style: ZineText.kicker(size: 10), maxLines: 1, overflow: TextOverflow.ellipsis),
          ]),
        ),
      );
}
