import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/theme.dart';
import '../widgets.dart';
import 'agent_dashboard.dart';
import 'agent_form_flow.dart';

/// Creator studio home — every agent the creator owns, with status, quick
/// stats and actions (edit / publish / unpublish / dashboard / delete).
class MyAgentsScreen extends StatefulWidget {
  const MyAgentsScreen({super.key});
  @override
  State<MyAgentsScreen> createState() => _MyAgentsScreenState();
}

class _MyAgentsScreenState extends State<MyAgentsScreen> {
  List<VoiceAgent> _agents = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavoice', 'studio_my_agents');
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await AvaVoiceApi.mine();
      if (!mounted) return;
      setState(() { _agents = items; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _create() async {
    final created = await Navigator.push<bool>(context,
        MaterialPageRoute(builder: (_) => const AgentFormFlow()));
    if (created == true) _load();
  }

  Future<void> _edit(VoiceAgent a) async {
    final changed = await Navigator.push<bool>(context,
        MaterialPageRoute(builder: (_) => AgentFormFlow(existing: a)));
    if (changed == true) _load();
  }

  void _snack(String msg) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }

  Future<void> _act(VoiceAgent a, String action) async {
    Analytics.capture('avavoice_studio_action', {'agent': a.id, 'action': action});
    switch (action) {
      case 'publish':
        final r = await AvaVoiceApi.publish(a.id);
        _snack(r.isEmpty
            ? '${a.name} is live in the marketplace!'
            : (r['detail']?.toString() ?? r['error']?.toString() ?? 'Publish failed'));
      case 'unpublish':
        _snack(await AvaVoiceApi.unpublish(a.id)
            ? 'Removed from the marketplace' : 'Failed');
      case 'delete':
        _snack(await AvaVoiceApi.deleteAgent(a.id) ? 'Deleted' : 'Failed');
    }
    _load();
  }

  void _menu(VoiceAgent a) {
    showModalBottomSheet(context: context, builder: (s) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(leading: const Icon(Icons.edit_outlined), title: const Text('Edit agent'),
            onTap: () { Navigator.pop(s); _edit(a); }),
        ListTile(leading: const Icon(Icons.insights_outlined), title: const Text('Dashboard & earnings'),
            onTap: () { Navigator.pop(s); Navigator.push(context,
                MaterialPageRoute(builder: (_) => AgentDashboardScreen(agent: a))); }),
        if (a.status == 'draft')
          ListTile(leading: const Icon(Icons.publish_outlined, color: AvaColors.success),
              title: const Text('Publish to marketplace'),
              onTap: () { Navigator.pop(s); _act(a, 'publish'); }),
        if (a.status == 'published')
          ListTile(leading: const Icon(Icons.visibility_off_outlined),
              title: const Text('Unpublish (back to draft)'),
              onTap: () { Navigator.pop(s); _act(a, 'unpublish'); }),
        ListTile(leading: const Icon(Icons.delete_outline, color: AvaColors.danger),
            title: const Text('Delete agent'),
            onTap: () async {
              Navigator.pop(s);
              final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
                title: Text('Delete ${a.name}?'),
                content: const Text('Its listing, knowledge files and availability are removed. Past earnings are kept in your ledger.'),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Keep')),
                  TextButton(onPressed: () => Navigator.pop(d, true),
                      child: const Text('Delete', style: TextStyle(color: AvaColors.danger))),
                ],
              ));
              if (ok == true) _act(a, 'delete');
            }),
      ]),
    ));
  }

  Color _statusColor(String s) => switch (s) {
        'published' => AvaColors.success,
        'suspended' => AvaColors.danger,
        _ => AvaColors.sub,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0,
          foregroundColor: AvaColors.ink, title: const Text('My voice agents')),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: kAvaVoicePurple,
        onPressed: _create,
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('New agent',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _agents.isEmpty
              ? _empty()
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 90),
                    itemCount: _agents.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final a = _agents[i];
                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(vertical: 6),
                        leading: Avatar(seed: a.id, name: a.name, size: 52, avatarUrl: a.avatarUrl),
                        title: Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Row(children: [
                          Container(
                            margin: const EdgeInsets.only(top: 2),
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                            decoration: BoxDecoration(
                                color: _statusColor(a.status).withValues(alpha: .12),
                                borderRadius: BorderRadius.circular(8)),
                            child: Text(a.status.toUpperCase(), style: TextStyle(
                                fontSize: 10, fontWeight: FontWeight.w800,
                                color: _statusColor(a.status))),
                          ),
                          const SizedBox(width: 8),
                          Flexible(child: Text(
                            a.isFreeForCallers
                                ? 'Free to callers · you pay ${fmtCoins(kCreatorPaysRateCoinsPerHour)}/hr'
                                : '${fmtCoins(a.ratePerHourCoins)}/hr · you earn ${fmtCoins(creatorNetPerHour(a.ratePerHourCoins))}/hr',
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12, color: AvaColors.sub),
                          )),
                        ]),
                        trailing: IconButton(icon: const Icon(Icons.more_vert), onPressed: () => _menu(a)),
                        onTap: () => _menu(a),
                      );
                    },
                  ),
                ),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 72, height: 72,
              decoration: BoxDecoration(
                  color: kAvaVoicePurple.withValues(alpha: .12),
                  borderRadius: BorderRadius.circular(22)),
              child: const Icon(Icons.smart_toy_outlined, size: 36, color: kAvaVoicePurple),
            ),
            const SizedBox(height: 18),
            const Text('Create your first AI voice agent',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
            const SizedBox(height: 8),
            const Text(
              'Give it a name, a personality and knowledge files, pick a voice, set your hourly rate — and publish. You earn 50% of every minute people talk to it.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AvaColors.sub, fontSize: 13, height: 1.5),
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: kAvaVoicePurple),
              onPressed: _create,
              icon: const Icon(Icons.add),
              label: const Text('Create an agent',
                  style: TextStyle(fontWeight: FontWeight.w800)),
            ),
          ]),
        ),
      );
}
