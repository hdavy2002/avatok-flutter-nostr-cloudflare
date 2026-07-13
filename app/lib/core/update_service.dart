import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../push/push_service.dart' show navigatorKey;
import 'analytics.dart';
import 'ava_log.dart';
import 'remote_config.dart';

/// "Update available" prompt for AvaTOK (Android/Play).
///
/// WHY THIS IS CONFIG-DRIVEN (not Google Play in-app-update): the old flow used
/// `InAppUpdate.checkForUpdate()`, which is unreliable on the *internal testing*
/// and closed tracks — it frequently reports "no update" even when a newer build
/// is live, so testers never saw a popup. This version instead compares the
/// installed build number against [RemoteConfig.latestAppBuild] (a value the
/// owner bumps in KV each time a release is published) and, when a newer build
/// exists, shows a dismissible popup whose **Update** button opens the Google
/// Play listing so the user can tap Play's own Update button. No dependency on
/// Play's in-app-update propagation, and it works on every track.
///
/// Two entry points:
///  • [runManual] — the "Update" row under ACCOUNT & SETTINGS. Always opens the
///    Play Store listing so the button reliably does something.
///  • [maybePromptOnLaunch] — called once per cold launch by the home shell.
///    If `latestAppBuild > installedBuild` it shows the centered popup
///    "There is a new version. Press Update to get it." → opens Play.
///
/// Everything here is best-effort — like [Analytics], a failure must never throw
/// into the app. iOS and non-Play installs simply no-op.
class UpdateService {
  UpdateService._();

  /// Show the launch popup at most once per app session (don't nag on every
  /// navigation). A fresh cold launch shows it again until they update.
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

  /// Installed package name (e.g. `ai.avatok.avatok_call` in prod, `…​.staging`
  /// on the staging flavour) so the Play link points at the RIGHT listing.
  static Future<String?> _packageName() async {
    try {
      return (await PackageInfo.fromPlatform()).packageName;
    } catch (_) {
      return null;
    }
  }

  /// Open the Google Play listing for the installed package. Tries the native
  /// `market://` intent first (opens the Play app straight on the listing, which
  /// shows the Update button for opted-in testers), then falls back to the https
  /// listing URL. Best-effort — never throws.
  static Future<void> _openPlayStore({required String source}) async {
    final pkg = await _packageName();
    if (pkg == null) {
      _snack("Couldn't open the Play Store. Please update from the Play Store app.");
      return;
    }
    Analytics.capture('update_open_store', {'source': source, 'package': pkg});
    final market = Uri.parse('market://details?id=$pkg');
    final web = Uri.parse('https://play.google.com/store/apps/details?id=$pkg');
    try {
      if (await canLaunchUrl(market)) {
        await launchUrl(market, mode: LaunchMode.externalApplication);
        return;
      }
      await launchUrl(web, mode: LaunchMode.externalApplication);
    } catch (e) {
      AvaLog.I.log('update', 'open play store failed: $e');
      Analytics.capture(
          'update_open_store_failed', {'source': source, 'reason': e.toString()});
      _snack("Couldn't open the Play Store. Please update from the Play Store app.");
    }
  }

  // ── MANUAL: the "Update" sidebar row ──────────────────────────────────────
  static Future<void> runManual() async {
    if (!Platform.isAndroid) {
      _snack('Updates are available on Android only.');
      return;
    }
    Analytics.capture('update_check', {'source': 'manual'});
    // Always take the user to the store — the store itself shows Update or Open,
    // so the button is never a dead end.
    await _openPlayStore(source: 'manual');
  }

  // ── LAUNCH: config-driven "new version available" popup ───────────────────
  static Future<void> maybePromptOnLaunch() async {
    if (!_supported || _promptedThisSession) return;
    _promptedThisSession = true;

    final latest = RemoteConfig.latestAppBuild;
    if (latest <= 0) return; // owner hasn't published a target yet

    final current = await _currentBuild();
    if (current == null || latest <= current) return; // already up to date

    final ctx = _dialogCtx;
    if (ctx == null || !ctx.mounted) return;

    Analytics.capture('update_available', {
      'source': 'launch',
      'available_build': latest,
      'installed_build': current,
    });
    Analytics.capture('update_popup_shown', {'available_build': latest});

    final go = await showDialog<bool>(
      context: ctx,
      builder: (dctx) => AlertDialog(
        title: const Text('New version available'),
        content: const Text(
          'A new version of AvaTOK is available. Press Update to get the latest '
          'features and fixes from the Google Play Store.',
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
      await _openPlayStore(source: 'launch');
    } else {
      Analytics.capture('update_popup_dismissed', {'available_build': latest});
    }
  }
}
