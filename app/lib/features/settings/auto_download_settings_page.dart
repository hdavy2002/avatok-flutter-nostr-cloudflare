import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/media_auto_download.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// ACCOUNT & SETTINGS → Auto-download (STREAM J / D17).
///
/// Three radio options controlling whether incoming chat media (photos, videos,
/// files, voice notes) is fetched automatically when a message arrives, or left
/// as a tap-to-download placeholder. A manual tap ALWAYS downloads regardless of
/// this setting; once fetched, media is cached forever (local-first).
///
/// The choice is stored per-account (`scopedKey('auto_download_mode')`) so a
/// parent and each child sharing one phone keep independent settings.
///
/// Stranger-gate note: a not-yet-accepted (pending) thread never auto-downloads
/// in ANY mode — that gate lives in [MediaAutoDownload.shouldAutoFetch] and is
/// independent of this page.
class AutoDownloadSettingsPage extends StatefulWidget {
  const AutoDownloadSettingsPage({super.key});

  @override
  State<AutoDownloadSettingsPage> createState() => _AutoDownloadSettingsPageState();
}

class _AutoDownloadSettingsPageState extends State<AutoDownloadSettingsPage> {
  AutoDownloadMode? _mode; // null while loading

  @override
  void initState() {
    super.initState();
    Analytics.capture('auto_download_settings_viewed', const {});
    _load();
  }

  Future<void> _load() async {
    final m = await MediaAutoDownload.mode();
    if (mounted) setState(() => _mode = m);
  }

  Future<void> _select(AutoDownloadMode m) async {
    if (_mode == m) return;
    setState(() => _mode = m);
    await MediaAutoDownload.setMode(m);
    // Telemetry: which policy the user picked (email rides in the envelope).
    Analytics.capture('auto_download_mode_set', {'mode': _encode(m)});
  }

  static String _encode(AutoDownloadMode m) => switch (m) {
        AutoDownloadMode.always => 'always',
        AutoDownloadMode.wifiOnly => 'wifi_only',
        AutoDownloadMode.never => 'never',
      };

  @override
  Widget build(BuildContext context) {
    final mode = _mode;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Auto-download'),
      body: mode == null
          ? const Center(
              child: SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2)))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
              children: [
                Text(
                  'When should AvaTOK download the photos, videos, files and voice '
                  'notes people send you?',
                  style: ZineText.sub(size: 13),
                ),
                const SizedBox(height: 16),
                _option(
                  mode: mode,
                  value: AutoDownloadMode.always,
                  icon: PhosphorIcons.downloadSimple(PhosphorIconsStyle.fill),
                  color: Zine.mint,
                  title: 'Download media automatically',
                  subtitle: 'Media is ready to view the moment it arrives.',
                ),
                _option(
                  mode: mode,
                  value: AutoDownloadMode.wifiOnly,
                  icon: PhosphorIcons.wifiHigh(PhosphorIconsStyle.fill),
                  color: Zine.blue,
                  title: 'Download on Wi-Fi only',
                  subtitle: 'Save mobile data — download over Wi-Fi, tap to fetch on cellular.',
                ),
                _option(
                  mode: mode,
                  value: AutoDownloadMode.never,
                  icon: PhosphorIcons.handPalm(PhosphorIconsStyle.fill),
                  color: Zine.coral,
                  title: 'Do not download automatically',
                  subtitle: 'Nothing downloads until you tap it — you stay fully in control.',
                ),
                const SizedBox(height: 18),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Zine.paper2,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Zine.ink, width: 1.2),
                  ),
                  child: Row(children: [
                    PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.fill),
                        size: 18, color: Zine.inkSoft),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'You can always tap any attachment to download it, whatever '
                        'you choose here. Once downloaded, it is kept on this phone.',
                        style: ZineText.sub(size: 12),
                      ),
                    ),
                  ]),
                ),
              ],
            ),
    );
  }

  Widget _option({
    required AutoDownloadMode mode,
    required AutoDownloadMode value,
    required IconData icon,
    required Color color,
    required String title,
    required String subtitle,
  }) {
    final selected = mode == value;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZineCard(
        onTap: () => _select(value),
        radius: Zine.rSm,
        padding: const EdgeInsets.all(13),
        color: selected ? Zine.paper2 : Zine.card,
        boxShadow: selected ? Zine.shadowXs : const [],
        child: Row(children: [
          ZineIconBadge(icon: icon, color: color, size: 38),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: ZineText.value(size: 14.5)),
                const SizedBox(height: 3),
                Text(subtitle, style: ZineText.sub(size: 12)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          _radio(selected),
        ]),
      ),
    );
  }

  Widget _radio(bool selected) => Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(
              color: selected ? Zine.ink : Zine.inkMute, width: 2),
          color: selected ? Zine.ink : Colors.transparent,
        ),
        child: selected
            ? const Icon(Icons.check, size: 14, color: Colors.white)
            : null,
      );
}
