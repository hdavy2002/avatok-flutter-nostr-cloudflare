import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../ava_tools/mcp_connect_screen.dart';
import '../settings_registry.dart';

/// Settings → "Tools & connectors" section (Phase 5 — Tool Layer). A single
/// row that opens [McpConnectScreen], where the user connects their own
/// accounts (Gmail, Drive, …) for Ava to use via the self-hosted Strata MCP
/// gateway. Subscription connectors carry a PaidBadge in that screen.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init] (the one
/// sanctioned bootstrap append) — never by editing settings_screen.dart.
void registerToolsSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_tools',
      title: 'Tools & connectors',
      order: 30, // below Focus mode / Ava AI, near the other Ava sections
      builder: (context) => const _ToolsCard(),
    ),
  );
}

class _ToolsCard extends StatelessWidget {
  const _ToolsCard();

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(4),
      boxShadow: Zine.shadowXs,
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const McpConnectScreen()),
      ),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(children: [
          ZineIconBadge(
            icon: PhosphorIcons.plugs(PhosphorIconsStyle.fill),
            color: Zine.lilac,
            size: 36,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Connect Ava to your tools', style: ZineText.value(size: 14.5)),
              const SizedBox(height: 2),
              Text(
                'Link Gmail, Drive and more so Ava can act for you. Your tokens '
                'stay private to this account.',
                style: ZineText.sub(size: 12),
              ),
            ]),
          ),
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
        ]),
      ),
    );
  }
}
