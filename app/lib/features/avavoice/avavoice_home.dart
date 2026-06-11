import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/remote_config.dart';
import '../../core/theme.dart';
import 'agent_detail.dart';
import 'studio/my_agents_screen.dart';
import 'widgets.dart';

/// AvaVoice landing — marketplace of AI voice agents + my bookings + creator
/// studio entry. Spec: Specs/AVAVOICE-PROPOSAL.md.
class AvaVoiceHome extends StatefulWidget {
  const AvaVoiceHome({super.key});
  @override
  State<AvaVoiceHome> createState() => _AvaVoiceHomeState();
}

class _AvaVoiceHomeState extends State<AvaVoiceHome> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  List<VoiceAgent> _agents = [];
  List<VoiceBooking> _bookings = [];
  bool _loading = true;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        AvaVoiceApi.marketplace(q: _q.isEmpty ? null : _q),
        AvaVoiceApi.myBookings(),
      ]);
      if (!mounted) return;
      setState(() {
        _agents = results[0] as List<VoiceAgent>;
        _bookings = results[1] as List<VoiceBooking>;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _openAgent(VoiceAgent a) => Navigator.push(context,
      MaterialPageRoute(builder: (_) => AgentDetailScreen(agentId: a.id)))
      .then((_) => _load());

  @override
  Widget build(BuildContext context) {
    if (!RemoteConfig.avavoiceEnabled) {
      return Scaffold(
        appBar: AppBar(title: const Text('AvaVoice')),
        body: const Center(child: Padding(padding: EdgeInsets.all(24),
            child: Text('AvaVoice is temporarily unavailable. Please check back soon.',
                textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub)))),
      );
    }
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Row(children: [
          Container(
            width: 30, height: 30,
            decoration: BoxDecoration(
                color: kAvaVoicePurple.withValues(alpha: .14),
                borderRadius: BorderRadius.circular(9)),
            child: const Icon(Icons.mic, size: 18, color: kAvaVoicePurple),
          ),
          const SizedBox(width: 10),
          const Text('AvaVoice'),
        ]),
        actions: [
          IconButton(
            tooltip: 'My agents (creator studio)',
            icon: const Icon(Icons.smart_toy_outlined),
            onPressed: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const MyAgentsScreen())).then((_) => _load()),
          ),
        ],
        bottom: TabBar(
          controller: _tabs,
          labelColor: kAvaVoicePurple,
          indicatorColor: kAvaVoicePurple,
          unselectedLabelColor: AvaColors.sub,
          labelStyle: const TextStyle(fontWeight: FontWeight.w800),
          tabs: const [Tab(text: 'Marketplace'), Tab(text: 'My bookings')],
        ),
      ),
      body: TabBarView(controller: _tabs, children: [
        _marketplace(),
        _myBookings(),
      ]),
    );
  }

  Widget _marketplace() {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          TextField(
            decoration: InputDecoration(
              hintText: 'Search voice agents — interview coach, tech support…',
              prefixIcon: const Icon(Icons.search),
              isDense: true,
              filled: true, fillColor: AvaColors.soft,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
            ),
            onSubmitted: (v) { _q = v; _load(); },
          ),
          const SizedBox(height: 14),
          // Hero strip — what AvaVoice is.
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                  colors: [Color(0xFFA06AF0), Color(0xFFD08BF5)],
                  begin: Alignment.topLeft, end: Alignment.bottomRight),
              borderRadius: BorderRadius.circular(16),
            ),
            child: const Row(children: [
              Icon(Icons.record_voice_over, color: Colors.white, size: 30),
              SizedBox(width: 12),
              Expanded(child: Text(
                'Talk to AI voice agents built by creators — interview practice, tech help, tutoring & more. Pay per minute, max 1 hour.',
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 12.5),
              )),
            ]),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const Padding(padding: EdgeInsets.all(40),
                child: Center(child: CircularProgressIndicator()))
          else if (_agents.isEmpty)
            const Padding(
              padding: EdgeInsets.all(40),
              child: Center(child: Text(
                'No voice agents yet.\nBe the first — tap the robot icon to create one!',
                textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub))),
            )
          else
            ..._agents.map((a) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AgentCard(agent: a, onTap: () => _openAgent(a)))),
        ],
      ),
    );
  }

  Widget _myBookings() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_bookings.isEmpty) {
      return const Center(child: Padding(padding: EdgeInsets.all(24),
          child: Text('No bookings yet.\nBook a session with any agent in the marketplace.',
              textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub))));
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _bookings.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (_, i) {
          final b = _bookings[i];
          final upcoming = b.status == 'booked' &&
              b.scheduledAt > DateTime.now().millisecondsSinceEpoch - 10 * 60 * 1000;
          return ListTile(
            contentPadding: const EdgeInsets.symmetric(vertical: 6),
            leading: Avatar(seed: b.agentId, name: b.agentName, size: 46, avatarUrl: b.agentAvatar),
            title: Text(b.agentName, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(
              '${fmtWhenMs(b.scheduledAt)} · ${b.bookedMinutes} min'
              '${b.escrowCoins > 0 ? ' · ${fmtCoins(b.escrowCoins)} held' : ''} · ${b.status}',
              style: const TextStyle(fontSize: 12, color: AvaColors.sub),
            ),
            trailing: upcoming
                ? FilledButton(
                    style: FilledButton.styleFrom(
                        backgroundColor: kAvaVoicePurple,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8)),
                    onPressed: () => Navigator.push(context, MaterialPageRoute(
                            builder: (_) => AgentDetailScreen(agentId: b.agentId, bookingId: b.id)))
                        .then((_) => _load()),
                    child: const Text('Join'),
                  )
                : null,
            onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => AgentDetailScreen(agentId: b.agentId)))
                .then((_) => _load()),
          );
        },
      ),
    );
  }
}
