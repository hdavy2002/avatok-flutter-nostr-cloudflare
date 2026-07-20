import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../campaigns/campaign_analytics_screen.dart';
import '../../campaigns/campaigns_home_screen.dart';
import '../settings_registry.dart';

/// Settings → "Campaigns" section (AVA-CAMP-FL-NAV — Specs/
/// OUTBOUND-AI-CALLING-CAMPAIGNS.md). Two entries next to Ava Receptionist:
/// "Campaigns" opens [CampaignsHomeScreen] (list + create), "Analytics" opens
/// [CampaignAnalyticsScreen] (account-wide rollup). Mirrors the single-card,
/// two-row layout `tools_section.dart` uses for "Tools & connectors" —
/// [AdCard] + [ZineIconBadge] + trailing caret, same [ADText]/[AD] tokens.
///
/// Entirely gated on [RemoteConfig.campaignsEnabled] — hidden when the flag
/// is off, same `visible: () => ...` mechanism `business_agent_section.dart`
/// uses for [RemoteConfig.voiceAgent] (never render a tile that opens a
/// disabled backend). Registered via [SettingsSectionRegistry] from
/// [AvaBootstrap.init] — never by editing settings_screen.dart.
void registerCampaignsSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_campaigns',
      title: 'Campaigns',
      order: 26, // just below Ava Receptionist (24) / Business Agent (25)
      visible: () => RemoteConfig.campaignsEnabled,
      builder: (context) => const _CampaignsCard(),
    ),
  );
}

class _CampaignsCard extends StatelessWidget {
  const _CampaignsCard();

  @override
  Widget build(BuildContext context) {
    return AdCard(
      padding: const EdgeInsets.all(4),
      child: Column(children: [
        _row(
          context,
          icon: PhosphorIcons.megaphone(PhosphorIconsStyle.fill),
          iconColor: AD.iconVideo,
          title: 'Campaigns',
          subtitle: 'Launch and manage outbound AI-calling campaigns.',
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const CampaignsHomeScreen()),
          ),
        ),
        const Divider(color: AD.borderHairline, height: 1),
        _row(
          context,
          icon: PhosphorIcons.chartBar(PhosphorIconsStyle.fill),
          iconColor: AD.iconSearch,
          title: 'Analytics',
          subtitle: 'Account-wide campaign performance and spend.',
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const CampaignAnalyticsScreen()),
          ),
        ),
      ]),
    );
  }

  Widget _row(
    BuildContext context, {
    required IconData icon,
    required Color iconColor,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: iconColor, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName()),
              const SizedBox(height: 2),
              Text(subtitle, style: ADText.preview()),
            ]),
          ),
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 18, color: AD.textSecondary),
        ]),
      ),
    );
  }
}
