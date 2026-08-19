import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:in_app_update/in_app_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

// [CALL-UPDATE-GUARD-1] Read-only access to the call globals so an update can
// never interrupt a call. `show`-limited on purpose: this service must not
// acquire any other dependency on the call feature, and must never WRITE these.
// Note they live in two different files — `gIncomingRingingCallId` is owned by
// push_service.dart (it is set by the ring handlers), the other two by
// call_screen.dart. `call_session.dart` imports the same globals the same way.
import '../push/push_service.dart' show navigatorKey, gIncomingRingingCallId;
import '../features/avatok/call_screen.dart'
    show callIsGenuinelyActive, gOutgoingCallId;
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

/// Why a concrete update path was (or was not) selected. Keeping this separate
/// from [_UpdatePath] prevents a temporarily-unavailable Play release from being
/// mislabelled as a side-loaded install that must be reinstalled.
enum _UpdateResolutionReason {
  playUpdate,
  downloaded,
  confirmedSideload,
  playNotReady,
  transientFailure,
}

class _UpdateResolution {
  const _UpdateResolution(this.reason, [this.path]);

  final _UpdateResolutionReason reason;
  final _UpdatePath? path;
}

class _PlayProbe {
  const _PlayProbe({this.info, this.confirmedSideload = false});

  final AppUpdateInfo? info;
  final bool confirmedSideload;
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

  /// `build:epochMs` until which automatic prompts for that exact target are
  /// snoozed. Device-global because the installed APK is device-global.
  static const String _kPromptCooldown = 'update_prompt_cooldown';

  /// `build:epochMs` for the first FCM notice of a release. Play's client-side
  /// catalogue can lag a successful Developer API upload, so Store fallbacks
  /// receive a short propagation grace instead of opening an "Open" listing.
  static const String _kReleasePushSeen = 'update_release_push_seen';

  /// Re-probe a known side-loaded install at most weekly.
  static const int _sideloadReprobeMs = 7 * 24 * 60 * 60 * 1000;

  static const int _promptCooldownMs = 24 * 60 * 60 * 1000;
  static const int _playPropagationGraceMs = 45 * 60 * 1000;

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

  /// Covers the async work before [_promptOpen] becomes true. Without this,
  /// launch + resume + FCM can all pass the prompt guard and race into dialogs.
  static bool _detectInFlight = false;

  /// A release push received during detection gets one fresh pass afterward.
  static bool _pendingPushDetection = false;

  static void _queuePendingPushDetection(String busyReason) {
    _pendingPushDetection = true; // bool coalesces any number of duplicate pushes
    unawaited(Analytics.capture('update_detection_suppressed', {
      'trigger': 'push',
      'reason': '${busyReason}_rerun_queued',
    }));
  }

  static void _drainPendingPushDetection() {
    if (!_pendingPushDetection ||
        _detectInFlight ||
        _promptOpen ||
        _immediateInFlight ||
        _downloadInFlight) {
      return;
    }
    _pendingPushDetection = false;
    // A release arrived after the previous decision began. Re-run with fresh
    // config; the call guard and per-build disk cooldown still apply normally.
    _dismissedThisSession = false;
    _lastPromptAtMs = 0;
    unawaited(Analytics.capture('update_detection_rerun_started', {
      'trigger': 'push',
      'reason': 'push_arrived_while_update_busy',
    }));
    unawaited(_maybeDetect(trigger: 'push'));
  }

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

  /// [CALL-UPDATE-GUARD-1] Is a call live, dialling, or ringing right now?
  ///
  /// All three states matter and none of them is covered by the others:
  ///
  /// * `callIsGenuinelyActive()` — a live call screen is attached. This is the
  ///   connected case.
  /// * `gOutgoingCallId` — we are dialling and it has not connected yet. This is
  ///   the state the 2026-08-05 incident was actually in; note that
  ///   `gOutgoingCallTo` is explicitly nulled the moment a call connects, so the
  ///   *id* is the field to test, not the peer.
  /// * `gIncomingRingingCallId` — their phone is ringing ours. Interrupting the
  ///   user mid-ring with a full-screen dialog is how a call gets missed.
  ///
  /// Read-only use of the call globals; this service never writes them.
  static bool get _callInProgress =>
      callIsGenuinelyActive() ||
      gOutgoingCallId != null ||
      gIncomingRingingCallId != null;

  // ── stable UI handles (survive the drawer opening/closing) ────────────────
  static BuildContext? get _dialogCtx =>
      navigatorKey.currentState?.overlay?.context ??
      navigatorKey.currentContext;
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

    // Manual tap re-probes Play even for a remembered side-loaded install (force).
    final resolution = await _resolvePath(force: true);
    final path = resolution.path;

    // A flexible update may already be downloaded even when the remote pointer
    // says this APK is current (or is temporarily unset). Completing that local
    // Play state must take precedence over the config-only up-to-date shortcut.
    if (path == _UpdatePath.downloaded) {
      await _act(
        path: path,
        trigger: 'manual',
        available: latest > 0 ? latest : (current ?? 0),
      );
      return;
    }

    // Config is the source of truth for "newer exists" after the pending local
    // install check above. If it says we're current, never open the Store.
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

    if (path == null) {
      final notReady =
          resolution.reason == _UpdateResolutionReason.playNotReady;
      Analytics.capture('update_manual_unavailable', {
        'reason': resolution.reason.name,
        'installed_build': current ?? 0,
        'available_build': latest,
      });
      if (latest <= 0 && notReady) {
        _snack("You're on the latest version"
            "${current != null && current > 0 ? ' (build $current)' : ''}.");
      } else if (notReady) {
        _snack('The update is still reaching Google Play. Try again shortly.');
      } else {
        _snack("Couldn't check Google Play right now. Please try again later.");
      }
      return;
    }

    // If config has no target (latest<=0) and Play offers nothing installable,
    // treat as up to date rather than dumping the user in the store.
    if (latest <= 0 && path == _UpdatePath.store) {
      _snack("You're on the latest version"
          "${current != null && current > 0 ? ' (build $current)' : ''}.");
      return;
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
    // [CALL-UPDATE-GUARD-1 2026-08-06] Never interrupt a call.
    //
    // This is not a politeness rule, it is a data-loss rule. On 2026-08-05 a
    // tester's outgoing call was ringing when he switched apps and came back;
    // the `resume` trigger fired, the dialog rendered OVER the call screen, and
    // he tapped Update one second before the call connected. Play's immediate
    // flow then killed the process mid-call. He came back 20 seconds later on
    // the new build with no call, redialled four times chasing it, and the
    // fourth attempt tore down a working call to answer one that was already
    // dead. Every downstream symptom in that session started here.
    //
    // The dialog has no idea what is underneath it — it renders on the root
    // navigator overlay — so the check has to live at the decision, not the
    // paint.
    if (_callInProgress) {
      // Deferred, not dismissed: `_dismissedThisSession` and `_lastPromptAtMs`
      // are deliberately NOT touched, so the prompt returns on the next trigger
      // once the call is over rather than being suppressed for the session.
      unawaited(Analytics.capture('update_prompt_deferred', {
        'trigger': trigger,
        'reason': 'call_in_progress',
      }));
      return;
    }
    if (_dismissedThisSession)
      return; // no re-prompt after "Not now" this session
    if (_promptOpen || _immediateInFlight || _downloadInFlight) {
      if (trigger == 'push') {
        final reason = _promptOpen
            ? 'prompt_open'
            : (_immediateInFlight
                ? 'immediate_in_flight'
                : 'download_in_flight');
        _queuePendingPushDetection(reason);
      }
      return;
    }
    if (_detectInFlight) {
      if (trigger == 'push') {
        _queuePendingPushDetection('detection_in_flight');
      } else {
        unawaited(Analytics.capture('update_detection_suppressed', {
          'trigger': trigger,
          'reason': 'detection_in_flight',
        }));
      }
      return;
    }

    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _lastPromptAtMs < _minPromptGapMs) return;

    _detectInFlight = true;
    try {
      // Refresh config on resume/timer so latestAppBuild is fresh; the launch
      // pass rides on RemoteConfig.start()'s fetch and skips a redundant call.
      if (trigger != 'launch') {
        try {
          await RemoteConfig.refresh();
        } catch (_) {/* best-effort */}
      }

      final current = await _currentBuild();
      final latest = RemoteConfig.latestAppBuild;
      if (current == null || current <= 0) return;
      if (latest <= 0 || latest <= current) return; // no target, or up to date

      if (await _promptCooldownActive(latest)) {
        Analytics.capture('update_prompt_suppressed', {
          'trigger': trigger,
          'reason': 'same_build_cooldown',
          'available_build': latest,
          'installed_build': current,
        });
        return;
      }

      final resolution = await _resolvePath(force: false);
      final path = resolution.path;
      if (path == null) {
        Analytics.capture('update_prompt_suppressed', {
          'trigger': trigger,
          'reason': resolution.reason.name,
          'available_build': latest,
          'installed_build': current,
        });
        return;
      }

      // A successful Play upload is not proof that every tester's Play client
      // can see it yet. Delay only the Store fallback; a real in-app Play update
      // remains immediate.
      if (path == _UpdatePath.store && await _releaseGraceActive(latest)) {
        Analytics.capture('update_prompt_suppressed', {
          'trigger': trigger,
          'reason': 'play_propagation_grace',
          'available_build': latest,
          'installed_build': current,
        });
        return;
      }

      await _showPrompt(
        path: path,
        trigger: trigger,
        available: latest,
        installed: current,
      );
    } finally {
      _detectInFlight = false;
      _drainPendingPushDetection();
    }
  }

  /// Resolve how THIS install can be updated right now.
  ///
  /// When [force] is false a recently-remembered side-loaded install returns
  /// [_UpdatePath.store] WITHOUT calling Play — that is what stops the -10
  /// "app is not owned" probe (and its error log) from firing every launch.
  static Future<_UpdateResolution> _resolvePath({required bool force}) async {
    if (!force && await _sideloadedRecently()) {
      return const _UpdateResolution(
        _UpdateResolutionReason.confirmedSideload,
        _UpdatePath.store,
      );
    }

    final probe = await _playCheck();
    final info = probe.info;
    if (probe.confirmedSideload) {
      return const _UpdateResolution(
        _UpdateResolutionReason.confirmedSideload,
        _UpdatePath.store,
      );
    }
    if (info == null) {
      return const _UpdateResolution(_UpdateResolutionReason.transientFailure);
    }

    if (info.installStatus == InstallStatus.downloaded) {
      return const _UpdateResolution(
        _UpdateResolutionReason.downloaded,
        _UpdatePath.downloaded,
      );
    }
    if (info.updateAvailability == UpdateAvailability.updateAvailable) {
      if (info.immediateUpdateAllowed) {
        return const _UpdateResolution(
          _UpdateResolutionReason.playUpdate,
          _UpdatePath.immediate,
        );
      }
      if (info.flexibleUpdateAllowed) {
        return const _UpdateResolution(
          _UpdateResolutionReason.playUpdate,
          _UpdatePath.flexible,
        );
      }
    }
    // Config can advance seconds after upload while Play's per-device catalogue
    // still says no update. That is not evidence of a sideload; stay silent and
    // retry later rather than sending the user to a listing that only says Open.
    return const _UpdateResolution(_UpdateResolutionReason.playNotReady);
  }

  /// Ask Play about this install. The result keeps a confirmed side-load
  /// separate from a transient failure; callers must never turn a network/API
  /// failure into a misleading reinstall instruction. Confirmed side-loads
  /// (ERROR_APP_NOT_OWNED / -10 / ERROR_API_NOT_AVAILABLE) are remembered so we
  /// stop re-checking every launch. Logs and telemetry are deduped per session.
  static Future<_PlayProbe> _playCheck() async {
    try {
      return _PlayProbe(info: await InAppUpdate.checkForUpdate());
    } catch (e) {
      final s = e.toString();
      if (_looksSideloaded(s)) {
        try {
          await DiskCache.writeGlobal(
              _kSideloadAtMs, '${DateTime.now().millisecondsSinceEpoch}');
        } catch (_) {/* best-effort */}
        _logOnce(
            'sideload',
            'play check: install is not Play-owned (side-loaded); '
                'suppressing further probes for a week');
        if (_loggedThisSession.add('sideload_event')) {
          Analytics.capture(
              'update_play_unavailable', {'reason': 'sideloaded'});
        }
      } else {
        _logOnce('playcheck', 'play checkForUpdate failed: $s');
        if (_loggedThisSession.add('playcheck_event')) {
          Analytics.capture('update_play_check_failed', {'reason': s});
        }
      }
      return _PlayProbe(confirmedSideload: _looksSideloaded(s));
    }
  }

  static (int, int)? _parseBuildTimestamp(String? raw) {
    if (raw == null) return null;
    final parts = raw.split(':');
    if (parts.length != 2) return null;
    final build = int.tryParse(parts[0]);
    final timestamp = int.tryParse(parts[1]);
    if (build == null || timestamp == null) return null;
    return (build, timestamp);
  }

  static Future<bool> _promptCooldownActive(int build) async {
    try {
      final state =
          _parseBuildTimestamp(await DiskCache.readGlobal(_kPromptCooldown));
      return state != null &&
          state.$1 == build &&
          DateTime.now().millisecondsSinceEpoch < state.$2;
    } catch (_) {
      return false;
    }
  }

  static Future<void> _snoozeAutomaticPrompt(
    int build, {
    required String reason,
  }) async {
    final until = DateTime.now().millisecondsSinceEpoch + _promptCooldownMs;
    try {
      await DiskCache.writeGlobal(_kPromptCooldown, '$build:$until');
    } catch (_) {/* best-effort */}
    Analytics.capture('update_prompt_snoozed', {
      'reason': reason,
      'available_build': build,
      'cooldown_hours': _promptCooldownMs ~/ (60 * 60 * 1000),
    });
  }

  static Future<void> _rememberReleasePush(int build) async {
    if (build <= 0) return;
    try {
      final existing =
          _parseBuildTimestamp(await DiskCache.readGlobal(_kReleasePushSeen));
      // Duplicate delivery must not keep extending the propagation window.
      if (existing?.$1 == build) return;
      await DiskCache.writeGlobal(
        _kReleasePushSeen,
        '$build:${DateTime.now().millisecondsSinceEpoch}',
      );
    } catch (_) {/* best-effort */}
  }

  static Future<bool> _releaseGraceActive(int build) async {
    try {
      final state =
          _parseBuildTimestamp(await DiskCache.readGlobal(_kReleasePushSeen));
      return state != null &&
          state.$1 == build &&
          DateTime.now().millisecondsSinceEpoch - state.$2 <
              _playPropagationGraceMs;
    } catch (_) {
      return false;
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
            'This copy was installed outside Google Play, so Play cannot update '
            'it in place. Open the Play Store and, if it only shows Open, tap '
            'Uninstall and then Install to move to automatic updates.';
        cta = 'Open Play Store';
        break;
      case _UpdatePath.immediate:
      case _UpdatePath.flexible:
        title = 'Update available';
        body = 'A new version of AvaTOK is ready. Update now to get the latest '
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
      await _snoozeAutomaticPrompt(available, reason: 'dismissed');
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
    if (path == _UpdatePath.store) {
      // Returning from a Store listing that still says Open must not recreate
      // the same modal on every cold launch.
      await _snoozeAutomaticPrompt(available, reason: 'store_opened');
    }
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
    // [CALL-UPDATE-GUARD-1] Last line of defence, and not redundant with the
    // check in `_maybeDetect`. A call can start AFTER the dialog is on screen —
    // an incoming ring paints over it — and the user then taps Update on a
    // dialog that was legitimate when it appeared. `performImmediateUpdate`
    // hands the process to Play and it does not come back, so there is no
    // recovering from this one; refuse it.
    if (_callInProgress) {
      unawaited(Analytics.capture('update_immediate_blocked', {
        'trigger': trigger,
        'reason': 'call_in_progress',
        'available_build': available,
      }));
      _snack('Update paused until your call ends.');
      return;
    }
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
      _drainPendingPushDetection();
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
      return false;
    } finally {
      _downloadInFlight = false;
      _drainPendingPushDetection();
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
      Analytics.capture('update_complete_failed',
          {'trigger': trigger, 'reason': e.toString()});
      _snack("Couldn't update right now — we'll try again later.");
    }
  }

  /// Open the Google Play listing for the installed package. Best-effort.
  static Future<void> _openPlayStore({required String source}) async {
    final pkg = await _packageName();
    if (pkg == null) {
      _snack(
          "Couldn't open the Play Store. Please update from the Play Store app.");
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
      Analytics.capture('update_open_store_failed',
          {'source': source, 'reason': e.toString()});
      _snack(
          "Couldn't open the Play Store. Please update from the Play Store app.");
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
  /// A real release clears the in-memory "Not now" latch and inter-prompt
  /// throttle. The persisted cooldown is keyed by build, however, so a duplicate
  /// push for the same release cannot restart the loop while a genuinely newer
  /// release bypasses the old cooldown automatically. The kill switch, current-
  /// build check, call guard, and Play propagation grace still apply.
  ///
  /// [build] is the freshly-published build number carried by the push, used for
  /// telemetry only — the authoritative "newer exists" decision is re-derived
  /// from a fresh [RemoteConfig.latestAppBuild] inside [_maybeDetect]. Best-effort
  /// like everything else here; a failure never throws into the push handler.
  static Future<void> onUpdatePush({int? build}) async {
    Analytics.capture('update_push_received', {'build': build ?? 0});
    if (!_supported) return;
    _ensureObservers();
    if (build != null && build > 0) await _rememberReleasePush(build);
    _dismissedThisSession =
        false; // a new release overrides an earlier "Not now"
    _lastPromptAtMs =
        0; // this is an explicit, freshly-triggered check — don't throttle it
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
