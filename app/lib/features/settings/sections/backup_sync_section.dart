
import '../../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/drive_service.dart';
import '../../../core/paid_feature.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
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
      title: uiCopy(UiMessage.m_backup_sync_9e742a3709),
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
    // Section health (was a telemetry blind spot): how many users land here
    // connected, and whether the backup folder is ready — queryable per email.
    Analytics.capture('backup_drive_status', {
      'connected': st.connected,
      'folder_ready': folderReady,
    });
  }

  /// Connect Drive via an IN-APP auth sheet (iOS ASWebAuthenticationSession /
  /// Android Custom Tabs) that AUTO-CLOSES on the avatokauth:// callback — the
  /// user authorizes Google and lands right back here, never bounced to the
  /// external Chrome app. connectUrl() already requests ?return=app so the
  /// Worker redirects to the callback scheme. Same pattern as AvaStorage.
  Future<void> _connectDrive() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    final sw = Stopwatch()..start();
    Analytics.capture('backup_drive_connect_started', const {});
    final url = await DriveService.I.connectUrl();
    if (url == null || url.isEmpty) {
      Analytics.capture('backup_drive_connect_url_missing', {'after_ms': sw.elapsedMilliseconds});
      Analytics.error(
          domain: 'storage', code: 'connect_url_null', screen: 'backup_sync', action: 'connect');
      _snack(uiCopy(UiMessage.m_couldn_t_start_google_drive_efc20114d8));
    } else {
      Analytics.capture('backup_drive_connect_opened', const {'mode': 'web_auth'});
      try {
        await FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: 'avatokauth');
        Analytics.capture('backup_drive_connect_returned', const {'mode': 'web_auth'});
        await _refreshDrive();
        final connected = _driveConnected == true;
        Analytics.capture(connected ? 'backup_drive_connected' : 'backup_drive_connect_unverified',
            {'via': 'web_auth', 'connect_ms': sw.elapsedMilliseconds});
        if (connected) _snack(uiCopy(UiMessage.m_google_drive_connected_c97023e92a));
      } on PlatformException catch (e) {
        if (e.code == 'CANCELED' || e.code == 'CANCELLED') {
          Analytics.capture('backup_drive_connect_cancelled',
              {'code': e.code, 'after_ms': sw.elapsedMilliseconds});
        } else {
          AvaLog.I.log('drive', 'backup web auth failed (${e.code}); falling back to tab');
          Analytics.error(
              domain: 'storage', code: 'web_auth_failed', message: e.code,
              screen: 'backup_sync', action: 'connect');
          try {
            final opened = await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
            Analytics.capture('backup_drive_connect_fallback_opened',
                {'mode': 'in_app_tab', 'opened': opened});
            _snack(opened
                ? uiCopy(UiMessage.m_authorize_google_drive_then_tap_67a1b4b964)
                : uiCopy(UiMessage.m_could_not_open_google_drive_b72939218e));
          } catch (e2) {
            Analytics.error(
                domain: 'storage', code: 'fallback_launch_failed', message: e2.toString(),
                screen: 'backup_sync', action: 'connect');
            _snack(uiCopy(UiMessage.m_could_not_open_google_drive_b72939218e));
          }
        }
      } catch (e) {
        AvaLog.I.log('drive', 'backup web auth error: $e');
        Analytics.error(
            domain: 'storage', code: 'web_auth_error', message: e.toString(),
            screen: 'backup_sync', action: 'connect');
        _snack(uiCopy(UiMessage.m_could_not_open_google_drive_b72939218e));
      }
    }
    if (mounted) setState(() => _connecting = false);
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _run(Future<BackupResult> Function() op, String okMsg, {String name = ''}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await op();
      // Result of each backup/restore/sync op so a failing lane is queryable
      // per user (e.g. premium_required / no_token / network).
      Analytics.capture('backup_op_result',
          {'op': name, 'ok': r.ok, if (r.reason != null) 'reason': r.reason!});
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
        return uiCopy(UiMessage.m_cross_device_sync_is_a_2c27dd1a7c);
      case 'no_token':
        return uiCopy(UiMessage.m_connect_google_drive_first_to_16e4017eab);
      case 'no_backup':
        return uiCopy(UiMessage.m_no_backup_found_yet_7402c74a68);
      case 'empty':
        return uiCopy(UiMessage.m_nothing_to_back_up_yet_48e29c4534);
      case 'network':
        return uiCopy(UiMessage.m_could_not_reach_the_backup_b8ae5b9059);
      default:
        return uiCopy(UiMessage.m_backup_failed_value1_5536d6fce4, {'value1': (reason != null ? ' ($reason)' : '').toString()});
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _driveCard(),
      const SizedBox(height: 12),
      _r2Card(),
    ]);
  }

  // ── FREE: Google Drive backup ──────────────────────────────────────────────
  Widget _driveCard() {
    return AdCard(
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.cloud(PhosphorIconsStyle.fill), color: AD.primaryBadge, size: 34),
          const SizedBox(width: Msg.s2),
          Expanded(child: UiText(UiMessage.m_google_drive_backup_85feb6de07, style: ADText.rowName())),
          const _FreeChip(),
        ]),
        const SizedBox(height: 8),
        UiText(
          UiMessage.m_free_encrypted_backup_to_your_900bc8abf5,
          style: ADText.preview(),
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
        padding: EdgeInsets.symmetric(vertical: Msg.s2),
        child: Row(children: [
          SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2.2)),
          SizedBox(width: Msg.s2),
          UiText(UiMessage.m_checking_google_drive_14d73b3588),
        ]),
      );
    }

    final ready = _driveConnected == true && _folderReady;
    if (!ready) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        AdButton(
          label: _connecting ? uiCopy(UiMessage.m_opening_google_28caff1f82) : uiCopy(UiMessage.m_connect_google_drive_4406cf53ed),
          variant: AdButtonVariant.primary,
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
            underline: AD.iconSearch,
            onTap: _connecting ? null : _refreshDrive,
          ),
        ),
      ]);
    }

    return Row(children: [
      Expanded(
        child: AdButton(
          label: uiCopy(UiMessage.m_back_up_now_02a2840b59),
          variant: AdButtonVariant.primary,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold),
          trailingIcon: false,
          loading: _busy,
          onPressed: _busy ? null : () => _run(BackupService.I.backupAllToDrive, 'Chats + media backed up to Drive.', name: 'drive_backup'),
        ),
      ),
      const SizedBox(width: Msg.s2),
      Expanded(
        child: AdButton(
          label: uiCopy(UiMessage.m_restore_a76e13b983),
          variant: AdButtonVariant.ghost,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.cloudArrowDown(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: _busy
              ? null
              : () => _run(BackupService.I.restoreAllFromDrive, 'Chats + media restored from Drive.', name: 'drive_restore'),
        ),
      ),
    ]);
  }

  // ── PAID: R2 cross-device sync ──────────────────────────────────────────────
  Widget _r2Card() {
    return AdCard(
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.devices(PhosphorIconsStyle.fill), color: AD.iconSearch, size: 34),
          const SizedBox(width: Msg.s2),
          Expanded(child: UiText(UiMessage.m_cross_device_sync_5ed52173f0, style: ADText.rowName())),
          const PaidBadge(),
        ]),
        const SizedBox(height: 8),
        UiText(
          UiMessage.m_keep_your_chats_in_sync_2ae43d81ce, params: {'value1': (_r2Summary != null ? ' · $_r2Summary' : '').toString()},
          style: ADText.preview(),
        ),
        const SizedBox(height: 12),
        Row(children: [
          // PaidFeature gates the SYNC action: a free tap routes to the top-up
          // sheet; an entitled tap runs the encrypted R2 upload.
          Expanded(
            child: PaidFeature(
              actionLabel: 'Sync across devices',
              onRun: () => _run(BackupService.I.syncToR2, 'Synced to your other devices.', name: 'r2_sync'),
              child: _pillLabel('Sync now', PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), AD.newGroup),
            ),
          ),
          const SizedBox(width: Msg.s2),
          // Restore from R2 is allowed even for a lapsed account (so they can
          // recover their own data) — still behind PaidFeature so the entry
          // point reads as premium, but the server permits the GET regardless.
          Expanded(
            child: PaidFeature(
              actionLabel: 'Restore from sync',
              onRun: () => _run(BackupService.I.restoreFromR2, 'Restored from sync.', name: 'r2_restore'),
              child: _pillLabel('Restore', PhosphorIcons.cloudArrowDown(PhosphorIconsStyle.bold), AD.card),
            ),
          ),
        ]),
      ]),
    );
  }

  Widget _pillLabel(String text, IconData icon, Color fill) {
    final fg = fill == AD.card ? AD.textPrimary : Colors.white;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s3),
      decoration: BoxDecoration(
        color: fill,
        // Full-width action BUTTON, not a badge.
        borderRadius: Msg.brMd,
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, mainAxisSize: MainAxisSize.max, children: [
        Icon(icon, size: 16, color: fg),
        const SizedBox(width: 8),
        Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName(c: fg))),
      ]),
    );
  }
}

/// A small "FREE" counterpart to [PaidBadge].
class _FreeChip extends StatelessWidget {
  const _FreeChip();
  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
        decoration: BoxDecoration(
          color: AD.primaryBadge,
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: UiText(UiMessage.m_free_f411a1fb62, style: ADText.statCaption(c: Colors.white)),
      ); }
}
