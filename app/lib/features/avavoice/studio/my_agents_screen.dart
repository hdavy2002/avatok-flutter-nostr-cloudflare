
import '../../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/avatar.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/ui/zine_widgets.dart';
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
            ? uiCopy(UiMessage.m_value1_is_live_in_the_40e2328a51, {'value1': (a.name).toString()})
            : (r['detail']?.toString() ?? r['error']?.toString() ?? uiCopy(UiMessage.m_publish_failed_2fe0dacea2)));
      case 'unpublish':
        _snack(await AvaVoiceApi.unpublish(a.id)
            ? uiCopy(UiMessage.m_removed_from_the_marketplace_6bae5904d4) : uiCopy(UiMessage.m_failed_031a8f0f65));
      case 'delete':
        _snack(await AvaVoiceApi.deleteAgent(a.id) ? uiCopy(UiMessage.m_deleted_b48ff39c2e) : uiCopy(UiMessage.m_failed_031a8f0f65));
    }
    _load();
  }

  void _menu(VoiceAgent a) {
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet, builder: (s) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(
            leading: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), color: AD.textPrimary),
            title: UiText(UiMessage.m_edit_agent_6ff5e7a947, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
            onTap: () { Navigator.pop(s); _edit(a); }),
        ListTile(
            leading: PhosphorIcon(PhosphorIcons.chartLineUp(PhosphorIconsStyle.bold), color: AD.textPrimary),
            title: UiText(UiMessage.m_dashboard_earnings_b920d2c900, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
            onTap: () { Navigator.pop(s); Navigator.push(context,
                MaterialPageRoute(builder: (_) => AgentDashboardScreen(agent: a))); }),
        if (a.status == 'draft')
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold), color: AD.online),
              title: UiText(UiMessage.m_publish_to_marketplace_de33ec5ca3, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
              onTap: () { Navigator.pop(s); _act(a, 'publish'); }),
        if (a.status == 'published')
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold), color: AD.textPrimary),
              title: UiText(UiMessage.m_unpublish_back_to_draft_b5d2e80da2, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
              onTap: () { Navigator.pop(s); _act(a, 'unpublish'); }),
        ListTile(
            leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: AD.danger),
            title: UiText(UiMessage.m_delete_agent_602cc4da98, style: ADText.rowName(c: AD.danger).copyWith(fontSize: 15, height: 1.3)),
            onTap: () async {
              Navigator.pop(s);
              final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
                backgroundColor: AD.card,
                title: UiText(UiMessage.m_delete_value1_073bfafa85, params: {'value1': (a.name).toString()}, style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
                content: UiText(UiMessage.m_its_listing_knowledge_files_and_3a7f498fe0,
                    style: ADText.preview().copyWith(fontSize: 14, height: 1.42)),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(d, false),
                      child: UiText(UiMessage.m_keep_183f00f483, style: ADText.tabLabel(c: AD.textSecondary).copyWith(fontSize: 13, letterSpacing: 0.52))),
                  TextButton(onPressed: () => Navigator.pop(d, true),
                      child: UiText(UiMessage.m_delete_e2d0a54968, style: ADText.tabLabel(c: AD.danger).copyWith(fontSize: 13, letterSpacing: 0.52))),
                ],
              ));
              if (ok == true) _act(a, 'delete');
            }),
      ]),
    ));
  }

  // Status pill fill (zine poster colors).
  Color _statusColor(String s) => switch (s) {
        'published' => AD.online,
        'suspended' => AD.danger,
        _ => AD.card,
      };

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      appBar: ZineAppBar(
        title: uiCopy(UiMessage.m_my_voice_agents_a07149d211),
        markWord: 'voice',
        tag: 'AvaVoice studio',
        showBack: Navigator.of(context).canPop(),
      ),
      floatingActionButton: ZineButton(
        label: uiCopy(UiMessage.m_new_agent_98a23e6db3),
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
                            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis,
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
                                const SizedBox(width: 8),
                                Flexible(child: Text(
                                  a.isFreeForCallers
                                      ? uiCopy(UiMessage.m_free_to_callers_you_pay_149f5c8d27, {'value1': (fmtTokens(kCreatorPaysRateTokensPerHour)).toString()})
                                      : uiCopy(UiMessage.m_value1_hr_you_earn_value2_51b437afc3, {'value1': (fmtTokens(a.ratePerHourTokens)).toString(), 'value2': (fmtTokens(creatorNetPerHour(a.ratePerHourTokens))).toString()}),
                                  maxLines: 1, overflow: TextOverflow.ellipsis,
                                  style: ADText.preview().copyWith(fontSize: 12, height: 1.42),
                                )),
                              ]),
                            ])),
                            const SizedBox(width: Msg.s1),
                            PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold),
                                size: 22, color: AD.textSecondary),
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
              width: 72, height: 72,
              decoration: BoxDecoration(
                color: AD.tabCalls,
                borderRadius: BorderRadius.circular(Msg.rLg),
                border: Border.all(color: AD.borderControl, width: 1),
                boxShadow: Msg.none,
              ),
              child: Center(child: PhosphorIcon(PhosphorIcons.robot(PhosphorIconsStyle.fill), size: 36, color: Colors.white)),
            ),
            const SizedBox(height: Msg.s4),
            UiText(UiMessage.m_create_your_first_ai_voice_6ee7bad368,
                style: ADText.appTitle().copyWith(fontSize: 26, height: 1.08, letterSpacing: 0.52), textAlign: TextAlign.center),
            const SizedBox(height: Msg.s2),
            UiText(
              UiMessage.m_give_it_a_name_a_38bef2d3ee,
              textAlign: TextAlign.center,
              style: ADText.preview().copyWith(fontSize: 14, height: 1.42),
            ),
            const SizedBox(height: Msg.s4),
            ZineButton(
              label: uiCopy(UiMessage.m_create_an_agent_04a077f349),
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
