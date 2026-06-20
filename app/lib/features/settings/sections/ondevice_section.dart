/// Settings → "Ava on-device" section (Phase A — step 1: prove Qwen3-0.6B).
///
/// A simple, FREE entry point that opens the on-device test harness
/// ([AvaOnDeviceTestScreen]) where Qwen3-0.6B runs fully offline via Cactus.
/// This is a developer/QA surface for the first on-device slice — it does NOT
/// gate or change the existing server Ava chat. Registered via
/// [SettingsSectionRegistry] from [AvaBootstrap.init] (`registerOnDeviceSection()`).
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../ava_ondevice/ava_ondevice_test_screen.dart';
import '../settings_registry.dart';

void registerOnDeviceSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_ondevice',
      title: 'Ava on-device',
      order: 5, // near the top — easy to find while testing
      builder: (context) => const _OnDeviceCard(),
    ),
  );
}

class _OnDeviceCard extends StatelessWidget {
  const _OnDeviceCard();

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: InkWell(
        borderRadius: BorderRadius.circular(Zine.rSm),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const AvaOnDeviceTestScreen()),
        ),
        child: Row(
          children: [
            ZineIconBadge(
              icon: PhosphorIcons.cpu(PhosphorIconsStyle.fill),
              color: Zine.lime,
              size: 36,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Text('Run Ava on-device', style: ZineText.value(size: 14.5)),
                    const SizedBox(width: 8),
                    ZineChip(label: 'BETA'),
                  ]),
                  const SizedBox(height: 2),
                  Text(
                    'Test Qwen3-0.6B running privately on this phone — works '
                    'offline. First open downloads the model (≈400 MB).',
                    style: ZineText.sub(size: 12),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Icon(PhosphorIcons.caretRight(), size: 18, color: Zine.ink),
          ],
        ),
      ),
    );
  }
}
