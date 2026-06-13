import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavision_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'agent_detail.dart';
import 'studio/agent_form_flow.dart';
import 'studio/my_agents_screen.dart';
import 'widgets.dart';

// NOTE (Phase Z dependency): `RemoteConfig.avavisionEnabled` does not exist yet —
// Phase Z adds the getter to app/lib/core/remote_config.dart (mirroring
// `avavoiceEnabled`). Until then the reference below is an EXPECTED
// deferred-wiring analyzer error documented in
// Specs/avavision-build/glue/PHASE-2-GLUE.md.

/// AvaVision landing — marketplace of AI vision coaching agents + my bookings +
/// creator studio entry. Master: Specs/avavision-build/MASTER-PROMPT.md.
class AvaVisionHome extends StatefulWidget {
  const AvaVisionHome({super.key});
  @override
  State<AvaVisionHome> createState() => _AvaVisionHomeState();
}

class _AvaVisionHomeState extends State<AvaVisionHome> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  List<VisionAgent> _agents = [];
  List<VisionBooking> _bookings = [];
  bool _loading = true;
  String _q = '';

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavision', 'home');
    _tabs.addListener(() {
      if (!_tabs.indexIsChanging) {
        Analytics.capture('avavision_tab_switched', {'tab': _tabs.index == 0 ? 'marketplace' : 'my_bookings'});
      }
      if (mounted) setState(() {});
    });
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
        AvaVisionApi.marketplace(q: _q.isEmpty ? null : _q),
        AvaVisionApi.myBookings(),
      ]);
      if (!mounted) return;
      setState(() {
        _agents = results[0] as List<VisionAgent>;
        _bookings = results[1] as List<VisionBooking>;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createAgent() async {
    Analytics.capture('avavision_new_agent_shortcut', {'from': 'home'});
    final created = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => const AgentFormFlow()));
    if (created == true && mounted) _load();
  }

  void _openAgent(VisionAgent a) {
    Analytics.capture('avavision_agent_opened', {
      'agent': a.id,
      'payer_mode': a.payerMode,
      'busy': a.busy,
      'from': _q.isEmpty ? 'browse' : 'search',
    });
    Navigator.push(context, MaterialPageRoute(builder: (_) => AgentDetailScreen(agentId: a.id))).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    if (!RemoteConfig.avavisionEnabled) {
      return Scaffold(
        backgroundColor: Zine.paper,
        appBar: const ZineAppBar(title: 'AvaVision', markWord: 'Vision'),
        body: ZinePaper(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: ZineEmptyState(
                  icon: PhosphorIcons.eye(PhosphorIconsStyle.bold),
                  text: 'AvaVision is temporarily unavailable — check back soon.'),
            ),
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'AvaVision',
        markWord: 'Vision',
        tag: 'ai vision coaches',
        actions: [
          ZinePressable(
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MyAgentsScreen())).then((_) => _load()),
            color: Zine.lime,
            radius: BorderRadius.circular(100),
            boxShadow: Zine.shadowXs,
            child: SizedBox(
              width: 42,
              height: 42,
              child: Center(child: PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.bold), size: 20, color: Zine.ink)),
            ),
          ),
        ],
      ),
      body: ZinePaper(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
            child: Row(children: [
              Expanded(child: ZineChip(label: 'Marketplace', active: _tabs.index == 0, onTap: () => _tabs.animateTo(0))),
              const SizedBox(width: 9),
              Expanded(child: ZineChip(label: 'My bookings', active: _tabs.index == 1, onTap: () => _tabs.animateTo(1))),
            ]),
          ),
          Expanded(
            child: TabBarView(controller: _tabs, children: [_marketplace(), _myBookings()]),
          ),
        ]),
      ),
    );
  }

  Widget _marketplace() {
    return RefreshIndicator(
      onRefresh: _load,
      color: Zine.blueInk,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          ZineField(
            leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            hint: 'Search vision coaches…',
            onSubmitted: (v) {
              _q = v;
              Analytics.capture('avavision_search', {'q_len': v.trim().length});
              _load();
            },
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Zine.lilac,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Zine.border,
              boxShadow: Zine.shadowXs,
            ),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.fill), size: 28, color: Zine.ink),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'AI coaches that SEE you — form, technique and skill, live on camera. A skeleton overlay + live score, and "Analyze my form" for a deep look. Pay per minute, max 1 hour.',
                  style: ZineText.sub(size: 12.5, color: Zine.ink),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: ZineButton(
              label: 'New vision agent',
              variant: ZineButtonVariant.blue,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              fontSize: 14,
              onPressed: _createAgent,
            ),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator(color: Zine.blueInk)))
          else if (_agents.isEmpty)
            Padding(
              padding: const EdgeInsets.all(40),
              child: Center(
                child: ZineEmptyState(
                    icon: PhosphorIcons.eye(PhosphorIconsStyle.bold),
                    text: 'No vision agents yet — tap the eye to create the first one.'),
              ),
            )
          else
            ..._agents.map((a) => Padding(padding: const EdgeInsets.only(bottom: 10), child: AgentCard(agent: a, onTap: () => _openAgent(a)))),
        ],
      ),
    );
  }

  Widget _myBookings() {
    if (_loading) return const Center(child: CircularProgressIndicator(color: Zine.blueInk));
    if (_bookings.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ZineEmptyState(
              icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
              text: 'No bookings yet — book a session with any coach in the marketplace.'),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      color: Zine.blueInk,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _bookings.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (_, i) {
          final b = _bookings[i];
          final upcoming = b.status == 'booked' && b.scheduledAt > DateTime.now().millisecondsSinceEpoch - 10 * 60 * 1000;
          return ZinePressable(
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AgentDetailScreen(agentId: b.agentId))).then((_) => _load()),
            radius: BorderRadius.circular(Zine.rSm),
            boxShadow: Zine.shadowXs,
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
                child: Avatar(seed: b.agentId, name: b.agentName, size: 44, avatarUrl: b.agentAvatar),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(b.agentName, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 15)),
                  const SizedBox(height: 3),
                  Text(
                    ('${fmtWhenMs(b.scheduledAt)} · ${b.bookedMinutes} min'
                            '${b.escrowCoins > 0 ? ' · ${fmtCoins(b.escrowCoins)} held' : ''} · ${b.status}')
                        .toUpperCase(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ZineText.tag(size: 10, color: Zine.inkSoft),
                  ),
                ]),
              ),
              if (upcoming) ...[
                const SizedBox(width: 8),
                ZinePressable(
                  onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AgentDetailScreen(agentId: b.agentId, bookingId: b.id))).then((_) => _load()),
                  color: Zine.mint,
                  radius: BorderRadius.circular(100),
                  boxShadow: Zine.shadowXs,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  child: Text('Join', style: ZineText.button(size: 14)),
                ),
              ],
            ]),
          );
        },
      ),
    );
  }
}
