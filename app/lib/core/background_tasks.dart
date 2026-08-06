/// [CALLREC-BG-1] THE app-wide WorkManager dispatcher.
///
/// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
/// `Workmanager().initialize(cb)` stores **one** callback handle for the whole
/// process — last writer wins. Two features had grown their own
/// `initialize(...)` call (`features/avadial/contacts_daily_backup.dart` and
/// `core/call_recording/call_recording_uploader.dart`), so whichever one ran
/// last owned every background task in the app. And a dispatcher that receives
/// a task name it doesn't recognise just `return true`s, which WorkManager
/// reads as "done, all good" — so the losing feature's job silently never ran,
/// with no error, no log and no telemetry anywhere. That silence is what made
/// the bug invisible; see [BackgroundTasks.run], which now shouts.
///
/// There is exactly ONE `Workmanager().initialize` call site in the app and it
/// is [BackgroundTasks.ensureInitialized]. Features never call `initialize`
/// themselves — they register a handler by task name and schedule their work:
///
/// ```dart
/// await BackgroundTasks.ensureInitialized();
/// await Workmanager().registerPeriodicTask(<work>, <taskName>, …);
/// ```
///
/// ── ⚠️ WHERE REGISTRATION HAS TO HAPPEN ─────────────────────────────────────
/// WorkManager spins up its OWN headless FlutterEngine and calls
/// [avatokBackgroundDispatcher] directly — `main()` never runs there, and Dart
/// statics are NOT shared with the UI isolate. So a `BackgroundTasks.register`
/// executed at app start is INVISIBLE to the background isolate. That is why
/// the dispatcher itself calls [registerBuiltInBackgroundTasks] before looking
/// anything up, and why every task that must survive an app-not-running wake
/// belongs in that function. [BackgroundTasks.register] is still public (tests,
/// debug actions, a future dynamically-registered lane), but a handler that is
/// ONLY registered from the UI isolate will never fire headlessly.
library;

import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/widgets.dart';
import 'package:workmanager/workmanager.dart';

import '../auth/clerk_client.dart';
import '../features/avadial/contacts_daily_backup.dart'
    show kContactsDailyBackupTask, runDailyContactsBackup;
import '../identity/identity.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'call_recording/call_recording_uploader.dart'
    show kCallRecUploadTask, CallRecordingUploader;
import 'disk_cache.dart';
import 'remote_config.dart';

/// What one background task does. Returns WorkManager's own success flag —
/// return `true` unless you genuinely want the OS to retry with backoff.
typedef BackgroundTaskHandler = Future<bool> Function(
    Map<String, dynamic>? inputData);

/// Device-global key holding the ACTIVE Clerk account id. MUST match `_kAcct`
/// in `main.dart` (and the same constant duplicated in
/// `contacts_daily_backup.dart` / `call_recording_uploader.dart`) — it is what
/// lets a headless isolate scope itself to the right account on a shared phone
/// instead of reading the guest scope.
const String _kAcctGlobal = 'clerk_account_id';

/// The single `@pragma('vm:entry-point')` WorkManager entry point for the whole
/// app. MUST be a top-level function and MUST keep the pragma, or the AOT
/// tree-shaker drops it and EVERY background task silently stops firing in a
/// release APK.
@pragma('vm:entry-point')
void avatokBackgroundDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    // Headless isolate: statics are not shared with the UI isolate, so the
    // registry is empty here until we fill it. See the file header.
    registerBuiltInBackgroundTasks();
    return BackgroundTasks.run(task, inputData);
  });
}

/// Every task that must run headlessly. Idempotent (map assignment), called
/// both from the background isolate's entry point and from
/// [BackgroundTasks.ensureInitialized].
///
/// ADD YOUR TASK HERE — a handler registered anywhere else is not reachable
/// from a WorkManager wake.
void registerBuiltInBackgroundTasks() {
  // Daily contacts backup (features/avadial/contacts_daily_backup.dart). It
  // does its own isolate bootstrap and its own remote-config kill-switch check.
  BackgroundTasks.register(
      kContactsDailyBackupTask, (_) => runDailyContactsBackup());
  // Deferred call-recording upload retry (core/call_recording/
  // call_recording_uploader.dart). The bootstrap + refresh live here rather
  // than in the uploader so this file owns the whole background contract.
  BackgroundTasks.register(kCallRecUploadTask, _runCallRecordingUpload);
}

Future<bool> _runCallRecordingUpload(Map<String, dynamic>? _) async {
  if (!await bootstrapBackgroundIsolate(tag: 'callrec')) return true;
  await RemoteConfig.refresh();
  await CallRecordingUploader.uploadPending(source: 'workmanager');
  return true;
}

/// Re-create, inside a headless isolate, the slice of app state a background
/// job needs: the plugin registrant, the active account scope (so per-account
/// storage and `Db.I` open the RIGHT files) and a Clerk bearer.
///
/// Returns false when nobody is signed in on this device — the caller should
/// then do nothing and return success, not retry.
Future<bool> bootstrapBackgroundIsolate({String tag = 'bg'}) async {
  try {
    // Without these, anything touching path_provider / secure storage throws
    // MissingPluginException in the headless engine.
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();
    final acct = await DiskCache.readGlobal(_kAcctGlobal);
    if (acct == null || acct.isEmpty) return false;
    // Scope EVERY subsequent read/write to this account, exactly as the UI
    // isolate does at boot. Without it the job reads the 'guest' scope — a
    // different SQLite file and media dir — which on a shared phone is both a
    // cross-account leak and a data loss.
    AccountScope.id = acct;
    final clerk = ClerkClient();
    ApiAuth.clerkBearer = clerk.sessionToken;
    return true;
  } catch (e, st) {
    AvaLog.I.warn(tag, 'background isolate bootstrap failed: $e');
    await Analytics.captureException(e, st,
        screen: 'background_tasks', handled: true, extra: {'stage': 'bootstrap', 'tag': tag});
    return false;
  }
}

/// The task-name → handler registry plus the one `Workmanager().initialize`
/// call site in the app.
abstract class BackgroundTasks {
  static final Map<String, BackgroundTaskHandler> _handlers = {};
  static bool _initialized = false;

  /// Register (or replace) the handler for [taskName]. Idempotent.
  static void register(String taskName, BackgroundTaskHandler handler) {
    _handlers[taskName] = handler;
  }

  /// Task names currently known to THIS isolate. Exposed for the unknown-task
  /// telemetry and for tests.
  static Iterable<String> get registered => _handlers.keys;

  /// Install [avatokBackgroundDispatcher] as the process-wide dispatcher, once.
  /// Every feature calls this instead of `Workmanager().initialize(...)`; a
  /// second call is a no-op rather than a silent hijack of someone else's tasks.
  static Future<void> ensureInitialized() async {
    if (_initialized) return;
    _initialized = true;
    registerBuiltInBackgroundTasks();
    try {
      // No isInDebugMode: deprecated in workmanager 0.9.x in favour of
      // WorkmanagerDebug handlers.
      await Workmanager().initialize(avatokBackgroundDispatcher);
    } catch (e) {
      // Allow a later caller to try again rather than pinning the app in a
      // permanently un-initialized state.
      _initialized = false;
      AvaLog.I.warn('bg', 'workmanager initialize failed: $e');
      rethrow; // the feature's own scheduler already guards with try/catch
    }
  }

  /// Dispatch one task. NEVER throws — a crash inside `executeTask` gets the
  /// job retried/penalised by the OS, which no background lane here is worth.
  ///
  /// An UNKNOWN task name is the failure mode this whole file exists to kill:
  /// it is logged at warn (auto-forwarded to PostHog Logs) and captured as an
  /// event, so a feature whose handler stopped being registered shows up in
  /// telemetry instead of just quietly never running.
  static Future<bool> run(String task, Map<String, dynamic>? inputData) async {
    final handler = _handlers[task];
    if (handler == null) {
      AvaLog.I.warn('bg',
          'unknown background task "$task" — no handler registered (known: ${_handlers.keys.join(", ")})');
      await Analytics.capture('background_task_unknown', {
        'task': task,
        'registered': _handlers.keys.join(','),
      });
      return true;
    }
    try {
      return await handler(inputData);
    } catch (e, st) {
      AvaLog.I.error('bg', 'background task "$task" threw: $e');
      await Analytics.captureException(e, st,
          screen: 'background_tasks',
          handled: true,
          extra: {'stage': 'run', 'task': task});
      return true;
    }
  }
}
