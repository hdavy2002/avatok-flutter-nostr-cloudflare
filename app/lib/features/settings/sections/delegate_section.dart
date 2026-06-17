import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/disk_cache.dart';
import '../../../core/paid_feature.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../settings_registry.dart';

/// Settings → "Ava delegate" section (Phase 7 — Delegate: Monitor + Auto-reply
/// + Push).
///
/// This section EXPLAINS the delegate feature and holds the account-wide
/// DEFAULTS that new chats inherit. The actual switches are PER-CHAT (see
/// [DelegateSettingsSheet] in features/ava_delegate/) — a parent doesn't want
/// Ava answering for them everywhere by default, so monitoring is opt-in per
/// conversation. Here the user sets:
///
///   • "Alert me on mentions by default"  — FREE. New chats start with the
///     mention-alert toggle ON (the per-chat sheet can still override).
///   • "Let Ava reply for me by default"  — PREMIUM. New chats start with
///     monitoring ON. Wrapped in [PaidFeature] (enabling is the paid gate).
///
/// Defaults are a per-account convenience stored on-device ([DiskCache],
/// account-scoped); the authoritative per-chat prefs live server-side
/// (`/api/ava/delegate`, a Phase-11 hook). Registered via
/// [SettingsSectionRegistry] from [AvaBootstrap.init] (`registerDelegateSection()`)
/// — the one sanctioned bootstrap append — never by editing settings_screen.dart.
void registerDelegateSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_delegate',
      title: 'Ava delegate',
      order: 27, // just below "Ava voice" (25), above "Tools & connectors" (30)
      builder: (context) => const _DelegateCard(),
    ),
  );
}

/// Account-wide delegate DEFAULTS new chats inherit. Per-account via [DiskCache]
/// (scoped under `cache/<AccountScope.id>/`). The per-chat sheet reads/writes the
/// authoritative server prefs; these defaults only seed a chat the first time.
class DelegateDefaults {
  DelegateDefaults._();

  static const _kAlert = 'ava_delegate_default_alert';
  static const _kMonitor = 'ava_delegate_default_monitor';

  /// Default for "alert me on mentions" in new chats. Default ON (free, useful).
  static final ValueNotifier<bool> alertMentions = ValueNotifier<bool>(true);

  /// Default for "monitor & reply on my behalf" in new chats. Default OFF
  /// (premium + intentionally conservative — Ava should not speak for you
  /// everywhere unless you ask, per chat).
  static final ValueNotifier<bool> monitor = ValueNotifier<bool>(false);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  /// Read persisted defaults for the current account. Never throws.
  static Future<void> load() async {
    try {
      final a = await DiskCache.read(_kAlert);
      final m = await DiskCache.read(_kMonitor);
      alertMentions.value = a == null || a.isEmpty ? true : a == '1';
      monitor.value = m == '1';
    } catch (_) {/* keep defaults */}
    _loaded = true;
  }

  static Future<void> setAlert(bool v) async {
    alertMentions.value = v;
    await DiskCache.write(_kAlert, v ? '1' : '0');
  }

  static Future<void> setMonitor(bool v) async {
    monitor.value = v;
    await DiskCache.write(_kMonitor, v ? '1' : '0');
  }
}

class _DelegateCard extends StatefulWidget {
  const _DelegateCard();
  @override
  State<_DelegateCard> createState() => _DelegateCardState();
}

class _DelegateCardState extends State<_DelegateCard> {
  @override
  void initState() {
    super.initState();
    DelegateDefaults.load();
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.userFocus(PhosphorIconsStyle.fill), color: Zine.lilac, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Let Ava watch a chat and step in when you’re @mentioned and away. '
              'Replies are always disclosed ("Ava — for you") — never impersonation. '
              'Switch it on per chat from the chat’s Ava menu; set the defaults '
              'for new chats here.',
              style: ZineText.sub(size: 12.5),
            ),
          ),
        ]),
        const SizedBox(height: 14),
        // FREE default — alert on mentions.
        ValueListenableBuilder<bool>(
          valueListenable: DelegateDefaults.alertMentions,
          builder: (context, on, _) => Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Alert me on mentions by default', style: ZineText.value(size: 13.5)),
                Text('New chats start by pushing you on @mentions.', style: ZineText.sub(size: 11.5)),
              ]),
            ),
            const SizedBox(width: 10),
            ZineToggle(value: on, onChanged: (v) => DelegateDefaults.setAlert(v)),
          ]),
        ),
        const SizedBox(height: 12),
        const Divider(height: 1, thickness: 1, color: Zine.inkMute),
        const SizedBox(height: 12),
        // PREMIUM default — let Ava reply for me. Enable is paid-gated; off free.
        ValueListenableBuilder<bool>(
          valueListenable: DelegateDefaults.monitor,
          builder: (context, on, _) => Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text('Let Ava reply for me by default', style: ZineText.value(size: 13.5))),
                  const SizedBox(width: 8),
                  const PaidBadge(),
                ]),
                Text('New chats start with on-your-behalf replies (while offline).',
                    style: ZineText.sub(size: 11.5)),
              ]),
            ),
            const SizedBox(width: 10),
            if (on)
              ZineToggle(value: true, onChanged: (_) => DelegateDefaults.setMonitor(false))
            else
              PaidFeature(
                actionLabel: 'Enable Ava delegate by default',
                onRun: () async => DelegateDefaults.setMonitor(true),
                child: const IgnorePointer(child: ZineToggle(value: false, onChanged: null)),
              ),
          ]),
        ),
      ]),
    );
  }
}
