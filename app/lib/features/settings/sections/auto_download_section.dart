/// Settings → "Auto-download" section (STREAM J / D17). A single tile that opens
/// [AutoDownloadSettingsPage], where the user picks how incoming chat media is
/// fetched (automatically / Wi-Fi only / never). The choice is stored per-account
/// by [MediaAutoDownload]; a manual tap on any attachment always downloads.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init] — no flag
/// (this is a setting, not a gated feature).
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/media_auto_download.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../auto_download_settings_page.dart';
import '../settings_registry.dart';

void registerAutoDownloadSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'auto_download',
      title: 'Media',
      order: 24,
      builder: (context) => const _AutoDownloadTile(),
    ),
  );
}

class _AutoDownloadTile extends StatefulWidget {
  const _AutoDownloadTile();
  @override
  State<_AutoDownloadTile> createState() => _AutoDownloadTileState();
}

class _AutoDownloadTileState extends State<_AutoDownloadTile> {
  AutoDownloadMode? _mode;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final m = await MediaAutoDownload.mode();
    if (mounted) setState(() => _mode = m);
  }

  String _summary(AutoDownloadMode? m) => switch (m) {
        AutoDownloadMode.wifiOnly => 'On Wi-Fi only',
        AutoDownloadMode.never => 'Never — tap to download',
        AutoDownloadMode.always => 'Automatically',
        null => '',
      };

  Future<void> _open() async {
    Analytics.capture('auto_download_tile_tapped', const {});
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const AutoDownloadSettingsPage()),
    );
    // Reflect any change made on the page in the tile subtitle.
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return AdCard(
      onTap: _open,
      padding: const EdgeInsets.all(14),
      child: Row(children: [
        ZineIconBadge(
            icon: PhosphorIcons.downloadSimple(PhosphorIconsStyle.fill),
            color: AD.iconSearch,
            size: 36),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Auto-download', style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(
              _mode == null
                  ? 'Choose when media downloads'
                  : 'Media downloads: ${_summary(_mode)}',
              style: ADText.preview(),
            ),
          ]),
        ),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
            size: 18, color: AD.textSecondary),
      ]),
    );
  }
}
