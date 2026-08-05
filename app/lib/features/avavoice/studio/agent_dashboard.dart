import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/ui/zine_widgets.dart';
import '../widgets.dart';

/// Per-agent earnings dashboard (AvaVerse creator dashboard surface).
/// "Every morning the creator sees: bookings, calls in the last 24 h, and
/// how much this agent earned." — spec §6.
class AgentDashboardScreen extends StatefulWidget {
  final VoiceAgent agent;
  const AgentDashboardScreen({super.key, required this.agent});
  @override
  State<AgentDashboardScreen> createState() => _AgentDashboardScreenState();
}

class _AgentDashboardScreenState extends State<AgentDashboardScreen> {
  AgentDayStats? _stats;
  bool _loading = true;

  VoiceAgent get a => widget.agent;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavoice', 'studio_dashboard');
    _load();
  }

  Future<void> _load() async {
    final s = await AvaVoiceApi.stats(a.id);
    if (!mounted) return;
    setState(() { _stats = s; _loading = false; });
  }

  @override
  Widget build(BuildContext context) {
    final s = _stats;
    return Scaffold(
      appBar: ZineAppBar(
        title: a.name,
        tag: 'Dashboard · earnings',
        showBack: Navigator.of(context).canPop(),
      ),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AD.tabCalls))
            : RefreshIndicator(
                color: AD.tabGroups,
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    Row(children: [
                      Avatar(seed: a.id, name: a.name, size: 56, avatarUrl: a.avatarUrl),
                      const SizedBox(width: 14),
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(a.name, style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
                        Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
                      ])),
                    ]),
                    const SizedBox(height: 22),
                    Text('Last 24 hours', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                    const SizedBox(height: 10),
                    if (s == null)
                      Padding(padding: const EdgeInsets.all(24), child: Center(
                          child: Text('No stats yet — they appear after your first booking or call.',
                              textAlign: TextAlign.center, style: ADText.preview().copyWith(fontSize: 13, height: 1.42))))
                    else ...[
                      Row(children: [
                        _stat('Bookings', '${s.bookings}', PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), AD.tabGroups),
                        const SizedBox(width: 10),
                        _stat('Calls', '${s.calls}', PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), AD.tabCalls),
                      ]),
                      const SizedBox(height: 10),
                      Row(children: [
                        _stat('Minutes talked', '${s.minutes}', PhosphorIcons.timer(PhosphorIconsStyle.bold), AD.online),
                        const SizedBox(width: 10),
                        _stat('Refunds', fmtCoins(s.refundsCoins), PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), AD.danger),
                      ]),
                      const SizedBox(height: 16),
                      // Earnings hero — money = mint (§7.10/§7.11).
                      ZineCard(
                        color: AD.card,
                        padding: const EdgeInsets.all(18),
                        boxShadow: Msg.lift,
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('You earned', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                          const SizedBox(height: 6),
                          Text(fmtCoins(s.netCoins), style: ADText.appTitle(c: AD.online).copyWith(fontSize: 38, height: 1.0, letterSpacing: -0.76)),
                          const SizedBox(height: 6),
                          Text(a.isFreeForCallers
                              ? 'Sponsored agent — callers talk free; usage billed to your AvaWallet.'
                              : 'Gross ${fmtCoins(s.grossCoins)} · your 50% share after the platform fee. Paid to your AvaWallet on settlement.',
                              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12, height: 1.42)),
                        ]),
                      ),
                      // ── Audience (last 30 days) — who's looking at this agent ──
                      const SizedBox(height: 22),
                      Text('Audience — last 30 days', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
                      const SizedBox(height: 10),
                      Row(children: [
                        _stat('Page views', '${s.views30d}', PhosphorIcons.eye(PhosphorIconsStyle.bold), AD.tabGroups),
                        const SizedBox(width: 10),
                        _stat('Unique viewers', '${s.uniqueViewers30d}', PhosphorIcons.users(PhosphorIconsStyle.bold), AD.tabCalls),
                      ]),
                      if (s.viewsByCountry.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text('Top countries', style: ADText.threadName().copyWith(fontSize: 15, height: 1.1, letterSpacing: -0.2)),
                        const SizedBox(height: 8),
                        for (final c in s.viewsByCountry) _rank(c.key, c.value,
                            s.viewsByCountry.first.value),
                      ],
                      if (s.viewsByAgeGroup.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text('Age groups', style: ADText.threadName().copyWith(fontSize: 15, height: 1.1, letterSpacing: -0.2)),
                        const SizedBox(height: 8),
                        for (final g in s.viewsByAgeGroup) _rank(g.key, g.value, s.views30d),
                      ],
                    ],
                    const SizedBox(height: 18),
                    Text(
                      "📬 You'll also get a morning digest with these numbers for all your agents.",
                      style: ADText.preview().copyWith(fontSize: 12, height: 1.42),
                    ),
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
          SizedBox(width: 90, child: Text(
              label.length == 2 ? '${_flag(label)}  $label' : label,
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w600))),
          Expanded(child: ClipRRect(
            borderRadius: BorderRadius.circular(Msg.rPill),
            child: LinearProgressIndicator(
              value: max > 0 ? value / max : 0, minHeight: 9,
              backgroundColor: AD.card,
              valueColor: const AlwaysStoppedAnimation(AD.tabCalls),
            ),
          )),
          const SizedBox(width: 8),
          SizedBox(width: 32, child: Text('$value', textAlign: TextAlign.right,
              style: ADText.rowName().copyWith(fontSize: 13, height: 1.3, fontWeight: FontWeight.w700))),
        ]),
      );

  Widget _stat(String label, String value, IconData icon, Color accent) => Expanded(
        child: ZineCard(
          radius: Msg.rLg,
          boxShadow: Msg.none,
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(height: 10),
            Text(value, style: ADText.appTitle().copyWith(fontSize: 26, height: 1.0, letterSpacing: -0.52)),
            const SizedBox(height: 2),
            Text(label, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 10, letterSpacing: 0.8)),
          ]),
        ),
      );
}
