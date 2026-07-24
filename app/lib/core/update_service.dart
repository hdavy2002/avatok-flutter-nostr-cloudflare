import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:in_app_update/in_app_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../push/push_service.dart' show navigatorKey;
import 'analytics.dart';
import 'ava_log.dart';
import 'disk_cache.dart';
import 'remote_config.dart';

/// The concrete way THIS install can be updated, resolved per-check.
enum _UpdatePath {
  /// Play can update and immediate (full-screen) mode is allowed — the owner's
  /// preferred experience: Play's own install screen takes over and restarts.
  immediate,

  /// Play can update but only via the background (flexible) download.
  flexible,

  /// A flexible update from a previous session already finished downloading and
  /// is waiting on disk. Completing it just installs + restarts — no download.
  downloaded,

  /// Play cannot update this install (side-loaded / not opted into the track).
  /// The only honest route is the Play listing, tapped by the user.
  store,
}

/// In-app app updates for AvaTOK (Android/Play).
///
/// [AVA-UPDATE-FLOW] Owner-requested flow (2026-07-17), replacing the old
/// "silently auto-update at launch" behaviour that (1) hijacked cold launch with
/// Play's "Installing…" screen before the user could do anything, (2) sent the
/// manual "Update" row to the Play Store even when already up to date, and (3)
/// re-logged the same "app is not owned" (-10) error on every launch of a
/// side-loaded install (×67 in PostHog).
///
/// The new contract:
///   • DETECT while the app is in USE — on launch (non-blocking), on foreground
///     resume, and on a low-frequency 30-min timer — and show an "Update
///     available" popup. Detection uses [RemoteConfig.latestAppBuild] (KV-served,
///     true for EVERY install source) as the source of truth for "newer exists".
///   • Launch NEVER blocks and NEVER starts an install the user didn't tap.
///   • On the user's tap, pick the best path for THIS install (see [_UpdatePath]):
///     Play immediate → Play flexible → complete a pending download → Play
///     listing. A side-loaded install is remembered persistently so we stop
///     probing Play every launch (kills the -10 error spam) and re-probe weekly.
///   • After an update lands (in-app OR organically via the Play Store), a
///     one-time friendly "You've been updated to build N" confirmation is shown.
///
/// Everything here is best-effort — like [Analytics], a failure must never throw
/// into the app, and the worst a failure ever surfaces is a polite snackbar.
/// iOS and non-Play installs simply no-op (except the confirmation toast, which
/// is device-local and Android-only).
class UpdateService {
  UpdateService._();

  // ── device-level (unscoped) persisted state ──────────────────────────────
  /// Build number recorded at the last run; drives the post-update confirmation.
  static const String _kLastSeenBuild = 'update_last_seen_build';

  /// Epoch-ms of the last time Play told us this install is side-loaded / not
  /// owned. While recent we skip the Play check entirely (no -10 spam).
  static const String _kSideloadAtMs = 'update_sideloaded_at_ms';

  /// Re-probe a known side-loaded install at most weekly.
  static const int _sideloadReprobeMs = 7 * 24 * 60 * 60 * 1000;

  // ── session state ─────────────────────────────────────────────────────────
  static bool _ranLaunchThisSession = false;
  static bool _toastChecked = false;
  static bool _observersUp = false;

  /// The user chose "Not now" this session → do not re-prompt until next launch.
  static bool _dismissedThisSession = false;

  /// A prompt dialog is currently on screen.
  static bool _promptOpen = false;

  /// A background flexible download is running.
  static bool _downloadInFlight = false;

  /// Play's full-screen immediate update is running.
  static bool _immediateInFlight = false;

  /// Epoch-ms the last popup was shown — throttles automatic prompts.
  static int _lastPromptAtMs = 0;

  /// Minimum gap between automatic prompts (manual tap bypasses this).
  static const int _minPromptGapMs = 15 * 60 * 1000;

  /// Low-frequency foreground detection cadence.
  static const Duration _pollInterval = Duration(minutes: 30);

  /// Failure logs/events already emitted this session, so a re-check can't spam
  /// the same known condition (part of the -10 spam fix).
  static final Set<String> _loggedThisSession = <String>{};

  static Timer? _timer;
  static final _UpdateLifecycleObserver _lifecycle = _UpdateLifecycleObserver();

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

  /// Log a message at most once per session for [tag] (dedupes known failures).
  static void _logOnce(String tag, String msg) {
    if (_loggedThisSession.add(tag)) AvaLog.I.log('update', msg);
  }

  /// Current installed build number (versionCode), best-effort.
  ///
  /// Reads [PackageInfo] rather than the compile-time `kAppBuild` constant: CI
  /// stamps the real versionCode via `--build-number=$((10000 + run_number))`,
  /// so the constant is frozen at a number no shipped build has carried for
  /// months. See feature_flags.dart.
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

  // ── public entry points ───────────────────────────────────────────────────

  /// Launch hook (called from features/avatok/chat_list.dart after first frame).
  /// NEVER blocks and NEVER starts an install: it shows the post-update
  /// confirmation toast (works for organic Play updates too) and kicks off a
  /// non-blocking detection pass that may show the "Update available" popup.
  static Future<void> maybePromptOnLaunch() async {
    if (_ranLaunchThisSession) return;
    _ranLaunchThisSession = true;
    // Confirmation is device-local and worth doing even if the auto-update flow
    // is killed via KV — it just tells the user a Play update landed.
    await _maybeShowUpdatedToast();
    if (!_supported) return;
    _ensureObservers();
    unawaited(_maybeDetect(trigger: 'launch'));
  }

  /// Back-compat alias kept for the existing call site.
  static Future<void> maybeAutoUpdateOnLaunch() => maybePromptOnLaunch();

  /// The "Update" sidebar row. The user has already expressed intent, so this
  /// acts directly on the best path instead of showing an intermediate popup —
  /// and, crucially, short-circuits to a friendly "you're up to date" message
  /// when the install already carries the latest build (the old bug where this
  /// row "gave an error" by falling through to the Play Store even when About
  /// showed the app was already updated).
  static Future<void> runManual() async {
    if (!Platform.isAndroid) {
      _snack('Updates are available on Android only.');
      return;
    }
    Analytics.capture('update_check', {'source': 'manual'});
    // Freshen latestAppBuild (edge-cached ~60s, so cheap and self-throttling).
    try {
      await RemoteConfig.refresh();
    } catch (_) {/* best-effort */}

    final current = await _currentBuild();
    final latest = RemoteConfig.latestAppBuild;

    // Config is the source of truth for "newer exists". If it says we're current,
    // NEVER open the Play Store — just reassure the user.
    if (current != null && current > 0 && latest > 0 && latest <= current) {
      Analytics.capture('update_check_result', {
        'source': 'manual',
        'result': 'up_to_date',
        'installed_build': current,
        'latest_build': latest,
      });
      _snack("You're on the latest version (build $current).");
      return;
    }

    // Manual tap re-probes Play even for a remembered side-loaded install (force).
    final path = await _resolvePath(force: true);

    // If config has no target (latest<=0) and Play offers nothing installable,
    // treat as up to date rather than dumping the user in the store.
    if (path == _UpdatePath.store && (latest <= 0)) {
      final info = await _playCheck(); // one probe already happened; cheap here
      final playHasUpdate = info != null &&
          info.updateAvailability == UpdateAvailability.updateAvailable;
      if (!playHasUpdate) {
        _snack("You're on the latest version"
            "${current != null && current > 0 ? ' (build $current)' : ''}.");
        return;
      }
    }

    await _act(
      path: path,
      trigger: 'manual',
      available: latest > 0 ? latest : (current ?? 0),
    );
  }

  // ── detection ─────────────────────────────────────────────────────────────

  /// One detection pass. Decides whether a newer build exists (via config, the
  /// truth for every install source) and, if so, shows the popup for the best
  /// path. Throttled and single-flighted; never blocks; never starts an install
  /// without a tap.
  static Future<void> _maybeDetect({required String trigger}) async {
    if (!_supported) return;
    if (_dismissedThisSession) return; // no re-prompt after "Not now" this session
    if (_promptOpen || _immediateInFlight || _downloadInFlight) return;

    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _lastPromptAtMs < _minPromptGapMs) return;

    // Refresh config on resume/timer so latestAppBuild is fresh; the launch pass
    // rides on RemoteConfig.start()'s fetch and skips a redundant call.
    if (trigger != 'launch') {
      try {
        await RemoteConfig.refresh();
      } catch (_) {/* best-effort */}
    }

    final current = await _currentBuild();
    final latest = RemoteConfig.latestAppBuild;
    if (current == null || current <= 0) return;
    if (latest <= 0 || latest <= current) return; // no target, or up to date

    final path = await _resolvePath(force: false);
    await _showPrompt(
      path: path,
      trigger: trigger,
      available: latest,
      installed: current,
    );
  }

  /// Resolve how THIS install can be updated right now.
  ///
  /// When [force] is false a recently-remembered side-loaded install returns
  /// [_UpdatePath.store] WITHOUT calling Play — that is what stops the -10
  /// "app is not owned" probe (and its error log) from firing every launch.
  static Future<_UpdatePath> _resolvePath({required bool force}) async {
    if (!force && await _sideloadedRecently()) return _UpdatePath.store;

    final info = await _playCheck();
    if (info == null) return _UpdatePath.store; // Play can't serve this install

    if (info.installStatus == InstallStatus.downloaded) {
      return _UpdatePath.downloaded;
    }
    if (info.updateAvailability == UpdateAvailability.updateAvailable) {
      if (info.immediateUpdateAllowed) return _UpdatePath.immediate;
      if (info.flexibleUpdateAllowed) return _UpdatePath.flexible;
    }
    // Play knows of no installable update but config said newer exists → this
    // install is one Play can't update. The listing is the only honest route.
    return _UpdatePath.store;
  }

  /// Ask Play about this install. Returns null when the check throws — the
  /// overwhelmingly common cause is a side-loaded install (ERROR_APP_NOT_OWNED /
  /// -10 / ERROR_API_NOT_AVAILABLE), which we remember persistently so we stop
  /// re-checking every launch. Both the log and the telemetry are deduped per
  /// session so a repeated known condition never spams.
  static Future<AppUpdateInfo?> _playCheck() async {
    try {
      return await InAppUpdate.checkForUpdate();
    } catch (e) {
      final s = e.toString();
      if (_looksSideloaded(s)) {
        try {
          await DiskCache.writeGlobal(
              _kSideloadAtMs, '${DateTime.now().millisecondsSinceEpoch}');
        } catch (_) {/* best-effort */}
        _logOnce('sideload',
            'play check: install is not Play-owned (side-loaded); '
            'suppressing further probes for a week');
        if (_loggedThisSession.add('sideload_event')) {
          Analytics.capture('update_play_unavailable', {'reason': 'sideloaded'});
        }
      } else {
        _logOnce('playcheck', 'play checkForUpdate failed: $s');
        if (_loggedThisSession.add('playcheck_event')) {
          Analytics.capture('update_play_check_failed', {'reason': s});
        }
      }
      return null;
    }
  }

  static bool _looksSideloaded(String e) {
    final s = e.toUpperCase();
    return s.contains('APP_NOT_OWNED') ||
        s.contains('NOT_OWNED') ||
        s.contains('NOT OWNED') ||
        s.contains('API_NOT_AVAILABLE') ||
        s.contains('(-10)') ||
        s.contains('ERROR(-10)') ||
        s.contains('-10:');
  }

  static Future<bool> _sideloadedRecently() async {
    try {
      final v = int.tryParse(await DiskCache.readGlobal(_kSideloadAtMs) ?? '');
      if (v == null) return false;
      return DateTime.now().millisecondsSinceEpoch - v < _sideloadReprobeMs;
    } catch (_) {
      return false;
    }
  }

  // ── prompt + actions ──────────────────────────────────────────────────────

  static Future<void> _showPrompt({
    required _UpdatePath path,
    required String trigger,
    required int available,
    required int installed,
  }) async {
    final ctx = _dialogCtx;
    if (ctx == null || !ctx.mounted) return;

    _promptOpen = true;
    _lastPromptAtMs = DateTime.now().millisecondsSinceEpoch;
    final pathName = path.name;
    Analytics.capture('update_prompt_shown', {
      'trigger': trigger,
      'available_build': available,
      'installed_build': installed,
      'path': pathName,
    });

    String title;
    String body;
    String cta;
    switch (path) {
      case _UpdatePath.downloaded:
        title = 'Update ready to install';
        body =
            'Your update to build $available has downloaded. Install it now to '
            'finish updating.';
        cta = 'Install now';
        break;
      case _UpdatePath.store:
        title = 'A new version is available';
        body =
            'A newer version of AvaTOK is available. Reinstall it from the Google '
            'Play Store to get it — and to receive automatic updates from then on.';
        cta = 'Open Play Store';
        break;
      case _UpdatePath.immediate:
      case _UpdatePath.flexible:
        title = 'Update available';
        body =
            'A new version of AvaTOK is ready. Update now to get the latest '
            'features and fixes.';
        cta = 'Update';
        break;
    }

    bool go = false;
    try {
      go = (await showDialog<bool>(
            context: ctx,
            builder: (d) => AlertDialog(
              title: Text(title),
              content: Text(body),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(d, false),
                    child: const Text('Not now')),
                FilledButton(
                    onPressed: () => Navigator.pop(d, true), child: Text(cta)),
              ],
            ),
          )) ??
          false;
    } finally {
      _promptOpen = false;
    }

    if (!go) {
      _dismissedThisSession = true;
      Analytics.capture('update_prompt_dismissed', {
        'trigger': trigger,
        'path': pathName,
        'available_build': available,
      });
      return;
    }
    Analytics.capture('update_prompt_accepted', {
      'trigger': trigger,
      'path': pathName,
      'available_build': available,
    });
    await _act(path: path, trigger: trigger, available: available);
  }

  /// Execute the chosen update path.
  static Future<void> _act({
    required _UpdatePath path,
    required String trigger,
    required int available,
  }) async {
    switch (path) {
      case _UpdatePath.immediate:
        await _runImmediate(trigger: trigger, available: available);
        break;
      case _UpdatePath.flexible:
        _snack('Downloading the update…');
        final ok = await _runFlexible(source: trigger);
        if (!ok) _snack("Couldn't update right now — we'll try again later.");
        break;
      case _UpdatePath.downloaded:
        await _completePending(trigger: trigger);
        break;
      case _UpdatePath.store:
        await _openPlayStore(source: trigger);
        break;
    }
  }

  /// The owner's preferred experience: Play's full-screen immediate update UI
  /// takes over, installs, and restarts the app. On success Play restarts us, so
  /// control usually does not return here.
  static Future<void> _runImmediate({
    required String trigger,
    required int available,
  }) async {
    if (_immediateInFlight) return;
    _immediateInFlight = true;
    Analytics.capture('update_immediate_started', {
      'trigger': trigger,
      'available_build': available,
    });
    try {
      final r = await InAppUpdate.performImmediateUpdate();
      if (r != AppUpdateResult.success) {
        // userDeniedUpdate | inAppUpdateFailed — leave them be this session.
        Analytics.capture('update_immediate_failed', {
          'trigger': trigger,
          'result': r.toString(),
        });
      }
    } catch (e) {
      _logOnce('immediate', 'immediate update failed: $e');
      Analytics.capture('update_immediate_failed', {
        'trigger': trigger,
        'reason': e.toString(),
      });
      _snack("Couldn't update right now — we'll try again later.");
    } finally {
      _immediateInFlight = false;
    }
  }

  /// Background download path. `startFlexibleUpdate()` surfaces Play's consent
  /// sheet, then streams WITHOUT blocking the app. `AppUpdateResult.success`
  /// means the user ACCEPTED, not that bytes have landed — so we wait for
  /// [InstallStatus.downloaded] before completing (installing early fails, and on
  /// a slow link it would fail for exactly the users who most need the update).
  static Future<bool> _runFlexible({required String source}) async {
    if (_downloadInFlight) return true;
    _downloadInFlight = true;
    try {
      Analytics.capture('update_download_started', {'source': source});
      final result = await InAppUpdate.startFlexibleUpdate();
      if (result != AppUpdateResult.success) {
        Analytics.capture('update_download_abandoned', {
          'source': source,
          'result': result.toString(),
        });
        _downloadInFlight = false;
        return false;
      }
      await InAppUpdate.installUpdateListener
          .firstWhere((s) => s == InstallStatus.downloaded)
          .timeout(const Duration(minutes: 15));
      Analytics.capture('update_download_complete', {'source': source});
      await InAppUpdate.completeFlexibleUpdate();
      Analytics.capture('update_installed', {'source': source});
      return true;
    } catch (e) {
      _logOnce('flexible', 'flexible update failed: $e');
      Analytics.capture(
          'update_flexible_failed', {'source': source, 'reason': e.toString()});
      _downloadInFlight = false;
      return false;
    }
  }

  /// Complete an update that finished downloading in a PREVIOUS session. Only
  /// ever runs on a user tap now (never automatically at launch) — that is the
  /// fix for Play's "Installing…" screen hijacking cold start.
  static Future<void> _completePending({required String trigger}) async {
    try {
      Analytics.capture('update_resume_pending_install', {'trigger': trigger});
      await InAppUpdate.completeFlexibleUpdate();
      Analytics.capture('update_installed', {'source': 'resume'});
    } catch (e) {
      _logOnce('complete', 'complete pending install failed: $e');
      Analytics.capture(
          'update_complete_failed', {'trigger': trigger, 'reason': e.toString()});
      _snack("Couldn't update right now — we'll try again later.");
    }
  }

  /// Open the Google Play listing for the installed package. Best-effort.
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
      _logOnce('openstore', 'open play store failed: $e');
      Analytics.capture(
          'update_open_store_failed', {'source': source, 'reason': e.toString()});
      _snack("Couldn't open the Play Store. Please update from the Play Store app.");
    }
  }

  // ── post-update confirmation ──────────────────────────────────────────────

  /// Once per session: if the build recorded last run is older than the build we
  /// are running now, an update landed (in-app OR organically via Play) — show a
  /// friendly one-time confirmation. Then record the current build. Device-level
  /// (unscoped) storage: the build is a property of the APK, not the account.
  static Future<void> _maybeShowUpdatedToast() async {
    if (_toastChecked) return;
    _toastChecked = true;
    if (!Platform.isAndroid) return;

    final current = await _currentBuild();
    if (current == null || current <= 0) return;

    int? stored;
    try {
      stored = int.tryParse(await DiskCache.readGlobal(_kLastSeenBuild) ?? '');
    } catch (_) {/* best-effort */}

    if (stored != null && stored > 0 && stored < current) {
      _snack("You've been updated to build $current");
      Analytics.capture('update_success_toast_shown', {
        'from_build': stored,
        'to_build': current,
      });
    }
    if (stored == null || stored != current) {
      try {
        await DiskCache.writeGlobal(_kLastSeenBuild, '$current');
      } catch (_) {/* best-effort */}
    }
  }

  // ── observers (self-contained; no extra call sites needed) ────────────────

  static void _ensureObservers() {
    if (_observersUp) return;
    _observersUp = true;
    try {
      WidgetsBinding.instance.addObserver(_lifecycle);
    } catch (_) {/* best-effort */}
    _timer?.cancel();
    _timer = Timer.periodic(
        _pollInterval, (_) => unawaited(_maybeDetect(trigger: 'timer')));
  }

  /// Called by the lifecycle observer on foreground resume.
  static void onAppResumed() => unawaited(_maybeDetect(trigger: 'resume'));

  /// [AVA-UPDATE-PUSH-1] A server push (FCM `type=app_update`) told us a new
  /// build was JUST published — prompt right away, even mid-use, instead of
  /// waiting for the 30-min timer or a background/foreground bounce (the owner's
  /// report 2026-07-24: "the popup only shows after I swipe the app out and back
  /// in, then hit the Update menu").
  ///
  /// A real release IS the reason to re-ask, so this clears this session's "Not
  /// now" latch and the inter-prompt throttle before detecting. It does NOT
  /// bypass the honest guards inside [_maybeDetect] / [_resolvePath]: the kill
  /// switch ([RemoteConfig.inAppUpdateEnabled]), the up-to-date short-circuit
  /// (the device that just installed this very build gets the push too and must
  /// stay silent), and the side-loaded suppression all still apply.
  ///
  /// [build] is the freshly-published build number carried by the push, used for
  /// telemetry only — the authoritative "newer exists" decision is re-derived
  /// from a fresh [RemoteConfig.latestAppBuild] inside [_maybeDetect]. Best-effort
  /// like everything else here; a failure never throws into the push handler.
  static Future<void> onUpdatePush({int? build}) async {
    Analytics.capture('update_push_received', {'build': build ?? 0});
    if (!_supported) return;
    _ensureObservers();
    _dismissedThisSession = false; // a new release overrides an earlier "Not now"
    _lastPromptAtMs = 0; // this is an explicit, freshly-triggered check — don't throttle it
    await _maybeDetect(trigger: 'push');
  }
}

/// Detects foreground resume so we can check for a new build while the user is
/// actively using the app (no cold launch required). Registered once by
/// [UpdateService._ensureObservers].
class _UpdateLifecycleObserver extends WidgetsBindingObserver {
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) UpdateService.onAppResumed();
  }
}
