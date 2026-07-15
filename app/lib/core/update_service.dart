import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:in_app_update/in_app_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../push/push_service.dart' show navigatorKey;
import 'analytics.dart';
import 'ava_log.dart';
import 'remote_config.dart';

/// Automatic app updates for AvaTOK (Android/Play).
///
/// [AVA-UPDATE-AUTO] Owner request 2026-07-15: "as soon as it detects a new
/// release it silently updates itself without user intervention." The honest
/// ceiling on Android is ONE tap: Play's own confirmation dialog inside our app.
/// A non-system app cannot install a package invisibly (that privilege belongs to
/// the Play Store and device-owner/system apps only), and an app cannot switch on
/// Play's background auto-update setting either — there is no API for it. So this
/// service goes as close as the platform permits: detect on launch → download in
/// the BACKGROUND while the user keeps using the app → install on completion.
/// No "Not now" escape hatch, no trip to the Play listing, no button to hunt for.
///
/// WHY BOTH A PLAY CHECK **AND** A CONFIG CHECK. The previous revision of this
/// file ripped `InAppUpdate` out entirely because it reported "no update" while a
/// newer build was demonstrably live, and replaced it with a popup that opened the
/// Play listing. That popup is a dead end for anyone who SIDE-LOADED the APK from
/// GitHub Releases — Play does not own that install, so it offers them nothing.
/// And that is almost certainly the same reason `checkForUpdate()` "failed": Play
/// only serves in-app updates to installs it owns. Rather than pick a side, this
/// version uses each source for what it is actually reliable at:
///
///   • [RemoteConfig.latestAppBuild] (KV, owner-bumped per release) is the TRUTH
///     about whether a newer build exists. It works on every track and every
///     install source, because it is just a number we serve ourselves.
///   • Play's `checkForUpdate()` is the truth about whether Play CAN update this
///     particular install. When it can, we take the silent background path.
///
/// When config says "newer exists" but Play says "nothing for you", the install
/// is un-updatable by Play (side-loaded, or not opted into the track). We fall
/// back to the old Play-listing popup and tag the event `play_cannot_update` so
/// the reason is visible in PostHog instead of being a silent no-op.
///
/// Everything here is best-effort — like [Analytics], a failure must never throw
/// into the app. iOS and non-Play installs simply no-op.
class UpdateService {
  UpdateService._();

  /// Run the launch flow at most once per app session. A fresh cold launch tries
  /// again until the update lands.
  static bool _ranThisSession = false;

  /// Set once a flexible download has been kicked off, so a second call can't
  /// start a competing one.
  static bool _downloadInFlight = false;

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
  ///
  /// Deliberately reads [PackageInfo] rather than the compile-time `kAppBuild`
  /// constant: CI stamps the real versionCode via `--build-number=$((10000 +
  /// run_number))`, so the constant is frozen at a number no shipped build has
  /// carried for months. See feature_flags.dart.
  static Future<int?> _currentBuild() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return int.tryParse(info.buildNumber);
    } catch (_) {
      return null;
    }
  }

  /// Installed package name so the Play link points at the RIGHT listing.
  static Future<String?> _packageName() async {
    try {
      return (await PackageInfo.fromPlatform()).packageName;
    } catch (_) {
      return null;
    }
  }

  /// Open the Google Play listing for the installed package. Tries the native
  /// `market://` intent first, then falls back to the https listing URL.
  /// Best-effort — never throws.
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

  /// Ask Play what it knows about this install. Returns the raw info (whatever
  /// the availability) so callers can distinguish "a newer build is available"
  /// from "one is already downloaded and waiting to install" — the latter reports
  /// `developerTriggeredUpdateInProgress`, NOT `updateAvailable`, so filtering to
  /// `updateAvailable` in here would silently strand a finished download forever.
  ///
  /// Returns null only when the check itself throws. The overwhelmingly common
  /// cause is `ERROR_API_NOT_AVAILABLE`: Play only serves in-app updates to
  /// installs IT owns, so every side-loaded APK lands here. The plugin's own
  /// README says it outright — "cannot be tested locally, it must be installed
  /// via Google Play to work." This is almost certainly why the previous revision
  /// concluded in-app updates were broken on our track and tore them out.
  static Future<AppUpdateInfo?> _playCheck({required String source}) async {
    try {
      return await InAppUpdate.checkForUpdate();
    } catch (e) {
      AvaLog.I.log('update', 'play checkForUpdate failed: $e');
      Analytics.capture('update_play_check_failed', {
        'source': source,
        // 'ERROR_API_NOT_AVAILABLE' here == a side-loaded install. Nothing the
        // app can do about it; the user must reinstall from Play.
        'reason': e.toString(),
      });
      return null;
    }
  }

  static bool _canUpdateNow(AppUpdateInfo? i) =>
      i != null &&
      i.updateAvailability == UpdateAvailability.updateAvailable &&
      i.flexibleUpdateAllowed;

  /// The silent path: download in the background, install once it's ready.
  ///
  /// `startFlexibleUpdate()` surfaces Play's own consent sheet (the one tap we
  /// cannot remove), then downloads WITHOUT blocking the app — the user carries
  /// on chatting while it streams.
  ///
  /// TIMING, AND WHY THIS ISN'T TWO LINES. `AppUpdateResult.success` means "the
  /// user ACCEPTED the update", NOT "the download finished" — the plugin's own
  /// API docs are explicit about that. Calling `completeFlexibleUpdate()` straight
  /// after `success` therefore tries to install a package that may still be
  /// streaming, which fails (and on a slow connection it would fail for exactly
  /// the users on bad networks who most need the update to land). So we wait for
  /// [InstallStatus.downloaded] on `installUpdateListener` before installing.
  ///
  /// We install immediately on `downloaded` rather than parking a "Restart to
  /// install" bar, because a bar is a thing to ignore and the owner's whole
  /// complaint is users ignoring things.
  static Future<bool> _runFlexible({required String source}) async {
    if (_downloadInFlight) return true;
    _downloadInFlight = true;
    try {
      Analytics.capture('update_download_started', {'source': source});
      final result = await InAppUpdate.startFlexibleUpdate();
      if (result != AppUpdateResult.success) {
        // userDeniedUpdate | inAppUpdateFailed — leave them alone this session.
        Analytics.capture('update_download_abandoned', {
          'source': source,
          'result': result.toString(),
        });
        _downloadInFlight = false;
        return false;
      }
      // Accepted. Now wait for the bytes. The 15-min cap stops a stalled download
      // holding this subscription (and _downloadInFlight) for the whole session;
      // if it does time out, the next cold launch finds installStatus ==
      // downloaded via [_resumePendingInstall] and finishes the job then.
      await InAppUpdate.installUpdateListener
          .firstWhere((s) => s == InstallStatus.downloaded)
          .timeout(const Duration(minutes: 15));
      Analytics.capture('update_download_complete', {'source': source});
      await InAppUpdate.completeFlexibleUpdate();
      Analytics.capture('update_installed', {'source': source});
      return true;
    } catch (e) {
      AvaLog.I.log('update', 'flexible update failed: $e');
      Analytics.capture(
          'update_flexible_failed', {'source': source, 'reason': e.toString()});
      _downloadInFlight = false;
      return false;
    }
  }

  /// An update downloaded in a PREVIOUS session but never got installed (the user
  /// killed the app mid-download, or our listener timed out). Play still has the
  /// bytes on disk, so finish the job now — this is the cheapest update of all,
  /// nothing to re-download and no consent sheet.
  static Future<bool> _resumePendingInstall(AppUpdateInfo info) async {
    if (info.installStatus != InstallStatus.downloaded) return false;
    try {
      Analytics.capture('update_resume_pending_install', {
        'available_build': info.availableVersionCode ?? -1,
      });
      await InAppUpdate.completeFlexibleUpdate();
      Analytics.capture('update_installed', {'source': 'resume'});
      return true;
    } catch (e) {
      AvaLog.I.log('update', 'resume pending install failed: $e');
      Analytics.capture('update_resume_failed', {'reason': e.toString()});
      return false;
    }
  }

  // ── MANUAL: the "Update" sidebar row ──────────────────────────────────────
  static Future<void> runManual() async {
    if (!Platform.isAndroid) {
      _snack('Updates are available on Android only.');
      return;
    }
    Analytics.capture('update_check', {'source': 'manual'});

    final info = await _playCheck(source: 'manual');
    if (info != null && await _resumePendingInstall(info)) return;
    if (_canUpdateNow(info)) {
      _snack('Downloading the update in the background…');
      if (await _runFlexible(source: 'manual')) return;
    }
    // Play can't help this install — the listing is still the only honest place
    // to send them, and it shows Update-or-Open so the row is never a no-op.
    await _openPlayStore(source: 'manual');
  }

  // ── LAUNCH: automatic, no user intervention ───────────────────────────────
  static Future<void> maybeAutoUpdateOnLaunch() async {
    if (!_supported || _ranThisSession) return;
    _ranThisSession = true;

    final current = await _currentBuild();

    final info = await _playCheck(source: 'launch');

    // Bytes already on disk from a previous session → install, no re-download.
    if (info != null && await _resumePendingInstall(info)) return;

    // Play is the fast path: if it can update this install, just do it. We don't
    // gate this on latestAppBuild — Play knowing about a newer build is a
    // stronger signal than a KV value the owner has to remember to bump.
    if (_canUpdateNow(info)) {
      Analytics.capture('update_available', {
        'source': 'launch',
        'available_build': info!.availableVersionCode ?? -1,
        'installed_build': current ?? -1,
        'path': 'play_flexible',
        'staleness_days': info.clientVersionStalenessDays ?? -1,
      });
      await _runFlexible(source: 'launch');
      return;
    }

    // Play had nothing. Does OUR config think there's a newer build? If so this
    // install is one Play cannot update (side-loaded, or not opted into the
    // track) — fall back to the popup so they at least have a route.
    final latest = RemoteConfig.latestAppBuild;
    if (latest <= 0) return; // owner hasn't published a target yet
    if (current == null || latest <= current) return; // genuinely up to date

    final ctx = _dialogCtx;
    if (ctx == null || !ctx.mounted) return;

    Analytics.capture('update_available', {
      'source': 'launch',
      'available_build': latest,
      'installed_build': current,
      'path': 'play_cannot_update',
    });

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

  /// The name the launch call site (features/avatok/chat_list.dart) uses.
  ///
  /// Kept as an alias ON PURPOSE rather than renaming the call site: chat_list.dart
  /// currently holds another agent's uncommitted [UNREAD-FROM-DB-1] work, and
  /// committing that file to rename one method would sweep their change into this
  /// commit (CLAUDE.md, the 2026-07-14 cross-agent push bug). One line here costs
  /// nothing and keeps the commits honest. Fold it into the call site whenever
  /// chat_list.dart is next legitimately touched.
  static Future<void> maybePromptOnLaunch() => maybeAutoUpdateOnLaunch();
}
