/// Settings → "Ava AI" section — activate/deactivate Local Ava AI (LFM2-350M
/// on-device via Cactus).
///
/// OFF by default → Ava uses the cloud. Activating downloads + loads the tiny
/// model so Ava runs on-device: faster, private, works offline. Shows live
/// status — green "Connected (on-device)" when ready, "Loading…" while
/// downloading/initialising, "Off — using cloud" otherwise — and a Disconnect
/// button to fall back to cloud. Registered via [SettingsSectionRegistry] from
/// [AvaBootstrap.init] (`registerOnDeviceSection()`).
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ava_local_mode.dart';
import '../../../core/ava_ondevice_llm.dart';
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
  final _llm = AvaOnDeviceLlm.I;
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
      child: AnimatedBuilder(
        animation: Listenable.merge([
          _mode.enabled,
          _llm.status,
          _llm.statusLine,
          _llm.downloadProgress,
        ]),
        builder: (context, _) {
          final on = _mode.enabled.value;
          final st = _llm.status.value;
          final (dotColor, label) = _statusFor(on, st);
          final downloading = on &&
              (st == OnDeviceStatus.downloading ||
                  st == OnDeviceStatus.initializing);

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
                        Text('Run Ava AI on this phone',
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
                            child: Text(label,
                                style: ZineText.sub(size: 12)),
                          ),
                        ]),
                      ]),
                ),
              ]),
              const SizedBox(height: 10),
              Text(
                'Faster, private, and works offline — best on a powerful phone. '
                'When off, Ava uses the cloud.',
                style: ZineText.sub(size: 12),
              ),
              if (downloading) ...[
                const SizedBox(height: 10),
                ValueListenableBuilder<double>(
                  valueListenable: _llm.downloadProgress,
                  builder: (context, p, _) => ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: LinearProgressIndicator(
                        value: p > 0 ? p : null, minHeight: 7),
                  ),
                ),
                const SizedBox(height: 6),
                Text(_llm.statusLine.value, style: ZineText.sub(size: 11.5)),
              ],
              const SizedBox(height: 12),
              if (!on)
                ZineButton(
                  label: _busy ? 'Activating…' : 'Activate Ava AI locally',
                  onPressed: _busy ? null : _activate,
                  variant: ZineButtonVariant.lime,
                  fontSize: 14,
                )
              else
                ZineButton(
                  label: 'Disconnect (use cloud Ava)',
                  onPressed: downloading ? null : _disconnect,
                  variant: ZineButtonVariant.ghost,
                  fontSize: 14,
                ),
            ],
          );
        },
      ),
    );
  }

  (Color, String) _statusFor(bool on, OnDeviceStatus st) {
    if (!on) return (Zine.inkMute, 'Off — using cloud Ava');
    return switch (st) {
      OnDeviceStatus.ready => (const Color(0xFF22A06B), 'Connected (on-device)'),
      OnDeviceStatus.downloading => (const Color(0xFFE8A23D), 'Model downloading…'),
      OnDeviceStatus.initializing => (const Color(0xFFE8A23D), 'Model loading…'),
      OnDeviceStatus.error => (Zine.coral, 'Error — using cloud Ava'),
      OnDeviceStatus.idle => (const Color(0xFFE8A23D), 'Starting…'),
    };
  }
}
