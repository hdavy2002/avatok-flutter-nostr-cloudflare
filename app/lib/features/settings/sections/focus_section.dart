import 'package:flutter/material.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../shell/focus_mode.dart';
import '../settings_registry.dart';

/// Settings → "Focus mode" section (Phase 1 — Ava in-chat). A single Zine toggle
/// that flips [FocusMode]. When ON, the AvaTOK sidebar shows AvaTOK + account
/// essentials only; when OFF the full app menu returns. Persisted per-account by
/// [FocusMode] (DiskCache). The sidebar listens to [FocusMode.enabled] and
/// rebuilds the moment this flips.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init] (the one
/// sanctioned bootstrap append) — never by editing settings_screen.dart.
void registerFocusSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'focus_mode',
      title: 'Focus mode',
      order: 5, // sits near the top of the pluggable sections
      builder: (context) => const _FocusModeCard(),
    ),
  );
}

class _FocusModeCard extends StatefulWidget {
  const _FocusModeCard();
  @override
  State<_FocusModeCard> createState() => _FocusModeCardState();
}

class _FocusModeCardState extends State<_FocusModeCard> {
  @override
  void initState() {
    super.initState();
    // Ensure the notifier reflects this account's persisted value.
    FocusMode.load();
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: ValueListenableBuilder<bool>(
        valueListenable: FocusMode.enabled,
        builder: (context, on, _) => Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Keep the menu focused', style: ZineText.value(size: 14.5)),
              const SizedBox(height: 2),
              Text(
                on
                    ? 'Showing AvaTOK + your account essentials only. Turn off to '
                        'show all AvaVerse apps in the menu.'
                    : 'Showing all AvaVerse apps. Turn on to keep the menu to '
                        'AvaTOK + your account essentials.',
                style: ZineText.sub(size: 12),
              ),
            ]),
          ),
          const SizedBox(width: 10),
          ZineToggle(value: on, onChanged: (v) => FocusMode.set(v)),
        ]),
      ),
    );
  }
}
