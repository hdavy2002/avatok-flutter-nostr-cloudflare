
import '../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/campaigns_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

/// Campaign detail dashboard (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md) —
/// header (name/status/progress/spend), a filterable per-contact list, and
/// Pause/Resume/Cancel controls. Talks to [CampaignsApi.getCampaign] +
/// [CampaignsApi.listContacts] + the control-op methods.
///
/// Scaffold/AppBar/loading/error pattern mirrors `campaigns_home_screen.dart`
/// (inline dark v2 header, AD/ADText tokens) and the `_card`/`_button`
/// building blocks from `features/avatok/number_settings_screen.dart`.
///
/// NOT wired into the app router yet (AVA-CAMP-FL-DASH) — [onOpenInbox] and
/// [onOpenAnalytics] are left as optional callbacks for a later nav-wiring
/// pass; when null they fall back to a compile-safe "coming soon" SnackBar
/// so this screen never depends on a screen that doesn't exist yet.
class CampaignDetailScreen extends StatefulWidget {
  final String campaignId;
  final VoidCallback? onOpenInbox;
  final VoidCallback? onOpenAnalytics;

  const CampaignDetailScreen({
    super.key,
    required this.campaignId,
    this.onOpenInbox,
    this.onOpenAnalytics,
  });

  @override
  State<CampaignDetailScreen> createState() => _CampaignDetailScreenState();
}

enum _ContactFilter { all, answered, missed, pending }

class _CampaignDetailScreenState extends State<CampaignDetailScreen> {
  Campaign? _campaign;
  List<CampaignContactStat> _contacts = const [];
  bool _loading = true;
  String? _error;
  bool _busy = false; // pause/resume/cancel in flight
  _ContactFilter _filter = _ContactFilter.all;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final campaign = await CampaignsApi.getCampaign(widget.campaignId);
      final contacts = await CampaignsApi.listContacts(widget.campaignId);
      if (!mounted) return;
      setState(() {
        _campaign = campaign;
        _contacts = contacts;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      final msg = e is ApiException ? e.message : 'Could not load this campaign.';
      setState(() {
        _error = msg;
        _loading = false;
      });
    }
  }

  Future<void> _reload() => _load();

  // ------------------------------------------------------------- actions

  Future<void> _runOp(Future<String> Function() op, String successVerb) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await op();
      if (!mounted) return;
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: UiText(UiMessage.m_campaign_successverb_a969d67358, params: {'successVerb': (successVerb).toString()})));
    } catch (e) {
      if (!mounted) return;
      final msg = e is ApiException ? e.message : 'That action failed.';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _pause() => _runOp(() => CampaignsApi.pauseCampaign(widget.campaignId), 'paused');
  void _resume() => _runOp(() => CampaignsApi.resumeCampaign(widget.campaignId), 'resumed');

  Future<void> _cancel() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: UiText(UiMessage.m_cancel_this_campaign_7d1cba7c8d, style: ADText.threadName().copyWith(fontSize: 18)),
        content: UiText(
          UiMessage.m_this_stops_all_future_dialing_fe28beab24,
          style: ADText.preview(c: AD.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: UiText(UiMessage.m_back_76900f1bfd, style: ADText.rowName(c: AD.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: UiText(UiMessage.m_cancel_campaign_2edc287d49, style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _runOp(() => CampaignsApi.cancelCampaign(widget.campaignId), 'cancelled');
  }

  void _openInbox() {
    if (widget.onOpenInbox != null) {
      widget.onOpenInbox!();
      return;
    }
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: UiText(UiMessage.m_opening_the_thread_in_inbox_397c45afc9)));
  }

  void _openAnalytics() {
    if (widget.onOpenAnalytics != null) {
      widget.onOpenAnalytics!();
      return;
    }
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: UiText(UiMessage.m_campaign_analytics_is_coming_soon_ed9e59bd6d)));
  }

  // -------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _header(),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: AD.iconSearch));
    }
    if (_error != null) {
      return _errorState(_error!);
    }
    final c = _campaign;
    if (c == null) return _errorState('Campaign not found.');

    final filtered = _filteredContacts();
    return RefreshIndicator(
      color: AD.iconSearch,
      onRefresh: _reload,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(Msg.s5),
        children: [
          _headerCard(c),
          const SizedBox(height: Msg.s4),
          _actionRow(c),
          const SizedBox(height: Msg.s4),
          _shortcutRow(),
          const SizedBox(height: Msg.s4),
          UiText(UiMessage.m_contacts_b450645deb, style: ADText.sectionLabel()),
          const SizedBox(height: Msg.s3),
          _filterChips(),
          const SizedBox(height: Msg.s3),
          if (filtered.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: Msg.s5),
              child: Center(
                child: UiText(UiMessage.m_no_contacts_match_this_filter_041a8b5358,
                    style: ADText.preview(c: AD.textSecondary)),
              ),
            )
          else
            for (final contact in filtered) ...[
              _contactTile(contact),
              const SizedBox(height: Msg.s3),
            ],
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- header

  PreferredSizeWidget _header() {
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
            child: Row(children: [
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).maybePop(),
                child: Container(
                  width: 42, height: 42,
                  decoration: BoxDecoration(
                    color: AD.card,
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: Center(
                    child: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                        size: 20, color: AD.textPrimary),
                  ),
                ),
              ),
              const SizedBox(width: Msg.s4),
              Expanded(
                child: Text(_campaign?.name.isNotEmpty == true ? _campaign!.name : uiCopy(UiMessage.m_campaign_268286d2ef),
                    style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- states

  Widget _errorState(String message) {
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(Msg.s6),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.warningCircle(PhosphorIconsStyle.duotone),
                    size: 48, color: AD.danger),
                const SizedBox(height: Msg.s4),
                Text(message, textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary)),
                const SizedBox(height: Msg.s4),
                _retryButton(),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _retryButton() {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _load,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brMd,
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold), size: 16, color: AD.textPrimary),
          const SizedBox(width: Msg.s2),
          UiText(UiMessage.m_retry_942087cc2d, style: ADText.rowName()),
        ]),
      ),
    );
  }

  // ---------------------------------------------------------------- header card

  Widget _headerCard(Campaign c) {
    final total = c.nTotal;
    final done = c.nDone;
    final pct = total <= 0 ? 0.0 : (done / total).clamp(0.0, 1.0);
    final spendCap = c.spendCapTokens; // 0 means "no cap set" — guard divide-by-zero
    final spent = c.tokensSpent;
    final spendPct = spendCap <= 0 ? null : (spent / spendCap).clamp(0.0, 1.0);

    return Container(
      padding: const EdgeInsets.all(Msg.s4),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text(c.name.isEmpty ? uiCopy(UiMessage.m_untitled_campaign_ed0fd179f1) : c.name,
                style: ADText.threadName().copyWith(fontSize: 19),
                maxLines: 2, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: Msg.s2),
          _statusChip(c.status),
        ]),
        if (c.goalText.isNotEmpty) ...[
          const SizedBox(height: Msg.s2),
          Text(c.goalText, style: ADText.preview(c: AD.textSecondary),
              maxLines: 2, overflow: TextOverflow.ellipsis),
        ],
        const SizedBox(height: Msg.s4),
        UiText(UiMessage.m_progress_4664827f8e, style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s2),
        ClipRRect(
          borderRadius: BorderRadius.circular(Msg.rSm),
          child: LinearProgressIndicator(
            value: pct,
            minHeight: 8,
            backgroundColor: AD.borderControl,
            valueColor: const AlwaysStoppedAnimation<Color>(AD.online),
          ),
        ),
        const SizedBox(height: Msg.s2),
        Row(children: [
          Expanded(
            child: UiText(UiMessage.m_done_of_total_called_0da8592db0, params: {'done': (done).toString(), 'total': (total).toString()}, style: ADText.preview(c: AD.textSecondary)),
          ),
          UiText(UiMessage.m_value1_answered_value2_missed_2a12b28b6a, params: {'value1': (c.nAnswered).toString(), 'value2': (c.nMissed).toString()},
              style: ADText.statCaption(c: AD.textTertiary)),
        ]),
        const SizedBox(height: Msg.s4),
        UiText(UiMessage.m_spend_85f3d558db, style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s2),
        if (spendPct != null) ...[
          ClipRRect(
            borderRadius: BorderRadius.circular(Msg.rSm),
            child: LinearProgressIndicator(
              value: spendPct,
              minHeight: 8,
              backgroundColor: AD.borderControl,
              valueColor: AlwaysStoppedAnimation<Color>(
                  spendPct >= 1.0 ? AD.danger : AD.iconBell),
            ),
          ),
          const SizedBox(height: Msg.s2),
          Row(children: [
            PhosphorIcon(PhosphorIcons.coin(PhosphorIconsStyle.bold), size: 13, color: AD.textTertiary),
            const SizedBox(width: Msg.s1),
            UiText(UiMessage.m_spent_of_spendcap_tokens_spent_732e6da5ac, params: {'spent': (spent).toString(), 'spendCap': (spendCap).toString()},
                style: ADText.statCaption(c: AD.textTertiary)),
          ]),
        ] else ...[
          Row(children: [
            PhosphorIcon(PhosphorIcons.coin(PhosphorIconsStyle.bold), size: 13, color: AD.textTertiary),
            const SizedBox(width: Msg.s1),
            UiText(UiMessage.m_spent_tokens_spent_no_cap_4649791991, params: {'spent': (spent).toString()},
                style: ADText.statCaption(c: AD.textTertiary)),
          ]),
        ],
      ]),
    );
  }

  Widget _statusChip(String status) {
    Color color;
    switch (status) {
      case 'running':
        color = AD.online;
        break;
      case 'paused':
        color = AD.outgoingCall;
        break;
      case 'completed':
        color = AD.textTertiary;
        break;
      case 'draft':
        color = AD.iconSearch;
        break;
      case 'out_of_tokens':
      case 'cancelled':
        color = AD.danger;
        break;
      default:
        color = AD.outgoingCall; // ready/pausing/cancelling/window_wait
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(AD.rChip),
        border: Border.all(color: color.withValues(alpha: 0.4), width: 1),
      ),
      child: Text(status.replaceAll('_', ' '), style: ADText.statCaption(c: color)),
    );
  }

  // ---------------------------------------------------------------- actions

  Widget _actionRow(Campaign c) {
    final canPause = c.status == 'running';
    final canResume = c.status == 'paused';
    final canCancel = !['completed', 'cancelled', 'cancelling'].contains(c.status);
    return Row(children: [
      Expanded(
        child: _actionButton(
          label: uiCopy(UiMessage.m_pause_858e4ba7a2),
          icon: PhosphorIcons.pause(PhosphorIconsStyle.bold),
          onPressed: _busy || !canPause ? null : _pause,
        ),
      ),
      const SizedBox(width: Msg.s3),
      Expanded(
        child: _actionButton(
          label: uiCopy(UiMessage.m_resume_d640c7421d),
          icon: PhosphorIcons.play(PhosphorIconsStyle.bold),
          onPressed: _busy || !canResume ? null : _resume,
        ),
      ),
      const SizedBox(width: Msg.s3),
      Expanded(
        child: _actionButton(
          label: uiCopy(UiMessage.m_cancel_19766ed6cc),
          icon: PhosphorIcons.xCircle(PhosphorIconsStyle.bold),
          danger: true,
          onPressed: _busy || !canCancel ? null : _cancel,
        ),
      ),
    ]);
  }

  Widget _actionButton({
    required String label,
    required IconData icon,
    required VoidCallback? onPressed,
    bool danger = false,
  }) {
    final disabled = onPressed == null;
    final fg = disabled ? AD.textTertiary : (danger ? AD.danger : AD.textPrimary);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onPressed,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: Msg.s3),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brMd,
          border: Border.all(color: disabled ? AD.borderControl : (danger ? AD.danger.withValues(alpha: 0.4) : AD.borderControl), width: 1),
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(icon, size: 18, color: fg),
          const SizedBox(height: Msg.s1),
          Text(label, style: ADText.statCaption(c: fg)),
        ]),
      ),
    );
  }

  Widget _shortcutRow() {
    return Row(children: [
      Expanded(
        child: _shortcutButton(
          label: uiCopy(UiMessage.m_open_thread_in_inbox_fa127b9229),
          icon: PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold),
          onTap: _openInbox,
        ),
      ),
      const SizedBox(width: Msg.s3),
      Expanded(
        child: _shortcutButton(
          label: uiCopy(UiMessage.m_open_analytics_ecf8bb4e41),
          icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
          onTap: _openAnalytics,
        ),
      ),
    ]);
  }

  Widget _shortcutButton({required String label, required IconData icon, required VoidCallback onTap}) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(icon, size: 16, color: AD.iconSearch),
          const SizedBox(width: Msg.s2),
          Flexible(
            child: Text(label, style: ADText.rowName().copyWith(fontSize: 13),
                maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
        ]),
      ),
    );
  }

  // ---------------------------------------------------------------- contacts

  List<CampaignContactStat> _filteredContacts() {
    switch (_filter) {
      case _ContactFilter.all:
        return _contacts;
      case _ContactFilter.answered:
        // "done" is the terminal success state (spec §3/§6.2 status enum);
        // missed/busy/voicemail/failed/etc. are their own terminal states.
        return _contacts.where((c) => c.status == 'done').toList();
      case _ContactFilter.missed:
        return _contacts.where((c) => const {'missed', 'busy', 'voicemail', 'failed'}.contains(c.status)).toList();
      case _ContactFilter.pending:
        return _contacts.where((c) => const {'pending', 'dial_reserved', 'calling'}.contains(c.status)).toList();
    }
  }

  Widget _filterChips() {
    final entries = <(_ContactFilter, String)>[
      (_ContactFilter.all, 'All'),
      (_ContactFilter.answered, 'Answered'),
      (_ContactFilter.missed, 'Missed'),
      (_ContactFilter.pending, 'Pending'),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final e in entries) ...[
            _filterChip(e.$1, e.$2),
            const SizedBox(width: Msg.s2),
          ],
        ],
      ),
    );
  }

  Widget _filterChip(_ContactFilter f, String label) {
    final active = _filter == f;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() => _filter = f),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
        decoration: BoxDecoration(
          color: active ? AD.primaryBadge.withValues(alpha: 0.16) : AD.card,
          borderRadius: Msg.brPill,
          border: Border.all(
              color: active ? AD.primaryBadge.withValues(alpha: 0.5) : AD.borderControl, width: 1),
        ),
        child: Text(label,
            style: ADText.statCaption(c: active ? AD.primaryBadge : AD.textSecondary)),
      ),
    );
  }

  Widget _contactTile(CampaignContactStat contact) {
    final name = (contact.name ?? '').isNotEmpty ? contact.name! : (contact.e164 ?? 'Unknown contact');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, style: ADText.rowName(), maxLines: 1, overflow: TextOverflow.ellipsis),
            if (contact.e164 != null && contact.e164!.isNotEmpty && name != contact.e164) ...[
              const SizedBox(height: 2),
              Text(contact.e164!, style: ADText.preview(c: AD.textSecondary)),
            ],
            const SizedBox(height: Msg.s1),
            UiText(
              UiMessage.m_attempts_value1_value2_dd50c6da1d, params: {'value1': (contact.attempts).toString(), 'value2': ((contact.lastOutcome ?? '').isNotEmpty ? ' · ${contact.lastOutcome}' : '').toString()},
              style: ADText.statCaption(c: AD.textTertiary),
            ),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        _contactStatusChip(contact.status),
      ]),
    );
  }

  Widget _contactStatusChip(String status) {
    Color color;
    switch (status) {
      case 'done':
        color = AD.online;
        break;
      case 'calling':
      case 'dial_reserved':
        color = AD.iconSearch;
        break;
      case 'missed':
      case 'busy':
      case 'voicemail':
      case 'failed':
      case 'invalid':
      case 'dnd_blocked':
        color = AD.danger;
        break;
      default:
        color = AD.textTertiary; // pending
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(AD.rChip),
        border: Border.all(color: color.withValues(alpha: 0.4), width: 1),
      ),
      child: Text(status.replaceAll('_', ' '), style: ADText.statCaption(c: color)),
    );
  }
}
