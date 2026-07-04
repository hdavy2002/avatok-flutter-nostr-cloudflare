import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:in_app_update/in_app_update.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../push/push_service.dart' show navigatorKey;
import 'analytics.dart';
import 'ava_log.dart';
import 'remote_config.dart';

/// Google Play **in-app update** flow for AvaTOK (Android only).
///
/// Two entry points:
///  • [runManual] — the "Update" row under ACCOUNT & SETTINGS. Always force-checks
///    Play, downloads the newest build in the background (flexible flow) and, once
///    the app restarts into it, confirms "Your app has been updated to build #X".
///  • [maybePromptOnLaunch] — called once per cold launch by the home shell. If a
///    newer build exists it shows the popup "There is a new version. Press Update
///    below to update to the new version." It ALSO surfaces the post-restart
///    "updated to build #X" confirmation.
///
/// Data-usage guard (owner note: a new build ships ~every 30 min): the *automatic*
/// launch check is throttled to at most once per [_autoCheckFloor] and at most
/// once per app session, so we never hammer Play. The manual row bypasses the
/// throttle because the user explicitly asked to check.
///
/// Everything here is best-effort — like [Analytics], a failure must never throw
/// into the app. iOS and non-Play installs simply no-op.
class UpdateService {
  UpdateService._();

  // Device-level state. Like the Clerk client token, a build is installed once
  // for the WHOLE device (not per account), so these keys are deliberately GLOBAL
  // — an explicit, documented exception to the per-account scoping rule.
  static const FlutterSecureStorage _sec = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const String _kLastCheckMs = 'upd_last_check_ms';
  static const String _kPendingBuild = 'upd_pending_build';

  /// Floor between automatic (launch) checks. ~one release cycle.
  static const Duration _autoCheckFloor = Duration(minutes: 30);

  /// Show the launch popup at most once per app session.
  static bool _promptedThisSession = false;

  static bool get _supported =>
      Platform.isAndroid && RemoteConfig.inAppUpdateEnabled;

  // ── stable UI handles (survive the drawer opening/closing) ────────────────
  static BuildContext? get _dialogCtx =>
      navigatorKey.currentState?.overlay?.context ?? navigatorKey.currentContext;
  static ScaffoldMessengerState? get _messenger {
    final c = navigatorKey.currentContext;
    return c == null ? null : ScaffoldMessenger.maybeOf(c);
  }

  static void _snack(String msg) =>
      _messenger?.showSnackBar(SnackBar(content: Text(msg)));

  /// Current installed build number (versionCode), best-effort.
  static Future<int?> _currentBuild() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return int.tryParse(info.buildNumber);
    } catch (_) {
      return null;
    }
  }

  static Future<int> _lastCheckMs() async {
    try {
      return int.tryParse(await _sec.read(key: _kLastCheckMs) ?? '') ?? 0;
    } catch (_) {
      return 0;
    }
  }

  static Future<void> _stampCheck() async {
    try {
      await _sec.write(
          key: _kLastCheckMs,
          value: DateTime.now().millisecondsSinceEpoch.toString());
    } catch (_) {}
  }

  // ── MANUAL: the "Update" sidebar row ──────────────────────────────────────
  static Future<void> runManual() async {
    if (!Platform.isAndroid) {
      _snack('In-app updates are available on Android only.');
      return;
    }
    Analytics.capture('update_check', {'source': 'manual'});
    AppUpdateInfo info;
    try {
      info = await InAppUpdate.checkForUpdate();
    } catch (e) {
      AvaLog.I.log('update', 'manual check failed: $e');
      Analytics.capture(
          'update_check_failed', {'source': 'manual', 'reason': e.toString()});
      _snack("Couldn't check for updates right now. Please try again later.");
      return;
    }
    await _stampCheck();
    if (info.updateAvailability != UpdateAvailability.updateAvailable) {
      final b = await _currentBuild();
      _snack("You're on the latest version${b != null ? ' (build #$b)' : ''}.");
      Analytics.capture(
          'update_check', {'source': 'manual', 'result': 'up_to_date'});
      return;
    }
    final target = info.availableVersionCode;
    Analytics.capture('update_available', {
      'source': 'manual',
      if (target != null) 'available_build': target,
    });
    await _runFlexible(target, source: 'manual');
  }

  // ── LAUNCH: throttled auto-check + post-restart confirmation ──────────────
  static Future<void> maybePromptOnLaunch() async {
    if (!_supported || _promptedThisSession) return;
    _promptedThisSession = true;

    // If we just restarted INTO the build we were updating to, confirm it.
    await _confirmAppliedUpdate();

    // Throttle the network check so we don't hammer Play (owner ships ~every 30m).
    final since = DateTime.now().millisecondsSinceEpoch - await _lastCheckMs();
    if (since < _autoCheckFloor.inMilliseconds) return;

    Analytics.capture('update_check', {'source': 'launch'});
    AppUpdateInfo info;
    try {
      info = await InAppUpdate.checkForUpdate();
    } catch (e) {
      AvaLog.I.log('update', 'launch check failed: $e');
      return;
    }
    await _stampCheck();
    if (info.updateAvailability != UpdateAvailability.updateAvailable) return;

    final ctx = _dialogCtx;
    if (ctx == null || !ctx.mounted) return;
    final target = info.availableVersionCode;
    Analytics.capture('update_available', {
      'source': 'launch',
      if (target != null) 'available_build': target,
    });
    Analytics.capture(
        'update_popup_shown', {if (target != null) 'available_build': target});

    final go = await showDialog<bool>(
      context: ctx,
      builder: (dctx) => AlertDialog(
        title: const Text('New version available'),
        content: Text(
          'There is a new version${target != null ? ' (build #$target)' : ''}. '
          'Press Update below to update to the new version.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dctx, false),
              child: const Text('Not now')),
          FilledButton(
              onPressed: () => Navigator.pop(dctx, true),
              child: const Text('Update')),
        ],
      ),
    );
    if (go == true) {
      await _runFlexible(target, source: 'launch');
    } else {
      Analytics.capture('update_popup_dismissed',
          {if (target != null) 'available_build': target});
    }
  }

  // ── shared flexible download → restart flow ───────────────────────────────
  static Future<void> _runFlexible(int? target, {required String source}) async {
    _snack('Downloading the latest update…');
    Analytics.capture('update_started', {
      'source': source,
      'type': 'flexible',
      if (target != null) 'available_build': target,
    });
    try {
      final res = await InAppUpdate.startFlexibleUpdate();
      if (res != AppUpdateResult.success) {
        Analytics.capture(
            'update_cancelled', {'source': source, 'result': res.toString()});
        return;
      }
      // Stash the target so the NEXT launch can say "updated to build #X".
      if (target != null) {
        try {
          await _sec.write(key: _kPendingBuild, value: target.toString());
        } catch (_) {}
      }
      Analytics.capture('update_downloaded',
          {'source': source, if (target != null) 'available_build': target});

      final ctx = _dialogCtx;
      if (ctx == null || !ctx.mounted) return;
      final restart = await showDialog<bool>(
        context: ctx,
        builder: (dctx) => AlertDialog(
          title: const Text('Update ready'),
          content: Text(
            'The update${target != null ? ' (build #$target)' : ''} has been '
            'downloaded. Restart now to finish updating.',
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dctx, false),
                child: const Text('Later')),
            FilledButton(
                onPressed: () => Navigator.pop(dctx, true),
                child: const Text('Restart & update')),
          ],
        ),
      );
      if (restart == true) {
        Analytics.capture('update_completing',
            {'source': source, if (target != null) 'available_build': target});
        await InAppUpdate.completeFlexibleUpdate(); // app restarts here
      }
    } catch (e) {
      AvaLog.I.log('update', 'flexible update failed: $e');
      Analytics.capture(
          'update_failed', {'source': source, 'reason': e.toString()});
      _snack("The update couldn't be completed. Please try again later.");
    }
  }

  /// One-time "Your app has been updated to build #X" after a completed update.
  static Future<void> _confirmAppliedUpdate() async {
    String? raw;
    try {
      raw = await _sec.read(key: _kPendingBuild);
    } catch (_) {}
    final pending = int.tryParse(raw ?? '');
    if (pending == null) return;
    final current = await _currentBuild();
    // Clear regardless so we never nag twice.
    try {
      await _sec.delete(key: _kPendingBuild);
    } catch (_) {}
    if (current == null || current < pending) return; // didn't land yet
    Analytics.capture('update_completed', {'build': current});
    _snack('Your app has been updated to the latest build #$current.');
  }
}
