import 'package:flutter/material.dart';

import '../../../core/avatar.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/theme.dart';
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
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0,
          foregroundColor: AvaColors.ink, title: Text('${a.name} — dashboard')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Row(children: [
                    Avatar(seed: a.id, name: a.name, size: 56, avatarUrl: a.avatarUrl),
                    const SizedBox(width: 14),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(a.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                      Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
                    ])),
                  ]),
                  const SizedBox(height: 20),
                  const Text('Last 24 hours',
                      style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                  const SizedBox(height: 10),
                  if (s == null)
                    const Padding(padding: EdgeInsets.all(24), child: Center(
                        child: Text('No stats yet — they appear after your first booking or call.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: AvaColors.sub, fontSize: 13))))
                  else ...[
                    Row(children: [
                      _stat('Bookings', '${s.bookings}', Icons.event_available_outlined),
                      const SizedBox(width: 10),
                      _stat('Calls', '${s.calls}', Icons.call_outlined),
                    ]),
                    const SizedBox(height: 10),
                    Row(children: [
                      _stat('Minutes talked', '${s.minutes}', Icons.timer_outlined),
                      const SizedBox(width: 10),
                      _stat('Refunds', fmtCoins(s.refundsCoins), Icons.replay_outlined),
                    ]),
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(18),
                      decoration: BoxDecoration(
                        gradient: const LinearGradient(
                            colors: [Color(0xFFA06AF0), Color(0xFFD08BF5)],
                            begin: Alignment.topLeft, end: Alignment.bottomRight),
                        borderRadius: BorderRadius.circular(18),
                      ),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const Text('You earned', style: TextStyle(color: Colors.white70,
                            fontWeight: FontWeight.w700, fontSize: 12)),
                        const SizedBox(height: 4),
                        Text(fmtCoins(s.netCoins), style: const TextStyle(color: Colors.white,
                            fontWeight: FontWeight.w800, fontSize: 32)),
                        const SizedBox(height: 4),
                        Text(a.isFreeForCallers
                            ? 'Sponsored agent — callers talk free; usage billed to your AvaWallet.'
                            : 'Gross ${fmtCoins(s.grossCoins)} · your 50% share after the platform fee. Paid to your AvaWallet on settlement.',
                            style: const TextStyle(color: Colors.white70, fontSize: 11.5, height: 1.4)),
                      ]),
                    ),
                  ],
                  const SizedBox(height: 16),
                  const Text(
                    '📬 You\'ll also get a morning digest with these numbers for all your agents.',
                    style: TextStyle(fontSize: 12, color: AvaColors.sub),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _stat(String label, String value, IconData icon) => Expanded(
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            border: Border.all(color: AvaColors.line),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, size: 18, color: kAvaVoicePurple),
            const SizedBox(height: 8),
            Text(value, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
            Text(label, style: const TextStyle(fontSize: 11.5, color: AvaColors.sub)),
          ]),
        ),
      );
}
