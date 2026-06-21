/// Settings → "Ava AI" section — the "keep my memory on this phone" toggle.
///
/// ARCHITECTURE (2026-06-21): the on-device LLM (Cactus/LFM350M) was removed —
/// all of Ava's thinking is the cloud (Gemini 3) now. This toggle controls
/// whether your messages/notes are indexed into a PRIVATE on-device search index
/// (SQLite FTS5), so recall stays on your phone. No model download, instant.
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init].
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ava_local_mode.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../settings_registry.dart';

void registerOnDeviceSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_local',
      title: 'Ava AI',
      order: 5,
      builder: (context) => const _LocalAvaCard(),
    ),
  );
}

class _LocalAvaCard extends StatefulWidget {
  const _LocalAvaCard();
  @override
  State<_LocalAvaCard> createState() => _LocalAvaCardState();
}

class _LocalAvaCardState extends State<_LocalAvaCard> {
  final _mode = AvaLocalMode.I;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _mode.load();
  }

  Future<void> _activate() async {
    setState(() => _busy = true);
    await _mode.activate();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _disconnect() async {
    await _mode.disconnect();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: ValueListenableBuilder<bool>(
        valueListenable: _mode.enabled,
        builder: (context, on, _) {
          final (dotColor, label) = on
              ? (const Color(0xFF22A06B), 'On — your memory stays on this phone')
              : (Zine.inkMute, 'Off — Ava uses the cloud');
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.cpu(PhosphorIconsStyle.fill),
                    color: Zine.lilac,
                    size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Keep my memory on this phone',
                            style: ZineText.value(size: 14.5)),
                        const SizedBox(height: 3),
                        Row(children: [
                          Container(
                            width: 9,
                            height: 9,
                            decoration: BoxDecoration(
                                color: dotColor, shape: BoxShape.circle),
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child:
                                Text(label, style: ZineText.sub(size: 12)),
                          ),
                        ]),
                      ]),
                ),
              ]),
              const SizedBox(height: 10),
              Text(
                'When on, your messages and notes are indexed privately on this '
                'phone so Ava can recall them offline. Ava still thinks in the '
                'cloud for answers — only your data stays local.',
                style: ZineText.sub(size: 12),
              ),
              const SizedBox(height: 12),
              if (!on)
                ZineButton(
                  label: _busy ? 'Turning on…' : 'Keep memory on this phone',
                  onPressed: _busy ? null : _activate,
                  variant: ZineButtonVariant.lime,
                  fontSize: 14,
                )
              else
                ZineButton(
                  label: 'Turn off (use cloud only)',
                  onPressed: _disconnect,
                  variant: ZineButtonVariant.ghost,
                  fontSize: 14,
                ),
            ],
          );
        },
      ),
    );
  }
}
