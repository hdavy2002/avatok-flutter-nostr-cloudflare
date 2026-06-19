import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/drive_service.dart';
import '../../../core/paid_feature.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../ava_backup/backup_service.dart';
import '../settings_registry.dart';

/// Settings → "Backup & sync" section (Phase 10 — Ava in-chat).
///
/// Two lanes, both backing up the CLIENT-SIDE-ENCRYPTED on-device SQLite:
///   • FREE  — Google Drive (the user's own appDataFolder; survives uninstall).
///   • PAID  — R2 cross-device sync (server-readable across devices), wrapped in
///             [PaidFeature] + a [PaidBadge].
///
/// This is a SEPARATE section from the existing email-export backup in
/// settings_screen.dart (which is left untouched). Registered via
/// [SettingsSectionRegistry] from [AvaBootstrap.init] (the one sanctioned
/// bootstrap append) — never by editing settings_screen.dart.
void registerBackupSyncSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'backup_sync',
      title: 'Backup & sync',
      order: 40,
      builder: (context) => const _BackupSyncCard(),
    ),
  );
}

class _BackupSyncCard extends StatefulWidget {
  const _BackupSyncCard();
  @override
  State<_BackupSyncCard> createState() => _BackupSyncCardState();
}

class _BackupSyncCardState extends State<_BackupSyncCard> {
  bool _busy = false;
  String? _r2Summary;

  // Drive connection gate (FREE lane). null = still checking. The backup/restore
  // buttons only appear once Drive is connected AND the avatok-backup folder is
  // in place — otherwise we show a single "Connect Google Drive" button so the
  // user is taken through the OAuth pipeline instead of hitting a backup error.
  bool? _driveConnected;
  bool _folderReady = false;
  bool _connecting = false;

  @override
  void initState() {
    super.initState();
    _loadStatus();
    _refreshDrive();
  }

  Future<void> _loadStatus() async {
    final s = await BackupService.I.r2Status();
    if (!mounted) return;
    setState(() {
      _r2Summary = s == null
          ? null
          : 'Last sync v${s.version} · ${(s.sizeBytes / 1024).toStringAsFixed(0)} KB';
    });
  }

  /// Check Drive connection and, when connected, ensure the avatok-backup folder
  /// exists. Drives whether we show the connect button or the backup buttons.
  Future<void> _refreshDrive() async {
    final st = await DriveService.I.status();
    var folderReady = false;
    if (st.connected) {
      folderReady = await DriveService.I.ensureBackupFolder();
    }
    if (!mounted) return;
    setState(() {
      _driveConnected = st.connected;
      _folderReady = folderReady;
    });
  }

  /// Open Google's consent screen to connect Drive (reuses the gcal/drive.file
  /// OAuth). After the user authorizes and returns, they tap "I've connected".
  Future<void> _connectDrive() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    try {
      final url = await DriveService.I.connectUrl();
      if (url != null && url.isNotEmpty) {
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        _snack('Authorize Google Drive, then come back and tap "I\'ve connected".');
      } else {
        _snack("Couldn't start Google Drive — try again in a moment.");
      }
    } catch (_) {
      _snack('Could not open Google Drive.');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _run(Future<BackupResult> Function() op, String okMsg) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await op();
      if (r.ok) {
        _snack(okMsg);
      } else {
        _snack(_reasonMessage(r.reason));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      _loadStatus();
    }
  }

  String _reasonMessage(String? reason) {
    switch (reason) {
      case 'premium_required':
        return 'Cross-device sync is a premium feature. Top up to enable it.';
      case 'no_token':
        return 'Connect Google Drive first to back up.';
      case 'no_backup':
        return 'No backup found yet.';
      case 'empty':
        return 'Nothing to back up yet.';
      case 'network':
        return 'Could not reach the backup service. Check your connection.';
      default:
        return 'Backup failed${reason != null ? ' ($reason)' : ''}.';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _driveCard(),
      const SizedBox(height: 12),
      _r2Card(),
    ]);
  }

  // ── FREE: Google Drive backup ──────────────────────────────────────────────
  Widget _driveCard() {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.cloud(PhosphorIconsStyle.fill), color: Zine.lime, size: 34),
          const SizedBox(width: 10),
          Expanded(child: Text('Google Drive backup', style: ZineText.value(size: 14.5))),
          const _FreeChip(),
        ]),
        const SizedBox(height: 8),
        Text(
          'Free, encrypted backup to your own Google Drive. Your chats are '
          'encrypted on this device before upload, so neither AvaTOK nor Google '
          'can read them. Survives reinstalling the app.',
          style: ZineText.sub(size: 12),
        ),
        const SizedBox(height: 12),
        _driveActions(),
      ]),
    );
  }

  /// Connect-gated actions: until Drive is connected and the avatok-backup
  /// folder exists, only a "Connect Google Drive" button shows. Once ready, the
  /// backup/restore buttons appear.
  Widget _driveActions() {
    if (_driveConnected == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2.2)),
          SizedBox(width: 10),
          Text('Checking Google Drive…'),
        ]),
      );
    }

    final ready = _driveConnected == true && _folderReady;
    if (!ready) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        ZineButton(
          label: _connecting ? 'Opening Google…' : 'Connect Google Drive',
          variant: ZineButtonVariant.lime,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold),
          trailingIcon: false,
          loading: _connecting,
          onPressed: _connecting ? null : _connectDrive,
        ),
        const SizedBox(height: 8),
        Center(
          child: ZineLink(
            _driveConnected == true ? 'finish setup' : "I've connected — refresh",
            fontSize: 13,
            onTap: _connecting ? null : _refreshDrive,
          ),
        ),
      ]);
    }

    return Row(children: [
      Expanded(
        child: ZineButton(
          label: 'Back up now',
          variant: ZineButtonVariant.lime,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold),
          trailingIcon: false,
          loading: _busy,
          onPressed: _busy ? null : () => _run(BackupService.I.backupToDrive, 'Backed up to Drive.'),
        ),
      ),
      const SizedBox(width: 10),
      Expanded(
        child: ZineButton(
          label: 'Restore',
          variant: ZineButtonVariant.ghost,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.cloudArrowDown(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: _busy
              ? null
              : () => _run(BackupService.I.restoreFromDrive, 'Restored from Drive. Reopen the app.'),
        ),
      ),
    ]);
  }

  // ── PAID: R2 cross-device sync ──────────────────────────────────────────────
  Widget _r2Card() {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.devices(PhosphorIconsStyle.fill), color: Zine.blue, size: 34),
          const SizedBox(width: 10),
          Expanded(child: Text('Cross-device sync', style: ZineText.value(size: 14.5))),
          const PaidBadge(),
        ]),
        const SizedBox(height: 8),
        Text(
          'Keep your chats in sync across all your devices, encrypted end-to-end. '
          'Premium feature${_r2Summary != null ? ' · $_r2Summary' : ''}.',
          style: ZineText.sub(size: 12),
        ),
        const SizedBox(height: 12),
        Row(children: [
          // PaidFeature gates the SYNC action: a free tap routes to the top-up
          // sheet; an entitled tap runs the encrypted R2 upload.
          Expanded(
            child: PaidFeature(
              actionLabel: 'Sync across devices',
              onRun: () => _run(BackupService.I.syncToR2, 'Synced to your other devices.'),
              child: _pillLabel('Sync now', PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), Zine.blue),
            ),
          ),
          const SizedBox(width: 10),
          // Restore from R2 is allowed even for a lapsed account (so they can
          // recover their own data) — still behind PaidFeature so the entry
          // point reads as premium, but the server permits the GET regardless.
          Expanded(
            child: PaidFeature(
              actionLabel: 'Restore from sync',
              onRun: () => _run(BackupService.I.restoreFromR2, 'Restored from sync. Reopen the app.'),
              child: _pillLabel('Restore', PhosphorIcons.cloudArrowDown(PhosphorIconsStyle.bold), Zine.card),
            ),
          ),
        ]),
      ]),
    );
  }

  Widget _pillLabel(String text, IconData icon, Color fill) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, mainAxisSize: MainAxisSize.max, children: [
          Icon(icon, size: 16, color: Zine.ink),
          const SizedBox(width: 8),
          Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.button(size: 14, color: Zine.ink))),
        ]),
      );
}

/// A small "FREE" counterpart to [PaidBadge].
class _FreeChip extends StatelessWidget {
  const _FreeChip();
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Zine.lime,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
          boxShadow: Zine.shadowXs,
        ),
        child: Text('FREE', style: ZineText.tag(size: 9.5, color: Zine.ink)),
      );
}
