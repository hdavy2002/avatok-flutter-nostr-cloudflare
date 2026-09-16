/// Settings → "Ava AI" section — the "keep my memory on this phone" toggle.
///
/// ARCHITECTURE (2026-06-21): the on-device LLM (Cactus/LFM350M) was removed —
/// all of Ava's thinking is the cloud (Gemini 3) now. This toggle controls
/// whether your messages/notes are indexed into a PRIVATE on-device search index
/// (SQLite FTS5), so recall stays on your phone. No model download, instant.
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init].
library;
import '../../../core/localization/ui_text.dart';


import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ava_local_mode.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../settings_registry.dart';
import '../../../core/ui/messenger_theme.dart';

void registerOnDeviceSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_local',
      title: uiCopy(UiMessage.m_ava_ai_cb953cfc66),
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
    UiLocaleScope.watch(context);
    return AdCard(
      padding: const EdgeInsets.all(Msg.s4),
      child: ValueListenableBuilder<bool>(
        valueListenable: _mode.enabled,
        builder: (context, on, _) {
          final (dotColor, label) = on
              ? (AD.online, 'On — your memory stays on this phone')
              : (AD.textTertiary, 'Off — Ava uses the cloud');
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.cpu(PhosphorIconsStyle.fill),
                    color: AD.iconVideo,
                    size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        UiText(UiMessage.m_keep_my_memory_on_this_9f88d6d346,
                            style: ADText.rowName()),
                        const SizedBox(height: Msg.s1),
                        Row(children: [
                          Container(
                            width: 9,
                            height: 9,
                            decoration: BoxDecoration(
                                color: dotColor, shape: BoxShape.circle),
                          ),
                          const SizedBox(width: Msg.s1),
                          Flexible(
                            child:
                                Text(label, style: ADText.preview()),
                          ),
                        ]),
                      ]),
                ),
              ]),
              const SizedBox(height: Msg.s2),
              UiText(
                UiMessage.m_when_on_your_messages_and_4bd8ab274a,
                style: ADText.preview(),
              ),
              const SizedBox(height: 12),
              if (!on)
                AdButton(
                  label: _busy ? uiCopy(UiMessage.m_turning_on_63fd4df43f) : uiCopy(UiMessage.m_keep_memory_on_this_phone_711cfc5942),
                  onPressed: _busy ? null : _activate,
                  variant: AdButtonVariant.primary,
                  fontSize: 14,
                )
              else
                AdButton(
                  label: uiCopy(UiMessage.m_turn_off_use_cloud_only_2ab3838060),
                  onPressed: _disconnect,
                  variant: AdButtonVariant.ghost,
                  fontSize: 14,
                ),
            ],
          );
        },
      ),
    );
  }
}
