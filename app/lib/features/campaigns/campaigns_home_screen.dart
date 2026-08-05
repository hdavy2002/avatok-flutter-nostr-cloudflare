import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/campaigns_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'campaign_analytics_screen.dart' show CampaignAnalyticsCards;
import 'campaign_detail_screen.dart';
import 'campaign_wizard_screen.dart';

/// Campaigns home — lists the caller's outbound AI-calling campaigns
/// (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md). Talks to [CampaignsApi.listCampaigns].
///
/// Scaffold/AppBar/loading/error/empty-state pattern mirrors
/// `features/avatok/number_settings_screen.dart` (inline dark v2 header,
/// AD/ADText tokens, `_card`/`_button` building blocks) and the
/// RefreshIndicator + FutureBuilder pattern from
/// `features/avaapps/avaapps_screen.dart`.
///
/// [AVA-CAMP-FL-NAV] Wired into Settings → Campaigns (see
/// features/settings/sections/campaigns_section.dart). The FAB opens
/// [CampaignWizardScreen] and a tile opens [CampaignDetailScreen] for real
/// (originally left as compile-safe TODOs in AVA-CAMP-FL-HOME, before those
/// screens existed).
class CampaignsHomeScreen extends StatefulWidget {
  const CampaignsHomeScreen({super.key});
  @override
  State<CampaignsHomeScreen> createState() => _CampaignsHomeScreenState();
}

class _CampaignsHomeScreenState extends State<CampaignsHomeScreen> {
  late Future<List<Campaign>> _future;

  @override
  void initState() {
    super.initState();
    _future = CampaignsApi.listCampaigns();
  }

  Future<void> _refresh() async {
    final next = CampaignsApi.listCampaigns();
    // Await before swapping so RefreshIndicator's spinner tracks the real
    // fetch, and surface any failure back into the FutureBuilder below.
    setState(() => _future = next);
    try {
      await next;
    } catch (_) {/* surfaced by the FutureBuilder's error branch */}
  }

  // [AVA-CAMP-FL-NAV] campaign_wizard_screen.dart now exists — wired for real.
  void _openWizard() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => const CampaignWizardScreen(),
    )).then((_) => _refresh());
  }

  // [AVA-CAMP-FL-NAV] campaign_detail_screen.dart now exists — wired for real.
  void _openDetail(Campaign c) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CampaignDetailScreen(
        campaignId: c.id,
        onOpenAnalytics: () => _openAnalyticsFor(c.id),
      ),
    )).then((_) => _refresh());
  }

  // [AVA-CAMP-FL-NAV] Per-campaign analytics shortcut for
  // CampaignDetailScreen's "Open analytics" row — wraps the already-built
  // CampaignAnalyticsCards (campaign_analytics_screen.dart) in a minimal
  // scaffold matching this screen's own `_header` styling, since
  // CampaignAnalyticsScreen itself is the account-wide rollup (no
  // campaignId), not the per-campaign view.
  void _openAnalyticsFor(String campaignId) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          foregroundColor: AD.textPrimary,
          title: Text('Campaign analytics', style: ADText.appTitle()),
        ),
        body: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(Msg.s5),
            child: CampaignAnalyticsCards(campaignId: campaignId),
          ),
        ),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _header(title: 'Campaigns'),
      body: SafeArea(
        child: FutureBuilder<List<Campaign>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator(color: AD.iconSearch));
            }
            if (snap.hasError) {
              final msg = snap.error is ApiException
                  ? (snap.error as ApiException).message
                  : 'Could not load campaigns.';
              return _errorState(msg);
            }
            final campaigns = snap.data ?? const <Campaign>[];
            if (campaigns.isEmpty) return _emptyState();
            return RefreshIndicator(
              color: AD.iconSearch,
              onRefresh: _refresh,
              child: ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(Msg.s5),
                itemCount: campaigns.length,
                separatorBuilder: (_, __) => const SizedBox(height: Msg.s3),
                itemBuilder: (_, i) => _campaignTile(campaigns[i]),
              ),
            );
          },
        ),
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: AD.primaryBadge,
        foregroundColor: Colors.white,
        onPressed: _openWizard,
        child: Icon(PhosphorIcons.plus(PhosphorIconsStyle.bold)),
      ),
    );
  }

  /// Inline dark v2 header — mirrors number_settings_screen.dart's `_header`.
  PreferredSizeWidget _header({required String title}) {
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
                child: Text(title, style: ADText.appTitle(),
                    maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- states

  Widget _emptyState() {
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(Msg.s6),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.megaphone(PhosphorIconsStyle.duotone),
                    size: 48, color: AD.textTertiary),
                const SizedBox(height: Msg.s4),
                Text('No campaigns yet — tap + to create one',
                    textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary)),
              ]),
            ),
          ),
        ),
      ),
    );
  }

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
      onTap: () => setState(() => _future = CampaignsApi.listCampaigns()),
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
          Text('Retry', style: ADText.rowName()),
        ]),
      ),
    );
  }

  // ---------------------------------------------------------------- tile

  Widget _campaignTile(Campaign c) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _openDetail(c),
      child: Container(
        padding: const EdgeInsets.all(Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderCard, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text(c.name.isEmpty ? 'Untitled campaign' : c.name,
                  style: ADText.rowName().copyWith(fontSize: 16),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
            const SizedBox(width: Msg.s2),
            _statusChip(c.status),
          ]),
          const SizedBox(height: Msg.s3),
          _progressBar(c),
          const SizedBox(height: Msg.s2),
          Row(children: [
            Expanded(
              child: Text('${c.nDone} of ${c.nTotal} called',
                  style: ADText.preview(c: AD.textSecondary)),
            ),
            Text('${c.nAnswered} answered',
                style: ADText.statCaption(c: AD.textTertiary)),
          ]),
          const SizedBox(height: Msg.s1),
          Row(children: [
            PhosphorIcon(PhosphorIcons.coin(PhosphorIconsStyle.bold), size: 13, color: AD.textTertiary),
            const SizedBox(width: Msg.s1),
            Text('${c.tokensSpent} tokens spent', style: ADText.statCaption(c: AD.textTertiary)),
          ]),
        ]),
      ),
    );
  }

  Widget _progressBar(Campaign c) {
    final pct = c.nTotal <= 0 ? 0.0 : (c.nDone / c.nTotal).clamp(0.0, 1.0);
    return ClipRRect(
      borderRadius: BorderRadius.circular(Msg.rSm),
      child: LinearProgressIndicator(
        value: pct,
        minHeight: 6,
        backgroundColor: AD.borderControl,
        valueColor: const AlwaysStoppedAnimation<Color>(AD.online),
      ),
    );
  }

  /// Status → color mapping: running=green, paused=amber, completed=grey,
  /// draft=blue, out_of_tokens/cancelled=red — everything else (ready,
  /// pausing, cancelling, window_wait) falls back to amber as an
  /// "in transition" hint.
  Widget _statusChip(String status) {
    Color color;
    switch (status) {
      case 'running':
        color = AD.online;
        break;
      case 'paused':
        color = AD.outgoingCall; // amber
        break;
      case 'completed':
        color = AD.textTertiary; // grey
        break;
      case 'draft':
        color = AD.iconSearch; // blue
        break;
      case 'out_of_tokens':
      case 'cancelled':
        color = AD.danger; // red
        break;
      default:
        color = AD.outgoingCall; // amber — ready/pausing/cancelling/window_wait
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(AD.rChip),
        border: Border.all(color: color.withValues(alpha: 0.4), width: 1),
      ),
      child: Text(
        status.replaceAll('_', ' '),
        style: ADText.statCaption(c: color),
      ),
    );
  }
}
