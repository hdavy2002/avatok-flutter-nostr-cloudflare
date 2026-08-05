import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavision_api.dart';
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
        backgroundColor: AD.overlaySheet,
        builder: (s) => SafeArea(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ListTile(
                    leading: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), color: AD.textPrimary),
                    title: Text('Edit agent', style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
                    onTap: () {
                      Navigator.pop(s);
                      _edit(a);
                    }),
                ListTile(
                    leading: PhosphorIcon(PhosphorIcons.chartLineUp(PhosphorIconsStyle.bold), color: AD.textPrimary),
                    title: Text('Dashboard & earnings', style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
                    onTap: () {
                      Navigator.pop(s);
                      Navigator.push(context, MaterialPageRoute(builder: (_) => AgentDashboardScreen(agent: a)));
                    }),
                if (a.status == 'draft')
                  ListTile(
                      leading: PhosphorIcon(PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold), color: AD.online),
                      title: Text('Publish to marketplace', style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
                      onTap: () {
                        Navigator.pop(s);
                        _act(a, 'publish');
                      }),
                if (a.status == 'published')
                  ListTile(
                      leading: PhosphorIcon(PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold), color: AD.textPrimary),
                      title: Text('Unpublish (back to draft)', style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
                      onTap: () {
                        Navigator.pop(s);
                        _act(a, 'unpublish');
                      }),
                ListTile(
                    leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: AD.danger),
                    title: Text('Delete agent', style: ADText.rowName(c: AD.danger).copyWith(fontSize: 15, height: 1.3)),
                    onTap: () async {
                      Navigator.pop(s);
                      final ok = await showDialog<bool>(
                          context: context,
                          builder: (d) => AlertDialog(
                                backgroundColor: AD.card,
                                title: Text('Delete ${a.name}?', style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
                                content: Text(
                                    'Its listing, knowledge files and availability are removed. Past earnings are kept in your ledger.',
                                    style: ADText.preview().copyWith(fontSize: 14, height: 1.42)),
                                actions: [
                                  TextButton(
                                      onPressed: () => Navigator.pop(d, false),
                                      child: Text('Keep', style: ADText.tabLabel(c: AD.textSecondary).copyWith(fontSize: 13, letterSpacing: 0.52))),
                                  TextButton(
                                      onPressed: () => Navigator.pop(d, true),
                                      child: Text('Delete', style: ADText.tabLabel(c: AD.danger).copyWith(fontSize: 13, letterSpacing: 0.52))),
                                ],
                              ));
                      if (ok == true) _act(a, 'delete');
                    }),
              ]),
            ));
  }

  Color _statusColor(String s) => switch (s) {
        'published' => AD.online,
        'suspended' => AD.danger,
        _ => AD.card,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ZineAppBar(
        title: 'My vision agents',
        markWord: 'vision',
        tag: 'AvaVision studio',
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
            ? const Center(child: CircularProgressIndicator(color: AD.tabCalls))
            : _agents.isEmpty
                ? _empty()
                : RefreshIndicator(
                    color: AD.tabGroups,
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
                          radius: BorderRadius.circular(Msg.rLg),
                          boxShadow: Msg.none,
                          padding: const EdgeInsets.all(12),
                          child: Row(children: [
                            Avatar(seed: a.id, name: a.name, size: 52, avatarUrl: a.avatarUrl),
                            const SizedBox(width: 12),
                            Expanded(
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(a.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ADText.rowName().copyWith(fontSize: 15, height: 1.3, fontWeight: FontWeight.w600)),
                              const SizedBox(height: Msg.s1),
                              Row(children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
                                  decoration: BoxDecoration(
                                    color: _statusColor(a.status),
                                    borderRadius: BorderRadius.circular(Msg.rPill),
                                    border: Border.all(color: AD.borderControl, width: 1),
                                  ),
                                  child: Text(_sentence(a.status),
                                      style: ADText.tabLabel(c: suspended ? Colors.white : AD.textPrimary).copyWith(fontSize: 10, letterSpacing: 0.4)),
                                ),
                                const SizedBox(width: Msg.s1),
                                CapabilityBadge(a.capability),
                                const SizedBox(width: Msg.s1),
                                Flexible(
                                    child: Text(
                                  a.isFreeForCallers
                                      ? 'Free · you pay ${fmtCoins(kCreatorPaysRateCoinsPerHour)}/hr'
                                      : '${fmtCoins(a.ratePerHourCoins)}/hr · earn ${fmtCoins(creatorNetPerHour(a.ratePerHourCoins))}/hr',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ADText.preview().copyWith(fontSize: 12, height: 1.42),
                                )),
                              ]),
                            ])),
                            const SizedBox(width: Msg.s1),
                            PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 22, color: AD.textSecondary),
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
          padding: const EdgeInsets.all(Msg.s6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: AD.tabCalls,
                borderRadius: BorderRadius.circular(Msg.rLg),
                border: Border.all(color: AD.borderControl, width: 1),
                boxShadow: Msg.none,
              ),
              child: Center(child: PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.fill), size: 36, color: Colors.white)),
            ),
            const SizedBox(height: Msg.s4),
            Text('Create your first AI vision agent', style: ADText.appTitle().copyWith(fontSize: 26, height: 1.08, letterSpacing: -0.52), textAlign: TextAlign.center),
            const SizedBox(height: Msg.s2),
            Text(
              'Pick a use-case template, give it a personality, choose a voice and vision overlay, set your rate — and publish. You earn 50% of every minute people train with it.',
              textAlign: TextAlign.center,
              style: ADText.preview().copyWith(fontSize: 14, height: 1.42),
            ),
            const SizedBox(height: Msg.s4),
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

/// Sentence case for a display label. Replaces the `.toUpperCase()` the legacy
/// zine stickers applied to everything; call sites pass lowercase strings, so
/// simply dropping the transform would render them lowercase.
String _sentence(String s) =>
    s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
