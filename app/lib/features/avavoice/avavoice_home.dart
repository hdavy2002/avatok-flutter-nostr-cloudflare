import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/widgets.dart' show CoverImage;
import 'agent_detail.dart';
import 'studio/agent_form_flow.dart';
import 'studio/my_agents_screen.dart';
import 'widgets.dart' show fmtWhenMs;

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
    Analytics.screenViewed('avavoice', 'home');
    _tabs.addListener(() {
      if (!_tabs.indexIsChanging) {
        Analytics.capture('avavoice_tab_switched',
            {'tab': _tabs.index == 0 ? 'marketplace' : 'my_bookings'});
      }
      if (mounted) setState(() {}); // keep the zine tab chips in sync
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

  // Direct shortcut into the create-agent wizard (skips the studio list).
  Future<void> _createAgent() async {
    Analytics.capture('avavoice_new_agent_shortcut', {'from': 'home'});
    final created = await Navigator.push<bool>(context,
        MaterialPageRoute(builder: (_) => const AgentFormFlow()));
    if (created == true && mounted) _load();
  }

  void _openAgent(VoiceAgent a) {
    Analytics.capture('avavoice_agent_opened', {
      'agent': a.id, 'payer_mode': a.payerMode, 'busy': a.busy,
      'from': _q.isEmpty ? 'browse' : 'search',
    });
    Navigator.push(context,
        MaterialPageRoute(builder: (_) => AgentDetailScreen(agentId: a.id)))
        .then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    if (!RemoteConfig.avavoiceEnabled) {
      return Scaffold(
        backgroundColor: Zine.paper,
        appBar: const ZineAppBar(title: 'AvaVoice', markWord: 'Voice'),
        body: ZinePaper(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: ZineEmptyState(
                  icon: PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                  text: 'AvaVoice is temporarily unavailable — check back soon.'),
            ),
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'AvaVoice',
        markWord: 'Voice',
        tag: 'ai voice agents',
        actions: [
          // Create-agent CTA — the ONE lime action on this screen.
          ZinePressable(
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const MyAgentsScreen())).then((_) => _load()),
            color: Zine.lime,
            radius: BorderRadius.circular(100),
            boxShadow: Zine.shadowXs,
            child: SizedBox(
              width: 42, height: 42,
              child: Center(
                child: PhosphorIcon(PhosphorIcons.robot(PhosphorIconsStyle.bold),
                    size: 20, color: Zine.ink),
              ),
            ),
          ),
        ],
      ),
      body: ZinePaper(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
            child: Row(children: [
              Expanded(
                child: ZineChip(
                    label: 'Marketplace',
                    active: _tabs.index == 0,
                    onTap: () => _tabs.animateTo(0)),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: ZineChip(
                    label: 'My bookings',
                    active: _tabs.index == 1,
                    onTap: () => _tabs.animateTo(1)),
              ),
            ]),
          ),
          Expanded(
            child: TabBarView(controller: _tabs, children: [
              _marketplace(),
              _myBookings(),
            ]),
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
            hint: 'Search voice agents…',
            onSubmitted: (v) {
              _q = v;
              Analytics.capture('avavoice_search', {'q_len': v.trim().length});
              _load();
            },
          ),
          const SizedBox(height: 14),
          // Hero strip — lilac (AI accent), flat fill, ink border, hard shadow.
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Zine.lilac,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Zine.border,
              boxShadow: Zine.shadowXs,
            ),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.robot(PhosphorIconsStyle.fill),
                  size: 28, color: Zine.ink),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Talk to AI voice agents built by creators — interview practice, tech help, tutoring & more. Pay per minute, max 1 hour.',
                  style: ZineText.sub(size: 12.5, color: Zine.ink),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          // Small creator shortcut — jump straight into the new-agent wizard.
          Align(
            alignment: Alignment.centerLeft,
            child: ZineButton(
              label: 'New AI agent',
              variant: ZineButtonVariant.blue,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              fontSize: 14,
              onPressed: _createAgent,
            ),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const Padding(padding: EdgeInsets.all(40),
                child: Center(child: CircularProgressIndicator(color: Zine.blueInk)))
          else if (_agents.isEmpty)
            Padding(
              padding: const EdgeInsets.all(40),
              child: Center(
                child: ZineEmptyState(
                    icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
                    text: 'No voice agents yet — tap the robot to create the first one.'),
              ),
            )
          else
            ..._agents.map((a) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _agentCard(a))),
        ],
      ),
    );
  }

  // Marketplace agent card — zine card with a lilac AI badge + mono stickers.
  Widget _agentCard(VoiceAgent a) {
    return ZinePressable(
      onTap: () => _openAgent(a),
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: Zine.shadowXs,
      padding: const EdgeInsets.all(12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Zine.ink, width: 2),
          ),
          clipBehavior: Clip.antiAlias,
          child: a.images.isNotEmpty
              ? CoverImage(url: a.images.first, seed: a.id.hashCode, width: 52, height: 52)
              : Avatar(seed: a.id, name: a.name, size: 52, avatarUrl: a.avatarUrl),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                child: Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.cardTitle(size: 16)),
              ),
              const SizedBox(width: 8),
              ZineIconBadge(
                  icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
                  color: Zine.lilac, size: 26),
            ]),
            const SizedBox(height: 2),
            Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [
              if (a.activeCalls != null)
                a.busy
                    ? _miniSticker('busy', Zine.coral, Colors.white)
                    : _miniSticker('call now', Zine.mint, Zine.ink),
              if (a.isFreeForCallers) _miniSticker('free', Zine.mint, Zine.ink),
              if (a.visionEnabled) _miniSticker('vision', Zine.lilac, Zine.ink),
              _miniSticker(
                  a.isFreeForCallers
                      ? 'up to ${a.sessionLimitMin} min'
                      : '${a.rateLabel} · ${a.sessionLimitMin} min',
                  Zine.card, Zine.inkSoft),
            ]),
          ]),
        ),
      ]),
    );
  }

  Widget _miniSticker(String text, Color fill, Color fg) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: Text(text.toUpperCase(), style: ZineText.tag(size: 9.5, color: fg)),
      );

  Widget _myBookings() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Zine.blueInk));
    }
    if (_bookings.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ZineEmptyState(
              icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
              text: 'No bookings yet — book a session with any agent in the marketplace.'),
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
          final upcoming = b.status == 'booked' &&
              b.scheduledAt > DateTime.now().millisecondsSinceEpoch - 10 * 60 * 1000;
          return ZinePressable(
            onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => AgentDetailScreen(agentId: b.agentId)))
                .then((_) => _load()),
            radius: BorderRadius.circular(Zine.rSm),
            boxShadow: Zine.shadowXs,
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                child: Avatar(seed: b.agentId, name: b.agentName, size: 44, avatarUrl: b.agentAvatar),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(b.agentName, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 15)),
                  const SizedBox(height: 3),
                  Text(
                    ('${fmtWhenMs(b.scheduledAt)} · ${b.bookedMinutes} min'
                            '${b.escrowCoins > 0 ? ' · ${fmtCoins(b.escrowCoins)} held' : ''} · ${b.status}')
                        .toUpperCase(),
                    maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: ZineText.tag(size: 10, color: Zine.inkSoft),
                  ),
                ]),
              ),
              if (upcoming) ...[
                const SizedBox(width: 8),
                ZinePressable(
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                          builder: (_) => AgentDetailScreen(agentId: b.agentId, bookingId: b.id)))
                      .then((_) => _load()),
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
