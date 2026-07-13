import 'package:flutter/material.dart';

import '../../../core/ui/avatok_dark.dart';
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
    return AdCard(
      padding: const EdgeInsets.all(14),
      child: ValueListenableBuilder<bool>(
        valueListenable: FocusMode.enabled,
        builder: (context, on, _) => Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Keep the menu focused', style: ADText.rowName()),
              const SizedBox(height: 2),
              Text(
                on
                    ? 'Showing AvaTOK + your account essentials only. Turn off to '
                        'show all AvaVerse apps in the menu.'
                    : 'Showing all AvaVerse apps. Turn on to keep the menu to '
                        'AvaTOK + your account essentials.',
                style: ADText.preview(),
              ),
            ]),
          ),
          const SizedBox(width: 10),
          _AdToggle(value: on, onChanged: (v) => FocusMode.set(v)),
        ]),
      ),
    );
  }
}

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
class _AdToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _AdToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 22, height: 22,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }
}
