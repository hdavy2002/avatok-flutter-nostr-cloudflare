import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavision_api.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../widgets.dart';
import 'agent_dashboard.dart';
import 'agent_form_flow.dart';

/// Creator studio home — every vision agent the creator owns, with status,
/// quick stats and actions (edit / publish / unpublish / dashboard / delete).
class MyAgentsScreen extends StatefulWidget {
  const MyAgentsScreen({super.key});
  @override
  State<MyAgentsScreen> createState() => _MyAgentsScreenState();
}

class _MyAgentsScreenState extends State<MyAgentsScreen> {
  List<VisionAgent> _agents = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavision', 'studio_my_agents');
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await AvaVisionApi.mine();
      if (!mounted) return;
      setState(() {
        _agents = items;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _create() async {
    final created = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => const AgentFormFlow()));
    if (created == true) _load();
  }

  Future<void> _edit(VisionAgent a) async {
    final changed = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => AgentFormFlow(existing: a)));
    if (changed == true) _load();
  }

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _act(VisionAgent a, String action) async {
    Analytics.capture('avavision_studio_action', {'agent': a.id, 'action': action});
    switch (action) {
      case 'publish':
        final r = await AvaVisionApi.publish(a.id);
        _snack(r.isEmpty
            ? '${a.name} is live in the marketplace!'
            : (r['detail']?.toString() ?? r['error']?.toString() ?? 'Publish failed'));
      case 'unpublish':
        _snack(await AvaVisionApi.unpublish(a.id) ? 'Removed from the marketplace' : 'Failed');
      case 'delete':
        _snack(await AvaVisionApi.deleteAgent(a.id) ? 'Deleted' : 'Failed');
    }
    _load();
  }

  void _menu(VisionAgent a) {
    showModalBottomSheet(
        context: context,
        backgroundColor: Zine.paper,
        builder: (s) => SafeArea(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ListTile(
                    leading: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), color: Zine.ink),
                    title: Text('Edit agent', style: ZineText.value(size: 15)),
                    onTap: () {
                      Navigator.pop(s);
                      _edit(a);
                    }),
                ListTile(
                    leading: PhosphorIcon(PhosphorIcons.chartLineUp(PhosphorIconsStyle.bold), color: Zine.ink),
                    title: Text('Dashboard & earnings', style: ZineText.value(size: 15)),
                    onTap: () {
                      Navigator.pop(s);
                      Navigator.push(context, MaterialPageRoute(builder: (_) => AgentDashboardScreen(agent: a)));
                    }),
                if (a.status == 'draft')
                  ListTile(
                      leading: PhosphorIcon(PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold), color: Zine.mintInk),
                      title: Text('Publish to marketplace', style: ZineText.value(size: 15)),
                      onTap: () {
                        Navigator.pop(s);
                        _act(a, 'publish');
                      }),
                if (a.status == 'published')
                  ListTile(
                      leading: PhosphorIcon(PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold), color: Zine.ink),
                      title: Text('Unpublish (back to draft)', style: ZineText.value(size: 15)),
                      onTap: () {
                        Navigator.pop(s);
                        _act(a, 'unpublish');
                      }),
                ListTile(
                    leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: Zine.coral),
                    title: Text('Delete agent', style: ZineText.value(size: 15, color: Zine.coral)),
                    onTap: () async {
                      Navigator.pop(s);
                      final ok = await showDialog<bool>(
                          context: context,
                          builder: (d) => AlertDialog(
                                backgroundColor: Zine.card,
                                title: Text('Delete ${a.name}?', style: ZineText.cardTitle()),
                                content: Text(
                                    'Its listing, knowledge files and availability are removed. Past earnings are kept in your ledger.',
                                    style: ZineText.sub(size: 14)),
                                actions: [
                                  TextButton(
                                      onPressed: () => Navigator.pop(d, false),
                                      child: Text('Keep', style: ZineText.tag(size: 13, color: Zine.inkSoft))),
                                  TextButton(
                                      onPressed: () => Navigator.pop(d, true),
                                      child: Text('Delete', style: ZineText.tag(size: 13, color: Zine.coral))),
                                ],
                              ));
                      if (ok == true) _act(a, 'delete');
                    }),
              ]),
            ));
  }

  Color _statusColor(String s) => switch (s) {
        'published' => Zine.mint,
        'suspended' => Zine.coral,
        _ => Zine.paper2,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ZineAppBar(
        title: 'My vision agents',
        markWord: 'vision',
        tag: 'AVAVISION STUDIO',
        showBack: Navigator.of(context).canPop(),
      ),
      floatingActionButton: ZineButton(
        label: 'New agent',
        icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _create,
      ),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.lilac))
            : _agents.isEmpty
                ? _empty()
                : RefreshIndicator(
                    color: Zine.blueInk,
                    onRefresh: _load,
                    child: ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                      itemCount: _agents.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 12),
                      itemBuilder: (_, i) {
                        final a = _agents[i];
                        final suspended = a.status == 'suspended';
                        return ZinePressable(
                          onTap: () => _menu(a),
                          radius: BorderRadius.circular(Zine.rSm),
                          boxShadow: Zine.shadowXs,
                          padding: const EdgeInsets.all(12),
                          child: Row(children: [
                            Avatar(seed: a.id, name: a.name, size: 52, avatarUrl: a.avatarUrl),
                            const SizedBox(width: 12),
                            Expanded(
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(a.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ZineText.value(size: 15, weight: FontWeight.w800)),
                              const SizedBox(height: 5),
                              Row(children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                  decoration: BoxDecoration(
                                    color: _statusColor(a.status),
                                    borderRadius: BorderRadius.circular(100),
                                    border: Border.all(color: Zine.ink, width: 2),
                                  ),
                                  child: Text(a.status.toUpperCase(),
                                      style: ZineText.tag(size: 9.5, color: suspended ? Colors.white : Zine.ink)),
                                ),
                                const SizedBox(width: 6),
                                CapabilityBadge(a.capability),
                                const SizedBox(width: 6),
                                Flexible(
                                    child: Text(
                                  a.isFreeForCallers
                                      ? 'Free · you pay ${fmtCoins(kCreatorPaysRateCoinsPerHour)}/hr'
                                      : '${fmtCoins(a.ratePerHourCoins)}/hr · earn ${fmtCoins(creatorNetPerHour(a.ratePerHourCoins))}/hr',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ZineText.sub(size: 12),
                                )),
                              ]),
                            ])),
                            const SizedBox(width: 6),
                            PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 22, color: Zine.inkSoft),
                          ]),
                        );
                      },
                    ),
                  ),
      ),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: Zine.lilac,
                borderRadius: BorderRadius.circular(Zine.r),
                border: Zine.border,
                boxShadow: Zine.shadowSm,
              ),
              child: Center(child: PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.fill), size: 36, color: Zine.ink)),
            ),
            const SizedBox(height: 20),
            Text('Create your first AI vision agent', style: ZineText.hero(size: 26), textAlign: TextAlign.center),
            const SizedBox(height: 10),
            Text(
              'Pick a use-case template, give it a personality, choose a voice and vision overlay, set your rate — and publish. You earn 50% of every minute people train with it.',
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 14),
            ),
            const SizedBox(height: 20),
            ZineButton(
              label: 'Create an agent',
              variant: ZineButtonVariant.blue,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _create,
            ),
          ]),
        ),
      );
}
