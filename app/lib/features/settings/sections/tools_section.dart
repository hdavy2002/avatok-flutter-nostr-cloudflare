
import '../../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avaapps/avaapps_screen.dart';
import '../settings_registry.dart';
import '../../../core/ui/messenger_theme.dart';

/// Settings → "Tools & connectors" section. A single row that opens
/// [AvaAppsScreen], where the user connects their own Google accounts
/// (Gmail, Drive, Calendar, …) for Ava to use via Composio. Subscription
/// connectors carry a PaidBadge in that screen.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init] (the one
/// sanctioned bootstrap append) — never by editing settings_screen.dart.
void registerToolsSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_tools',
      title: uiCopy(UiMessage.m_tools_connectors_1104df0496),
      order: 30, // below Focus mode / Ava AI, near the other Ava sections
      builder: (context) => const _ToolsCard(),
    ),
  );
}

class _ToolsCard extends StatelessWidget {
  const _ToolsCard();

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return AdCard(
      padding: const EdgeInsets.all(4),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const AvaAppsScreen()),
      ),
      child: Padding(
        padding: const EdgeInsets.all(Msg.s3),
        child: Row(children: [
          ZineIconBadge(
            icon: PhosphorIcons.plugs(PhosphorIconsStyle.fill),
            color: AD.iconVideo,
            size: 36,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              UiText(UiMessage.m_connect_ava_to_your_tools_6235a0e922, style: ADText.rowName()),
              const SizedBox(height: 2),
              UiText(
                UiMessage.m_link_gmail_drive_and_more_ef1492d739,
                style: ADText.preview(),
              ),
            ]),
          ),
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 18, color: AD.textSecondary),
        ]),
      ),
    );
  }
}
